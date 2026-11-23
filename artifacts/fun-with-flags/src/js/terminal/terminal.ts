import { banner, about, getHelp, terminalDate } from '../config/content.js';
import { showTrain } from './trainView.js';
import { showMatrix } from './matrixView.js';
import { startMatrixTest } from './idleMatrix.js';
import { autoCopyCommand } from './clipboardPreference.js';
import { openChallengeModal } from './challengeModal.js';
import { scrollToBottom } from '../handlers/utils.js';
import {
  login,
  logout,
  checkAuthStatus,
  getCurrentUser,
  getAuthenticationRevision,
  invalidateAuthentication,
  isAuthenticated,
  refreshCurrentUser,
} from '../services/authService.js';
import type { HomeRoster } from '../services/authService.js';
import { AuthRequiredError, describeError } from '../services/api.js';
import { checkMail } from '../services/mailService.js';
import {
  getUserStats,
  importUserPoints,
} from '../services/adminService.js';
import {
  getChallenge,
  getChallengeById,
  getGroupLeaderboard,
  getLeaderboard,
  getMyRank,
  listCrackingChallenges,
  listGoldChallenges,
  submitFlag,
  curlPublicUrl,
  type Challenge,
  type GroupLeaderboardEntry,
  type LeaderboardEntry,
} from '../services/ctfService.js';
import { openEditor } from '../shell/editor.js';
import { startEditorView } from './editorView.js';
import {
  beginAdventure,
  hasAdventure,
  noteShellCommand,
  playAdventure,
  recoverTerminal,
  renderShellOutput,
  resetGames,
  runFortune,
} from './games.js';
import {
  beginCreateFlag,
  beginDeleteFlag,
  beginImportChallenges,
  beginExportFlags,
  beginImportFlags,
  cancelGuidedSession,
  handleGuidedInput,
  hasGuidedSession,
} from './flagAdminState.js';
import { captureTerminalOwnership, replaceTerminalLifecycle } from './lifecycle.js';

// The HP-UX sandbox (Lifo + the seeded tree) is ~300 KB gzipped, so it is loaded on demand
// instead of blocking the banner. Vite splits it into its own chunk.
type ShellModule = typeof import('../shell/hpux.js');
type DrivesModule = typeof import('../shell/drives.js');
let shellModule: Promise<ShellModule> | null = null;
let drivesModule: Promise<DrivesModule> | null = null;
const shell = (): Promise<ShellModule> => (shellModule ??= import('../shell/hpux.js'));
const drives = (): Promise<DrivesModule> => (drivesModule ??= import('../shell/drives.js'));

const LEADERBOARD_SIZE = 10;
const GROUP_LEADERBOARD_SIZE = 100;
const SCOREBOARD_USAGE = '    Usage: scoreboard [users|groups]';
const SUBMIT_USAGE = '    Usage: submit <flag>';
const DELETE_FLAG_USAGE = '    Usage: delete_flag <flag>';

export function setPrompt(text: string): void {
  const prefix = document.getElementById('input-prefix');
  if (prefix) prefix.textContent = text;
}

/** Boot the HP-UX sandbox in the background and switch the prompt once it is ready. */
export async function bootShell(roster: HomeRoster): Promise<void> {
  replaceTerminalLifecycle();
  try {
    // Module state must never carry between identities in the same SPA lifetime.
    resetGames();
    const { configureShellIdentity, getSandbox, prompt } = await shell();
    configureShellIdentity(roster);
    const sb = await getSandbox();
    setPrompt(prompt(sb.cwd));
    const mail = await checkMail(roster.owner.account_id);
    if (mail.warning) {
      const output = document.getElementById('terminal-output');
      if (output) output.append(document.createTextNode(`\n    WARNING: ${mail.warning}\n\n`));
    }
    if (mail.delivered) {
      const output = document.getElementById('terminal-output');
      if (output) output.append(document.createTextNode('\nYou have new mail.\n\n'));
    }
  } catch (error) {
    console.error('HP-UX sandbox failed to start:', error);
    throw error;
  }
}

