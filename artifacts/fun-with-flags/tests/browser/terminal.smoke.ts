import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, firefox, webkit, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright';
import { clipboardDragJourney, clipboardRestrictedJourney, clipboardTouchJourney } from './clipboard-journeys.js';
import { pagerDesktopJourney, pagerDesktopLayouts } from './pager-zoom-journeys.js';
import { configureOfflineTimeouts, reloadWithDiagnostics, startupDiagnostics } from './startup-diagnostics.js';
import { sharedHookPhase, sharedHookTeardown } from './shared-hook-diagnostics.js';
import {
  assertPromptRestored, beginKnock, dismissMatrixReward, disposeMatrix, expireMatrixIdentity,
  followRabbit, matrixTestHooks, prepareMatrix, refreshMatrixIdentity, suspendMatrixAudio,
  traceAudio, matrixRuntime, reachActiveMatrixStage,
} from './idle-matrix-journeys.js';
import { build } from 'vite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { user } from '../fixtures/account.js';
import { nextFortune, SYNTHETIC_CORE } from '../../src/js/shell/games.js';
import type { CurrentUser } from '../../src/js/services/authService.js';
import { AVAILABLE_COMMANDS } from '../../src/js/handlers/commands.js';
import { fixtureTimings } from './fixture-timings.js';
import {
  MatrixCompletionFixture, completionDocument, observeCompletionDocument,
  pauseCompletionClock, statusSettled, submitReplay, takeAppliedCompletionStatuses,
  appliedStatuses, replaceMatrix, endMatrixSession, resumeMatrixSession, replaySettled,
  takeFailedCompletionWrites, replayResults,
} from './matrix-completion-fixture.js';

const timings = fixtureTimings('terminal');
const startupByPage = new WeakMap<Page, ReturnType<typeof startupDiagnostics>>();

const activityNames = new Set([
  ...AVAILABLE_COMMANDS, 'leaderboard', 'top', 'rank', 'groups', 'history', 'mail',
  'reset-shell', 'shell command',
]);

const origin = 'https://terminal-smoke.invalid';
const root = resolve(import.meta.dirname, '../..');
// Immutable bytes only; never cache a context, page, session or browser storage.
const assets = new Map<string, string | Buffer>();
const contentTypes: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
};
// Keep the production bundle and real command-output animation, but render the
// repeated welcome banner immediately in this offline fixture. This transform
// fails closed if boot changes, rather than silently running a different path.
function fastWelcomeBoot(code: string): string {
  for (const [original, replacement] of [
    ['await animateText(newOutputLine, bannerParts[0]);', 'appendTerminalText(newOutputLine, bannerParts[0]);'],
    ["await animateText(newOutputLine, '\\n    HIMEM is testing extended memory...\\n');",
      "appendTerminalText(newOutputLine, '\\n    HIMEM is testing extended memory...\\n');"],
    ['await animateMemoryCount(line, target);', 'await animateMemoryCount(line, target, 1);'],
    ['await animateText(newOutputLine, remainingBanner);', 'appendTerminalText(newOutputLine, remainingBanner);'],
    ['await animateText(loginLine, `\\n    ${postLoginMessage}\\n`);',
      'appendTerminalText(loginLine, `\\n    ${postLoginMessage}\\n`);'],
  ] as const) {
    if (code.split(original).length !== 2) throw new Error('Offline fast boot no longer matches welcome animation');
    code = code.replace(original, replacement);
  }
  return code;
}

// Opt-in command gates exist only in this in-memory, network-isolated bundle.
// Hold the command promise itself so transport cancellation cannot hide a stale
// renderer continuation. All rendering, input handling and cleanup stay real.
function terminalOwnershipHooks(code: string, id: string): string {
  if (id.endsWith('/src/js/terminal/terminal.ts')) {
    // Unlike the synthetic return gate below, these gates pause real commands
    // after real local shell work, before their UI side effects.
    for (const [marker, key] of [
      ['await (await shell()).recordUserCommand(rawLine);', "'__history:' + rawLine"],
      ['const opened = await (await shell()).openForEdit(target);', "'__editor'"],
    ]) {
      if (code.split(marker!).length !== 2) throw new Error('Offline shell continuation changed');
      code = code.replace(marker!, `${marker}
        {
          const gate = window.__terminalCommandGates?.find(g => g.command === ${key} && !g.entered);
          if (gate) { gate.entered = true; await gate.wait; }
        }
      `);
    }
    const entry = "const rawLine = inputText ?? '';";
    if (code.split(entry).length !== 2) throw new Error('Offline command gate entry changed');
    return code.replace(entry, `${entry}
      const gate = window.__terminalCommandGates?.find(g => g.command === inputText && !g.entered);
      if (gate) {
        gate.entered = true;
        await gate.wait;
        if (gate.reject) throw new Error('Synthetic command rejection');
        return gate.output;
      }
    `);
  }
  if (id.endsWith('/src/js/handlers/inputHandler.ts')) {
    const entry = 'await handleEnterKey(terminalOutput, inputElement);';
    if (code.split(entry).length !== 2) throw new Error('Offline command settlement entry changed');
    return code.replace(entry, `try { ${entry} } finally {
      window.__terminalCommandSettled = (window.__terminalCommandSettled ?? 0) + 1;
    }`);
  }
  if (id.endsWith('/src/js/main.ts')) {
    return `${code}
      import { replaceTerminalLifecycle } from './terminal/lifecycle.js';
      window.__replaceTerminalLifecycle = replaceTerminalLifecycle;
    `;
  }
  return code;
}

type CommandOwnershipWindow = Window & typeof globalThis & {
  __replaceTerminalLifecycle(): void;
  __terminalCommandSettled?: number;
  __terminalCommandGates: Array<{
    command: string; output: string; reject: boolean; entered: boolean;
    wait: Promise<void>; release(): void;
  }>;
};

async function holdCommand(page: Page, command: string, reject = false) {
  const index = await page.evaluate(({ command, reject }) => {
    const fixture = window as CommandOwnershipWindow;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    return (fixture.__terminalCommandGates ??= []).push({
      command, output: 'SYNTHETIC-COMMAND-RESULT', reject, entered: false, wait, release,
    }) - 1;
  }, { command, reject });
  return {
    entered: () => expect.poll(() => page.evaluate(index =>
      (window as CommandOwnershipWindow).__terminalCommandGates[index]?.entered, index)).toBe(true),
    release: () => page.evaluate(index =>
      (window as CommandOwnershipWindow).__terminalCommandGates[index]!.release(), index),
  };
}
let browser: Browser | undefined;
let scratch: string | undefined;
const browserName = process.env.TERMINAL_BROWSER ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) {
  throw new Error('Unsupported offline browser selection');
}

beforeAll(async () => {
  const built = timings.start('bundle');
  const result = await sharedHookPhase('build', async () => {
    scratch = await mkdtemp(resolve(tmpdir(), 'fwf-browser-'));
    // Ignore workspace Vite config and .env files; no server, credentials or dist writes.
    return build({
      root, configFile: false, envDir: scratch, base: '/',
      // Raw Vite errors can include source or paths; the wrapper reports only a
      // fixed phase and failure class. Production bundle transforms stay unchanged.
      logLevel: 'silent',
      build: { write: false, target: 'es2022' },
      plugins: [{
        name: 'offline-fast-welcome',
        enforce: 'pre',
        transformIndexHtml() {
          // The power-on transform changes getBoundingClientRect(). Suppress only
          // that decorative animation in the offline HTML, including on reload;
          // page.addStyleTag() is lost when clock/audio fixtures reload the page.
          // Command, pager, train and other production animations stay untouched.
          return [{
            tag: 'style',
            children: '#switch:checked ~ .container > .terminal-content { animation: none !important; }',
            injectTo: 'head',
          }];
        },
        transform(code, id) {
          code = terminalOwnershipHooks(code, id);
          if (id.endsWith('/src/js/terminal/terminal.ts')) return fastWelcomeBoot(code);
          if (id.endsWith('/src/js/main.ts')) {
            // Offline bundle only: change the real shared auth state and run the
            // real terminal resume path without navigating away. A reload would
            // destroy the old timers and hide account-boundary cleanup failures.
            code = `${code}
            import { logout, refreshCurrentUser } from './services/authService.js';
            window.offlineMatrixSession = {
              logout,
              refresh: async () => {
                await refreshCurrentUser();
                await resumeTerminal();
              },
            };
          `;
          }
          if (process.env.SMOKE_INJECT_MISSING_GLOBAL === '1' && id.endsWith('/src/js/shell/hpux.ts')) {
            return `__FWF_MISSING_BROWSER_GLOBAL__.boot();\n${code}`;
          }
          return matrixTestHooks(code, id) ?? code;
        },
      }],
    });
  });
  await sharedHookPhase('assets', () => {
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!('output' in output)) throw new Error('Expected an in-memory production bundle');
      for (const item of output.output) {
        const source = item.type === 'chunk' ? item.code : item.source;
        assets.set(`/${item.fileName}`, typeof source === 'string' ? source : Buffer.from(source));
      }
    }
    // Catch fixture transforms that accidentally bypass one another after merges.
    for (const hook of ['__matrixLifecycle', '__matrixAuth', 'offlineMatrixSession']) {
      if (![...assets.values()].some(value => typeof value === 'string' && value.includes(hook))) {
        throw new Error(`Offline Matrix fixture hook missing from bundle: ${hook}`);
      }
    }
  });
  built();
  const launched = timings.start('browser');
  browser = await sharedHookPhase('browser-launch', async () => {
    const executablePath = process.env.CHROMIUM_PATH || undefined;
    return browserName === 'chromium'
      ? await chromium.launch({ executablePath, args: ['--disable-background-networking', '--no-proxy-server'] })
      : browserName === 'firefox'
        ? await firefox.launch({
          executablePath: process.env.FIREFOX_PATH,
          firefoxUserPrefs: { 'dom.events.testing.asyncClipboard': false },
        })
        : await webkit.launch({ executablePath: process.env.WEBKIT_PATH });
  });
  launched();
});

afterAll(async () => {
  await sharedHookTeardown(
    async () => {
      await browser?.close();
      browser = undefined;
    },
    async () => {
      try {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
      } finally {
        assets.clear();
      }
    },
  ).finally(() => timings.report());
});

interface SyntheticSession {
  userPointsAwarded?: boolean;
  matrixCompletion?: MatrixCompletionFixture;
  activityCommands: string[];
  user: CurrentUser | null;
  homes: string[];
  logoutRequests: number;
  gold: GoldRow;
  /** When set, replaces the single default row in the challenge listing. */
  goldRows?: GoldRow[];
  detailRequests: number;
  detailTitle?: string;
  detailDescription?: string;
  importRequests: number;
  backupPreviewRequests: number;
  backupImportRequests: number;
  exportRequests: number;
  backupPreview: { missing: number; identical: number; conflicts: number };
  denyBackupPreview?: boolean;
  hashMissing: string[];
  terminalMissing: string[];
  expectDeniedImport?: boolean;
  submittedFlag?: string;
  scopedSubmissions?: number;
  scopedResponse?: 'incorrect' | 'correct' | 'already' | 'unauthorized';
  releaseSubmission?: Promise<void>;
  mailEvents: Array<{
    id: number; outcome: string; points: number; time: string; challenge_id: number | null;
  }>;
}

interface GoldRow {
  id: number; slug: string; category: string; title: string; description: string;
  points: number; solved: boolean; solve_count: number;
}

/** Synthetic Gold listing rows with a recognisable wide points cell. */
function pagedGoldRows(count: number, title: (number: number) => string): GoldRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1, slug: `paged-${index + 1}`, category: 'gold', title: title(index + 1),
    description: 'Offline paged fixture', points: 12345, solved: false, solve_count: 0,
  }));
}

async function withTerminal(
  authenticated: boolean,
  check: (page: Page, session: SyntheticSession) => Promise<void>,
  options: BrowserContextOptions = {},
  load = true,
) {
  if (!browser) throw new Error('Browser did not start');
  const session: SyntheticSession = {
    activityCommands: [],
    user: authenticated ? { ...user } : null,
    homes: [user.home],
    logoutRequests: 0,
    mailEvents: [],
    gold: { id: 24, slug: 'offline-hidden', category: 'gold', title: '<hidden>',
      description: '<hidden>', points: 75, solved: false, solve_count: 3 },
    detailRequests: 0,
    importRequests: 0,
    backupPreviewRequests: 0,
    backupImportRequests: 0,
    exportRequests: 0,
    backupPreview: { missing: 2, identical: 1, conflicts: 0 },
    hashMissing: ['easy', 'medium', 'hard'],
    terminalMissing: [],
  };
  const created = timings.start('context');
  const startup = startupDiagnostics();
  startup.attachBrowser(browser);
  const context = await startup.step('context',
    () => browser!.newContext({ ...options, serviceWorkers: 'block' }));
  const failures: string[] = [];
  const seen = new Set<string>();
  try {
    startup.phase('routes');
    await context.routeWebSocket('**/*', async (socket) => {
      failures.push('Unexpected WebSocket');
      await socket.close();
    });
    await context.route('**/*', startup.route(async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin === 'https://fonts.googleapis.com' && request.method() === 'GET') {
        return route.fulfill({ contentType: 'text/css', body: '/* Offline font fixture */' });
      }
      if (url.origin === origin && path === '/api/activity/command' && request.method() === 'POST') {
        const body: unknown = request.postDataJSON();
        if (!session.user || !body || typeof body !== 'object'
            || Object.keys(body).join(',') !== 'command'
            || !('command' in body) || typeof body.command !== 'string'
            || !activityNames.has(body.command)) {
          failures.push('Invalid offline command activity request');
          return json({ detail: 'Invalid activity' }, 422);
        }
        session.activityCommands.push(body.command);
        return route.fulfill({ status: 204 });
      }
      if (url.origin === origin && path === '/api/cli/commands' && request.method() === 'GET') {
        return json({ commands: ['submit', 'scoreboard', 'promote_user_to_admin'] });
      }
      if (url.origin === origin && path === '/api/cli/curl' && request.method() === 'POST') {
        const body = request.postDataJSON() as { url?: string };
        if (Object.keys(body).join(',') === 'url'
            && body.url === 'http://169.254.169.254/latest/meta-data/iam/') {
          return json({ output: 'security-credentials/' });
        }
        failures.push('Unexpected offline curl URL');
        return json({ detail: 'Unexpected curl fixture' }, 400);
      }
      if (url.origin === origin && path.startsWith('/api/training/')) {
        if (path === '/api/training/invoices/1043' && request.method() === 'GET')
          return json({ flag: 'offline-invoice-flag' });
        if (path === '/api/training/profile' && request.method() === 'POST'
            && (request.postDataJSON() as { role?: string }).role === 'admin')
          return json({ flag: 'offline-profile-flag' });
        if (path === '/api/training/files' && request.method() === 'GET'
            && url.searchParams.get('path') === '../internal/release.txt')
          return json({ content: 'offline-file-flag' });
      }
      if (url.origin === origin && path === '/api/cli/promote_user_to_admin' && request.method() === 'POST') {
        const posted = request.postDataJSON() as { token?: string };
        const valid = posted.token === 'ctf-only.7e19b42d.93ac608f.bundle';
        return valid ? json({ flag: 'offline-bundle-flag', message: 'Account privileges unchanged.' })
          : json({ detail: 'Invalid challenge token' }, 403);
      }
      if (url.origin === origin && path === '/api/auth/logout' && request.method() === 'POST') {
        session.logoutRequests++;
        session.user = null;
        return route.fulfill({ status: 204 });
      }
      if (url.origin === origin && path === '/api/challenges/submit'
          && request.method() === 'POST') {
        session.submittedFlag = (request.postDataJSON() as { flag: string }).flag;
        if (session.gold.slug === 'enter-the-matrix' && session.submittedFlag === 'neo_has_land3d') {
          session.gold.solved = true;
        }
        const event_id = session.mailEvents.length + 1;
        session.mailEvents.push({ id: event_id, outcome: 'correct', points: 50,
          time: '2026-09-25T12:00:00Z', challenge_id: session.gold.id });
        return json({ correct: true, already_solved: false, points_awarded: 50,
          total_score: 50, message: 'Flag accepted.', event_id });
      }
      if (url.origin === origin && path === `/api/challenges/${session.gold.slug}/submit`
          && request.method() === 'POST') {
        session.scopedSubmissions = (session.scopedSubmissions ?? 0) + 1;
        session.submittedFlag = (request.postDataJSON() as { flag: string }).flag;
        await session.releaseSubmission;
        if (session.scopedResponse === 'unauthorized') return json({ detail: 'Unauthorized' }, 401);
        const correct = session.scopedResponse === 'correct' || session.scopedResponse === 'already';
        const event_id = session.mailEvents.length + 1;
        session.mailEvents.push({ id: event_id,
          outcome: !correct ? 'incorrect' : session.scopedResponse === 'already' ? 'already_solved' : 'correct',
          points: session.scopedResponse === 'correct' ? 75 : 0,
          time: '2026-09-25T12:00:00Z', challenge_id: session.gold.id });
        return json({ correct, already_solved: session.scopedResponse === 'already',
          points_awarded: session.scopedResponse === 'correct' ? 75 : 0,
          total_score: correct ? 75 : 0, message: correct ? 'Accepted' : 'That is not the flag.',
          event_id });
      }
      if (url.origin === origin && path === '/api/flag-admin/access' && request.method() === 'GET') {
        return json(session.user?.groups.includes('funwithflags-admins')
          ? { allowed: true } : { detail: 'Permission denied' },
        session.user?.groups.includes('funwithflags-admins') ? 200 : 403);
      }
      if (url.origin === origin && path === '/api/flag-admin/export-flags' && request.method() === 'GET') {
        if (!session.user?.groups.includes('funwithflags-admins')) return json({ detail: 'Permission denied' }, 403);
        session.exportRequests++;
        return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'X-Flag-Count': '3' },
          body: JSON.stringify({ version: 1, flags: [{ slug: 'offline-one', flag: 'offline-flag-one' }] }) });
      }
      if (url.origin === origin && path === '/api/flag-admin/import-flags/preview' && request.method() === 'POST') {
        session.backupPreviewRequests++;
        if (session.denyBackupPreview) return json({ detail: 'Permission denied' }, 403);
        return json(session.backupPreview);
      }
      if (url.origin === origin && path === '/api/flag-admin/import-flags' && request.method() === 'POST') {
        session.backupImportRequests++;
        if (!session.user?.groups.includes('funwithflags-admins')) return json({ detail: 'Permission denied' }, 403);
        return json({
          created: session.backupPreview.missing, identical: session.backupPreview.identical,
        });
      }
      if (url.origin === origin && path === '/api/flag-admin/import-challenges'
          && request.method() === 'GET') {
        return json(session.user?.groups.includes('funwithflags-admins')
          ? { puzzles: session.hashMissing.map((name) => ({
            slug: `crack-the-hash-${name}`,
            title: `Crack The Hash: ${name[0]?.toUpperCase()}${name.slice(1)}`,
            points: { easy: 50, medium: 150, hard: 400 }[name as 'easy' | 'medium' | 'hard'],
          })), terminal: session.terminalMissing.map(slug => ({
            slug, title: 'Find sensitive data in common files on system',
            points: 50, missing: true,
          })) } : { detail: 'Permission denied' },
        session.user?.groups.includes('funwithflags-admins') ? 200 : session.user ? 403 : 401);
      }
      if (url.origin === origin && path === '/api/flag-admin/import-challenges'
          && request.method() === 'POST') {
        if (!session.user?.groups.includes('funwithflags-admins')) {
          return json({ detail: 'Permission denied' }, 403);
        }
        const body = request.postDataJSON() as Record<string, unknown>;
        const missing = session.hashMissing;
        if (Object.keys(body).sort().join(',') !== [...missing, 'terminal_missing'].sort().join(',')
            || !missing.every(name => typeof body[name] === 'string'
              && (body[name]).startsWith('offline-only-'))
            || JSON.stringify(body.terminal_missing) !== JSON.stringify(session.terminalMissing)) {
          failures.push('Invalid offline import request');
          return json({ detail: 'Invalid import' }, 400);
        }
        const created = missing.length + session.terminalMissing.length;
        session.hashMissing = [];
        session.terminalMissing = [];
        session.importRequests++;
        // Three hash puzzles and seven terminal challenges are in the registry.
        return json({ created, unchanged: 10 - created });
      }
      if (url.origin === origin && request.method() === 'POST' && path === '/api/admin/user-points/import') {
          if (!session.user?.groups.includes('funwithflags-admins')) return json({ detail: 'Forbidden' }, 403);
          const body = request.postDataJSON() as {
            user?: string; challenge?: string; preview?: boolean;
          };
          expect(body.user).toBe('Demo Speaker');
          expect(body.challenge).toBe('talk-demo-day-2026-10-09');
          const already = !!session.userPointsAwarded;
          if (!body.preview) session.userPointsAwarded = true;
          return json({
            user_id: 19, display_name: 'Demo Speaker', challenge: body.challenge,
            title: 'Talk: Demo Day 10/09', points: 500,
            points_awarded: body.preview || already ? 0 : 500,
            already_awarded: already, preview: body.preview,
          });
      }
      if (url.origin === origin && request.method() === 'GET') {
        seen.add(path);
        if (path === '/api/admin/user-stats') {
          if (!session.user?.is_admin) return json({ detail: 'Forbidden' }, 403);
          return json({
            people_logged_in: 18, people_with_points: 12, average_daily_logins: 2.4,
            window_days: 30, window_start: '2026-09-09', window_end: '2026-10-08', timezone: 'UTC',
          });
        }
        if (path === '/api/auth/me') return json(session.user ?? { detail: 'Unauthorized' }, session.user ? 200 : 401);
        if (session.user && path === '/api/auth/home-roster') {
          return json({
            owner: { account_id: session.user.account_id, home: session.user.home },
            entries: session.homes.map((home) => ({ home })),
          });
        }
        if (session.user && path === '/api/challenges/notifications') {
          const gold_after = Number(url.searchParams.get('gold_after') ?? 0);
          const initialize = url.searchParams.get('initialize') === 'true';
          const gold = initialize ? [] : session.mailEvents.filter(event => event.id > gold_after);
          return json({ gold, gold_cursor: initialize
            ? session.mailEvents.length : gold.at(-1)?.id ?? gold_after,
          gold_more: false });
        }
        if (session.user && path === '/api/challenges/matrix/status') {
          const status = { solved: session.gold.slug === 'enter-the-matrix' && session.gold.solved };
          if (session.matrixCompletion) {
            return session.matrixCompletion.respond(route, session.user.account_id, status);
          }
          return json(status);
        }
        if (session.user && path === '/api/challenges') return json(session.goldRows ?? [session.gold]);
        if (session.user && path === `/api/challenges/id/${session.gold.id}`) {
          session.detailRequests++;
          return json({ ...session.gold, title: session.detailTitle ?? 'Offline detail <script>alert(1)</script>',
            description: session.detailDescription ?? 'Fresh detail <img src=x onerror=alert(1)>' });
        }
        const assetPath = path === '/' ? '/index.html' : path;
        let body = assets.get(assetPath);
        // Public files are not included in Vite's in-memory bundle.
        const publicPath = resolve(root, 'public', `.${assetPath}`);
        if (body === undefined && publicPath.startsWith(`${root}/public/`)) {
          try {
            body = await readFile(publicPath);
            assets.set(assetPath, body);
          } catch { /* Reject below. */ }
        }
        if (body !== undefined) {
          return route.fulfill({
            contentType: contentTypes[extname(assetPath)] ?? 'application/octet-stream',
            body,
          });
        }
      }
      failures.push('Unexpected network request');
      await route.abort('blockedbyclient');
    }, context));
    const page = await startup.step('page', () => context.newPage());
    startup.attach(page);
    startupByPage.set(page, startup);
    page.on('load', () => timings.documentLoaded());
    created();
    configureOfflineTimeouts(page);
    page.on('pageerror', () => failures.push('Browser runtime error'));
    page.on('console', (message) => {
      // A synthetic 401 is expected in the signed-out case, not a runtime exception.
      if (message.type() === 'error'
        && !session.matrixCompletion?.consumeExpectedError(message.text(), message.location().url)
        && !(!session.user && message.text().includes('401 (Unauthorized)'))
        && !(session.scopedResponse === 'unauthorized' && message.text().includes('401 (Unauthorized)'))
        && !(session.expectDeniedImport && message.text().includes('403 (Forbidden)'))) {
        failures.push('Browser console error');
      }
    });
    if (load) await loadTerminal(page);
    // Never dump the transcript or raw runtime/network messages: game clues and
    // recovered answers can be present. Assertions below report booleans instead.
    const checked = timings.start('journey');
    try { await check(page, session); } finally { checked(); }
    expect(seen.has('/api/auth/me')).toBe(true);
    if (authenticated) expect(seen.has('/api/auth/home-roster')).toBe(true);
  } finally {
    startup.stop('failed');
    session.matrixCompletion?.dispose();
    const closed = timings.start('teardown');
    await context.close(); // Deletes cookies, localStorage and IndexedDB even on failure.
    closed();
    expect(failures, 'Browser errors or unexpected network requests').toEqual([]);
  }
}

