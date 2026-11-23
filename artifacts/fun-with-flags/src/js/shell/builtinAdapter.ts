import type { Sandbox } from '@lifo-sh/core';

const names = ['test', '[', 'cd'] as const;

/**
 * Bounded compatibility bridge for pinned @lifo-sh/core 0.10.18.
 *
 * There is no public builtin registration API. Its interpreter resolves expanded
 * names through a builtin map before the public command registry, including
 * aliases and source files. Remove only these three entries so normal registry
 * dispatch supplies the original argv, streams and cwd to our permission-aware
 * commands. Do not replace the interpreter or reconstruct shell source.
 *
 * Keep this private-layout dependency here, validate it before any mutation, and
 * fail closed on incompatible upgrades. Remove when upstream exposes an override.
 */
export function enableHpuxBuiltinDispatch(shell: Sandbox['shell']): void {
  const internal = shell as unknown as {
    builtins?: unknown;
    interpreterConfig?: { builtins?: unknown };
    interpreter?: { config?: { builtins?: unknown } };
  };
  const builtins = internal.builtins;
  if (
    !(builtins instanceof Map)
    || internal.interpreterConfig?.builtins !== builtins
    || internal.interpreter?.config?.builtins !== builtins
    || names.some((name) => typeof builtins.get(name) !== 'function')
    || names.some((name) => !shell.getRegistry().has(name))
  ) {
    throw new Error('Unsupported Lifo builtin dispatch layout; HP-UX shell initialization refused');
  }
  for (const name of names) builtins.delete(name);
}