export async function animateText(
  element: HTMLElement,
  text: string | null | undefined,
  delay: number = 10,
  terminalInput?: HTMLElement,
  inputPrefix?: HTMLElement,
  ownsTerminal: () => boolean = captureTerminalOwnership(),
): Promise<void> {
  if (!element || !ownsTerminal()) return;
    
  // Convert text to string and handle null/undefined
  const textContent = String(text || '');
  if (/^ {4}\+[-+]+\+$/m.test(textContent)) {
    element.classList.add('terminal-table-output');
  }
    
  // Disable input during animation
  const previousEditable = terminalInput?.contentEditable;
  if (terminalInput) {
    terminalInput.contentEditable = 'false';
    if (inputPrefix) inputPrefix.style.display = 'none';
  }

  try {
    const segments = parseTerminalText(textContent);
    // Long outputs (directory listings, file dumps) appear at once instead of crawling in.
    if (textContent.length > 1500) {
      appendTerminalSegments(element, segments);
      scrollToBottom();
      return;
    }
    // Calculate speed factor based on text length
    const speedFactor = textContent.length <= 50 ? 1 : textContent.length <= 100 ? 10 : 20;
    const adjustedDelay = delay / speedFactor;

    // Split the text into characters and animate
    for (const segment of segments) {
      if (!ownsTerminal()) return;
      if (segment.challengeId !== undefined) {
        appendTerminalSegments(element, [segment]);
        scrollToBottom();
      } else {
        for (const char of Array.from(segment.text)) {
          if (!ownsTerminal()) return;
          element.appendChild(document.createTextNode(char));
          scrollToBottom();
          await new Promise(resolve => setTimeout(resolve, adjustedDelay));
        }
      }
    }
  } catch (error) {
    if (!ownsTerminal()) return;
    // If animation fails, just set the text immediately
    console.error('Text animation error:', error);
    element.textContent = textContent;
  } finally {
    // Restore the caller's state; a command may still be running between animations.
    if (terminalInput && ownsTerminal()) {
      terminalInput.contentEditable = previousEditable!;
      if (inputPrefix) inputPrefix.style.display = 'inline';
    }
  }
}

export interface TerminalTextSegment {
  text: string;
  challengeId?: number;
}

const OSC_LINK = /\x1b\]8;;([^\x07]*)\x07([\s\S]*?)\x1b\]8;;\x07/g;

/** Parse the tiny OSC-8 subset emitted by this app; all labels remain plain text. */
export function parseTerminalText(value: string): TerminalTextSegment[] {
  const segments: TerminalTextSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(OSC_LINK)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: value.slice(cursor, index) });
    const target = match[1] ?? '';
    const challengeId = /^challenge-id:([1-9]\d*)$/.exec(target);
    const text = match[2] ?? '';
    const id = challengeId ? Number(challengeId[1]) : NaN;
    segments.push(Number.isSafeInteger(id) ? { text, challengeId: id } : { text });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor) });
  return segments;
}

function appendTerminalSegments(element: HTMLElement, segments: TerminalTextSegment[]): void {
  for (const segment of segments) {
    if (segment.challengeId !== undefined) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'challenge-link';
      button.textContent = segment.text;
      button.addEventListener('click', () => {
        void openChallengeModal(segment.challengeId!, button);
      });
      element.appendChild(button);
      continue;
    }
    element.appendChild(document.createTextNode(segment.text));
  }
}

/** Render terminal control tokens without ever interpreting output as HTML. */
export function appendTerminalText(element: HTMLElement, text: string): void {
  if (/^ {4}\+[-+]+\+$/m.test(text)) {
    element.classList.add('terminal-table-output');
  }
  appendTerminalSegments(element, parseTerminalText(text));
}