// Setup-only clock/audio/identity changes belong before the first navigation.
// This still creates and destroys a fresh context per case. Real persistence,
// account-switch and reload assertions continue to use reloadWithDiagnostics().
async function withUnloadedTerminal(
  authenticated: boolean,
  check: (page: Page, session: SyntheticSession) => Promise<void>,
  options: BrowserContextOptions = {},
) {
  await withTerminal(authenticated, check, options, false);
}

async function loadTerminal(page: Page) {
  if (page.url() !== 'about:blank') throw new Error('Initial fixture navigation must start from a fresh page');
  // Keep diagnostics active through deferred setup as well as automatic loading.
  const startup = startupByPage.get(page);
  if (!startup) throw new Error('Initial fixture navigation requires startup diagnostics');
  const navigated = timings.start('navigation');
  try {
    await startup.step('navigation', () => page.goto(origin));
    startup.stop('loaded');
  } finally { navigated(); }
}

async function ready(page: Page) {
  const finished = timings.start('ready');
  try {
    // The offline bundle renders the welcome text immediately, but still waits
    // for real shell boot and the prompt's editable state.
    await page.locator('#terminal-input-wrapper').waitFor({ timeout: 35_000 });
    await expect.poll(() => page.locator('#terminal-input').getAttribute('contenteditable')).toBe('true');
    await expect.poll(() => page.locator('#terminal-input').getAttribute('data-command-busy'))
      .not.toBe('true');
  } finally { finished(); }
}

async function command(page: Page, text: string, expected: string | RegExp) {
  const input = page.locator('#terminal-input');
  const output = page.locator('#terminal-output');
  // Ordinary type-ahead is editable even while a command is in flight.
  // Check the submission lifecycle, not the editable state or a partial echo.
  await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 15_000 }).not.toBe('true');
  await expect.poll(() => input.getAttribute('contenteditable'), { timeout: 10_000 }).toBe('true');
  const before = (await output.innerText()).length;
  const childrenBefore = await output.locator(':scope > *').count();
  const completionsBefore = Number(await input.getAttribute('data-command-completions') ?? 0);
  // The empty contenteditable has zero width; focus it as keyboard users do.
  await input.focus();
  await page.keyboard.insertText(text);
  expect((await input.innerText()) === text, 'Command must be staged exactly before Enter').toBe(true);
  await input.press('Enter');
  // The count advances only when the command (including animation/pager) ends.
  await expect.poll(() => input.getAttribute('data-command-completions'), { timeout: 60_000 })
    .toBe(String(completionsBefore + 1));
  await expect.poll(() => output.locator(':scope > *').count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(childrenBefore + 1);
  await expect.poll(async () => {
    const result = (await output.innerText()).slice(before);
    return typeof expected === 'string' ? result.includes(expected) : expected.test(result);
  }, { timeout: 5_000, message: 'Command output must match without disclosing its contents' }).toBe(true);
  await expect.poll(() => input.getAttribute('contenteditable')).toBe('true');
  await expect.poll(() => input.innerText()).toBe('');
  return (await output.innerText()).slice(before);
}

it('import_user_points previews personal credit, imports once, and denies nonadmins', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    await command(page, 'import_user_points', 'requires funwithflags-admins');
    session.user = { ...user, is_admin: true, groups: ['funwithflags-admins'] };
    await reloadWithDiagnostics(page);
    await ready(page);
    await command(page, 'import_user_points', 'Usage: import_user_points');
    await command(page, 'import_user_points --preview talk-demo-day-2026-10-09 Demo Speaker',
      'Preview: Demo Speaker would receive 500 points');
    expect(session.userPointsAwarded).not.toBe(true);
    await command(page, 'import_user_points talk-demo-day-2026-10-09 Demo Speaker',
      'Awarded 500 points to Demo Speaker');
    expect(session.userPointsAwarded).toBe(true);
    await command(page, 'import_user_points talk-demo-day-2026-10-09 Demo Speaker',
      'already received 500 points');
    expect(await page.locator('#terminal-output').innerText()).toContain('No additional points awarded.');
  });
});

it('user_stats is admin-only and renders clearly defined aggregate statistics', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    await command(page, 'user_stats', 'available to administrators only');
    session.user = { ...user, is_admin: true };
    await reloadWithDiagnostics(page);
    await ready(page);
    await command(page, 'user_stats extra', 'Usage: user_stats');
    await command(page, 'user_stats', 'People who have logged in (all time): 18');
    const output = await page.locator('#terminal-output').innerText();
    expect(output).toContain('People with points (including scoreboard opt-outs): 12');
    expect(output).toContain('Average daily unique sign-ins: 2.40');
    expect(output).toContain('30 completed days, UTC');
    expect(output).toContain('Zero-login days count.');
  });
});

it('covers the offline admin flag backup journey', async () => {
  await withUnloadedTerminal(true, async (page, session) => {
    session.user = { ...user, groups: ['funwithflags-admins'] };
    await loadTerminal(page);
    await ready(page);
    await command(page, 'export_flags', 'Downloaded backup of 3 challenges');
    expect(session.exportRequests).toBe(1);
    await command(page, 'import_flags', 'Choose a local JSON backup');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose local flag backup JSON file' }).click();
    const fileChooser = await chooser;
    await fileChooser.setFiles({ name: 'synthetic.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 1, flags: [{ slug: 'new', flag: 'synthetic-secret' }] })) });
    await expect.poll(() => page.locator('#input-prefix').innerText()).toContain('Import missing flags?');
    expect(await page.locator('#terminal-output').innerText()).toContain('2 missing, 1 identical, 0 conflicts');
    await command(page, 'y', 'Import complete: 2 created, 1 identical unchanged.');
    expect(session.backupPreviewRequests).toBe(1);
    expect(session.backupImportRequests).toBe(1);

    session.backupPreview = { missing: 0, identical: 3, conflicts: 0 };
    await command(page, 'import_flags', 'Choose a local JSON backup');
    const allExistingChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose local flag backup JSON file' }).click();
    await (await allExistingChooser).setFiles({ name: 'existing.json', mimeType: 'application/json',
      buffer: Buffer.from('{}') });
    await expect.poll(() => page.locator('#terminal-output').innerText()).toContain('Nothing to import');
    await expect.poll(() => page.locator('#terminal-input').getAttribute('contenteditable')).toBe('true');
    expect(session.backupImportRequests).toBe(1);

    await command(page, 'import_flags', 'Choose a local JSON backup');
    const cancelChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose local flag backup JSON file' }).click();
    await cancelChooser;
    await page.locator('#terminal-input').focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#terminal-input').getAttribute('contenteditable')).toBe('true');
    await expect.poll(() => page.locator('#terminal-output').innerText()).toContain('Cancelled.');
    expect(await page.getByRole('button', { name: 'Choose local flag backup JSON file' }).count()).toBe(0);

    session.denyBackupPreview = true;
    session.expectDeniedImport = true;
    session.backupPreview = { missing: 1, identical: 0, conflicts: 0 };
    await command(page, 'import_flags', 'Choose a local JSON backup');
    const deniedChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose local flag backup JSON file' }).click();
    await (await deniedChooser).setFiles({ name: 'denied.json', mimeType: 'application/json',
      buffer: Buffer.from('{}') });
    await expect.poll(() => page.locator('#terminal-output').innerText()).toContain('Permission denied');
    await expect.poll(() => page.locator('#terminal-input').getAttribute('contenteditable')).toBe('true');
    expect(session.backupImportRequests).toBe(1);
  });
}, 90_000);

it('previews admin hash import, masks words and requires final confirmation offline', async () => {
  await withUnloadedTerminal(true, async (page, session) => {
    session.user = { ...user, groups: ['funwithflags-admins'] };
    await loadTerminal(page);
    await ready(page);
    await command(page, 'import_challenges', 'Crack The Hash: Hard — 400 pts');
    const input = page.locator('#terminal-input');
    await input.focus();
    await page.keyboard.type('yes');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#input-prefix').innerText()).toContain('Easy original word');
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
    const secret = 'offline-only-easy';
    await input.focus();
    await page.keyboard.type(secret);
    expect(await input.innerText()).toBe('•'.repeat(secret.length));
    expect(await input.innerText()).not.toContain(secret);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#input-prefix').innerText()).toContain('Medium original word');
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
    expect(await page.locator('#terminal-output').innerText()).not.toContain(secret);
    await page.keyboard.press('Escape');
    expect(session.importRequests).toBe(0);
    await command(page, 'import_challenges', 'Crack The Hash: Easy — 50 pts');
    await input.focus();
    await page.keyboard.type('yes');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#input-prefix').innerText()).toContain('Easy original word');
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
    for (const name of ['easy', 'medium', 'hard']) {
      await input.focus();
      await page.keyboard.type(`offline-only-${name}`);
      expect(await input.innerText()).toBe('•'.repeat(`offline-only-${name}`.length));
      expect(await input.innerText()).not.toContain(`offline-only-${name}`);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('#input-prefix').innerText())
        .toContain(name === 'hard' ? 'Import missing challenges now?' : `${name === 'easy' ? 'Medium' : 'Hard'} original word`);
      await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
    }
    expect(session.importRequests).toBe(0);
    await command(page, 'yes', '3 created, 7 existing unchanged');
    expect(session.importRequests).toBe(1);
    const transcript = await page.locator('#terminal-output').innerText();
    expect(transcript).not.toContain('offline-only-');
  });
}, 90_000);

it('imports partial or terminal-only missing challenges, then short-circuits and denies nonadmins offline', async () => {
  await withUnloadedTerminal(true, async (page, session) => {
    session.user = { ...user, groups: ['funwithflags-admins'] };
    session.hashMissing = ['medium'];
    session.terminalMissing = ['shell-backups'];
    await loadTerminal(page);
    await ready(page);
    await command(page, 'import_challenges', 'Find sensitive data in common files on system');
    const input = page.locator('#terminal-input');
    await input.focus();
    await page.keyboard.type('yes');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#input-prefix').innerText()).toContain('Medium original word');
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
    await input.focus();
    await page.keyboard.type('offline-only-medium');
    expect(await input.innerText()).toBe('•'.repeat('offline-only-medium'.length));
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#input-prefix').innerText()).toContain('Import missing challenges now?');
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
    await command(page, 'yes', '2 created, 8 existing unchanged');
    expect(session.importRequests).toBe(1);
    await command(page, 'import_challenges', 'Nothing to import');
    expect(session.importRequests).toBe(1);
    session.terminalMissing = ['shell-backups'];
    await command(page, 'import_challenges', 'Find sensitive data in common files on system');
    await expect.poll(() => page.locator('#input-prefix').innerText())
      .toContain('Import missing Gold track challenges?');
    await command(page, 'yes', '1 created, 9 existing unchanged');
    expect(session.importRequests).toBe(2);
    session.user = { ...user, groups: [] };
    session.expectDeniedImport = true;
    await command(page, 'import_challenges', 'Permission denied');
    expect(session.importRequests).toBe(2);
  });
}, 90_000);

it.skipIf(browserName !== 'chromium')('pauses auto-copy across reloads without blocking native copy and paste, then resumes', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    expect(await page.locator('.clipboard-preference').count()).toBe(0);
    expect(await page.locator('#terminal-output').innerText()).not.toContain('Auto-copy:');
    await command(page, 'autocopy off', 'Auto-copy: OFF');
    await reloadWithDiagnostics(page);
    await ready(page);
    expect(await page.locator('.clipboard-preference').count()).toBe(0);
    await command(page, 'autocopy', 'Auto-copy: OFF');
    await page.evaluate(() => navigator.clipboard.writeText('keep this clipboard'));
    const selectOutput = async (text: string) => page.evaluate((value) => {
      const line = document.createElement('div');
      line.textContent = value;
      document.getElementById('terminal-output')!.append(line);
      (document.activeElement as HTMLElement)?.blur();
      const range = document.createRange();
      range.selectNodeContents(line);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    }, text);
    await selectOutput('manual copy while paused');
    await page.waitForTimeout(500); // Include the debounced selection-change path.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('keep this clipboard');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('manual copy while paused');
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('manual copy while paused');
    await page.keyboard.press('Control+v');
    await expect.poll(() => page.locator('#terminal-input').innerText()).toBe('manual copy while paused');
    await page.locator('#terminal-input').fill('');
    await command(page, 'autocopy on', 'Auto-copy: ON');
    await reloadWithDiagnostics(page);
    await ready(page);
    expect(await page.locator('.clipboard-preference').count()).toBe(0);
    await command(page, 'autocopy', 'Auto-copy: ON');
    await selectOutput('automatic copy resumed');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('automatic copy resumed');
  });
});

it.skipIf(browserName !== 'chromium')('copies output selection and pastes literal text with Ctrl+V without executing it', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.evaluate(() => {
      const output = document.getElementById('terminal-output')!;
      const line = document.createElement('div');
      line.id = 'clipboard-fixture';
      line.textContent = 'copy this terminal text';
      output.append(line);
      const range = document.createRange();
      range.selectNodeContents(line);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('copy this terminal text');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('copy this terminal text');
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('copy this terminal text');
    await page.keyboard.press('Control+v');
    const input = page.locator('#terminal-input');
    await expect.poll(() => input.innerText()).toBe('copy this terminal text');
    await input.fill('prefix suffix');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => navigator.clipboard.writeText('<b>literal</b>\necho NOT_EXECUTED'));
    await page.keyboard.press('Control+v');
    await expect.poll(() => input.innerText()).toBe('p<b>literal</b> echo NOT_EXECUTEDrefix suffix');
    expect(await input.locator('b').count()).toBe(0);
    expect(await page.locator('#terminal-output').innerText()).not.toContain('NOT_EXECUTED');
    // Clipboard refusal leaves selection intact and explains manual copy.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true, value: () => Promise.reject(new Error('blocked')),
      });
      const line = document.getElementById('clipboard-fixture')!;
      line.textContent = 'manual copy fallback';
      const range = document.createRange();
      range.selectNodeContents(line);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await expect.poll(() => page.locator('.clipboard-status').innerText()).toContain('Auto-copy unavailable');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('manual copy fallback');
  });
});

it(`clipboard: ${browserName} native drag, keyboard selection and literal paste`, async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await clipboardDragJourney(page);
  });
});

it(`clipboard: ${browserName} restricted automatic copy and native manual fallback`, async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await clipboardRestrictedJourney(page, browserName);
  });
});

it(`clipboard: ${browserName} touch selectionchange and hidden-prompt ownership`, async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await clipboardTouchJourney(page);
  }, {
    viewport: { width: 390, height: 844 }, hasTouch: true,
    // Firefox does not implement Playwright's isMobile emulation.
    isMobile: browserName !== 'firefox',
  });
});

