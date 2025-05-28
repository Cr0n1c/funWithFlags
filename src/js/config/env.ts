// Environment configuration
interface EnvConfig {
    OKTA_DOMAIN: string;
    OKTA_CLIENT_ID: string;
}

const env: EnvConfig = {
    // In production, these values will be replaced during build time
    // For development, we use default values
    OKTA_DOMAIN: 'trial-5939542.okta.com',
    OKTA_CLIENT_ID: '0oartsuih3QYwbQws697'
};

export default env; 