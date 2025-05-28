import { handleInput } from './handlers/inputHandler.js';
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
  
  terminalInput.addEventListener('keydown', handleInput);
}; 