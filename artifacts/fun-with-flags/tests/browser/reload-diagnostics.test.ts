import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { errors, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright';
import { reloadWithDiagnostics, startupDiagnostics } from './startup-diagnostics.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixture() {
  const browser = new EventEmitter();
  const page = new EventEmitter();
  const context = { browser: () => browser as unknown as Browser, close: vi.fn() };
  const reload = vi.fn<() => ReturnType<Page['reload']>>();
  Object.assign(page, { context: () => context, reload });
  // Fail on access, not just serialization: collection must never inspect data
  // or change timeouts, storage, routing, ownership, or the browser clock.
  for (const key of [
    'url', 'evaluate', 'content', 'screenshot', 'locator', 'clock', 'close',
    'setDefaultTimeout', 'setDefaultNavigationTimeout', 'route', 'unroute',
  ]) {
    Object.defineProperty(page, key, { get() { throw new Error(`Forbidden page access: ${key}`); } });
  }
  for (const key of ['storageState', 'cookies', 'newPage', 'route', 'unroute']) {
    Object.defineProperty(context, key, { get() { throw new Error(`Forbidden context access: ${key}`); } });
  }
  // Fixture routing must continue to work after the initial startup detaches.
  const startup = startupDiagnostics(() => { throw new Error('Initial collector must stay stopped'); });
  startup.stop('loaded');
  return {
    page: page as unknown as Page,
    events: page,
    browser,
    context,
    reload,
    route: (handler: (route: Route) => Promise<unknown>) =>
      startup.route(handler, context as unknown as BrowserContext),
  };
}

const request = (kind: string) => new Proxy({ resourceType: () => kind }, {
  get(target, key) {
    if (key === 'resourceType') return target.resourceType;
    throw new Error('Forbidden request data access');
  },
}) as unknown as Request;
const route = (kind: string) => ({ request: () => request(kind) }) as Route;
type Emit = ReturnType<typeof vi.fn<(line: string) => void>>;
interface Report {
  phases: Record<string, number>;
  counts: Record<string, Record<string, number>>;
}
const reports = (emit: Emit) =>
  emit.mock.calls.map(([line]) => JSON.parse(line.replace('[offline-startup] ', '')) as Report);

it('keeps a fast reload quiet, returns its response, and preserves caller ownership and listeners', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '');
  const f = fixture();
  const onLoad = vi.fn();
  const onDisconnect = vi.fn();
  f.events.on('load', onLoad);
  f.browser.on('disconnected', onDisconnect);
  const response = {} as Awaited<ReturnType<Page['reload']>>;
  f.reload.mockImplementation(() => {
    f.events.emit('load');
    return Promise.resolve(response);
  });
  const emit = vi.fn<(line: string) => void>();
  expect(await reloadWithDiagnostics(f.page, emit)).toBe(response);
  expect(f.reload.mock.calls).toEqual([[]]); // No changed options, waits, or retries.
  expect(emit).not.toHaveBeenCalled();
  expect(f.context.close).not.toHaveBeenCalled();
  expect(f.events.listeners('load')).toEqual([onLoad]);
  expect(f.events.eventNames()).toEqual(['load']);
  expect(f.browser.listeners('disconnected')).toEqual([onDisconnect]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['timeout', 'error'] as const)('bounds a stalled reload and sanitizes its %s failure without retrying', async failure => {
  vi.useFakeTimers();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '');
  const f = fixture();
  let reject!: (error: unknown) => void;
  f.reload.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const emit = vi.fn<(line: string) => void>();
  const result = reloadWithDiagnostics(f.page, emit).then(
    () => { throw new Error('Expected reload rejection'); },
    error => error as Error,
  );
  const routed = vi.fn().mockResolvedValue('unchanged');
  expect(await f.route(routed)(route('script'))).toBe('unchanged');
  expect(routed).toHaveBeenCalledOnce();
  f.events.emit('request', request('document'));
  f.events.emit('requestfinished', request('document'));
  f.events.emit('request', request('private-resource-kind'));
  f.events.emit('requestfailed', request('private-resource-kind'));
  f.events.emit('console', { text: 'private-terminal-transcript' });
  f.events.emit('pageerror', new Error('private-raw-error'));
  f.events.emit('domcontentloaded');
  f.events.emit('crash');
  f.events.emit('close');
  f.browser.emit('disconnected');
  vi.advanceTimersByTime(120_000);
  expect(emit).toHaveBeenCalledTimes(3);
  const raw = failure === 'timeout'
    ? new errors.TimeoutError('private-url-and-storage')
    : new Error('private-url-and-storage');
  for (const key of ['stack', 'message', 'cause']) {
    Object.defineProperty(raw, key, { get() { throw new Error('Must not inspect raw error'); } });
  }
  reject(raw);
  const error = await result;
  expect(error.message).toBe(`Offline terminal startup failed during reload: ${failure} (see safe startup diagnostics)`);
  expect(error.cause).toBeUndefined();
  expect(f.reload.mock.calls).toEqual([[]]);
  expect(emit).toHaveBeenCalledTimes(4);
  const final = reports(emit).at(-1)!;
  expect(final).toMatchObject({
    phase: 'reload', phases: { reload: 0 }, failure, outcome: 'failed',
    milestones: { domcontentloaded: 0, crash: 0, close: 0, disconnected: 0 },
    counts: {
      document: { requested: 1, finished: 1, failed: 0 },
      script: { routing: 0, routed: 1 },
      other: { requested: 1, failed: 1 },
    },
  });
  expect(Object.keys(final.phases)).toEqual(['reload']);
  expect(emit.mock.calls.every(([line]) => line.length < 2_000 && !line.includes('private-'))).toBe(true);
  expect(f.events.eventNames()).toEqual([]);
  expect(f.browser.eventNames()).toEqual([]);
  expect(f.context.close).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.events.emit('request', request('image'));
  vi.advanceTimersByTime(120_000);
  expect(emit).toHaveBeenCalledTimes(4);
  // Later journey routing passes through untouched, including error identity.
  const laterError = new Error('caller-owned-error');
  await expect(f.route(() => Promise.reject(laterError))(route('fetch'))).rejects.toBe(laterError);
});

