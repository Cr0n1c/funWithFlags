/**
 * HP-UX 11.11 flavoured shell on top of the Lifo sandbox (`@lifo-sh/core`).
 *
 * Everything runs in the browser. The filesystem is seeded once from `tree.ts` and persisted in
 * IndexedDB, so each player gets a private copy that survives reloads. Lifo does not enforce
 * Unix permissions, so this module layers an `operator`-eye view on top: `ls -l` shows the modes
 * and owners from the tree, read commands refuse root-only files, and write commands refuse
 * directories the operator could not write to. Files the operator may not read are seeded empty,
 * so even tools we don't wrap (`sed`, `awk`, `tar`, redirects...) cannot leak their contents.
 */

import { Sandbox, type Command, type CommandContext } from '@lifo-sh/core';
import { HPUX_TREE } from './tree.js';
import { DIAG_PASSWD_RECORD, HPUX_LORE_PATHS } from './hpuxLore.js';
import { TRAIN } from './train.js';
import { testExpression } from './testExpression.js';
import { adaptShellCommands } from './commandAdapter.js';
import { enableHpuxBuiltinDispatch } from './builtinAdapter.js';
import { listIdentityGroups } from '../services/authService.js';
import { describeError } from '../services/api.js';
import type { HomeRoster } from '../services/authService.js';

export const HOST = 'hpux01';
const DEFAULT_USER = 'operator';
const DEFAULT_HOME = '/home/operator';
export let USER = DEFAULT_USER;
export let HOME = DEFAULT_HOME;
const GROUP = 'sys';
const UID = 201;
const GID = 3;
const UNAME = `HP-UX ${HOST} B.11.11 U 9000/800 1849587264 unlimited-user license`;
const SEED_MARKER = '/etc/.fwf-seed';
const ACCOUNT_MARKER = '/.fwf-account-owner';
const SEED_VERSION = 'hpux-tree-v1';
const RESERVED_HOMES = new Set(['/home/backup', '/home/operator', '/home/oracle']);
const MAX_OUTPUT = 64 * 1024;
const RUN_TIMEOUT_MS = 10_000;
const BINARY_STUB = '\u007fELF\u0001\u0002\u0001\u0008 (binary)\n';

interface Meta {
  mode: number;
  owner: string;
  group: string;
  mtime: string;
  dir: boolean;
  size?: number;
}

const META = new Map<string, Meta>();
const PERSONALIZED_HOMES = new Map<string, string>();
const ROSTER_HOMES = new Set<string>();
let ACCOUNT_KEY = 'operator';
META.set('/', { mode: 0o755, owner: 'root', group: 'sys', mtime: 'Mar 14  2003', dir: true });
for (const e of HPUX_TREE) {
  META.set(e.p, {
    mode: e.m,
    owner: e.o,
    group: e.g,
    mtime: e.mt,
    dir: e.t === 'd',
    size: e.bin ? e.size : undefined,
  });
}

// ------------------------------------------------------------------ paths & permissions

export function normalizePath(path: string, cwd: string): string {
  let p = path;
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  if (!p.startsWith('/')) p = `${cwd}/${p}`;
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function foreignHome(path: string): string | null {
  for (const home of ROSTER_HOMES) {
    if (home !== HOME && (path === home || path.startsWith(`${home}/`))) return home;
  }
  return null;
}

/** The mail spool is visible, but only the canonical account mailbox is accessible. */
function foreignMailbox(path: string): boolean {
  return path.startsWith('/var/mail/') && path !== `/var/mail/${USER}`;
}

function baseName(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

function perm(meta: Meta, bit: number, user = USER): boolean {
  if (meta.owner === user) return ((meta.mode >> 6) & bit) !== 0;
  if (meta.group === GROUP) return ((meta.mode >> 3) & bit) !== 0;
  return (meta.mode & bit) !== 0;
}

function formatMtime(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const day = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mon} ${day} ${hh}:${mm}`;
}

/** Metadata for a path: from the seeded tree, or synthesised for player-created entries. */
function metaFor(ctx: CommandContext, path: string): Meta | null {
  if (path === `/var/mail/${USER}` && ctx.vfs.exists(path)) {
    const st = ctx.vfs.stat(path);
    // The spool is never made group-readable, even when an old persisted entry exists.
    return { mode: 0o600, owner: USER, group: 'mail', mtime: formatMtime(st.mtime),
      dir: st.type === 'directory' };
  }
  const known = META.get(path);
  if (known) return known;
  if (!ctx.vfs.exists(path)) return null;
  const st = ctx.vfs.stat(path);
  const dir = st.type === 'directory';
  // Internal logging in a read-only system directory does not give the player
  // ownership of that directory's history file or permission to edit it.
  const directory = baseName(path) === '.bash_history' ? metaFor(ctx, parentOf(path)) : null;
  const historyOwner = directory
    ? (directory.owner === USER || perm(directory, 2) ? USER : directory.owner)
    : null;
  return {
    mode: dir ? 0o755 : historyOwner === USER ? 0o600 : 0o644,
    owner: historyOwner ??
      [...PERSONALIZED_HOMES].find(
        ([home]) => path === home || path.startsWith(`${home}/`),
      )?.[1] ?? USER,
    group: GROUP,
    mtime: formatMtime(st.mtime),
    dir,
  };
}

/** Base-tree entries the operator cannot read are seeded empty. */
function seededReadable(path: string): boolean {
  let p = parentOf(path);
  while (true) {
    const m = META.get(p);
    if (m && !perm(m, 1, DEFAULT_USER)) return false;
    if (p === '/') break;
    p = parentOf(p);
  }
  const m = META.get(path);
  return m ? perm(m, 4, DEFAULT_USER) : true;
}

/** Returns the ancestor directory that blocks traversal, or null if the path is reachable. */
function traverseBlocker(ctx: CommandContext, path: string): string | null {
  if (foreignMailbox(path)) return path;
  const foreign = foreignHome(path);
  if (foreign) return foreign;
  let p = parentOf(path);
  while (true) {
    const m = metaFor(ctx, p);
    if (m && !perm(m, 1)) return p;
    if (p === '/') return null;
    p = parentOf(p);
  }
}

type Access = 'ok' | 'missing' | 'denied' | 'isdir' | 'notdir';

function checkRead(ctx: CommandContext, path: string): Access {
  if (traverseBlocker(ctx, path)) return 'denied';
  const m = metaFor(ctx, path);
  if (!m) return 'missing';
  if (!perm(m, 4)) return 'denied';
  return m.dir ? 'isdir' : 'ok';
}

function checkList(ctx: CommandContext, path: string): Access {
  if (traverseBlocker(ctx, path)) return 'denied';
  const m = metaFor(ctx, path);
  if (!m) return 'missing';
  if (!m.dir) return 'notdir';
  return perm(m, 4) && perm(m, 1) ? 'ok' : 'denied';
}

/** Can the operator create/replace/delete `path`? */
function checkWrite(ctx: CommandContext, path: string): Access {
  if (path === '/') return 'denied';
  if (traverseBlocker(ctx, path)) return 'denied';
  const parent = metaFor(ctx, parentOf(path));
  if (!parent) return 'missing';
  if (!parent.dir) return 'notdir';
  const existing = metaFor(ctx, path);
  // The system spool is not writable by sys; the owner may still truncate or
  // remove an existing mailbox without gaining write access to /var/mail itself.
  if (path === `/var/mail/${USER}` && existing && !existing.dir) return 'ok';
  if (existing) return perm(existing, 2) || perm(parent, 2) ? 'ok' : 'denied';
  return perm(parent, 2) ? 'ok' : 'denied';
}

/**
 * Append server-derived notification text to this account's private browser filesystem.
 * Callers must supply the account ID captured before their request; late responses after
 * logout or a switch to another account cannot create mail in the new sandbox.
 * This does not store notification cursors and never reads or changes scoring state.
 */
export async function deliverShellMail(accountId: string, message: string): Promise<boolean> {
  if (!/^\d+$/.test(accountId) || accountId !== ACCOUNT_KEY || USER === DEFAULT_USER) return false;
  const identityVersion = shellIdentityVersion;
  const sb = await getSandbox();
  if (accountId !== ACCOUNT_KEY || identityVersion !== shellIdentityVersion) return false;
  const path = `/var/mail/${USER}`;
  const ctx = { vfs: sb.kernel.vfs, cwd: sb.cwd } as CommandContext;
  if (traverseBlocker(ctx, path) || (ctx.vfs.exists(path) && checkRead(ctx, path) !== 'ok')) {
    throw new Error('Cannot deliver mail: private mailbox is not a regular readable file.');
  }
  const previous = ctx.vfs.exists(path) ? await sb.fs.readFile(path) : '';
  if (accountId !== ACCOUNT_KEY || identityVersion !== shellIdentityVersion) return false;
  await sb.fs.writeFile(path, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${message}`);
  return true;
}

