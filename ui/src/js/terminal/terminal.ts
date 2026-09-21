import { banner, about, help } from '../config/content.js';
import { scrollToBottom } from '../handlers/utils.js';
import { login, logout, checkAuthStatus, isAuthenticated } from '../services/authService.js';
import { describeError } from '../services/api.js';
import {
  getChallenge,
  getLeaderboard,
  getMyRank,
  listChallenges,
  submitFlag,
  type Challenge,
  type LeaderboardEntry,
} from '../services/ctfService.js';
import { editorInput, openEditor, type EditorSession } from '../shell/editor.js';

// The HP-UX sandbox (Lifo + the seeded tree) is ~300 KB gzipped, so it is loaded on demand
// instead of blocking the banner. Vite splits it into its own chunk.
type ShellModule = typeof import('../shell/hpux.js');
type DrivesModule = typeof import('../shell/drives.js');
let shellModule: Promise<ShellModule> | null = null;
let drivesModule: Promise<DrivesModule> | null = null;
const shell = (): Promise<ShellModule> => (shellModule ??= import('../shell/hpux.js'));
const drives = (): Promise<DrivesModule> => (drivesModule ??= import('../shell/drives.js'));

const LEADERBOARD_SIZE = 10;
const EDITOR_PROMPT = '~ ';

let editor: EditorSession | null = null;

export function setPrompt(text: string): void {
  const prefix = document.getElementById('input-prefix');
  if (prefix) prefix.textContent = text;
}

/** Boot the HP-UX sandbox in the background and switch the prompt once it is ready. */
export async function bootShell(): Promise<void> {
  try {
    const { getSandbox, prompt } = await shell();
    const sb = await getSandbox();
    setPrompt(prompt(sb.cwd));
  } catch (error) {
    console.error('HP-UX sandbox failed to start:', error);
  }
}

