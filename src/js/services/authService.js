import { initOktaAuth } from '../config/okta.js';

// Initialize Okta Auth
let oktaAuth = null;
initOktaAuth()
    .then(auth => {
        oktaAuth = auth;
        // Check authentication state on page load
        return oktaAuth.isAuthenticated();
    })
    .then(authenticated => {
        if (authenticated && oktaAuth) {
            return oktaAuth.getUser();
        }
        return null;
    })
    .then(user => {
        if (user) {
            authState = {
                isAuthenticated: true,
                user,
                isLoggingIn: false,
                isLoggingOut: false
            };
        }
    })
    .catch(error => {
        console.error('Auth initialization error:', error);
        const terminal = document.getElementById("terminal-output");
        if (terminal) {
            const errorLine = document.createElement("div");
            errorLine.textContent = `Authentication initialization failed: ${error.message}`;
            errorLine.style.color = 'red';
            terminal.appendChild(errorLine);
        }
    });

// Auth state management
let authState = {
    isAuthenticated: false,
    user: null,
    isLoggingIn: false,
    isLoggingOut: false
};

export function getAuthState() {
    return authState;
}

export function login() {
    if (!oktaAuth) {
        return 'Authentication system is not initialized yet. Please try again in a moment.';
    }

    if (authState.isAuthenticated) {
        return `Already logged in as ${authState.user?.email || 'unknown user'}`;
    }
    
    if (authState.isLoggingIn) {
        return 'Login in progress...';
    }

    authState.isLoggingIn = true;
    
    // Start Okta login process
    oktaAuth.signInWithRedirect()
        .catch(error => {
            console.error('Login error:', error);
            authState.isLoggingIn = false;
            // Update terminal with error message
            const terminal = document.getElementById("terminal-output");
            if (terminal) {
                const newLine = document.createElement("div");
                newLine.textContent = `Login failed: ${error.message}`;
                terminal.appendChild(newLine);
            }
        });

    return 'Redirecting to Okta login...';
}

export function logout() {
    if (!oktaAuth) {
        return 'Authentication system is not initialized yet. Please try again in a moment.';
    }

    if (!authState.isAuthenticated) {
        return 'Not currently logged in';
    }
    
    if (authState.isLoggingOut) {
        return 'Logout in progress...';
    }

    authState.isLoggingOut = true;
    
    // Start Okta logout process
    oktaAuth.signOut()
        .then(() => {
            authState = {
                isAuthenticated: false,
                user: null,
                isLoggingIn: false,
                isLoggingOut: false
            };
            // Update terminal with success message
            const terminal = document.getElementById("terminal-output");
            if (terminal) {
                const newLine = document.createElement("div");
                newLine.textContent = 'Successfully logged out';
                terminal.appendChild(newLine);
            }
        })
        .catch(error => {
            console.error('Logout error:', error);
            authState.isLoggingOut = false;
            // Update terminal with error message
            const terminal = document.getElementById("terminal-output");
            if (terminal) {
                const newLine = document.createElement("div");
                newLine.textContent = `Logout failed: ${error.message}`;
                terminal.appendChild(newLine);
            }
        });

    return 'Logging out...';
}

export function checkAuthStatus() {
    if (authState.isLoggingIn) {
        return 'Login in progress...';
    }
    if (authState.isLoggingOut) {
        return 'Logout in progress...';
    }
    if (authState.isAuthenticated && authState.user) {
        return `Currently logged in as ${authState.user.email}`;
    }
    return 'Not logged in';
}

// Handle the Okta callback
export async function handleCallback() {
    try {
        const tokens = await oktaAuth.token.parseFromUrl();
        oktaAuth.tokenManager.setTokens(tokens);
        const user = await oktaAuth.getUser();
        
        authState = {
            isAuthenticated: true,
            user,
            isLoggingIn: false,
            isLoggingOut: false
        };
        
        return `Successfully logged in as ${user.email}`;
    } catch (error) {
        console.error('Authentication callback error:', error);
        authState = {
            isAuthenticated: false,
            user: null,
            isLoggingIn: false,
            isLoggingOut: false
        };
        return `Authentication failed: ${error.message}`;
    }
} 