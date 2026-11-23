import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { resolve } from 'node:path';
import type { EditorSession } from '../../src/js/shell/editor.js';
import { fixtureTimings } from './fixture-timings.js';

const timings = fixtureTimings('editor');

declare global {
  interface Window {
    editorFixture: {
      session: EditorSession;
      saves: string[];
      fail: boolean;
      scroll: number;
      release?: () => void;
      open: (writable?: boolean) => void;
    };
  }
}
let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const built = timings.start('bundle');
  const root = resolve(import.meta.dirname, '../..');
  const result = await build({
    root, configFile: false, envFile: false, logLevel: 'error',
    plugins: [{
      name: 'offline-editor-fixture',
      resolveId: (id) => id === 'fixture' || id === resolve(root, 'fixture') ? '\0fixture' : undefined,
      load: (id) => id === '\0fixture' ? `
        import ${JSON.stringify(resolve(root, 'src/sass/main.scss'))};
        import ${JSON.stringify(resolve(root, 'src/sass/terminal.scss'))};
        import { startEditorView } from ${JSON.stringify(resolve(root, 'src/js/terminal/editorView.ts'))};
        import { openEditor } from ${JSON.stringify(resolve(root, 'src/js/shell/editor.ts'))};
        window.editorFixture = { saves: [], fail: false, open(writable = true) {
          this.session = openEditor('/home/synthetic/file', '', writable, 'Permission denied');
          startEditorView({ session: this.session, close: () => {}, save: async content => {
            this.saves.push(content);
            await new Promise(resolve => { this.release = resolve; });
            if (this.fail) throw Error('Offline write failure');
          }});
        }};
      ` : undefined,
    }],
    build: { write: false, lib: { entry: 'fixture', formats: ['iife'], name: 'Fixture' } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw Error('Missing bundle');
  bundle = output.output.filter((item) => item.type === 'chunk').map((item) => item.code).join('\n');
  css = output.output.map((item) =>
    item.type === 'asset' && item.fileName.endsWith('.css') ? item.source : '').join('\n');
  built();
  const launched = timings.start('browser');
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-background-networking', '--no-proxy-server'],
  });
  launched();
});
afterAll(async () => { await browser?.close(); timings.report(); });

