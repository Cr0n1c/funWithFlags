import env from '../config/env.js';
import { OktaAuth, OAuthResponseType } from '@okta/okta-auth-js';

interface OktaConfig {
    domain: string;
    clientId: string;
}

interface OktaAuthConfig {
    issuer: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    pkce: boolean;
    responseType: OAuthResponseType;
}

// Function to load and validate config
function loadConfig(): OktaConfig {
    try {
        // Read from environment configuration
        const domain = env.OKTA_DOMAIN;
        const clientId = env.OKTA_CLIENT_ID;

        // Validate config
        if (!domain) {
            throw new Error('Missing Okta domain in environment configuration');
        }
        if (!clientId) {
            throw new Error('Missing Okta client ID in environment configuration');
        }

        return {
            domain,
            clientId
        };
    } catch (error) {
        console.error('Error loading config:', error);
        throw error;
    }
}

// Initialize config
let oktaConfig: OktaAuthConfig | null = null;

// Load config and create Okta config object
export async function getOktaConfig(): Promise<OktaAuthConfig> {
    if (oktaConfig) {
        return oktaConfig;
    }

    try {
        const config = loadConfig();
        oktaConfig = {
            issuer: `https://${config.domain}/oauth2/default`,
            clientId: config.clientId,
            redirectUri: window.location.origin,
            scopes: ['openid', 'profile', 'email'],
            pkce: true,
            responseType: 'code'
        };
        return oktaConfig;
    } catch (error) {
        const terminal = document.getElementById("terminal-output");
        if (terminal) {
            const errorLine = document.createElement("div");
            errorLine.textContent = `Error initializing Okta: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errorLine.style.color = 'red';
            terminal.appendChild(errorLine);
        }
        throw error;
    }
}

// Export a function to initialize Okta auth
export async function initOktaAuth(): Promise<OktaAuth> {
    const config = await getOktaConfig();
    return new OktaAuth(config);
} 