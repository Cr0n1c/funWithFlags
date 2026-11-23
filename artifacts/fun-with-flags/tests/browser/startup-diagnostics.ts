import { errors, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright';

// Deliberately no URLs, bodies, headers, console text, error messages, DOM or
// storage. Fixed keys and counters keep reports both bounded and non-sensitive.
const kinds = ['document', 'script', 'stylesheet', 'font', 'image', 'media', 'fetch', 'other'] as const;
type Kind = typeof kinds[number];
type Phase = 'context' | 'routes' | 'page' | 'navigation' | 'reload';
type RouteHandler = (route: Route) => Promise<unknown>;
// Routing stays owned by the fixture. Only an explicit reload temporarily
// redirects its counters to a fresh collector; no routes are added or removed.
const reloadCollectors = new WeakMap<
  BrowserContext, { route(handler: RouteHandler): RouteHandler }
>();
const kindOf = (value: string): Kind =>
  kinds.includes(value as Kind) ? value as Kind : 'other';

export function configureOfflineTimeouts(
  page: Pick<Page, 'setDefaultTimeout' | 'setDefaultNavigationTimeout'>,
) {
  // Preserve the existing budgets. Historical failures inherited the 8s action
  // deadline for goto; navigation and terminal readiness are separate phases.
  page.setDefaultTimeout(8_000);
  page.setDefaultNavigationTimeout(30_000);
}

export function startupDiagnostics(
  emit: (line: string) => void = console.warn,
  initialPhase: Phase = 'context',
) {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  let phase: Phase = initialPhase;
  const phases: Partial<Record<Phase, number>> = { [initialPhase]: 0 };
  const milestones: Record<string, number> = {};
  const counts = Object.fromEntries(kinds.map(kind => [kind, {
    requested: 0, finished: 0, failed: 0, routing: 0, routed: 0, routeErrors: 0, maxRouteMs: 0,
  }])) as Record<Kind, {
    requested: number; finished: number; failed: number;
    routing: number; routed: number; routeErrors: number; maxRouteMs: number;
  }>;
  let stopped = false;
  let reports = 0;
  let lastTick = performance.now();
  let maxSchedulerLagMs = 0;
  let detach = () => {};
  let detachBrowser = () => {};
  let failure: 'timeout' | 'error' | undefined;
  const report = (outcome: 'pending' | 'failed' | 'loaded') => {
    emit(`[offline-startup] ${JSON.stringify({
      outcome, phase, failure, elapsedMs: elapsed(), phases, milestones, maxSchedulerLagMs, counts,
    })}`);
  };
  const sampleScheduler = () => {
    const now = performance.now();
    maxSchedulerLagMs = Math.max(maxSchedulerLagMs, Math.round(now - lastTick - 1_000));
    lastTick = now;
  };
  // Still emits when Chromium is unresponsive; never await browser evaluation.
  // Three progress reports at most, plus one final result.
  const timer = setInterval(() => {
    sampleScheduler();
    if (elapsed() >= (reports + 1) * 10_000 && reports < 3) {
      reports++;
      report('pending');
    }
  }, 1_000);
  timer.unref();
  const stop = (outcome: 'failed' | 'loaded') => {
    if (stopped) return;
    stopped = true;
    sampleScheduler();
    clearInterval(timer);
    detach();
    detachBrowser();
    if (outcome === 'failed' || reports || process.env.SMOKE_STARTUP_DIAGNOSTICS === '1') report(outcome);
  };
  return {
    phase(next: Phase) { phase = next; phases[next] = elapsed(); },
    async step<T>(next: Phase, operation: () => Promise<T>): Promise<T> {
      phase = next;
      phases[next] = elapsed();
      try {
        return await operation();
      } catch (error) {
        failure = error instanceof errors.TimeoutError ? 'timeout' : 'error';
        stop('failed');
        // Never attach the raw Playwright error: reporters print its URL/call log.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Offline terminal startup failed during ${phase}: ${failure} (see safe startup diagnostics)`);
      }
    },
    attachBrowser(browser: Browser) {
      const disconnected = () => { milestones.disconnected = elapsed(); };
      browser.on('disconnected', disconnected);
      detachBrowser = () => { browser.off('disconnected', disconnected); };
    },
    attach(page: Page) {
      const requested = (request: Request) => counts[kindOf(request.resourceType())].requested++;
      const finished = (request: Request) => counts[kindOf(request.resourceType())].finished++;
      const failed = (request: Request) => counts[kindOf(request.resourceType())].failed++;
      const dom = () => { milestones.domcontentloaded = elapsed(); };
      const load = () => { milestones.load = elapsed(); };
      const crash = () => { milestones.crash = elapsed(); };
      const close = () => { milestones.close = elapsed(); };
      page.on('request', requested);
      page.on('requestfinished', finished);
      page.on('requestfailed', failed);
      page.on('domcontentloaded', dom);
      page.on('load', load);
      page.on('crash', crash);
      page.on('close', close);
      detach = () => {
        page.off('request', requested);
        page.off('requestfinished', finished);
        page.off('requestfailed', failed);
        page.off('domcontentloaded', dom);
        page.off('load', load);
        page.off('crash', crash);
        page.off('close', close);
      };
    },
    route(handler: RouteHandler, context?: BrowserContext): RouteHandler {
      return async (route: Route) => {
        const reload = context && reloadCollectors.get(context);
        if (reload) return reload.route(handler)(route);
        if (stopped) return handler(route);
        const count = counts[kindOf(route.request().resourceType())];
        const began = performance.now();
        count.routing++;
        try {
          return await handler(route);
        } catch {
          count.routeErrors++;
          // The route's raw error can contain a URL or payload.
          throw new Error('Offline fixture route failed');
        } finally {
          count.routing--;
          count.routed++;
          count.maxRouteMs = Math.max(count.maxRouteMs, Math.round(performance.now() - began));
        }
      };
    },
    stop,
  };
}

export async function reloadWithDiagnostics(
  page: Page,
  emit: (line: string) => void = console.warn,
): ReturnType<Page['reload']> {
  const context = page.context();
  const diagnostics = startupDiagnostics(emit, 'reload');
  reloadCollectors.set(context, diagnostics);
  try {
    diagnostics.attach(page);
    const browser = context.browser();
    if (browser) diagnostics.attachBrowser(browser);
    // Inherit the caller's navigation deadline and default load milestone.
    // Exactly one attempt, with no readiness/storage checks or context changes.
    const response = await diagnostics.step('reload', () => page.reload());
    diagnostics.stop('loaded');
    return response;
  } finally {
    diagnostics.stop('failed');
    reloadCollectors.delete(context);
  }
}