export function modeString(meta: Meta): string {
  let s = meta.dir ? 'd' : '-';
  for (const shift of [6, 3, 0]) {
    const t = (meta.mode >> shift) & 7;
    s += t & 4 ? 'r' : '-';
    s += t & 2 ? 'w' : '-';
    s += t & 1 ? 'x' : '-';
  }
  if (meta.mode & 0o4000) s = `${s.slice(0, 3)}s${s.slice(4)}`;
  if (meta.mode & 0o1000 && meta.dir) s = `${s.slice(0, 9)}t`;
  return s;
}

function readText(ctx: CommandContext, path: string): string {
  if (!ctx.vfs.exists(path)) return BINARY_STUB; // META-only device node
  return new TextDecoder().decode(ctx.vfs.readFile(path));
}

function globToRegex(glob: string, ignoreCase = false): RegExp {
  let re = '^';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`, ignoreCase ? 'i' : '');
}

// ------------------------------------------------------------------ command helpers

function splitFlags(args: string[]): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let done = false;
  for (const a of args) {
    if (!done && a === '--') {
      done = true;
    } else if (!done && a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (const f of a.slice(1)) flags.add(f);
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

function columns(names: string[], width = 80): string {
  if (names.length === 0) return '';
  const col = Math.max(...names.map((n) => n.length)) + 2;
  const perRow = Math.max(1, Math.floor(width / col));
  const rows = Math.ceil(names.length / perRow);
  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const cells: string[] = [];
    for (let c = 0; c < perRow; c += 1) {
      const n = names[r + c * rows];
      if (n !== undefined) cells.push(n.padEnd(col));
    }
    out.push(cells.join('').trimEnd());
  }
  return `${out.join('\n')}\n`;
}

const text = (fn: (ctx: CommandContext) => string | Promise<string>): Command =>
  async (ctx) => {
    ctx.stdout.write(await fn(ctx));
    return 0;
  };

// ------------------------------------------------------------------ ls

function lsColumnWidths(ctx: CommandContext, paths: string[]): { owner: number; group: number } {
  const widths = { owner: 10, group: 10 };
  for (const path of paths) {
    const m = metaFor(ctx, path);
    if (m) {
      widths.owner = Math.max(widths.owner, m.owner.length);
      widths.group = Math.max(widths.group, m.group.length);
    }
  }
  return widths;
}

function lsLongRow(
  ctx: CommandContext, path: string, name: string,
  widths: { owner: number; group: number },
): string {
  const m = metaFor(ctx, path);
  if (!m) return `${name}: not found`;
  let size = m.size;
  if (size === undefined) {
    if (m.dir) size = META.has(path) ? 8192 : 96;
    else {
      try {
        size = ctx.vfs.stat(path).size;
      } catch {
        size = 0;
      }
    }
  }
  let links = 1;
  if (m.dir) {
    try {
      links = ctx.vfs.exists(path)
        ? 2 + ctx.vfs.readdir(path).filter((d) => d.type === 'directory').length
        : 2;
    } catch {
      links = 2;
    }
  }
  return `${modeString(m)} ${String(links).padStart(3)} ${m.owner.padEnd(widths.owner)} ${m.group.padEnd(widths.group)} ${String(size).padStart(9)} ${m.mtime} ${name}`;
}

// eslint-disable-next-line @typescript-eslint/require-await
const lsCommand: Command = async (ctx) => {
  const { flags, rest } = splitFlags(ctx.args);
  const long = flags.has('l');
  const all = flags.has('a') || flags.has('A');
  const dirOnly = flags.has('d');
  const recursive = flags.has('R');
  const targets = rest.length ? rest : ['.'];
  const targetWidths = lsColumnWidths(ctx, targets.map((t) => normalizePath(t, ctx.cwd)));
  let rc = 0;
  const blocks: string[] = [];

  const listDir = (path: string, showHeader: boolean): void => {
    const access = checkList(ctx, path);
    if (access === 'denied') {
      ctx.stderr.write(`${path}: Permission denied\n`);
      rc = 2;
      return;
    }
    const fromVfs = ctx.vfs.exists(path) ? ctx.vfs.readdir(path).map((d) => d.name) : [];
    const prefix = path === '/' ? '/' : `${path}/`;
    const fromMeta = [...META.keys()]
      .filter((k) => k.startsWith(prefix) && k !== path && !k.slice(prefix.length).includes('/'))
      .map((k) => k.slice(prefix.length));
    let names = [...new Set([...fromVfs, ...fromMeta])]
      .filter((n) => n !== baseName(SEED_MARKER) && `${prefix}${n}` !== ACCOUNT_MARKER)
      .filter((n) => !foreignMailbox(`${prefix}${n}`))
      .sort();
    if (!all) names = names.filter((n) => !n.startsWith('.'));
    else if (flags.has('a')) names = ['.', '..', ...names];
    const join = (n: string): string => (n === '.' ? path : n === '..' ? parentOf(path) : `${path === '/' ? '' : path}/${n}`);
    let body: string;
    if (long) {
      const widths = lsColumnWidths(ctx, names.map(join));
      const rows = names.map((n) => lsLongRow(ctx, join(n), n, widths));
      body = `total ${names.length * 2}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
    } else {
      body = columns(names.map((n) => (flags.has('F') && metaFor(ctx, join(n))?.dir ? `${n}/` : n)));
    }
    blocks.push(showHeader ? `${path}:\n${body}` : body);
    if (recursive) {
      for (const n of names) {
        if (n === '.' || n === '..') continue;
        const child = join(n);
        if (metaFor(ctx, child)?.dir) listDir(child, true);
      }
    }
  };

  for (const t of targets) {
    const path = normalizePath(t, ctx.cwd);
    if (traverseBlocker(ctx, path)) {
      ctx.stderr.write(`${t}: Permission denied\n`);
      rc = 2;
      continue;
    }
    const m = metaFor(ctx, path);
    if (!m) {
      ctx.stderr.write(`${t} not found\n`);
      rc = 2;
      continue;
    }
    if (!m.dir || dirOnly) {
      blocks.push(long ? `${lsLongRow(ctx, path, t, targetWidths)}\n` : `${t}\n`);
      continue;
    }
    listDir(path, targets.length > 1 || recursive);
  }
  ctx.stdout.write(blocks.join('\n'));
  return rc;
};

// ------------------------------------------------------------------ readers

function readGuarded(ctx: CommandContext, cmd: string, arg: string): string | null {
  const path = normalizePath(arg, ctx.cwd);
  switch (checkRead(ctx, path)) {
    case 'missing':
      ctx.stderr.write(`${cmd}: Cannot open ${arg}: No such file or directory\n`);
      return null;
    case 'denied':
      ctx.stderr.write(`${cmd}: Cannot open ${arg}: Permission denied\n`);
      return null;
    case 'isdir':
      ctx.stderr.write(`${cmd}: read error on ${arg}: Is a directory\n`);
      return null;
    default:
      return readText(ctx, path);
  }
}

