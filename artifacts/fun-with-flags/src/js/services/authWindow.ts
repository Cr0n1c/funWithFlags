const LOGIN_URL = '/api/auth/login';

export interface AuthCallback {
  result: string | null;
  error: string | null;
  present: boolean;
}

/** Start Okta in this window only after an explicit user action. */
export function startSignIn(): void {
  window.location.assign(LOGIN_URL);
}

/**
 * Consume both current callbacks and the former popup callback shape. Legacy
 * callbacks continue startup in this window; they are never closed or relayed.
 */
export function normalizeAuthCallback(): AuthCallback {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('auth');
  const error = params.get('auth_error');
  const present = result !== null || error !== null || params.get('auth_popup') === '1';
  if (present) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return { result, error, present };
}