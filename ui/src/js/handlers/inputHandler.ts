import { processCommand, animateText } from '../terminal/terminal.js';
import { scrollToBottom } from './utils.js';
import { getAutocompleteSuggestions } from './commands.js';

// Preload the sound
const keySound = new Audio('/sounds/keypress.mp3');
keySound.volume = 0.4;

const commandHistory: string[] = [];
let commandIndex = -1;

/**
 * Replace the input text and park the caret at the end. Setting innerText alone leaves the
 * caret at offset 0 in a contenteditable, so Backspace and typing appear to do nothing.
 */
function setInputText(inputElement: HTMLElement, text: string): void {
  inputElement.innerText = text;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(inputElement);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function handleEnterKey(
  terminalOutput: HTMLElement,
  inputElement: HTMLElement,
): Promise<void> {
  if (!inputElement) return;

  const inputText = inputElement.innerText.trim();
  const outputText = await processCommand(inputText);

  if (outputText) {
    const newOutputLine = document.createElement('div');
    terminalOutput.appendChild(newOutputLine);

    if (inputText.length > 0) {
      commandHistory.push(inputText);
      commandIndex = commandHistory.length;
      
      inputElement.innerText = '';
      const inputPrefix = document.getElementById('input-prefix');
      if (inputPrefix) {
        await animateText(newOutputLine, inputPrefix.textContent || '', 10, inputElement, inputPrefix);
      } else {
        await animateText(newOutputLine, '', 10, inputElement);
      }
    }

    // Add a small delay before showing the command output
    await new Promise(resolve => setTimeout(resolve, 100));
    await animateText(newOutputLine, outputText, 10, inputElement);
    
    // Add an extra newline after the response
    const extraNewline = document.createElement('div');
    terminalOutput.appendChild(extraNewline);
    
    scrollToBottom();
  }

  inputElement.innerText = '';
  inputElement.focus();
}

function handleArrowUp(inputElement: HTMLElement): void {
  if (!inputElement) return;
  
  if (commandIndex > 0) {
    commandIndex--;
    setInputText(inputElement, commandHistory[commandIndex] ?? '');
  }
}

function handleArrowDown(inputElement: HTMLElement): void {
  if (!inputElement) return;

  if (commandIndex < commandHistory.length - 1) {
    commandIndex++;
    setInputText(inputElement, commandHistory[commandIndex] ?? '');
  } else if (commandIndex === commandHistory.length - 1) {
    commandIndex++;
    setInputText(inputElement, '');
  }
}

function handleEscape(inputElement: HTMLElement): void {
  setInputText(inputElement, '');
}

function handleTab(inputElement: HTMLElement): void {
  if (!inputElement) return;

  const inputText = inputElement.innerText.trim();
  const suggestions = getAutocompleteSuggestions(inputText);

  if (suggestions.length === 1) {
    setInputText(inputElement, `${suggestions[0] ?? ''} `);
  } else if (suggestions.length > 1) {
    const terminalOutput = document.getElementById('terminal-output');
    if (terminalOutput) {
      const line = document.createElement('div');
      line.textContent = suggestions.join('    ');
      terminalOutput.appendChild(line);
      scrollToBottom();
    }
  }
}

export async function handleInput(event: KeyboardEvent): Promise<void> {
  if (!event?.target) return;

  const terminalOutput = document.getElementById('terminal-output');
  const inputElement = event.target as HTMLElement;
  
  // Play typing sound for any key that's "printable"
  if (event.key?.length === 1 || event.key === 'Backspace') {
    const soundClone = keySound.cloneNode() as HTMLAudioElement;
    soundClone.play().catch((e: unknown) => console.warn('Keypress sound blocked:', e));
  }

  switch (event.key) {
    case 'Enter':
      event.preventDefault();
      if (terminalOutput) {
        await handleEnterKey(terminalOutput, inputElement);
      }
      break;
    case 'ArrowUp':
      event.preventDefault();
      handleArrowUp(inputElement);
      break;
    case 'ArrowDown':
      event.preventDefault();
      handleArrowDown(inputElement);
      break;
    case 'Escape':
      event.preventDefault();
      handleEscape(inputElement);
      break;
    case 'Tab':
      event.preventDefault();
      handleTab(inputElement);
      break;
  }
}

/**
 * Any keypress outside the input refocuses the terminal so players can just start typing.
 * Registered once from init(); the per-key handling itself lives in handleInput.
 */
export function focusTerminalOnAnyKey(terminalInput: HTMLElement): void {
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.target !== terminalInput) {
      terminalInput.focus();
      const soundClone = keySound.cloneNode() as HTMLAudioElement;
      soundClone.play().catch((e: unknown) => console.warn('Keypress sound blocked:', e));
    }
  });
}
