import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { build } from 'vite';
import { resolve } from 'node:path';
import type { ShellRun } from '../../src/js/shell/hpux.js';
import { fixtureTimings } from './fixture-timings.js';

const timings = fixtureTimings('compounds');

declare global {
  interface Window {
    compoundShell: (command: string) => Promise<ShellRun>;
  }
}

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const built = timings.start('bundle');
  const root = resolve(import.meta.dirname, '../..');
  // Bundle only the actual shell, with its synthetic operator identity and
  // in-memory filesystem. No app auth, API, .env, preview server or live storage.
  const result = await build({
    root, configFile: false, envFile: false, logLevel: 'error',
    plugins: [{
      name: 'offline-compound-shell',
      resolveId: id => id === 'fixture' || id === resolve(root, 'fixture') ? '\0fixture' : undefined,
      load: id => id === '\0fixture' ? `
        import { runShell } from ${JSON.stringify(resolve(root, 'src/js/shell/hpux.ts'))};
        window.compoundShell = runShell;
      ` : undefined,
    }],
    build: { write: false, target: 'es2022', lib: { entry: 'fixture', formats: ['iife'], name: 'CompoundShell' } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw Error('Missing shell bundle');
  bundle = output.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  built();
  const launched = timings.start('browser');
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-background-networking', '--no-proxy-server'],
  });
  launched();
});

afterAll(async () => { await browser?.close(); timings.report(); });

it('captures compounds, streams, pipelines and quoted arguments offline', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests: string[] = [];
  const errors: string[] = [];
  await context.route('**/*', route => {
    requests.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<pre id="result">Offline shell smoke</pre>');
    await page.addScriptTag({ content: bundle });
    const run = (command: string) => page.evaluate(
      command => window.compoundShell(command), command,
    );
    for (const [command, output, exitCode] of [
      ['if true; then echo found; else echo lost; fi', 'found\n', 0],
      ['if false; then echo lost; elif true; then echo alternate; fi', 'alternate\n', 0],
      ['for item in one two; do echo "$item"; done', 'one\ntwo\n', 0],
      ['while true; do echo while; break; done', 'while\n', 0],
      ['until false; do echo until; break; done', 'until\n', 0],
      ['if true; then echo out; echo err >&2; false; fi', 'out\nerr\n', 1],
      ['if true; then echo piped; fi | cat', 'piped\n', 0],
      ['show() { printf "<%s>\\n" "$@"; }; show "two words" "" "a*b"', '<two words>\n<>\n<a*b>\n', 0],
      ['show "still quoted" ""', '<still quoted>\n<>\n', 0],
      ['show "through pipe" | cat', '<through pipe>\n', 0],
      ['bad() { echo problem >&2; return 7; }; bad', 'problem\n', 7],
      ['if true; then echo saved > /tmp/compound-output; fi; cat /tmp/compound-output', 'saved\n', 0],
      ['echo "$(if true; then echo substituted; fi)"', 'substituted\n', 0],
    ] as const) {
      expect(await run(command), command).toMatchObject({ output, exitCode });
    }
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});