const catLike =
  (cmd: string, pager: boolean): Command =>
  async (ctx) => {
    const { rest } = splitFlags(ctx.args);
    if (rest.length === 0) {
      ctx.stdout.write((await ctx.stdin?.readAll()) ?? '');
      return 0;
    }
    let rc = 0;
    for (const arg of rest) {
      const content = readGuarded(ctx, cmd, arg);
      if (content === null) {
        rc = 2;
        continue;
      }
      if (pager && rest.length > 1) ctx.stdout.write(`::::::::::::::\n${arg}\n::::::::::::::\n`);
      ctx.stdout.write(content.endsWith('\n') || content === '' ? content : `${content}\n`);
    }
    return rc;
  };

const headTail =
  (cmd: 'head' | 'tail'): Command =>
  async (ctx) => {
    let n = 10;
    const files: string[] = [];
    for (let i = 0; i < ctx.args.length; i += 1) {
      const a = ctx.args[i] ?? '';
      if (a === '-n') n = Number(ctx.args[++i] ?? 10);
      else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
      else if (a.startsWith('-n')) n = Number(a.slice(2));
      else if (!a.startsWith('-')) files.push(a);
    }
    const pick = (s: string): string => {
      const lines = s.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const chosen = cmd === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n));
      return chosen.length ? `${chosen.join('\n')}\n` : '';
    };
    if (files.length === 0) {
      ctx.stdout.write(pick((await ctx.stdin?.readAll()) ?? ''));
      return 0;
    }
    let rc = 0;
    for (const f of files) {
      const content = readGuarded(ctx, cmd, f);
      if (content === null) {
        rc = 2;
        continue;
      }
      if (files.length > 1) ctx.stdout.write(`==> ${f} <==\n`);
      ctx.stdout.write(pick(content));
    }
    return rc;
  };

// eslint-disable-next-line @typescript-eslint/require-await
const stringsCommand: Command = async (ctx) => {
  const { rest } = splitFlags(ctx.args);
  let rc = 0;
  for (const f of rest) {
    const content = readGuarded(ctx, 'strings', f);
    if (content === null) {
      rc = 2;
      continue;
    }
    const runs = content.match(/[\x20-\x7e]{4,}/g) ?? [];
    ctx.stdout.write(runs.length ? `${runs.join('\n')}\n` : '');
  }
  return rc;
};

// ------------------------------------------------------------------ grep

const grepCommand: Command = async (ctx) => {
  const opts = new Set<string>();
  const positional: string[] = [];
  let pattern: string | null = null;
  for (let i = 0; i < ctx.args.length; i += 1) {
    const a = ctx.args[i] ?? '';
    if (a === '-e' && ctx.args[i + 1] !== undefined) {
      pattern = ctx.args[++i] ?? '';
    } else if (a.startsWith('-') && a.length > 1) {
      for (const f of a.slice(1)) opts.add(f);
    } else if (pattern === null) {
      pattern = a;
    } else {
      positional.push(a);
    }
  }
  if (pattern === null) {
    ctx.stderr.write('Usage: grep [-E] [-c|-l|-q] [-insvwx] pattern [file...]\n');
    return 2;
  }
  let re: RegExp;
  try {
    const body = opts.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    re = new RegExp(opts.has('w') ? `\\b(?:${body})\\b` : body, opts.has('i') ? 'i' : '');
  } catch {
    ctx.stderr.write(`grep: RE error in ${pattern}\n`);
    return 2;
  }
  const invert = opts.has('v');
  const files: string[] = [];
  const expand = (arg: string, shown: string): void => {
    const path = normalizePath(arg, ctx.cwd);
    const m = metaFor(ctx, path);
    if (m?.dir && opts.has('r')) {
      if (!(perm(m, 4) && perm(m, 1))) {
        ctx.stderr.write(`grep: can't open ${shown}\n`);
        return;
      }
      const prefix = path === '/' ? '/' : `${path}/`;
      const names = new Set([
        ...(ctx.vfs.exists(path) ? ctx.vfs.readdir(path).map((d) => d.name) : []),
        ...[...META.keys()]
          .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map((k) => k.slice(prefix.length)),
      ]);
      for (const n of [...names].sort()) {
        if (`${prefix}${n}` !== SEED_MARKER && !foreignMailbox(`${prefix}${n}`)) {
          expand(`${prefix}${n}`, `${shown.replace(/\/$/, '')}/${n}`);
        }
      }
      return;
    }
    files.push(shown);
  };
  for (const arg of positional) expand(arg, arg);
  const many = files.length > 1 || (opts.has('r') && positional.length > 0);
  let matchedAny = false;
  let rc = 0;
  const scan = (content: string, label: string | null): void => {
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let count = 0;
    lines.forEach((line, idx) => {
      if (re.test(line) === invert) return;
      count += 1;
      matchedAny = true;
      if (opts.has('c') || opts.has('l') || opts.has('q')) return;
      const tag = label !== null && many ? `${label}:` : '';
      const num = opts.has('n') ? `${idx + 1}:` : '';
      ctx.stdout.write(`${tag}${num}${line}\n`);
    });
    if (opts.has('c')) ctx.stdout.write(`${label !== null && many ? `${label}:` : ''}${count}\n`);
    if (opts.has('l') && count > 0 && label !== null) ctx.stdout.write(`${label}\n`);
  };
  if (files.length === 0) {
    scan((await ctx.stdin?.readAll()) ?? '', null);
  } else {
    for (const f of files) {
      const path = normalizePath(f, ctx.cwd);
      const access = checkRead(ctx, path);
      if (access === 'ok') scan(readText(ctx, path), f);
      else if (access === 'isdir') ctx.stderr.write(`grep: ${f}: Is a directory\n`);
      else if (access === 'denied') {
        ctx.stderr.write(`grep: ${f}: Permission denied\n`);
        rc = 2;
      } else {
        ctx.stderr.write(`grep: can't open ${f}\n`);
        rc = 2;
      }
    }
  }
  return rc || (matchedAny ? 0 : 1);
};

// ------------------------------------------------------------------ find

// eslint-disable-next-line @typescript-eslint/require-await
const findCommand: Command = async (ctx) => {
  const paths: string[] = [];
  let i = 0;
  while (i < ctx.args.length && !ctx.args[i]!.startsWith('-')) paths.push(ctx.args[i++]!);
  if (paths.length === 0) paths.push('.');
  let namePat: RegExp | null = null;
  let type: 'f' | 'd' | null = null;
  let maxDepth = Infinity;
  for (; i < ctx.args.length; i += 1) {
    const a = ctx.args[i];
    const v = ctx.args[i + 1];
    if ((a === '-name' || a === '-iname') && v !== undefined) {
      namePat = globToRegex(v, a === '-iname');
      i += 1;
    } else if (a === '-type' && v !== undefined) {
      type = v === 'd' ? 'd' : 'f';
      i += 1;
    } else if (a === '-maxdepth' && v !== undefined) {
      maxDepth = Number(v);
      i += 1;
    } else if (a === '-exec' || a === '-delete' || a === '-ok') {
      ctx.stderr.write(`find: ${a} is not supported on this system\n`);
      return 1;
    } else if (a === '-print' || a === '-print0') {
      // default behaviour
    } else if (a === '-mtime' || a === '-newer' || a === '-user' || a === '-perm' || a === '-size') {
      i += 1; // accepted and ignored, like a very forgiving find
    } else {
      ctx.stderr.write(`find: bad option ${a}\n`);
      return 1;
    }
  }
  let rc = 0;
  const visit = (path: string, shown: string, depth: number): void => {
    const m = metaFor(ctx, path);
    if (!m) return;
    const matches = (!type || (type === 'd') === m.dir) && (!namePat || namePat.test(baseName(path)));
    if (matches) ctx.stdout.write(`${shown}\n`);
    if (!m.dir || depth >= maxDepth) return;
    if (!(perm(m, 4) && perm(m, 1))) {
      ctx.stderr.write(`find: cannot open ${shown}: Permission denied\n`);
      rc = 1;
      return;
    }
    const prefix = path === '/' ? '/' : `${path}/`;
    const fromVfs = ctx.vfs.exists(path) ? ctx.vfs.readdir(path).map((d) => d.name) : [];
    const fromMeta = [...META.keys()]
      .filter((k) => k.startsWith(prefix) && k !== path && !k.slice(prefix.length).includes('/'))
      .map((k) => k.slice(prefix.length));
    for (const name of [...new Set([...fromVfs, ...fromMeta])].sort()) {
      const child = `${prefix}${name}`;
      if (child === SEED_MARKER || foreignMailbox(child)) continue;
      visit(child, `${shown === '/' ? '' : shown}/${name}`, depth + 1);
    }
  };
  for (const p of paths) {
    const path = normalizePath(p, ctx.cwd);
    if (!metaFor(ctx, path) || traverseBlocker(ctx, path)) {
      ctx.stderr.write(`find: cannot access ${p}: No such file or directory\n`);
      rc = 1;
      continue;
    }
    visit(path, p.replace(/\/+$/, '') || '/', 0);
  }
  return rc;
};