it('keeps a bare ls prompt editable for native typing, deletion and Enter', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    const input = page.locator('#terminal-input');
    const output = page.locator('#terminal-output');
    const promptState = () => page.evaluate(() => {
      const input = document.getElementById('terminal-input')!;
      const selection = getSelection();
      return {
        focused: document.activeElement === input,
        editable: input.contentEditable === 'true',
        visible: !document.getElementById('terminal-input-wrapper')!.hidden,
        caretInside: !!selection?.anchorNode && input.contains(selection.anchorNode),
      };
    });
    expect(await promptState()).toEqual({
      focused: true, editable: true, visible: true, caretInside: true,
    });
    let previousLines = await output.locator(':scope > *').count();
    await page.keyboard.type('ls');
    expect(await input.innerText()).toBe('ls');
    await page.keyboard.press('Enter');
    await expect.poll(() => output.locator(':scope > *').count(), { timeout: 10_000 })
      .toBe(previousLines + 1);
    // A result node exists before its real output animation finishes. Use the
    // same bounded readiness budget as command(), not Vitest's short default.
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 15_000 }).toBe('false');
    expect(await output.innerText()).toContain('notes.txt');
    expect(await promptState()).toEqual({
      focused: true, editable: true, visible: true, caretInside: true,
    });
    // No input.focus(), helper, insertText(), output click or readiness retry.
    await page.keyboard.type('pwX');
    expect(await input.innerText()).toBe('pwX');
    await page.keyboard.press('Backspace');
    expect(await input.innerText()).toBe('pw');
    await page.keyboard.type('d');
    expect(await input.innerText()).toBe('pwd');
    previousLines = await output.locator(':scope > *').count();
    await page.keyboard.press('Enter');
    await expect.poll(() => output.locator(':scope > *').count(), { timeout: 10_000 })
      .toBe(previousLines + 1);
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 15_000 }).toBe('false');
    expect((await output.innerText()).split('\n').filter(line => line.trim() === user.home)).toHaveLength(1);
    expect(await input.innerText()).toBe('');
    expect(await promptState()).toEqual({
      focused: true, editable: true, visible: true, caretInside: true,
    });

    await command(page, 'help', 'Explore the Shell');
    await command(page, 'about', 'About This CTF');
    await command(page, 'ls', 'notes.txt');
    previousLines = await output.locator(':scope > *').count();
    // An output click (or scrolling through a long response) takes focus off
    // the contenteditable. The first printable key and Enter must not be lost.
    await output.click({ position: { x: 40, y: 20 } });
    expect(await input.evaluate(node => document.activeElement === node)).toBe(false);
    expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(true);
    expect(await input.getAttribute('contenteditable')).toBe('true');
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await output.locator('.terminal-pager__status').count()).toBe(0);
    await page.keyboard.type('pwd');
    expect(await input.innerText()).toBe('pwd');
    await page.keyboard.press('Enter');
    await expect.poll(() => output.locator(':scope > *').count(), { timeout: 10_000 })
      .toBe(previousLines + 1);
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 15_000 }).toBe('false');
    await expect.poll(async () => (await output.innerText()).includes(`\n${user.home}`),
      { timeout: 10_000 }).toBe(true);
    expect(await input.innerText()).toBe('');
    expect(await input.evaluate(node => document.activeElement === node)).toBe(true);
  });
}, 60_000);

it('scrolls ordinary long output and prompt into the CRT viewport on desktop and phone', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    for (const size of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(size);
      // Four copies fill more than a screen without relying on synthetic DOM
      // insertion or on a challenge pager. The real shell renders this output.
      await command(page, 'cat /etc/passwd /etc/passwd /etc/passwd /etc/passwd', 'backup:*:202');
      const layout = await page.evaluate(() => {
        const terminal = document.querySelector<HTMLElement>('.terminal')!;
        const output = document.getElementById('terminal-output')!;
        const line = output.lastElementChild!;
        const node = line.lastChild!;
        const range = document.createRange();
        range.setStart(node, Math.max(0, (node.textContent?.length ?? 0) - 2));
        range.setEnd(node, Math.max(0, (node.textContent?.length ?? 0) - 1));
        const clip = terminal.getBoundingClientRect();
        const prompt = document.getElementById('terminal-input-wrapper')!.getBoundingClientRect();
        const lastLine = range.getBoundingClientRect();
        return {
          scrollTop: terminal.scrollTop, clientHeight: terminal.clientHeight,
          clipTop: clip.top, clipBottom: clip.bottom,
          promptTop: prompt.top, promptBottom: prompt.bottom,
          lastLineTop: lastLine.top, lastLineBottom: lastLine.bottom,
        };
      });
      expect(layout.scrollTop, 'Long ordinary output must move the CRT scroll position')
        .toBeGreaterThan(layout.clientHeight / 2);
      expect(layout.lastLineTop, 'The latest output must not be clipped above the screen')
        .toBeGreaterThanOrEqual(layout.clipTop);
      expect(layout.lastLineBottom, 'The latest output must not be clipped below the screen')
        .toBeLessThanOrEqual(layout.clipBottom);
      expect(layout.promptTop).toBeGreaterThanOrEqual(layout.clipTop);
      expect(layout.promptBottom).toBeLessThanOrEqual(layout.clipBottom);
    }
  });
}, 60_000);

async function calibrateExistenceProbe(page: Page, cwd: string) {
  // Exercise both spellings of the existence builtin against relative and
  // absolute operands. A nested cd verifies that cwd resolution and PWD move
  // together; positive and negative probes keep stale/constant statuses from
  // passing. Also keep aliases, expanded variables, protected files, and a
  // sourced script in this same calibration so the browser boots only once.
  const nested = `${cwd}/existence-dir`;
  const escapedNested = nested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spaced = `${cwd}/space dir`;
  const escapedSpaced = spaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await command(page, [
    'touch existence-probe',
    'test -e existence-probe', 'echo $?',
    `test -e "${cwd}/existence-probe"`, 'echo $?',
    '[ -e ./existence-probe ]', 'echo $?',
    'test -e missing-probe', 'echo $?',
    `[ -e "${cwd}/missing-probe" ]`, 'echo $?',
    '[ -e existence-probe', 'echo $?',
    'mkdir existence-dir', 'cd existence-dir',
    'pwd', 'echo $PWD',
    'touch nested-probe',
    'test -e nested-probe', 'echo $?',
    '[ -e ./nested-probe ]', 'echo $?',
    `test -e "${nested}/nested-probe"`, 'echo $?',
    'test -e ../existence-probe', 'echo $?',
    'rm nested-probe', 'cd ..', 'rmdir existence-dir', 'rm existence-probe',
    'test -e existence-probe', 'echo $?',
    `test -e "${cwd}/existence-probe"`, 'echo $?',
    'mkdir "space dir"', 'touch "space dir/source-present"',
    'TARGET="$PWD/space dir/source-present"', 'DEST="$PWD/space dir"',
    `alias te='test -e'; alias bracket='['`,
    'te "$TARGET"', 'echo $?',
    'te "$TARGET/missing"', 'echo $?',
    'te /.secure/etc/passwd', 'echo $?',
    'bracket -e "$TARGET" ]', 'echo $?',
    'bracket -e "$TARGET/missing" ]', 'echo $?',
    'bracket -r /etc/shadow ]', 'echo $?',
    'CHECK_CMD=test', '$CHECK_CMD -e "$TARGET"', 'echo $?',
    'CHECK_CMD="["', '$CHECK_CMD -e "$TARGET/missing" ]', 'echo $?',
    'alias go=cd', 'go "$DEST"', 'pwd', 'echo "$PWD"', 'CD_CMD=cd', '$CD_CMD ..',
    'echo ALIASES_DONE',
    `echo 'test -e source-check; ST=$?; [ -e source-missing ]; SM=$?; cd "$DEST"' > source-check`,
    '. ./source-check',
    'echo AFTER_SOURCE', 'echo "$ST $SM"', 'pwd', 'echo "$PWD"',
    'test -e source-present', 'echo $?',
    '[ -e source-missing ]', 'echo $?',
    'rm source-present', 'cd ..', 'rmdir "space dir"', 'rm source-check',
    'unalias te; unalias bracket; unalias go',
  ].join('; '), new RegExp(
    `\\n0\\n0\\n0\\n1\\n1\\n2\\n${escapedNested}\\n${escapedNested}\\n0\\n0\\n0\\n0\\n1\\n1`
    + `\\n0\\n1\\n1\\n0\\n1\\n1\\n0\\n1\\n${escapedSpaced}\\n${escapedSpaced}\\nALIASES_DONE`
    + `\\nAFTER_SOURCE\\n0 1\\n${escapedSpaced}\\n${escapedSpaced}\\n0\\n1\\n\\[: missing \\]\\s*$`,
  ));
}

async function expectCoreExists(page: Page, exists: boolean) {
  await command(page, `test -e "${user.home}/fortune-smoke/core"; echo $?`, exists ? /\n0\s*$/ : /\n1\s*$/);
}

it('preserves alias redirections, temporary variables and pipeline streams offline', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await command(page, [
      'mkdir alias-smoke', 'cd alias-smoke',
      'alias check=test', 'alias bracket="["',
      'check -e missing 2>errors', 'echo $?',
      'test -e errors', 'echo $?',
      'bracket -e missing 2>errors', 'echo $?', 'cat errors',
      'alias copy=cat', 'alias chained=copy',
      'echo PIPE_OK | chained >out', 'cat out',
      'alias identity=env', 'ALIAS_TEMP=TEMP_OK identity >env-out',
      'grep "^ALIAS_TEMP=" env-out', 'echo "RESTORED:$ALIAS_TEMP"',
      'alias routed="echo ROUTED >inner"', '>outer routed',
      'test -s outer', 'echo $?', 'cat inner',
      'echo SEED >outer', '>>outer routed', 'cat outer', 'cat inner',
      'unalias routed', 'unalias check', 'unalias bracket',
      'unalias copy', 'unalias chained', 'unalias identity',
    ].join('; '), /\n1\n0\n2\n\[: missing \]\nPIPE_OK\nALIAS_TEMP=TEMP_OK\nRESTORED:\n1\nROUTED\nSEED\nROUTED\s*$/);
  });
});

// Lifo saves after a debounce, not when the shell command resolves. Observe a
// committed snapshot before navigation; never substitute a fixed sleep or seed it.
async function persistedFile(
  page: Page, accountId: string, path: string, content: string | RegExp,
) {
  await expect.poll(() => page.evaluate(async ({ accountId, path }) => {
    const name = `lifo-fwf-account-${accountId}`;
    if (!(await indexedDB.databases()).some((db) => db.name === name)) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not open persisted filesystem', {
        cause: request.error,
      }));
    });
    try {
      interface StoredNode { n: string; d?: string; c?: StoredNode[] }
      const root = await new Promise<StoredNode | undefined>((resolve, reject) => {
        const transaction = db.transaction('filesystem', 'readonly');
        const request = transaction.objectStore('filesystem').get('root');
        transaction.oncomplete = () => resolve(request.result as StoredNode | undefined);
        transaction.onerror = () => reject(new Error('Could not read persisted filesystem', {
          cause: transaction.error,
        }));
        transaction.onabort = () => reject(new Error('Persisted filesystem read aborted', {
          cause: transaction.error,
        }));
      });
      let node = root;
      for (const part of path.split('/').filter(Boolean)) {
        node = node?.c?.find((child) => child.n === part);
      }
      return node ? atob(node.d ?? '') : null;
    } finally {
      db.close();
    }
  }, { accountId, path }), { timeout: 10_000 })
    .toEqual(typeof content === 'string' ? content : expect.stringMatching(content));
}

it('keeps the signed-out terminal gated with synthetic authentication', async () => {
  await withTerminal(false, async (page) => {
    await page.getByRole('button', { name: 'Sign in with Okta' }).waitFor();
    expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(false);
  });
});

it('explores HP-UX lore, adventure, fortune and recoverable terminal glitches offline', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await command(page, 'getconf KERNEL_BITS', /\n64\n/);
    await command(page, 'machinfo', 'PA-RISC');
    await command(page, 'finger operator', /diagnostic/i);
    await command(page, 'last diag', 'diag');
    await command(page, 'strings /usr/local/bin/monitor', '/tmp/.monitor');
    await command(page, 'cat /var/adm/.operator', 'Permission denied');
    await command(page, 'cat /var/adm/operator.restore', /monitor|diag/i);
    await command(page, 'ls /usr/games', 'adventure');
    const prompt = await page.locator('#input-prefix').innerText();
    await command(page, '/usr/games/adventure', 'WELCOME TO ADVENTURE');
    await command(page, 'no', 'SMALL BRICK BUILDING');
    await command(page, 'north', 'DUSTY NOTICE');
    await command(page, 'read', 'EASTERN GRATE');
    await command(page, 'south', 'END OF A ROAD');
    await command(page, 'east', 'FOREST');
    await command(page, 'east', 'GRATE');
    await command(page, 'read', 'CORE STRINGS');
    await command(page, 'quit', 'RETURN TO HP-UX');
    expect((await page.locator('#input-prefix').innerText()) === prompt,
      'Quitting Adventure must restore the original shell prompt').toBe(true);
    await command(page, 'pwd', new RegExp(`\\n${user.home}\\s*$`));
    // Use the real shell filesystem in this fresh synthetic browser context.
    // No game API calls or seeded core: Fortune must create it in the active cwd.
    await command(page, 'mkdir ~/fortune-smoke; cd ~/fortune-smoke; pwd', /\n.*\/fortune-smoke\s*$/);
    await calibrateExistenceProbe(page, `${user.home}/fortune-smoke`);
    await expectCoreExists(page, false);
    await command(page, 'fortune', 'least likely directory');
    await expectCoreExists(page, false);
    await command(page, 'fortune', 'patient reader');
    await expectCoreExists(page, false);
    await command(page, 'fortune', '/tmp');
    await expectCoreExists(page, false);
    await command(page, 'fortune', `simulated core saved to ${user.home}/fortune-smoke/core`);
    await expectCoreExists(page, true);
    await command(page, 'ls core', /\ncore\s*$/);
    const inspected = await command(page, 'strings core', 'PROGRAM=fortune');
    expect(inspected.trimEnd().endsWith(`\n${SYNTHETIC_CORE.trimEnd()}`),
      'The generated core must be readable and complete').toBe(true);
    await command(page, 'strings core | grep PROGRAM', /\nPROGRAM=fortune\s*$/);
    await command(page, 'cd; pwd', new RegExp(`\\n${user.home}\\s*$`));
    await command(page, 'cat /tmp/weirdfile', 'terminal exerciser');
    await command(page, 'pwd', '^[?1h');
    await command(page, 'reset', 'Terminal settings restored');
    const restored = await command(page, 'pwd', user.home);
    expect(restored).not.toContain('^[?1h');
    await command(page, 'cat /tmp/weirdfile', 'terminal exerciser');
    await command(page, 'stty sane', 'Terminal settings restored');
    expect(await command(page, 'pwd', user.home)).not.toContain('^[?1h');
  });
// Includes synthetic probe calibration and the post-Fortune positive control.
// Keep the shared runner's 480-second deadline unchanged.
}, 90_000);

it.each(['logout', 'active account switch'] as const)(
  'resets Adventure routing and Fortune counts after %s with synthetic users',
  async (transition) => {
    await withTerminal(true, async (page, session) => {
      const other = { ...user, account_id: '99', home: '/home/jane-doe-99' };
      session.homes = [user.home, other.home];
      await ready(page);
      const originalPrompt = await page.locator('#input-prefix').innerText();
      // Stop one call short of a core so a leaked counter faults immediately.
      // Keep all returned game text inside boolean comparisons, never assertions.
      const firstFortune = nextFortune({ index: 0 }).output;
      await command(page, 'fortune', firstFortune);
      await command(page, 'fortune', /\S/);
      await command(page, 'fortune', /\S/);
      await command(page, 'ls core', /not found|No such file/i);
      await command(page, 'adventure', 'WELCOME TO ADVENTURE');
      await command(page, 'no', 'SMALL BRICK BUILDING');
      await command(page, 'north', 'DUSTY NOTICE');
      expect((await page.locator('#input-prefix').innerText()) !== originalPrompt,
        'Adventure must own input before the identity transition').toBe(true);

      if (transition === 'logout') {
        // Adventure consumes all command text; return to the shell before using
        // the real logout command. The other case abandons an active game.
        await command(page, 'quit', 'RETURN TO HP-UX');
        await page.locator('#terminal-input').focus();
        await page.keyboard.insertText('logout');
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Sign in with Okta' }).waitFor();
        expect(session.logoutRequests === 1, 'Logout must reach the mocked API').toBe(true);
        expect(session.user === null, 'Logout must clear the synthetic session').toBe(true);
        expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(false);
        expect((await page.locator('#terminal-input').getAttribute('contenteditable')) === 'false').toBe(true);
      }

      session.user = other;
      await reloadWithDiagnostics(page);
      await ready(page);
      // A changed prompt alone is insufficient: a real shell command must not
      // be interpreted as a turn in the previous player's Adventure.
      await command(page, 'pwd', new RegExp(`\\n${other.home}\\s*$`));
      const otherPrompt = await page.locator('#input-prefix').innerText();
      expect(otherPrompt !== originalPrompt, 'The shell must use the new identity').toBe(true);
      await command(page, 'ls core', /not found|No such file/i);
      for (let invocation = 0; invocation < 3; invocation++) {
        const result = await command(page, 'fortune', /\S/);
        if (invocation === 0) {
          expect(result.includes(firstFortune),
            'The new player must receive Fortune invocation one').toBe(true);
        }
        await command(page, 'ls core', /not found|No such file/i);
      }
      await command(page, 'fortune', `simulated core saved to ${other.home}/core`);
      await command(page, 'ls core', /\ncore\s*$/);
      await command(page, 'adventure', 'WELCOME TO ADVENTURE');
      await command(page, 'no', 'SMALL BRICK BUILDING');
      await command(page, 'east', 'FOREST');

      // Return while the second player's game is active. Neither the original
      // player's old turn/counter nor the second player's current game may resume.
      session.user = { ...user };
      await reloadWithDiagnostics(page);
      await ready(page);
      expect((await page.locator('#input-prefix').innerText()) === originalPrompt,
        'The returning player must regain their shell prompt').toBe(true);
      await command(page, 'pwd', new RegExp(`\\n${user.home}\\s*$`));
      expect((await command(page, 'fortune', /\S/)).includes(firstFortune),
        'The returning player must restart the Fortune cycle').toBe(true);
      await command(page, 'ls core', /not found|No such file/i);
      await command(page, 'adventure', 'WELCOME TO ADVENTURE');
      await command(page, 'no', 'SMALL BRICK BUILDING');
      await command(page, 'quit', 'RETURN TO HP-UX');
      await command(page, 'pwd', new RegExp(`\\n${user.home}\\s*$`));
    });
  }, 120_000,
);

it('aligns table indentation and borders with linked Unicode punctuation', async () => {
  await withTerminal(true, async (page, session) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    session.goldRows = pagedGoldRows(2, number => number === 1
      ? 'Synthetic summary - plain text' : 'Synthetic summary — “quoted”… text');
    await ready(page);
    await command(page, 'challenges gold', 'Synthetic summary');
    const table = page.locator('.terminal-table-output').last();
    expect(await table.textContent()).toContain('— “quoted”…');
    const rows = await table.evaluate((element) => {
      const lines = new Map<number, number[]>();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (let i = 0; i < text.length; i++) {
          if (text[i] !== '|' && text[i] !== '+') continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          const y = Math.round(rect.y);
          lines.set(y, [...(lines.get(y) ?? []), rect.x]);
        }
      }
      return [...lines.values()];
    });
    expect(rows).toHaveLength(6); // three rules, header, two data rows
    for (const row of rows) {
      expect(row).toHaveLength(6); // id, category, title, points, completed
      row.forEach((x, column) => expect(Math.abs(x - rows[0]![column]!)).toBeLessThan(1));
    }
  });
}, 60_000);

it('opens fresh gold detail in an accessible modal without leaking hidden data', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    await command(page, 'challenges gold', '<hidden>');
    const button = page.locator('#terminal-output .challenge-link').filter({ hasText: '<hidden>' });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Offline detail <script>alert(1)</script>' });
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await dialog.innerText()).toContain('Fresh detail <img src=x onerror=alert(1)>');
    expect(session.detailRequests).toBe(1);
    expect(await dialog.locator('script, img').count()).toBe(0);
    await page.keyboard.press('x');
    expect(await page.locator('#terminal-input').innerText()).toBe('');
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.count()).toBe(0);
    expect(await page.locator('#terminal-input').evaluate(node => node === document.activeElement)).toBe(true);
    await button.click();
    // The loading dialog is visible before the request reaches the fixture.
    // Wait for the fetched title, as on the first open, before counting it.
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(session.detailRequests).toBe(2);
    await page.getByRole('button', { name: 'Close challenge details' }).click();
    await command(page, 'challenges describe 24', 'unique solve_count: 3');
    expect(session.detailRequests).toBe(3);
  });
}, 120_000);

