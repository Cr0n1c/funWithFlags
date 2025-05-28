import env from './env.js';
// Function to get the correct redirect URI based on environment
function getRedirectUri() {
    // For development
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return `${window.location.protocol}//${window.location.host}`;
    }
    // For production
    return window.location.origin;
}
// Function to load and validate config
function loadConfig() {
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
    }
    catch (error) {
        console.error('Error loading config:', error);
        throw error;
    }
}
// Initialize config
let oktaConfig = null;
// Load config and create Okta config object
export async function getOktaConfig() {
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
    }
    catch (error) {
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
export async function initOktaAuth() {
    const config = await getOktaConfig();
    return new window.OktaAuth(config);
}
//# sourceMappingURL=okta.js.map