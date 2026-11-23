import { expect } from 'vitest';
import type { Page } from 'playwright';

export type AudioMode = 'native' | 'suspended' | 'rejected' | 'unavailable';
interface ResumeCall { key: string; ctrl: boolean; trusted: boolean }
interface AudioTrace {
  contexts: AudioContext[];
  resumes: ResumeCall[];
  starts: Array<{ wall: number; at: number }>;
  stops: number[];
  gains: number[];
  disconnected: number;
  closed: number;
  armed: boolean;
}
type MatrixWindow = Window & typeof globalThis & {
  __matrixAudio: AudioTrace;
  __matrixRuntime: { installs: number; heartbeats: number };
  __matrixLifecycle: { dispose(): void; replace(): void };
  __matrixStatusReady?: boolean;
  __matrixAuth: {
    refreshCurrentUser(): Promise<unknown>;
    invalidateAuthentication(message: string): void;
    getCurrentUser(): { account_id: string } | null;
    getAuthSessionGeneration(): number;
  };
};

// Only appended to the offline in-memory build; no production test globals.
export function matrixTestHooks(code: string, id: string): string | undefined {
  if (id.endsWith('/src/js/terminal/idleMatrix.ts')) {
    const marker = '} finally {';
    if (code.split(marker).length !== 2) throw new Error('Matrix completion observer no longer matches');
    const applied = 'solved = status.solved;';
    if (code.split(applied).length !== 2) throw new Error('Matrix status observer target is missing');
    const failed = '        solved = null;';
    if (code.split(failed).length !== 2) throw new Error('Matrix failed status observer target is missing');
    // Count settlement even for cancelled/stale requests. Keep the observer
    // outside the request-ownership guard and leave all production checks intact.
    const completionImport = "import { getMatrixCompletion }";
    if (code.split(completionImport).length !== 2) throw new Error('Matrix completion import is missing');
    const replay = 'export async function startMatrixTest()';
    if (code.split(replay).length !== 2) throw new Error('Matrix replay observer target is missing');
    const install = 'export function installIdleMatrix() {';
    const tick = 'const tick = () => {';
    for (const marker of [install, tick]) {
      if (code.split(marker).length !== 2) throw new Error('Matrix lifetime observer target is missing');
    }
    return code
      .replace(install, `${install}
        (window.__matrixRuntime ??= { installs: 0, heartbeats: 0 }).installs++;`)
      .replace(tick, `${tick} window.__matrixRuntime.heartbeats++;`)
      .replace(replay, 'async function observedStartMatrixTest()')
      .replace(completionImport, 'import { getMatrixCompletion as requestMatrixCompletion }')
      .replace(marker, `${marker}
      window.__matrixStatusSettled = (window.__matrixStatusSettled ?? 0) + 1;`)
      .replace(failed, `${failed}
        window.__matrixFailedCompletionWrites = (window.__matrixFailedCompletionWrites ?? 0) + 1;`)
      .replace(applied, `${applied}
      window.__matrixStatusReady = true;
      (window.__matrixAppliedStatuses ??= []).push(solved);
      (window.__matrixStatusesApplied ??= []).push(status.solved);`)
      + `
      export async function startMatrixTest() {
        try {
          const result = await observedStartMatrixTest();
          (window.__matrixReplayResults ??= []).push(result);
          return result;
        }
        finally { window.__matrixReplaySettled = (window.__matrixReplaySettled ?? 0) + 1; }
      }
      async function getMatrixCompletion(signal) {
        const delivery = window.__matrixDeliveryQueue?.shift();
        try {
          const status = await requestMatrixCompletion(signal);
          if (delivery) delivery.outcome = 'fulfilled';
          return status;
        } catch (error) {
          if (delivery) {
            delivery.outcome = 'rejected';
            delivery.errorMessage = error instanceof Error ? error.message : String(error);
          }
          throw error;
        } finally {
          if (delivery) {
            delivery.received = true;
            await delivery.wait;
          }
        }
      }`;
  }
  if (id.endsWith('/src/js/main.ts')) {
    return `${code}
      window.__matrixLifecycle = {
        dispose: () => disposeIdleMatrix?.(),
        replace: () => {
          disposeIdleMatrix?.();
          disposeIdleMatrix = installIdleMatrix();
        },
      };`;
  }
  if (id.endsWith('/src/js/services/authService.ts')) {
    return `${code}
      window.__matrixAuth = {
        refreshCurrentUser, invalidateAuthentication, getCurrentUser, getAuthSessionGeneration,
      };`;
  }
}

