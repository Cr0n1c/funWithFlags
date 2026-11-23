import {
  focusTerminalOnAnyKey,
  handleBeforeInput,
  handleInput,
  handlePaste,
} from './handlers/inputHandler.js';
import { handleClick } from './handlers/globalHandlers.js';
import { installSelectionCopy } from './terminal/clipboard.js';
import { replaceTerminalLifecycle } from './terminal/lifecycle.js';

export const init = (): void => {
  replaceTerminalLifecycle();
  const terminalInput = document.getElementById('terminal-input');
  if (!terminalInput) return;
  const output = document.getElementById('terminal-output');
  if (output) installSelectionCopy(output);

  // Add touch event listeners for terminal input
  terminalInput.addEventListener('click', handleClick);
  terminalInput.addEventListener('paste', handlePaste);
  document.addEventListener('paste', (event) => {
    if (event.defaultPrevented || document.getElementById('terminal-input-wrapper')?.hidden
      || terminalInput.contentEditable !== 'true') return;
    if (event.target instanceof Element &&
      event.target.closest('input, textarea, button, [contenteditable="true"], [role="dialog"]')) return;
    handlePaste(event, terminalInput);
  });
  terminalInput.addEventListener('beforeinput', handleBeforeInput);

  terminalInput.addEventListener('focus', () => {
    setTimeout(() => {
      document.body.scrollTop = document.documentElement.scrollTop = terminalInput.offsetTop;
    }, 500);
  });

  // Single keydown registration: this used to be duplicated at module load in inputHandler.ts,
  // which made every command run (and render) twice.
  terminalInput.addEventListener('keydown', (event: KeyboardEvent) => {
    void handleInput(event);
  });
  focusTerminalOnAnyKey(terminalInput);
};
