import { afterEach, expect, it, vi } from 'vitest';
import { processCommand, redactSensitiveCommand } from '../src/js/terminal/terminal.js';

vi.mock('../src/js/services/authService.js', () => ({
  isAuthenticated: () => true, getCurrentUser: () => null,
  login: vi.fn(), logout: vi.fn(), checkAuthStatus: vi.fn(),
}));
vi.mock('../src/js/services/ctfService.js', async (original) => ({
  ...await original<object>(),
  curlPublicUrl: vi.fn((url: string) => Promise.resolve({
    output: url.endsWith('/iam/security-credentials/ctf-instance-role')
      ? '{ "flag": "always_check_ssrf_imdsv1" }' : '1.0\n2021-07-15\nlatest\n',
  })),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('prints the curl response and preserves its URL for command recall', async () => {
  vi.stubGlobal('document', { getElementById: () => null });
  const output = await processCommand('curl http://169.254.169.254/latest/meta-data/iam/security-credentials/ctf-instance-role');
  expect(output).toContain('always_check_ssrf_imdsv1');
  expect(output).toContain('curl http://169.254.169.254/latest/meta-data/iam/security-credentials/ctf-instance-role');
  expect(redactSensitiveCommand('curl https://example.com/path?q=test')).toBe('curl https://example.com/path?q=test');
  expect(redactSensitiveCommand('submit private-answer')).toBe('submit [redacted]');
});
it('shows metadata listings without revealing the flag at the root', async () => {
  vi.stubGlobal('document', { getElementById: () => null });
  const output = await processCommand('curl http://169.254.169.254');
  expect(output).toContain('latest');
  expect(output).not.toContain('always_check_ssrf_imdsv1');
});
it.each([
  'curl -L https://example.com', 'curl -X POST https://example.com',
  'curl -X GET https://example.com', 'curl --head https://example.com',
  'curl https://example.com -d test', 'curl https://example.com https://other.example',
  'curl --help https://example.com', 'curl -h',
])('rejects unsupported curl arguments: %s', async (command) => {
  expect(await processCommand(command)).toContain('this version of curl does not support any params other than --help');
});
it('supports --help without fetching a site', async () => {
  const { curlPublicUrl } = await import('../src/js/services/ctfService.js');
  vi.mocked(curlPublicUrl).mockClear();
  const output = await processCommand('curl --help');
  expect(output).toContain('first 500 characters');
  expect(output).toContain('GET');
  expect(curlPublicUrl).not.toHaveBeenCalled();
});
