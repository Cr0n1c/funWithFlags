import '@csstools/normalize.css';
import '../sass/main.scss';
import '../sass/terminal.scss';

import $ from 'jquery';
import { init } from './init.js';
import { initCursor } from './terminal/cursor.js';
import { bootShell, showWelcomeMessage } from './terminal/terminal.js';
import { handleClick, theme, fullscreen, globalListener } from './handlers/globalHandlers.js';
import { initializeAuth } from './services/authService.js';

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

// Restore the session first so the banner can greet a freshly logged-in player.
void initializeAuth().then((postLoginMessage) => showWelcomeMessage(postLoginMessage));
// Warm the HP-UX sandbox (IndexedDB restore or first seed) while the banner plays.
void bootShell();

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
  $('.surround').addClass('on');
  createCookie('power', '1');
};

const powerOff = (sound = true): void => {
  if (sound) playSound('snd_power_off');
  $('#switch').prop('checked', false);
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

  // Design element toggles
  $('.surround').on('click', togglePower);
  $('.power-label').on('click', toggleScanlines);
  $('.theme-button').on('click', toggleTheme);
});