async function animateMemoryCount(
  element: HTMLElement,
  targetValue: number,
  duration: number = 2000,
): Promise<void> {
  const start = performance.now();
  const startValue = 0;

  return new Promise(resolve => {
    function update(currentTime: number): void {
      const elapsed = currentTime - start;
      const progress = Math.min(elapsed / duration, 1);

      const currentValue = Math.floor(startValue + (targetValue - startValue) * progress);
      if (element.textContent) {
        element.textContent = element.textContent.replace(/\d+K/, `${currentValue}K`);
      }

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(update);
  });
}

export async function showWelcomeMessage(postLoginMessage: string | null = null): Promise<void> {
  const terminalOutput = document.getElementById('terminal-output');
  if (!terminalOutput) return;

  const newOutputLine = document.createElement('div');
  terminalOutput.appendChild(newOutputLine);

  // Split the banner into sections
  const bannerParts = banner.split('HIMEM is testing extended memory...');
  await animateText(newOutputLine, bannerParts[0]);

  // Add memory test section with proper spacing
  await animateText(newOutputLine, '\n    HIMEM is testing extended memory...\n');

  // Create container for memory lines with white-space: pre to preserve formatting
  const memLines = document.createElement('div');
  memLines.style.whiteSpace = 'pre';
  newOutputLine.appendChild(memLines);

  for (const [label, target] of [['base', 64], ['extended', 256], ['extended', 1024]] as const) {
    const line = document.createElement('span');
    line.textContent = `    > 0K ${label} memory`;
    memLines.appendChild(line);
    await animateMemoryCount(line, target);
    line.textContent += ' OK';
    memLines.appendChild(document.createTextNode('\n'));
  }

  // Continue with the rest of the banner
  const remainingBanner = (bannerParts[1] ?? '')
    .split('1024K extended memory OK')[1]
    ?.trim() ?? '';
  await animateText(newOutputLine, remainingBanner);

  if (postLoginMessage) {
    const loginLine = document.createElement('div');
    terminalOutput.appendChild(loginLine);
    await animateText(loginLine, `\n    ${postLoginMessage}\n`);
  }

  scrollToBottom();
}

export function formatChallenges(challenges: Challenge[], showCompleted = false): string {
  if (challenges.length === 0) {
    return '    No challenges are live yet. Check back soon.';
  }
  const columns: Column[] = [
    { header: 'id', width: Math.max(2, ...challenges.map(c => String(c.id).length)), align: 'right' },
    { header: 'category', width: Math.min(24, Math.max(8, ...challenges.map(c => terminalWidth(c.category)))), align: 'left' },
    { header: 'title', width: Math.min(64, Math.max(5, ...challenges.map(c => terminalWidth(c.title)))), align: 'left' },
    { header: 'points', width: Math.max(6, ...challenges.map(c => String(c.points).length)), align: 'right' },
  ];
  if (showCompleted) columns.push({ header: 'completed', width: 9, align: 'left' });
  return [
    renderTable(columns, challenges.map(c => [
      { text: String(c.id), href: `challenge-id:${c.id}` },
      c.category, { text: c.title, href: `challenge-id:${c.id}` }, String(c.points),
      ...(showCompleted ? [c.solved === true ? 'x' : ''] : []),
    ])),
    '    Select an id or title for details, or type `challenges describe <id>` / `challenges <slug>`.',
    '    submit <flag>',
  ].join('\n');
}

const GOLD_CATEGORIES = ['gold', 'owasp', 'cracking', 'talks', 'intro'];

/** Legacy combined-list formatter retained for consumers needing a single snapshot. */
export function formatAllChallenges(challenges: Challenge[]): string {
  const sections: string[] = [];
  const gold = challenges.filter(c => GOLD_CATEGORIES.includes(c.category.toLowerCase()));
  if (gold.length) sections.push('    Gold', formatChallenges(gold, true));
  const others = challenges.filter(c => !GOLD_CATEGORIES.includes(c.category.toLowerCase()));
  if (others.length) sections.push('    Other categories', formatChallenges(others));
  return sections.join('\n\n');
}

function formatChallenge(c: Challenge): string {
  const safe = (value: string) => value.replace(/\p{Cc}/gu, ' ');
  return [
    `    id: ${c.id}`,
    `    category: ${safe(c.category)}`,
    `    title: ${safe(c.title)}`,
    `    points: ${c.points}`,
    `    unique solve_count: ${c.solve_count}`,
    '',
    ...c.description.split('\n').map((l) => `    ${safe(l)}`),
    '',
    '    submit <flag>',
  ].join('\n');
}

interface SubmitCommand {
  flag: string | null;
  display: string;
}

/**
 * Parse submit separately from ordinary shell arguments. Only the single whitespace
 * character separating the command from its argument is removed; the API owns all flag
 * normalization. The returned display value is safe for terminal output and history.
 */
function parseSubmitCommand(rawLine: string): SubmitCommand {
  const command = /^\s*\S+/.exec(rawLine);
  if (!command) return { flag: null, display: 'submit' };
  const remainder = rawLine.slice(command[0].length);
  if (!remainder) return { flag: null, display: 'submit' };
  const flag = /^\s/.test(remainder) ? remainder.slice(1) : null;
  return {
    flag,
    display: flag === null || flag.length === 0 ? 'submit' : 'submit [redacted]',
  };
}

/** Return a command representation that can safely be rendered or recalled. */
export function redactSensitiveCommand(rawLine: string): string {
  const command = /^\s*(\S+)/.exec(rawLine)?.[1]?.toLowerCase();
  if (command === 'import_user_points') return 'import_user_points [redacted]';
  if (command === 'promote_user_to_admin') return 'promote_user_to_admin [redacted]';
  // Curl URLs stay usable in the transcript and in-memory arrow-key history.
  // Persistent shell history and activity metadata have separate privacy rules.
  if (command === 'import_flags' || command === 'export_flags') return command;
  if (command === 'submit') return parseSubmitCommand(rawLine).display;
  if (command === 'delete_flag') {
    const parsed = parseSubmitCommand(rawLine);
    return parsed.flag ? 'delete_flag [redacted]' : 'delete_flag';
  }
  return rawLine.trim();
}

function redactValue(value: string, secret: string): string {
  return secret ? value.split(secret).join('[redacted]') : value;
}

type Align = 'left' | 'right';

interface Column {
  header: string;
  width: number;
  align: Align;
}

interface LinkedCell {
  text: string;
  href: string;
}

type CellValue = string | LinkedCell;

function characterWidth(char: string): number {
  if (/\p{Mark}/u.test(char) || char === '\u200d' || char === '\ufe0f') return 0;
  const point = char.codePointAt(0) ?? 0;
  return (
    point >= 0x1100 && (
      point <= 0x115f || point === 0x2329 || point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0x1f300 && point <= 0x1faff)
    )
  ) ? 2 : 1;
}

