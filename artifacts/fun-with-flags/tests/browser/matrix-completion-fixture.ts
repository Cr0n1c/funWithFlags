import { expect } from 'vitest';
import type { Page, Route } from 'playwright';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Per-context response gates. Capture data on arrival, never on release. */
export class MatrixCompletionFixture {
  private pending: Array<ReturnType<MatrixCompletionFixture['holdNext']>> = [];
  private gates: Array<ReturnType<typeof deferred>> = [];
  readonly requests: Array<{ account: string; solved: boolean }> = [];
  readonly expectedFailures: number[] = [];
  // Counts completed fixture fulfill attempts, not receipt by an aborted fetch.
  fulfilledResponses = 0;

  async holdNextDelivery(page: Page, beforeLoad = false) {
    // Delay the caller AFTER the real service has fulfilled or rejected.
    // Aborting a completed transport cannot cancel this continuation. This
    // exercises installer ownership rather than passing only because fetch
    // rejected on abort. Default journeys still use the unmodified service.
    const install = () => {
      const fixture = window as CompletionWindow;
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const gate: DeliveryGate = { received: false, wait, release };
      (fixture.__matrixDeliveryQueue ??= []).push(gate);
      return (fixture.__matrixDeliveries ??= []).push(gate) - 1;
    };
    // The first gate must exist before the installer starts its initial check.
    let index: number;
    if (beforeLoad) {
      await page.addInitScript(install);
      index = 0;
    } else {
      index = await page.evaluate(install);
    }
    return {
      received: async (outcome: 'fulfilled' | 'rejected' = 'fulfilled') => {
        await expect.poll(() => page.evaluate(index =>
          (window as CompletionWindow).__matrixDeliveries?.[index]?.received, index)).toBe(true);
        expect(await page.evaluate(index =>
          (window as CompletionWindow).__matrixDeliveries![index]!.outcome, index)).toBe(outcome);
        if (outcome === 'rejected') {
          expect(await page.evaluate(index =>
            (window as CompletionWindow).__matrixDeliveries![index]!.errorMessage, index))
            .toBe('Synthetic completion check failed.');
        }
      },
      release: () => page.evaluate(index =>
        (window as CompletionWindow).__matrixDeliveries![index]!.release(), index),
    };
  }

  holdNext(status = 200): { status: number; release: () => void; wait: Promise<void> } {
    const gate = deferred();
    const reply = { status, release: gate.release, wait: gate.promise };
    this.gates.push(gate);
    this.pending.push(reply);
    return reply;
  }

  async respond(route: Route, account: string, completion: { solved: boolean }) {
    const body = JSON.stringify(completion);
    const reply = this.pending.shift();
    this.requests.push({ account, solved: completion.solved });
    await reply?.wait;
    const status = reply?.status ?? 200;
    if (status !== 200) this.expectedFailures.push(status);
    await route.fulfill({
      status, contentType: 'application/json',
      body: status === 200 ? body : JSON.stringify({ detail: 'Synthetic completion check failed.' }),
    });
    this.fulfilledResponses++;
  }

  consumeExpectedError(text: string, url: string) {
    const status = this.expectedFailures[0];
    if (status && url === 'https://terminal-smoke.invalid/api/challenges/matrix/status'
        && text.includes(String(status))) {
      this.expectedFailures.shift();
      return true;
    }
    return false;
  }

  dispose() {
    for (const gate of this.gates) gate.release();
  }
}

export async function replaceMatrix(page: Page) {
  await page.evaluate(() => (window as CompletionWindow).__matrixLifecycle.replace());
}

/** Use real auth mutations and resume the existing installer, without a reload. */
export async function endMatrixSession(page: Page, method: 'logout' | 'expiry') {
  await page.evaluate(async method => {
    const fixture = window as CompletionWindow;
    if (method === 'logout') await fixture.offlineMatrixSession.logout();
    else fixture.__matrixAuth.invalidateAuthentication('Synthetic session ended.');
  }, method);
  expect(await page.locator('#terminal-input-wrapper').evaluate(node => node.hasAttribute('hidden'))).toBe(true);
}

export async function resumeMatrixSession(page: Page) {
  await page.evaluate(() => (window as CompletionWindow).offlineMatrixSession.refresh());
  expect(await page.locator('#terminal-input-wrapper').evaluate(node => node.hasAttribute('hidden'))).toBe(false);
}

export async function replaySettled(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() =>
    (window as CompletionWindow).__matrixReplaySettled ?? 0)).toBe(count);
}

/** Catch-branch writes matter even when both the old and new value are null. */
export async function takeFailedCompletionWrites(page: Page) {
  return page.evaluate(() => {
    const fixture = window as CompletionWindow;
    const writes = fixture.__matrixFailedCompletionWrites ?? 0;
    fixture.__matrixFailedCompletionWrites = 0;
    return writes;
  });
}

/** Observe the returned result before terminal animation advances the clock. */
export async function replayResults(page: Page) {
  return page.evaluate(() => (window as CompletionWindow).__matrixReplayResults ?? []);
}
export async function statusSettled(page: Page, count: number) {
  // Observes the real refresh finally block, not just network delivery. HTTP
  // completion alone does not prove the app has consumed a delayed response.
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __matrixStatusSettled?: number }).__matrixStatusSettled ?? 0))
    .toBe(count);
}

/** Drain applied state, not responses: failed/stale checks never append here. */
export async function takeAppliedCompletionStatuses(page: Page) {
  return page.evaluate(() => {
    const observed = window as Window & { __matrixAppliedStatuses?: boolean[] };
    return (observed.__matrixAppliedStatuses ??= []).splice(0);
  });
}

export async function pauseCompletionClock(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

export async function submitReplay(page: Page) {
  await page.locator('#terminal-input').focus();
  await page.keyboard.type('matrix_test');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('#terminal-input').getAttribute('data-command-busy')).toBe('true');
}

type CompletionDocument = Window & {
  __completionDocument: { id: string; solveEvents: number };
};

/** Observe local events and reloads without injecting an award into either tab. */
export async function observeCompletionDocument(page: Page) {
  await page.addInitScript(() => {
    const state = { id: crypto.randomUUID(), solveEvents: 0 };
    (window as unknown as CompletionDocument).__completionDocument = state;
    document.addEventListener('ctf:solve-confirmed', () => { state.solveEvents++; });
  });
}

export async function completionDocument(page: Page) {
  return page.evaluate(() => (window as unknown as CompletionDocument).__completionDocument);
}

type DeliveryGate = {
  received: boolean;
  outcome?: 'fulfilled' | 'rejected';
  errorMessage?: string;
  wait: Promise<void>;
  release(): void;
};

export async function appliedStatuses(page: Page) {
  return page.evaluate(() => (window as CompletionWindow).__matrixStatusesApplied ?? []);
}

type CompletionWindow = Window & typeof globalThis & {
  __matrixDeliveryQueue?: DeliveryGate[];
  __matrixDeliveries?: DeliveryGate[];
  __matrixStatusesApplied?: boolean[];
  __matrixReplaySettled?: number;
  __matrixReplayResults?: Array<string | null>;
  __matrixFailedCompletionWrites?: number;
  __matrixLifecycle: { replace(): void };
  __matrixAuth: { invalidateAuthentication(message: string): void };
  offlineMatrixSession: { logout(): Promise<string>; refresh(): Promise<void> };
};
