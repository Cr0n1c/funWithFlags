/** Native keyboard bridge. The textarea is a transport, never the file buffer. */
export function bindEditorInput(
  input: HTMLTextAreaElement,
  handlers: {
    key: (key: string) => void;
    text: (text: string, literal: boolean) => void;
    blocked: () => boolean;
  },
): () => void {
  const sentinel = '\u200b';
  let composing = false;
  let committed: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    input.value = sentinel;
    input.setSelectionRange(1, 1);
  };
  const clearCommit = () => {
    committed = null;
    clearTimeout(timer);
  };
  const duplicate = (data: string | null) => committed !== null && data === committed;
  const beforeInput = (event: InputEvent) => {
    event.stopImmediatePropagation();
    if (handlers.blocked()) {
      event.preventDefault();
      reset();
      return;
    }
    if (composing || event.isComposing || event.inputType === 'insertCompositionText') return;
    if (!event.cancelable) return; // input below consumes the native value.
    event.preventDefault();
    if (!duplicate(event.data)) {
      clearCommit();
      if (event.inputType === 'deleteContentBackward') handlers.key('Backspace');
      else if (event.inputType === 'deleteContentForward') handlers.key('Delete');
      else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') handlers.key('Enter');
      else if (event.inputType.startsWith('insert') && event.data) {
        handlers.text(event.data, event.inputType !== 'insertText');
      }
    }
    reset();
  };
  const onInput = (event: Event) => {
    event.stopImmediatePropagation();
    const native = event as InputEvent;
    if (composing || native.isComposing) return;
    if (!handlers.blocked() && !duplicate(native.data)) {
      const text = input.value.startsWith(sentinel) ? input.value.slice(1) : input.value;
      if (text) handlers.text(text, native.inputType !== 'insertText');
      else if (native.inputType === 'deleteContentBackward') handlers.key('Backspace');
      else if (native.inputType === 'deleteContentForward') handlers.key('Delete');
    }
    reset();
  };
  const start = () => { clearCommit(); composing = true; };
  const end = (event: CompositionEvent) => {
    composing = false;
    if (!handlers.blocked() && event.data) handlers.text(event.data, true);
    // Some engines send the final input after compositionend, others before it.
    committed = event.data;
    timer = setTimeout(clearCommit, 0);
    reset();
  };
  const paste = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!handlers.blocked() && !composing) {
      handlers.text(event.clipboardData?.getData('text/plain') ?? '', true);
    }
    reset();
  };
  const key = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLButtonElement && !handlers.blocked()) return;
    event.stopImmediatePropagation();
    if (handlers.blocked()) { event.preventDefault(); return; }
    if (composing || event.isComposing || event.keyCode === 229) return;
    clearCommit();
    // Keep browser paste/copy and IME shortcuts; printable text uses beforeinput.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (Array.from(event.key).length === 1 || event.key === 'Dead' || event.key === 'Process') return;
    if (event.key === 'Tab') return;
    event.preventDefault();
    handlers.key(event.key);
    reset();
  };
  input.addEventListener('beforeinput', beforeInput);
  input.addEventListener('input', onInput);
  input.addEventListener('compositionstart', start);
  input.addEventListener('compositionend', end);
  input.addEventListener('paste', paste);
  document.addEventListener('keydown', key, true);
  reset();
  return () => {
    clearCommit();
    document.removeEventListener('keydown', key, true);
    input.removeEventListener('beforeinput', beforeInput);
    input.removeEventListener('input', onInput);
    input.removeEventListener('compositionstart', start);
    input.removeEventListener('compositionend', end);
    input.removeEventListener('paste', paste);
  };
}