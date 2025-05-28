import { banner, about, help } from "../config/content.js";
import { scrollToBottom } from '../handlers/utils.js';
import { login, logout, checkAuthStatus, getAuthState } from '../services/authService.js';

export async function showWelcomeMessage() {
    const terminalOutput = document.getElementById("terminal-output");
    if (!terminalOutput) return;

    const newOutputLine = document.createElement("div");
    terminalOutput.appendChild(newOutputLine);
    await animateText(newOutputLine, banner);
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
