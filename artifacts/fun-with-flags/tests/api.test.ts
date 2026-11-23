import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch, ApiConnectionError, AuthRequiredError, describeError,
} from '../src/js/services/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('API transport failures', () => {
  it('does not follow redirects or replay sensitive POST bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      type: 'opaqueredirect', status: 0, ok: false,
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/challenges/submit', {
      method: 'POST', body: JSON.stringify({ flag: 'synthetic-secret' }),
      redirect: 'follow',
    })).rejects.toThrow('Reload the app to renew access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/challenges/submit',
      expect.objectContaining({ redirect: 'manual', credentials: 'same-origin' }));
  });

  it('also recognizes exposed redirect responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
      status: 307, headers: { Location: 'https://access.example.test/' },
    })));
    await expect(apiFetch('/challenges/submit', { method: 'POST' }))
      .rejects.toThrow('Your flag was not forwarded');
  });

  it('classifies transport failures without retrying an ambiguous submission', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/challenges/submit', { method: 'POST' }))
      .rejects.toBeInstanceOf(ApiConnectionError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeError(new ApiConnectionError())).toContain('not automatically retried');
    expect(describeError(new TypeError('client bug'))).not.toContain('API running');
  });

  it('preserves cancellation, expired app sessions, and server errors', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValueOnce(abort)
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Scoring unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/leaderboard')).rejects.toBe(abort);
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(apiFetch('/challenges/submit')).rejects.toThrow('Scoring unavailable');
  });
});