export async function animateText(
  element: HTMLElement,
  text: string | null | undefined,
  delay: number = 10,
  terminalInput?: HTMLElement,
  inputPrefix?: HTMLElement,
): Promise<void> {
  if (!element) return;
    
  // Convert text to string and handle null/undefined
  const textContent = String(text || '');
    
  // Disable input during animation
  if (terminalInput) {
    terminalInput.contentEditable = 'false';
    if (inputPrefix) inputPrefix.style.display = 'none';
  }

  try {
    // Long outputs (directory listings, file dumps) appear at once instead of crawling in.
    if (textContent.length > 1500) {
      element.textContent += textContent;
      scrollToBottom();
      return;
    }
    // Calculate speed factor based on text length
    const speedFactor = textContent.length <= 50 ? 1 : textContent.length <= 100 ? 10 : 20;
    const adjustedDelay = delay / speedFactor;

    // Split the text into characters and animate
    const characters = Array.from(textContent);
    for (const char of characters) {
      element.textContent += char;
      scrollToBottom();
      await new Promise(resolve => setTimeout(resolve, adjustedDelay));
    }
  } catch (error) {
    // If animation fails, just set the text immediately
    console.error('Text animation error:', error);
    element.textContent = textContent;
  } finally {
    // Re-enable input after animation (even if there was an error)
    if (terminalInput) {
      terminalInput.contentEditable = 'true';
      if (inputPrefix) inputPrefix.style.display = 'inline';
    }
  }
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

function formatChallenges(challenges: Challenge[]): string {
  if (challenges.length === 0) {
    return '    No challenges are live yet. Check back soon.';
  }
  const byCategory = new Map<string, Challenge[]>();
  for (const c of challenges) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  const lines: string[] = [];
  for (const [category, list] of byCategory) {
    lines.push(`    [${category}]`);
    for (const c of list) {
      const mark = c.solved ? '[x]' : '[ ]';
      lines.push(`      ${mark} ${c.slug.padEnd(24)} ${String(c.points).padStart(4)} pts  ${c.title}`);
    }
    lines.push('');
  }
  lines.push('    Type `challenges <slug>` for details, `submit <slug> <flag>` to submit.');
  return lines.join('\n');
}

function formatChallenge(c: Challenge): string {
  return [
    `    ${c.title}  (${c.points} pts, ${c.category})`,
    `    ${c.solved ? 'SOLVED' : 'unsolved'} — ${c.solve_count} player(s) have solved this`,
    '',
    ...c.description.split('\n').map((l) => `    ${l}`),
    '',
    `    submit ${c.slug} <flag>`,
  ].join('\n');
}

type Align = 'left' | 'right';

interface Column {
  header: string;
  width: number;
  align: Align;
}

function truncate(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

function cell(value: string, col: Column): string {
  const text = truncate(value, col.width);
  return col.align === 'right' ? text.padStart(col.width) : text.padEnd(col.width);
}

/** Render rows as an ASCII box table indented to match the rest of the terminal output. */
function renderTable(
  columns: Column[],
  rows: string[][],
  trailingRows: string[][] = [],
  indent = '    ',
): string {
  const rule = `${indent}+${columns.map((c) => '-'.repeat(c.width + 2)).join('+')}+`;
  const gap = `${indent}|${columns.map((c) => ' '.repeat(c.width + 2)).join('|')}|`;
  const line = (values: string[]): string =>
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
  { header: 'PLAYER', width: 26, align: 'left' },
  { header: 'USERNAME', width: 28, align: 'left' },
  { header: 'SCORE', width: 6, align: 'right' },
  { header: 'SOLVES', width: 6, align: 'right' },
];

function leaderboardRow(e: LeaderboardEntry, highlight = false): string[] {
  const rank = e.rank === null ? '—' : RANK_BADGES[e.rank] ?? String(e.rank);
  return [
    rank,
    `${highlight ? '> ' : ''}${e.full_name ?? '—'}`,
    e.username,
    String(e.score),
    String(e.solves),
  ];
}

function formatLeaderboard(entries: LeaderboardEntry[], me: LeaderboardEntry | null): string {
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

async function withApi(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (error) {
    return `    ${describeError(error)}`;
  }
}

async function handleEditorLine(raw: string): Promise<string> {
  if (!editor) return '';
  const step = editorInput(editor, raw);
  let output = step.output;
  if (step.save !== undefined) {
    try {
      await (await shell()).saveFile(editor.path, step.save);
    } catch (error) {
      output = `    "${editor.path}" write failed: ${describeError(error)}`;
      editor.dirty = true;
    }
  }
  if (step.done) {
    editor = null;
    const { getSandbox, prompt } = await shell();
    setPrompt(prompt((await getSandbox()).cwd));
  }
  return output ? `${output}\n` : '';
}

async function openVi(args: string[], readOnly: boolean): Promise<string> {
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) {
    return '    vi: a file name is required on this console (vi <file>)';
  }
  const opened = await (await shell()).openForEdit(target);
  if (opened.reason && opened.content === null && opened.exists) {
    return `    vi: ${opened.reason}`;
  }
  const { session, output } = openEditor(
    opened.path,
    opened.content,
    opened.writable && !readOnly,
    opened.reason,
  );
  editor = session;
  setPrompt(EDITOR_PROMPT);
  return output;
}

export async function processCommand(inputText: string | null): Promise<string> {
  const rawLine = inputText ?? '';
  if (editor) {
    // Inside vi every line, including blank ones, belongs to the buffer.
    return `${rawLine}\n${await handleEditorLine(rawLine)}`;
  }
  const raw = rawLine.trim();
  if (!raw) return '';

  const [commandWord = '', ...args] = raw.split(/\s+/);
  const command = commandWord.toLowerCase();
  const userCommand = `${raw}\n`;
  let response: string;

  switch (command) {
    case 'help':
      response = help;
      break;
    case 'date':
      response = new Date().toLocaleString();
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
      response = await logout();
      break;
    case 'status':
      response = checkAuthStatus();
      break;
    case 'vi':
    case 'vim':
    case 'ex':
      response = await openVi(args, false);
      break;
    case 'view':
      response = await openVi(args, true);
      break;
    case 'reset-shell':
      response = await withApi(async () => {
        const { getSandbox, prompt, resetSandbox } = await shell();
        await resetSandbox();
        setPrompt(prompt((await getSandbox()).cwd));
        return '    hpux01 restored to factory image. Your files are gone.';
      });
      break;
    case 'challenges':
    case 'challenge': {
      const slug = args[0];
      response = await withApi(async () => (slug
        ? formatChallenge(await getChallenge(slug))
        : formatChallenges(await listChallenges())));
      break;
    }
    case 'submit': {
      const [slug, ...flagParts] = args;
      const flag = flagParts.join(' ');
      if (!slug || !flag) {
        response = '    Usage: submit <challenge-slug> <flag>';
        break;
      }
      response = await withApi(async () => {
        const result = await submitFlag(slug, flag);
        const prefix = result.correct ? 'CORRECT' : 'INCORRECT';
        return `    ${prefix}: ${result.message}\n    Total score: ${result.total_score} pts`;
      });
      break;
    }
    case 'leaderboard':
    case 'scoreboard':
    case 'top':
      response = await withApi(async () => {
        const [entries, mine] = await Promise.all([
          getLeaderboard(LEADERBOARD_SIZE),
          isAuthenticated() ? getMyRank() : Promise.resolve(null),
        ]);
        return formatLeaderboard(entries, mine?.entry ?? null);
      });
      break;
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
        setPrompt(prompt(run.cwd));
        return `${notice}${run.output.replace(/\n$/, '')}`;
      });
      return `${userCommand}${result}${result ? '\n' : ''}`;
    }
  }

  return `${userCommand}${response}\n`;
}
