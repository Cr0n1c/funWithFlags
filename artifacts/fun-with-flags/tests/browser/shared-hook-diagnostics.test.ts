import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errors } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedHookPhase, sharedHookTeardown } from './shared-hook-diagnostics.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface EvidenceRecord {
  phase: string;
  outcome: string;
  elapsedMs: number;
  failure?: string;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    // Failure payloads deliberately must not reach a test reporter.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Expected an Error rejection');
  }
  throw new Error('Expected a rejection');
}

function evidence() {
  const lines: string[] = [];
  return {
    lines,
    emit: (line: string) => { lines.push(line); },
    records: () => lines.map(line =>
      JSON.parse(line.replace('[offline-shared-hook] ', '')) as EvidenceRecord),
  };
}

it.each(['build', 'assets', 'browser-launch', 'browser-close', 'scratch-cleanup'] as const)(
  'records fixed-label %s timings without serializing results',
  async phase => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const log = evidence();
    const privateResult = { toJSON() { throw new Error('Do not serialize bundle or browser'); } };
    expect(await sharedHookPhase(phase, () => {
      clock.mockReturnValue(350);
      return privateResult;
    }, log.emit)).toBe(privateResult);
    expect(log.records()).toEqual([
      { phase, outcome: 'started', elapsedMs: 0 },
      { phase, outcome: 'completed', elapsedMs: 250 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('bounds stalled output and releases its timer without waiting for hook cancellation', async () => {
  vi.useFakeTimers();
  const log = evidence();
  let finish!: () => void;
  const running = sharedHookPhase('build', () => new Promise<void>(resolve => { finish = resolve; }), log.emit);
  vi.advanceTimersByTime(600_000);
  expect(log.records().map(record => record.outcome)).toEqual(['started', 'pending', 'pending', 'pending']);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(600_000);
  expect(log.lines).toHaveLength(4);
  finish();
  await running;
  expect(log.lines).toHaveLength(5);
  expect(log.lines.every(line => line.length < 180)).toBe(true);
});

it.each([Infinity, NaN, -100, Number.MAX_VALUE])('bounds clock values (%s)', async value => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const log = evidence();
  await sharedHookPhase('assets', () => { clock.mockReturnValue(value); }, log.emit);
  const duration = log.records()[1]?.elapsedMs;
  expect(Number.isSafeInteger(duration)).toBe(true);
  expect(duration).toBeGreaterThanOrEqual(0);
  expect(log.lines.every(line => line.length < 180)).toBe(true);
});

it.each(['build', 'assets', 'browser-launch', 'browser-close', 'scratch-cleanup'] as const)(
  'sanitizes synchronous and async errors in %s without reading their contents',
  async phase => {
    vi.useFakeTimers();
    for (const asyncFailure of [false, true]) {
      const log = evidence();
      const privateError = new Error();
      for (const key of ['message', 'stack', 'cause', 'toJSON']) {
        Object.defineProperty(privateError, key, {
          get() { throw new Error('Do not read raw errors'); },
        });
      }
      const failure = await rejection(sharedHookPhase(phase, () => {
        if (asyncFailure) return Promise.reject(privateError);
        throw privateError;
      }, log.emit));
      expect(failure.message).toBe(
        `Offline shared hook failed during ${phase}: error (see safe shared-hook diagnostics)`,
      );
      expect(failure.cause).toBeUndefined();
      expect(log.records().at(-1)).toEqual({ phase, outcome: 'failed', elapsedMs: 0, failure: 'error' });
      expect(vi.getTimerCount()).toBe(0);
    }
  },
);

it('reports timeouts without browser arguments, environment, paths or credentials', async () => {
  vi.useFakeTimers();
  const log = evidence();
  const raw = 'PRIVATE bundle-content --browser-argument ENV=value /private/path credential';
  const failure = await rejection(sharedHookPhase('browser-launch',
    () => Promise.reject(new errors.TimeoutError(raw)), log.emit));
  expect(failure.message).toContain('browser-launch: timeout');
  expect(failure.cause).toBeUndefined();
  expect(log.records().at(-1)?.failure).toBe('timeout');
  expect(log.lines.join('')).not.toContain('PRIVATE');
  expect(failure.stack).not.toContain(raw);
  expect(vi.getTimerCount()).toBe(0);
});

it('removes the actual ephemeral directory even when browser close fails', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'fwf-hook-test-'));
  const log = evidence();
  try {
    await expect(sharedHookTeardown(
      () => { throw new Error('PRIVATE close error'); },
      () => rm(scratch, { recursive: true, force: true }),
      log.emit,
    )).rejects.toThrow('Offline shared teardown failed');
    await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(log.records()).toContainEqual(expect.objectContaining({ phase: 'scratch-cleanup', outcome: 'completed' }));
    expect(log.lines.join('')).not.toContain(scratch);
    expect(log.lines.join('')).not.toContain('PRIVATE');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it('starts scratch cleanup while browser close is stalled and bounds teardown reports', async () => {
  vi.useFakeTimers();
  const log = evidence();
  const removeScratch = vi.fn();
  let close!: () => void;
  const teardown = sharedHookTeardown(
    () => new Promise<void>(resolve => { close = resolve; }), removeScratch, log.emit,
  );
  await Promise.resolve();
  expect(removeScratch).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(600_000);
  expect(log.lines).toHaveLength(6); // close start + 3 pending, cleanup start + complete
  expect(vi.getTimerCount()).toBe(0);
  close();
  await teardown;
  expect(log.lines).toHaveLength(7);
});

it('waits for both cleanups and reports both failures without an aggregate raw error', async () => {
  vi.useFakeTimers();
  const log = evidence();
  let rejectScratch!: (error: Error) => void;
  const teardown = sharedHookTeardown(
    () => Promise.reject(new Error('PRIVATE browser')),
    () => new Promise<void>((_, reject) => { rejectScratch = reject; }),
    log.emit,
  );
  const rejected = expect(teardown).rejects.toThrow('Offline shared teardown failed');
  await Promise.resolve();
  vi.advanceTimersByTime(10_000);
  rejectScratch(new Error('PRIVATE filesystem'));
  await rejected;
  expect(log.records().filter(record => record.outcome === 'failed').map(record => record.phase))
    .toEqual(['browser-close', 'scratch-cleanup']);
  expect(log.lines.join('')).not.toContain('PRIVATE');
  expect(vi.getTimerCount()).toBe(0);
});
