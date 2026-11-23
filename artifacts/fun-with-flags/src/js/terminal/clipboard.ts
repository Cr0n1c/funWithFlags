import { AUTO_COPY_CHANGED, isAutoCopyEnabled } from './clipboardPreference.js';

/** Copy output selections without clearing them or moving keyboard focus. */
export function installSelectionCopy(output: HTMLElement): void {
  let lastCopied = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dragging = false;
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.className = 'clipboard-status';
  output.after(status);
  let generation = 0;
  document.addEventListener(AUTO_COPY_CHANGED, () => {
    generation++;
    clearTimeout(timer);
    lastCopied = '';
    status.textContent = '';
  });
  const copy = async () => {
    if (!isAutoCopyEnabled() || dragging || document.getElementById('terminal-input-wrapper')?.hidden) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      lastCopied = '';
      return;
    }
    const range = selection.getRangeAt(0);
    if (!output.contains(range.startContainer) || !output.contains(range.endContainer)) return;
    const text = selection.toString();
    if (!text || text === lastCopied) return;
    const copyGeneration = generation;
    try {
      await navigator.clipboard.writeText(text);
      if (copyGeneration !== generation) return;
      lastCopied = text;
      // Successful auto-copy is silent; clear any earlier failure notice.
      status.textContent = '';
    } catch {
      if (copyGeneration !== generation) return;
      status.textContent = 'Auto-copy unavailable. Use Copy in the selection menu or press Ctrl+C (⌘C on Mac).';
    }
  };
  document.addEventListener('pointerdown', () => { dragging = true; });
  document.addEventListener('pointerup', () => { dragging = false; void copy(); });
  document.addEventListener('pointercancel', () => { dragging = false; });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) void copy();
  });
  document.addEventListener('selectionchange', () => {
    clearTimeout(timer);
    if (isAutoCopyEnabled()) timer = setTimeout(() => { void copy(); }, 350);
  });
}

export function insertPlainPaste(input: HTMLElement, text: string): void {
  // Bracketed-paste equivalent: pasted newlines never submit shell commands.
  const plain = text.replace(/\r\n?|\n/g, ' ').replace(/\0/g, '');
  input.focus();
  if (document.execCommand('insertText', false, plain)) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
  if (!input.contains(range.commonAncestorContainer)) {
    range.selectNodeContents(input);
    range.collapse(false);
  }
  range.deleteContents();
  const node = document.createTextNode(plain);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
