import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: null as { account_id: string; username: string; is_admin?: boolean } | null,
}));
vi.mock('../src/js/services/authService.js', () => ({
  getCurrentUser: () => state.user,
  getAuthSessionGeneration: () => 0,
}));
vi.mock('../src/js/services/mailService.js', () => ({ primeGoldMail: vi.fn() }));
vi.mock('../src/js/terminal/flagAdminState.js', () => ({ hasGuidedSession: () => false }));
vi.mock('../src/js/terminal/games.js', () => ({ hasAdventure: () => false }));
vi.mock('../src/js/terminal/challengeModal.js', () => ({ isChallengeModalOpen: () => false }));

import { getMatrixCompletion, submitFlag } from '../src/js/services/ctfService.js';
import { installIdleMatrix, startMatrixTest } from '../src/js/terminal/idleMatrix.js';

class Element {
  hidden = false;
  contentEditable = 'true';
  textContent = '';
  checked = true;
  dataset = {};
  style = {};
  append = vi.fn();
  replaceChildren = vi.fn();
  setAttribute = vi.fn();
  removeAttribute = vi.fn();
  remove = vi.fn();
  focus = vi.fn();
  blur = vi.fn();
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
};
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const requestSignal = (index: number) => fetchMock.mock.calls[index]![1]!.signal!;
let wrapper: Element;
let dispose: (() => void) | undefined;

