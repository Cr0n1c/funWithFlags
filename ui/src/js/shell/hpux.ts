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

export const HOST = 'hpux01';
export const USER = 'operator';
export const HOME = '/home/operator';
const GROUP = 'sys';
const UID = 201;
const GID = 3;
const UNAME = `HP-UX ${HOST} B.11.11 U 9000/800 1849587264 unlimited-user license`;
const SEED_MARKER = '/etc/.fwf-seed';
const SEED_VERSION = 'hpux-tree-v1';
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

function baseName(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

function perm(meta: Meta, bit: number): boolean {
  if (meta.owner === USER) return ((meta.mode >> 6) & bit) !== 0;
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
  const known = META.get(path);
  if (known) return known;
  if (!ctx.vfs.exists(path)) return null;
  const st = ctx.vfs.stat(path);
  const dir = st.type === 'directory';
  return {
    mode: dir ? 0o755 : 0o644,
    owner: USER,
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
    if (m && !perm(m, 1)) return false;
    if (p === '/') break;
    p = parentOf(p);
  }
  const m = META.get(path);
  return m ? perm(m, 4) : true;
}

/** Returns the ancestor directory that blocks traversal, or null if the path is reachable. */
function traverseBlocker(ctx: CommandContext, path: string): string | null {
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
  if (existing) return perm(existing, 2) || perm(parent, 2) ? 'ok' : 'denied';
  return perm(parent, 2) ? 'ok' : 'denied';
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

function lsLongRow(ctx: CommandContext, path: string, name: string): string {
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
  return `${modeString(m)} ${String(links).padStart(3)} ${m.owner.padEnd(10)} ${m.group.padEnd(10)} ${String(size).padStart(9)} ${m.mtime} ${name}`;
}

// eslint-disable-next-line @typescript-eslint/require-await
const lsCommand: Command = async (ctx) => {
  const { flags, rest } = splitFlags(ctx.args);
  const long = flags.has('l');
  const all = flags.has('a') || flags.has('A');
  const dirOnly = flags.has('d');
  const recursive = flags.has('R');
  const targets = rest.length ? rest : ['.'];
  let rc = 0;
  const blocks: string[] = [];

  const listDir = (path: string, showHeader: boolean): void => {
    const access = checkList(ctx, path);
    if (access === 'denied') {
      ctx.stderr.write(`${path} unreadable\n`);
      rc = 2;
      return;
    }
    const fromVfs = ctx.vfs.exists(path) ? ctx.vfs.readdir(path).map((d) => d.name) : [];
    const prefix = path === '/' ? '/' : `${path}/`;
    const fromMeta = [...META.keys()]
      .filter((k) => k.startsWith(prefix) && k !== path && !k.slice(prefix.length).includes('/'))
      .map((k) => k.slice(prefix.length));
    let names = [...new Set([...fromVfs, ...fromMeta])]
      .filter((n) => n !== baseName(SEED_MARKER))
      .sort();
    if (!all) names = names.filter((n) => !n.startsWith('.'));
    else if (flags.has('a')) names = ['.', '..', ...names];
    const join = (n: string): string => (n === '.' ? path : n === '..' ? parentOf(path) : `${path === '/' ? '' : path}/${n}`);
    let body: string;
    if (long) {
      const rows = names.map((n) => lsLongRow(ctx, join(n), n));
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
      ctx.stderr.write(`${t} unreadable\n`);
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
      blocks.push(long ? `${lsLongRow(ctx, path, t)}\n` : `${t}\n`);
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
        if (`${prefix}${n}` !== SEED_MARKER) expand(`${prefix}${n}`, `${shown.replace(/\/$/, '')}/${n}`);
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
      if (child === SEED_MARKER) continue;
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
      ctx.stderr.write(`sh: ${name}:  not found.\n`);
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
jsmith     pts/2        Mar 13 22:03    (10.42.9.77)
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
  reg('uname', unameCommand);
  reg('model', modelCommand);
  reg('bdf', bdfCommand);
  reg('df', bdfCommand);
  reg('swlist', swlistCommand);
  reg('who', whoCommand);
  reg('w', whoCommand);
  reg('users', text(() => 'jsmith operator oracle root\n'));
  reg('last', whoCommand);
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

async function boot(): Promise<Sandbox> {
  const env = {
    USER,
    LOGNAME: USER,
    HOME,
    HOSTNAME: HOST,
    SHELL: '/usr/bin/sh',
    TERM: 'hp',
    PATH: '/usr/bin:/usr/ccs/bin:/usr/contrib/bin:/opt/perl/bin:/usr/local/bin:/sbin:/usr/sbin',
    TZ: 'EST5EDT',
    EDITOR: 'vi',
  };
  let sb: Sandbox;
  try {
    sb = await Sandbox.create({ persist: true, cwd: HOME, env });
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
  if (!(await sb.fs.exists(sb.cwd))) sb.cwd = HOME;
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
  const result = await sb.commands.run(command, { timeout: RUN_TIMEOUT_MS });
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
  sb.cwd = HOME;
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
  const parent = parentOf(path);
  if (!(await sb.fs.exists(parent))) await sb.fs.mkdir(parent, { recursive: true });
  await sb.fs.writeFile(path, content);
}
