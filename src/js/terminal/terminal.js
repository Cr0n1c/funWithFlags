import { banner, about, help } from "../config/content.js";
import { scrollToBottom } from '../handlers/utils.js';

export async function showWelcomeMessage() {
    const terminalOutput = document.getElementById("terminal-output");
    const welcomeMessage = banner;
    const newOutputLine = document.createElement("div");
    terminalOutput.appendChild(newOutputLine);
    await animateText(newOutputLine, welcomeMessage);
    scrollToBottom();
}

export function processCommand(inputText) {
    const terminalInput = document.getElementById("terminal-input");
    const userCommand = terminalInput.textContent;
    let response = '';

    switch (inputText.toLowerCase()) {
      case "help":
        return userCommand + "\n" + help;
      case "date":
        return userCommand + "\n" + new Date().toLocaleString();
      case "clear":
        document.getElementById("terminal-output").innerHTML = "";
        return "";
      case "about":
        return userCommand + "\n" + about;
      default:
        return userCommand + "\n" + `Unknown command: ${inputText}`;
    }
}

let userInteracted = false;
document.addEventListener("click", () => {
    userInteracted = true;
});
  
export async function animateText(element, text, delay = 10, terminalInput, inputPrefix) {
    if (terminalInput) {
        terminalInput.contentEditable = "false";
        if (inputPrefix) inputPrefix.style.display = "none";
    }

    // Calculate speed factor based on character count
    const speedFactor = text.length <= 50 ? 1 : text.length <= 100 ? 10 : 20;
    const adjustedDelay = delay / speedFactor;

    for (const char of text) {
        element.textContent += char;
        scrollToBottom();
        await new Promise((resolve) => setTimeout(resolve, adjustedDelay));
    }

    if (terminalInput) {
        terminalInput.contentEditable = "true";
        if (inputPrefix) inputPrefix.style.display = "inline";
    }
}