export function terminalWidth(value: string): number {
  return Array.from(value).reduce((width, char) => width + characterWidth(char), 0);
}

function truncate(value: string, width: number): string {
  if (terminalWidth(value) <= width) return value;
  const ellipsis = '...';
  const target = Math.max(0, width - terminalWidth(ellipsis));
  let used = 0;
  let text = '';
  for (const char of Array.from(value)) {
    const next = characterWidth(char);
    if (used + next > target) break;
    text += char;
    used += next;
  }
  return `${text}${ellipsis}`;
}

function terminalLink(text: string, href: string): string {
  return `\x1b]8;;${href}\x07${text}\x1b]8;;\x07`;
}

function cell(value: CellValue, col: Column): string {
  const rawText = typeof value === 'string' ? value : value.text;
  const text = truncate(rawText.replace(/\p{Cc}/gu, ' '), col.width);
  const padding = ' '.repeat(Math.max(0, col.width - terminalWidth(text)));
  const content = typeof value === 'string' ? text : terminalLink(text, value.href);
  return col.align === 'right' ? `${padding}${content}` : `${content}${padding}`;
}

/** Render rows as an ASCII box table indented to match the rest of the terminal output. */
function renderTable(
  columns: Column[],
  rows: CellValue[][],
  trailingRows: CellValue[][] = [],
  indent = '    ',
): string {
  const rule = `${indent}+${columns.map((c) => '-'.repeat(c.width + 2)).join('+')}+`;
  const gap = `${indent}|${columns.map((c) => ' '.repeat(c.width + 2)).join('|')}|`;
  const line = (values: CellValue[]): string =>
    `${indent}| ${columns.map((c, i) => cell(values[i] ?? '', c)).join(' | ')} |`;
  const out = [rule, line(columns.map((c) => c.header)), rule, ...rows.map(line)];
  if (trailingRows.length > 0) {
    // Visually detach the "you are here" rows from the top-N block.
    out.push(gap, ...trailingRows.map(line));
  }
  out.push(rule);
  return out.join('\n');
}

const RANK_BADGES: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd' };

const LEADERBOARD_COLUMNS: Column[] = [
  { header: 'RANK', width: 4, align: 'right' },
  { header: 'PLAYER', width: 18, align: 'left' },
  { header: 'SCORE', width: 6, align: 'right' },
  { header: 'SOLVES', width: 6, align: 'right' },
  { header: 'Failed Attempts', width: 15, align: 'right' },
];

function leaderboardRow(e: LeaderboardEntry, highlight = false): string[] {
  const rank = e.rank === null ? '-' : RANK_BADGES[e.rank] ?? String(e.rank);
  return [
    rank,
    `${highlight ? '> ' : ''}${e.full_name?.trim() || 'Hidden User'}`,
    String(e.score),
    String(e.solves),
    String(e.failed_attempts),
  ];
}

export function formatLeaderboard(entries: LeaderboardEntry[], me: LeaderboardEntry | null): string {
  if (entries.length === 0 && !me) {
    return '    Nobody has scored yet. Be the first!';
  }
  const inTop = me !== null && entries.some((e) => e.username === me.username);
  const rows = entries.map((e) => leaderboardRow(e, me !== null && e.username === me.username));
  const trailing = me && !inTop ? [leaderboardRow(me, true)] : [];
  const table = renderTable(LEADERBOARD_COLUMNS, rows, trailing);

  let footer: string;
  if (!me) {
    footer = `    Top ${entries.length}. Log in to see where you stand.`;
  } else if (me.rank === null) {
    footer = '    You are unranked: solve a challenge to get on the board.';
  } else if (inTop) {
    footer = `    Top ${entries.length}. You are ranked #${me.rank}.`;
  } else {
    footer = `    Top ${entries.length}, plus your position (#${me.rank}).`;
  }
  return `${table}\n${footer}`;
}

function groupLeaderboardRow(entry: GroupLeaderboardEntry): string[] {
  return [
    RANK_BADGES[entry.rank] ?? String(entry.rank),
    entry.group_name,
    String(entry.score),
    String(entry.solves),
  ];
}

export function formatGroupLeaderboard(entries: GroupLeaderboardEntry[]): string {
  if (entries.length === 0) {
    return '    No groups have scored yet. Be the first!';
  }
  const groupWidth = entries.reduce(
    (width, entry) => Math.max(width, terminalWidth(entry.group_name.replace(/\p{Cc}/gu, ' '))),
    26,
  );
  const columns: Column[] = [
    { header: 'RANK', width: 4, align: 'right' },
    { header: 'GROUP', width: groupWidth, align: 'left' },
    { header: 'SCORE', width: 6, align: 'right' },
    { header: 'SOLVES', width: 6, align: 'right' },
  ];
  return renderTable(columns, entries.map(groupLeaderboardRow));
}

