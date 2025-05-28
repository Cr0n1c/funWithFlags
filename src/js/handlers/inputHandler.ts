import { processCommand, animateText } from '../terminal/terminal.js';
import { scrollToBottom } from './utils.js';

// Preload the sound
const keySound = new Audio('sounds/keypress.mp3');
keySound.volume = 0.4;

const commandHistory: string[] = [];
let commandIndex = -1;

// Helper function to get autocomplete suggestions
function getAutocompleteSuggestions(input: string): string[] {
  const commands = ['help', 'date', 'clear', 'about', 'login', 'logout', 'status'];
  return commands.filter(cmd => cmd.startsWith(input.toLowerCase()));
}

async function handleEnterKey(
  terminalOutput: HTMLElement,
  inputElement: HTMLElement,
): Promise<void> {
  if (!inputElement) return;

  const inputText = inputElement.innerText.trim();
  const outputText = processCommand(inputText);

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
    inputElement.innerText = commandHistory[commandIndex] || '';
  }
}

function handleArrowDown(inputElement: HTMLElement): void {
  if (!inputElement) return;

  if (commandIndex < commandHistory.length - 1) {
    commandIndex++;
    inputElement.innerText = commandHistory[commandIndex] || '';
  } else if (commandIndex === commandHistory.length - 1) {
    commandIndex++;
    inputElement.innerText = '';
  }
}

function handleEscape(inputElement: HTMLElement): void {
  if (inputElement) {
    inputElement.innerText = '';
  }
}

function handleTab(inputElement: HTMLElement): void {
  if (!inputElement) return;

  const inputText = inputElement.innerText.trim();
  const suggestions = getAutocompleteSuggestions(inputText);

  if (suggestions.length === 1) {
    inputElement.innerText = suggestions[0];
  } else if (suggestions.length > 1) {
    console.log(
      'Suggestions:',
      suggestions.join(', '),
    );
  }
}

export async function handleInput(event: KeyboardEvent): Promise<void> {
  if (!event?.target) return;

  const terminalOutput = document.getElementById('terminal-output');
  const inputElement = event.target as HTMLElement;
  
  // Play typing sound for any key that's "printable"
  if (event.key?.length === 1 || event.key === 'Backspace') {
    const soundClone = keySound.cloneNode() as HTMLAudioElement;
    soundClone.play().catch(e => console.warn('Keypress sound blocked:', e));
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

const terminalInput = document.getElementById('terminal-input');
if (terminalInput) {
  terminalInput.addEventListener('keydown', handleInput);

  // Also globally listen
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event?.target !== terminalInput) {
      terminalInput.focus();
      const soundClone = keySound.cloneNode() as HTMLAudioElement;
      soundClone.play().catch(e => console.warn('Keypress sound blocked:', e));
    }
  });
} 