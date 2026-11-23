import { captureTerminalOwnership, onTerminalRetired } from './lifecycle.js';

import { TRAIN } from '../shell/train.js';

/** The HTML terminal cannot interpret the bundled sl command's ANSI frames. */
export async function showTrain(ownsTerminal = captureTerminalOwnership()): Promise<void> {
  const host = document.querySelector<HTMLElement>('.terminal-content-inner');
  const output = document.getElementById('terminal-output');
  const wrapper = document.getElementById('terminal-input-wrapper');
  if (!host || !output || !wrapper) throw new Error('Train display is unavailable');
  const outputHidden = output.hidden;
  const wrapperHidden = wrapper.hidden;
  const screen = document.createElement('div');
  screen.className = 'sl-screen';
  screen.setAttribute('role', 'status');
  screen.setAttribute('aria-label', 'Steam locomotive');
  const train = document.createElement('pre');
  train.textContent = TRAIN;
  screen.appendChild(train);
  host.appendChild(screen);
  output.hidden = true;
  wrapper.hidden = true;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const stopRetirement = onTerminalRetired(() => {
    screen.remove();
    finish();
  });
  const onKey = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape' || (event.ctrlKey && event.key.toLowerCase() === 'c')) finish();
  };
  document.addEventListener('keydown', onKey, true);
  let animation: Animation | undefined;
  // Bound lifetime even if animation events are lost in a background tab.
  const timer = setTimeout(() => finish(), 5000);
  try {
    animation = train.animate([
      { transform: `translateX(${screen.clientWidth}px)` },
      { transform: 'translateX(-100%)' },
    ], { duration: 4000, easing: 'linear', fill: 'forwards' });
    void animation.finished.then(finish, finish);
    await done;
  } finally {
    stopRetirement();
    clearTimeout(timer);
    animation?.cancel();
    document.removeEventListener('keydown', onKey, true);
    screen.remove();
    if (ownsTerminal()) {
      output.hidden = outputHidden;
      wrapper.hidden = wrapperHidden;
    }
  }
}