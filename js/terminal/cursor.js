export function initCursor() {
    const terminalInput = document.getElementById("terminal-input");
    if (!terminalInput)
        return;
    const cursor = document.createElement("span");
    cursor.classList.add("cursor");
    const parent = terminalInput.parentElement;
    if (!parent)
        return;
    parent.appendChild(cursor);
    const toggleCursor = (show) => cursor.classList.toggle("cursor", show);
    terminalInput.addEventListener("focus", () => toggleCursor(true));
    terminalInput.addEventListener("blur", () => toggleCursor(false));
}
//# sourceMappingURL=cursor.js.map