async function fixture(check: (page: Page) => Promise<void>, writable = true) {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await context.route('**/*', (route) => route.abort());
  await page.setContent(`<style>${css}</style>
    <div class="wrapper container"><div class="terminal-content">
    <div class="terminal"><div class="terminal-content-inner">
    <div id="terminal-output"><b>untouched output</b></div>
    <div id="terminal-input-wrapper"><span id="input-prefix">owner $ </span>
    <div id="terminal-input" contenteditable="true">pending shell text</div></div>
  </div></div></div></div>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate((writable) => {
    document.querySelector('.terminal')!.scrollTop = 30;
    window.editorFixture.scroll = document.querySelector('.terminal')!.scrollTop;
    window.editorFixture.open(writable);
  }, writable);
  try {
    await visibleEditor(page);
    await check(page);
  } finally { await context.close(); }
}

async function visibleEditor(page: Page, bottom = page.viewportSize()!.height) {
  for (const selector of ['.vi-screen', '.vi-buffer', '.vi-controls', '.vi-controls button']) {
    for (const element of await page.locator(selector).all()) {
      const rect = await element.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.height).toBeGreaterThan(15);
      expect(rect!.width).toBeGreaterThan(15);
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(bottom);
    }
  }
}

async function native(
  page: Page, inputType: string, data: string | null = null, cancelable = true,
) {
  await page.getByTestId('vi-input').evaluate((element, args) => {
    const input = element as HTMLTextAreaElement;
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: args.cancelable, inputType: args.inputType, data: args.data });
    if (input.dispatchEvent(event)) {
      input.value = args.data === null ? '' : '\u200b' + args.data;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: args.inputType, data: args.data }));
    }
  }, { inputType, data, cancelable });
}
async function paste(page: Page, text: string) {
  await page.getByTestId('vi-input').evaluate((input, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    data.setData('text/html', '<img src=x onerror="throw Error()">');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}
const lines = (page: Page) => page.evaluate(() => window.editorFixture.session.lines);

it('accepts virtual input, deletion, multiline literal paste and touch-only save; restores the shell', async () => {
  await fixture(async (page) => {
    await paste(page, ':wq\n');
    expect(await lines(page)).toEqual(['']);
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    // A synthetic visual viewport shrink models keyboard occlusion without
    // changing the layout viewport, as on mobile browsers.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 320 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await visibleEditor(page, 320);
    await native(page, 'insertText', 'mobile');
    await native(page, 'deleteContentBackward');
    await native(page, 'insertText', 'e', false);
    await native(page, 'insertLineBreak');
    await paste(page, '<b>literal</b>\r\n:wq\rEND');
    expect(await lines(page)).toEqual(['mobile', '<b>literal</b>', ':wq', 'END']);
    expect(await page.getByTestId('vi-buffer').locator('b').count()).toBe(0);
    await page.getByRole('button', { name: 'Esc', exact: true }).click();
    await page.getByRole('button', { name: ':', exact: true }).click();
    await paste(page, 'wq\n');
    expect(await page.evaluate(() => window.editorFixture.saves)).toEqual([]);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await native(page, 'insertText', 'ignored');
    expect(await lines(page)).toEqual(['mobile', '<b>literal</b>', ':wq', 'END']);
    await page.evaluate(() => window.editorFixture.release!());
    await page.getByTestId('vi-screen').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => window.editorFixture.saves)).toEqual(['mobile\n<b>literal</b>\n:wq\nEND\n']);
    expect(await page.locator('#terminal-output').innerHTML()).toBe('<b>untouched output</b>');
    expect(await page.locator('#input-prefix').textContent()).toBe('owner $ ');
    expect(await page.locator('#terminal-input').innerText()).toBe('pending shell text');
    expect(await page.locator('#terminal-input').getAttribute('contenteditable')).toBe('true');
    expect(await page.locator('.terminal').evaluate((element) => element.scrollTop))
      .toBe(await page.evaluate(() => window.editorFixture.scroll));
    expect(await page.locator('.terminal-content-inner').getAttribute('style')).toBe('');
    expect(await page.locator('#terminal-input').evaluate((element) => element === document.activeElement)).toBe(true);
  });
});

it('commits IME once in either event order, ignores cancelled composition and keeps failed writes editable', async () => {
  await fixture(async (page) => {
    await page.keyboard.press('i');
    for (const [text, afterEnd] of [['日本', false], ['語', true]] as const) {
      await page.getByTestId('vi-input').evaluate((element, { text, afterEnd }) => {
        const input = element as HTMLTextAreaElement;
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }));
        input.value = '\u200b' + text;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: text, isComposing: true }));
        if (!afterEnd) input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
        if (afterEnd) {
          input.value = '\u200b' + text;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
      }, { text, afterEnd });
    }
    await page.getByTestId('vi-input').evaluate((input) => {
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
    });
    expect(await lines(page)).toEqual(['日本語']);
    await page.keyboard.press('Escape');
    await page.keyboard.type(':wq');
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      window.editorFixture.fail = true;
      window.editorFixture.release!();
    });
    await expect.poll(() => page.getByTestId('vi-command').innerText()).toContain('Offline write failure');
    expect(await lines(page)).toEqual(['日本語']);
    expect(await page.evaluate(() => window.editorFixture.session.dirty)).toBe(true);
    await page.keyboard.press('a');
    await page.keyboard.type('!');
    expect(await lines(page)).toEqual(['日本語!']);
    await page.keyboard.press('Escape');
    await page.keyboard.type(':q!');
    await page.keyboard.press('Enter');
    await page.getByTestId('vi-screen').waitFor({ state: 'detached' });
  });
});

it('never calls save for readonly buffers after native typing or paste', async () => {
  await fixture(async (page) => {
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    await paste(page, 'unsaved');
    await page.keyboard.press('Escape');
    await page.keyboard.type(':wq');
    await page.keyboard.press('Enter');
    expect(await page.getByTestId('vi-command').innerText()).toContain('Permission denied');
    expect(await page.evaluate(() => window.editorFixture.saves)).toEqual([]);
    expect(await lines(page)).toEqual(['unsaved']);
  }, false);
});