// Desktop CSS viewport reflow, not mobile emulation or native browser zoom.
for (const layout of [
  { name: '200% desktop reflow', width: 640, height: 450, textSize: 14 },
  { name: '400% desktop reflow', width: 320, height: 225, textSize: 14 },
  { name: '200% desktop text', width: 1280, height: 900, textSize: 28 },
  { name: '400% desktop reflow plus 200% text', width: 320, height: 225, textSize: 28 },
]) {
  it(`keeps challenge details keyboard-readable and actions reachable at ${layout.name}`, async () => {
    await withTerminal(true, async (page, session) => {
      session.detailTitle = 'LongChallengeTitleWithoutSpaces'.repeat(6);
      session.detailDescription = [
        'Read this first line.',
        ...Array.from({ length: 30 }, (_, i) => `Description paragraph ${i + 1}: Read the clues before submitting.`),
        'LongUnbrokenClue'.repeat(30),
        'End of description.',
      ].join('\n\n');
      await ready(page);
      await command(page, 'challenges gold', '<hidden>');
      // Prepare the list before shrinking; terminal pager reflow is a separate
      // journey. This test starts at the real detail link and dialog.
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.evaluate(size => {
        document.documentElement.style.fontSize = `${size}px`;
      }, layout.textSize);
      const link = page.locator('#terminal-output .challenge-link').filter({ hasText: '<hidden>' });
      // Open via the real link, then use only native keyboard navigation.
      await link.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      const description = dialog.locator('.challenge-dialog__description');
      const close = dialog.getByRole('button', { name: 'Close challenge details' });
      const input = dialog.getByRole('textbox', { name: 'Flag' });
      const submit = dialog.getByRole('button', { name: 'Submit', exact: true });
      const feedback = dialog.locator('.challenge-dialog__feedback');
      await expect.poll(() => description.count()).toBe(1);
      const tabTo = async (target: Locator) => {
        for (let i = 0; i < 8
            && !await target.evaluate(node => node === document.activeElement); i++) {
          await page.keyboard.press('Tab');
        }
        expect(await target.evaluate(node => node === document.activeElement)).toBe(true);
      };
      const expectUncovered = async (target: Locator, focused = true) => {
        const geometry = await target.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const parent = node.closest('dialog')!.getBoundingClientRect();
          const css = getComputedStyle(node);
          return {
            contained: rect.top >= parent.top + 4 && rect.bottom <= parent.bottom - 4
              && rect.left >= parent.left + 4 && rect.right <= parent.right - 4,
            focusVisible: node.matches(':focus-visible'),
            outlineWidth: parseFloat(css.outlineWidth), outlineStyle: css.outlineStyle,
            uncovered: [
              [rect.left + 2, rect.top + 2], [rect.right - 2, rect.bottom - 2],
              [rect.left + rect.width / 2, rect.top + rect.height / 2],
            ].every(([x, y]) => node.contains(document.elementFromPoint(x!, y!))),
          };
        });
        expect(geometry, 'Action/feedback must fit the dialog and clear CRT hardware').toMatchObject({
          contained: true, uncovered: true,
        });
        if (focused) {
          expect(geometry.focusVisible).toBe(true);
          expect(geometry.outlineStyle).toBe('solid');
          expect(geometry.outlineWidth).toBeGreaterThanOrEqual(2);
        }
      };
      expect(await dialog.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight
          && rect.left >= 0 && rect.right <= innerWidth
          && node.scrollWidth <= node.clientWidth + 1
          && node.clientHeight >= parseFloat(getComputedStyle(node).lineHeight);
      })).toBe(true);
      await expectUncovered(close);
      await tabTo(description);
      // The first text line must actually fit and be hit-testable, not merely
      // belong to a "visible" paragraph thousands of pixels tall.
      expect(await description.evaluate(node => {
        const range = document.createRange();
        range.setStart(node.firstChild!, 0);
        range.setEnd(node.firstChild!, 5);
        const rect = range.getBoundingClientRect();
        const dialogRect = node.closest('dialog')!.getBoundingClientRect();
        return rect.top >= dialogRect.top + 2 && rect.bottom <= dialogRect.bottom - 2
          && node.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2));
      })).toBe(true);
      const before = await dialog.evaluate(node => node.scrollTop);
      await page.keyboard.press('PageDown');
      await expect.poll(() => dialog.evaluate(node => node.scrollTop)).toBeGreaterThan(before);
      await page.keyboard.press('Control+End');
      await expect.poll(() => dialog.evaluate(node =>
        node.scrollTop + node.clientHeight >= node.scrollHeight - 2)).toBe(true);
      await page.keyboard.press('Control+Home');
      await expect.poll(() => dialog.evaluate(node => node.scrollTop)).toBe(0);
      await tabTo(input);
      await expectUncovered(input);
      await tabTo(submit);
      await expectUncovered(submit);
      await page.keyboard.press('Enter'); // Native required-field validation.
      expect(await input.evaluate(node =>
        (node as HTMLInputElement).validity.valueMissing)).toBe(true);
      expect(await input.evaluate(node => node === document.activeElement)).toBe(true);
      await expectUncovered(input);
      expect(session.scopedSubmissions ?? 0).toBe(0);
      await page.keyboard.insertText('synthetic-wrong');
      await tabTo(submit);
      await page.keyboard.press('Enter');
      await expect.poll(() => feedback.innerText()).toBe('Incorrect flag. Try again.');
      // Feedback must never scroll the focused retry field out of view.
      expect(await input.evaluate(node => node === document.activeElement)).toBe(true);
      await expectUncovered(input);
      expect(await feedback.getAttribute('aria-live')).toBe('polite');
      expect(await input.getAttribute('aria-describedby')).toBe(await feedback.getAttribute('id'));
      expect(session.scopedSubmissions).toBe(1);
      expect(await input.inputValue()).toBe('');
      await page.keyboard.insertText('retry-draft');
      expect(await input.inputValue()).toBe('retry-draft');
      await expectUncovered(input);
      await tabTo(submit);
      await expectUncovered(submit);
      await tabTo(feedback);
      await expectUncovered(feedback);
      // Return to the draft without a forced focus or scrollIntoView.
      await page.keyboard.press('Shift+Tab');
      await expectUncovered(submit);
      await page.keyboard.press('Shift+Tab');
      await expectUncovered(input);
      expect(await input.inputValue()).toBe('retry-draft');
      expect(session.scopedSubmissions).toBe(1);
      await tabTo(close);
      await expectUncovered(close);
      await page.keyboard.press('Enter');
      expect(await dialog.count()).toBe(0);
      expect(await page.locator('#terminal-input').evaluate(node => node === document.activeElement)).toBe(true);
      expect(await page.locator('#terminal-input').innerText()).toBe('');
      expect(await page.locator('#terminal-output').innerText()).not.toContain('synthetic-wrong');
    }, { viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  });
}

it('submits scoped synthetic answers from Gold, OWASP and Cracking detail links', async () => {
  for (const category of ['gold', 'owasp', 'cracking']) {
    await withTerminal(true, async (page, session) => {
      session.gold.category = category;
      await ready(page);
      await command(page, category === 'cracking' ? 'challenges cracking' : 'challenges gold', '<hidden>');
      const links = page.locator('#terminal-output .challenge-link');
      // Both the id and the title are backed by the same detail dialog.
      await links.filter({ hasText: '24' }).first().click();
      let dialog = page.getByRole('dialog');
      await expect.poll(() => dialog.getByRole('textbox', { name: 'Flag' }).count()).toBe(1);
      await dialog.getByRole('button', { name: 'Close challenge details' }).click();
      await links.filter({ hasText: '<hidden>' }).first().click();
      dialog = page.getByRole('dialog');
      const input = dialog.getByRole('textbox', { name: 'Flag' });
      await input.fill('synthetic-wrong');
      await input.press('Enter');
      await expect.poll(() => dialog.getByRole('status').last().innerText()).toContain('Incorrect flag');
      expect(session.scopedSubmissions).toBe(1);
      expect(await input.inputValue()).toBe('');
      session.scopedResponse = 'correct';
      await input.fill('synthetic-correct');
      await dialog.getByRole('button', { name: 'Submit' }).click();
      await expect.poll(() => dialog.getByRole('status').last().innerText()).toContain('Correct!');
      expect(await dialog.innerText()).toContain('Solved');
      expect(session.scopedSubmissions).toBe(2);
      session.scopedResponse = 'already';
      await input.fill('synthetic-correct');
      await input.press('Enter');
      await expect.poll(() => dialog.getByRole('status').last().innerText()).toContain('Already solved');
      await page.keyboard.press('Escape');
      await expect.poll(() => dialog.count()).toBe(0);
      expect(await page.locator('#terminal-input').evaluate(node => node === document.activeElement)).toBe(true);
      expect(await page.locator('#terminal-output').innerText()).not.toContain('synthetic-correct');
      await links.filter({ hasText: '24' }).first().click();
      expect(await page.getByRole('textbox', { name: 'Flag' }).inputValue()).toBe('');
      expect(await page.getByRole('dialog').innerText()).not.toContain('Already solved');
    });
  }
}, 120_000);

it('locks pending detail submissions, tolerates close/reopen, and handles expired auth', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    await command(page, 'challenges gold', '<hidden>');
    const link = page.locator('#terminal-output .challenge-link').filter({ hasText: '<hidden>' });
    await link.click();
    let release!: () => void;
    session.releaseSubmission = new Promise<void>(resolve => { release = resolve; });
    session.scopedResponse = 'correct';
    const input = page.getByRole('textbox', { name: 'Flag' });
    await input.fill('synthetic-pending');
    await input.press('Enter');
    await expect.poll(() => page.getByRole('button', { name: 'Submit' }).isDisabled()).toBe(true);
    await page.getByRole('dialog').evaluate(dialog =>
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(session.scopedSubmissions).toBe(1);
    await page.keyboard.press('Escape');
    await link.click();
    release();
    await expect.poll(() => page.getByRole('textbox', { name: 'Flag' }).isVisible()).toBe(true);
    expect(await page.getByRole('dialog').innerText()).not.toContain('Correct!');
    session.releaseSubmission = undefined;
    session.scopedResponse = 'unauthorized';
    await page.getByRole('textbox', { name: 'Flag' }).fill('synthetic-expired');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    expect(await page.locator('#terminal-output').innerText()).toContain('session has expired');
  });
}, 120_000);

for (const reject of [false, true]) {
  for (const successor of [false, true]) {
    it(`terminal ownership: stale ${reject ? 'rejection' : 'success'} preserves replacement ${successor ? 'busy command' : 'draft'}`, async () => {
      await withTerminal(true, async (page) => {
        await ready(page);
        // A guided/admin command disables type-ahead. Its old cleanup would
        // clear the replacement draft even when the same input node is reused.
        const old = await holdCommand(page, 'create_flag', reject);
        const next = successor ? await holdCommand(page, 'status') : undefined;
        const input = page.locator('#terminal-input');
        await input.focus();
        await page.keyboard.insertText('create_flag');
        await input.press('Enter');
        await old.entered();
        expect(await input.getAttribute('contenteditable')).toBe('false');

        await page.evaluate(() => {
          (window as CommandOwnershipWindow).__replaceTerminalLifecycle();
          const output = document.getElementById('terminal-output')!;
          output.replaceChildren();
          const sentinel = document.createElement('button');
          sentinel.id = 'replacement-sentinel';
          sentinel.textContent = 'REPLACEMENT-SCREEN';
          output.append(sentinel);
          const input = document.getElementById('terminal-input')!;
          input.contentEditable = 'true';
          input.dataset.commandBusy = 'false';
          input.dataset.commandCompletions = '0';
          document.getElementById('input-prefix')!.textContent = 'REPLACEMENT-PROMPT> ';
        });
        if (next) {
          await input.focus();
          await page.keyboard.insertText('status');
          await input.press('Enter');
          await next.entered(); // The old command must not block the new lifecycle.
        }
        await input.focus();
        await page.keyboard.insertText('echo REPLACEMENT-DRAFT');
        await page.locator('#replacement-sentinel').focus();
        const snapshot = () => page.evaluate(() => {
          const input = document.getElementById('terminal-input')!;
          return {
            output: document.getElementById('terminal-output')!.innerHTML,
            draft: input.innerText,
            prefix: document.getElementById('input-prefix')!.textContent,
            editable: input.contentEditable,
            busy: input.dataset.commandBusy,
            completions: input.dataset.commandCompletions,
            focus: document.activeElement?.id,
          };
        });
        const before = await snapshot();
        expect(before.focus).toBe('replacement-sentinel');
        await old.release();
        // Observe the handler's finally, not just delivery of the held result.
        await expect.poll(() => page.evaluate(() =>
          (window as CommandOwnershipWindow).__terminalCommandSettled)).toBe(1);
        expect(await snapshot()).toEqual(before);
        if (next) {
          await next.release();
          await expect.poll(() => input.getAttribute('data-command-completions')).toBe('1');
          expect(await input.innerText()).toBe('echo REPLACEMENT-DRAFT');
          expect(await page.locator('#terminal-output').innerText())
            .toContain('SYNTHETIC-COMMAND-RESULT');
        }
        // Real command execution and focus recovery still work after retirement.
        await input.fill('');
        await command(page, 'pwd', user.home);
      });
    });
  }
}

for (const [text, stage] of [
  ['clear', 'history'],
  ['vi /tmp/presentation-owner.txt', 'history'],
  ['vi /tmp/presentation-owner.txt', 'editor'],
  ['view /tmp/presentation-owner.txt', 'editor'],
]) {
  it(`terminal ownership: real ${text} cannot replace the auth gate after ${stage}`, async () => {
    await withTerminal(true, async (page, session) => {
      await ready(page);
      await command(page, 'echo PRIVATE-SYNTHETIC-FILE > /tmp/presentation-owner.txt', /./);
      await page.evaluate(() => {
        (window as CommandOwnershipWindow).__terminalCommandSettled = 0;
      });
      const held = await holdCommand(page, stage === 'history' ? `__history:${text}` : '__editor');
      const input = page.locator('#terminal-input');
      await input.focus();
      await page.keyboard.insertText(text!);
      await input.press('Enter');
      await held.entered();
      session.user = null;
      await expireMatrixIdentity(page); // Real auth invalidation, not a fixture-only epoch change.
      const signIn = page.getByRole('button', { name: 'Sign in with Okta' });
      await signIn.focus();
      const before = await page.locator('#terminal-output').innerHTML();
      await held.release();
      await expect.poll(() => page.evaluate(() =>
        (window as CommandOwnershipWindow).__terminalCommandSettled)).toBe(1);
      expect(await page.locator('#terminal-output').innerHTML()).toBe(before);
      expect(await signIn.isVisible()).toBe(true);
      expect(await signIn.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await page.locator('.vi-screen').count()).toBe(0);
      expect(await input.getAttribute('contenteditable')).toBe('false');
      expect(await input.getAttribute('data-command-busy')).toBe('false');
      expect(await page.locator('#terminal-input-wrapper').getAttribute('hidden')).not.toBeNull();
    });
  });
}

for (const [text, selector] of [['matrix', '.matrix-screen'], ['sl', '.sl-screen']] as const) {
  it(`terminal ownership: auth replacement closes active ${text} and reveals sign-in`, async () => {
    await withTerminal(true, async (page, session) => {
      await ready(page);
      const input = page.locator('#terminal-input');
      await input.focus();
      await page.keyboard.insertText(text);
      await input.press('Enter');
      await page.locator(selector).waitFor();
      session.user = null;
      await expireMatrixIdentity(page);
      const signIn = page.getByRole('button', { name: 'Sign in with Okta' });
      await signIn.focus();
      await expect.poll(() => page.evaluate(() =>
        (window as CommandOwnershipWindow).__terminalCommandSettled)).toBe(1);
      expect(await page.locator(selector).count()).toBe(0);
      expect(await page.locator('#terminal-output').isVisible()).toBe(true);
      expect(await signIn.isVisible()).toBe(true);
      expect(await input.getAttribute('contenteditable')).toBe('false');
      expect(await input.getAttribute('data-command-busy')).toBe('false');
      expect(await page.locator('#terminal-input-wrapper').getAttribute('hidden')).not.toBeNull();
      expect(await signIn.evaluate(element => element === document.activeElement)).toBe(true);
    });
  });
}

it('terminal ownership: replacement interrupts an already-running output animation', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    const held = await holdCommand(page, 'create_flag');
    const input = page.locator('#terminal-input');
    await input.focus();
    await page.keyboard.insertText('create_flag');
    await input.press('Enter');
    await held.entered();
    await page.clock.install();
    await held.release();
    await page.clock.runFor(30);
    const before = await page.evaluate(() => {
      const output = document.getElementById('terminal-output')!;
      const line = output.lastElementChild as HTMLElement;
      if (!line.textContent) throw new Error('Command animation must start before replacement');
      (window as CommandOwnershipWindow).__replaceTerminalLifecycle();
      // Reuse even the animated line: neither connectivity nor node identity
      // alone can protect a replacement screen from the next animation tick.
      line.textContent = 'REPLACEMENT-SCREEN';
      const input = document.getElementById('terminal-input')!;
      input.textContent = 'REPLACEMENT-DRAFT';
      input.contentEditable = 'true';
      const sentinel = document.createElement('button');
      sentinel.id = 'animation-sentinel';
      sentinel.textContent = 'Replacement control';
      output.append(sentinel);
      sentinel.focus();
      return { output: output.innerHTML, completions: input.dataset.commandCompletions ?? null };
    });
    await page.clock.runFor(5000);
    await expect.poll(() => page.evaluate(() =>
      (window as CommandOwnershipWindow).__terminalCommandSettled)).toBe(1);
    expect(await page.locator('#terminal-output').innerHTML()).toBe(before.output);
    expect(await input.innerText()).toBe('REPLACEMENT-DRAFT');
    expect(await input.getAttribute('contenteditable')).toBe('true');
    expect(await input.getAttribute('data-command-completions')).toBe(before.completions);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('animation-sentinel');
  });
});

it('boots and executes identity, lazy shell tools and a synthetic API command', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    await command(page, 'pwd', user.home);
    expect(session.activityCommands).toEqual(['pwd']);
    await command(page, 'whoami', 'jane-doe-7');
    await command(page, 'id', 'uid=201(jane-doe-7)');
    await command(page, 'uname -a', 'HP-UX hpux01 B.11.11');
    await command(page, 'hostname', /hpux01\s*$/);
    await command(page, "echo browser-lazy | tr a-z A-Z", 'BROWSER-LAZY');
    expect(session.activityCommands.at(-1)).toBe('shell command');
    await command(page, "echo lazy-sort | wc -w", /\n\s*1\s*$/);
    // A bare listing goes straight to Gold; there is no track prompt.
    await command(page, 'challenges', '<hidden>');
    await command(page, 'challenge', '<hidden>');
    expect(await page.locator('#terminal-output').innerText()).not.toContain('Choose a challenge track');
    await command(page, 'pwd', user.home);
    // Hold a synthetic API response while real keyboard events edit the next
    // draft. Repeated Enter must not submit the in-flight command again.
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/auth/me', async (route) => {
      requests++;
      await pending;
      await route.fulfill({ json: user });
    });
    const input = page.locator('#terminal-input');
    const output = page.locator('#terminal-output');
    const before = await output.locator(':scope > *').count();
    const completionsBefore = Number(await input.getAttribute('data-command-completions') ?? 0);
    await input.focus();
    await page.keyboard.insertText('status');
    await input.press('Enter');
    await expect.poll(() => requests).toBe(1);
    try {
      await input.press('Enter');
      await input.press('Enter');
      await page.keyboard.insertText('echo TYPEAHEAD-PRESERVED');
      await input.press('Enter');
      expect(await input.innerText()).toBe('echo TYPEAHEAD-PRESERVED');
      expect(requests).toBe(1);
    } finally {
      release();
    }
    await expect.poll(() => output.locator(':scope > *').count()).toBe(before + 1);
    await page.keyboard.insertText('-ANIMATED');
    await input.press('Enter');
    await expect.poll(() => input.getAttribute('data-command-completions'), { timeout: 10_000 })
      .toBe(String(completionsBefore + 1));
    expect(await output.locator(':scope > *').count()).toBe(before + 1);
    expect(await input.innerText()).toBe('echo TYPEAHEAD-PRESERVED-ANIMATED');
    await input.press('Enter');
    await expect.poll(() => input.getAttribute('data-command-completions'), { timeout: 10_000 })
      .toBe(String(completionsBefore + 2));
    expect(await output.locator(':scope > *').count()).toBe(before + 2);
    const lines = (await output.innerText()).split('\n');
    expect(lines.filter(line => line.trim() === 'TYPEAHEAD-PRESERVED-ANIMATED')).toHaveLength(1);
    expect(requests).toBe(1);
  });
});

it('recalls a complete curl URL with ArrowUp for editing without logging its arguments', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    const line = 'curl http://169.254.169.254/latest/meta-data/iam/';
    await command(page, line, 'security-credentials/');
    const input = page.locator('#terminal-input');
    await page.keyboard.press('ArrowUp');
    expect(await input.innerText()).toBe(line);
    await page.keyboard.type('security-credentials/');
    expect(await input.innerText()).toBe(`${line}security-credentials/`);
    expect(await page.locator('#terminal-output').innerText()).toContain(line);
    expect(session.activityCommands).toContain('shell command');
    expect(session.activityCommands.every(name => !name.includes('169.254'))).toBe(true);
  });
});

