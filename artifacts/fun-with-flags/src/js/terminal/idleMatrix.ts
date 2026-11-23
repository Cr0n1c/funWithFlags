import { getMatrixCompletion } from '../services/ctfService.js';
import { getAuthSessionGeneration, getCurrentUser } from '../services/authService.js';
import { hasGuidedSession } from './flagAdminState.js';
import { hasAdventure } from './games.js';
import { isChallengeModalOpen } from './challengeModal.js';
import { describeError } from '../services/api.js';

const IDLE_MS = 180_000;
const FLAG = 'neo_has_land3d';
type Stage = 'idle' | 'wake' | 'matrix' | 'rabbit' | 'knock' | 'reward';
type Action = 'wake' | 'cut' | 'escape' | 'cancel' | 'dismiss';

let triggerTest: (() => boolean) | undefined;
/** A local, fictional puzzle. Completing it reveals an ordinary submit-able flag. */
export function installIdleMatrix() {
  let stage: Stage = 'idle';
  let solved: boolean | null = null;
  let checking: AbortController | undefined;
  let submissionRefreshPending = false;
  let disposed = false;
  let lastCheck = 0;
  let statusVersion = 0;
  let lastCommandAt = Date.now();
  let account: string | null = null;
  let sessionGeneration = getAuthSessionGeneration();
  let firstName = '';
  let escapes = 0;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let typing: ReturnType<typeof setInterval> | undefined;
  let typingDone = true;
  let audio: AudioContext | undefined;
  let notice: HTMLDivElement | undefined;
  const output = document.getElementById('terminal-output');
  const wrapper = document.getElementById('terminal-input-wrapper');
  const input = document.getElementById('terminal-input');
  if (!output || !wrapper || !input) return () => {};

  const show = (text: string, type = false) => {
    clearInterval(typing);
    output.replaceChildren();
    notice = document.createElement('div');
    notice.className = 'idle-matrix-message';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.setAttribute('aria-atomic', 'true');
    notice.style.whiteSpace = 'pre-wrap';
    output.append(notice);
    // A focusable scroll region lets keyboard users read overflow without
    // sending navigation keys to the shell or progressing the puzzle.
    output.tabIndex = 0;
    output.setAttribute('aria-label', 'Matrix encounter message');
    typingDone = !type;
    if (!type) notice.textContent = text;
    else {
      let index = 0;
      typing = setInterval(() => {
        if (notice) notice.textContent = text.slice(0, ++index);
        if (index >= text.length) {
          clearInterval(typing);
          typingDone = true;
        }
      }, 55);
    }
    document.querySelector('.terminal')?.scrollTo(0, 0);
  };

  const finish = (restore = true) => {
    clearTimeout(phaseTimer);
    clearInterval(typing);
    notice?.remove();
    notice = undefined;
    output.removeAttribute('tabindex');
    output.removeAttribute('aria-label');
    if (audio) void audio.close().catch(() => {});
    audio = undefined;
    stage = 'idle';
    lastCommandAt = Date.now();
    if (restore) {
      output.replaceChildren();
      input.replaceChildren();
      wrapper.hidden = false;
      input.contentEditable = 'true';
      input.focus();
    }
  };

  const unlockAudio = () => {
    try {
      audio ??= new AudioContext();
      void audio.resume().catch(() => {});
    } catch { /* Visual reward remains available if audio is unsupported. */ }
  };
  const knock = () => {
    if (!audio || audio.state !== 'running') return false;
    // Original synthesized wooden double knock; no film recording or request.
    for (const offset of [0, 0.23]) {
      const start = audio.currentTime + offset;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(190, start);
      oscillator.frequency.exponentialRampToValueAtTime(65, start + 0.12);
      gain.gain.setValueAtTime(1, start); // Maximum in-app gain; device volume is untouched.
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.2);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
    return true;
  };
  const eligible = (fromCommand = false) => document.visibilityState === 'visible'
    && !wrapper.hidden && input.contentEditable === 'true'
    && (fromCommand || input.dataset.commandBusy !== 'true') && !input.textContent?.trim()
    && !hasGuidedSession() && !hasAdventure()
    && !isChallengeModalOpen() && !document.querySelector('.matrix-screen, .sl-screen, .vi-screen, .terminal-pager:not(.terminal-pager--finished)')
    && (document.getElementById('switch') as HTMLInputElement | null)?.checked !== false;

  const start = () => {
    syncIdentity();
    const user = getCurrentUser();
    if (!user) return false;
    account = user.account_id;
    firstName = user.first_name?.trim()
      || user.full_name?.trim().split(/\s+/)[0] || user.username;
    stage = 'wake';
    wrapper.hidden = true;
    input.contentEditable = 'false';
    input.blur();
    show(`Wake up, ${firstName}. . .`);
    return true;
  };
  // The command owns the busy flag until its handler returns. All other idle
  // safety gates still apply, and the exported entry point checks awarded solves.
  const trigger = () => stage === 'idle' && eligible(true) && start();
  triggerTest = trigger;

  const cancelCheck = () => {
    const previous = checking;
    checking = undefined;
    previous?.abort();
  };
  const refreshSolved = async () => {
    const owner = getCurrentUser()?.account_id;
    const generation = getAuthSessionGeneration();
    if (!owner || checking || disposed) return;
    const request = new AbortController();
    checking = request;
    submissionRefreshPending = false;
    // Never use an older unsolved result while refreshing, including after a
    // hidden tab returns or when the fresh request fails.
    solved = null;
    const version = statusVersion;
    lastCheck = Date.now();
    try {
      const status = await getMatrixCompletion(request.signal);
      if (!disposed && checking === request && version === statusVersion
          && getAuthSessionGeneration() === generation
          && getCurrentUser()?.account_id === owner) {
        solved = status.solved;
      }
    } catch {
      // Unknown status must not start an encounter; retry on the next check.
      if (!disposed && checking === request && version === statusVersion
          && getAuthSessionGeneration() === generation
          && getCurrentUser()?.account_id === owner) {
        solved = null;
      }
    } finally {
      // A cancelled account's completion must not release its replacement.
      if (checking === request) {
        checking = undefined;
        if (!disposed && version !== statusVersion
            && getAuthSessionGeneration() === generation
            && (submissionRefreshPending || document.visibilityState === 'visible')) {
          void refreshSolved();
        }
      }
    }
  };
  const solveConfirmed = () => {
    statusVersion++;
    solved = null;
    lastCheck = 0;
    submissionRefreshPending = true;
    void refreshSolved();
  };
  document.addEventListener('ctf:solve-confirmed', solveConfirmed);
  const syncIdentity = () => {
    const user = getCurrentUser();
    const generation = getAuthSessionGeneration();
    if ((user?.account_id ?? null) !== account || generation !== sessionGeneration) {
      if (stage !== 'idle') finish(false);
      account = user?.account_id ?? null;
      sessionGeneration = generation;
      statusVersion++;
      submissionRefreshPending = false;
      cancelCheck();
      lastCommandAt = Date.now();
      solved = null;
      lastCheck = 0;
    }
  };
  const tick = () => {
    syncIdentity();
    const user = getCurrentUser();
    if (disposed || stage !== 'idle' || !user || document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck > 30_000 && !checking) void refreshSolved();
    if (solved !== false) return;
    // Defer an overdue encounter until the prompt is safe, without counting
    // mouse movement, scrolling, or an unsubmitted draft as a command.
    if (!eligible()) return;
    if (Date.now() - lastCommandAt > IDLE_MS) {
      start();
    }
  };
  const advance = (action: Action) => {
    if (stage !== 'idle' && stage !== 'reward' && action === 'cancel') {
      finish();
    } else if (stage === 'reward' && action === 'dismiss') {
      finish();
    } else if (stage === 'wake' && action === 'wake') {
      stage = 'matrix';
      show('The Matrix has you. . . ');
    } else if (stage === 'matrix' && action === 'cut') {
      stage = 'rabbit';
      escapes = 0;
      show('Follow the white rabbit.', true);
    } else if (stage === 'rabbit' && typingDone && action === 'escape') {
      if (++escapes !== 2) return;
      stage = 'knock';
      show(`Knock, knock, ${firstName}.`);
      phaseTimer = setTimeout(() => {
        if (getCurrentUser()?.account_id !== account
            || getAuthSessionGeneration() !== sessionGeneration) { finish(false); return; }
        const played = knock();
        stage = 'reward';
        show(`${played ? '' : '[Knock sound unavailable: browser audio is blocked.]\n'}Flag: ${FLAG}\nSubmit this flag for Enter the Matrix (25 points).\nNo time limit. Read or copy the flag, then press Enter or Escape to return to an empty prompt.`);
      }, 5000);
    }
  };
  const activity = (event: Event) => {
    if (stage === 'idle') {
      return;
    }
    if (getCurrentUser()?.account_id !== account
        || getAuthSessionGeneration() !== sessionGeneration) { finish(false); return; }
    const key = event instanceof KeyboardEvent ? event : null;
    if (!key) return;
    key.stopImmediatePropagation();
    if (stage === 'reward') {
      // Keep the untimed reward selectable/copyable. Dismiss deliberately.
      if (key.key === 'Enter' || key.key === 'Escape') {
        key.preventDefault();
        if (!key.repeat) finish();
      }
      return;
    }
    key.preventDefault();
    // Modifier keydowns precede chords; held keys are not additional steps.
    if (key.repeat || ['Control', 'Shift', 'Alt', 'Meta'].includes(key.key)) return;
    if (stage === 'wake') { advance('wake'); return; }
    unlockAudio();
    if (stage === 'matrix' && key.ctrlKey && !key.altKey && !key.metaKey
        && !key.shiftKey && key.key.toLowerCase() === 'x') advance('cut');
    else if (stage === 'rabbit' && typingDone && key.key === 'Escape'
        && !key.ctrlKey && !key.altKey && !key.metaKey && !key.shiftKey) advance('escape');
    else finish(); // No feedback or hint; consume the wrong key, restore prompt.
  };
  const events = ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'wheel', 'input'] as const;
  for (const event of events) window.addEventListener(event, activity, true);
  const commandSubmitted = () => { lastCommandAt = Date.now(); };
  document.addEventListener('terminal:command-submitted', commandSubmitted);
  const heartbeat = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', tick);
    cancelCheck();
    document.removeEventListener('ctf:solve-confirmed', solveConfirmed);
    if (triggerTest === trigger) triggerTest = undefined;
    clearInterval(heartbeat);
    document.removeEventListener('terminal:command-submitted', commandSubmitted);
    for (const event of events) window.removeEventListener(event, activity, true);
    if (stage !== 'idle') finish(getCurrentUser()?.account_id === account
      && getAuthSessionGeneration() === sessionGeneration);
  };
}

