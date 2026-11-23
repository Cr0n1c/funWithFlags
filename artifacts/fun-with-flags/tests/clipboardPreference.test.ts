import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let store: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
let doc: EventTarget;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  store = new Map();
  storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
  };
  doc = new EventTarget();
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('document', doc);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('defaults on and persists only a boolean, surviving module reloads', async () => {
  let preference = await import('../src/js/terminal/clipboardPreference.js');
  expect(preference.isAutoCopyEnabled()).toBe(true);
  expect(preference.autoCopyCommand([])).toContain('ON');
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(preference.autoCopyCommand(['off'])).toContain('OFF');
  expect([...store.values()]).toEqual(['false']);
  vi.resetModules();
  preference = await import('../src/js/terminal/clipboardPreference.js');
  expect(preference.isAutoCopyEnabled()).toBe(false);
  expect(preference.autoCopyCommand(['on'])).toContain('ON');
  expect([...store.values()]).toEqual(['true']);
  vi.resetModules();
  expect((await import('../src/js/terminal/clipboardPreference.js')).isAutoCopyEnabled()).toBe(true);
});

it.each(['null', '{}', '"false"', '0', 'invalid'])('ignores malformed saved preferences: %s', async raw => {
  storage.getItem.mockReturnValue(raw);
  const { isAutoCopyEnabled } = await import('../src/js/terminal/clipboardPreference.js');
  expect(isAutoCopyEnabled()).toBe(true);
});