it('keeps offline terminal geometry unanimated across reloads', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    const animation = () => page.locator('.terminal-content').evaluate(node => ({
      name: getComputedStyle(node).animationName,
      transform: getComputedStyle(node).transform,
    }));
    expect(await animation()).toEqual({ name: 'none', transform: 'none' });
    await page.clock.install();
    await reloadWithDiagnostics(page);
    await ready(page);
    expect(await animation()).toEqual({ name: 'none', transform: 'none' });
  });
});

it('always starts idle Matrix after three command-free minutes despite mouse and key activity', async () => {
  await withUnloadedTerminal(true, async (page) => {
    await page.clock.install();
    await loadTerminal(page);
    await ready(page);
    await page.evaluate(() => { Math.random = () => 1; });
    await page.clock.runFor(1000);
    await page.clock.fastForward(170_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await page.mouse.move(300, 300);
    await page.keyboard.press('Shift');
    await page.keyboard.press('Enter'); // An empty prompt is not a command.
    await ready(page);
    await page.clock.fastForward(11_000);
    expect(await page.locator('.idle-matrix-message').innerText()).toContain('Wake up,');
    await page.keyboard.press('Space');
    await page.keyboard.press('q');
    // Cancelling starts a fresh grace period; typing a draft defers entry.
    await page.locator('#terminal-input').focus();
    await page.keyboard.insertText('unfinished draft');
    await page.clock.fastForward(181_000);
    expect(await page.locator('#terminal-input').innerText()).toBe('unfinished draft');
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(await page.locator('.idle-matrix-controls').count()).toBe(0);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.evaluate(() => {
      const oldPage = document.createElement('div');
      oldPage.className = 'terminal-pager terminal-pager--finished';
      document.getElementById('terminal-output')!.append(oldPage);
    });
    await page.clock.runFor(1000);
    expect(await page.locator('.idle-matrix-message').innerText()).toContain('Wake up,');
  });
});

it('never shows idle Matrix touch controls over an open editor', async () => {
  await withUnloadedTerminal(true, async (page) => {
    await page.clock.install();
    await loadTerminal(page);
    await ready(page);
    await page.evaluate(() => { Math.random = () => 0; });
    await page.locator('#terminal-input').focus();
    await page.keyboard.insertText('vi touch-draft.txt');
    await page.keyboard.press('Enter');
    await page.locator('.vi-screen').waitFor();
    await page.clock.fastForward(181_000);
    expect(await page.locator('.idle-matrix-controls').count()).toBe(0);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(await page.locator('.vi-screen').isVisible()).toBe(true);
  }, { hasTouch: true, viewport: { width: 390, height: 844 } });
});

for (const entry of ['idle', 'command'] as const) {
it(`idle Matrix: native ${entry} entry unlocks Ctrl+X/Escape audio, schedules at five seconds and cleans up`, async () => {
  await withUnloadedTerminal(true, async (page, session) => {
    if (entry === 'command') session.gold = { ...session.gold, slug: 'enter-the-matrix', solved: true };
    await prepareMatrix(page, ready, loadTerminal, 'native', entry);
    const output = page.locator('#terminal-output');
    expect((await traceAudio(page)).states).toEqual([]);
    await followRabbit(page);
    await expect.poll(async () => (await traceAudio(page)).states, { timeout: 8000 }).toEqual(['running']);
    const ctrlCalls = (await traceAudio(page)).resumes;
    expect(ctrlCalls.some(call => call.key.toLowerCase() === 'x' && call.ctrl && call.trusted)).toBe(true);
    // Real native suspension between gestures: Escape must resume the same
    // context, not merely reuse the already-running result of Ctrl+X.
    await suspendMatrixAudio(page);
    expect((await traceAudio(page)).states).toEqual(['suspended']);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await traceAudio(page)).states, { timeout: 8000 }).toEqual(['running']);
    expect(await output.innerText()).toBe('Follow the white rabbit.');
    expect((await traceAudio(page)).resumes.at(-1)).toEqual({ key: 'Escape', ctrl: false, trusted: true });
    await page.keyboard.press('Escape');
    const started = await page.evaluate(() => Date.now());
    const callsBeforeDelay = (await traceAudio(page)).resumes.length;
    await page.clock.runFor(4999);
    expect(await output.innerText()).toBe('Knock, knock, Jane.');
    expect((await traceAudio(page)).starts).toEqual([]);
    await page.clock.runFor(1);
    const audio = await traceAudio(page);
    expect(audio.starts.map(call => call.wall - started)).toEqual([5000, 5000]);
    expect(audio.starts[1]!.at - audio.starts[0]!.at).toBeCloseTo(0.23, 1);
    expect(audio.stops.map((stop, index) => stop - audio.starts[index]!.at)).toEqual([
      expect.closeTo(0.2, 3), expect.closeTo(0.2, 3),
    ]);
    expect(audio.gains).toEqual([1, 1]);
    expect(audio.resumes.length).toBe(callsBeforeDelay); // No delayed "unlock".
    expect(await output.innerText()).not.toContain('unavailable');
    expect(await output.innerText()).toContain('neo_has_land3d');
    // Web Audio uses its own clock: virtual JS time does not finish oscillators.
    await expect.poll(async () => (await traceAudio(page)).disconnected, { timeout: 8000 }).toBe(4);
    await dismissMatrixReward(page);
    await expect.poll(async () => (await traceAudio(page)).states, { timeout: 8000 }).toEqual(['closed']);
    expect((await traceAudio(page)).closed).toBe(1);
    await assertPromptRestored(page);
  });
});
}

for (const entry of ['idle', 'command'] as const) {
for (const step of ['matrix', 'early escape', 'rabbit', 'knock'] as const) {
  it(`idle Matrix: ${entry} silently exits on a missed ${step} step without buttons or leaked input`, async () => {
    await withUnloadedTerminal(true, async (page, session) => {
      session.gold = { ...session.gold, slug: 'enter-the-matrix', solved: entry === 'command' };
      await prepareMatrix(page, ready, loadTerminal, 'unavailable', entry);
      if (step === 'early escape') await page.keyboard.press('Control+x');
      else if (step !== 'matrix') await followRabbit(page);
      if (step === 'rabbit') await page.keyboard.press('Escape');
      if (step === 'knock') await beginKnock(page);
      expect(await page.locator('.idle-matrix-controls').count()).toBe(0);
      await page.keyboard.press(step === 'early escape' ? 'Escape' : 'q');
      await page.clock.runFor(10_000);
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      expect(await page.locator('#terminal-input').innerText()).toBe('');
      expect(session.scopedSubmissions ?? 0).toBe(0);
      await assertPromptRestored(page);
    });
  });
}
}