it('captures pending and failed fixture routes only during the reload and resets each boundary', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '');
  const f = fixture();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '1');
  const emit = vi.fn<(line: string) => void>();
  let complete!: () => void;
  f.reload.mockImplementation(() => new Promise(resolve => { complete = () => resolve(null); }));
  const first = reloadWithDiagnostics(f.page, emit);
  let release!: () => void;
  const pending = f.route(() => new Promise<void>(resolve => { release = resolve; }))(route('media'));
  vi.advanceTimersByTime(10_000);
  expect(reports(emit)[0]!.counts.media!.routing).toBe(1);
  release();
  await pending;
  await expect(f.route(() => Promise.reject(new Error('private-route-url')))(route('script')))
    .rejects.toThrow('Offline fixture route failed');
  complete();
  await first;
  expect(reports(emit)[1]).toMatchObject({
    outcome: 'loaded',
    counts: { media: { routing: 0, routed: 1, maxRouteMs: 10_000 }, script: { routeErrors: 1 } },
  });
  await f.route(async () => {})(route('font'));
  f.events.emit('request', request('font'));
  const second = reloadWithDiagnostics(f.page, emit);
  f.events.emit('load');
  complete();
  await second;
  expect(reports(emit)[2]).toMatchObject({
    outcome: 'loaded', milestones: { load: 0 },
    counts: { font: { requested: 0, routed: 0 }, media: { routed: 0 }, script: { routeErrors: 0 } },
  });
  expect(f.reload.mock.calls).toEqual([[], []]);
  expect(emit.mock.calls.flat().join('')).not.toContain('private-');
  expect(f.events.eventNames()).toEqual([]);
  expect(f.browser.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('isolates overlapping reloads in separate caller-owned contexts', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '');
  const a = fixture();
  const b = fixture();
  vi.stubEnv('SMOKE_STARTUP_DIAGNOSTICS', '1');
  const emitA = vi.fn<(line: string) => void>();
  const emitB = vi.fn<(line: string) => void>();
  let complete!: () => void;
  a.reload.mockImplementation(() => new Promise(resolve => { complete = () => resolve(null); }));
  b.reload.mockResolvedValue(null);
  const pendingA = reloadWithDiagnostics(a.page, emitA);
  a.events.emit('request', request('document'));
  await a.route(async () => {})(route('document'));
  await reloadWithDiagnostics(b.page, emitB);
  expect(reports(emitB)[0]!.counts.document).toMatchObject({ requested: 0, routed: 0 });
  expect(a.events.listenerCount('load')).toBe(1);
  expect(b.events.eventNames()).toEqual([]);
  complete();
  await pendingA;
  expect(reports(emitA)[0]!.counts.document).toMatchObject({ requested: 1, routed: 1 });
  expect(a.events.eventNames()).toEqual([]);
  expect(a.browser.eventNames()).toEqual([]);
  expect(b.browser.eventNames()).toEqual([]);
  expect(a.context.close).not.toHaveBeenCalled();
  expect(b.context.close).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
