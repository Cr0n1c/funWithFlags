import { afterEach, expect, it, vi } from 'vitest';
import { fixtureTimings } from './browser/fixture-timings.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('keeps coarse fixture timings silent unless explicitly enabled', () => {
  vi.stubEnv('BROWSER_FIXTURE_TIMINGS', '');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const timings = fixtureTimings('terminal');
  timings.start('bundle')();
  timings.documentLoaded();
  timings.report();
  expect(log).not.toHaveBeenCalled();
});

it('reports only aggregate counts and seconds under fixed phase labels', () => {
  vi.stubEnv('BROWSER_FIXTURE_TIMINGS', '1');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const timings = fixtureTimings('terminal');
  timings.start('ready')();
  timings.start('ready')();
  timings.documentLoaded();
  timings.documentLoaded();
  timings.report();
  expect(log.mock.calls).toEqual([
    [expect.stringMatching(/^\[browser-timing\] terminal ready count=2 seconds=\d+\.\d$/)],
    ['[browser-timing] terminal documents=2'],
  ]);
});

it('does not share timing state between fixtures or claim document counts for library bundles', () => {
  vi.stubEnv('BROWSER_FIXTURE_TIMINGS', '1');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const terminal = fixtureTimings('terminal');
  const editor = fixtureTimings('editor');
  terminal.start('ready')();
  terminal.documentLoaded();
  editor.start('bundle')();
  editor.report();
  expect(log.mock.calls).toEqual([
    [expect.stringMatching(/^\[browser-timing\] editor bundle count=1 seconds=\d+\.\d$/)],
  ]);
});
