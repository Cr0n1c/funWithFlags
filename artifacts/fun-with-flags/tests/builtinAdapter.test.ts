import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@lifo-sh/core';
import { enableHpuxBuiltinDispatch } from '../src/js/shell/builtinAdapter.js';

function fixture() {
  const builtins = new Map(['test', '[', 'cd', 'echo'].map((name) => [name, () => 0]));
  const shell = {
    builtins,
    interpreterConfig: { builtins },
    interpreter: { config: { builtins } },
    getRegistry: () => ({ has: () => true }),
  };
  return { shell, install: () => enableHpuxBuiltinDispatch(shell as unknown as Sandbox['shell']) };
}

describe('bounded Lifo builtin adapter', () => {
  it('removes only the three compatibility entries from the shared dispatch map', () => {
    const { shell, install } = fixture();
    install();
    expect([...shell.builtins.keys()]).toEqual(['echo']);
    expect(shell.interpreter.config.builtins.has('test')).toBe(false);
  });

  it('refuses changed private layouts before mutating any entries', () => {
    const { shell, install } = fixture();
    shell.interpreter.config.builtins = new Map(shell.builtins);
    expect(install).toThrow(/initialization refused/);
    expect(shell.builtins.size).toBe(4);
  });

  it('refuses missing original builtins or unregistered replacements atomically', () => {
    const missing = fixture();
    missing.shell.builtins.delete('cd');
    expect(missing.install).toThrow(/initialization refused/);
    expect(missing.shell.builtins.has('test')).toBe(true);
    const unregistered = fixture();
    unregistered.shell.getRegistry = () => ({ has: () => false });
    expect(unregistered.install).toThrow(/initialization refused/);
    expect(unregistered.shell.builtins.size).toBe(4);
  });
});