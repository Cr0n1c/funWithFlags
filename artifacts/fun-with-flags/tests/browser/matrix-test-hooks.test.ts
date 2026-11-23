import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { matrixTestHooks } from './idle-matrix-journeys.js';

const id = '/src/js/terminal/idleMatrix.ts';
const settled = '\n      window.__matrixStatusSettled = (window.__matrixStatusSettled ?? 0) + 1;';
const failed = `
        window.__matrixFailedCompletionWrites = (window.__matrixFailedCompletionWrites ?? 0) + 1;`;
const ready = `
      window.__matrixStatusReady = true;
      (window.__matrixAppliedStatuses ??= []).push(solved);
      (window.__matrixStatusesApplied ??= []).push(status.solved);`;

it('instruments the current Matrix source without changing request ownership or status guards', async () => {
  const source = await readFile(new URL('../../src/js/terminal/idleMatrix.ts', import.meta.url), 'utf8');
  const instrumented = matrixTestHooks(source, id)!;
  // Boolean assertions keep application source out of failure reports.
  expect(instrumented.includes(`} finally {${settled}`)).toBe(true);
  expect(instrumented.includes(`solved = status.solved;${ready}`)).toBe(true);
  expect(instrumented.includes(`        solved = null;${failed}`)).toBe(true);
  expect(instrumented.split(settled)).toHaveLength(2);
  expect(instrumented.split(ready)).toHaveLength(2);
  expect(instrumented.split(failed)).toHaveLength(2);
  const wrapper = instrumented.indexOf('\n      export async function startMatrixTest() {');
  expect(wrapper).toBeGreaterThan(0);
  const restored = instrumented.slice(0, wrapper)
    .replace(settled, '').replace(ready, '').replace(failed, '')
    .replace('async function observedStartMatrixTest()', 'export async function startMatrixTest()')
    .replace('import { getMatrixCompletion as requestMatrixCompletion }', 'import { getMatrixCompletion }');
  expect(restored === source).toBe(true);
  expect(instrumented.includes('finally { window.__matrixReplaySettled =')).toBe(true);
  const settlement = instrumented.indexOf(settled);
  const cleanupGuard = instrumented.indexOf('if (checking === request) {', settlement);
  expect(cleanupGuard).toBeGreaterThan(settlement);
  const catchStart = instrumented.indexOf('} catch {', instrumented.indexOf('const refreshSolved'));
  const catchBranch = instrumented.slice(catchStart, settlement);
  expect(catchBranch.includes('getAuthSessionGeneration() === generation')).toBe(true);
  expect(catchBranch.includes(`        solved = null;${failed}`)).toBe(true);
});

it.each([
  ['', 'Matrix completion observer no longer matches'],
  ['} finally {} finally {', 'Matrix completion observer no longer matches'],
  ['} finally {', 'Matrix status observer target is missing'],
  ['} finally { solved = status.solved; solved = status.solved;', 'Matrix status observer target is missing'],
  ['} finally { solved = status.solved;', 'Matrix failed status observer target is missing'],
  ['} finally { solved = status.solved;        solved = null;        solved = null;',
    'Matrix failed status observer target is missing'],
  ['} finally { solved = status.solved;        solved = null;', 'Matrix completion import is missing'],
  ['import { getMatrixCompletion } } finally { solved = status.solved;        solved = null;',
    'Matrix replay observer target is missing'],
  ['import { getMatrixCompletion } } finally { solved = status.solved;        solved = null; export async function startMatrixTest() export async function startMatrixTest()',
    'Matrix replay observer target is missing'],
])('rejects missing or ambiguous observer targets (%#)', (source, message) => {
  expect(() => matrixTestHooks(source, id)).toThrow(message);
});

it('leaves unrelated modules untouched', () => {
  expect(matrixTestHooks('synthetic source', '/src/js/terminal/other.ts')).toBeUndefined();
});
