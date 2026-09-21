import { scrollToBottom } from './utils.js';

export function toggleFullscreen(enable?: boolean): void {
  const shouldEnable = enable ?? !document.fullscreenElement;
  if (shouldEnable && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((e: unknown) => {
      console.warn('Fullscreen request rejected:', e);
    });
  } else if (!shouldEnable && document.fullscreenElement) {
    document.exitFullscreen().catch((e: unknown) => {
      console.warn('Exit fullscreen rejected:', e);
    });
  }
}

export function handleClick(event: MouseEvent | TouchEvent): void {
  if (!event) return;
  
  event.preventDefault();
  
  const input = document.querySelector("[contenteditable='true']") as HTMLElement;
  if (!input) return;

  input.focus();

  const terminalOutput = document.getElementById('terminal-output');
  if (terminalOutput) {
    const isScrolledToBottom =
      terminalOutput.scrollHeight - terminalOutput.clientHeight <=
      terminalOutput.scrollTop + 1;

    if (isScrolledToBottom) {
      scrollToBottom();
    }
  }

  // Only allow click events that originated from within the terminal container
  const target = event.target as HTMLElement;
  if (target.closest('.terminal') !== null) {
    event.stopPropagation();
  }

  // Set focus back to the input field
  setTimeout(() => input.focus(), 0);
}

interface ThemeEvent extends Event {
  target: HTMLElement & {
    dataset: {
      theme?: string;
    };
  };
}

export function theme(event: ThemeEvent): void {
  if (!event?.target?.dataset?.theme) return;
  
  const themeValue = event.target.dataset.theme;
  document.querySelectorAll('.theme').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.body.className = 'theme-' + themeValue;
  handleClick(new MouseEvent('click'));
}

export function fullscreen(event: Event): void {
  if (event?.target) {
    (event.target as HTMLElement).blur();
  }
}

export function globalListener(event: KeyboardEvent): void {
  if (!event) return;

  if (event.key === 'F11') {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === 'Escape') {
    toggleFullscreen(false);
  }
}

// Initialize terminal input listener
const terminalInput = document.getElementById('terminal-input');
if (terminalInput) {
  terminalInput.addEventListener('input', scrollToBottom);
} 