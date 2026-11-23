/** Deliberately public CTF bait. Never use this value for authentication. */
export function plantBrowserChallenge(
  getStorage: () => Pick<Storage, 'setItem'> = () => window.localStorage,
): boolean {
  try {
    getStorage().setItem('access_token', ' eyJhbGci_d0nt_st0r3_h3r3');
    return true;
  } catch {
    // Blocked browser storage must not prevent sign-in or terminal startup.
    return false;
  }
}