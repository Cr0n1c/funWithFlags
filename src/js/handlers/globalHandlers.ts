import { scrollToBottom } from './utils.js';

// Extend Document interface to include vendor prefixed methods
interface CustomDocument extends Document {
  mozCancelFullScreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void>;
  msExitFullscreen?: () => Promise<void>;
  mozFullScreenElement?: Element;
  webkitFullscreenElement?: Element;
  msFullscreenElement?: Element;
}

// Extend HTMLElement interface to include vendor prefixed methods
interface CustomHTMLElement extends HTMLElement {
  mozRequestFullScreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void>;
  msRequestFullscreen?: () => Promise<void>;
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

  const keyCode = event.keyCode;

  if ((event.target as HTMLElement).matches('#terminal-input')) {
    const target = event.target as HTMLElement;
    target.addEventListener('click', handleClick);
    target.addEventListener('touchstart', handleClick as EventListener);
  }

  if (keyCode === 122) { // F11
    toggleFullscreen();
  } else if (keyCode === 27) { // ESC
    toggleFullscreen(false);
  }
}

// Initialize terminal input listener
const terminalInput = document.getElementById('terminal-input');
if (terminalInput) {
  terminalInput.addEventListener('input', scrollToBottom);
}

export function toggleFullscreen(enable?: boolean): void {
  const doc = document as CustomDocument;
  const docEl = doc.documentElement as CustomHTMLElement;

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
  } else if (!enable && exitFS && (doc.fullscreenElement || 
                                 doc.mozFullScreenElement || 
                                 doc.webkitFullscreenElement || 
                                 doc.msFullscreenElement)) {
    exitFS.call(doc);
  }
} 