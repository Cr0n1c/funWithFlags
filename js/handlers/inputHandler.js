import { processCommand, animateText } from '../terminal/terminal.js';
import { scrollToBottom } from './utils.js';

// Preload the sound
const keySound = new Audio('sounds/keypress.mp3');
keySound.volume = 0.4;

let commandHistory = [];
let commandIndex = -1;

const terminalInput = document.getElementById('terminal-input');
if (terminalInput) {
  terminalInput.addEventListener('keydown', handleInput);

  // Also globally listen
  document.addEventListener('keydown', (event) => {
    if (event?.target !== terminalInput) {
      terminalInput.focus();
      const soundClone = keySound.cloneNode();
      soundClone.play().catch(e => console.warn("Keypress sound blocked:", e));
    }
  });
}

export async function handleInput(event) {
  if (!event?.target) return;

  const terminalOutput = document.getElementById("terminal-output");
  const terminalInput = event.target;
  
  // Play typing sound for any key that's "printable"
  if (event.key?.length === 1 || event.key === "Backspace") {
    const soundClone = keySound.cloneNode();
    soundClone.play().catch(e => console.warn("Keypress sound blocked:", e));
  }

  switch (event.key) {
    case "Enter":
      event.preventDefault();
      await handleEnterKey(terminalOutput, terminalInput);
      break;
    case "ArrowUp":
      event.preventDefault();
      handleArrowUp(terminalInput);
      break;
    case "ArrowDown":
      event.preventDefault();
      handleArrowDown(terminalInput);
      break;
    case "Escape":
      event.preventDefault();
      handleEscape(terminalInput);
      break;
    case "Tab":
      event.preventDefault();
      handleTab(terminalInput);
      break;
  }
}

async function handleEnterKey(terminalOutput, terminalInput) {
  if (!terminalOutput || !terminalInput) return;

  const inputText = terminalInput.innerText.trim();
  const outputText = processCommand(inputText);

  if (outputText) {
    const newOutputLine = document.createElement("div");
    terminalOutput.appendChild(newOutputLine);

    if (inputText.length > 0) {
      commandHistory.push(inputText);
      commandIndex = commandHistory.length;
      
      terminalInput.innerText = "";
      const inputPrefix = document.getElementById("input-prefix");
      await animateText(newOutputLine, inputPrefix?.textContent || "", 10, terminalInput, inputPrefix);
    }

    await animateText(newOutputLine, outputText, 10, terminalInput);
    scrollToBottom();
  }

  terminalInput.innerText = "";
  terminalInput.focus();
}

function handleArrowUp(terminalInput) {
  if (!terminalInput) return;
  
  if (commandIndex > 0) {
    commandIndex--;
    terminalInput.innerText = commandHistory[commandIndex] || "";
  }
}

function handleArrowDown(terminalInput) {
  if (!terminalInput) return;

  if (commandIndex < commandHistory.length - 1) {
    commandIndex++;
    terminalInput.innerText = commandHistory[commandIndex] || "";
  } else if (commandIndex === commandHistory.length - 1) {
    commandIndex++;
    terminalInput.innerText = "";
  }
}

function handleEscape(terminalInput) {
  if (terminalInput) {
    terminalInput.innerText = "";
  }
}

function handleTab(terminalInput) {
  if (!terminalInput) return;

  const inputText = terminalInput.innerText.trim();
  const suggestions = getAutocompleteSuggestions(inputText);

  if (suggestions.length === 1) {
    terminalInput.innerText = suggestions[0];
  } else if (suggestions.length > 1) {
    console.log("Suggestions:", suggestions.join(", "));
  }
}
