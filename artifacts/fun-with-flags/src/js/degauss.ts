export const DEGAUSS_DURATION = 2600;
const RECOVERY_MS = 10 * 60 * 1000;
const STORAGE_PREFIX = 'fwf-degauss-v1:';

interface DegaussHistory {
  count: number;
  lastAt: number;
}

/** A first use is fully charged; subsequent uses recover smoothly over ten minutes. */
export function degaussStrength(lastAt: number | null, now: number): number {
  if (lastAt === null || !Number.isFinite(lastAt) || lastAt < 0) return 1;
  const elapsed = Math.min(RECOVERY_MS, Math.max(0, now - lastAt));
  return 0.04 + 0.96 * Math.pow(elapsed / RECOVERY_MS, 1.2);
}

interface DegaussElements {
  button: HTMLButtonElement;
  screen: HTMLElement;
  power: HTMLInputElement;
  audio: HTMLAudioElement;
  status: HTMLElement;
}

interface DegaussOptions {
  accountId?: () => string | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
}

/** Temporary presentation only: never replace terminal nodes or change preferences. */
export function createDegauss(
  { button, screen, power, audio, status }: DegaussElements,
  motion: Pick<MediaQueryList, 'matches'> = window.matchMedia('(prefers-reduced-motion: reduce)'),
  { accountId = () => null, storage, now = Date.now }: DegaussOptions = {},
) {
  let active = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const distortions = screen.ownerDocument?.querySelectorAll<SVGAnimationElement>(
    '#degauss-distortion animate',
  );
  const displacement = screen.ownerDocument?.querySelector<SVGAnimationElement>(
    '#degauss-distortion feDisplacementMap animate',
  );
  let memoryHistory: DegaussHistory | null = null;
  let memoryKey = '';
  let historyUnavailable = false;

  const recordTrigger = (): number => {
    // The backend account ID is immutable; never use names, email or SAML attributes.
    const key = `${STORAGE_PREFIX}${accountId() ?? 'browser'}`;
    if (memoryKey !== key) { memoryHistory = null; memoryKey = key; }
    const time = now();
    let history = memoryHistory;
    try {
      const store = storage ?? window.localStorage;
      const raw = store.getItem(key);
      if (raw !== null) {
        history = null;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && 'count' in parsed && 'lastAt' in parsed) {
            const value = parsed as DegaussHistory;
            if (Number.isSafeInteger(value.count) && value.count >= 0 &&
              Number.isFinite(value.lastAt) && value.lastAt >= 0) {
              history = value;
            }
          }
        } catch { /* Corrupt local history is treated as a first use. */ }
      }
      const strength = degaussStrength(history?.lastAt ?? null, time);
      const next = {
        count: Math.min(Number.MAX_SAFE_INTEGER, (history?.count ?? 0) + 1),
        lastAt: time,
      };
      memoryHistory = next;
      store.setItem(key, JSON.stringify(next));
      historyUnavailable = false;
      return strength;
    } catch {
      // Private browsing or disabled storage: retain this tab's cadence and notify the user.
      const strength = degaussStrength(history?.lastAt ?? null, time);
      memoryHistory = { count: (history?.count ?? 0) + 1, lastAt: time };
      historyUnavailable = true;
      return strength;
    }
  };

  const stopAudio = () => {
    audio.pause();
    try { audio.currentTime = 0; } catch { /* Media may not have loaded. */ }
  };
  const sync = () => {
    button.setAttribute('aria-disabled', String(disposed || active || !power.checked));
    button.setAttribute('aria-busy', String(active));
    button.title = !power.checked ? 'Power on the monitor to degauss' :
      active ? 'Degaussing — please wait' : 'Degauss the CRT display (history stays in this browser, not across devices)';
  };
  const cancel = () => {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    active = false;
    screen.classList.remove('degaussing', 'degauss-reduced');
    screen.style.removeProperty('--degauss-strength');
    distortions?.forEach(animation => animation.endElement?.());
    stopAudio();
    status.textContent = '';
    sync();
  };
  const activate = () => {
    if (disposed || active || !power.checked) return;
    active = true;
    const run = ++generation;
    const strength = recordTrigger();
    screen.style.setProperty('--degauss-strength', String(strength));
    displacement?.setAttribute('values', `0;${82 * strength};${-54 * strength};${36 * strength};${-20 * strength};${9 * strength};0`);
    screen.classList.toggle('degauss-reduced', motion.matches);
    screen.classList.add('degaussing');
    if (!motion.matches) distortions?.forEach(animation => animation.beginElement?.());
    status.textContent = historyUnavailable ? 'Degaussing display (history unavailable in this browser)' : 'Degaussing display';
    sync();
    timer = setTimeout(() => {
      cancel();
      status.textContent = historyUnavailable ? 'Display ready (history unavailable in this browser)' : 'Display ready';
    }, DEGAUSS_DURATION);
    // Playback is requested synchronously within the user's click/keyboard activation.
    // A late play promise must not resurrect audio after cancellation or teardown.
    try {
      audio.volume = 0.45 * strength;
      audio.currentTime = 0;
      void audio.play().then(() => {
        if (run !== generation && !active) stopAudio();
      }).catch(() => { /* Muted/blocked media must not interrupt the effect. */ });
    } catch { /* Browsers without media support still get the visual treatment. */ }
  };
  const powerChanged = () => {
    if (!power.checked) cancel();
    else sync();
  };
  button.addEventListener('click', activate);
  power.addEventListener('change', powerChanged);
  sync();
  return {
    activate, cancel, sync: powerChanged,
    dispose() {
      disposed = true;
      cancel();
      button.removeEventListener('click', activate);
      power.removeEventListener('change', powerChanged);
    },
  };
}