// ------------------------------------------------------------------ guarded wrappers around Lifo originals

const DELEGATED_READ_TOOLS = [
  'wc', 'sort', 'cut', 'sed', 'awk', 'diff', 'nl', 'file', 'du', 'tr', 'uniq', 'rev', 'tar',
  'gzip', 'gunzip',
];
const DELEGATED_WRITE_TOOLS = ['rm', 'rmdir', 'touch', 'mkdir', 'chmod', 'chown', 'ln', 'tee'];
const DELEGATED_COPY_TOOLS = ['cp', 'mv'];

/**
 * Wrap an original Lifo command so file arguments are permission-checked first.
 *
 * Read tools get the readable files' contents on stdin instead of as paths: Lifo decides
 * "binary" from the file extension, so `wc /etc/passwd` would otherwise be skipped. Positional
 * arguments that are not files (an awk program, a sed script) are passed through untouched.
 */
function guarded(originals: Map<string, Command>, name: string, mode: 'read' | 'write' | 'copy'): Command {
  return async (ctx) => {
    const original = originals.get(name);
    if (!original) {
      ctx.stderr.write(`bash: ${name}:  not found.\n`);
      return 127;
    }
    const positional = ctx.args.filter((a) => !a.startsWith('-') || a === '-');
    const drop = new Set<string>();
    let rc = 0;
    let piped = '';
    let pipedAny = false;

    positional.forEach((arg, idx) => {
      const path = normalizePath(arg, ctx.cwd);
      const isTarget = mode === 'copy' && idx === positional.length - 1 && positional.length > 1;
      if (mode === 'write' || isTarget) {
        if (checkWrite(ctx, path) === 'denied') {
          ctx.stderr.write(`${name}: ${arg}: Permission denied\n`);
          drop.add(arg);
          rc = 1;
        }
        return;
      }
      const access = checkRead(ctx, path);
      if (access === 'denied') {
        ctx.stderr.write(`${name}: ${arg}: Permission denied\n`);
        drop.add(arg);
        rc = mode === 'read' ? 2 : 1;
      } else if (mode === 'read' && access === 'ok') {
        piped += readText(ctx, path);
        pipedAny = true;
        drop.add(arg);
      }
    });

    if (rc && !pipedAny) return rc; // something was refused and nothing readable remains
    const args = ctx.args.filter((a) => !drop.has(a));
    const stdin = pipedAny
      ? {
          read: (): Promise<string | null> => Promise.resolve(null),
          readAll: (): Promise<string> => Promise.resolve(piped),
        }
      : ctx.stdin;
    const inner = await original({ ...ctx, args, stdin });
    return rc || inner;
  };
}

// ------------------------------------------------------------------ system flavour

const idCommand = text(() => `uid=${UID}(${USER}) gid=${GID}(${GROUP}) groups=${GID}(${GROUP})\n`);

const unameCommand = text((ctx) => {
  const { flags } = splitFlags(ctx.args);
  if (flags.has('a')) return `${UNAME}\n`;
  const parts: string[] = [];
  if (flags.has('s') || flags.size === 0) parts.push('HP-UX');
  if (flags.has('n')) parts.push(HOST);
  if (flags.has('r')) parts.push('B.11.11');
  if (flags.has('v')) parts.push('U');
  if (flags.has('m')) parts.push('9000/800');
  if (flags.has('i')) parts.push('1849587264');
  return `${parts.join(' ')}\n`;
});

const bdfCommand = text(
  () => `Filesystem          kbytes    used   avail %used Mounted on
/dev/vg00/lvol3     204800  118432   85704   58% /
/dev/vg00/lvol1     298928   45120  223904   17% /stand
/dev/vg00/lvol8    2097152 1404992  686784   67% /var
/dev/vg00/lvol7    1835008 1311200  519616   72% /usr
/dev/vg00/lvol4     524288   12048  508176    2% /tmp
/dev/vg00/lvol6    1048576  702304  343536   67% /opt
/dev/vg00/lvol5     524288   86416  434480   17% /home
oradb01:/export/dumps
                  16777216 9834496 6511616   60% /dumps
`,
);

const swlistCommand = text(
  () => `# Initializing...
# Contacting target "${HOST}"...
#
# Target:  ${HOST}:/
#

#
# Bundle(s):
#

  B3901BA               B.11.11.06     HP C/ANSI C Developer's Bundle for HP-UX 11.i
  B3913DB               C.03.25        HP aC++ Compiler (S800)
  B6848BA               1.4.gm.46.9    Ximian GNOME 1.4 GTK+ Libraries for HP-UX
  B8339BA               B.11.11        HP-UX Installation Utilities (Ignite-UX)
  B9073BA               B.11.11.0206   HP-UX iCOD (Instant Capacity on Demand)
  BUNDLE11i             B.11.11.0102.2 Required Patch Bundle for HP-UX 11i, February 2001
  GOLDAPPS11i           B.11.11.0306.4 Gold Applications Patches for HP-UX 11i v1, June 2003
  GOLDBASE11i           B.11.11.0306.4 Gold Base Patches for HP-UX 11i v1, June 2003
  HPUX11i-OE            B.11.11        HP-UX 11i Operating Environment Component
  HPUXBase64            B.11.11        HP-UX 64-bit Base OS
  T1471AA               A.03.10.002    HP-UX Secure Shell
  UnlimitedUserLic      B.11.11        HP-UX Unlimited-User License
`,
);

const whoCommand = text(
  () => `root       console      Mar 14 07:42
operator   pts/0        Mar 14 09:12    (10.42.9.31)
oracle     pts/1        Mar 14 07:43
`,
);

const uptimeCommand = text(() => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `  ${hh}:${mm}  up 11 days,  7:12,  4 users,  load average: 0.21, 0.18, 0.12\n`;
});

const psCommand = text(
  () => `     UID   PID  PPID  C    STIME TTY       TIME COMMAND
    root     0     0  0  Mar 10  ?         0:31 swapper
    root     1     0  0  Mar 10  ?         0:04 init
    root     8     0  0  Mar 10  ?         0:00 supsched
    root   482     1  0  Mar 10  ?         0:02 /usr/sbin/inetd
    root   611     1  0  Mar 10  ?         0:14 /opt/ssh/sbin/sshd
    root   702     1  0  Mar 10  ?         0:03 /usr/sbin/syslogd -D
    root  1402     1  0  Mar 10  ?         0:00 /usr/sbin/cron
  oracle  1877     1  0  Mar 10  ?         2:11 /opt/oracle/product/8.1.7/bin/tnslsnr LISTENER
  oracle  1902     1  0  Mar 10  ?        11:48 ora_pmon_FIN
  oracle  1904     1  0  Mar 10  ?        24:03 ora_dbw0_FIN
    root  2211     1  0  Mar 14  ?         0:00 /usr/sbin/sam
operator  3011   611  0 09:12:08 pts/0     0:00 -sh
operator  3187  3011  1 09:41:22 pts/0     0:00 ps -ef
`,
);

