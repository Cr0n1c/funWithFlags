import { banner, about, help } from "../config/content.js";
import { scrollToBottom } from '../handlers/utils.js';
import { login, logout, checkAuthStatus, getAuthState } from '../services/authService.js';

export async function showWelcomeMessage() {
    const terminalOutput = document.getElementById("terminal-output");
    if (!terminalOutput) return;

    const newOutputLine = document.createElement("div");
    terminalOutput.appendChild(newOutputLine);
    
    // Split the banner into sections
    const bannerParts = banner.split('HIMEM is testing extended memory...');
    await animateText(newOutputLine, bannerParts[0]);
    
    // Add memory test section with proper spacing
    await animateText(newOutputLine, '\n    HIMEM is testing extended memory...\n');
    
    // Create container for memory lines with white-space: pre to preserve formatting
    const memLines = document.createElement('div');
    memLines.style.whiteSpace = 'pre';
    newOutputLine.appendChild(memLines);
    
    // Base memory
    const baseMemLine = document.createElement('span');
    baseMemLine.textContent = '    > 0K base memory';
    memLines.appendChild(baseMemLine);
    await animateMemoryCount(baseMemLine, 64);
    baseMemLine.textContent += ' OK';
    memLines.appendChild(document.createTextNode('\n'));
    
    // First extended memory
    const extMem1Line = document.createElement('span');
    extMem1Line.textContent = '    > 0K extended memory';
    memLines.appendChild(extMem1Line);
    await animateMemoryCount(extMem1Line, 256);
    extMem1Line.textContent += ' OK';
    memLines.appendChild(document.createTextNode('\n'));
    
    // Second extended memory
    const extMem2Line = document.createElement('span');
    extMem2Line.textContent = '    > 0K extended memory';
    memLines.appendChild(extMem2Line);
    await animateMemoryCount(extMem2Line, 1024);
    extMem2Line.textContent += ' OK';
    memLines.appendChild(document.createTextNode('\n'));
    
    // Continue with the rest of the banner
    await animateText(newOutputLine, bannerParts[1].split('64K base memory OK')[1].split('256K extended memory OK')[1].split('1024K extended memory OK')[1]);
    
    scrollToBottom();
}

export function processCommand(inputText) {
    if (!inputText?.trim()) return '';

    const command = inputText.toLowerCase().trim();
    const userCommand = `${inputText}\n`;

    switch (command) {
      case "help":
        return userCommand + help;
      case "date":
        return userCommand + new Date().toLocaleString();
      case "clear":
        const terminal = document.getElementById("terminal-output");
        if (terminal) terminal.innerHTML = "";
        return "";
      case "about":
        return userCommand + about;
      case "login":
        const loginResponse = login();
        return userCommand + loginResponse;
      case "logout":
        const logoutResponse = logout();
        return userCommand + logoutResponse;
      case "status":
        const statusResponse = checkAuthStatus();
        return userCommand + statusResponse;
      default:
        return userCommand + `Unknown command: ${inputText}`;
    }
}

let userInteracted = false;
document.addEventListener("click", () => {
    userInteracted = true;
});
  
export async function animateText(element, text, delay = 10, terminalInput, inputPrefix) {
    if (!element) return;
    
    // Convert text to string and handle null/undefined
    const textContent = String(text || '');
    
    // Disable input during animation
    if (terminalInput) {
        terminalInput.contentEditable = "false";
        if (inputPrefix) inputPrefix.style.display = "none";
    }

    try {
        // Calculate speed factor based on text length
        const speedFactor = textContent.length <= 50 ? 1 : textContent.length <= 100 ? 10 : 20;
        const adjustedDelay = delay / speedFactor;

        // Split the text into characters and animate
        const characters = Array.from(textContent);
        for (const char of characters) {
            element.textContent += char;
            scrollToBottom();
            await new Promise(resolve => setTimeout(resolve, adjustedDelay));
        }
    } catch (error) {
        // If animation fails, just set the text immediately
        console.error('Text animation error:', error);
        element.textContent = textContent;
    } finally {
        // Re-enable input after animation (even if there was an error)
        if (terminalInput) {
            terminalInput.contentEditable = "true";
            if (inputPrefix) inputPrefix.style.display = "inline";
        }
    }
}

async function animateMemoryCount(element, targetValue, duration = 2000) {
  const start = performance.now();
  const startValue = 0;

  return new Promise(resolve => {
    function update(currentTime) {
      const elapsed = currentTime - start;
      const progress = Math.min(elapsed / duration, 1);

      const currentValue = Math.floor(startValue + (targetValue - startValue) * progress);
      element.textContent = element.textContent.replace(/\d+K/, `${currentValue}K`);

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(update);
  });
}
