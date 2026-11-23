import { it, expect, vi } from 'vitest';
import { apiFetch } from '../src/js/services/api.js';
import { runTraining } from '../src/js/services/trainingService.js';
vi.mock('../src/js/services/api.js', () => ({ apiFetch: vi.fn() }));

it('offers discoverable examples and preserves structured input', async () => {
  expect(await runTraining('')).toContain('lab invoice 1042');
  vi.mocked(apiFetch).mockResolvedValue({ flag: 'fixture-flag' });
  expect(await runTraining('invoice 1043')).toContain('fixture-flag');
  expect(apiFetch).toHaveBeenLastCalledWith('/training/invoices/1043');
  await runTraining('profile {"display_name": "Test Learner", "role": "admin"}');
  expect(apiFetch).toHaveBeenLastCalledWith('/training/profile', {
    method: 'POST', body: JSON.stringify({ display_name: 'Test Learner', role: 'admin' }),
  });
  await runTraining('file ../internal/release.txt');
  expect(apiFetch).toHaveBeenLastCalledWith('/training/files?path=..%2Finternal%2Frelease.txt');
  expect(await runTraining('profile {')).toContain('Expected a JSON object');
  expect(await runTraining('invoice nope')).toContain('numeric');
});