it('idle Matrix: awarding points stops idle entry immediately and unlocks replay without reload', async () => {
  await withUnloadedTerminal(true, async (page, session) => {
    session.gold = { ...session.gold, slug: 'enter-the-matrix', solved: false };
    await prepareMatrix(page, ready, loadTerminal, 'unavailable', 'idle');
    await followRabbit(page);
    await beginKnock(page);
    await page.clock.runFor(5000);
    await dismissMatrixReward(page);
    // Revealing the flag is not a solve; only the accepted submission is.
    await page.clock.resume(); // Shell command rendering uses timers.
    expect(session.gold.solved).toBe(false);
    await command(page, 'matrix_test', 'earn its points');
    await command(page, 'submit neo_has_land3d', 'Flag accepted.');
    expect(session.gold.solved).toBe(true);
    await page.clock.fastForward(600_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await page.keyboard.type('matrix_test');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.idle-matrix-message').innerText()).toContain('Wake up,');
    expect(await page.locator('.idle-matrix-controls').count()).toBe(0);
  });
});

async function withMatrixCompletion(
  solved: boolean,
  check: (page: Page, session: SyntheticSession, checks: MatrixCompletionFixture,
    initial: Awaited<ReturnType<MatrixCompletionFixture['holdNextDelivery']>>) => Promise<void>,
  initialStatus = 200,
) {
  await withUnloadedTerminal(true, async (page, session) => {
    session.gold = { ...session.gold, slug: 'enter-the-matrix', solved };
    const checks = session.matrixCompletion = new MatrixCompletionFixture();
    if (initialStatus !== 200) checks.holdNext(initialStatus).release();
    await observeCompletionDocument(page);
    const initial = await checks.holdNextDelivery(page, true);
    await page.clock.install();
    await loadTerminal(page);
    await ready(page);
    await pauseCompletionClock(page);
    await page.clock.runFor(1000);
    await expect.poll(() => checks.requests.length).toBe(1);
    await initial.received(initialStatus === 200 ? 'fulfilled' : 'rejected');
    await check(page, session, checks, initial);
  });
}

it('idle Matrix: late completion response from before an award cannot restart automatic entry', async () => {
  await withMatrixCompletion(false, async (page, session, checks, initial) => {
    expect(checks.requests).toEqual([{ account: user.account_id, solved: false }]);
    await page.clock.resume();
    await command(page, 'submit neo_has_land3d', 'Flag accepted.');
    expect(session.gold.solved).toBe(true);
    expect(session.mailEvents).toHaveLength(1);
    // Hold the post-award refresh too: an immediate correct reply could hide a
    // transient stale false assignment and make a broken version guard pass.
    const afterAward = await checks.holdNextDelivery(page);
    await initial.release();
    await statusSettled(page, 1);
    await expect.poll(() => checks.requests.length).toBe(2);
    await afterAward.received();
    expect(checks.requests[1]).toEqual({ account: user.account_id, solved: true });
    await pauseCompletionClock(page);
    await page.clock.fastForward(181_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(checks.requests).toHaveLength(2); // No overlapping status requests.
    await afterAward.release();
    await statusSettled(page, 2);
    await page.clock.fastForward(181_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await page.clock.resume();
    await command(page, 'echo award-race-safe', 'award-race-safe');
  });
});

it('idle Matrix: a rejected pre-award completion cannot write over a same-session award and replay recovers', async () => {
  await withMatrixCompletion(false, async (page, session, checks, initial) => {
    const documentBefore = await completionDocument(page);
    const runtimeBefore = await matrixRuntime(page);
    expect(await takeFailedCompletionWrites(page)).toBe(0);
    expect(await takeAppliedCompletionStatuses(page)).toEqual([]);
    await page.clock.resume();
    await command(page, 'submit neo_has_land3d', 'Flag accepted.');
    expect(session.gold.solved).toBe(true);
    expect(session.mailEvents).toHaveLength(1);
    expect(session.mailEvents[0]).toMatchObject({
      outcome: 'correct', points: 50, challenge_id: session.gold.id,
    });
    await pauseCompletionClock(page);
    expect(checks.requests).toEqual([{ account: user.account_id, solved: false }]);

    // Keep the real service rejection held after transport settlement, and
    // separately hold its successor. Only the award version changes here:
    // no identity change, installer replacement, or abort can mask the guard.
    const afterAward = await checks.holdNextDelivery(page);
    await initial.release();
    await statusSettled(page, 1);
    // The award already reset solved to null. Observe the guarded catch write,
    // not just the UI: a stale null-to-null assignment must fail this test too.
    expect(await takeFailedCompletionWrites(page)).toBe(0);
    expect(await takeAppliedCompletionStatuses(page)).toEqual([]);
    await afterAward.received();
    expect(checks.requests).toEqual([
      { account: user.account_id, solved: false },
      { account: user.account_id, solved: true },
    ]);
    await page.clock.fastForward(181_000);
    expect(checks.requests).toHaveLength(2);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(await page.locator('#terminal-output').innerText()).not.toContain('Synthetic completion check failed.');

    await afterAward.release();
    await statusSettled(page, 2);
    expect(await takeAppliedCompletionStatuses(page)).toEqual([true]);
    // The held continuation aged the cache. Verify a fresh poll also recovers
    // solved state before allowing the overdue idle heartbeat to run.
    const fresh = checks.holdNext();
    await page.clock.runFor(1000);
    await expect.poll(() => checks.requests.length).toBe(3);
    expect(checks.requests[2]).toEqual({ account: user.account_id, solved: true });
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    fresh.release();
    await statusSettled(page, 3);
    expect(await takeAppliedCompletionStatuses(page)).toEqual([true]);
    await page.clock.runFor(1000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);

    await submitReplay(page);
    await replaySettled(page, 1);
    expect(await replayResults(page)).toEqual([null]);
    expect(checks.requests).toHaveLength(4);
    expect(checks.requests[3]).toEqual({ account: user.account_id, solved: true });
    expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
    expect(await takeFailedCompletionWrites(page)).toBe(0);
    expect(await completionDocument(page)).toEqual({
      ...documentBefore, solveEvents: documentBefore.solveEvents + 1,
    });
    expect(await matrixRuntime(page)).toMatchObject({
      installs: runtimeBefore.installs, account: runtimeBefore.account,
      generation: runtimeBefore.generation,
    });
    expect(session.logoutRequests).toBe(0);
    expect(session.submittedFlag).toBe('neo_has_land3d');
    expect(session.mailEvents).toHaveLength(1);
    expect(checks.expectedFailures).toEqual([]);
  }, 503);
});

for (const refreshStatus of [200, 503]) {
  it(`idle Matrix: another tab's award is learned by polling${refreshStatus === 503 ? ' after a failed refresh recovers' : ''} without a local solve event or reload`, async () => {
    await withMatrixCompletion(false, async (page, session, checks, initial) => {
      const originalDocument = await completionDocument(page);
      await initial.release();
      await statusSettled(page, 1);
      expect(checks.requests).toEqual([{ account: user.account_id, solved: false }]);
      // Reset evidence from boot: only a newly applied result can prove that
      // polling learned the remote award rather than leaving status unknown.
      expect(await takeAppliedCompletionStatuses(page)).toEqual([false]);

      // A second isolated context has independent DOM, timers and browser
      // storage. Only the synthetic server's challenge/award records are shared.
      await withUnloadedTerminal(true, async (otherPage, otherSession) => {
        expect(otherPage.context()).not.toBe(page.context());
        otherSession.gold = session.gold;
        otherSession.mailEvents = session.mailEvents;
        await observeCompletionDocument(otherPage);
        await loadTerminal(otherPage);
        await ready(otherPage);
        expect(otherSession.user?.account_id).toBe(session.user?.account_id);
        await command(otherPage, 'matrix_test', 'earn its points');
        expect(await otherPage.locator('.idle-matrix-message').count()).toBe(0);
        await command(otherPage, 'submit neo_has_land3d', 'Flag accepted.');
        expect((await completionDocument(otherPage)).solveEvents).toBe(1);
        expect(session.gold.solved).toBe(true);
        expect(session.mailEvents).toHaveLength(1);
        expect(session.submittedFlag).toBeUndefined();
        expect(await completionDocument(page)).toEqual(originalDocument);
        expect(originalDocument.solveEvents).toBe(0);
        // The original's paused clock proves the other tab didn't trigger
        // a refresh there by dispatching the same-tab award event.
        expect(checks.requests).toHaveLength(1);

        const refresh = checks.holdNext(refreshStatus);
        await page.clock.runFor(31_000);
        await expect.poll(() => checks.requests.length).toBe(2);
        expect(checks.requests[1]).toEqual({ account: user.account_id, solved: true });
        refresh.release();
        await statusSettled(page, 2);
        expect(await takeAppliedCompletionStatuses(page))
          .toEqual(refreshStatus === 200 ? [true] : []);
        expect(await takeFailedCompletionWrites(page)).toBe(refreshStatus === 200 ? 0 : 1);
        if (refreshStatus === 503) {
          // Hold recovery past the idle deadline. Failure must leave eligibility
          // unknown, not reuse the previous unsolved result or invent an award.
          const recovery = checks.holdNext();
          await page.clock.fastForward(181_000);
          await expect.poll(() => checks.requests.length).toBe(3);
          expect(await page.locator('.idle-matrix-message').count()).toBe(0);
          expect(checks.requests[2]).toEqual({ account: user.account_id, solved: true });
          recovery.release();
          await statusSettled(page, 3);
          expect(await takeAppliedCompletionStatuses(page)).toEqual([true]);
        }
        // Hold a later refresh so an immediate successor response cannot hide
        // failure to apply the first successful post-award result.
        const later = checks.holdNext();
        const beforeIdle = checks.requests.length;
        await page.clock.fastForward(181_000);
        await expect.poll(() => checks.requests.length).toBe(beforeIdle + 1);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        later.release();
        await statusSettled(page, beforeIdle + 1);

        // Replay still needs its own server confirmation, even after polling
        // learned the award. It must neither reload nor award points again.
        const replay = checks.holdNext();
        const beforeReplay = checks.requests.length;
        await submitReplay(page);
        await expect.poll(() => checks.requests.length).toBe(beforeReplay + 1);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        replay.release();
        await page.clock.resume();
        await expect.poll(() => page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
        await page.keyboard.press('Space');
        await page.keyboard.press('q');
        await command(page, 'echo cross-tab-replay-finished', 'cross-tab-replay-finished');
        expect(await completionDocument(page)).toEqual(originalDocument);
        expect(session.mailEvents).toHaveLength(1);
        expect(session.submittedFlag).toBeUndefined();
        expect(session.scopedSubmissions ?? 0).toBe(0);
        expect(checks.expectedFailures).toEqual([]);
      });
    });
  });
}

for (const oldSolved of [false, true]) {
  it(`idle Matrix: late completion response is discarded after switching from a ${oldSolved ? 'solved' : 'unsolved'} account`, async () => {
    await withMatrixCompletion(oldSolved, async (page, session, checks, initial) => {
      session.user = { ...user, account_id: '8', home: '/home/synthetic-8', first_name: 'Other' };
      session.gold = { ...session.gold, solved: !oldSolved };
      // Identity changes now abort the old request and immediately replace it.
      // Queue the replacement gate before triggering that change.
      const current = await checks.holdNextDelivery(page);
      await refreshMatrixIdentity(page);
      await page.clock.runFor(1000); // Observe identity change without a reload.
      await current.received();
      await initial.release();
      await statusSettled(page, 1);
      await expect.poll(() => checks.requests.length).toBe(2);
      expect(checks.requests).toEqual([
        { account: user.account_id, solved: oldSolved },
        { account: '8', solved: !oldSolved },
      ]);
      // This continuation is held after transport completion, so advancing the
      // idle deadline exercises ownership rather than the request timeout.
      await page.clock.fastForward(181_000);
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      const fresh = checks.holdNext();
      await current.release();
      await statusSettled(page, 2);
      expect(await takeAppliedCompletionStatuses(page)).toEqual([!oldSolved]);
      // The clock jump also aged the cache: the next tick requires a fresh
      // account-scoped read before an overdue encounter can open.
      await page.clock.runFor(1000);
      await expect.poll(() => checks.requests.length).toBe(3);
      expect(checks.requests[2]).toEqual({ account: '8', solved: !oldSolved });
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      fresh.release();
      await statusSettled(page, 3);
      expect(await takeAppliedCompletionStatuses(page)).toEqual([!oldSolved]);
      await page.clock.runFor(1000);
      if (oldSolved) {
        // The new unsolved player still gets their own automatic encounter.
        expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Other. . .');
      } else {
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      }
      expect(session.submittedFlag).toBeUndefined();
      expect(session.mailEvents).toHaveLength(0);
    });
  });
}

for (const method of ['logout', 'expiry'] as const) {
  for (const oldSolved of [false, true]) {
    it(`idle Matrix: same-account ${method} discards a pending ${oldSolved ? 'solved' : 'unsolved'} completion before the heartbeat`, async () => {
      await withMatrixCompletion(oldSolved, async (page, session, checks, initial) => {
        const documentBefore = await completionDocument(page);
        const now = await page.evaluate(() => Date.now());
        await endMatrixSession(page, method);
        session.user = { ...user };
        session.gold = { ...session.gold, solved: !oldSolved };
        const current = await checks.holdNextDelivery(page);
        await resumeMatrixSession(page);
        expect(await page.evaluate(() => Date.now())).toBe(now);
        expect(await completionDocument(page)).toEqual(documentBefore);
        expect(session.logoutRequests).toBe(method === 'logout' ? 1 : 0);

        // Deliver before any tick can observe the signed-out intermediate state.
        await initial.release();
        await statusSettled(page, 1);
        expect(await takeAppliedCompletionStatuses(page)).toEqual([]);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        await page.clock.runFor(1000);
        await current.received();
        expect(checks.requests).toEqual([
          { account: user.account_id, solved: oldSolved },
          { account: user.account_id, solved: !oldSolved },
        ]);
        await page.clock.fastForward(181_000);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        // A routine same-session profile refresh must not discard valid work.
        await refreshMatrixIdentity(page);
        await current.release();
        await statusSettled(page, 2);
        expect(await takeAppliedCompletionStatuses(page)).toEqual([!oldSolved]);
        const fresh = checks.holdNext();
        await page.clock.runFor(1000);
        await expect.poll(() => checks.requests.length).toBe(3);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        fresh.release();
        await statusSettled(page, 3);
        expect(await takeAppliedCompletionStatuses(page)).toEqual([!oldSolved]);
        await page.clock.runFor(1000);
        if (oldSolved) {
          expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
        } else {
          expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        }
        expect(session.submittedFlag).toBeUndefined();
        expect(session.mailEvents).toHaveLength(0);
      });
    });
  }

  for (const freshSolved of [false, true]) {
    it(`idle Matrix: same-account ${method} discards a rejected completion before the heartbeat and recovers ${freshSolved ? 'solved' : 'unsolved'} state`, async () => {
      await withMatrixCompletion(false, async (page, session, checks, initial) => {
        const documentBefore = await completionDocument(page);
        const now = await page.evaluate(() => Date.now());
        expect(await takeFailedCompletionWrites(page)).toBe(0);
        await endMatrixSession(page, method);
        session.user = { ...user };
        session.gold = { ...session.gold, solved: freshSolved };
        const current = await checks.holdNextDelivery(page);
        await resumeMatrixSession(page);
        await initial.release();
        await statusSettled(page, 1);
        // Equal account IDs are insufficient. Observe the guarded catch write
        // itself: null-to-null would otherwise look safe in the UI.
        expect(await takeFailedCompletionWrites(page)).toBe(0);
        expect(await takeAppliedCompletionStatuses(page)).toEqual([]);
        expect(await page.evaluate(() => Date.now())).toBe(now);
        expect(await completionDocument(page)).toEqual(documentBefore);
        expect(checks.requests).toEqual([{ account: user.account_id, solved: false }]);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        expect(await page.locator('#terminal-output').innerText()).not.toContain('Synthetic completion check failed.');

        await page.clock.runFor(1000);
        await current.received();
        expect(checks.requests).toEqual([
          { account: user.account_id, solved: false },
          { account: user.account_id, solved: freshSolved },
        ]);
        // Hold recovery independently past the idle deadline, after transport
        // has finished, so real service cancellation/deadlines stay unchanged.
        await page.clock.fastForward(181_000);
        expect(checks.requests).toHaveLength(2);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        await refreshMatrixIdentity(page);
        await current.release();
        await statusSettled(page, 2);
        expect(await takeAppliedCompletionStatuses(page)).toEqual([freshSolved]);
        const fresh = checks.holdNext();
        await page.clock.runFor(1000);
        await expect.poll(() => checks.requests.length).toBe(3);
        expect(checks.requests[2]).toEqual({ account: user.account_id, solved: freshSolved });
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        fresh.release();
        await statusSettled(page, 3);
        expect(await takeAppliedCompletionStatuses(page)).toEqual([freshSolved]);
        expect(await takeFailedCompletionWrites(page)).toBe(0);
        await page.clock.runFor(1000);
        if (freshSolved) expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        else expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
        expect(await completionDocument(page)).toEqual(documentBefore);
        expect(session.logoutRequests).toBe(method === 'logout' ? 1 : 0);
        expect(session.submittedFlag).toBeUndefined();
        expect(session.mailEvents).toHaveLength(0);
        expect(checks.expectedFailures).toEqual([]);
      }, 503);
    });
  }

  for (const replayStatus of [200, 503]) {
  it(`idle Matrix: same-account ${method} rejects pending replay ${replayStatus === 200 ? 'success' : 'error'} before the heartbeat and allows fresh checks`, async () => {
    await withMatrixCompletion(true, async (page, session, checks, initial) => {
      await initial.release();
      await statusSettled(page, 1);
      const replay = await checks.holdNextDelivery(page);
      const settledBefore = await page.evaluate(() =>
        (window as CommandOwnershipWindow).__terminalCommandSettled ?? 0);
      checks.holdNext(replayStatus).release();
      await submitReplay(page);
      await replay.received(replayStatus === 200 ? 'fulfilled' : 'rejected');
      const documentBefore = await completionDocument(page);
      const now = await page.evaluate(() => Date.now());
      await endMatrixSession(page, method);
      session.user = { ...user };
      session.gold = { ...session.gold, solved: false };
      const current = await checks.holdNextDelivery(page);
      await resumeMatrixSession(page);
      const replacementOutput = await page.locator('#terminal-output').innerHTML();
      await replay.release();
      await replaySettled(page, 1);
      await expect.poll(() => page.evaluate(() =>
        (window as CommandOwnershipWindow).__terminalCommandSettled)).toBe(settledBefore + 1);
      expect(await page.locator('#terminal-output').innerHTML()).toBe(replacementOutput);
      expect(await page.evaluate(() => Date.now())).toBe(now);
      expect(await completionDocument(page)).toEqual(documentBefore);
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      expect(await replayResults(page)).toEqual(['    Sign in first.']);
      expect(await appliedStatuses(page)).toEqual([true]);
      expect(await takeFailedCompletionWrites(page)).toBe(0);
      expect(checks.requests).toEqual([
        { account: user.account_id, solved: true },
        { account: user.account_id, solved: true },
      ]);

      await page.clock.runFor(1000);
      await current.received();
      expect(checks.requests).toHaveLength(3);
      expect(checks.requests[2]).toEqual({ account: user.account_id, solved: false });
      await current.release();
      await statusSettled(page, 2);
      expect(await appliedStatuses(page)).toEqual([true, false]);
      await page.clock.resume();
      await expect.poll(() => page.locator('#terminal-input').getAttribute('data-command-busy'),
        { timeout: 15_000 }).toBe('false');
      expect(await page.locator('#terminal-output').innerText()).not.toContain('Sign in first.');
      expect(await page.locator('#terminal-output').innerText()).not.toContain('Synthetic completion check failed.');
      expect(await page.locator('#terminal-output').innerText()).not.toContain('Unable to check Matrix completion');
      await command(page, 'matrix_test', 'earn its points');
      session.gold = { ...session.gold, solved: true };
      await page.locator('#terminal-input').focus();
      await page.keyboard.type('matrix_test');
      await page.keyboard.press('Enter');
      await replaySettled(page, 3);
      expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
      expect(await replayResults(page)).toEqual([
        '    Sign in first.',
        '    Complete Enter the Matrix and earn its points to unlock matrix_test.',
        null,
      ]);
      expect(checks.requests).toEqual([
        { account: user.account_id, solved: true },
        { account: user.account_id, solved: true },
        { account: user.account_id, solved: false },
        { account: user.account_id, solved: false },
        { account: user.account_id, solved: true },
      ]);
      expect(session.logoutRequests).toBe(method === 'logout' ? 1 : 0);
      expect(session.submittedFlag).toBeUndefined();
      expect(session.mailEvents).toHaveLength(0);
      expect(checks.expectedFailures).toEqual([]);
    });
  });
  }
}

for (const status of [200, 503]) {
  it(`idle Matrix: delayed replay ${status === 200 ? 'success waits for confirmation' : 'failure restores the prompt and allows retry'}`, async () => {
    await withMatrixCompletion(true, async (page, session, checks, initial) => {
      await initial.release();
      await statusSettled(page, 1);
      const replay = checks.holdNext(status);
      await submitReplay(page);
      await expect.poll(() => checks.requests.length).toBe(2);
      // This case covers delayed replies, not request timeout. Advance the idle
      // wall clock independently, then run less than the real transport budget.
      await page.clock.setSystemTime(await page.evaluate(() => Date.now() + 181_000));
      await page.clock.runFor(1000);
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      expect(await page.locator('#terminal-input').getAttribute('data-command-busy')).toBe('true');
      // A terminal submission waits on the check; it must not optimistically
      // enter from cached solve state, nor get stuck after a failed response.
      await page.clock.resume();
      replay.release();
      await expect.poll(() => page.locator('#terminal-input').getAttribute('data-command-busy'), { timeout: 15_000 }).toBe('false');
      if (status !== 200) {
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        expect(await page.locator('#terminal-output').innerText()).toContain('Synthetic completion check failed.');
        await command(page, 'echo replay-retry-ready', 'replay-retry-ready');
        const retry = checks.holdNext();
        const count = checks.requests.length;
        await submitReplay(page);
        await expect.poll(() => checks.requests.length).toBe(count + 1);
        retry.release();
      }
      await expect.poll(() => page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
      expect(session.submittedFlag).toBeUndefined();
      expect(session.mailEvents).toHaveLength(0);
      await page.keyboard.press('Space');
      await page.keyboard.press('q');
      await command(page, 'echo replay-finished', 'replay-finished');
    });
  });
}

it('idle Matrix: replay transport timeout releases the prompt, permits retry and ignores late success', async () => {
  await withMatrixCompletion(true, async (page, session, checks, initial) => {
    await initial.release();
    await statusSettled(page, 1);
    const input = page.locator('#terminal-input');
    const replay = checks.holdNext();
    await submitReplay(page);
    await expect.poll(() => checks.requests.length).toBe(2);

    // Exercise the real service's ten-second deadline, not a synthetic error or
    // a caller-continuation gate. The solved response stays held through retry.
    await page.clock.runFor(9_999);
    expect(await input.getAttribute('data-command-busy')).toBe('true');
    expect(await replayResults(page)).toEqual([]);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await page.clock.runFor(1);
    await replaySettled(page, 1);
    const timeout = '    Unable to check Matrix completion: Matrix completion request timed out';
    expect(await replayResults(page)).toEqual([timeout]);
    await page.clock.resume();
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 15_000 }).toBe('false');
    expect(await page.locator('#terminal-output').innerText()).toContain(timeout.trim());
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(await input.getAttribute('contenteditable')).toBe('true');
    expect(await input.evaluate(node => document.activeElement === node)).toBe(true);
    await command(page, 'echo timeout-prompt-ready', 'timeout-prompt-ready');

    // A new command must make its own request while the old transport is held.
    const retry = checks.holdNext();
    await submitReplay(page);
    await expect.poll(() => checks.requests.length).toBe(3);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    retry.release();
    await replaySettled(page, 2);
    expect(await replayResults(page)).toEqual([timeout, null]);
    await expect.poll(() => page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
    await page.keyboard.press('Space');
    await page.keyboard.press('q');
    await command(page, 'echo timeout-retry-finished', 'timeout-retry-finished');

    // Release the original solved response only after the fresh encounter has
    // ended. Observe fixture fulfillment before checking it cannot re-enter.
    await pauseCompletionClock(page);
    await expect.poll(() => checks.fulfilledResponses).toBe(2);
    replay.release();
    await expect.poll(() => checks.fulfilledResponses).toBe(3);
    await page.clock.runFor(1000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(await input.getAttribute('data-command-busy')).toBe('false');
    await replaySettled(page, 2);
    expect(await replayResults(page)).toEqual([timeout, null]);
    expect(checks.requests).toEqual(Array.from({ length: 3 }, () => ({
      account: user.account_id, solved: true,
    })));
    await page.clock.resume();
    await command(page, 'echo timeout-late-response-safe', 'timeout-late-response-safe');
    expect(session.submittedFlag).toBeUndefined();
    expect(session.mailEvents).toHaveLength(0);
  });
});

it('idle Matrix: late solved replay response cannot unlock a different unsolved account', async () => {
  await withMatrixCompletion(true, async (page, session, checks, initial) => {
    await initial.release();
    await statusSettled(page, 1);
    const replay = checks.holdNext();
    await submitReplay(page);
    await expect.poll(() => checks.requests.length).toBe(2);
    expect(checks.requests[1]).toEqual({ account: user.account_id, solved: true });
    session.user = { ...user, account_id: '8', home: '/home/synthetic-8', first_name: 'Other' };
    session.gold = { ...session.gold, solved: false };
    await refreshMatrixIdentity(page);
    // Resolve before the heartbeat: the replay guard must check the current
    // identity itself, not rely on the background tick noticing the switch.
    replay.release();
    await page.clock.resume();
    await expect.poll(() => page.locator('#terminal-input').getAttribute('data-command-busy'), { timeout: 15_000 }).toBe('false');
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(await page.locator('#terminal-output').innerText()).toContain('Sign in first.');
    await command(page, 'matrix_test', 'earn its points');
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(session.submittedFlag).toBeUndefined();
    expect(session.mailEvents).toHaveLength(0);
  });
});

for (const replacement of [false, true]) {
  for (const { oldSolved, status, invalidate } of [false, true].flatMap(oldSolved => [
    { oldSolved, status: 200, invalidate: true },
    { oldSolved, status: 503, invalidate: false },
    { oldSolved, status: 503, invalidate: true },
  ])) {
    it(`idle Matrix: disposed background ${oldSolved ? 'solved' : 'unsolved'} ${status === 200 ? 'response' : `503 rejection ${invalidate ? 'with' : 'without'} invalidation`} stays inactive ${replacement ? 'after replacement' : 'without replacement'}`, async () => {
      await withMatrixCompletion(oldSolved, async (page, session, checks, initial) => {
        await initial.release();
        await statusSettled(page, 1);
        const documentBefore = await completionDocument(page);
        const ownerBefore = await matrixRuntime(page);
        expect(await takeFailedCompletionWrites(page)).toBe(0);
        const old = await checks.holdNextDelivery(page);
        checks.holdNext(status).release();
        await page.clock.runFor(31_000);
        // Hold the parsed service outcome, not transport: disposal must not
        // substitute an abort for the synthetic rejection under test.
        await old.received(status === 200 ? 'fulfilled' : 'rejected');
        expect(checks.requests).toHaveLength(2);
        // An unchanged version isolates retired-owner catch writes. Separately,
        // invalidate pending work to exercise the finally block's follow-up.
        if (invalidate) {
          await page.evaluate(() => document.dispatchEvent(new Event('ctf:solve-confirmed')));
        }
        await disposeMatrix(page);
        await disposeMatrix(page);

        let current: Awaited<ReturnType<MatrixCompletionFixture['holdNextDelivery']>> | undefined;
        if (replacement) {
          session.gold = { ...session.gold, solved: !oldSolved };
          current = await checks.holdNextDelivery(page);
          await replaceMatrix(page); // Same account, same DOM; no reload hides old work.
          await page.clock.runFor(1000);
          await current.received();
          expect(checks.requests[2]).toEqual({ account: user.account_id, solved: !oldSolved });
        }
        const count = checks.requests.length;
        const now = await page.evaluate(() => Date.now());
        const outputBefore = await page.locator('#terminal-output').innerHTML();
        await old.release();
        await statusSettled(page, 2);
        // A stale null-to-null assignment is invisible in the UI. Observe the
        // guarded catch write itself, before any replacement response settles.
        expect(await takeFailedCompletionWrites(page)).toBe(0);
        expect(await appliedStatuses(page)).toEqual([oldSolved]);
        expect(checks.requests).toHaveLength(count);
        expect(await page.evaluate(() => Date.now())).toBe(now);
        expect(await page.locator('#terminal-output').innerHTML()).toBe(outputBefore);
        expect(await completionDocument(page)).toEqual({
          ...documentBefore, solveEvents: documentBefore.solveEvents + Number(invalidate),
        });
        expect(await matrixRuntime(page)).toMatchObject({
          installs: ownerBefore.installs + Number(replacement),
          account: ownerBefore.account, generation: ownerBefore.generation,
        });
        // Cover both an overdue idle deadline and repeated refresh ticks while
        // the replacement remains unknown. Neither may use the old response.
        await page.clock.fastForward(181_000);
        await page.clock.runFor(31_000);
        expect(checks.requests).toHaveLength(count);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        expect(await takeFailedCompletionWrites(page)).toBe(0);

        if (current) {
          await current.release();
          await statusSettled(page, 3);
          expect(await appliedStatuses(page)).toEqual([oldSolved, !oldSolved]);
          const next = checks.holdNext();
          await page.clock.runFor(1000);
          await expect.poll(() => checks.requests.length).toBe(count + 1);
          // The long-held response is already due for another refresh.
          // Unknown status must stay inactive until that fresh check settles.
          expect(await page.locator('.idle-matrix-message').count()).toBe(0);
          next.release();
          await statusSettled(page, 4);
          expect(await appliedStatuses(page)).toEqual([oldSolved, !oldSolved, !oldSolved]);
          await page.clock.runFor(1000);
          if (oldSolved) {
            expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
          } else {
            expect(await page.locator('.idle-matrix-message').count()).toBe(0);
          }
          await disposeMatrix(page);
          await page.clock.fastForward(181_000);
          expect(checks.requests).toHaveLength(count + 1);
        }
        await page.clock.resume();
        await command(page, 'echo cleanup-background-safe', 'cleanup-background-safe');
        expect(await takeFailedCompletionWrites(page)).toBe(0);
        expect(await page.locator('#terminal-output').innerText()).not.toContain('Synthetic completion check failed.');
        expect(await page.locator('#terminal-output').innerText()).not.toContain('Unable to check Matrix completion');
        expect(session.logoutRequests).toBe(0);
        expect(session.submittedFlag).toBeUndefined();
        expect(session.mailEvents).toHaveLength(0);
        expect(checks.expectedFailures).toEqual([]);
      });
    });
  }

  for (const replayStatus of [200, 503]) {
  it(`idle Matrix: disposed replay ${replayStatus === 200 ? 'success' : 'error'} stays inactive ${replacement ? 'after replacement' : 'without replacement'}`, async () => {
    await withMatrixCompletion(true, async (page, session, checks, initial) => {
      await initial.release();
      await statusSettled(page, 1);
      const documentBefore = await completionDocument(page);
      const ownerBefore = await matrixRuntime(page);
      const replay = await checks.holdNextDelivery(page);
      checks.holdNext(replayStatus).release();
      await submitReplay(page);
      // Hold the parsed service outcome, not the HTTP transport. Disposal cannot
      // turn this synthetic 503 into an abort and hide a missing catch guard.
      await replay.received(replayStatus === 200 ? 'fulfilled' : 'rejected');
      expect(checks.requests).toHaveLength(2);
      await disposeMatrix(page);
      await disposeMatrix(page);
      let current: Awaited<ReturnType<MatrixCompletionFixture['holdNextDelivery']>> | undefined;
      if (replacement) {
        session.gold = { ...session.gold, solved: false };
        current = await checks.holdNextDelivery(page);
        await replaceMatrix(page);
        await page.clock.runFor(1000);
        await current.received();
        expect(checks.requests[2]).toEqual({ account: user.account_id, solved: false });
      }
      const count = checks.requests.length;
      const now = await page.evaluate(() => Date.now());
      await replay.release();
      await replaySettled(page, 1);
      expect(await replayResults(page)).toEqual([
        '    Matrix test unavailable: return to an empty terminal prompt first.',
      ]);
      expect(await page.evaluate(() => Date.now())).toBe(now);
      expect(await completionDocument(page)).toEqual(documentBefore);
      const ownerAfter = await matrixRuntime(page);
      expect(ownerAfter.account).toBe(ownerBefore.account);
      expect(ownerAfter.generation).toBe(ownerBefore.generation);
      await page.clock.resume();
      await expect.poll(() => page.locator('#terminal-input').getAttribute('data-command-busy'),
        { timeout: 15_000 }).toBe('false');
      await pauseCompletionClock(page);
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      expect(await page.locator('#terminal-output').innerText()).toContain('Matrix test unavailable');
      expect(await page.locator('#terminal-output').innerText()).not.toContain('Synthetic completion check failed.');
      expect(await page.locator('#terminal-output').innerText()).not.toContain('Unable to check Matrix completion');
      expect(await appliedStatuses(page)).toEqual([true]);
      await page.clock.fastForward(181_000);
      await page.clock.runFor(31_000);
      expect(checks.requests).toHaveLength(count);
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      if (current) {
        await current.release();
        await statusSettled(page, 2);
        expect(await appliedStatuses(page)).toEqual([true, false]);
        const next = checks.holdNext();
        await page.clock.runFor(1000);
        await expect.poll(() => checks.requests.length).toBe(count + 1);
        expect(await page.locator('.idle-matrix-message').count()).toBe(0);
        next.release();
        await statusSettled(page, 3);
        expect(await appliedStatuses(page)).toEqual([true, false, false]);
        await page.clock.runFor(1000);
        expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
        await disposeMatrix(page);
        await page.clock.fastForward(181_000);
        expect(checks.requests).toHaveLength(count + 1);
      }
      await page.clock.resume();
      await command(page, 'echo cleanup-replay-safe', 'cleanup-replay-safe');
      // Both paths now have no installer. A fresh one must accept its own replay
      // rather than inheriting the retired request's error or remaining locked.
      session.gold = { ...session.gold, solved: true };
      await pauseCompletionClock(page);
      await replaceMatrix(page);
      await page.clock.runFor(1000);
      await statusSettled(page, replacement ? 4 : 2);
      expect(await appliedStatuses(page))
        .toEqual(replacement ? [true, false, false, true] : [true, true]);
      await page.clock.resume();
      await page.locator('#terminal-input').focus();
      await page.keyboard.type('matrix_test');
      await page.keyboard.press('Enter');
      await replaySettled(page, 2);
      expect(await replayResults(page)).toEqual([
        '    Matrix test unavailable: return to an empty terminal prompt first.',
        null,
      ]);
      expect(await page.locator('.idle-matrix-message').innerText()).toBe('Wake up, Jane. . .');
      await page.keyboard.press('Space');
      await page.keyboard.press('q');
      await command(page, 'echo fresh-replay-safe', 'fresh-replay-safe');
      expect(await completionDocument(page)).toEqual(documentBefore);
      expect(session.submittedFlag).toBeUndefined();
      expect(session.mailEvents).toHaveLength(0);
      expect(session.logoutRequests).toBe(0);
      expect(checks.expectedFailures).toEqual([]);
    });
  });
  }
}

it('idle Matrix: only an awarded solve unlocks replay and disables automatic entry across reloads', async () => {
  await withUnloadedTerminal(true, async (page, session) => {
    await page.clock.install();
    await loadTerminal(page);
    await ready(page);
    await command(page, 'matrix_test', 'earn its points');
    session.user = { ...user, is_admin: true };
    await reloadWithDiagnostics(page);
    await ready(page);
    await command(page, 'matrix_test', 'earn its points');
    session.user = { ...user, is_admin: false };
    session.gold = { ...session.gold, slug: 'enter-the-matrix', solved: true };
    await reloadWithDiagnostics(page);
    await ready(page);
    await page.clock.runFor(1000);
    await page.clock.fastForward(600_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await command(page, 'matrix_test extra', 'Usage: matrix_test');
    await page.keyboard.type('matrix_test');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.idle-matrix-message').innerText()).toContain('Wake up,');
    expect(await page.locator('.idle-matrix-controls').count()).toBe(0);
    await page.keyboard.press('Space');
    await page.keyboard.press('q');
    await page.clock.fastForward(600_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect(session.scopedSubmissions ?? 0).toBe(0);
  });
});

for (const mode of ['suspended', 'rejected', 'unavailable'] as const) {
  it(`idle Matrix: injected ${mode} audio shows feedback without losing the reward or prompt`, async () => {
    await withUnloadedTerminal(true, async (page) => {
      await prepareMatrix(page, ready, loadTerminal, mode);
      await followRabbit(page);
      await beginKnock(page);
      await page.clock.runFor(4999);
      expect(await page.locator('.idle-matrix-message').innerText()).toBe('Knock, knock, Jane.');
      await page.clock.runFor(1);
      expect(await page.locator('.idle-matrix-message').innerText()).toContain('[Knock sound unavailable: browser audio is blocked.]');
      expect(await page.locator('.idle-matrix-message').innerText()).toContain('neo_has_land3d');
      expect((await traceAudio(page)).starts).toEqual([]);
      await dismissMatrixReward(page);
      expect((await traceAudio(page)).closed).toBe(mode === 'unavailable' ? 0 : 1);
      await assertPromptRestored(page);
    });
  });
}

for (const stage of ['typing', 'delay', 'reward'] as const) {
  it(`idle Matrix: sign-out during ${stage} cancels timers and audio without reopening the prompt`, async () => {
    await withUnloadedTerminal(true, async (page, session) => {
      await prepareMatrix(page, ready, loadTerminal);
      await page.keyboard.press('Control+x');
      if (stage !== 'typing') {
        await page.clock.runFor(2000);
        await beginKnock(page);
        await page.clock.runFor(stage === 'delay' ? 4999 : 5000);
      }
      const starts = (await traceAudio(page)).starts.length;
      session.user = null;
      await expireMatrixIdentity(page);
      await page.clock.runFor(1000); // Identity heartbeat.
      expect((await traceAudio(page)).closed).toBe(1);
      await page.clock.runFor(15_000);
      expect(await page.locator('.idle-matrix-message').count()).toBe(0);
      expect(await page.locator('#terminal-output').innerText()).not.toContain('neo_has_land3d');
      expect((await traceAudio(page)).starts.length).toBe(starts);
      expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(false);
      expect(await page.locator('#terminal-input').getAttribute('contenteditable')).toBe('false');
    });
  });
}

for (const method of ['logout', 'expiry'] as const) {
  for (const stage of ['typing', 'delay', 'reward'] as const) {
    const guards = stage === 'delay'
      ? ['keyboard', 'heartbeat', 'timer'] as const
      : ['keyboard', 'heartbeat'] as const;
    for (const guard of guards) {
      it(`idle Matrix: active same-account ${method} during ${stage} cancels via ${guard} without erasing resumed UI`, async () => {
        await withUnloadedTerminal(true, async (page, session) => {
          await observeCompletionDocument(page);
          await prepareMatrix(page, ready, loadTerminal);
          await reachActiveMatrixStage(page, stage);
          // Delay cases normally leave the next heartbeat ahead of the knock.
          // For the timer guard, stop 1ms before the knock, with no tick due.
          if (guard === 'timer') await page.clock.runFor(1000);
          const documentBefore = await completionDocument(page);
          const runtimeBefore = await matrixRuntime(page);
          const audioBefore = await traceAudio(page);
          const now = await page.evaluate(() => Date.now());
          // Retain the old node: auth replaces the output, which could otherwise
          // hide a typing interval still mutating its detached message.
          const oldNotice = await page.locator('.idle-matrix-message').elementHandle();
          expect(oldNotice).not.toBeNull();
          try {
            await endMatrixSession(page, method);
            expect((await matrixRuntime(page)).account).toBeNull();
            expect(await page.locator('#terminal-input').getAttribute('contenteditable')).toBe('false');
            session.user = { ...user };
            await resumeMatrixSession(page);
            const resumed = await matrixRuntime(page);
            expect(resumed.account).toBe(runtimeBefore.account);
            expect(resumed.generation).toBeGreaterThan(runtimeBefore.generation);
            expect(resumed.installs).toBe(1);
            expect(resumed.heartbeats).toBe(runtimeBefore.heartbeats);
            expect(await completionDocument(page)).toEqual(documentBefore);
            expect(await page.evaluate(() => Date.now())).toBe(now);
            expect((await traceAudio(page)).closed).toBe(0);

            // Represent output and a draft owned by the resumed session. Do not
            // dispatch an input event: the old activity listener must remain live
            // until the deliberately selected guard below runs.
            await page.evaluate(() => {
              document.getElementById('terminal-output')!.textContent = 'Resumed session owns this screen';
              document.getElementById('terminal-input')!.textContent = 'echo resumed';
            });
            if (guard === 'keyboard') {
              await page.keyboard.press('End');
              expect(await page.evaluate(() => Date.now())).toBe(now);
            } else {
              await page.clock.runFor(guard === 'timer' ? 1 : 1000);
            }
            expect((await matrixRuntime(page)).heartbeats)
              .toBe(runtimeBefore.heartbeats + (guard === 'heartbeat' ? 1 : 0));
            await expect.poll(async () => (await traceAudio(page)).states).toEqual(['closed']);
            expect((await traceAudio(page)).closed).toBe(1);
            const stoppedText = await oldNotice.textContent();
            await page.keyboard.press('End');
            await page.keyboard.type('-safe');
            expect(await page.locator('#terminal-input').innerText()).toBe('echo resumed-safe');

            // Cross both the remaining typing and knock deadlines. No old key
            // handler, timer, or audio unlock may take ownership back.
            await page.clock.runFor(15_000);
            expect(await oldNotice.textContent()).toBe(stoppedText);
            const audioAfter = await traceAudio(page);
            expect(audioAfter.starts).toEqual(audioBefore.starts);
            expect(audioAfter.resumes).toEqual(audioBefore.resumes);
            expect(audioAfter.closed).toBe(1);
            expect(audioAfter.states).toEqual(['closed']);
            expect(await page.locator('.idle-matrix-message').count()).toBe(0);
            expect(await page.locator('#terminal-output').innerText()).toBe('Resumed session owns this screen');
            expect(await page.locator('#terminal-input').innerText()).toBe('echo resumed-safe');
            expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(true);
            expect(await page.locator('#terminal-input').getAttribute('contenteditable')).toBe('true');
            expect(await page.locator('#terminal-input').evaluate(node => document.activeElement === node)).toBe(true);
            expect(await completionDocument(page)).toEqual(documentBefore);
            expect((await matrixRuntime(page)).installs).toBe(1);
            expect(session.logoutRequests).toBe(method === 'logout' ? 1 : 0);
            expect(session.submittedFlag).toBeUndefined();
            expect(session.scopedSubmissions ?? 0).toBe(0);
            expect(session.mailEvents).toHaveLength(0);
          } finally {
            await oldNotice?.dispose();
          }
        });
      });
    }
  }
}

it('idle Matrix: switching accounts cancels the old sequence without erasing the new identity UI', async () => {
  await withUnloadedTerminal(true, async (page, session) => {
    await prepareMatrix(page, ready, loadTerminal);
    await followRabbit(page);
    await beginKnock(page);
    await page.clock.runFor(4999);
    session.user = { ...user, account_id: '8', home: '/home/synthetic-8', first_name: 'Other' };
    await refreshMatrixIdentity(page);
    await page.evaluate(() => {
      const output = document.getElementById('terminal-output')!;
      output.textContent = 'New identity owns this screen';
      document.getElementById('terminal-input-wrapper')!.hidden = false;
      document.getElementById('terminal-input')!.contentEditable = 'true';
    });
    await page.clock.runFor(1);
    expect((await traceAudio(page)).starts).toEqual([]);
    expect((await traceAudio(page)).closed).toBe(1);
    await page.clock.runFor(15_000);
    expect(await page.locator('#terminal-output').innerText()).toBe('New identity owns this screen');
  });
});

it('idle Matrix: disposing the installer cancels pending audio and removes event handlers and heartbeat', async () => {
  await withUnloadedTerminal(true, async (page) => {
    await prepareMatrix(page, ready, loadTerminal);
    await followRabbit(page);
    await beginKnock(page);
    await disposeMatrix(page);
    await disposeMatrix(page); // Idempotent disposal.
    expect((await traceAudio(page)).closed).toBe(1);
    await assertPromptRestored(page);
    await page.locator('#terminal-input').fill('');
    await page.clock.runFor(130_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    expect((await traceAudio(page)).starts).toEqual([]);
    await page.keyboard.type('still editable');
    expect(await page.locator('#terminal-input').innerText()).toBe('still editable');
  });
});

it('idle Matrix: submitted commands restart the three-minute deadline', async () => {
  await withUnloadedTerminal(true, async (page) => {
    await page.clock.install();
    await loadTerminal(page);
    await ready(page);
    await page.evaluate(() => { Math.random = () => 1; });
    await page.clock.runFor(1000);
    await page.clock.fastForward(120_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await page.keyboard.type('clear');
    await page.keyboard.press('Enter');
    await ready(page);
    await page.clock.fastForward(120_000);
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await page.locator('#terminal-input').focus();
    await page.keyboard.insertText('unfinished draft');
    await page.clock.fastForward(61_000);
    expect(await page.locator('#terminal-input').innerText()).toBe('unfinished draft');
    expect(await page.locator('.idle-matrix-message').count()).toBe(0);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.evaluate(() => {
      const oldPage = document.createElement('div');
      oldPage.className = 'terminal-pager terminal-pager--finished';
      document.getElementById('terminal-output')!.append(oldPage);
    });
    await page.clock.runFor(1000);
    expect(await page.locator('.idle-matrix-message').innerText()).toContain('Wake up,');
  });
});

it('shows matrix rain and restores a usable prompt with Escape or the exit button', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    const input = page.locator('#terminal-input');
    const output = page.locator('#terminal-output');
    const before = await output.innerText();
    const expectFullMonitor = async () => {
      const bounds = await page.locator('.matrix-screen canvas').boundingBox();
      const viewport = page.viewportSize()!;
      expect(bounds).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
      expect(await page.locator('.matrix-screen').evaluate(node =>
        Number(getComputedStyle(node).zIndex)
        < Number(getComputedStyle(document.querySelector('.crt')!).zIndex),
      )).toBe(true);
    };
    for (const exit of ['keyboard', 'button']) {
      await input.focus();
      await page.keyboard.insertText('matrix');
      await input.press('Enter');
      await page.locator('.matrix-screen').waitFor();
      await expectFullMonitor();
      expect(await output.isVisible()).toBe(false);
      expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(false);
      await expect.poll(() => page.locator('.matrix-screen canvas').evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, index) => index % 4 === 1 && value > 100);
      })).toBe(true);
      // Switch the real theme button in both directions while Matrix is open.
      // Canvas pixels (not just CSS) must adopt the selected phosphor color.
      for (const reduced of ['reduce', 'no-preference'] as const) {
        await page.emulateMedia({ reducedMotion: reduced });
        await page.locator('.theme-button').click();
        await expect.poll(() => page.locator('.matrix-screen canvas').evaluate(node => {
          const green = document.body.classList.contains('green');
          const canvas = node as HTMLCanvasElement;
          const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
          let matching = 0;
          let wrong = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i]!, g = pixels[i + 1]!;
            if (Math.max(r, g) < 50) continue;
            if (green ? g > r : r > g) matching++;
            else if (r !== g) wrong++;
          }
          return matching > 100 && wrong === 0;
        })).toBe(true);
      }
      await page.keyboard.type('ignored');
      if (exit === 'keyboard') await page.keyboard.press('Escape');
      else {
        await page.setViewportSize({ width: 390, height: 844 });
        await expectFullMonitor();
        await page.getByRole('button', { name: 'ESC · Return to prompt' }).click();
      }
      await page.locator('.matrix-screen').waitFor({ state: 'detached' });
      await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 15_000 }).toBe('false');
      expect(await input.innerText()).toBe('');
      expect(await output.innerText()).toContain(before);
      expect(await input.evaluate(node => document.activeElement === node)).toBe(true);
      await command(page, 'echo after-matrix', 'after-matrix');
    }
  });
});

