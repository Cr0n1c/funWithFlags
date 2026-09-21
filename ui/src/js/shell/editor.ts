/**
 * A tiny line-oriented "vi" for the CTF console.
 *
 * The terminal takes one line at a time, so a modal full-screen editor is not possible. This
 * behaves like `ex`/`ed` wearing a vi costume: typed lines are appended to the buffer and
 * colon-commands manage it. Saving goes through `saveFile` in hpux.ts, so the same permission
 * rules as the shell apply.
 */

export interface EditorSession {
  path: string;
  lines: string[];
  dirty: boolean;
  writable: boolean;
  reason: string | null;
  existed: boolean;
}

export interface EditorStep {
  output: string;
  /** true when the editor should close */
  done: boolean;
  /** content to persist, when a write was requested */
  save?: string;
}

const HELP = `    :p              show the buffer with line numbers
    :Nd  :N,Md      delete line N, or lines N through M
    :%d             clear the buffer
    :Ni <text>      insert <text> before line N
    :Nc <text>      replace line N with <text>
    :w  :wq  :x     write, write and quit
    :q  :q!         quit (:q refuses if there are unsaved changes)
    anything else   appended as a new line`;

export function openEditor(
  path: string,
  content: string | null,
  writable: boolean,
  reason: string | null,
): { session: EditorSession; output: string } {
  const existed = content !== null;
  const lines = existed ? content.replace(/\n$/, '').split('\n') : [];
  if (existed && lines.length === 1 && lines[0] === '') lines.length = 0;
  const session: EditorSession = { path, lines, dirty: false, writable, reason, existed };
  const chars = existed ? content.length : 0;
  const status = existed
    ? `"${path}" ${lines.length} line${lines.length === 1 ? '' : 's'}, ${chars} characters`
    : `"${path}" [New file]`;
  const ro = writable ? '' : `\n    [Read only] ${reason ?? ''}`;
  return {
    session,
    output: `    ${status}${ro}\n    -- INSERT -- typed lines are appended. :p shows the buffer, :wq saves, :q! abandons, :help lists editor keys.`,
  };
}

function numbered(lines: string[]): string {
  if (lines.length === 0) return '    (empty buffer)';
  const w = String(lines.length).length;
  return lines.map((l, i) => `    ${String(i + 1).padStart(w)}  ${l}`).join('\n');
}

function parseRange(spec: string, max: number): [number, number] | null {
  if (spec === '%') return max === 0 ? null : [1, max];
  const m = /^(\d+)(?:,(\d+))?$/.exec(spec);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b < a || b > max) return null;
  return [a, b];
}

export function editorInput(session: EditorSession, raw: string): EditorStep {
  const line = raw.replace(/\r$/, '');
  if (line === 'ZZ') return editorInput(session, ':x');
  if (!line.startsWith(':')) {
    session.lines.push(line);
    session.dirty = true;
    return { output: '', done: false };
  }

  const cmd = line.slice(1).trim();
  const content = (): string => (session.lines.length ? `${session.lines.join('\n')}\n` : '');

  if (cmd === 'help' || cmd === 'h') return { output: HELP, done: false };
  if (cmd === 'p' || cmd === '%p' || cmd === 'nu' || cmd === '%nu') return { output: numbered(session.lines), done: false };
  if (cmd === 'q') {
    if (session.dirty) return { output: '    No write since last change (:q! overrides)', done: false };
    return { output: '', done: true };
  }
  if (cmd === 'q!') return { output: '', done: true };
  if (cmd === 'w' || cmd === 'wq' || cmd === 'x') {
    if (!session.writable) {
      return { output: `    ${session.reason ?? `"${session.path}" File is read only`}`, done: false };
    }
    const body = content();
    const done = cmd !== 'w';
    session.dirty = false;
    session.existed = true;
    return {
      output: `    "${session.path}" ${session.lines.length} line${session.lines.length === 1 ? '' : 's'}, ${body.length} characters written`,
      done,
      save: body,
    };
  }

  const del = /^(%|\d+(?:,\d+)?)d$/.exec(cmd);
  if (del) {
    const range = parseRange(del[1]!, session.lines.length);
    if (!range) return { output: '    Invalid range', done: false };
    session.lines.splice(range[0] - 1, range[1] - range[0] + 1);
    session.dirty = true;
    return { output: `    ${range[1] - range[0] + 1} line(s) deleted`, done: false };
  }
  const ins = /^(\d+)([ic])(?:\s(.*))?$/.exec(cmd);
  if (ins) {
    const n = Number(ins[1]);
    const textArg = ins[3] ?? '';
    if (ins[2] === 'i') {
      if (n < 1 || n > session.lines.length + 1) return { output: '    Invalid line number', done: false };
      session.lines.splice(n - 1, 0, textArg);
    } else {
      if (n < 1 || n > session.lines.length) return { output: '    Invalid line number', done: false };
      session.lines[n - 1] = textArg;
    }
    session.dirty = true;
    return { output: '', done: false };
  }
  return { output: `    :${cmd}: Not an editor command`, done: false };
}
