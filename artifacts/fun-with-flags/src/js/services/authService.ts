import { apiFetch, AuthRequiredError, describeError } from './api.js';
import { normalizeAuthCallback, startSignIn } from './authWindow.js';
import { closeChallengeModal } from '../terminal/challengeModal.js';
import { cancelActiveChallengePager } from '../terminal/pager.js';
import { cancelGuidedSession } from '../terminal/flagAdminState.js';
import { replaceTerminalLifecycle } from '../terminal/lifecycle.js';

/** Shape returned by GET /api/auth/me. Mirrors `UserOut` in the API. */
export interface CurrentUser {
  account_id: string;
  home: string;
  username: string;
  email: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  department_parent: string | null;
  department_leaf: string | null;
  level: string | null;
  groups: string[];
  is_admin: boolean;
  score: number;
  solves: number;
}

export interface HomeRoster {
  owner: {
    account_id: string;
    home: string;
  };
  entries: Array<{ home: string }>;
}

interface AuthState {
  user: CurrentUser | null;
  loaded: boolean;
}

const authState: AuthState = { user: null, loaded: false };

let sessionGeneration = 0;
let authenticationRevision = 0;

/** Identifies a session lifetime, even when the same account signs back in. */
export function getAuthenticationRevision(): number {
  return authenticationRevision;
}

/**
 * Called once on page load. Restores the session (if the HttpOnly cookie is present) and
 * returns a message describing the result of a login redirect.
 */
export async function initializeAuth(): Promise<string | null> {
  authenticationRevision += 1;
  sessionGeneration++;
  const callback = normalizeAuthCallback();

  try {
    setCurrentUser(await apiFetch<CurrentUser>('/auth/me'));
  } catch (error) {
    setCurrentUser(null);
    if (!(error instanceof AuthRequiredError)) {
      console.warn('Session check failed:', describeError(error));
      return 'Unable to check your session. Please retry when the server is available.';
    }
  } finally {
    authState.loaded = true;
  }

  if (callback.error) {
    if (callback.error === 'Okta SAML is not configured. Contact the administrator.'
      || callback.error === 'Okta SAML configuration is invalid.') {
      return callback.error;
    }
    return 'Sign-in was not completed. Select “Sign in with Okta” to try again.';
  }
  if (callback.result === 'ok' && authState.user) {
    return `Login successful. Welcome, ${authState.user.full_name ?? authState.user.username}!`;
  }
  if (callback.result === 'ok') {
    return 'Sign-in completed, but your session could not be restored. Select “Sign in with Okta” to try again.';
  }
  if (callback.present) {
    return 'Sign-in was not completed. Select “Sign in with Okta” to try again.';
  }
  return null;
}

export function getCurrentUser(): CurrentUser | null {
  return authState.user;
}

/** Refresh the signed-in user's private profile and keep the shared auth state current. */
export async function refreshCurrentUser(): Promise<CurrentUser> {
  const user = await apiFetch<CurrentUser>('/auth/me');
  if (authState.user?.account_id !== user.account_id) {
    authenticationRevision += 1;
  }
  setCurrentUser(user);
  authState.loaded = true;
  return user;
}

export function isAuthenticated(): boolean {
  return authState.user !== null;
}

/** Forget a session the server has rejected, then leave the existing sign-in UI in charge. */
export function invalidateAuthentication(message: string): void {
  cancelGuidedSession();
  setCurrentUser(null);
  authState.loaded = true;
  requireAuthentication(message);
}

/** Names are display identity only, never authorization or database keys. */
export function shellUsername(user: CurrentUser): string {
  const normalize = (value: string): string => value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .trim().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalize(user.full_name ?? '') || normalize(user.username) || 'player';
}

export async function getHomeRoster(): Promise<HomeRoster> {
  const roster = await apiFetch<HomeRoster>('/auth/home-roster');
  if (authState.user
    && (roster.owner.account_id !== authState.user.account_id
      || roster.owner.home !== authState.user.home)) {
    throw new Error('The shell identity returned by the server is inconsistent.');
  }
  return roster;
}

/** Protect the terminal until the user explicitly chooses same-window Okta sign-in. */
export function requireAuthentication(message: string | null): void {
  authenticationRevision += 1;
  replaceTerminalLifecycle();
  closeChallengeModal(false);
  cancelActiveChallengePager();
  const wrapper = document.getElementById('terminal-input-wrapper');
  if (wrapper) wrapper.hidden = true;
  const input = document.getElementById('terminal-input');
  if (input) input.contentEditable = 'false';
  const output = document.getElementById('terminal-output');
  if (output) {
    output.hidden = false;
    output.replaceChildren();
    const text = document.createElement('p');
    text.textContent = message ?? 'Sign in to continue to Fun With Flags.';
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = 'Sign in with Okta';
    link.style.color = 'inherit';
    link.style.background = 'transparent';
    link.style.border = '1px solid currentColor';
    link.style.padding = '8px 16px';
    link.style.font = 'inherit';
    link.style.cursor = 'pointer';
    link.addEventListener('click', startSignIn);
    output.append(text, link);
  }
}

export function login(): string {
  if (authState.user) {
    return `Already logged in as ${authState.user.username}. Type \`logout\` first.`;
  }
  
  requireAuthentication(null);
  return 'Select “Sign in with Okta” to continue in this window.';
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
  setCurrentUser(null);
  cancelGuidedSession();
  requireAuthentication('You have signed out.');
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
  const fields: [string, string][] = [
    ['Logged in as', user.username],
    ['Name', user.full_name ?? '(not provided)'],
    ['First name', user.first_name ?? '(not provided)'],
    ['Last name', user.last_name ?? '(not provided)'],
    ['Email', user.email ?? '(not provided)'],
    ['Department parent', user.department_parent ?? '(not provided)'],
    ['Department leaf', user.department_leaf ?? '(not provided)'],
    ['Level', user.level ?? '(not provided)'],
    ['Groups', user.groups.length ? user.groups.join(', ') : '(not provided by sign-in)'],
    ['Role', user.is_admin ? 'admin' : 'player'],
    ['Score', `${user.score} pts (${user.solves} solved)`],
  ];
  const labelWidth = Math.max(...fields.map(([label]) => label.length));
  const lines = fields.map(([label, value]) => `    ${label.padEnd(labelWidth)} : ${value}`);
  return `\n${lines.join('\n')}\n`;
}

export async function listIdentityGroups(): Promise<string> {
  // Fetch the authenticated user's server record, never another user's membership
  // or the simulated Unix groups from /etc/group.
  const user = await refreshCurrentUser();
  if (!user.groups.length) {
    return 'Okta SAML sign-in did not provide any group memberships.\n'
      + 'Group memberships are unavailable for this session.';
  }
  return user.groups.join('\n');
}

function setCurrentUser(user: CurrentUser | null): void {
  if (authState.user?.account_id !== user?.account_id) sessionGeneration++;
  authState.user = user;
}

/** Local session lifetime, distinct from an immutable account ID or profile refresh. */
export function getAuthSessionGeneration(): number {
  return sessionGeneration;
}
