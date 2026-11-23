import { spawnSync } from 'node:child_process';

// Same offline fixture in all engines; unavailable browsers fail, never skip.
let failed = false;
for (const browser of ['chromium', 'firefox', 'webkit']) {
  console.log(`\nIdle Matrix audio regressions: ${browser}`);
  const result = spawnSync('pnpm', [
    'exec', 'vitest', 'run', '--config', 'vitest.browser.config.ts',
    'tests/browser/terminal.smoke.ts', '-t', 'idle Matrix:',
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TERMINAL_BROWSER: browser },
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