const ioscanCommand = text(
  () => `H/W Path        Class       Description
=========================================================
                bc
0               bc          Local PCI Bus Adapter (782)
0/0/0/0         lan         HP PCI 10/100Base-TX Core
0/0/1/0         ext_bus     SCSI C895 Ultra Wide LVD
0/0/1/0.5.0     disk        SEAGATE ST318404LC
0/0/1/0.6.0     disk        SEAGATE ST318404LC
0/0/2/0         ext_bus     SCSI C875 Ultra Wide Single-Ended
0/0/2/0.3.0     tape        HP C1537A
0/0/4/0         tty         PCI Serial (103c1048)
8               processor   Processor
10              processor   Processor
`,
);

const lanscanCommand = text(
  () => `Hardware Station        Crd Hdw   Net-Interface  NM  MAC       HP-DLPI DLPI
Path     Address         In# State NamePPA        ID  Type      Support Mjr#
0/0/0/0  0x00306E0C1D2A  0   UP    lan0 snap0     1   ETHER     Yes     119
`,
);

const modelCommand = text(() => '9000/800/rp5470\n');

// eslint-disable-next-line @typescript-eslint/require-await
const getconfCommand: Command = async (ctx) => {
  if (ctx.args.length === 1 && ctx.args[0] === 'KERNEL_BITS') {
    ctx.stdout.write('64\n');
    return 0;
  }
  ctx.stderr.write(`getconf: ${ctx.args[0] ?? ''}: Invalid argument\n`);
  return 1;
};

const machinfoCommand = text(
  () => `CPU info:
   Number of CPUs = 2
   Clock speed = 750 MHz
   PA-RISC 2.0 processors (PA-8700)
   64-bit capable

Memory: 4096 MB
System model: 9000/800/rp5470

Compatibility note: hardware inventory is simulated by the hpux01 training sandbox.
`,
);

// eslint-disable-next-line @typescript-eslint/require-await
const fingerCommand: Command = async (ctx) => {
  const login = ctx.args.find((arg) => !arg.startsWith('-')) ?? USER;
  if (login === 'operator') {
    ctx.stdout.write(`Login name: operator                 In real life: Console Operator
Directory: /home/operator             Shell: /usr/bin/sh
Last login Thu May 14 03:12 on pts/2
Plan:
Remember to remove the diagnostic account.
`);
    return 0;
  }
  if (login === 'diag') {
    ctx.stdout.write(`Login name: diag                     In real life: Diagnostics Service Account
Directory: /usr/diag                  Shell: /usr/bin/ksh
Last login Thu May 14 03:11 on pts/7
No Plan.
`);
    return 0;
  }
  ctx.stderr.write(`finger: ${login}: no such user\n`);
  return 1;
};

const lastCommand = text((ctx) => {
  const login = ctx.args.find((arg) => !arg.startsWith('-'));
  if (login === 'diag') {
    return 'diag       pts/7        May 14 03:11 - 03:16  (00:05)\n';
  }
  if (login) return '';
  return `root       console      May 14 03:17   still logged in
operator   pts/2        May 14 03:12   still logged in
diag       pts/7        May 14 03:11 - 03:16  (00:05)
backup     pts/4        May 14 02:58 - 03:06  (00:08)
reboot     system boot  May 14 02:47
`;
});

const denied =
  (msg: string, code = 1): Command =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (ctx) => {
    ctx.stderr.write(`${msg}\n`);
    return code;
  };

// eslint-disable-next-line @typescript-eslint/require-await
const manCommand: Command = async (ctx) => {
  const topic = ctx.args.find((a) => !a.startsWith('-'));
  if (!topic) {
    ctx.stderr.write('Usage: man [-] [-M path] [-T macro-package] [ section ] name ...\n');
    return 1;
  }
  ctx.stderr.write(`No manual entry for ${topic}.\n`);
  return 1;
};

// ------------------------------------------------------------------ sandbox lifecycle

let sandboxPromise: Promise<Sandbox> | null = null;
let shellIdentityVersion = 0;

/**
 * Select the Unix identity used by the next sandbox boot.
 *
 * Authentication calls this before any shell API is used. Clearing the cached sandbox also makes
 * an identity change between sessions safe: a new shell receives the new environment and starts
 * in its own home rather than inheriting the previous user's cwd.
 */
export function configureShellIdentity(roster: HomeRoster): void {
  const validHome = (home: string): boolean => /^\/home\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(home);
  const homes = roster.entries.map((entry) => entry.home);
  if (!/^\d+$/.test(roster.owner.account_id)
    || !validHome(roster.owner.home)
    || homes.filter((home) => home === roster.owner.home).length !== 1
    || homes.some((home) => !validHome(home) || RESERVED_HOMES.has(home))
    || new Set(homes).size !== homes.length) {
    throw new Error('Invalid home roster returned by the server.');
  }
  const username = baseName(roster.owner.home);
  const identityChanged = roster.owner.account_id !== ACCOUNT_KEY || roster.owner.home !== HOME;
  ACCOUNT_KEY = roster.owner.account_id;
  USER = username;
  HOME = roster.owner.home;
  ROSTER_HOMES.clear();
  roster.entries.forEach((entry) => ROSTER_HOMES.add(entry.home));
  PERSONALIZED_HOMES.set(HOME, USER);
  if (identityChanged) {
    shellIdentityVersion++;
    sandboxPromise = null;
  }
}

/** Lifo provides /dev and /proc itself; our device nodes live only in META and are overlaid. */
const VIRTUAL_ROOTS = ['/dev', '/proc'];
const isVirtual = (path: string): boolean =>
  VIRTUAL_ROOTS.some((r) => path === r || path.startsWith(`${r}/`));

async function seed(sb: Sandbox): Promise<void> {
  for (const entry of await sb.fs.readdir('/')) {
    if (isVirtual(`/${entry.name}`)) continue;
    try {
      await sb.fs.rm(`/${entry.name}`, { recursive: true });
    } catch {
      // mounts may refuse; that is fine
    }
  }
  const dirs = HPUX_TREE.filter((e) => e.t === 'd' && !isVirtual(e.p)).sort(
    (a, b) => a.p.length - b.p.length,
  );
  for (const d of dirs) {
    try {
      await sb.fs.mkdir(d.p, { recursive: true });
    } catch {
      // already present
    }
  }
  for (const f of HPUX_TREE) {
    if (f.t !== 'f' || isVirtual(f.p)) continue;
    const content = f.bin ? BINARY_STUB : seededReadable(f.p) ? (f.c ?? '') : '';
    try {
      await sb.fs.writeFile(f.p, content);
    } catch (error) {
      console.warn(`seed: could not write ${f.p}`, error);
    }
  }
  await sb.fs.writeFile(SEED_MARKER, SEED_VERSION);
}

async function copyMissingHomeEntries(
  sb: Sandbox,
  source: string,
  destination: string,
): Promise<void> {
  for (const entry of await sb.fs.readdir(source)) {
    const src = `${source}/${entry.name}`;
    const dest = `${destination}/${entry.name}`;
    if (entry.type === 'directory') {
      if (!(await sb.fs.exists(dest))) await sb.fs.mkdir(dest, { recursive: true });
      await copyMissingHomeEntries(sb, src, dest);
    } else if (!(await sb.fs.exists(dest))) {
      await sb.fs.writeFile(dest, await sb.fs.readFile(src, null));
    }
  }
}