async function withApi(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (error) {
    return `    ${describeError(error)}`;
  }
}

type ScoreboardTarget = 'users' | 'groups';

function scoreboardTarget(args: string[]): ScoreboardTarget | null {
  if (args.length === 0) return 'users';
  if (args.length === 1 && ['users', 'groups'].includes(args[0]?.toLowerCase() ?? '')) {
    return args[0]!.toLowerCase() as ScoreboardTarget;
  }
  return null;
}

async function showLeaderboard(
  target: ScoreboardTarget, ownsTerminal: () => boolean,
): Promise<string> {
  if (!isAuthenticated()) {
    invalidateAuthentication('Please sign in to view the scoreboard.');
    return '';
  }
  const revision = getAuthenticationRevision();
  const accountId = getCurrentUser()!.account_id;
  const isCurrentSession = () => ownsTerminal() && isAuthenticated()
    && getAuthenticationRevision() === revision
    && getCurrentUser()?.account_id === accountId;
  try {
    if (target === 'groups') {
      const entries = await getGroupLeaderboard(GROUP_LEADERBOARD_SIZE);
      return isCurrentSession() ? formatGroupLeaderboard(entries) : '';
    }
    // A 401 must retire the screen immediately, even if its peer never finishes.
    // Other errors still wait for both reads so they cannot mask a later 401.
    let rejectUnauthorized!: (error: AuthRequiredError) => void;
    const unauthorized = new Promise<never>((_resolve, reject) => {
      rejectUnauthorized = reject;
    });
    const watchUnauthorized = <T>(request: Promise<T>): Promise<T> => request.catch(error => {
      if (error instanceof AuthRequiredError) rejectUnauthorized(error);
      throw error;
    });
    const [entries, mine] = await Promise.race([
      Promise.allSettled([
        watchUnauthorized(getLeaderboard(LEADERBOARD_SIZE)),
        watchUnauthorized(getMyRank()),
      ]),
      unauthorized,
    ]);
    if (!isCurrentSession()) return '';
    // Inspect both failures: a fast network/server error must not mask a later
    // expired session. Never render rankings unless both reads succeeded.
    for (const result of [entries, mine]) {
      if (result.status === 'rejected' && result.reason instanceof AuthRequiredError) {
        throw result.reason;
      }
    }
    if (entries.status === 'rejected') throw entries.reason;
    if (mine.status === 'rejected') throw mine.reason;
    return formatLeaderboard(entries.value, mine.value.entry);
  } catch (error) {
    // An old request must neither render under nor invalidate a successor session.
    if (!isCurrentSession()) return '';
    // Only leaderboard commands turn an API 401 back into the interactive auth gate.
    if (error instanceof AuthRequiredError) {
      invalidateAuthentication('Your session has expired. Sign in again to view the scoreboard.');
      return '';
    }
    return `    WARNING: Scores may be stale; previous scores remain unchanged. ${describeError(error)}`;
  }
}

