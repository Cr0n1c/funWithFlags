import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeAuthCallback,
  startSignIn,
} from '../src/js/services/authWindow.js';

afterEach(() => vi.unstubAllGlobals());

function mockWindow(search = '') {
  const window = {
    location: { search, pathname: '/', assign: vi.fn() },
    history: { replaceState: vi.fn() },
    open: vi.fn(),
    close: vi.fn(),
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { title: 'Fun With Flags' });
  return window;
}

describe('same-window sign-in', () => {
  it('navigates to Okta in the current window only after an explicit call', () => {
    const window = mockWindow();

    expect(window.location.assign).not.toHaveBeenCalled();
    startSignIn();

    expect(window.location.assign).toHaveBeenCalledExactlyOnceWith('/api/auth/login');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('consumes a successful callback for normal same-window startup', () => {
    const window = mockWindow('?auth=ok');

    expect(normalizeAuthCallback()).toEqual({
      result: 'ok', error: null, present: true,
    });
    expect(window.history.replaceState).toHaveBeenCalledWith({}, 'Fun With Flags', '/');
    expect(window.close).not.toHaveBeenCalled();
  });

  it('normalizes an old popup callback without closing or opening a window', () => {
    const window = mockWindow('?auth=ok&auth_popup=1');

    expect(normalizeAuthCallback()).toEqual({
      result: 'ok', error: null, present: true,
    });
    expect(window.history.replaceState).toHaveBeenCalledWith({}, 'Fun With Flags', '/');
    expect(window.open).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });

  it('returns callback errors as data without rendering provider values', () => {
    const window = mockWindow('?auth_popup=1&auth_error=untrusted-provider-details');

    expect(normalizeAuthCallback()).toEqual({
      result: null, error: 'untrusted-provider-details', present: true,
    });
    expect(window.history.replaceState).toHaveBeenCalledOnce();
    expect(window.open).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });
});