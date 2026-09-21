import { apiFetch, AuthRequiredError, describeError } from './api.js';

/** Shape returned by GET /api/auth/me. Mirrors `UserOut` in the API. */
export interface CurrentUser {
  username: string;
  email: string | null;
  full_name: string | null;
  groups: string[];
  is_admin: boolean;
  score: number;
  solves: number;
}

interface AuthState {
  user: CurrentUser | null;
  loaded: boolean;
}

const authState: AuthState = { user: null, loaded: false };

/**
 * Called once on page load. Restores the session (if the HttpOnly cookie is present) and
 * returns a message describing the result of an Okta redirect, if we just came back from one.
 */
export async function initializeAuth(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search);
  const authResult = params.get('auth');
  const authError = params.get('auth_error');

  if (authResult || authError) {
    // Strip the query string so a refresh doesn't replay the message.
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  try {
    authState.user = await apiFetch<CurrentUser>('/auth/me');
  } catch (error) {
    authState.user = null;
    if (!(error instanceof AuthRequiredError)) {
      console.warn('Session check failed:', describeError(error));
    }
  } finally {
    authState.loaded = true;
  }

  if (authError) {
    return `Login failed: ${decodeURIComponent(authError)}`;
  }
  if (authResult === 'ok' && authState.user) {
    return `Login successful. Welcome, ${authState.user.full_name ?? authState.user.username}!`;
  }
  return null;
}

export function getCurrentUser(): CurrentUser | null {
  return authState.user;
}

export function isAuthenticated(): boolean {
  return authState.user !== null;
}

export function login(): string {
  if (authState.user) {
    return `Already logged in as ${authState.user.username}. Type \`logout\` first.`;
  }
  // The middleware owns the whole OIDC dance (authorization code + PKCE). A full-page redirect
  // keeps tokens out of the browser entirely; we only ever hold an HttpOnly session cookie.
  window.setTimeout(() => window.location.assign('/api/auth/login'), 400);
  return 'Redirecting to Okta for single sign-on...';
}

export async function logout(): Promise<string> {
  if (!authState.user) {
    return 'Not currently logged in';
  }
  try {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
  } catch (error) {
    if (!(error instanceof AuthRequiredError)) {
      return `Logout failed: ${describeError(error)}`;
    }
  }
  authState.user = null;
  return 'Successfully logged out';
}

export function checkAuthStatus(): string {
  if (!authState.loaded) {
    return 'Authentication system is initializing...';
  }
  const { user } = authState;
  if (!user) {
    return 'Not logged in';
  }
  const lines = [
    `    Logged in as : ${user.username}`,
    `    Name         : ${user.full_name ?? '(not provided)'}`,
    `    Email        : ${user.email ?? '(not provided)'}`,
    `    Groups       : ${user.groups.length ? user.groups.join(', ') : '(none)'}`,
    `    Role         : ${user.is_admin ? 'admin' : 'player'}`,
    `    Score        : ${user.score} pts (${user.solves} solved)`,
  ];
  return `\n${lines.join('\n')}\n`;
}