const setVisibility = (visibility: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
  state.user = { account_id: 'alice', username: 'alice' };
  wrapper = new Element();
  const elements: Record<string, Element> = {
    'terminal-input-wrapper': wrapper,
    'terminal-input': new Element(),
    'terminal-output': new Element(),
    switch: new Element(),
  };
  vi.stubGlobal('document', Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    getElementById: (id: string) => elements[id],
    querySelector: () => null,
    createElement: () => new Element(),
  }));
  vi.stubGlobal('window', new EventTarget());
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ solved: false })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Matrix completion transport', () => {
  it('uses only the private no-store status endpoint with session credentials', async () => {
    await expect(getMatrixCompletion()).resolves.toEqual({ solved: false });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/challenges/matrix/status',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', redirect: 'manual' }));
  });

  it.each([null, {}, [], { solved: 'false' }, { solved: 1 }])(
    'rejects malformed status instead of treating it as a solve: %j', async value => {
      fetchMock.mockResolvedValueOnce(json(value));
      await expect(getMatrixCompletion()).rejects.toThrow('invalid response');
    },
  );

  it('bounds a never-settling transport, aborts it, and does not retry it', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const result = getMatrixCompletion();
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    const signal = requestSignal(0);
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(getMatrixCompletion()).resolves.toEqual({ solved: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds a response whose JSON body never finishes', async () => {
    const response = json({ solved: false });
    vi.spyOn(response, 'json').mockReturnValue(new Promise(() => {}));
    fetchMock.mockResolvedValueOnce(response);
    const rejected = expect(getMatrixCompletion()).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(requestSignal(0).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects cancellation even when transport ignores abort and removes its listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const rejected = expect(getMatrixCompletion(controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(requestSignal(0).aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await expect(getMatrixCompletion(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cleans up cancellation and timeout after a successful lookup', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await getMatrixCompletion(controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestSignal(0).aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not timeout or retry a pending flag POST', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const submission = submitFlag('synthetic');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeUndefined();
    pending.resolve(json({ correct: false }));
    await submission;
  });
});

describe('Matrix periodic checks and replay', () => {
  it('does not poll while initially hidden and starts checking as soon as visible', async () => {
    setVisibility('hidden');
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.hidden).toBe(false);
    setVisibility('visible');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.hidden).toBe(true); // Visibility does not reset command-based idle time.
  });

  it.each([true, false])('waits for stale status on return before entry (solved=%s)', async solved => {
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved })));
    setVisibility('visible');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.hidden).toBe(false); // Cached unsolved must not start the encounter.
    setVisibility('hidden');
    setVisibility('visible');
    expect(fetchMock).toHaveBeenCalledTimes(2); // Do not duplicate a pending refresh.
    pending.resolve(json({ solved }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.hidden).toBe(!solved);
  });

  it('does not refresh still-fresh status or reset command timing on visibility changes', async () => {
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(170_000);
    document.dispatchEvent(new Event('terminal:command-submitted'));
    const calls = fetchMock.mock.calls.length;
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(5000);
    setVisibility('visible');
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(175_000);
    expect(wrapper.hidden).toBe(false); // Exactly three minutes since the command.
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.hidden).toBe(true);
  });

  it('keeps stale unsolved status closed if the visible refresh fails, then retries', async () => {
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(200_000);
    fetchMock.mockResolvedValueOnce(json({ detail: 'Unavailable' }, 503));
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wrapper.hidden).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wrapper.hidden).toBe(true);
  });

  it('discards old-account results without retrying in the background', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(200_000);
    state.user = { account_id: 'bob', username: 'bob' };
    await vi.advanceTimersByTimeAsync(1000);
    pending.resolve(json({ solved: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(wrapper.hidden).toBe(false); // The new account gets its own grace period.
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.hidden).toBe(true);
  });

  it.each([false, true])('refreshes submissions while hidden (older request pending=%s)', async inFlight => {
    const pending = deferred();
    if (inFlight) fetchMock.mockReturnValueOnce(pending.promise);
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    setVisibility('hidden');
    fetchMock.mockResolvedValueOnce(json({
      correct: true, already_solved: false, points_awarded: 25, event_id: 1,
    }));
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: true })));
    await submitFlag('synthetic');
    if (inFlight) {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      pending.resolve(json({ solved: false }));
    }
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/challenges/matrix/status');
    expect(wrapper.hidden).toBe(false);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.hidden).toBe(false);
  });

  it('still checks explicit replay while hidden without opening an encounter', async () => {
    setVisibility('hidden');
    dispose = installIdleMatrix();
    fetchMock.mockResolvedValueOnce(json({ solved: true }));
    await expect(startMatrixTest()).resolves.toContain('return to an empty terminal prompt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.hidden).toBe(false);
  });

  it('removes the visibility listener and timer on disposal', async () => {
    setVisibility('hidden');
    dispose = installIdleMatrix();
    dispose();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.hidden).toBe(false);
  });

  it('polls only status and never starts automatic entry for a solved player', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: true })));
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(wrapper.hidden).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.every(([url]) => url === '/api/challenges/matrix/status')).toBe(true);
  });

  it('keeps unknown status closed and retries after a transient failure', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ detail: 'Unavailable' }, 503)));
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(190_000);
    expect(wrapper.hidden).toBe(false);
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: false })));
    await vi.advanceTimersByTimeAsync(32_000);
    expect(wrapper.hidden).toBe(true);
  });

  it('releases a timed-out check but waits for the normal polling interval', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(requestSignal(0).aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(151_000);
    expect(wrapper.hidden).toBe(true);
  });

  it('keeps repeated timeouts unknown until a later successful check', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(wrapper.hidden).toBe(false);
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: false })));
    await vi.advanceTimersByTimeAsync(32_000);
    expect(wrapper.hidden).toBe(true);
  });

  it('does not retain a previously unsolved result after timeout', async () => {
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(wrapper.hidden).toBe(false);
  });

  it('refreshes post-submit after timeout even if the old transport never settles', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    fetchMock.mockResolvedValueOnce(json({ correct: true, event_id: 1 }));
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: true })));
    await submitFlag('synthetic');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestSignal(0).aborted).toBe(true);
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/challenges/matrix/status');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(wrapper.hidden).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('refreshes immediately after submission and discards an older in-flight result', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    fetchMock.mockResolvedValueOnce(json({
      correct: true, already_solved: false, points_awarded: 25, event_id: 1,
    }));
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: true })));
    await submitFlag('synthetic');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending.resolve(json({ solved: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/challenges/matrix/status');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(wrapper.hidden).toBe(false);
    await expect(startMatrixTest()).resolves.toBeNull();
    expect(wrapper.hidden).toBe(true);
  });

  it('discards old-account status and refreshes the new account without waiting for polling', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    state.user = { account_id: 'bob', username: 'bob' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestSignal(0).aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending.resolve(json({ solved: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(wrapper.hidden).toBe(true); // Bob is unsolved, unlike Alice.
  });

  it('does not let cancelled or late account checks clear a newer pending check', async () => {
    const alice = deferred();
    const bob = deferred();
    fetchMock.mockReturnValueOnce(alice.promise).mockReturnValueOnce(bob.promise);
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    state.user = { account_id: 'bob', username: 'bob' };
    await vi.advanceTimersByTimeAsync(1000);
    document.dispatchEvent(new Event('ctf:solve-confirmed'));
    alice.resolve(json({ solved: false }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // Bob still owns the in-flight slot.
    expect(requestSignal(1).aborted).toBe(false);
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: true })));
    bob.resolve(json({ solved: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3); // Only Bob's completion drains the refresh.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(wrapper.hidden).toBe(false);
  });

  it('ignores a timed-out result arriving while its replacement is pending', async () => {
    const old = deferred();
    const replacement = deferred();
    fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event('ctf:solve-confirmed'));
    old.resolve(json({ solved: false }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(() => Promise.resolve(json({ solved: true })));
    replacement.resolve(json({ solved: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(wrapper.hidden).toBe(false);
  });

  it('aborts on sign-out without retrying and can check a later sign-in', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    state.user = null;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(requestSignal(0).aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.hidden).toBe(false);
    state.user = { account_id: 'bob', username: 'bob' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.hidden).toBe(false); // A new account gets the full idle grace period.
  });

  it('does not apply or retry a result after disposal', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    document.dispatchEvent(new Event('ctf:solve-confirmed'));
    dispose();
    expect(requestSignal(0).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(json({ solved: false }));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.hidden).toBe(false);
  });

  it('disposes a never-settling check without leaving timers or queued refreshes', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(1000);
    document.dispatchEvent(new Event('ctf:solve-confirmed'));
    dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestSignal(0).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.hidden).toBe(false);
  });

  it('requires a fresh awarded solve for replay even for an administrator', async () => {
    state.user!.is_admin = true;
    dispose = installIdleMatrix();
    await expect(startMatrixTest()).resolves.toContain('earn its points');
    fetchMock.mockResolvedValueOnce(json({ solved: true }));
    await expect(startMatrixTest()).resolves.toBeNull();
    expect(wrapper.hidden).toBe(true);
  });

  it('reports replay lookup failures without entering and allows a later retry', async () => {
    dispose = installIdleMatrix();
    fetchMock.mockResolvedValueOnce(json({ detail: 'Unavailable' }, 503));
    await expect(startMatrixTest()).resolves.toBe('    Unable to check Matrix completion: Unavailable');
    expect(wrapper.hidden).toBe(false);
    fetchMock.mockResolvedValueOnce(json({ solved: true }));
    await expect(startMatrixTest()).resolves.toBeNull();
    expect(wrapper.hidden).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects replay if the account changes while awaiting status', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    dispose = installIdleMatrix();
    const replay = startMatrixTest();
    state.user = { account_id: 'bob', username: 'bob' };
    pending.resolve(json({ solved: true }));
    await expect(replay).resolves.toContain('Sign in first');
    expect(wrapper.hidden).toBe(false);
  });

  it('does not request status when signed out', async () => {
    state.user = null;
    dispose = installIdleMatrix();
    await vi.advanceTimersByTimeAsync(200_000);
    await expect(startMatrixTest()).resolves.toContain('Sign in first');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
