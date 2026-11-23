import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkAuthStatus,
  getCurrentUser,
  initializeAuth,
  listIdentityGroups,
  shellUsername,
} from '../src/js/services/authService.js';
import { user } from './fixtures/account.js';

afterEach(() => vi.unstubAllGlobals());

describe('terminal account names', () => {
  it('uses the profile name rather than the account handle', () => {
    expect(shellUsername(user)).toBe('jane.doe');
  });
  it('normalizes names into safe home directory components', () => {
    expect(shellUsername({ ...user, full_name: '  José   O’Neill  ' })).toBe('jose.oneill');
    expect(shellUsername({ ...user, full_name: '../../' })).toBe('okta-handle');
  });
  it('uses the account handle if a name is missing', () => {
    expect(shellUsername({ ...user, full_name: null })).toBe('okta-handle');
  });
});

describe('identity groups', () => {
  it('lists only memberships returned by the authenticated API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...user, groups: ['engineering', 'ctf-players'],
    }))));
    expect(await listIdentityGroups()).toBe(
      'engineering\nctf-players',
    );
  });
  it('explains missing memberships without claiming the user has no groups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(user))));
    expect(await listIdentityGroups()).toBe(
      'Okta SAML sign-in did not provide any group memberships.\n'
      + 'Group memberships are unavailable for this session.',
    );
  });
  it('does not replace a failed lookup with simulated Unix groups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(listIdentityGroups()).rejects.toThrow('Your session has expired');
  });
});

describe('private Okta profile', () => {
  it('shows all six assertion attributes only in the signed-in account status', async () => {
    vi.stubGlobal('window', {
      location: { search: '', pathname: '/' }, history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('document', { title: 'Fun With Flags' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(user), { status: 200 }),
    ));
    await initializeAuth();

    const status = checkAuthStatus();
    expect(status).toContain('First name        : Jane');
    expect(status).toContain('Last name         : Doe');
    expect(status).toContain('Email             : jane@example.test');
    expect(status).toContain('Department parent : Technology');
    expect(status).toContain('Department leaf   : Security Engineering');
    expect(status).toContain('Level             : L4');
    const lines = status.trimEnd().split('\n').filter(Boolean);
    expect(lines).toHaveLength(11);
    expect(lines.every((line) => line.startsWith('    '))).toBe(true);
    expect(new Set(lines.map((line) => line.indexOf(':')))).toEqual(new Set([22]));
  });

  it('returns provider values as terminal text without interpreting markup', async () => {
    const profile = { ...user, department_leaf: '<script>not-executed()</script>' };
    vi.stubGlobal('window', {
      location: { search: '', pathname: '/' }, history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('document', { title: 'Fun With Flags' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(profile), { status: 200 }),
    ));
    await initializeAuth();

    expect(checkAuthStatus()).toContain(
      'Department leaf   : <script>not-executed()</script>',
    );
  });
});

describe('session initialization', () => {
  function setup(status: number, body: unknown, search = '') {
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: { search, pathname: '/', assign }, history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('document', { title: 'Fun With Flags' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
    return assign;
  }
  it('restores the player before starting their shell', async () => {
    setup(200, user);
    expect(await initializeAuth()).toBeNull();
    expect(getCurrentUser()?.full_name).toBe('Jane Doe');
  });
  it('leaves an ordinary missing session signed out without navigating', async () => {
    const assign = setup(401, {});
    expect(await initializeAuth()).toBeNull();
    expect(getCurrentUser()).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
  });
  it('replaces an untrusted callback error with safe generic text', async () => {
    const assign = setup(401, {}, '?auth_error=Login%20denied');
    const message = await initializeAuth();
    expect(message).toBe('Sign-in was not completed. Select “Sign in with Okta” to try again.');
    expect(message).not.toContain('Login denied');
    expect(fetch).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
  });
  it('allows only known configuration errors', async () => {
    setup(401, {}, `?auth_error=${encodeURIComponent(
      'Okta SAML is not configured. Contact the administrator.',
    )}`);
    expect(await initializeAuth()).toBe(
      'Okta SAML is not configured. Contact the administrator.',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not treat a server outage as a missing session', async () => {
    setup(503, {});
    expect(await initializeAuth()).toContain('Unable to check your session');
  });
  it('does not redirect-loop when callback cookies are unavailable', async () => {
    setup(401, {}, '?auth=ok');
    expect(await initializeAuth()).toContain('session could not be restored');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('resumes a legacy popup callback as an ordinary same-window callback', async () => {
    setup(200, user, '?auth=ok&auth_popup=1');
    expect(await initializeAuth()).toContain('Login successful');
    expect(getCurrentUser()).toEqual(user);
    expect(fetch).toHaveBeenCalledOnce();
  });
});