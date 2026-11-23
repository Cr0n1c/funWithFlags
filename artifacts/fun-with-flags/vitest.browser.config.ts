import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  test: {
    ...base.test,
    include: ['tests/browser/*.smoke.ts'],
    testTimeout: 45_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Surface progress during long offline journeys, including before a watchdog fires.
    reporters: ['verbose'],
  },
});