import { initOktaAuth } from '../config/okta.js';

// Define interfaces for our types
interface OktaUser {
  email: string;
  name?: string;
  sub: string;
  [key: string]: unknown;
}

interface OktaAuth {
  token: {
    getWithPopup: (options: { responseType: string[] }) => Promise<{
      tokens: { accessToken: unknown; idToken: unknown }
    }>;
    parseFromUrl: () => Promise<{ tokens: { accessToken: unknown; idToken: unknown } }>;
  };
  tokenManager: {
    setTokens: (tokens: { accessToken: unknown; idToken: unknown }) => Promise<void>;
    get: (tokenName: string) => Promise<unknown>;
    clear: () => void;
  };
  getUser: () => Promise<OktaUser>;
  isAuthenticated: () => Promise<boolean>;
  closeSession: () => Promise<void>;
}

interface AuthState {
  isAuthenticated: boolean;
  user: OktaUser | null;
  isLoggingIn: boolean;
  isLoggingOut: boolean;
}

interface AuthError extends Error {
  name: string;
  errorCode?: string;
  message: string;
}

interface ServerResponse {
  error?: string;
  [key: string]: unknown;
}

// Initialize Okta Auth
let oktaAuth: OktaAuth | null = null;

// Auth state management
let authState: AuthState = {
  isAuthenticated: false,
  user: null,
  isLoggingIn: false,
  isLoggingOut: false,
};

// Check if third-party cookies are enabled
function checkThirdPartyCookies(): Promise<boolean> {
  return new Promise((resolve) => {
    const testCookie = 'okta-cookie-test';
        
    // Try to set a test cookie
    document.cookie = testCookie + '=1; SameSite=None; Secure';
        
    // Check if the cookie was set
    const cookieEnabled = document.cookie.indexOf(testCookie) !== -1;
        
    // Clean up test cookie
    document.cookie = testCookie + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=None; Secure';
        
    resolve(cookieEnabled);
  });
}

// Helper function to handle auth errors
function handleAuthError(error: AuthError, operation: string): string {
  console.error(`${operation} error:`, error);
    
  let errorMessage = error.message;
  if (error.name === 'AuthApiError' && error.message.includes('Failed to fetch')) {
    errorMessage = 'Unable to connect to Okta. Please check your network connection and ensure this domain is allowed in your Okta CORS settings.';
  }

  // Check for cookie-related errors
  if (error.message?.toLowerCase().includes('cookie') || 
      (error.name === 'AuthApiError' && error.errorCode === 'invalid_session')) {
    errorMessage = 'Third-party cookies appear to be blocked. Please enable third-party cookies ' +
      'for this site or use a different browser.';
  }

  // Reset auth state
  authState = {
    isAuthenticated: false,
    user: null,
    isLoggingIn: false,
    isLoggingOut: false,
  };

  return `${operation} failed: ${errorMessage}`;
}

// Helper function to make API calls to the server
async function callServerApi(
  endpoint: string,
  method: string,
  data?: Record<string, unknown>,
): Promise<ServerResponse> {
  const response = await fetch(`http://localhost:3001/api${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: data ? JSON.stringify(data) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Server error: ${response.statusText}${
        errorData.error ? ` - ${errorData.error}` : ''
      }`,
    );
  }

  return response.json();
}