export async function matrixRuntime(page: Page) {
  return page.evaluate(() => {
    const fixture = window as MatrixWindow;
    return {
      ...fixture.__matrixRuntime,
      account: fixture.__matrixAuth.getCurrentUser()?.account_id ?? null,
      generation: fixture.__matrixAuth.getAuthSessionGeneration(),
    };
  });
}

/** Leave live work pending, offsetting the knock deadline from the heartbeat. */
export async function reachActiveMatrixStage(page: Page, stage: 'typing' | 'delay' | 'reward') {
  await page.keyboard.press('Control+x');
  if (stage === 'typing') {
    await page.clock.runFor(165);
    expect(await page.locator('.idle-matrix-message').innerText()).toBe('Fol');
  } else {
    await page.clock.runFor(2250);
    expect(await page.locator('.idle-matrix-message').innerText()).toBe('Follow the white rabbit.');
    await beginKnock(page);
    await expect.poll(async () => (await traceAudio(page)).states).toEqual(['running']);
    await page.clock.runFor(stage === 'delay' ? 3999 : 5000);
    if (stage === 'delay') {
      expect(await page.locator('.idle-matrix-message').innerText()).toBe('Knock, knock, Jane.');
    } else {
      expect(await page.locator('.idle-matrix-message').innerText()).toContain('neo_has_land3d');
    }
  }
  const audio = await traceAudio(page);
  expect(audio.states).toEqual(['running']);
  expect(audio.closed).toBe(0);
  expect(audio.starts).toHaveLength(stage === 'reward' ? 2 : 0);
}

export async function prepareMatrix(
  page: Page,
  ready: (page: Page) => Promise<void>,
  load: (page: Page) => Promise<void>,
  mode: AudioMode = 'native',
  entry: 'idle' | 'command' = 'idle',
) {
  // Called on about:blank: install observers before the app boots,
  // rather than booting once just to discard it with a setup-only reload.
  await page.clock.install();
  await page.addInitScript((mode: AudioMode) => {
    const trace: AudioTrace = {
      contexts: [], resumes: [], starts: [], stops: [], gains: [],
      disconnected: 0, closed: 0, armed: false,
    };
    (window as MatrixWindow).__matrixAudio = trace;
    let gesture: KeyboardEvent | undefined;
    // Installed before app listeners: stopImmediatePropagation cannot hide the
    // real key event. eventPhase becomes NONE outside dispatch, so a delayed
    // resume cannot pass (even with the JavaScript clock paused).
    window.addEventListener('keydown', event => {
      gesture = event;
    }, true);
    const NativeContext = window.AudioContext;
    window.AudioContext = new Proxy(NativeContext, {
      construct(Target, args) {
        if (trace.armed && mode === 'unavailable') throw new DOMException('Audio disabled', 'NotSupportedError');
        const context = new Target(...args as ConstructorParameters<typeof AudioContext>);
        if (!trace.armed) return context;
        trace.contexts.push(context);
        const resume = context.resume.bind(context);
        if (mode === 'suspended' || mode === 'rejected') {
          // Deliberate failure injection, NOT evidence of native autoplay denial.
          Object.defineProperty(context, 'state', { get: () => 'suspended' });
        }
        context.resume = () => {
          trace.resumes.push(gesture && gesture.eventPhase !== Event.NONE
            ? { key: gesture.key, ctrl: gesture.ctrlKey, trusted: gesture.isTrusted }
            : { key: '', ctrl: false, trusted: false });
          if (mode === 'rejected') return Promise.reject(new DOMException('Audio blocked', 'NotAllowedError'));
          return mode === 'suspended' ? Promise.resolve() : resume();
        };
        const close = context.close.bind(context);
        context.close = () => { trace.closed++; return close(); };
        const oscillator = context.createOscillator.bind(context);
        context.createOscillator = () => {
          const node = oscillator();
          const start = node.start.bind(node);
          const stop = node.stop.bind(node);
          const disconnect = node.disconnect.bind(node);
          node.start = (at = 0) => { trace.starts.push({ wall: Date.now(), at }); start(at); };
          node.stop = (at = 0) => { trace.stops.push(at); stop(at); };
          node.disconnect = () => { trace.disconnected++; disconnect(); };
          return node;
        };
        const gain = context.createGain.bind(context);
        context.createGain = () => {
          const node = gain();
          const setValue = node.gain.setValueAtTime.bind(node.gain);
          node.gain.setValueAtTime = (value, at) => {
            trace.gains.push(value);
            return setValue(value, at);
          };
          const disconnect = node.disconnect.bind(node);
          node.disconnect = () => { trace.disconnected++; disconnect(); };
          return node;
        };
        return context;
      },
    });
  }, mode);
  await load(page);
  await ready(page);
  // Freeze between driver calls: assertions must distinguish 4999ms from 5000ms.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.evaluate(entry => {
    Math.random = () => entry === 'idle' ? 0 : 1;
    (window as MatrixWindow).__matrixAudio.armed = true;
  }, entry);
  if (entry === 'idle') {
    await page.clock.runFor(1000);
    // Network completion is not advanced by the mocked clock. Wait until the
    // installer actually applies status before firing the overdue idle tick.
    await expect.poll(() => page.evaluate(() =>
      (window as MatrixWindow).__matrixStatusReady === true)).toBe(true);
    await page.evaluate(() => { (window as MatrixWindow).__matrixStatusReady = false; });
    await page.clock.fastForward(181_000);
    // The jump makes the cached status stale. Automatic entry now waits for
    // that refresh too; the paused clock needs another heartbeat afterwards.
    await expect.poll(() => page.evaluate(() =>
      (window as MatrixWindow).__matrixStatusReady === true)).toBe(true);
    await page.clock.runFor(1000);
  } else {
    await page.locator('#terminal-input').focus();
    await page.keyboard.type('matrix_test');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#terminal-input').getAttribute('data-command-busy'))
      .toBe('false');
  }
  expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
  expect(await page.locator('.idle-matrix-controls').count()).toBe(0);
  await page.keyboard.press('Space');
  expect(await page.locator('.idle-matrix-message').innerText()).toBe('The Matrix has you. . . ');
}

