import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDegauss, degaussStrength, DEGAUSS_DURATION } from '../src/js/degauss.js';

function fixture(
  reduced = false,
  options: { storage?: Pick<Storage, 'getItem' | 'setItem'>; accountId?: () => string | null } = {},
) {
  vi.useFakeTimers();
  const attributes = new Map<string, string>();
  const classes = new Set<string>();
  const styles = new Map<string, string>();
  const local = new Map<string, string>();
  const storage = options.storage ?? {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => { local.set(key, value); },
  };
  const button = Object.assign(new EventTarget(), {
    title: '', setAttribute: (key: string, value: string) => attributes.set(key, value),
  });
  const screen = {
    style: {
      setProperty: (key: string, value: string) => styles.set(key, value),
      removeProperty: (key: string) => styles.delete(key),
    },
    classList: {
      add: (...names: string[]) => names.forEach(n => classes.add(n)),
      remove: (...names: string[]) => names.forEach(n => classes.delete(n)),
      toggle: (name: string, enabled: boolean) =>
        enabled ? classes.add(name) : classes.delete(name),
    },
  };
  const power = Object.assign(new EventTarget(), { checked: true });
  const audio = { play: vi.fn(() => Promise.resolve()), pause: vi.fn(), currentTime: 0, volume: 1 };
  const status = { textContent: '' };
  const controller = createDegauss({
    button: button as unknown as HTMLButtonElement,
    screen: screen as unknown as HTMLElement,
    power: power as unknown as HTMLInputElement,
    audio: audio as unknown as HTMLAudioElement,
    status: status as HTMLElement,
  }, { matches: reduced }, { ...options, storage });
  const click = () => button.dispatchEvent(new Event('click'));
  return { controller, click, power, audio, status, classes, styles, attributes };
}

afterEach(() => vi.useRealTimers());

describe('CRT degauss lifecycle', () => {
  it('runs once per activation and restores presentation after 2.6 seconds', () => {
    const f = fixture();
    f.click(); f.click(); f.controller.activate();
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.classes.has('degaussing')).toBe(true);
    expect(f.attributes.get('aria-disabled')).toBe('true');
    vi.advanceTimersByTime(DEGAUSS_DURATION);
    expect(f.classes.size).toBe(0);
    expect(f.audio.currentTime).toBe(0);
    expect(f.attributes.get('aria-disabled')).toBe('false');
    expect(f.status.textContent).toBe('Display ready');
    f.click();
    expect(f.audio.play).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });

  it('cancels on power off and refuses activation until powered on', () => {
    const f = fixture();
    f.click();
    f.power.checked = false;
    f.power.dispatchEvent(new Event('change'));
    expect(f.classes.size).toBe(0);
    expect(f.audio.pause).toHaveBeenCalled();
    f.click();
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEGAUSS_DURATION);
    expect(f.status.textContent).toBe('');
    f.power.checked = true;
    f.controller.sync();
    expect(f.attributes.get('aria-disabled')).toBe('false');
    f.controller.dispose();
  });

  it('selects the restrained reduced-motion treatment', () => {
    const f = fixture(true);
    f.click();
    expect(f.classes.has('degauss-reduced')).toBe(true);
    f.controller.cancel();
    expect(f.classes.size).toBe(0);
    f.controller.dispose();
  });

  it('finishes despite rejected or synchronously failing media playback', async () => {
    const f = fixture();
    f.audio.play.mockRejectedValueOnce(new Error('NotAllowedError'));
    f.click();
    await Promise.resolve();
    vi.advanceTimersByTime(DEGAUSS_DURATION);
    expect(f.classes.size).toBe(0);
    f.audio.play.mockImplementationOnce(() => { throw new Error('Unavailable'); });
    f.click();
    expect(f.classes.has('degaussing')).toBe(true);
    vi.advanceTimersByTime(DEGAUSS_DURATION);
    expect(f.attributes.get('aria-busy')).toBe('false');
    f.controller.dispose();
  });

  it('cleans up timers and listeners and stops late playback after teardown', async () => {
    const f = fixture();
    let resolve!: () => void;
    f.audio.play.mockReturnValueOnce(new Promise<void>(r => { resolve = r; }));
    f.click();
    f.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    f.click();
    f.controller.activate();
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    expect(f.audio.pause).toHaveBeenCalledTimes(2);
    expect(f.classes.size).toBe(0);
  });
});