async function applyPersonalizedMetadata(sb: Sandbox, path: string): Promise<void> {
  const operatorPath = `${DEFAULT_HOME}${path.slice(HOME.length)}`;
  const original = META.get(operatorPath);
  const stat = await sb.fs.stat(path);
  META.set(path, {
    mode: original?.mode ?? (stat.type === 'directory' ? 0o755 : 0o644),
    owner: USER,
    group: original?.group ?? GROUP,
    mtime: original?.mtime ?? formatMtime(stat.mtime),
    dir: stat.type === 'directory',
    size: original?.size,
  });
  if (stat.type === 'directory') {
    for (const entry of await sb.fs.readdir(path)) {
      await applyPersonalizedMetadata(sb, `${path}/${entry.name}`);
    }
  }
}

/** Add only missing home entries, leaving both persisted edits and historical fixture data intact. */
async function ensurePersonalizedHome(sb: Sandbox): Promise<void> {
  if (USER === DEFAULT_USER) return;
  for (const sample of ['jsmith', 'mchen']) {
    const oldPath = `/home/${sample}`;
    if (await sb.fs.exists(oldPath)) {
      let quarantine = `/.fwf-legacy-fixtures/${sample}`;
      await sb.fs.mkdir('/.fwf-legacy-fixtures', { recursive: true });
      if (await sb.fs.exists(quarantine)) quarantine += '-additional';
      if (!(await sb.fs.exists(quarantine))) await sb.fs.rename(oldPath, quarantine);
    }
  }
  if (await sb.fs.exists('/home/user')
    && (await sb.fs.readdir('/home/user')).length === 0) {
    await sb.fs.rm('/home/user');
  }
  for (const home of ROSTER_HOMES) {
    PERSONALIZED_HOMES.set(home, baseName(home));
    if (!(await sb.fs.exists(home))) await sb.fs.mkdir(home, { recursive: true });
    META.set(home, {
      mode: 0o700,
      owner: baseName(home),
      group: GROUP,
      mtime: formatMtime((await sb.fs.stat(home)).mtime),
      dir: true,
    });
  }
  PERSONALIZED_HOMES.set(HOME, USER);
  if (!(await sb.fs.exists(HOME))) await sb.fs.mkdir(HOME, { recursive: true });
  await copyMissingHomeEntries(sb, DEFAULT_HOME, HOME);
  await applyPersonalizedMetadata(sb, HOME);
  META.set(HOME, { ...META.get(HOME)!, mode: 0o700, owner: USER });
}

/**
 * Move an account's old canonical home after a server-side rename.
 *
 * The marker and the account-scoped IndexedDB together are the ownership evidence. Never merge:
 * a destination of the same name may contain unrelated data, so any collision stops boot without
 * changing either tree or marker.
 */
export async function migrateCanonicalHome(sb: Sandbox): Promise<void> {
  if (!(await sb.fs.exists(ACCOUNT_MARKER))) return;
  let previous: { accountId?: unknown; home?: unknown };
  try {
    previous = JSON.parse(await sb.fs.readFile(ACCOUNT_MARKER)) as {
      accountId?: unknown;
      home?: unknown;
    };
  } catch (error) {
    throw new Error('Home migration stopped: the ownership marker is unreadable or invalid.', {
      cause: error,
    });
  }
  if (previous.accountId !== ACCOUNT_KEY) {
    throw new Error('Home migration stopped: the ownership marker belongs to another account.');
  }
  if (typeof previous.home !== 'string'
    || !/^\/home\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(previous.home)) {
    throw new Error('Home migration stopped: the ownership marker contains an invalid home.');
  }
  if (previous.home === HOME) return;
  if (!(await sb.fs.exists(previous.home))) {
    throw new Error(`Home migration stopped: the marked source ${previous.home} is missing.`);
  }
  if (await sb.fs.exists(HOME)) {
    throw new Error(`Home migration stopped: destination ${HOME} already exists.`);
  }
  try {
    await sb.fs.rename(previous.home, HOME);
  } catch (error) {
    throw new Error(`Home migration failed while moving ${previous.home} to ${HOME}.`, {
      cause: error,
    });
  }
  try {
    // Commit the marker immediately so a later boot never mistakes a completed rename for loss.
    await sb.fs.writeFile(ACCOUNT_MARKER, JSON.stringify({ accountId: ACCOUNT_KEY, home: HOME }));
  } catch (error) {
    throw new Error('Home migration failed while saving the ownership marker.', { cause: error });
  }
}

async function removePersistedSampleAccounts(sb: Sandbox): Promise<void> {
  const accountFiles = ['/etc/passwd', '/etc/shadow', '/.secure/etc/passwd'];
  for (const path of accountFiles) {
    if (!(await sb.fs.exists(path))) continue;
    const content = await sb.fs.readFile(path);
    const filtered = content.split('\n')
      .filter((line) => !line.startsWith('jsmith:') && !line.startsWith('mchen:'))
      .join('\n');
    if (filtered !== content) await sb.fs.writeFile(path, filtered);
  }
  if (await sb.fs.exists('/etc/group')) {
    const content = await sb.fs.readFile('/etc/group');
    const filtered = content.split('\n').map((line) => {
      if (!line.startsWith('users:')) return line;
      const fields = line.split(':');
      fields[3] = (fields[3] ?? '').split(',')
        .filter((member) => member !== 'jsmith' && member !== 'mchen')
        .join(',');
      return fields.join(':');
    }).join('\n');
    if (filtered !== content) await sb.fs.writeFile('/etc/group', filtered);
  }
  const oldCrontab = '/var/spool/cron/crontabs/jsmith';
  if (await sb.fs.exists(oldCrontab)) {
    await sb.fs.mkdir('/.fwf-legacy-fixtures/crontabs', { recursive: true });
    const destination = '/.fwf-legacy-fixtures/crontabs/jsmith';
    if (!(await sb.fs.exists(destination))) await sb.fs.rename(oldCrontab, destination);
  }
}

/**
 * Install only absent lore paths. Existing files are never replaced, and the original v1 seed
 * marker remains untouched. The diagnostics passwd record is appended only when genuinely absent.
 */
export async function provisionHpuxLore(sb: Sandbox, freshSeed = false): Promise<void> {
  const entries = new Map(HPUX_TREE.map((entry) => [entry.p, entry]));
  for (const path of HPUX_LORE_PATHS) {
    if (await sb.fs.exists(path)) continue;
    const entry = entries.get(path);
    if (!entry) throw new Error(`HP-UX lore fixture is missing ${path}`);
    if (entry.t === 'd') {
      await sb.fs.mkdir(path, { recursive: true });
    } else {
      await sb.fs.mkdir(parentOf(path), { recursive: true });
      const content = seededReadable(path) ? (entry.c ?? '') : '';
      await sb.fs.writeFile(path, content);
    }
  }
  if (await sb.fs.exists('/etc/passwd')) {
    const passwd = await sb.fs.readFile('/etc/passwd');
    if (!passwd.split('\n').some((line) => line.startsWith('diag:'))) {
      await sb.fs.writeFile(
        '/etc/passwd',
        `${passwd}${passwd.endsWith('\n') || passwd === '' ? '' : '\n'}${DIAG_PASSWD_RECORD}\n`,
      );
    }
  }
  if (freshSeed && await sb.fs.exists('/etc/motd')) {
    const motd = await sb.fs.readFile('/etc/motd');
    const notice = `
                         HP-UX SYSTEM V
                       AUTHORIZED USE ONLY

NOTICE:
This system will be unavailable Sunday 0200-0400
for scheduled maintenance.

-- Operations

Nice try.
Try /var/adm.
`;
    if (!motd.includes('Try /var/adm.')) await sb.fs.writeFile('/etc/motd', `${motd}${notice}`);
  }
}