/** Replay is unlocked by a server-confirmed solve, never by an admin role. */
export async function startMatrixTest(): Promise<string | null> {
  const account = getCurrentUser()?.account_id;
  const generation = getAuthSessionGeneration();
  const trigger = triggerTest;
  if (!account) return '    Sign in first.';
  let status: Awaited<ReturnType<typeof getMatrixCompletion>>;
  try {
    status = await getMatrixCompletion();
  } catch (error) {
    // A failed check must neither enter from cached state nor reject the
    // keyboard handler's promise. Leave a usable prompt for an explicit retry.
    if (getCurrentUser()?.account_id !== account
        || getAuthSessionGeneration() !== generation) return '    Sign in first.';
    // Completed errors belong to the accepting installer just like successes.
    if (!trigger || triggerTest !== trigger) {
      return '    Matrix test unavailable: return to an empty terminal prompt first.';
    }
    return `    Unable to check Matrix completion: ${describeError(error)}`;
  }
  if (getCurrentUser()?.account_id !== account
      || getAuthSessionGeneration() !== generation) return '    Sign in first.';
  // A response belongs to the installer that accepted the command. Never
  // transfer pending replay work to a replacement terminal on the same account.
  if (!trigger || triggerTest !== trigger) {
    return '    Matrix test unavailable: return to an empty terminal prompt first.';
  }
  if (!status.solved) {
    return '    Complete Enter the Matrix and earn its points to unlock matrix_test.';
  }
  if (!trigger()) {
    return '    Matrix test unavailable: return to an empty terminal prompt first.';
  }
  return null;
}
