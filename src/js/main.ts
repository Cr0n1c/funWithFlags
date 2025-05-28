import { init } from './init.js';
import { initCursor } from './terminal/cursor.js';
import { showWelcomeMessage } from './terminal/terminal.js';
import { handleClick, theme, fullscreen, globalListener } from './handlers/globalHandlers.js';
import jQuery from 'jquery';

// Declare jQuery and moment to be available globally
declare const moment: any;
declare global {
  interface Window {
    theme: typeof theme;
    handleClick: typeof handleClick;
    fullscreen: typeof fullscreen;
    $: typeof jQuery;
    jQuery: typeof jQuery;
  }
}

const $ = window.$;

// Set a cookie to store prefs
export const createCookie = (name: string, value: string, days?: number): void => {
  let expires = '';
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = `; expires=${date.toUTCString()}`;
  }
  document.cookie = `${name}=${value}${expires}; path=/`;
};

// Get a cookie to read prefs
export const readCookie = (name: string): string | null => {
  const nameEQ = `${name}=`;
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
};

// Remove a cookie
export const eraseCookie = (name: string): void => {
  createCookie(name, '', -1);
};

document.addEventListener('DOMContentLoaded', init);
initCursor();
showWelcomeMessage();

document.addEventListener('keydown', globalListener);

// Define some stuff on the window so we can use it directly from the HTML
Object.assign(window, {
  theme,
  handleClick,
  fullscreen,
});

// Helper for toggling CRT screen power effect
const powerOn = (playSound = true): void => {
  const sndOn = document.getElementById('snd_power_on') as HTMLAudioElement;
  if (playSound && sndOn) sndOn.play().catch(e => console.warn('Power on sound blocked:', e));
  $('#switch').prop('checked', true);
  $('.surround').addClass('on');
  createCookie('power', '1');
};

const powerOff = (playSound = true): void => {
  const sndOff = document.getElementById('snd_power_off') as HTMLAudioElement;
  if (playSound && sndOff) sndOff.play().catch(e => console.warn('Power off sound blocked:', e));
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

// Helper for sorting elements alphabetically
export const sortAlpha = (a: HTMLElement, b: HTMLElement): number => 
  a.innerHTML.toLowerCase() > b.innerHTML.toLowerCase() ? 1 : -1;

// Initialize location services
export const initLocation = (): void => {
  if ('geolocation' in navigator) {
    const options: PositionOptions = {
      enableHighAccuracy: false,
      timeout: 5000,
      maximumAge: 0,
    };

    navigator.geolocation.getCurrentPosition(
      (pos: GeolocationPosition) => {
        // eslint-disable-next-line no-console
        console.log('Your current position is:');
        // eslint-disable-next-line no-console
        console.log(`Latitude : ${pos.coords.latitude}`);
        // eslint-disable-next-line no-console
        console.log(`Longitude: ${pos.coords.longitude}`);
        // eslint-disable-next-line no-console
        console.log(`More or less ${pos.coords.accuracy} meters.`);
      },
      (err: GeolocationPositionError) => {
        // eslint-disable-next-line no-console
        console.warn(`ERROR(${err.code}): ${err.message}`);
      },
      options,
    );
  }
};

const updateTime = (): void => {
  $('#clock').html(moment().format('MM/DD/YYYY h:mm:ss a'));
};

// Generate random text for testing
export const randomgen = (): void => {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@^$_@`';
  let text = '';

  for (let i = 0; i < 1024; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  $('.random').text(`${text}^^EXTRA1KBPAGELOADWHYNOT?`);
};

const readPrefs = (): void => {
  const cookiePower = readCookie('power');
  const cookieFlicker = readCookie('flicker');
  const cookieGreenTheme = readCookie('greenTheme');

  if (cookiePower === '0') { powerOff(false); } else { powerOn(false); }
  if (cookieFlicker === '1') { scanlinesOn(); } else { scanlinesOff(); }
  if (cookieGreenTheme === '0') { amberTheme(); } else { greenTheme(); }
};

$(document).ready((): void => {
  readPrefs(); // Read site preferences (flicker, colour, etc.)
  setInterval(updateTime, 1000); // Update the time every second.

  // Toggle display of tags on smaller breakpoints
  $('.tagsort-toggle').on('click', () => {
    $('.tag-wrap').toggle();
  });

  // Design element toggles
  $('.surround').on('click', togglePower);
  $('.power-label').on('click', toggleScanlines);
  $('.theme-button').on('click', toggleTheme);
}); 