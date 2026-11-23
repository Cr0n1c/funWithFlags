import { spawnSync } from 'node:child_process';

// Run sequentially: OS clipboards can be shared between browser processes.
// A missing engine or failed test is a failure, never an implicit skip.
let failed = false;
for (const browser of ['chromium', 'firefox', 'webkit']) {
  console.log(`\nTerminal clipboard regressions: ${browser}`);
  const result = spawnSync('pnpm', [
    'exec', 'vitest', 'run', '--config', 'vitest.browser.config.ts',
    'tests/browser/terminal.smoke.ts', '-t', 'clipboard:',
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TERMINAL_BROWSER: browser },
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
