import { expect } from 'vitest';
import type { Page } from 'playwright';

const selected = (page: Page) => page.evaluate(() => getSelection()?.toString());
const status = (page: Page) => page.locator('.clipboard-status').innerText();
const prompt = (page: Page) => page.locator('#terminal-input');

async function fixture(page: Page, text = 'copy this terminal text') {
  await page.evaluate((text) => {
    document.getElementById('clipboard-fixture')?.remove();
    const line = document.createElement('div');
    line.id = 'clipboard-fixture';
    line.textContent = text;
    // A short synthetic transcript avoids asynchronous welcome scrolling
    // moving the drag target between mousedown and mouseup.
    document.getElementById('terminal-output')!.replaceChildren(line);
    // A synthetic pending marker lets us await completion without a success
    // notice or replacing the browser's native clipboard implementation.
    document.querySelector('.clipboard-status')!.textContent = 'waiting for copy';
    line.scrollIntoView({ block: 'center' });
  }, text);
  return page.locator('#clipboard-fixture');
}

async function selectRange(page: Page, start = 0, end?: number) {
  await page.evaluate(({ start, end }) => {
    const node = document.getElementById('clipboard-fixture')!.firstChild!;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end ?? node.textContent!.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, { start, end });
}

async function drag(page: Page) {
  const points = await page.locator('#clipboard-fixture').evaluate((line) => {
    const range = document.createRange();
    range.selectNodeContents(line);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(points.left + 1, points.y);
  await page.mouse.down();
  await page.mouse.move(points.right - 1, points.y, { steps: 12 });
  // No write should happen during the drag, even after the debounce fires.
  await page.waitForTimeout(400);
  expect(await status(page)).toBe('waiting for copy');
  await page.mouse.up();
}

export async function clipboardDragJourney(page: Page) {
  const text = 'copy this terminal text';
  await fixture(page, text);
  await drag(page);
  await expect.poll(() => selected(page)).toBe(text);
  await expect.poll(() => status(page)).toBe('');
  expect(await prompt(page).innerText()).toBe('');
  // Read the REAL clipboard by native paste, without a clipboard-read grant.
  await page.keyboard.press('Control+v');
  await expect.poll(() => prompt(page).innerText()).toBe(text);

  // Seed an output range. Selection extension is a real keyboard action, not
  // Selection.modify() or a dispatched KeyboardEvent.
  await prompt(page).fill('');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.querySelector('.clipboard-status')!.textContent = 'waiting for copy';
  });
  await selectRange(page, 0, 5);
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await expect.poll(() => selected(page)).toBe('copy');
  await expect.poll(() => status(page)).toBe('');
  await page.keyboard.press('Control+v');
  await expect.poll(() => prompt(page).innerText()).toBe('copy');

  // Use native Copy to seed multiline clipboard bytes; never stub writeText.
  // Native paste must insert literal text
  // at a nonterminal caret, never HTML or an automatically submitted command.
  await fixture(page, '<b>literal</b>\necho NOT_EXECUTED');
  await selectRange(page);
  await page.keyboard.press('Control+c');
  await prompt(page).fill('prefix suffix');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  const completions = await prompt(page).getAttribute('data-command-completions');
  const outputBefore = await page.locator('#terminal-output').innerText();
  await page.keyboard.press('Control+v');
  await expect.poll(() => prompt(page).innerText()).toBe('p<b>literal</b> echo NOT_EXECUTEDrefix suffix');
  expect(await prompt(page).locator('b').count()).toBe(0);
  expect(await prompt(page).getAttribute('data-command-completions')).toBe(completions);
  expect(await page.locator('#terminal-output').innerText()).toBe(outputBefore);
}

export async function clipboardRestrictedJourney(page: Page, browserName: string) {
  // Explicit native permission denial in Chromium. Merely granting read is
  // insufficient: Chromium can also grant writes through that permission.
  // Firefox/WebKit instead enforce transient user activation.
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', {
      permission: { name: 'clipboard-write', allowWithoutSanitization: false }, setting: 'denied',
      origin: new URL(page.url()).origin, browserContextId: targetInfo.browserContextId,
    });
    // Keep this session until context teardown: detaching clears its overrides.
    expect(await page.evaluate(async () =>
      (await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })).state,
    )).toBe('denied');
  }
  await fixture(page, 'manual copy fallback');
  // evaluate() itself grants transient activation in some browser drivers.
  // Schedule selection after that activation expires, without stubbing APIs.
  // Observe the result inside this evaluation: polling with a fresh evaluate()
  // can renew activation while a delayed selectionchange/write is still pending.
  const automaticStatus = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const statusNode = document.querySelector('.clipboard-status')!;
    statusNode.textContent = '';
    const observer = new MutationObserver(() => {
      const message = statusNode.textContent ?? '';
      if (!message) return;
      observer.disconnect();
      clearTimeout(deadline);
      resolve(message);
    });
    observer.observe(statusNode, { childList: true, subtree: true, characterData: true });
    const selectionTimer = setTimeout(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('clipboard-fixture')!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    }, 6500);
    const deadline = setTimeout(() => {
      clearTimeout(selectionTimer);
      observer.disconnect();
      reject(new Error('Automatic copy produced no status after activation expired'));
    }, 15_000);
  }));
  expect(automaticStatus).toContain('Auto-copy unavailable');
  expect(await selected(page)).toBe('manual copy fallback');
  // Real Ctrl+C must still work after async clipboard denial, and must leave
  // the selected output intact. It is not enough just to inspect the message.
  await page.keyboard.press('Control+c');
  expect(await selected(page)).toBe('manual copy fallback');
  await page.keyboard.press('Control+v');
  await expect.poll(() => prompt(page).innerText()).toBe('manual copy fallback');
  // Re-selecting after a failed write must be retryable with a real gesture.
  await prompt(page).fill('');
  await page.evaluate(() => { document.querySelector('.clipboard-status')!.textContent = 'waiting for copy'; });
  await drag(page);
  if (browserName === 'chromium') {
    await expect.poll(() => status(page)).toContain('Auto-copy unavailable');
  } else {
    await expect.poll(() => status(page)).toBe('');
  }
}