// Initialize auth and set up callback handling
async function initializeAuth(): Promise<void> {
  try {
    // Check third-party cookie support first
    const cookiesEnabled = await checkThirdPartyCookies();
    if (!cookiesEnabled) {
      // Third-party cookies are disabled, but we'll continue anyway
      // The login process will handle any cookie-related errors
    }

    oktaAuth = await initOktaAuth();
    if (!oktaAuth) {
      throw new Error('Failed to initialize Okta auth');
    }
        
    // Check if we're handling a callback
    if (window.location.search.includes('code=') || window.location.hash.includes('access_token=')) {
      try {
        const tokens = await oktaAuth.token.parseFromUrl();
        await oktaAuth.tokenManager.setTokens(tokens.tokens);
                
        // Get the access token
        const accessToken = await oktaAuth.tokenManager.get('accessToken');
        if (!accessToken) {
          throw new Error('No access token available');
        }

        // Get user info using the access token
        const user = await oktaAuth.getUser();
        
        // Store user in database via server API
        try {
          await callServerApi('/users', 'POST', {
            email: user.email,
            username: user.name || user.email,
          });
        } catch (error) {
          console.error('Failed to store user in database:', error);
          // Continue with login even if database operation fails
        }
        
        authState = {
          isAuthenticated: true,
          user,
          isLoggingIn: false,
          isLoggingOut: false,
        };

        // Clear the URL parameters
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch (error) {
        handleAuthError(error as AuthError, 'Login');
      }
    } else {
      // Only check authentication state if we're not handling a callback
      try {
        // First check if we have a valid token
        const accessToken = await oktaAuth.tokenManager.get('accessToken');
        if (!accessToken) {
          // No token, definitely not authenticated
          authState = {
            isAuthenticated: false,
            user: null,
            isLoggingIn: false,
            isLoggingOut: false,
          };
          return;
        }

        // We have a token, check if it's still valid
        const authenticated = await oktaAuth.isAuthenticated();
        if (!authenticated) {
          // Token exists but is invalid, clear it
          oktaAuth.tokenManager.clear();
          authState = {
            isAuthenticated: false,
            user: null,
            isLoggingIn: false,
            isLoggingOut: false,
          };
          return;
        }

        // Token is valid, try to get user info
        try {
          const user = await oktaAuth.getUser();
          authState = {
            isAuthenticated: true,
            user,
            isLoggingIn: false,
            isLoggingOut: false,
          };
        } catch (error) {
          // If we can't get user info but have a valid token,
          // we'll still consider the user authenticated
          authState = {
            isAuthenticated: true,
            user: null,
            isLoggingIn: false,
            isLoggingOut: false,
          };
          // Don't log the error since this is expected behavior
        }
      } catch (error) {
        // If anything fails, assume not authenticated
        authState = {
          isAuthenticated: false,
          user: null,
          isLoggingIn: false,
          isLoggingOut: false,
        };
        console.warn('Authentication check failed:', error);
      }
    }
  } catch (error) {
    handleAuthError(error as AuthError, 'Authentication initialization');
  }
}

// Initialize auth on page load
initializeAuth();

export function getAuthState(): AuthState {
  return authState;
}

export async function login(): Promise<string> {
  if (!oktaAuth) {
    throw new Error('Okta auth not initialized');
  }

  try {
    authState.isLoggingIn = true;
    const tokens = await oktaAuth.token.getWithPopup({ responseType: ['token', 'id_token'] });
    await oktaAuth.tokenManager.setTokens(tokens.tokens);
    const user = await oktaAuth.getUser();
    
    // eslint-disable-next-line no-console
    console.log('Login successful:', user);

    // Update terminal with success message
    const terminal = document.getElementById('terminal-output');
    if (terminal) {
      const successLine = document.createElement('div');
      successLine.textContent = 'Login successful!';
      terminal.appendChild(successLine);
      const welcomeLine = document.createElement('div');
      welcomeLine.textContent = `Welcome, ${user.name || user.email}!`;
      terminal.appendChild(welcomeLine);
    }

    // Call server API to store user
    try {
      const serverResponse = await callServerApi('/users', 'POST', {
        email: user.email,
        username: user.name || user.email,
      });
      // eslint-disable-next-line no-console
      console.log('Server response:', serverResponse);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to store user in database:', error);
      // Continue with login even if database operation fails
    }

    authState = {
      isAuthenticated: true,
      user,
      isLoggingIn: false,
      isLoggingOut: false,
    };

    return 'Login successful';
  } catch (error) {
    const errorMessage = handleAuthError(error as AuthError, 'Login');
    return errorMessage;
  } finally {
    authState.isLoggingIn = false;
  }
}

export function logout(): string {
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
    
  try {
    // Clear tokens synchronously
    oktaAuth.tokenManager.clear();
        
    // Update state immediately
    authState = {
      isAuthenticated: false,
      user: null,
      isLoggingIn: false,
      isLoggingOut: false,
    };
        
    // Close the session without redirecting
    oktaAuth.closeSession().catch((error: unknown) => {
      console.warn('Session cleanup warning:', error);
    });

    return 'Successfully logged out';
  } catch (error) {
    return handleAuthError(error as AuthError, 'Logout');
  }
}

export function checkAuthStatus(): string {
  if (!oktaAuth) {
    return 'Authentication system is initializing...';
  }
    
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