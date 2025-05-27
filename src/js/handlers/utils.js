export function scrollToBottom() {
  const terminal = document.querySelector('.terminal');
  if (terminal) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}