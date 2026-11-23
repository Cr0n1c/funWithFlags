import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { errors, type Browser, type Page, type Request, type Route } from 'playwright';
import { configureOfflineTimeouts, startupDiagnostics } from './startup-diagnostics.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const request = (resourceType: string) => ({
  resourceType: () => resourceType,
  // Reading these is itself a regression, even if later redacted.
  url: () => { throw new Error('Do not read URLs'); },
  postData: () => { throw new Error('Do not read payloads'); },
  headers: () => { throw new Error('Do not read headers'); },
}) as unknown as Request;
const route = (resourceType: string) => ({
  request: () => request(resourceType),
}) as unknown as Route;

it('preserves separate action and navigation deadlines instead of inheriting the action budget', () => {
  const page = { setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn() };
  configureOfflineTimeouts(page);
  expect(page.setDefaultTimeout.mock.calls).toEqual([[8_000]]);
  expect(page.setDefaultNavigationTimeout.mock.calls).toEqual([[30_000]]);
});

it('bounds reports during an indefinitely stalled browser and removes its timer', () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const startup = startupDiagnostics(emit);
  startup.phase('navigation');
  vi.advanceTimersByTime(120_000);
  expect(emit).toHaveBeenCalledTimes(3);
  startup.stop('failed');
  startup.stop('failed');
  vi.advanceTimersByTime(120_000);
  expect(emit).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
  expect(emit.mock.calls.every(([line]) => (line as string).length < 2_000)).toBe(true);
});

it('records lifecycle and counts without reading or serializing request data', async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const page = new EventEmitter();
  const startup = startupDiagnostics(line => lines.push(line));
  startup.attach(page as unknown as Page);
  startup.phase('routes');
  const handled = vi.fn().mockResolvedValue('unchanged result');
  expect(await startup.route(handled)(route('document'))).toBe('unchanged result');
  page.emit('request', request('document'));
  page.emit('requestfinished', request('document'));
  page.emit('request', request('private-unrecognized-type'));
  page.emit('requestfailed', request('private-unrecognized-type'));
  page.emit('console', { text: 'private-console' });
  page.emit('pageerror', new Error('private-error'));
  page.emit('domcontentloaded');
  page.emit('crash');
  startup.stop('failed');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"document":{"requested":1,"finished":1,"failed":0,"routing":0,"routed":1');
  expect(lines[0]).toContain('"other":{"requested":1,"finished":0,"failed":1');
  expect(lines[0]).toContain('"domcontentloaded":0');
  expect(lines[0]).toContain('"crash":0');
  expect(lines[0]).not.toContain('private-');
  expect(page.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('distinguishes a pending route from browser loading and sanitizes route errors', async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const startup = startupDiagnostics(line => lines.push(line));
  let release!: () => void;
  const pending = startup.route(() => new Promise<void>(resolve => { release = resolve; }))(route('media'));
  vi.advanceTimersByTime(10_000);
  expect(lines[0]).toContain('"media":{"requested":0,"finished":0,"failed":0,"routing":1,"routed":0');
  release();
  await pending;
  await expect(startup.route(() => Promise.reject(new Error('private-route-error')))(route('script')))
    .rejects.toThrow('Offline fixture route failed');
  startup.stop('failed');
  expect(lines[1]).toContain('"routeErrors":1');
  expect(lines[1]).toContain('"maxRouteMs":10000');
  expect(lines.join('')).not.toContain('private-route-error');
});

it('stays quiet for fast success, passes later routes through, and isolates collectors', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '');
  const emit = vi.fn();
  const first = startupDiagnostics(emit);
  await first.route(async () => {})(route('font'));
  first.stop('loaded');
  expect(emit).not.toHaveBeenCalled();
  const later = vi.fn().mockResolvedValue(undefined);
  await first.route(later)(route('fetch'));
  expect(later).toHaveBeenCalledOnce();
  const second = startupDiagnostics(emit);
  second.stop('failed');
  expect(emit).toHaveBeenCalledOnce();
  expect(emit.mock.calls[0]?.[0]).toContain('"font":{"requested":0,"finished":0,"failed":0,"routing":0,"routed":0');
  expect(vi.getTimerCount()).toBe(0);
});

it('reports opt-in successful startup without retaining listeners', () => {
  vi.useFakeTimers();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '1');
  const emit = vi.fn();
  const page = new EventEmitter();
  const startup = startupDiagnostics(emit);
  startup.attach(page as unknown as Page);
  page.emit('load');
  startup.stop('loaded');
  expect(emit).toHaveBeenCalledOnce();
  expect(emit.mock.calls[0]?.[0]).toContain('"load":0');
  expect(page.eventNames()).toEqual([]);
});

it.each(['context', 'page', 'navigation'] as const)('fails %s once without retrying or leaking the error', async phase => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const startup = startupDiagnostics(line => lines.push(line));
  const browser = new EventEmitter();
  startup.attachBrowser(browser as unknown as Browser);
  browser.emit('disconnected');
  const operation = vi.fn().mockRejectedValue(new errors.TimeoutError('private-url-and-credentials'));
  await expect(startup.step(phase, operation))
    .rejects.toThrow(`Offline terminal startup failed during ${phase}: timeout`);
  expect(operation).toHaveBeenCalledOnce();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"failure":"timeout"');
  expect(lines[0]).toContain('"disconnected":0');
  expect(lines[0]).not.toContain('private-');
  expect(browser.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('records a scheduler stall even when navigation settles before a timer can fire', () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const emit = vi.fn();
  const startup = startupDiagnostics(emit);
  clock.mockReturnValue(12_000);
  startup.stop('failed');
  expect(emit.mock.calls[0]?.[0]).toContain('"maxSchedulerLagMs":11000');
});
