import '@csstools/normalize.css';
import '../sass/main.scss';
import '../sass/terminal.scss';

import $ from 'jquery';
import { init } from './init.js';
import { initCursor } from './terminal/cursor.js';
import { bootShell, showWelcomeMessage } from './terminal/terminal.js';
import { handleClick, theme, fullscreen, globalListener } from './handlers/globalHandlers.js';
import { getCurrentUser, getHomeRoster, initializeAuth, requireAuthentication } from './services/authService.js';
import { describeError } from './services/api.js';
import { createDegauss } from './degauss.js';
import { plantBrowserChallenge } from './browserChallenge.js';
import { installIdleMatrix } from './terminal/idleMatrix.js';
import { blockPageContextMenu, blockSourceShortcut, createSourcePuzzle, SOURCE_PUZZLE_EVENT } from './terminal/sourcePuzzle.js';

const sourcePuzzle = createSourcePuzzle(
  () => getCurrentUser()?.account_id ?? null,
  (message) => {
    const output = document.getElementById('terminal-output');
    if (!output) throw new Error('Terminal output unavailable');
    const notice = document.createElement('div');
    notice.setAttribute('role', 'status');
    notice.style.whiteSpace = 'pre-wrap';
    notice.textContent = `\n${message}\n\n`;
    output.appendChild(notice);
    notice.scrollIntoView({ block: 'nearest' });
  },
);
const revealSourcePuzzle = () => sourcePuzzle.trigger();
const terminalContextMenu = (event: MouseEvent) => {
  blockPageContextMenu(event, getCurrentUser()?.groups);
};
const sourceShortcut = (event: KeyboardEvent) => blockSourceShortcut(event, getCurrentUser()?.groups);
window.addEventListener(SOURCE_PUZZLE_EVENT, revealSourcePuzzle);
document.addEventListener('contextmenu', terminalContextMenu, true);
window.addEventListener('keydown', sourceShortcut, true);

let degauss: ReturnType<typeof createDegauss> | undefined;

if (!plantBrowserChallenge()) {
  console.warn('Browser-storage challenge unavailable: local storage is blocked.');
}

declare global {
  interface Window {
    theme: typeof theme;
    handleClick: typeof handleClick;
    fullscreen: typeof fullscreen;
    $: typeof $;
    jQuery: typeof $;
  }
}

// Legacy globals for anything still poking at window.$ from the markup.
window.$ = $;
window.jQuery = $;

// Set a cookie to store prefs
export const createCookie = (name: string, value: string, days?: number): void => {
  let expires = '';
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = `; expires=${date.toUTCString()}`;
  }
  document.cookie = `${name}=${value}${expires}; path=/; SameSite=Lax`;
};

// Get a cookie to read prefs
export const readCookie = (name: string): string | null => {
  const nameEQ = `${name}=`;
  const ca = document.cookie.split(';');
  for (let c of ca) {
    while (c.charAt(0) === ' ') c = c.substring(1);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length);
  }
  return null;
};

// Remove a cookie
export const eraseCookie = (name: string): void => {
  createCookie(name, '', -1);
};

document.addEventListener('DOMContentLoaded', init);
initCursor();

let terminalStarted = false;
let startingTerminal = false;
let disposeIdleMatrix: (() => void) | undefined;
async function resumeTerminal(postLoginMessage: string | null = null): Promise<void> {
  const user = getCurrentUser();
  if (!user || startingTerminal) return;
  startingTerminal = true;
  try {
    const roster = await getHomeRoster();
    await bootShell(roster);
    if (!terminalStarted) await showWelcomeMessage(postLoginMessage);
    terminalStarted = true;
  } catch (error) {
    const output = document.getElementById('terminal-output');
    if (output) {
      output.textContent = `Unable to load your private home directory: ${describeError(error)}`;
    }
  } finally {
    startingTerminal = false;
  }
  if (!terminalStarted) return;
  const wrapper = document.getElementById('terminal-input-wrapper');
  const input = document.getElementById('terminal-input');
  if (wrapper) wrapper.hidden = false;
  if (input) {
    input.contentEditable = 'true';
    input.focus();
  }
  sourcePuzzle.bootComplete();
  disposeIdleMatrix ??= installIdleMatrix();
}

