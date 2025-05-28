import { scrollToBottom } from './utils.js';
export function handleClick(event) {
    if (!event)
        return;
    event.preventDefault();
    const input = document.querySelector("[contenteditable='true']");
    if (!input)
        return;
    input.focus();
    const terminalOutput = document.getElementById("terminal-output");
    if (terminalOutput) {
        const isScrolledToBottom = terminalOutput.scrollHeight - terminalOutput.clientHeight <=
            terminalOutput.scrollTop + 1;
        if (isScrolledToBottom) {
            scrollToBottom();
        }
    }
    // Only allow click events that originated from within the terminal container
    const target = event.target;
    if (target.closest(".terminal") !== null) {
        event.stopPropagation();
    }
    // Set focus back to the input field
    setTimeout(() => input.focus(), 0);
}
export function theme(event) {
    if (!event?.target?.dataset?.theme)
        return;
    const themeValue = event.target.dataset.theme;
    document.querySelectorAll(".theme").forEach(b => b.classList.remove("active"));
    event.target.classList.add("active");
    document.body.className = "theme-" + themeValue;
    handleClick(new MouseEvent('click'));
}
export function fullscreen(event) {
    if (event?.target) {
        event.target.blur();
    }
}
export function globalListener(event) {
    if (!event)
        return;
    const keyCode = event.keyCode;
    if (event.target.matches("#terminal-input")) {
        const target = event.target;
        target.addEventListener("click", handleClick);
        target.addEventListener("touchstart", handleClick);
    }
    if (keyCode === 122) { // F11
        toggleFullscreen();
    }
    else if (keyCode === 27) { // ESC
        toggleFullscreen(false);
    }
}
// Initialize terminal input listener
const terminalInput = document.getElementById('terminal-input');
if (terminalInput) {
    terminalInput.addEventListener('input', scrollToBottom);
}
export function toggleFullscreen(enable) {
    const doc = document;
    const docEl = doc.documentElement;
    if (enable === undefined) {
        enable = !doc.fullscreenElement &&
            !doc.mozFullScreenElement &&
            !doc.webkitFullscreenElement &&
            !doc.msFullscreenElement;
    }
    const requestFS = docEl.requestFullscreen ||
        docEl.mozRequestFullScreen || // Firefox
        docEl.webkitRequestFullscreen || // Chrome, Safari, Opera
        docEl.msRequestFullscreen; // IE/Edge
    const exitFS = doc.exitFullscreen ||
        doc.mozCancelFullScreen ||
        doc.webkitExitFullscreen ||
        doc.msExitFullscreen;
    if (enable && requestFS) {
        requestFS.call(docEl);
    }
    else if (!enable && exitFS && (doc.fullscreenElement ||
        doc.mozFullScreenElement ||
        doc.webkitFullscreenElement ||
        doc.msFullscreenElement)) {
        exitFS.call(doc);
    }
}
//# sourceMappingURL=globalHandlers.js.map