it('runs sl visibly, exits or cancels, and returns to a usable prompt', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    const input = page.locator('#terminal-input');
    const output = page.locator('#terminal-output');
    const before = await output.innerText();
    const initialLines = await output.locator(':scope > *').count();
    await input.focus();
    await page.keyboard.insertText('sl');
    await input.press('Enter');
    await page.locator('.sl-screen').waitFor();
    expect(await page.locator('.sl-screen').innerText()).toContain('STEAM');
    await page.locator('.sl-screen').waitFor({ state: 'detached', timeout: 7000 });
    await expect.poll(() => output.innerText()).toContain(' $ sl\n');
    await expect.poll(() => input.getAttribute('contenteditable')).toBe('true');
    expect(await output.innerText()).toContain(before);
    // One output node includes the command, response and trailing blank line.
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 5000 }).toBe('false');
    expect(await output.locator(':scope > *').count()).toBe(initialLines + 1);
    await command(page, 'echo after-train', 'after-train');
    const linesBeforeCancel = await output.locator(':scope > *').count();
    await input.focus();
    await page.keyboard.insertText('sl');
    await input.press('Enter');
    await page.locator('.sl-screen').waitFor();
    await page.keyboard.press('Control+c');
    await page.locator('.sl-screen').waitFor({ state: 'detached' });
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 5000 }).toBe('false');
    expect(await output.locator(':scope > *').count()).toBe(linesBeforeCancel + 1);
    await command(page, 'echo after-cancel', 'after-cancel');
  });
});