async function registerCommands(sb: Sandbox): Promise<void> {
  const registry = sb.shell.getRegistry();
  // Resolve every original we wrap *before* overriding: resolving a lazy command writes it back
  // into the registry when its import finishes, which would otherwise clobber our override.
  const wrapped = [...DELEGATED_READ_TOOLS, ...DELEGATED_WRITE_TOOLS, ...DELEGATED_COPY_TOOLS];
  const originals = new Map<string, Command>();
  await Promise.all(
    wrapped.map(async (n) => {
      const cmd = await registry.resolve(n);
      if (cmd) originals.set(n, cmd);
    }),
  );
  const reg = (name: string, cmd: Command): void => {
    registry.unregister(name);
    sb.commands.register(name, cmd);
  };

  // Use the same handlers for lexical adaptation and expanded-name dispatch.
  // eslint-disable-next-line @typescript-eslint/require-await
  const fileTest = (bracket: boolean): Command => async (ctx) => {
    const args = [...ctx.args];
    if (bracket && args.pop() !== ']') {
      ctx.stderr.write('[: missing ]\n');
      return 2;
    }
    try {
      const value = testExpression(args, (op, operand) => {
        if (!operand) return false;
        const path = normalizePath(operand, ctx.cwd);
        if (traverseBlocker(ctx, path)) return false;
        const meta = metaFor(ctx, path);
        if (!meta) return false;
        if (op === '-e') return true;
        if (op === '-f') return !meta.dir;
        if (op === '-d') return meta.dir;
        if (op === '-s') return !meta.dir && (meta.size ?? ctx.vfs.stat(path).size) > 0;
        return perm(meta, op === '-r' ? 4 : op === '-w' ? 2 : 1);
      });
      return value ? 0 : 1;
    } catch (error) {
      ctx.stderr.write(`test: ${describeError(error)}\n`);
      return 2;
    }
  };
  const testCommand = fileTest(false);
  const bracketCommand = fileTest(true);
  reg('__hpux_test', testCommand);
  reg('__hpux_bracket', bracketCommand);
  reg('test', testCommand);
  reg('[', bracketCommand);
  // eslint-disable-next-line @typescript-eslint/require-await
  const cdCommand: Command = async (ctx) => {
    if (ctx.args.length > 1) {
      ctx.stderr.write('cd: too many arguments\n');
      return 1;
    }
    const env = sb.shell.getEnv();
    const shown = ctx.args[0] ?? env.HOME ?? HOME;
    const path = normalizePath(shown === '-' ? env.OLDPWD ?? HOME : shown, ctx.cwd);
    const access = checkList(ctx, path);
    if (access !== 'ok') {
      ctx.stderr.write(`cd: ${shown}: ${access === 'denied' ? 'Permission denied' : access === 'notdir' ? 'Not a directory' : 'No such file or directory'}\n`);
      return 1;
    }
    env.OLDPWD = ctx.cwd;
    sb.cwd = path;
    env.PWD = path;
    if (shown === '-') ctx.stdout.write(`${path}\n`);
    return 0;
  };
  reg('__hpux_cd', cdCommand);
  reg('cd', cdCommand);
  enableHpuxBuiltinDispatch(sb.shell);
  reg('ls', lsCommand);
  reg('dir', lsCommand);
  reg('ll', async (ctx) => lsCommand({ ...ctx, args: ['-l', ...ctx.args] }));
  reg('cat', catLike('cat', false));
  for (const pager of ['more', 'less', 'pg', 'view']) reg(pager, catLike(pager, true));
  reg('head', headTail('head'));
  reg('tail', headTail('tail'));
  reg('strings', stringsCommand);
  reg('find', findCommand);
  reg('grep', grepCommand);
  reg('egrep', async (ctx) => grepCommand({ ...ctx, args: ['-E', ...ctx.args] }));
  reg('fgrep', async (ctx) => grepCommand({ ...ctx, args: ['-F', ...ctx.args] }));
  for (const n of DELEGATED_READ_TOOLS) reg(n, guarded(originals, n, 'read'));
  for (const n of DELEGATED_WRITE_TOOLS) reg(n, guarded(originals, n, 'write'));
  for (const n of DELEGATED_COPY_TOOLS) reg(n, guarded(originals, n, 'copy'));

  reg('id', idCommand);
  // The library's cloud-aware whoami requires Node globals; identity here is local.
  reg('whoami', text(() => `${USER}\n`));
  // Never buffer thousands of ANSI animation frames from the bundled sl.
  reg('sl', text(() => TRAIN));
  reg('groups', async (ctx) => {
    if (ctx.args.length) {
      ctx.stderr.write('Usage: groups (shows your own Okta SAML memberships)\n');
      return 1;
    }
    try {
      ctx.stdout.write(`${await listIdentityGroups()}\n`);
      return 0;
    } catch (error) {
      ctx.stderr.write(`groups: ${describeError(error)}\n`);
      return 1;
    }
  });
  reg('uname', unameCommand);
  reg('model', modelCommand);
  reg('getconf', getconfCommand);
  reg('machinfo', machinfoCommand);
  reg('bdf', bdfCommand);
  reg('df', bdfCommand);
  reg('swlist', swlistCommand);
  reg('who', whoCommand);
  reg('w', whoCommand);
  reg('users', text(() => 'operator oracle root\n'));
  reg('last', lastCommand);
  reg('finger', fingerCommand);
  reg('uptime', uptimeCommand);
  reg('ps', psCommand);
  reg('ioscan', ioscanCommand);
  reg('lanscan', lanscanCommand);
  reg('man', manCommand);
  reg('su', denied('su: Sorry'));
  reg('sudo', denied(`${USER} is not allowed to run sudo on ${HOST}.  This incident will be reported.`));
  reg('passwd', denied('passwd: Permission denied'));
  reg('login', denied('login: no utmp entry.  You must exec "login" from the lowest level "sh"'));
  reg('shutdown', denied('shutdown: You must be root to run shutdown'));
  reg('reboot', denied('reboot: Permission denied'));
  reg('swinstall', denied('swinstall: You do not have the required permissions to run swinstall'));
  reg('sam', denied('sam: You must be superuser to run SAM'));
  reg('crontab', denied(`crontab: you are not authorized to use cron.  Sorry.`));
  reg('mount', text(() => '/ on /dev/vg00/lvol3 log on Mon Mar 10 12:04:11 2003\n/stand on /dev/vg00/lvol1 defaults on Mon Mar 10 12:04:11 2003\n/var on /dev/vg00/lvol8 delaylog on Mon Mar 10 12:04:13 2003\n/usr on /dev/vg00/lvol7 delaylog on Mon Mar 10 12:04:13 2003\n/tmp on /dev/vg00/lvol4 delaylog on Mon Mar 10 12:04:14 2003\n/opt on /dev/vg00/lvol6 delaylog on Mon Mar 10 12:04:14 2003\n/home on /dev/vg00/lvol5 delaylog on Mon Mar 10 12:04:15 2003\n/dumps on oradb01:/export/dumps soft,bg on Mon Mar 10 12:04:20 2003\n'));
  reg('exit', denied('exit: this is the CTF console. Type `logout` to sign out or `clear` to reset the screen.', 0));
  for (const editor of ['vi', 'vim', 'ex', 'ed', 'emacs', 'nano']) {
    reg(editor, denied(`${editor}: run it directly from the console prompt, not inside a pipeline`));
  }
}

async function createAccountSandbox(
  options: Parameters<typeof Sandbox.create>[0],
): Promise<Sandbox> {
  if (typeof indexedDB === 'undefined' || ACCOUNT_KEY === 'operator') {
    return Sandbox.create({ ...options, persist: ACCOUNT_KEY === 'operator' ? false : options?.persist });
  }
  const original = globalThis.indexedDB;
  const scoped = new Proxy(original, {
    get(target, property) {
      if (property === 'open') {
        return (name: string, version?: number): IDBOpenDBRequest => target.open(
          scopedDatabaseName(name),
          version,
        );
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  try {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: scoped,
    });
    return await Sandbox.create(options);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: original });
  }
}

