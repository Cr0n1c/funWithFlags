import { captureTerminalOwnership, onTerminalRetired } from './lifecycle.js';

/** Local visual easter egg: no network, shell execution, or persisted state. */
export async function showMatrix(ownsTerminal = captureTerminalOwnership()): Promise<void> {
  // The text area is padded, scrollable and narrower than the CRT. Mount at
  // page level so the canvas fills the glass underneath the fixed bezel.
  const host = document.body;
  const output = document.getElementById('terminal-output');
  const wrapper = document.getElementById('terminal-input-wrapper');
  if (!host || !output || !wrapper) throw new Error('Matrix display is unavailable');
  const screen = document.createElement('div');
  screen.className = 'matrix-screen';
  screen.tabIndex = -1;
  screen.setAttribute('role', 'region');
  screen.setAttribute('aria-label', 'Matrix digital rain. Press Escape to return to the prompt.');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Matrix requires canvas support');
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = 'ESC · Return to prompt';
  screen.append(canvas, exit);
  const outputHidden = output.hidden;
  const wrapperHidden = wrapper.hidden;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const stopRetirement = onTerminalRetired(() => {
    screen.remove();
    finish();
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape' || (event.ctrlKey && event.key.toLowerCase() === 'c')) finish();
  };
  const glyphs = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789';
  const cell = 20;
  let width = 0;
  let height = 0;
  let drops: number[] = [];
  let frame = 0;
  let last = 0;
  let trailColor = '';
  let headColor = '';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const draw = () => {
    context.fillStyle = 'rgba(0, 0, 0, 0.12)';
    context.fillRect(0, 0, width, height);
    context.font = `${cell - 3}px monospace`;
    drops.forEach((y, column) => {
      const x = column * cell;
      context.fillStyle = trailColor;
      context.fillText(glyphs[Math.floor(Math.random() * glyphs.length)]!, x, y - cell);
      context.fillStyle = headColor;
      context.fillText(glyphs[Math.floor(Math.random() * glyphs.length)]!, x, y);
      drops[column] = y > height + cell && Math.random() > 0.97 ? -cell : y + cell;
    });
  };
  const resize = () => {
    const theme = getComputedStyle(screen);
    trailColor = theme.getPropertyValue('--primary-color-dark').trim();
    headColor = theme.getPropertyValue('--primary-color').trim();
    width = screen.clientWidth;
    height = screen.clientHeight;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    drops = Array.from({ length: Math.ceil(width / cell) },
      () => Math.floor(Math.random() * height / cell) * cell);
    // Start with visible trails; reduced-motion visitors get this static frame.
    for (let i = 0; i < 16; i++) draw();
  };
  const tick = (time: number) => {
    if (!reducedMotion.matches && time - last >= 65) {
      draw();
      last = time;
    }
    frame = requestAnimationFrame(tick);
  };
  const observer = new ResizeObserver(resize);
  // Theme buttons change the body's class. Repaint existing trails immediately,
  // including the static frame used for reduced-motion visitors.
  const themeObserver = new MutationObserver(resize);
  try {
    host.append(screen);
    output.hidden = true;
    wrapper.hidden = true;
    screen.focus();
    exit.addEventListener('click', finish);
    document.addEventListener('keydown', onKey, true);
    resize();
    observer.observe(screen);
    themeObserver.observe(host, { attributes: true, attributeFilter: ['class'] });
    frame = requestAnimationFrame(tick);
    await done;
  } finally {
    stopRetirement();
    cancelAnimationFrame(frame);
    observer.disconnect();
    themeObserver.disconnect();
    document.removeEventListener('keydown', onKey, true);
    exit.removeEventListener('click', finish);
    screen.remove();
    if (ownsTerminal()) {
      output.hidden = outputHidden;
      wrapper.hidden = wrapperHidden;
      document.getElementById('terminal-input')?.focus();
    }
  }
}