// isVisible() alone also accepts cells clipped by an overflow container. Measure
// actual text and hit-test challenge links without opening their details.
async function narrowTable(page: Page, pager: Locator) {
  const viewport = pager.locator('.terminal-pager__viewport');
  const ticket = pager.getByRole('button', { name: '1', exact: true });
  const summary = pager.getByRole('button', { name: /Offline paged challenge 1 .*RIGHT-EDGE$/, exact: true });
  const points = () => viewport.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent!.indexOf('12345');
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 5);
      const rect = range.getBoundingClientRect();
      const clip = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        clipLeft: clip.left, clipRight: clip.right, clipTop: clip.top, clipBottom: clip.bottom };
    }
    throw new Error('Missing wide points cell');
  });
  // Bring the first data row into view only if needed. For a full-height page,
  // keep its natural position rather than moving it behind the top CRT controls.
  for (let row = 0; row < 20; row++) {
    const cell = await points();
    const center = (cell.top + cell.bottom) / 2;
    if (center >= cell.clipTop && center < cell.clipBottom) break;
    await page.keyboard.press('Enter');
  }
  expect(await viewport.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  expect((await points()).left).toBeGreaterThan((await points()).clipRight);
  await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const cell = await points();
  expect(cell.left).toBeGreaterThanOrEqual(cell.clipLeft);
  expect(cell.right).toBeLessThanOrEqual(cell.clipRight);
  // Range rectangles include font leading (Courier extends 2px above its
  // 20px line box). Test the row's center, not that extra typographic padding.
  const cellCenter = (cell.top + cell.bottom) / 2;
  expect(cellCenter).toBeGreaterThanOrEqual(cell.clipTop);
  expect(cellCenter).toBeLessThan(cell.clipBottom);
  // scrollLeft updates geometry before Chromium necessarily updates compositor
  // hit-testing. Keep the actual reachability assertion, but wait for that frame.
  await expect.poll(() => summary.evaluate((element) => {
    const node = element.lastChild!;
    const range = document.createRange();
    range.setStart(node, node.textContent!.length - 'RIGHT-EDGE'.length);
    range.setEnd(node, node.textContent!.length);
    const rect = range.getBoundingClientRect();
    return element.contains(
      document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
    );
  }), { message: 'Scrolled title link must be exposed and hit-testable' }).toBe(true);
  await viewport.evaluate((element) => { element.scrollLeft = 0; });
  expect(await ticket.getAttribute('class')).toContain('challenge-link');
  await ticket.click({ trial: true });
  const status = await pager.locator('.terminal-pager__status').boundingBox();
  expect(status).not.toBeNull();
  expect(status!.x).toBeGreaterThanOrEqual(0);
  expect(status!.x + status!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(status!.y + status!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}

for (const layout of pagerDesktopLayouts) {
  it(`keeps pager exits and the restored prompt usable at ${layout.name}`, async () => {
    await withTerminal(true, async (page, session) => {
      await ready(page);
      session.goldRows = pagedGoldRows(80,
        number => `Desktop pager ${number} ${'wide '.repeat(30)}RIGHT-EDGE`);
      await pagerDesktopJourney(page, layout);
    }, { viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  });
}

it('keeps paging usable through desktop and phone resizes and accepts exactly one command after every exit', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    const input = page.locator('#terminal-input');
    const output = page.locator('#terminal-output');
    const wrapper = page.locator('#terminal-input-wrapper');
    const prefix = await page.locator('#input-prefix').textContent();
    // Reuse the booted session: repeated paging also catches leaked key handlers.
    for (const exit of ['Q', 'Escape', 'resize']) {
      const phone = exit !== 'resize';
      await page.setViewportSize(phone
        ? { width: exit === 'Q' ? 375 : 640, height: 812 }
        : { width: 1280, height: 720 });
      // Leave enough unread rows for a full page advance at both resized heights.
      const challengeCount = exit === 'resize' ? 160 : 80;
      // Titles stay within the Gold table's 64-column cap so RIGHT-EDGE is not truncated.
      session.goldRows = pagedGoldRows(challengeCount,
        number => `Offline paged challenge ${number} ${'wide '.repeat(5)}RIGHT-EDGE`);
      await input.focus();
      await page.keyboard.insertText('challenges gold');
      await page.keyboard.press('Enter');

      const pager = output.locator('.terminal-pager').last();
      const status = pager.locator('.terminal-pager__status');
      const content = pager.locator('.terminal-pager__content');
      await status.waitFor({ state: 'visible' });
      expect(await status.textContent()).toBe('--More--  Enter: next row  Space: next page  Left/Right: scroll  Q/Esc: quit');
      expect(await input.getAttribute('contenteditable')).toBe('false');
      expect(await wrapper.isVisible()).toBe(false);
      expect(await content.innerText()).toContain(`Offline paged challenge ${challengeCount}`);
      const metrics = await content.evaluate((element) => ({
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        pageHeight: element.parentElement!.getBoundingClientRect().height,
      }));
      const offset = () => content.evaluate((element) =>
        -new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);
      expect(await offset()).toBeCloseTo(0);
      expect(metrics.pageHeight).toBeGreaterThan(metrics.lineHeight);

      const stableHeight = async () => {
        // Sample across real animation frames so repeated ResizeObserver feedback
        // cannot pass merely by settling at its one-row minimum.
        const heights = await pager.locator('.terminal-pager__viewport').evaluate(async (element) => {
          const samples: number[] = [];
          for (let frame = 0; frame < 30; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            samples.push(element.getBoundingClientRect().height);
          }
          return samples;
        });
        expect(heights.every((height) => Math.abs(height - metrics.pageHeight) < 1),
          `Page height must remain stable: ${heights.join(', ')}`).toBe(true);
      };
      if (phone) {
        // At this 812px screen height, a one-row collapsed pager is never valid.
        expect(metrics.pageHeight).toBeGreaterThan(400);
        await stableHeight();
        await narrowTable(page, pager);
        const statusHeight = await status.evaluate(
          (element) => element.getBoundingClientRect().height,
        );
        if (page.viewportSize()!.width === 375) {
          expect(statusHeight, 'Narrow instructions must wrap without clipping').toBeGreaterThan(metrics.lineHeight);
        }
      }
      const startingOffset = await offset();
      await page.keyboard.press('Enter');
      expect(await offset()).toBeCloseTo(startingOffset + metrics.lineHeight);
      expect(await status.isVisible()).toBe(true);
      await page.keyboard.press('Space');
      expect(await offset()).toBeCloseTo(startingOffset + metrics.lineHeight + metrics.pageHeight);
      if (phone) await stableHeight();
      expect(await status.isVisible()).toBe(true);
      expect(await input.innerText()).toBe('');
      expect(await input.getAttribute('contenteditable')).toBe('false');

      if (exit === 'resize') {
        const viewport = pager.locator('.terminal-pager__viewport');
        let previousHeight = metrics.pageHeight;
        // Exercise the real ResizeObserver, not synthetic resize events or
        // direct calls into the pager. Both dimensions change while it is open.
        for (const size of [{ width: 900, height: 520 }, { width: 1280, height: 960 }]) {
          const previousOffset = await offset();
          await page.setViewportSize(size);
          const height = () => viewport.evaluate(
            (element) => element.getBoundingClientRect().height,
          );
          if (size.height === 520) {
            await expect.poll(height).toBeLessThan(previousHeight);
          } else {
            await expect.poll(height).toBeGreaterThan(previousHeight);
          }
          const layout = await pager.evaluate((element) => {
            const viewport = element.querySelector<HTMLElement>('.terminal-pager__viewport')!;
            const content = element.querySelector<HTMLElement>('.terminal-pager__content')!;
            const status = element.querySelector<HTMLElement>('.terminal-pager__status')!;
            const terminal = element.closest<HTMLElement>('.terminal')!;
            return {
              height: viewport.getBoundingClientRect().height,
              bottom: viewport.getBoundingClientRect().bottom,
              contentBottom: content.getBoundingClientRect().bottom,
              contentHeight: content.scrollHeight,
              overflow: getComputedStyle(viewport).overflowY,
              lineHeight: Number.parseFloat(getComputedStyle(content).lineHeight),
              statusTop: status.getBoundingClientRect().top,
              statusBottom: status.getBoundingClientRect().bottom,
              terminalBottom: terminal.getBoundingClientRect().bottom,
              scrollTop: terminal.scrollTop,
            };
          });
          // Content must still extend past a genuinely clipped viewport, with
          // the controls below it and inside both the terminal and the screen.
          expect(layout.overflow).toBe('hidden');
          expect(layout.contentBottom).toBeGreaterThan(layout.bottom);
          expect(layout.contentHeight).toBeGreaterThan(layout.height);
          expect(layout.statusTop).toBeGreaterThanOrEqual(layout.bottom - 1);
          expect(layout.statusBottom)
            .toBeLessThanOrEqual(Math.min(layout.terminalBottom, size.height) + 1);
          expect(layout.scrollTop).toBe(0);
          expect(await offset(), 'Resize must not skip previously unread rows').toBeCloseTo(previousOffset);
          expect(await status.isVisible()).toBe(true);
          expect(await wrapper.isVisible()).toBe(false);

          await page.keyboard.press('Enter');
          expect(await offset()).toBeCloseTo(previousOffset + layout.lineHeight);
          await page.keyboard.press('Space');
          expect(await offset(), 'Space must use the resized page height')
            .toBeCloseTo(previousOffset + layout.lineHeight + layout.height);
          expect(await status.isVisible()).toBe(true);
          expect(await input.getAttribute('contenteditable')).toBe('false');
          expect(await input.innerText()).toBe('');
          previousHeight = layout.height;
        }
      }

      const childrenBefore = await output.locator(':scope > *').count();
      if (exit === 'resize') {
        // Derive ample space from the rendered fixture rather than assuming a
        // font's row count. Only ResizeObserver should complete this pager.
        const contentHeight = await content.evaluate((element) => element.scrollHeight);
        await page.setViewportSize({ width: 1280, height: contentHeight * 2 + 960 });
        await status.waitFor({ state: 'detached' });
        expect(await input.getAttribute('contenteditable')).toBe('true');
        expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
      } else {
        await page.keyboard.press(exit);
      }
      if (phone) {
        const prompt = await wrapper.boundingBox();
        expect(prompt).not.toBeNull();
        expect(prompt!.y).toBeGreaterThanOrEqual(0);
        expect(prompt!.y + prompt!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
      }
      // Do not focus, wait for readiness, or retry: completion must restore a
      // usable prompt before the very next keyboard interaction (after the
      // asynchronous observer removes the status in the resize case).
      const text = `echo pager-${exit.toLowerCase()} | tr a-z A-Z`;
      const expected = `PAGER-${exit.toUpperCase()}`;
      await page.keyboard.insertText(text);
      expect(await input.innerText()).toBe(text);
      await page.keyboard.press('Enter');

      expect(await status.count()).toBe(0);
      expect(await pager.getAttribute('class')).toContain('terminal-pager--finished');
      expect(await wrapper.isVisible()).toBe(true);
      await expect.poll(() => input.getAttribute('contenteditable'), { timeout: 5_000 }).toBe('true');
      expect(await input.innerText()).toBe('');
      // Exact new output, not a substring match that could pass on the command
      // echo, truncated output, a swallowed Enter, or duplicate execution.
      const newLines = output.locator(`:scope > :nth-child(n+${childrenBefore + 1})`);
      await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
      expect(await newLines.count()).toBe(1);
      expect((await newLines.allTextContents()).join('').trim()).toBe(`${prefix}${text}\n${expected}`);
      expect((await output.innerText()).split('\n').filter((line) => line.trim() === expected)).toHaveLength(1);
    }
  });
});

it('persists owner-created nested files and edits through a real page reload', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await command(page, 'mkdir -p ~/projects/nested; echo directory-ready', /\ndirectory-ready\s*$/);
    await command(page, 'echo owner-reload-secret > ~/projects/nested/private.txt; cat ~/projects/nested/private.txt', /\nowner-reload-secret\s*$/);
    await command(page, 'echo owner-edited-notes > ~/notes.txt; cat ~/notes.txt', /\nowner-edited-notes\s*$/);
    await persistedFile(page, user.account_id, `${user.home}/notes.txt`, 'owner-edited-notes\n');
    await reloadWithDiagnostics(page);
    await ready(page);
    await command(page, 'pwd', user.home);
    await command(page, 'cat ~/projects/nested/private.txt', /\nowner-reload-secret\s*$/);
    await command(page, 'cat ~/notes.txt', /\nowner-edited-notes\s*$/);
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name));
    expect(databases).toContain(`lifo-fwf-account-${user.account_id}`);
    expect(databases).not.toContain('lifo');
  });
}, 90_000);

it('keeps per-directory bash history through reload and submits the literal env clue offline', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    const flag = '$t0ring_secrets_n_env_i$_bad';
    const plantedHistory = 'submit B@sh_h1st0ry_st0res_secret$_t00';
    const env = await command(page, 'env', 'SHELL=/bin/bash');
    expect(env).toContain(`FLAG=${flag}`);
    await command(page, 'mkdir -p ~/history-fixture/inner', '');
    await command(page, 'cd ~/history-fixture/inner', '');
    await command(page, 'pwd', `${user.home}/history-fixture/inner`);
    await command(page, `submit ${flag}`, 'CORRECT: Flag accepted.');
    expect(session.submittedFlag).toBe(flag);
    await command(page, 'cat .bash_history', 'pwd');
    await persistedFile(page, user.account_id, `${user.home}/history-fixture/inner/.bash_history`,
      `${plantedHistory}\npwd\ncat .bash_history\n`);
    await reloadWithDiagnostics(page);
    await ready(page);
    const history = await command(page, 'cat ~/history-fixture/inner/.bash_history', 'pwd');
    expect(history).not.toContain(flag);
    expect(history).not.toContain('submit [redacted]');
    expect(history.split('\n').filter(line => line === plantedHistory)).toHaveLength(1);
  });
}, 90_000);

it('delivers offline terminal and modal mail, clears it without replay, reloads and spaces prompts', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    const mailbox = `/var/mail/${user.home.split('/').at(-1)}`;
    await command(page, 'submit synthetic-answer', 'You have new mail.');
    await command(page, `cat ${mailbox}`, 'Outcome: Correct');
    await expect.poll(() => page.locator('#terminal-output > div').last().textContent(),
      { timeout: 10_000 }).toContain('Points awarded: 50');
    expect(await page.locator('#terminal-output > div').last().textContent())
      .not.toContain('synthetic-answer');
    await expect.poll(() => page.locator('#terminal-output > div').last().textContent(),
      { timeout: 10_000 }).toMatch(/\n\n$/);
    await command(page, 'challenges gold', '<hidden>');
    if (!await page.locator('.terminal-pager').count()) {
      await expect.poll(() => page.locator('#terminal-output > div').last().textContent(),
        { timeout: 10_000 }).toMatch(/\n\n$/);
    }
    await page.locator('#terminal-output .challenge-link').filter({ hasText: '<hidden>' }).first().click();
    const dialog = page.getByRole('dialog');
    session.scopedResponse = 'incorrect';
    await dialog.getByRole('textbox', { name: 'Flag' }).fill('modal-wrong');
    await dialog.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => dialog.getByRole('status').last().innerText()).toContain('Incorrect flag');
    session.scopedResponse = 'correct';
    await dialog.getByRole('textbox', { name: 'Flag' }).fill('modal-correct');
    await dialog.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => dialog.getByRole('status').last().innerText()).toContain('Correct!');
    await dialog.getByRole('button', { name: 'Close challenge details' }).click();
    if (await page.locator('.terminal-pager').count()) await page.keyboard.press('q');
    await page.locator('#terminal-input-wrapper').waitFor({ state: 'visible' });
    await expect.poll(() => page.locator('.terminal-pager').count()).toBe(0);
    await expect.poll(() => page.locator('#terminal-output').innerText())
      .toContain('You have new mail.');
    await command(page, `cat ${mailbox}`, 'Outcome: Incorrect');
    await expect.poll(() => page.locator('#terminal-output > div').last().textContent(),
      { timeout: 10_000 }).toContain('Points awarded: 75');
    await expect.poll(() => page.locator('#terminal-output > div').last().textContent(),
      { timeout: 10_000 }).toMatch(/\n\n$/);
    expect(await page.locator('#terminal-output > div').last().textContent())
      .not.toContain('modal-correct');
    await command(page, `: > ${mailbox}`, '');
    await expect.poll(() => page.locator('#terminal-output > div').last().textContent(),
      { timeout: 10_000 }).toMatch(/\n\n$/);
    await command(page, `cat ${mailbox}`, '');
    await persistedFile(page, user.account_id, mailbox, '');
    await reloadWithDiagnostics(page);
    await ready(page);
    const after = await command(page, `cat ${mailbox}`, '');
    expect(after).not.toContain('Outcome: Correct');
    expect(after).not.toContain('Outcome: Incorrect');
    expect(session.mailEvents).toHaveLength(3);
  });
}, 90_000);

it('runs fullscreen vi and restores the exact shell after save, reopen and discard', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    const input = page.locator('#terminal-input');
    const output = page.locator('#terminal-output');
    const wrapper = page.locator('#terminal-input-wrapper');
    const terminal = page.locator('.terminal');
    await command(page, 'echo before-vi', /\nbefore-vi\s*$/);
    await terminal.evaluate((element) => { element.scrollTop = 7; });
    const before = await page.evaluate(() => ({
      html: document.getElementById('terminal-output')!.innerHTML,
      prompt: document.getElementById('input-prefix')!.textContent,
      scroll: document.querySelector<HTMLElement>('.terminal')!.scrollTop,
    }));

    const enterVi = async () => {
      await input.focus();
      await page.keyboard.insertText('vi ~/vi-regression.txt');
      // The contenteditable caret can scroll itself while the command is typed.
      // Establish the shell viewport immediately before vi takes it over.
      await terminal.evaluate((element, scroll) => { element.scrollTop = scroll; }, before.scroll);
      await page.keyboard.press('Enter');
      await page.getByTestId('vi-screen').waitFor();
      expect(await output.isVisible()).toBe(false);
      expect(await wrapper.isVisible()).toBe(false);
      expect(await page.getByTestId('vi-buffer').innerText()).toContain('~');
    };
    const restored = async () => {
      await page.getByTestId('vi-screen').waitFor({ state: 'detached' });
      expect(await output.isVisible()).toBe(true);
      expect(await wrapper.isVisible()).toBe(true);
      expect(await input.getAttribute('contenteditable')).toBe('true');
      expect(await page.evaluate(() => ({
        html: document.getElementById('terminal-output')!.innerHTML,
        prompt: document.getElementById('input-prefix')!.textContent,
        scroll: document.querySelector<HTMLElement>('.terminal')!.scrollTop,
      }))).toEqual(before);
    };

    await enterVi();
    await page.keyboard.press('i');
    await page.keyboard.type('saved in fullscreen vi');
    await page.keyboard.press('Escape');
    await page.keyboard.type(':wq');
    await page.keyboard.press('Enter');
    await restored();
    await persistedFile(page, user.account_id, `${user.home}/vi-regression.txt`, 'saved in fullscreen vi\n');

    await enterVi();
    expect(await page.getByTestId('vi-buffer').innerText()).toContain('saved in fullscreen vi');
    await page.keyboard.press('o');
    await page.keyboard.type('discard me');
    await page.keyboard.press('Escape');
    await page.keyboard.type(':q');
    await page.keyboard.press('Enter');
    expect(await page.getByTestId('vi-command').innerText()).toContain('No write');
    await page.keyboard.type(':q!');
    await page.keyboard.press('Enter');
    await restored();
    await command(page, 'cat ~/vi-regression.txt', /\nsaved in fullscreen vi\s*$/);
    expect(await output.innerText()).not.toContain('discard me');
  });
}, 90_000);

it('executes the undocumented simulation without storing its argument', async () => {
  await withTerminal(true, async (page) => {
    await ready(page);
    await command(page, 'promote_user_to_admin', 'scoreboard');
    await command(page, 'promote_user_to_admin wrong', 'Invalid challenge token');
    await command(page, 'promote_user_to_admin ctf-only.7e19b42d.93ac608f.bundle', 'offline-bundle-flag');
    const history = await command(page, 'cat ~/.bash_history', 'cat ~/.bash_history');
    expect(history.includes('ctf-only.')).toBe(false);
    await command(page, 'lab', 'Isolated OWASP training');
    await command(page, 'lab invoice 1043', 'offline-invoice-flag');
    await command(page, 'lab profile {"role":"admin"}', 'offline-profile-flag');
    await command(page, 'lab file ../internal/release.txt', 'offline-file-flag');
  });
});

it('gates logout, isolates a second account, and restores the returning owner files', async () => {
  await withTerminal(true, async (page, session) => {
    const other = { ...user, account_id: '99', home: '/home/jane-doe-99' };
    session.homes = [user.home, other.home];
    await ready(page);
    await command(page, 'echo first-owner-secret > ~/private.txt; cat ~/private.txt', /\nfirst-owner-secret\s*$/);
    await command(page, 'echo history-owner-one', 'history-owner-one');
    await persistedFile(page, user.account_id, `${user.home}/private.txt`, 'first-owner-secret\n');
    // The earlier private-file snapshot can commit before this newer history
    // write. This test restores saved state, so observe both before navigation.
    await persistedFile(page, user.account_id, `${user.home}/.bash_history`, /^echo history-owner-one$/m);
    // Exercise the real logout command, not just a replacement /auth/me response.
    await page.locator('#terminal-input').focus();
    await page.keyboard.insertText('logout');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Sign in with Okta' }).waitFor();
    expect(session.logoutRequests).toBe(1);
    expect(session.user).toBeNull();
    expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(false);
    await reloadWithDiagnostics(page);
    await page.getByRole('button', { name: 'Sign in with Okta' }).waitFor();
    expect(await page.locator('#terminal-input-wrapper').isVisible()).toBe(false);

    session.user = other;
    await reloadWithDiagnostics(page);
    await ready(page);
    await command(page, 'pwd', other.home);
    await command(page, 'whoami', 'jane-doe-99');
    expect(await command(page, 'cat ~/.bash_history', 'whoami')).not.toContain('history-owner-one');
    expect(await page.locator('#terminal-output').innerText()).not.toContain('first-owner-secret');
    const denied = await command(page, `cat ${user.home}/private.txt`, 'Permission denied');
    expect(denied).not.toContain('first-owner-secret');
    await command(page, 'cat ~/private.txt', /No such file|not found/i);
    await command(page, `echo overwritten > ${user.home}/private.txt`, 'Permission denied');
    await command(page, 'echo second-owner-secret > ~/private.txt; cat ~/private.txt', /\nsecond-owner-secret\s*$/);
    await persistedFile(page, other.account_id, `${other.home}/private.txt`, 'second-owner-secret\n');
    await reloadWithDiagnostics(page);
    await ready(page);
    await command(page, 'cat ~/private.txt', /\nsecond-owner-secret\s*$/);

    session.user = { ...user };
    await reloadWithDiagnostics(page);
    await ready(page);
    await command(page, 'pwd', user.home);
    expect(await command(page, 'cat ~/.bash_history', 'history-owner-one')).not.toContain('second-owner-secret');
    await command(page, 'cat ~/private.txt', /\nfirst-owner-secret\s*$/);
    expect(await command(page, `cat ${other.home}/private.txt`, 'Permission denied')).not.toContain('second-owner-secret');
  });
}, 120_000);

it('migrates a persisted home to its canonical name without losing edits on later reloads', async () => {
  await withTerminal(true, async (page, session) => {
    await ready(page);
    await command(page, 'mkdir -p ~/projects/nested; echo directory-ready', /\ndirectory-ready\s*$/);
    await command(page, 'echo migration-secret > ~/projects/nested/private.txt; cat ~/projects/nested/private.txt', /\nmigration-secret\s*$/);
    await command(page, 'echo migration-notes > ~/notes.txt; cat ~/notes.txt', /\nmigration-notes\s*$/);
    await persistedFile(page, user.account_id, `${user.home}/notes.txt`, 'migration-notes\n');
    const before = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name).sort());
    session.user = { ...user, home: '/home/jane-doe' };
    session.homes = [session.user.home, '/home/another-owner'];
    // Same immutable account ID, new server-supplied home; no direct storage seeding.
    for (let reload = 0; reload < 2; reload++) {
      await reloadWithDiagnostics(page);
      await ready(page);
      await command(page, 'pwd', /\n\/home\/jane-doe\s*$/);
      await command(page, 'whoami', /\njane-doe\s*$/);
      await command(page, 'cat ~/projects/nested/private.txt', /\nmigration-secret\s*$/);
      await command(page, 'cat ~/notes.txt', /\nmigration-notes\s*$/);
      expect(await command(page, 'ls /home', 'jane-doe')).not.toContain('jane-doe-7');
      await command(page, 'cat /home/another-owner/private.txt', 'Permission denied');
      await persistedFile(page, user.account_id, '/home/jane-doe/notes.txt', 'migration-notes\n');
    }
    expect(await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name).sort())).toEqual(before);
  });
}, 90_000);
