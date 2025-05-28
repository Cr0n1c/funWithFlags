import env from './env.js';

// Define OktaAuth class type
interface OktaAuthClass {
    new(config: OktaAuthConfig): OktaAuthInstance;
}

export interface OktaAuthInstance {
    token: {
        parseFromUrl(): Promise<{ tokens: any }>;
        getWithPopup(options: { responseType: string[] }): Promise<{ tokens: any }>;
    };
    tokenManager: {
        setTokens(tokens: any): Promise<void>;
        get(tokenName: string): Promise<any>;
        clear(): void;
    };
    isAuthenticated(): Promise<boolean>;
    getUser(): Promise<OktaUser>;
    closeSession(): Promise<void>;
}

export interface OktaUser {
    email: string;
    name?: string;
    sub: string;
    [key: string]: any;
}

declare global {
    interface Window {
        OktaAuth: OktaAuthClass;
    }
}

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
    responseType: string;
}

// Function to get the correct redirect URI based on environment
function getRedirectUri(): string {
    // For development
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return `${window.location.protocol}//${window.location.host}`;
    }
    // For production
    return window.location.origin;
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
            redirectUri: getRedirectUri(),
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
export async function initOktaAuth(): Promise<OktaAuthInstance> {
    const config = await getOktaConfig();
    return new window.OktaAuth(config);
} 