/** Keep Lifo's authenticated stores isolated; notably, the legacy unscoped `lifo` DB is untouched. */
export function scopedDatabaseName(name: string, accountId = ACCOUNT_KEY): string {
  return name === 'lifo' || name === 'lifo-blobs'
    ? `${name}-fwf-account-${accountId}`
    : name;
}

async function boot(): Promise<Sandbox> {
  const env = {
    USER,
    LOGNAME: USER,
    HOME,
    HOSTNAME: HOST,
    SHELL: '/bin/bash',
    FLAG: '$t0ring_secrets_n_env_i$_bad',
    TERM: 'hp',
    PATH: '/usr/bin:/usr/ccs/bin:/usr/contrib/bin:/opt/perl/bin:/usr/local/bin:/sbin:/usr/sbin',
    TZ: 'EST5EDT',
    EDITOR: 'vi',
  };
  let sb: Sandbox;
  try {
    sb = await createAccountSandbox({ persist: true, cwd: HOME, env });
  } catch {
    // Private windows or blocked storage: fall back to a purely in-memory sandbox.
    sb = await Sandbox.create({ persist: false, cwd: HOME, env });
  }
  let seeded: boolean;
  try {
    seeded =
      (await sb.fs.exists(SEED_MARKER)) && (await sb.fs.readFile(SEED_MARKER)) === SEED_VERSION;
  } catch {
    seeded = false;
  }
  if (!seeded) await seed(sb);
  await provisionHpuxLore(sb, !seeded);
  await removePersistedSampleAccounts(sb);
  await migrateCanonicalHome(sb);
  await ensurePersonalizedHome(sb);
  await ensureDirectoryHistories(sb);
  if (USER !== DEFAULT_USER) {
    await sb.fs.writeFile(ACCOUNT_MARKER, JSON.stringify({ accountId: ACCOUNT_KEY, home: HOME }));
  }
  // Cwd may itself be persisted by Lifo; never carry it across authenticated identities.
  sb.cwd = HOME;
  sb.shell.getEnv().PWD = HOME;
  await registerCommands(sb);
  return sb;
}

export function getSandbox(): Promise<Sandbox> {
  sandboxPromise ??= boot();
  return sandboxPromise;
}

export interface ShellRun {
  output: string;
  cwd: string;
  exitCode: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export async function runShell(command: string): Promise<ShellRun> {
  const sb = await getSandbox();
  const ctx = { vfs: sb.kernel.vfs, cwd: sb.cwd } as CommandContext;
  for (const match of command.matchAll(/(?:^|\s)(?:\d*>>?)\s*([^\s;&|]+)/g)) {
    const shown = match[1]!;
    if (checkWrite(ctx, normalizePath(shown, sb.cwd)) !== 'ok') {
      return { output: `bash: ${shown}: Permission denied\n`, cwd: sb.cwd, exitCode: 1 };
    }
  }
  let adapted: string;
  try {
    adapted = adaptShellCommands(command);
  } catch (error) {
    return { output: `bash: ${describeError(error)}\n`, cwd: sb.cwd, exitCode: 2 };
  }
  let result;
  try {
    result = await sb.commands.run(adapted, { timeout: RUN_TIMEOUT_MS });
  } finally {
    // Run after all shell dispatch (including source, aliases and recursive mkdir), not
    // merely after a lexical "mkdir" command. Lifo persists these files with the tree.
    await ensureDirectoryHistories(sb);
  }
  let output = `${result.stdout}${result.stderr}`.replace(ANSI, '');
  if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n[output truncated]\n`;
  return { output, cwd: sb.cwd, exitCode: result.exitCode };
}

export async function currentCwd(): Promise<string> {
  return (await getSandbox()).cwd;
}

export function prompt(cwd: string): string {
  return `${HOST}:${cwd} $ `;
}

/** Wipe the player's copy and reseed the pristine tree. */
export async function resetSandbox(): Promise<void> {
  const sb = await getSandbox();
  await seed(sb);
  await ensurePersonalizedHome(sb);
  await ensureDirectoryHistories(sb);
  sb.cwd = HOME;
  sb.shell.getEnv().PWD = HOME;
}

const HISTORY_FIRST_LINE = 'submit B@sh_h1st0ry_st0res_secret$_t00';
const HISTORY_PREFIX = `${HISTORY_FIRST_LINE}\n`;

/** Preserve all existing entries verbatim after the mandatory first line. */
function prefixedHistory(content: string): string {
  if (content.startsWith(HISTORY_PREFIX)) return content;
  if (content === HISTORY_FIRST_LINE) return HISTORY_PREFIX;
  return `${HISTORY_PREFIX}${content}`;
}

/** Reconcile existing histories as well as new directories without disturbing their entries. */
async function ensureDirectoryHistories(sb: Sandbox): Promise<void> {
  async function visit(path: string): Promise<void> {
    if (foreignHome(path)) return;
    const history = path === '/' ? '/.bash_history' : `${path}/.bash_history`;
    if (!(await sb.fs.exists(history))) {
      // The original planted clue lived in .sh_history. Make it discoverable
      // through bash history without modifying the original history file.
      const legacy = `${path}/.sh_history`;
      const clue = (path === HOME || path === DEFAULT_HOME) && await sb.fs.exists(legacy)
        ? await sb.fs.readFile(legacy) : '';
      await sb.fs.writeFile(history, prefixedHistory(clue));
    } else {
      const previous = await sb.fs.readFile(history);
      const updated = prefixedHistory(previous);
      if (updated !== previous) await sb.fs.writeFile(history, updated);
    }
    for (const entry of await sb.fs.readdir(path)) {
      if (entry.type !== 'directory') continue;
      const child = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
      if (!isVirtual(child)) await visit(child);
    }
  }
  await visit('/');
}

/** Only prompt-level commands belong in history; internal shell subcommands do not. */
export async function recordUserCommand(command: string): Promise<void> {
  const sb = await getSandbox();
  const ctx = { vfs: sb.kernel.vfs, cwd: sb.cwd } as CommandContext;
  if (checkList(ctx, sb.cwd) !== 'ok') return;
  const path = sb.cwd === '/' ? '/.bash_history' : `${sb.cwd}/.bash_history`;
  const previous = prefixedHistory(await sb.fs.exists(path) ? await sb.fs.readFile(path) : '');
  await sb.fs.writeFile(path, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${command}\n`);
}

// ------------------------------------------------------------------ editor support

export interface OpenResult {
  path: string;
  content: string | null;
  exists: boolean;
  writable: boolean;
  reason: string | null;
}

/** Read a file for the line editor, applying the same permission view as the shell. */
export async function openForEdit(arg: string): Promise<OpenResult> {
  const sb = await getSandbox();
  const path = normalizePath(arg, sb.cwd);
  // Build a minimal CommandContext-like view for the permission helpers.
  const ctx = { vfs: sb.kernel.vfs, cwd: sb.cwd } as CommandContext;
  const exists = ctx.vfs.exists(path);
  const read = checkRead(ctx, path);
  const write = checkWrite(ctx, path);
  const isDir = read === 'isdir';
  let content: string | null = null;
  if (read === 'ok') content = readText(ctx, path);
  let reason: string | null = null;
  if (isDir) reason = `"${path}" Is a directory`;
  else if (read === 'denied') reason = `"${path}" Permission denied`;
  else if (write !== 'ok') reason = write === 'missing' ? `"${path}" No such file or directory` : `"${path}" Permission denied`;
  return { path, content, exists, writable: write === 'ok' && !isDir && read !== 'denied', reason };
}

export async function saveFile(path: string, content: string): Promise<void> {
  const sb = await getSandbox();
  const ctx = { vfs: sb.kernel.vfs, cwd: sb.cwd } as CommandContext;
  if (checkWrite(ctx, path) !== 'ok') {
    throw new Error(`"${path}" Permission denied`);
  }
  await sb.fs.writeFile(path, baseName(path) === '.bash_history' ? prefixedHistory(content) : content);
}
