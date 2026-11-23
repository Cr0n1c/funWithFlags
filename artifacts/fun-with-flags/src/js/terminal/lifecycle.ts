// A replacement can reuse the same DOM nodes, so connectivity alone is not ownership.
let generation = 0;
const retirementHandlers = new Set<() => void>();

/** Visual command views must release their overlays/listeners when replaced. */
export function onTerminalRetired(cleanup: () => void): () => void {
  retirementHandlers.add(cleanup);
  return () => { retirementHandlers.delete(cleanup); };
}

export function replaceTerminalLifecycle(): void {
  generation++;
  const handlers = [...retirementHandlers];
  retirementHandlers.clear();
  for (const cleanup of handlers) cleanup();
  const input = document.getElementById('terminal-input');
  if (input) input.dataset.commandBusy = 'false';
}

export function captureTerminalOwnership(): () => boolean {
  const owner = generation;
  // Pure command-formatting tests run without a browser document.
  if (typeof document === 'undefined') return () => owner === generation;
  const output = document.getElementById('terminal-output');
  const input = document.getElementById('terminal-input');
  return () => owner === generation
    && output === document.getElementById('terminal-output')
    && input === document.getElementById('terminal-input');
}