describe('degauss history and strength', () => {
  it('scales audio with visual recovery and caps it at the existing maximum', () => {
    const f = fixture();
    f.click();
    expect(f.audio.volume).toBe(0.45);
    f.controller.cancel();
    f.click();
    const immediate = f.audio.volume;
    expect(immediate).toBeCloseTo(0.45 * 0.04);
    f.controller.cancel();
    vi.advanceTimersByTime(3 * 60_000);
    f.click();
    expect(f.audio.volume).toBeGreaterThan(immediate);
    expect(f.audio.volume).toBeLessThan(0.45);
    expect(f.audio.volume).toBeCloseTo(0.45 * Number(f.styles.get('--degauss-strength')));
    f.controller.cancel();
    vi.advanceTimersByTime(10 * 60_000);
    f.click();
    expect(f.audio.volume).toBe(0.45);
    f.controller.cancel();
    vi.advanceTimersByTime(90 * 60_000);
    f.click();
    expect(f.audio.volume).toBe(0.45);
    f.controller.dispose();
  });

  it('is fully charged on first use, barely moves after seconds, modest after minutes, max at ten minutes', () => {
    const now = 1_000_000;
    expect(degaussStrength(null, now)).toBe(1);
    expect(degaussStrength(now - 5_000, now)).toBeLessThan(0.06);
    expect(degaussStrength(now - 3 * 60_000, now)).toBeGreaterThan(0.2);
    expect(degaussStrength(now - 3 * 60_000, now)).toBeLessThan(0.35);
    expect(degaussStrength(now - 10 * 60_000, now)).toBe(1);
    expect(degaussStrength(now - 90 * 60_000, now)).toBe(1);
    expect(degaussStrength(now + 60_000, now)).toBe(0.04);
    expect(degaussStrength(NaN, now)).toBe(1);
    expect(degaussStrength(-1, now)).toBe(1);
  });

  it('records accepted triggers only, restores count across controller reload, and scopes accounts', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    };
    let id: string | null = 'account-1';
    const options = { storage, accountId: () => id };
    const first = fixture(false, options);
    first.click(); first.click();
    expect(first.styles.get('--degauss-strength')).toBe('1');
    expect(JSON.parse(data.get('fwf-degauss-v1:account-1')!)).toMatchObject({ count: 1 });
    first.controller.dispose();
    const reloaded = fixture(false, options);
    reloaded.click();
    expect(Number(reloaded.styles.get('--degauss-strength'))).toBe(0.04);
    expect(reloaded.audio.volume).toBeCloseTo(0.018);
    expect(JSON.parse(data.get('fwf-degauss-v1:account-1')!)).toMatchObject({ count: 2 });
    reloaded.controller.cancel();
    id = 'account-2';
    reloaded.click();
    expect(reloaded.styles.get('--degauss-strength')).toBe('1');
    expect(reloaded.audio.volume).toBe(0.45);
    reloaded.controller.cancel();
    id = null;
    reloaded.click();
    expect(data.has('fwf-degauss-v1:browser')).toBe(true);
    reloaded.controller.dispose();
  });

  it('clamps future timestamps and resets invalid persisted data', () => {
    const data = new Map<string, string>([
      ['fwf-degauss-v1:browser', JSON.stringify({ count: 3, lastAt: Date.now() + 60_000 })],
    ]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    };
    const f = fixture(false, { storage });
    f.click();
    expect(f.styles.get('--degauss-strength')).toBe('0.04');
    expect(JSON.parse(data.get('fwf-degauss-v1:browser')!)).toMatchObject({ count: 4 });
    f.controller.cancel();
    for (const corrupt of ['not json', '{"count":-1,"lastAt":30}', '{"count":5,"lastAt":"bad"}']) {
      data.set('fwf-degauss-v1:browser', corrupt);
      f.click();
      expect(f.styles.get('--degauss-strength')).toBe('1');
      expect(JSON.parse(data.get('fwf-degauss-v1:browser')!)).toMatchObject({ count: 1 });
      f.controller.cancel();
    }
    f.controller.dispose();
  });

  it('keeps in-tab cadence and reports unavailable local storage', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    const f = fixture(false, { storage });
    f.click();
    expect(f.status.textContent).toContain('history unavailable');
    f.controller.cancel();
    f.click();
    expect(f.styles.get('--degauss-strength')).toBe('0.04');
    f.controller.dispose();
  });
});