// Resolve identity once after startup or the same-window Okta callback.
void initializeAuth().then((message) => {
  if (getCurrentUser()) return resumeTerminal(message);
  requireAuthentication(message);
});

document.addEventListener('keydown', globalListener);

// Define some stuff on the window so we can use it directly from the HTML
Object.assign(window, {
  theme,
  handleClick,
  fullscreen,
});

const playSound = (id: string): void => {
  const el = document.getElementById(id);
  if (el instanceof HTMLAudioElement) {
    el.play().catch((e: unknown) => console.warn(`Sound ${id} blocked:`, e));
  }
};

// Helper for toggling CRT screen power effect
const powerOn = (sound = true): void => {
  if (sound) playSound('snd_power_on');
  $('#switch').prop('checked', true);
  degauss?.sync();
  $('.surround').addClass('on');
  createCookie('power', '1');
};

const powerOff = (sound = true): void => {
  if (sound) playSound('snd_power_off');
  $('#switch').prop('checked', false);
  degauss?.sync();
  $('.surround').removeClass('on');
  createCookie('power', '0');
};

const togglePower = (): void => {
  if ($('#switch').prop('checked')) {
    powerOff();
  } else {
    powerOn();
  }
};

// Helper for toggling CRT screen flickering effect
const scanlinesOn = (): void => {
  $('#flicker').prop('checked', true);
  $('.crt-effects').addClass('scanlines');
  $('.power-label').addClass('btn-scanlines');
  createCookie('flicker', '1');
};

const scanlinesOff = (): void => {
  $('#flicker').prop('checked', false);
  $('.crt-effects').removeClass('scanlines');
  $('.power-label').removeClass('btn-scanlines');
  createCookie('flicker', '0');
};

const toggleScanlines = (): void => {
  if ($('#flicker').is(':checked')) {
    scanlinesOff();
  } else {
    scanlinesOn();
  }
};

// Helper for toggling CRT color theme
const greenTheme = (): void => {
  $('#greenTheme').prop('checked', true);
  $('body').addClass('green');
  createCookie('greenTheme', '1');
};

const amberTheme = (): void => {
  $('#greenTheme').prop('checked', false);
  $('body').removeClass('green');
  createCookie('greenTheme', '0');
};

const toggleTheme = (): void => {
  if ($('#greenTheme').is(':checked')) {
    amberTheme();
  } else {
    greenTheme();
  }
};

const readPrefs = (): void => {
  const cookiePower = readCookie('power');
  const cookieFlicker = readCookie('flicker');
  const cookieGreenTheme = readCookie('greenTheme');

  if (cookiePower === '0') { powerOff(false); } else { powerOn(false); }
  if (cookieFlicker === '1') { scanlinesOn(); } else { scanlinesOff(); }
  if (cookieGreenTheme === '0') { amberTheme(); } else { greenTheme(); }
};

$(() => {
  readPrefs(); // Read site preferences (flicker, colour, etc.)
  degauss = createDegauss({
    button: document.getElementById('degauss-button') as HTMLButtonElement,
    screen: document.querySelector('.terminal') as HTMLElement,
    power: document.getElementById('switch') as HTMLInputElement,
    audio: document.getElementById('snd_degauss') as HTMLAudioElement,
    status: document.getElementById('degauss-status') as HTMLElement,
  }, undefined, { accountId: () => getCurrentUser()?.account_id ?? null });
  window.addEventListener('pagehide', () => degauss?.cancel());

  // Design element toggles
  $('.surround').on('click', togglePower);
  $('.power-label').on('click', toggleScanlines);
  $('.theme-button').on('click', toggleTheme);
});

if (import.meta.hot) import.meta.hot.dispose(() => degauss?.dispose());
if (import.meta.hot) import.meta.hot.dispose(() => {
  disposeIdleMatrix?.();
  window.removeEventListener(SOURCE_PUZZLE_EVENT, revealSourcePuzzle);
  document.removeEventListener('contextmenu', terminalContextMenu, true);
  window.removeEventListener('keydown', sourceShortcut, true);
});
