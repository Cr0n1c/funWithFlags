/** State and keystroke handling for the deliberately small, old-style vi. */
export type EditorMode = 'normal' | 'insert' | 'command';

export interface EditorSession {
  path: string;
  lines: string[];
  row: number;
  col: number;
  mode: EditorMode;
  command: string;
  dirty: boolean;
  writable: boolean;
  reason: string | null;
  existed: boolean;
  message: string;
  pending: '' | 'd';
}

export interface EditorStep {
  /** Close immediately, or after a requested save succeeds. */
  done: boolean;
  /** Content to persist through the shell's permission-checked saveFile. */
  save?: string;
  message?: string;
}

export function openEditor(
  path: string,
  content: string | null,
  writable: boolean,
  reason: string | null,
): EditorSession {
  const existed = content !== null;
  const body = content ?? '';
  const lines = body === '' ? [''] : body.replace(/\n$/, '').split('\n');
  return {
    path, lines, row: 0, col: 0, mode: 'normal', command: '', dirty: false,
    writable, reason, existed, message: writable ? '' : (reason ?? '[Read only]'), pending: '',
  };
}

export function editorContent(session: EditorSession): string {
  return session.lines.length === 1 && session.lines[0] === ''
    ? ''
    : `${session.lines.join('\n')}\n`;
}

function clampCursor(session: EditorSession): void {
  session.row = Math.max(0, Math.min(session.row, session.lines.length - 1));
  const length = session.lines[session.row]!.length;
  session.col = Math.max(0, Math.min(session.col, session.mode === 'insert' ? length : Math.max(0, length - 1)));
}

function changed(session: EditorSession): void {
  session.dirty = true;
  session.message = '';
  session.pending = '';
  clampCursor(session);
}

function commandStep(session: EditorSession): EditorStep {
  const command = session.command.trim();
  session.command = '';
  session.mode = 'normal';
  if (command === 'q!') return { done: true };
  if (command === 'q') {
    if (session.dirty) {
      session.message = 'No write since last change (add ! to override)';
      return { done: false };
    }
    return { done: true };
  }
  if (command === 'w' || command === 'wq' || command === 'x') {
    if (command === 'x' && !session.dirty) return { done: true };
    if (!session.writable) {
      session.message = session.reason ?? `"${session.path}" File is read only`;
      return { done: false };
    }
    const save = editorContent(session);
    const count = session.lines.length === 1 && session.lines[0] === '' ? 0 : session.lines.length;
    const message = `"${session.path}" ${count} line${count === 1 ? '' : 's'}, ${save.length} characters written`;
    return { done: command !== 'w', save, message };
  }
  session.message = `:${command}: Not an editor command`;
  return { done: false };
}

function insertKey(session: EditorSession, key: string): void {
  const line = session.lines[session.row]!;
  if (key === 'Enter') {
    session.lines.splice(session.row, 1, line.slice(0, session.col), line.slice(session.col));
    session.row++;
    session.col = 0;
    changed(session);
  } else if (key === 'Backspace') {
    if (session.col > 0) {
      session.lines[session.row] = line.slice(0, session.col - 1) + line.slice(session.col);
      session.col--;
      changed(session);
    } else if (session.row > 0) {
      const previous = session.lines[session.row - 1]!;
      session.lines.splice(session.row - 1, 2, previous + line);
      session.row--;
      session.col = previous.length;
      changed(session);
    }
  } else if (key === 'Delete' && session.col < line.length) {
    session.lines[session.row] = line.slice(0, session.col) + line.slice(session.col + 1);
    changed(session);
  } else if (Array.from(key).length === 1) {
    session.lines[session.row] = line.slice(0, session.col) + key + line.slice(session.col);
    session.col += key.length;
    changed(session);
  }
}

/** Insert bulk text without interpreting characters as vi keys or commands. */
export function editorText(session: EditorSession, text: string): void {
  if (!text) return;
  if (session.mode === 'command') {
    session.command += text.replace(/[\r\n]/g, ' ');
  } else if (session.mode === 'insert') {
    const line = session.lines[session.row]!;
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    const last = parts.length - 1;
    const column = last === 0 ? session.col + parts[0]!.length : parts[last]!.length;
    parts[0] = line.slice(0, session.col) + parts[0];
    parts[last] += line.slice(session.col);
    session.lines.splice(session.row, 1, ...parts);
    session.row += last;
    session.col = column;
    changed(session);
  }
}

export function editorKey(session: EditorSession, key: string): EditorStep {
  if (session.mode === 'command') {
    if (key === 'Escape') {
      session.mode = 'normal';
      session.command = '';
    } else if (key === 'Enter') {
      return commandStep(session);
    } else if (key === 'Backspace') {
      if (session.command) session.command = session.command.slice(0, -1);
      else session.mode = 'normal';
    } else if (Array.from(key).length === 1) {
      session.command += key;
    }
    return { done: false };
  }

  if (key === 'Escape') {
    session.mode = 'normal';
    session.pending = '';
    clampCursor(session);
    return { done: false };
  }
  if (session.mode === 'insert') {
    if (key === 'ArrowLeft') session.col--;
    else if (key === 'ArrowRight') session.col++;
    else if (key === 'ArrowUp') session.row--;
    else if (key === 'ArrowDown') session.row++;
    else insertKey(session, key);
    clampCursor(session);
    return { done: false };
  }

  if (key === ':' ) {
    session.mode = 'command';
    session.command = '';
    session.pending = '';
  } else if (key === 'i') {
    session.mode = 'insert';
  } else if (key === 'a') {
    session.mode = 'insert';
    session.col = Math.min(session.lines[session.row]!.length, session.col + 1);
  } else if (key === 'o') {
    session.lines.splice(session.row + 1, 0, '');
    session.row++;
    session.col = 0;
    session.mode = 'insert';
    changed(session);
  } else if (key === 'h' || key === 'ArrowLeft') session.col--;
  else if (key === 'l' || key === 'ArrowRight') session.col++;
  else if (key === 'k' || key === 'ArrowUp') session.row--;
  else if (key === 'j' || key === 'ArrowDown') session.row++;
  else if (key === 'x') {
    const line = session.lines[session.row]!;
    if (line.length) {
      session.lines[session.row] = line.slice(0, session.col) + line.slice(session.col + 1);
      changed(session);
    }
  } else if (key === 'd') {
    if (session.pending === 'd') {
      if (session.lines.length === 1) session.lines[0] = '';
      else session.lines.splice(session.row, 1);
      changed(session);
    } else session.pending = 'd';
  } else {
    session.pending = '';
  }
  clampCursor(session);
  return { done: false };
}