it('rejects invalid arguments without changing the preference or writing storage', async () => {
  const { autoCopyCommand, isAutoCopyEnabled } = await import('../src/js/terminal/clipboardPreference.js');
  for (const args of [['invalid'], ['off', 'extra']]) {
    expect(autoCopyCommand(args)).toContain('Usage: autocopy [on|off]');
    expect(isAutoCopyEnabled()).toBe(true);
  }
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('keeps the setting usable in memory and explains blocked storage', async () => {
  storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
  storage.setItem.mockImplementation(() => { throw new Error('blocked'); });
  const { autoCopyCommand, autoCopyStatus } = await import('../src/js/terminal/clipboardPreference.js');
  expect(autoCopyStatus()).toContain('ON');
  expect(autoCopyCommand(['off'])).toContain('OFF');
  expect(autoCopyStatus()).toContain('Preference not saved; applies to this tab only');
  expect(autoCopyCommand(['on'])).toContain('ON');
});

async function installedCopy() {
  const children: Array<{ textContent: string; className: string }> = [];
  Object.assign(doc, {
    createElement: () => ({ textContent: '', className: '', setAttribute: vi.fn() }),
    getElementById: () => ({ hidden: false }),
  });
  const selectedNode = {};
  const output = {
    after: (...nodes: typeof children) => children.push(...nodes),
    contains: (node: unknown) => node === selectedNode,
  };
  Object.assign(window, {
    getSelection: () => ({
      isCollapsed: false, rangeCount: 1,
      getRangeAt: () => ({ startContainer: selectedNode, endContainer: selectedNode }),
      toString: () => 'synthetic output',
    }),
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { installSelectionCopy } = await import('../src/js/terminal/clipboard.js');
  installSelectionCopy(output as unknown as HTMLElement);
  // Only actionable failure feedback remains; there is no persistent ON/OFF banner.
  expect(children).toHaveLength(1);
  expect(children[0]!.className).toBe('clipboard-status');
  return { writeText, status: children[0]!, ...await import('../src/js/terminal/clipboardPreference.js') };
}

it('copies while enabled, cancels queued copies when paused, and resumes with the same selection', async () => {
  const { writeText, status, autoCopyCommand } = await installedCopy();
  doc.dispatchEvent(new Event('selectionchange'));
  expect(vi.getTimerCount()).toBe(1);
  expect(autoCopyCommand(['off'])).toContain('OFF');
  expect(vi.getTimerCount()).toBe(0);
  await vi.runAllTimersAsync();
  expect(writeText).not.toHaveBeenCalled();
  expect(autoCopyCommand(['on'])).toContain('ON');
  doc.dispatchEvent(new Event('pointerup'));
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledExactlyOnceWith('synthetic output');
  expect(status.textContent).toBe('');
  // A completed selection is deduplicated until the preference changes.
  doc.dispatchEvent(new Event('selectionchange'));
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(autoCopyCommand(['off'])).toContain('OFF');
  doc.dispatchEvent(new Event('pointerup'));
  doc.dispatchEvent(Object.assign(new Event('keyup'), { key: 'Shift' }));
  doc.dispatchEvent(new Event('selectionchange'));
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(status.textContent).toBe('');
  expect(autoCopyCommand(['on'])).toContain('ON');
  doc.dispatchEvent(new Event('selectionchange'));
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(status.textContent).toBe('');
  expect([...store.values()]).toEqual(['true']);
});

it('does not copy on pointer, keyboard, or delayed selection events when loaded disabled', async () => {
  storage.getItem.mockReturnValue('false');
  const { writeText } = await installedCopy();
  for (const name of ['pointerup', 'selectionchange']) doc.dispatchEvent(new Event(name));
  doc.dispatchEvent(Object.assign(new Event('keyup'), { key: 'ArrowRight' }));
  await vi.runAllTimersAsync();
  expect(writeText).not.toHaveBeenCalled();
});

it('shows manual-copy guidance on failure and silently clears it on successful retry', async () => {
  const { writeText, status } = await installedCopy();
  writeText.mockRejectedValueOnce(new Error('synthetic clipboard denial'));
  doc.dispatchEvent(new Event('pointerup'));
  await vi.runAllTimersAsync();
  expect(status.textContent).toContain('Auto-copy unavailable');
  expect(status.textContent).toContain('selection menu');
  expect(status.textContent).toContain('Ctrl+C');
  doc.dispatchEvent(new Event('pointerup'));
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(status.textContent).toBe('');
});

it('clears failure feedback when paused', async () => {
  const { writeText, status, autoCopyCommand } = await installedCopy();
  writeText.mockRejectedValueOnce(new Error('synthetic clipboard denial'));
  doc.dispatchEvent(new Event('pointerup'));
  await vi.runAllTimersAsync();
  expect(status.textContent).toContain('Auto-copy unavailable');
  expect(autoCopyCommand(['off'])).toContain('OFF');
  expect(status.textContent).toBe('');
});

it.each(['success', 'failure'])('ignores stale copy %s after pausing and allows the same selection on resume', async result => {
  const { writeText, status, autoCopyCommand } = await installedCopy();
  let settle!: () => void;
  writeText.mockReturnValueOnce(new Promise<void>((resolve, reject) => {
    settle = () => result === 'success' ? resolve() : reject(new Error('synthetic delayed denial'));
  }));
  doc.dispatchEvent(new Event('pointerup'));
  expect(writeText).toHaveBeenCalledExactlyOnceWith('synthetic output');
  expect(autoCopyCommand(['off'])).toContain('OFF');
  settle();
  await vi.runAllTimersAsync();
  expect(status.textContent).toBe('');
  expect(autoCopyCommand(['on'])).toContain('ON');
  doc.dispatchEvent(new Event('pointerup'));
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(status.textContent).toBe('');
});

it.each(['success', 'failure'])('does not let an old copy %s overwrite current feedback after resuming', async result => {
  const { writeText, status, autoCopyCommand } = await installedCopy();
  let settle!: () => void;
  writeText.mockReturnValueOnce(new Promise<void>((resolve, reject) => {
    settle = () => result === 'success' ? resolve() : reject(new Error('synthetic delayed denial'));
  }));
  doc.dispatchEvent(new Event('pointerup'));
  autoCopyCommand(['off']);
  autoCopyCommand(['on']);
  if (result === 'success') {
    writeText.mockRejectedValueOnce(new Error('synthetic current denial'));
  }
  doc.dispatchEvent(new Event('pointerup'));
  await vi.runAllTimersAsync();
  expect(writeText).toHaveBeenCalledTimes(2);
  const currentFeedback = status.textContent;
  if (result === 'success') expect(currentFeedback).toContain('Auto-copy unavailable');
  else expect(currentFeedback).toBe('');
  settle();
  await vi.runAllTimersAsync();
  expect(status.textContent).toBe(currentFeedback);
});
