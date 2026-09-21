import { focusTerminalOnAnyKey, handleInput } from './handlers/inputHandler.js';
import { handleClick } from './handlers/globalHandlers.js';

export const init = (): void => {
  const terminalInput = document.getElementById('terminal-input');
  if (!terminalInput) return;

  // Add touch event listeners for terminal input
  terminalInput.addEventListener('click', handleClick);
  terminalInput.addEventListener('touchstart', handleClick);

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
