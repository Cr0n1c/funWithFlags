import { performance } from 'node:perf_hooks';

type Phase = 'bundle' | 'browser' | 'context' | 'navigation' | 'ready' | 'journey' | 'teardown';

// Only fixed labels, counts and elapsed times: never URLs, commands, transcripts,
// browser errors, identities or environment values. Opt-in to keep normal runs quiet.
export function fixtureTimings(suite: 'terminal' | 'editor' | 'compounds') {
  const enabled = process.env.BROWSER_FIXTURE_TIMINGS === '1';
  const totals = new Map<Phase, { count: number; ms: number }>();
  let documents = 0;
  return {
    start(phase: Phase) {
      const start = performance.now();
      return () => {
        if (!enabled) return;
        const total = totals.get(phase) ?? { count: 0, ms: 0 };
        total.count++;
        total.ms += performance.now() - start;
        totals.set(phase, total);
      };
    },
    documentLoaded() { documents++; },
    report() {
      if (!enabled) return;
      for (const [phase, { count, ms }] of totals) {
        console.log(`[browser-timing] ${suite} ${phase} count=${count} seconds=${(ms / 1000).toFixed(1)}`);
      }
      if (suite === 'terminal') {
        console.log(`[browser-timing] ${suite} documents=${documents}`);
      }
    },
  };
}
