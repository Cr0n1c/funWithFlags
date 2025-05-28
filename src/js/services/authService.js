// Simple auth state management
let authState = {
    isAuthenticated: false,
    username: null,
    isLoggingIn: false,
    isLoggingOut: false
};

export function getAuthState() {
    return authState;
}

export function login(username = 'guest') {
    if (authState.isAuthenticated) {
        return `Already logged in as ${authState.username}`;
    }
    
    if (authState.isLoggingIn) {
        return 'Login in progress...';
    }

    authState.isLoggingIn = true;
    
    // Handle login asynchronously but return immediate response
    setTimeout(() => {
        authState = {
            isAuthenticated: true,
            username,
            isLoggingIn: false,
            isLoggingOut: false
        };
        
        // Update terminal with success message
        const terminal = document.getElementById("terminal-output");
        if (terminal) {
            const newLine = document.createElement("div");
            newLine.textContent = `Successfully logged in as ${username}`;
            terminal.appendChild(newLine);
        }
    }, 500);

    return 'Logging in...';
}

export function logout() {
    if (!authState.isAuthenticated) {
        return 'Not currently logged in';
    }
    
    if (authState.isLoggingOut) {
        return 'Logout in progress...';
    }

    authState.isLoggingOut = true;
    
    // Handle logout asynchronously but return immediate response
    setTimeout(() => {
        authState = {
            isAuthenticated: false,
            username: null,
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
    }, 500);

    return 'Logging out...';
}

export function checkAuthStatus() {
    if (authState.isLoggingIn) {
        return 'Login in progress...';
    }
    if (authState.isLoggingOut) {
        return 'Logout in progress...';
    }
    if (authState.isAuthenticated) {
        return `Currently logged in as ${authState.username}`;
    }
    return 'Not logged in';
} 