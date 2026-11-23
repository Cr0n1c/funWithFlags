/**
 * Thin fetch wrapper for the FastAPI middleware.
 *
 * Every request is made with a relative `/api/...` URL and same-origin cookies, so the
 * same build works behind nginx (Docker / Kubernetes) and behind the Vite dev proxy.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class AuthRequiredError extends ApiError {
  constructor() {
    super(401, 'Your session has expired. Reload the app to sign in again.');
    this.name = 'AuthRequiredError';
  }
}

export class ApiConnectionError extends Error {
  constructor() {
    super('The API connection failed. Reload the app to renew access, then check your connection and try again. Your submission was not automatically retried.');
    this.name = 'ApiConnectionError';
  }
}

interface ErrorBody {
  detail?: unknown;
}

function extractDetail(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const { detail } = body as ErrorBody;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
        .filter(Boolean)
        .join('; ') || fallback;
    }
  }
  return fallback;
}

export async function apiFetchWithHeaders<T>(
  path: string, init: RequestInit = {},
): Promise<{ data: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      // A private deployment's access gate can redirect to another origin.
      // Never follow a redirect carrying a flag or another sensitive API body.
      redirect: 'manual',
    });
  } catch (error) {
    if (error instanceof TypeError) throw new ApiConnectionError();
    throw error;
  }

  // Browsers hide Location/status for manual cross-origin redirects.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new ApiError(403,
      'API access redirected to a sign-in or access page. Reload the app to renew access, then submit again. Your flag was not forwarded to that page.');
  }

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, extractDetail(body, response.statusText || 'Request failed'));
  }

  if (response.status === 204) {
    return { data: undefined as T, headers: response.headers };
  }
  return { data: (await response.json()) as T, headers: response.headers };
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await apiFetchWithHeaders<T>(path, init)).data;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'An unexpected client error occurred. Reload the app and try again.';
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