export async function traceAudio(page: Page) {
  return page.evaluate(() => {
    const { contexts, ...trace } = (window as MatrixWindow).__matrixAudio;
    return { ...trace, states: contexts.map(context => context.state) };
  });
}

export async function followRabbit(page: Page) {
  await page.keyboard.press('Control+x');
  await page.clock.runFor(2000);
  expect(await page.locator('.idle-matrix-message').innerText()).toBe('Follow the white rabbit.');
}

export async function beginKnock(page: Page) {
  await page.keyboard.press('Escape');
  expect(await page.locator('.idle-matrix-message').innerText()).toBe('Follow the white rabbit.');
  await page.keyboard.press('Escape');
  expect(await page.locator('.idle-matrix-message').innerText()).toBe('Knock, knock, Jane.');
  return page.evaluate(() => Date.now());
}

export async function assertPromptRestored(page: Page) {
  expect(await page.locator('#terminal-output').innerText()).toBe('');
  expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(true);
  expect(await page.locator('#terminal-input').getAttribute('contenteditable')).toBe('true');
  expect(await page.locator('#terminal-input').evaluate(node => document.activeElement === node)).toBe(true);
  // Not just a visible prompt: key capture must be released.
  await page.keyboard.type('echo ready');
  expect(await page.locator('#terminal-input').innerText()).toBe('echo ready');
}

export async function dismissMatrixReward(page: Page) {
  // Completion is player-controlled; advancing time must never remove the flag.
  await page.clock.runFor(30_000);
  expect(await page.locator('.idle-matrix-message').innerText()).toContain('neo_has_land3d');
  expect((await traceAudio(page)).closed).toBe(0);
  expect(await page.locator('.idle-matrix-controls').count()).toBe(0);
  await page.keyboard.press('Enter');
  expect(await page.locator('.idle-matrix-message').count()).toBe(0);
}

export async function expireMatrixIdentity(page: Page) {
  await page.evaluate(() => (window as MatrixWindow).__matrixAuth.invalidateAuthentication('Synthetic session ended.'));
}

export async function refreshMatrixIdentity(page: Page) {
  await page.evaluate(() => (window as MatrixWindow).__matrixAuth.refreshCurrentUser());
}

export async function disposeMatrix(page: Page) {
  await page.evaluate(() => (window as MatrixWindow).__matrixLifecycle.dispose());
}

export async function suspendMatrixAudio(page: Page) {
  await page.evaluate(() => (window as MatrixWindow).__matrixAudio.contexts[0]!.suspend());
}
