export function scrollToBottom(): void {
  const terminal = document.querySelector('.terminal') as HTMLElement;
  if (terminal) {
    terminal.scrollTop = terminal.scrollHeight;
  }
} 