export async function clipboardTouchJourney(page: Page) {
  await fixture(page, 'touch selection text');
  // Playwright cannot manipulate OS selection handles. This is explicitly a
  // selectionchange contract check in a touch context, not real-handle evidence.
  // No pointerup is dispatched: handle adjustments can emit selectionchange only.
  // A write spy isolates event scheduling from platform permission policies;
  // actual clipboard success and rejection are covered by the desktop cases.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: (text: string) => {
        document.documentElement.dataset.clipboardWrite = text;
        return Promise.resolve();
      },
    });
  });
  await selectRange(page, 0, 5);
  await expect.poll(() => page.locator('html').getAttribute('data-clipboard-write')).toBe('touch');
  expect(await selected(page)).toBe('touch');
  await selectRange(page, 0, 15);
  await expect.poll(() => page.locator('html').getAttribute('data-clipboard-write')).toBe('touch selection');
  expect(await selected(page)).toBe('touch selection');
  expect(await prompt(page).innerText()).toBe('');
  // Prompt text (including a masked answer) must never be auto-copied.
  await page.evaluate(() => {
    document.getElementById('terminal-input')!.textContent = 'private draft';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('terminal-input')!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.waitForTimeout(450);
  expect(await page.locator('html').getAttribute('data-clipboard-write')).toBe('touch selection');
  await page.evaluate(() => { document.getElementById('terminal-input')!.textContent = ''; });

  // Hidden prompt is the shared editor/pager ownership boundary. A deliberate
  // write spy is appropriate here: prove no attempt, not clipboard success.
  await page.evaluate(() => {
    document.getElementById('terminal-input-wrapper')!.hidden = true;
    document.querySelector('.clipboard-status')!.textContent = 'owned by editor/pager';
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: () => { throw Error('Shell must not copy while hidden'); },
    });
  });
  await selectRange(page);
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(450);
  expect(await status(page)).toBe('owned by editor/pager');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'must not reach shell');
    document.body.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: data,
    }));
  });
  expect(await prompt(page).textContent()).toBe('');
}
