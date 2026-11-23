import { editorKey, editorText, type EditorSession } from '../shell/editor.js';
import { bindEditorInput } from './editorInput.js';

interface EditorViewOptions {
  session: EditorSession;
  save: (content: string) => Promise<void>;
  close: () => void;
}

interface TerminalSnapshot {
  outputHidden: boolean;
  wrapperHidden: boolean;
  prompt: string;
  inputEditable: string;
  inputText: string;
  scrollTop: number;
  hostHeight: string;
  hostHeightPriority: string;
}

let active = false;

export function isEditorActive(): boolean {
  return active;
}

export function startEditorView({ session, save, close }: EditorViewOptions): void {
  if (active) return;
  const output = document.getElementById('terminal-output');
  const wrapper = document.getElementById('terminal-input-wrapper');
  const prompt = document.getElementById('input-prefix');
  const input = document.getElementById('terminal-input');
  const terminal = document.querySelector<HTMLElement>('.terminal');
  const host = document.querySelector<HTMLElement>('.terminal-content-inner');
  if (!output || !wrapper || !prompt || !input || !terminal || !host) {
    throw new Error('Terminal editor display is unavailable');
  }
  active = true;
  const snapshot: TerminalSnapshot = {
    outputHidden: output.hidden,
    wrapperHidden: wrapper.hidden,
    prompt: prompt.textContent ?? '',
    inputEditable: input.contentEditable,
    inputText: input.innerText,
    scrollTop: terminal.scrollTop,
    hostHeight: host.style.getPropertyValue('height'),
    hostHeightPriority: host.style.getPropertyPriority('height'),
  };
  output.hidden = true;
  wrapper.hidden = true;
  input.contentEditable = 'false';

  const screen = document.createElement('div');
  screen.className = 'vi-screen';
  screen.dataset.testid = 'vi-screen';
  screen.tabIndex = 0;
  screen.setAttribute('role', 'application');
  screen.setAttribute('aria-label', `vi editor: ${session.path}`);
  const buffer = document.createElement('div');
  buffer.className = 'vi-buffer';
  buffer.dataset.testid = 'vi-buffer';
  const status = document.createElement('div');
  status.className = 'vi-status';
  status.dataset.testid = 'vi-status';
  const command = document.createElement('div');
  command.className = 'vi-command';
  command.dataset.testid = 'vi-command';
  const keyboard = document.createElement('textarea');
  keyboard.className = 'vi-input';
  keyboard.dataset.testid = 'vi-input';
  keyboard.setAttribute('aria-label', 'vi keyboard input');
  keyboard.setAttribute('autocapitalize', 'off');
  keyboard.setAttribute('autocomplete', 'off');
  keyboard.setAttribute('autocorrect', 'off');
  keyboard.spellcheck = false;
  const controls = document.createElement('div');
  controls.className = 'vi-controls';
  for (const [label, key] of [['Insert', 'i'], ['Esc', 'Escape'], [':', ':'], ['Enter', 'Enter']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label!;
    button.addEventListener('click', () => {
      if (saving) return;
      if (key === 'i' || key === ':') onKey('Escape');
      onKey(key!);
      if (active) keyboard.focus({ preventScroll: true });
    });
    controls.appendChild(button);
  }
  screen.append(buffer, status, command, controls, keyboard);
  buffer.addEventListener('click', () => keyboard.focus({ preventScroll: true }));
  host.appendChild(screen);

  let saving = false;
  const render = () => {
    const lineHeight = Number.parseFloat(getComputedStyle(screen).lineHeight) || 20;
    const rows = Math.max(1, Math.floor(buffer.clientHeight / lineHeight));
    const first = Math.max(0, Math.min(session.row - rows + 1, session.lines.length - 1));
    buffer.replaceChildren();
    for (let index = first; index < first + rows; index++) {
      const row = document.createElement('div');
      row.className = 'vi-row';
      if (index >= session.lines.length) {
        row.classList.add('vi-empty');
        row.textContent = '~';
      } else {
        const text = session.lines[index]!;
        if (index === session.row) {
          const before = document.createTextNode(text.slice(0, session.col));
          const cursor = document.createElement('span');
          cursor.className = 'vi-cursor';
          cursor.textContent = text.slice(session.col, session.col + 1) || ' ';
          row.append(before, cursor, document.createTextNode(text.slice(session.col + 1)));
        } else {
          row.textContent = text || ' ';
        }
      }
      buffer.appendChild(row);
    }
    const flags = `${session.dirty ? ' [+]' : ''}${session.writable ? '' : ' [RO]'}`;
    status.textContent = `"${session.path}"${flags}  ${session.row + 1},${session.col + 1}`;
    command.textContent = saving
      ? 'Writing...'
      : session.mode === 'insert'
        ? '-- INSERT --'
        : session.mode === 'command'
          ? `:${session.command}`
          : session.message;
  };

  const finish = () => {
    unbindInput();
    window.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
    screen.remove();
    if (snapshot.hostHeight) host.style.setProperty('height', snapshot.hostHeight, snapshot.hostHeightPriority);
    else host.style.removeProperty('height');
    output.hidden = snapshot.outputHidden;
    wrapper.hidden = snapshot.wrapperHidden;
    prompt.textContent = snapshot.prompt;
    input.contentEditable = snapshot.inputEditable;
    input.innerText = snapshot.inputText;
    active = false;
    close();
    if (!wrapper.hidden) input.focus();
    // Focusing the restored contenteditable may scroll its caret into view.
    // Put the CRT viewport back only after that browser side effect.
    terminal.scrollTop = snapshot.scrollTop;
  };

  const onKey = (key: string) => {
    if (saving) return;
    const step = editorKey(session, key);
    if (step.save === undefined) {
      render();
      if (step.done) finish();
      return;
    }
    saving = true;
    render();
    void save(step.save).then(() => {
      session.dirty = false;
      session.existed = true;
      session.message = step.message ?? '';
      saving = false;
      if (step.done) finish();
      else render();
    }).catch((error: unknown) => {
      saving = false;
      session.dirty = true;
      session.message = `"${session.path}" write failed: ${error instanceof Error ? error.message : String(error)}`;
      render();
    });
  };
  const unbindInput = bindEditorInput(keyboard, {
    key: onKey,
    text: (text, literal) => {
      if (session.mode === 'normal') {
        if (!literal) for (const character of text) onKey(character);
      } else {
        editorText(session, text);
        render();
      }
    },
    blocked: () => saving,
  });
  const resize = () => {
    // A percent height in an auto-height mobile terminal collapses when its
    // in-flow shell children are hidden. Also keep controls above the keyboard.
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const styles = getComputedStyle(terminal);
    const padding = Number.parseFloat(styles.paddingBottom) || 0;
    const topPadding = Number.parseFloat(styles.paddingTop) || 0;
    const available = Math.min(
      terminal.clientHeight - padding - topPadding,
      bottom - host.getBoundingClientRect().top - padding,
    );
    host.style.height = `${Math.max(0, available)}px`;
    render();
  };
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  resize();
  keyboard.focus({ preventScroll: true });
}