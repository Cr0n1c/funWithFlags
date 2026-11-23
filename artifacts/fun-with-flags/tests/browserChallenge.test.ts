import { describe, expect, it, vi } from 'vitest';
import { plantBrowserChallenge } from '../src/js/browserChallenge.js';

describe('deliberately planted browser-storage challenge', () => {
  it('stores the exact key and value, including the leading space', () => {
    const setItem = vi.fn();
    expect(plantBrowserChallenge(() => ({ setItem }))).toBe(true);
    expect(setItem).toHaveBeenCalledExactlyOnceWith('access_token', ' eyJhbGci_d0nt_st0r3_h3r3');
  });

  it('restores the same clue on reload without modifying other keys', () => {
    const values = new Map([['theme', 'green']]);
    const storage = { setItem: (key: string, value: string) => { values.set(key, value); } };
    plantBrowserChallenge(() => storage);
    values.delete('access_token');
    plantBrowserChallenge(() => storage);
    expect(values.size).toBe(2);
    expect(values.get('access_token')).toBe(' eyJhbGci_d0nt_st0r3_h3r3');
    expect(values.get('theme')).toBe('green');
  });

  it('does not break startup when storage access or writes are blocked', () => {
    expect(plantBrowserChallenge(() => { throw new Error('denied'); })).toBe(false);
    expect(plantBrowserChallenge(() => ({
      setItem: () => { throw new Error('quota'); },
    }))).toBe(false);
  });
});