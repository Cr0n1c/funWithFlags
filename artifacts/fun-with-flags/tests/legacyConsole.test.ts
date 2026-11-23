import { describe, it, expect, vi } from 'vitest';
import { apiFetch } from '../src/js/services/api.js';
import { invokeLegacyConsole } from '../src/js/services/legacyConsole.js';

vi.mock('../src/js/services/api.js', () => ({ apiFetch: vi.fn() }));
describe('undocumented console simulation', () => {
  it('discovers the API without leaking the puzzle value in discovery traffic', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ commands: ['promote_user_to_admin'] });
    expect(await invokeLegacyConsole([])).toContain('promote_user_to_admin');
    expect(apiFetch).toHaveBeenLastCalledWith('/cli/commands');
  });
  it('requires the recovered value and displays the returned flag', async () => {
    await expect(invokeLegacyConsole(['wrong'])).rejects.toThrow('Invalid challenge token');
    vi.mocked(apiFetch).mockResolvedValueOnce({ flag: 'test-flag', message: 'simulation' });
    expect(await invokeLegacyConsole(['ctf-only.7e19b42d.93ac608f.bundle'])).toContain('test-flag');
    expect(apiFetch).toHaveBeenLastCalledWith('/cli/promote_user_to_admin', {
      method: 'POST', body: JSON.stringify({ token: 'ctf-only.7e19b42d.93ac608f.bundle' }),
    });
  });
});
