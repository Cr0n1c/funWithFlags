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
    super(401, 'Submitting flags requires Okta login. Type `login` first.');
    this.name = 'AuthRequiredError';
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

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, extractDetail(body, response.statusText || 'Request failed'));
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'Unable to reach the server. Is the API running?';
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
