import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

describe('CMOS terminal clock', () => {
  it('starts at epoch on failure and advances with uptime', async () => {
    vi.resetModules();
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { banner, terminalDate } = await import('../src/js/config/content.js');
    expect(banner).toContain('CMOS Battery ....................... FAILED');
    expect(terminalDate()).toBe('01/01/1970 00:00:00');
    monotonic.mockReturnValue(66000);
    expect(terminalDate()).toBe('01/01/1970 00:01:05');
    expect(new Date().getFullYear()).toBeGreaterThan(1970);
  });

  it('keeps the real local clock when the battery is OK', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T17:29:28Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { banner, terminalDate } = await import('../src/js/config/content.js');
    expect(banner).toContain('CMOS Battery ....................... OK');
    expect(terminalDate()).toBe(new Date().toLocaleString());
    vi.advanceTimersByTime(60000);
    expect(terminalDate()).toBe(new Date().toLocaleString());
  });
});