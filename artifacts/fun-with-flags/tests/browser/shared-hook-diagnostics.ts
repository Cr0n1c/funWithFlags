import { errors } from 'playwright';

// These are fixture operations, never values derived from the bundle, browser,
// filesystem or environment. Keep shared-hook evidence separate from navigation.
type Phase = 'build' | 'assets' | 'browser-launch' | 'browser-close' | 'scratch-cleanup';
type Outcome = 'started' | 'pending' | 'completed' | 'failed';
type Failure = 'timeout' | 'error';
type Emit = (line: string) => void;

export async function sharedHookPhase<T>(
  phase: Phase,
  operation: () => T | Promise<T>,
  emit: Emit = console.warn,
): Promise<T> {
  const started = performance.now();
  const report = (outcome: Outcome, failure?: Failure) => {
    const duration = performance.now() - started;
    // A fixed shape and finite, capped integers bound each line, even if the
    // clock is abnormal. No operation result or caught error is serialized.
    const elapsedMs = Number.isFinite(duration)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(duration))) : 0;
    emit(`[offline-shared-hook] ${JSON.stringify({ phase, outcome, elapsedMs, failure })}`);
  };
  report('started'); // Also identifies a synchronous stall that prevents timers.
  let reports = 0;
  const timer = setInterval(() => {
    report('pending');
    if (++reports === 3) clearInterval(timer);
  }, 10_000);
  timer.unref();
  try {
    const result = await operation();
    report('completed');
    return result;
  } catch (error) {
    const failure = error instanceof errors.TimeoutError ? 'timeout' : 'error';
    report('failed', failure);
    // Do not preserve a cause: test reporters serialize raw errors and call logs.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Offline shared hook failed during ${phase}: ${failure} (see safe shared-hook diagnostics)`);
  } finally {
    // Pending reports stop themselves even if Vitest times out a hook without
    // cancelling its promise. This timer never extends or replaces that deadline.
    clearInterval(timer);
  }
}

export async function sharedHookTeardown(
  closeBrowser: () => void | Promise<void>,
  removeScratch: () => void | Promise<void>,
  emit: Emit = console.warn,
): Promise<void> {
  // The browser uses the in-memory assets, not the empty Vite env directory.
  // Start both cleanups so a stuck/failed close cannot prevent directory removal.
  const results = await Promise.allSettled([
    sharedHookPhase('browser-close', closeBrowser, emit),
    sharedHookPhase('scratch-cleanup', removeScratch, emit),
  ]);
  if (results.some(result => result.status === 'rejected')) {
    throw new Error('Offline shared teardown failed (see safe shared-hook diagnostics)');
  }
}