async function openVi(
  args: string[], readOnly: boolean, ownsTerminal: () => boolean,
): Promise<string | null> {
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) {
    return '    vi: a file name is required on this console (vi <file>)';
  }
  const opened = await (await shell()).openForEdit(target);
  if (!ownsTerminal()) return null;
  if (opened.reason && opened.content === null && opened.exists) {
    return `    vi: ${opened.reason}`;
  }
  const session = openEditor(
    opened.path,
    opened.content,
    opened.writable && !readOnly,
    opened.reason,
  );
  startEditorView({
    session,
    save: async (content) => {
      try {
        await (await shell()).saveFile(session.path, content);
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
    close: () => undefined,
  });
  return null;
}

async function challengeCommand(args: string[]): Promise<string> {
  const slug = args[0];
  let response = await withApi(async () => {
    if (slug?.toLowerCase() === 'describe') {
      const id = args[1];
      if (args.length !== 2 || !id || !/^[1-9]\d*$/.test(id)
        || !Number.isSafeInteger(Number(id))) {
        return '    Usage: challenges describe <id>';
      }
      return formatChallenge(await getChallengeById(Number(id)));
    }
    if (slug?.toLowerCase() === 'gold') {
      return formatChallenges(await listGoldChallenges(), true);
    }
    if (slug?.toLowerCase() === 'cracking') {
      return formatChallenges(await listCrackingChallenges());
    }
    return formatChallenge(await getChallenge(slug!));
  });
  const accountId = getCurrentUser()?.account_id;
  if (accountId) {
    const mail = await checkMail(accountId);
    if (mail.delivered) response += '\nYou have new mail.';
    if (mail.warning) response += `\n    WARNING: ${mail.warning}`;
  }
  return response;
}

export async function processCommand(
  inputText: string | null, ownsTerminal = captureTerminalOwnership(),
): Promise<string> {
  if (!ownsTerminal()) return '';
  const rawLine = inputText ?? '';
  const [requestedCommand = '', ...requestedArgs] = rawLine.trim().split(/\s+/);
  const requestedCommandLower = requestedCommand.toLowerCase();
  if (!isAuthenticated()) {
    resetGames();
    cancelGuidedSession();
    if (['leaderboard', 'scoreboard', 'top'].includes(requestedCommandLower)) {
      const target = scoreboardTarget(requestedArgs);
      if (!target) return `${rawLine.trim()}\n${SCOREBOARD_USAGE}\n`;
      await showLeaderboard(target, ownsTerminal);
      return '';
    }
    return 'Please sign in using the link above to continue.';
  }
  if (hasAdventure()) {
    const raw = rawLine.trim();
    const turn = playAdventure(raw);
    if (turn.quit) {
      const { getSandbox, prompt } = await shell();
      const sandbox = await getSandbox();
      if (ownsTerminal()) setPrompt(prompt(sandbox.cwd));
    }
    return `${raw}${raw ? '\n' : ''}${turn.output}${turn.output ? '\n' : ''}`;
  }
  if (hasGuidedSession()) {
    const result = await handleGuidedInput(rawLine);
    if (!ownsTerminal()) return '';
    setPrompt(result.prompt);
    if (result.authLost) {
      invalidateAuthentication('Your session has expired. Sign in again to continue.');
      return '';
    }
    if (result.refresh) {
      try {
        await refreshCurrentUser();
      } catch (error) {
        if (!ownsTerminal()) return '';
        if (error instanceof AuthRequiredError) {
          invalidateAuthentication('Your session has expired. Sign in again to continue.');
          return '';
        }
      }
    }
    return `${result.display ? `${result.display}\n` : ''}${result.output}${result.output ? '\n' : ''}`;
  }
  const raw = rawLine.trim();
  if (!raw) return '';

  const [commandWord = '', ...args] = raw.split(/\s+/);
  const command = commandWord.toLowerCase();
  const userCommand = `${redactSensitiveCommand(rawLine)}\n`;
  let response: string;

  // History is a prompt-level event, before cd changes cwd. Never retain flag
  // submissions, admin inputs, or authentication credentials in browser storage.
  if (!/\b(?:curl|promote_user_to_admin|submit|delete_flag|create_flag|export_flags|import_flags|import_challenges|import_user_points|login|logout|passwd|su|sudo)\b/i.test(raw)
    && !/\b(?:password|passwd|secret|token|authorization|credential|api[_-]?key)\s*=/i.test(raw)) {
    await (await shell()).recordUserCommand(rawLine);
  }
  // History/shell initialization may have outlived the screen that accepted
  // the command. Do not enter a UI-owning builtin on its replacement.
  if (!ownsTerminal()) return '';

  const recovered = recoverTerminal(raw);
  if (recovered !== null) return `${userCommand}${recovered}\n`;

  switch (command) {
    case 'autocopy':
      response = autoCopyCommand(args);
      break;
    case 'lab':
      response = await withApi(async () =>
        (await import('../services/trainingService.js')).runTraining(raw.slice(commandWord.length).trim()));
      break;
    case 'promote_user_to_admin':
      response = await withApi(async () =>
        (await import('../services/legacyConsole.js')).invokeLegacyConsole(args));
      break;
    case 'adventure':
    case '/usr/games/adventure':
      if (args.length > 0) {
        response = '    Usage: adventure';
        break;
      }
      setPrompt('ADVENTURE> ');
      response = beginAdventure();
      break;
    case 'fortune':
    case '/usr/games/fortune': {
      if (args.length > 0) {
        response = '    Usage: fortune';
        break;
      }
      const { getSandbox, saveFile } = await shell();
      const sandbox = await getSandbox();
      response = await runFortune(sandbox.cwd, saveFile, (path) => sandbox.fs.exists(path));
      break;
    }
    case 'matrix_test': {
      if (args.length > 0) {
        response = '    Usage: matrix_test';
        break;
      }
      const error = await startMatrixTest();
      if (!error) return ''; // The encounter, not the command renderer, owns output.
      response = error;
      break;
    }
    case 'matrix':
      if (args.length > 0) {
        response = '    Usage: matrix';
        break;
      }
      await showMatrix(ownsTerminal);
      response = '';
      break;
    case 'sl':
      // Pipelines/redirects use the shell's bounded plain-text implementation.
      if (/[|;&<>]/.test(raw)) {
        const run = await (await shell()).runShell(raw);
        return `${userCommand}${run.output}`;
      }
      await showTrain(ownsTerminal);
      response = '';
      break;
    case 'help':
      response = getHelp(getCurrentUser());
      break;
    case 'curl': {
      const url = args[0];
      if (args.length === 1 && url === '--help') {
        response = 'Usage: curl <url>\nFetch a public HTTP(S) URL using GET and display its first 500 characters.\nOnly --help is supported; redirects and internal destinations are blocked.';
        break;
      }
      if (args.length !== 1 || !url || url.startsWith('-')) {
        response = 'this version of curl does not support any params other than --help';
        break;
      }
      try {
        response = (await curlPublicUrl(url)).output;
      } catch {
        response = '    curl: request failed or blocked. Only public HTTP(S) GET requests on default ports are supported. Redirects are not followed.';
      }
      break;
    }
    case 'date':
      response = terminalDate();
      break;
    case 'clear': {
      const terminal = document.getElementById('terminal-output');
      if (terminal) terminal.innerHTML = '';
      return '';
    }
    case 'about':
      response = about;
      break;
    case 'login':
      response = login();
      break;
    case 'logout':
      resetGames();
      cancelGuidedSession();
      response = await logout();
      break;
    case 'status':
      try {
        await refreshCurrentUser();
        response = checkAuthStatus();
      } catch (error) {
        if (!ownsTerminal()) return '';
        if (error instanceof AuthRequiredError) {
          invalidateAuthentication('Your session has expired. Sign in again to view your status.');
          return '';
        }
        response = `    ${describeError(error)}`;
      }
      break;
    case 'vi':
    case 'vim':
    case 'ex': {
      const error = await openVi(args, false, ownsTerminal);
      if (error === null) return '';
      response = error;
      break;
    }
    case 'view': {
      const error = await openVi(args, true, ownsTerminal);
      if (error === null) return '';
      response = error;
      break;
    }
    case 'reset-shell':
      resetGames();
      response = await withApi(async () => {
        const { getSandbox, prompt, resetSandbox } = await shell();
        await resetSandbox();
        const sandbox = await getSandbox();
        if (ownsTerminal()) setPrompt(prompt(sandbox.cwd));
        return '    hpux01 restored to factory image. Your files are gone.';
      });
      break;
    case 'challenges':
    case 'challenge': {
      response = await challengeCommand(args.length === 0 ? ['gold'] : args);
      break;
    }
    case 'create_flag': {
      if (args.length > 0) {
        response = '    Usage: create_flag';
        break;
      }
      const prompt = document.getElementById('input-prefix')?.textContent ?? '';
      const result = await beginCreateFlag(prompt);
      if (!ownsTerminal()) return '';
      setPrompt(result.prompt);
      if (result.authLost) {
        invalidateAuthentication('Your session has expired. Sign in again to continue.');
        return '';
      }
      response = result.output;
      break;
    }
    case 'export_flags': {
      if (args.length) {
        response = '    Usage: export_flags';
        break;
      }
      const prompt = document.getElementById('input-prefix')?.textContent ?? '';
      const result = await beginExportFlags(prompt, ownsTerminal);
      if (!ownsTerminal()) return '';
      if (result.authLost) {
        invalidateAuthentication('Your session has expired. Sign in again to continue.');
        return '';
      }
      response = result.output;
      break;
    }
    case 'import_flags': {
      if (args.length) {
        response = '    Usage: import_flags';
        break;
      }
      const prompt = document.getElementById('input-prefix')?.textContent ?? '';
      const result = await beginImportFlags(prompt, (next) => {
        if (!ownsTerminal()) return;
        setPrompt(next.prompt);
        if (next.authLost) {
          invalidateAuthentication('Your session has expired. Sign in again to continue.');
          return;
        }
        const output = document.getElementById('terminal-output');
        if (output && next.output) {
          const line = document.createElement('div');
          line.textContent = next.output;
          output.appendChild(line);
        }
      }, ownsTerminal);
      if (!ownsTerminal()) return '';
      setPrompt(result.prompt);
      if (result.authLost) {
        invalidateAuthentication('Your session has expired. Sign in again to continue.');
        return '';
      }
      response = result.output;
      break;
    }
    case 'import_user_points': {
      const actor = getCurrentUser();
      if (!actor?.groups.includes('funwithflags-admins')) {
        response = '    Access denied: import_user_points requires funwithflags-admins.';
        break;
      }
      const preview = args[0] === '--preview';
      const parts = preview ? args.slice(1) : args;
      const challenge = parts[0];
      if (!challenge || parts.length < 2 || parts.some(part => part.startsWith('--'))) {
        response = '    Usage: import_user_points [--preview] <challenge-slug> <full name or username>';
        break;
      }
      const recipient = parts.slice(1).join(' ').replace(/^(["'])(.*)\1$/, '$2');
      response = await withApi(async () => {
        const result = await importUserPoints(recipient, challenge, preview);
        if (!ownsTerminal() || getCurrentUser()?.account_id !== actor.account_id) return '';
        const field = (value: string) => value.replace(/\p{Cc}/gu, ' ');
        const who = field(result.display_name);
        const title = field(result.title);
        if (result.already_awarded) {
          return `    ${who} already received ${result.points} points for ${title}. No additional points awarded.`;
        }
        if (result.preview) {
          return `    Preview: ${who} would receive ${result.points} points for ${title}.\n`
            + '    No points awarded. Run the same command without --preview to apply personal credit.';
        }
        return `    Awarded ${result.points_awarded} points to ${who} for ${title}.\n`
          + '    Personal scoreboard updated. Historical group credit was not inferred.';
      });
      if (!response) return '';
      break;
    }
    case 'import_challenges': {
      if (args.length > 0) {
        response = '    Usage: import_challenges';
        break;
      }
      const prompt = document.getElementById('input-prefix')?.textContent ?? '';
      const result = await beginImportChallenges(prompt);
      if (!ownsTerminal()) return '';
      setPrompt(result.prompt);
      if (result.authLost) {
        invalidateAuthentication('Your session has expired. Sign in again to continue.');
        return '';
      }
      response = result.output;
      break;
    }
    case 'delete_flag': {
      const parsed = parseSubmitCommand(rawLine);
      if (parsed.flag === null || parsed.flag.length === 0) {
        response = DELETE_FLAG_USAGE;
        break;
      }
      const prompt = document.getElementById('input-prefix')?.textContent ?? '';
      const result = await beginDeleteFlag(parsed.flag, prompt);
      if (!ownsTerminal()) return '';
      setPrompt(result.prompt);
      if (result.authLost) {
        invalidateAuthentication('Your session has expired. Sign in again to continue.');
        return '';
      }
      response = result.output;
      break;
    }
    case 'submit': {
      const { flag } = parseSubmitCommand(rawLine);
      if (flag === null || flag.length === 0) {
        response = SUBMIT_USAGE;
        break;
      }
      try {
        const accountId = getCurrentUser()?.account_id;
        const result = await submitFlag(flag);
        if (!ownsTerminal()) return '';
        const prefix = result.correct ? 'CORRECT' : 'INCORRECT';
        response = redactValue(
          `    ${prefix}: ${result.message}\n    Total score: ${result.total_score} pts`,
          flag,
        );
        if (result.correct) {
          try {
            await refreshCurrentUser();
          } catch (error) {
            if (!ownsTerminal()) return '';
            if (error instanceof AuthRequiredError) {
              invalidateAuthentication('Your session has expired. Sign in again to continue.');
              return '';
            }
            response += '\n    Score refresh failed; use status to retry.';
          }
        }
        if (accountId) {
          const mail = await checkMail(accountId);
          if (mail.delivered) response += '\nYou have new mail.';
          if (mail.warning) response += `\n    WARNING: ${mail.warning}`;
        }
      } catch (error) {
        response = `    ${redactValue(describeError(error), flag)}`;
      }
      break;
    }
    case 'leaderboard':
    case 'scoreboard':
    case 'top': {
      const target = scoreboardTarget(args);
      if (!target) {
        response = SCOREBOARD_USAGE;
        break;
      }
      response = await showLeaderboard(target, ownsTerminal);
      if (!response) return '';
      break;
    }
    case 'user_stats': {
      if (!getCurrentUser()?.is_admin) {
        response = '    Access denied: user_stats is available to administrators only.';
        break;
      }
      if (args.length) {
        response = '    Usage: user_stats';
        break;
      }
      const owner = getCurrentUser()?.account_id;
      response = await withApi(async () => {
        const stats = await getUserStats();
        if (getCurrentUser()?.account_id !== owner || !getCurrentUser()?.is_admin) return '';
        return [
          '    User statistics',
          `    People who have logged in (all time): ${stats.people_logged_in}`,
          `    People with points (including scoreboard opt-outs): ${stats.people_with_points}`,
          `    Average daily unique sign-ins: ${stats.average_daily_logins.toFixed(2)}`,
          `    Period: ${stats.window_start} through ${stats.window_end} (${stats.window_days} completed days, ${stats.timezone})`,
          '    Zero-login days count. Repeated sign-ins on one day count once per person.',
        ].join('\n');
      });
      if (!response) return '';
      break;
    }
    default: {
      // Anything that is not a console built-in goes to the HP-UX sandbox.
      const result = await withApi(async () => {
        const [{ getSandbox, prompt, runShell }, { accessDrive, detectDrive, driveNotice }] =
          await Promise.all([shell(), drives()]);
        const drive = detectDrive(raw, (await getSandbox()).cwd);
        let notice = '';
        if (drive) {
          // Removable media: wait for the drive, with the appropriate racket.
          notice = `${driveNotice(drive)}\n`;
          await accessDrive(drive);
        }
        const run = await runShell(raw);
        if (!ownsTerminal()) return '';
        setPrompt(prompt(run.cwd));
        const rendered = renderShellOutput(run.output);
        if (run.exitCode === 0) noteShellCommand(raw);
        return `${notice}${rendered.replace(/\n$/, '')}`;
      });
      return `${userCommand}${result}${result ? '\n' : ''}`;
    }
  }

  return `${userCommand}${renderShellOutput(response)}\n`;
}
