import { beforeAll, describe, expect, it } from 'vitest';
import { getSandbox, runShell } from '../src/js/shell/hpux.js';

describe('offline alias metadata dispatch', () => {
  beforeAll(async () => {
    const sb = await getSandbox();
    await sb.fs.mkdir('/tmp/alias-regressions', { recursive: true });
    await runShell('cd /tmp/alias-regressions');
    // Local commands avoid lazy Node/cloud dependencies and expose all streams.
    sb.shell.getRegistry().register('alias_probe', (ctx) => {
      ctx.stdout.write(`${JSON.stringify(ctx.args)}:${ctx.env.ALIAS_TEMP ?? 'unset'}\n`);
      ctx.stderr.write('probe-error\n');
      return Promise.resolve(7);
    });
    sb.shell.getRegistry().register('alias_copy', async (ctx) => {
      ctx.stdout.write(await ctx.stdin?.readAll() ?? '');
      return 0;
    });
    await runShell('alias check=test; alias bracket="["; alias probe=alias_probe; alias chained=probe; alias copy=alias_copy');
  });

  const capture = async (line: string) => {
    const { stdout, stderr, exitCode } = await (await getSandbox()).commands.run(line);
    return { stdout, stderr, code: exitCode };
  };
  const file = async (path: string) => (await getSandbox()).fs.readFile(`/tmp/alias-regressions/${path}`);

  it('creates stderr files for silent failures and redirects builtin diagnostics', async () => {
    expect(await capture('check -e missing 2>errors')).toEqual({ stdout: '', stderr: '', code: 1 });
    expect(await file('errors')).toBe('');
    expect(await capture('bracket -e missing 2>errors')).toEqual({ stdout: '', stderr: '', code: 2 });
    expect(await file('errors')).toContain('missing ]');
  });

  it('preserves chained arguments, temporary env, stdout/stderr and exit status', async () => {
    const env = (await getSandbox()).shell.getEnv();
    env.ALIAS_TEMP = 'before';
    env.ALIAS_ARG = "a ' $HOME ; $(touch injected)";
    const expected = `${JSON.stringify([env.ALIAS_ARG, ''])}:temporary\n`;
    expect(await capture('ALIAS_TEMP=temporary chained "$ALIAS_ARG" "" >out 2>err'))
      .toEqual({ stdout: '', stderr: '', code: 7 });
    expect(await file('out')).toBe(expected);
    expect(await file('err')).toBe('probe-error\n');
    expect(env.ALIAS_TEMP).toBe('before');
    expect((await capture('test -e injected')).code).toBe(1);
    delete env.ALIAS_TEMP;
    await capture('ALIAS_TEMP=one ALIAS_TEMP=two chained >out 2>err');
    expect(await file('out')).toBe('[]:two\n');
    expect(Object.hasOwn(env, 'ALIAS_TEMP')).toBe(false);
  });

  it('preserves append, descriptor ordering and alias-defined redirect precedence', async () => {
    await capture('probe >out 2>&1');
    await capture('probe >>out 2>>err');
    expect(await file('out')).toBe('[]:unset\nprobe-error\n[]:unset\n');
    expect((await capture('probe 2>&1 >out')).stdout).toBe('probe-error\n');
    await capture('alias redirected="probe >inner"; redirected >outer 2>/dev/null');
    expect(await file('inner')).toBe('');
    expect(await file('outer')).toBe('[]:unset\n');
  });

  it('keeps pipeline stdin/stdout and lets explicit input/output redirects override them', async () => {
    await capture('echo from-file >input');
    expect(await capture('copy <input | copy')).toEqual({ stdout: 'from-file\n', stderr: '', code: 0 });
    expect(await capture('echo upstream | copy')).toEqual({ stdout: 'upstream\n', stderr: '', code: 0 });
    expect(await capture('echo upstream | copy <input')).toEqual({ stdout: 'from-file\n', stderr: '', code: 0 });
    expect(await capture('probe 2>&1 | copy')).toEqual({ stdout: '[]:unset\nprobe-error\n', stderr: '', code: 0 });
    expect(await capture('probe >out 2>err | copy')).toEqual({ stdout: '', stderr: '', code: 0 });
    expect(await (await getSandbox()).commands.run('copy', { stdin: 'provided-input\n' }))
      .toEqual({ stdout: 'provided-input\n', stderr: '', exitCode: 0 });
  });

  it('keeps prefix redirects before alias-defined redirects across chains', async () => {
    await capture('alias prefixed="probe >inner"; alias prefix_chain=prefixed');
    await capture('echo seed >outer');
    expect(await capture('>outer prefix_chain 2>err')).toEqual({ stdout: '', stderr: '', code: 7 });
    expect(await file('outer')).toBe('');
    expect(await file('inner')).toBe('[]:unset\n');
    await capture('echo seed >outer');
    await capture('>>outer prefix_chain 2>err');
    expect(await file('outer')).toBe('seed\n');
    expect(await file('inner')).toBe('[]:unset\n');
    await capture('alias prefixed="probe >>inner"; >outer prefix_chain 2>err');
    expect(await file('inner')).toBe('[]:unset\n[]:unset\n');
    await capture('>outer prefix_chain >last 2>err');
    expect(await file('last')).toBe('[]:unset\n');
    expect(await capture('2>&1 probe >out')).toEqual({ stdout: 'probe-error\n', stderr: '', code: 7 });
  });

  it('expands quoted targets once and carries metadata through pipeline aliases', async () => {
    const env = (await getSandbox()).shell.getEnv();
    env.ALIAS_TARGET = "file ' $HOME ; $(touch target-injected)";
    await capture('probe >"$ALIAS_TARGET" 2>err');
    expect(await file(env.ALIAS_TARGET)).toBe('[]:unset\n');
    expect((await capture('test -e target-injected')).code).toBe(1);
    await capture('alias pipeline="alias_probe | alias_copy"');
    expect(await capture('ALIAS_TEMP=piped pipeline >pipeline-out'))
      .toEqual({ stdout: '', stderr: 'probe-error\n', code: 0 });
    expect(await file('pipeline-out')).toBe('[]:piped\n');
    expect(Object.hasOwn(env, 'ALIAS_TEMP')).toBe(false);
  });

  it('restores temporary variables on unknown commands and redirection failures', async () => {
    const env = (await getSandbox()).shell.getEnv();
    env.ALIAS_TEMP = 'original';
    await capture('alias absent=alias_command_not_found');
    expect((await capture('ALIAS_TEMP=changed absent 2>err')).code).toBe(127);
    expect(env.ALIAS_TEMP).toBe('original');
    expect((await capture('ALIAS_TEMP=changed probe <missing-input')).code).not.toBe(0);
    expect(env.ALIAS_TEMP).toBe('original');
    delete env.ALIAS_TEMP;
  });

  it('allows self aliases and terminates cycles instead of recursing forever', async () => {
    await capture('alias echo="echo prefixed"; alias cycle_a=cycle_b; alias cycle_b=cycle_a');
    expect(await capture('echo value')).toEqual({ stdout: 'prefixed value\n', stderr: '', code: 0 });
    expect((await capture('cycle_a')).code).toBe(127);
    await capture('unalias echo');
  });

  it('supports the browser identity probe without lazy command dependencies', async () => {
    expect(await runShell('alias identity=env; ALIAS_TEMP=TEMP_OK identity >env-out; grep "^ALIAS_TEMP=" env-out; echo "RESTORED:$ALIAS_TEMP"'))
      .toMatchObject({ output: 'ALIAS_TEMP=TEMP_OK\nRESTORED:\n', exitCode: 0 });
  });
});