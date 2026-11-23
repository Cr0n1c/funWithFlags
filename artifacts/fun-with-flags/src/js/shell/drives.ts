/**
 * Removable-media theatre. When a command touches the floppy or CD-ROM, we make the player wait
 * like it's 1999 and synthesise the drive noises with the Web Audio API. No audio assets needed.
 */

import { normalizePath } from './hpux.js';

export type Drive = 'floppy' | 'cdrom';

const FLOPPY_PATHS = ['/floppy', '/dev/floppy', '/dev/rfloppy'];
const CDROM_PATHS = ['/cdrom', '/SD_CDROM', '/dev/dsk/c1t2d0', '/dev/rdsk/c1t2d0'];

function under(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

/** Which drive, if any, a command line will spin up. Checks every argument and the cwd. */
export function detectDrive(command: string, cwd: string): Drive | null {
  const tokens = command.split(/\s+/).filter((t) => t && !t.startsWith('-') && t !== '|');
  const candidates = [cwd, ...tokens.slice(1).map((t) => normalizePath(t.replace(/^["']|["']$/g, ''), cwd))];
  // `cd /` from inside the cdrom should not spin the drive; only real accesses count.
  const word = tokens[0]?.toLowerCase() ?? '';
  const paths = word === 'cd' ? candidates.slice(1) : candidates;
  if (paths.some((p) => under(p, FLOPPY_PATHS))) return 'floppy';
  if (paths.some((p) => under(p, CDROM_PATHS))) return 'cdrom';
  return null;
}

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  audioCtx ??= new AudioContext();
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

function noiseBuffer(ac: AudioContext, seconds: number): AudioBuffer {
  const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * seconds), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** A short filtered noise burst: the "clack" of a stepper motor or a head seek. */
function click(ac: AudioContext, at: number, gainValue: number, freq: number, length = 0.03): void {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, length);
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 2;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(gainValue, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(at);
  src.stop(at + length);
}

function floppySound(ac: AudioContext, seconds: number): void {
  const t0 = ac.currentTime;
  // Spindle motor: a low buzz that fades in and out.
  const motor = ac.createOscillator();
  motor.type = 'sawtooth';
  motor.frequency.value = 95;
  const motorGain = ac.createGain();
  motorGain.gain.setValueAtTime(0.0001, t0);
  motorGain.gain.exponentialRampToValueAtTime(0.03, t0 + 0.2);
  motorGain.gain.setValueAtTime(0.03, t0 + seconds - 0.25);
  motorGain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
  motor.connect(motorGain).connect(ac.destination);
  motor.start(t0);
  motor.stop(t0 + seconds);
  // Head stepper: irregular bursts of clicks while it hunts for the track.
  let t = t0 + 0.3;
  while (t < t0 + seconds - 0.2) {
    const burst = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < burst; i += 1) {
      click(ac, t, 0.25, 1800 + Math.random() * 600, 0.025);
      t += 0.055;
    }
    t += 0.15 + Math.random() * 0.35;
  }
}

function cdromSound(ac: AudioContext, seconds: number): void {
  const t0 = ac.currentTime;
  // Tray/clamp thunk.
  click(ac, t0 + 0.05, 0.5, 300, 0.08);
  // Spin-up whine: rising pitch that settles, then a couple of seek chirps.
  const whine = ac.createOscillator();
  whine.type = 'triangle';
  whine.frequency.setValueAtTime(180, t0 + 0.2);
  whine.frequency.exponentialRampToValueAtTime(2400, t0 + Math.min(1.8, seconds * 0.6));
  const whineGain = ac.createGain();
  whineGain.gain.setValueAtTime(0.0001, t0 + 0.2);
  whineGain.gain.exponentialRampToValueAtTime(0.04, t0 + 0.6);
  whineGain.gain.setValueAtTime(0.04, t0 + seconds - 0.4);
  whineGain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
  const air = ac.createBufferSource();
  air.buffer = noiseBuffer(ac, seconds);
  const airFilter = ac.createBiquadFilter();
  airFilter.type = 'highpass';
  airFilter.frequency.value = 3000;
  const airGain = ac.createGain();
  airGain.gain.setValueAtTime(0.0001, t0);
  airGain.gain.exponentialRampToValueAtTime(0.02, t0 + 1.2);
  airGain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
  whine.connect(whineGain).connect(ac.destination);
  air.connect(airFilter).connect(airGain).connect(ac.destination);
  whine.start(t0 + 0.2);
  whine.stop(t0 + seconds);
  air.start(t0);
  air.stop(t0 + seconds);
  let t = t0 + Math.min(1.9, seconds * 0.65);
  while (t < t0 + seconds - 0.2) {
    click(ac, t, 0.15, 900, 0.04);
    t += 0.35 + Math.random() * 0.4;
  }
}

const DURATIONS: Record<Drive, [number, number]> = { floppy: [1.8, 3.2], cdrom: [2.5, 4.5] };

/** Play the drive noise and resolve when the "media" is ready. */
export async function accessDrive(drive: Drive): Promise<void> {
  const [min, max] = DURATIONS[drive];
  const seconds = min + Math.random() * (max - min);
  const ac = ctx();
  if (ac) {
    try {
      (drive === 'floppy' ? floppySound : cdromSound)(ac, seconds);
    } catch (error) {
      console.warn('Drive sound failed:', error);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export function driveNotice(drive: Drive): string {
  return drive === 'floppy' ? '    [floppy drive seeking...]' : '    [CD-ROM spinning up...]';
}
