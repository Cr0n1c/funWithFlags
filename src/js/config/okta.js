// Function to load and validate config
async function loadConfig() {
    try {
        const response = await fetch('/config.yaml');
        if (!response.ok) {
            throw new Error(`Failed to load config: ${response.status} ${response.statusText}`);
        }

        const yamlText = await response.text();
        const config = jsyaml.load(yamlText);

        // Validate config
        if (!config?.okta?.domain) {
            throw new Error('Missing Okta domain in config');
        }
        if (!config.okta.client_id) {
            throw new Error('Missing Okta client ID in config');
        }

        return {
            domain: config.okta.domain,
            clientId: config.okta.client_id
        };
    } catch (error) {
        console.error('Error loading config:', error);
        // Return default config for development
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.warn('Using default development configuration');
            return {
                domain: 'dev-example.okta.com',
                clientId: 'default_client_id'
            };
        }
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
        const config = await loadConfig();
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
            errorLine.textContent = `Error initializing Okta: ${error.message}`;
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