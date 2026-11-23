import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  configureShellIdentity,
  deliverShellMail,
  getSandbox,
  migrateCanonicalHome,
  openForEdit,
  prompt,
  runShell,
  saveFile,
  scopedDatabaseName,
  provisionHpuxLore,
  recordUserCommand,
} from '../src/js/shell/hpux.js';

const run = async (cmd: string): Promise<string> => (await runShell(cmd)).output;
const historyPrefix = 'submit B@sh_h1st0ry_st0res_secret$_t00\n';

describe('hpux01 sandbox', () => {
  beforeAll(async () => {
    await getSandbox();
  }, 30_000);

  it('initializes directory-local histories without replacing existing clues and retains exact env', async () => {
    const sb = await getSandbox();
    for (const path of ['/.bash_history', '/etc/.bash_history', '/tmp/.bash_history',
      '/home/operator/.bash_history']) {
      expect(await sb.fs.exists(path)).toBe(true);
    }
    const planted = await sb.fs.readFile('/home/operator/.sh_history');
    expect(await sb.fs.readFile('/home/operator/.bash_history')).toBe(`${historyPrefix}${planted}`);
    expect(await run('cat /etc/.bash_history')).toBe(historyPrefix);
    for (const path of ['/.bash_history', '/etc/.bash_history', '/tmp/.bash_history']) {
      expect(await sb.fs.readFile(path)).toBe(historyPrefix);
    }
    expect(await run('echo bypass > /etc/.bash_history')).toContain('Permission denied');
    const env = await run('env');
    expect(env).toMatch(/(?:^|\n)SHELL=\/bin\/bash(?:\n|$)/);
    expect(env).toMatch(/(?:^|\n)FLAG=\$t0ring_secrets_n_env_i\$_bad(?:\n|$)/);
    expect(await sb.fs.readFile('/home/operator/.sh_history')).toBe(planted);
  });

  it('records only prompt-level text in its original directory and initializes indirect mkdir', async () => {
    const sb = await getSandbox();
    await run('cd /tmp');
    const original = await sb.fs.readFile('/tmp/.bash_history');
    await recordUserCommand('cd /etc');
    await run('cd /etc');
    expect(await sb.fs.readFile('/tmp/.bash_history')).toBe(`${original}cd /etc\n`);
    expect(await sb.fs.readFile('/etc/.bash_history')).not.toContain('cd /etc');
    await run('cd /tmp; alias make_dir=mkdir; make_dir -p history-check/nested');
    expect(await sb.fs.readFile('/tmp/history-check/.bash_history')).toBe(historyPrefix);
    expect(await sb.fs.readFile('/tmp/history-check/nested/.bash_history')).toBe(historyPrefix);
    await sb.fs.writeFile('/tmp/history-check/.bash_history', 'original clue\n');
    await recordUserCommand('pwd');
    expect(await sb.fs.readFile('/tmp/.bash_history')).toContain('pwd\n');
    await run('cd /tmp/history-check');
    await recordUserCommand('echo retained');
    expect(await sb.fs.readFile('/tmp/history-check/.bash_history'))
      .toBe(`${historyPrefix}original clue\necho retained\n`);
    await run('cd; unalias make_dir');
  });

  it('reconciles saved histories and removed files once, preserving old bytes and the legacy clue', async () => {
    const sb = await getSandbox();
    const legacy = await sb.fs.readFile('/home/operator/.sh_history');
    await sb.fs.mkdir('/tmp/saved-history', { recursive: true });
    const saved = 'older entry\nsecond $pecial entry\n';
    await sb.fs.writeFile('/tmp/saved-history/.bash_history', saved);
    await sb.fs.rm('/tmp/.bash_history');
    await run('true');
    expect(await sb.fs.readFile('/tmp/saved-history/.bash_history')).toBe(`${historyPrefix}${saved}`);
    expect(await sb.fs.readFile('/tmp/.bash_history')).toBe(historyPrefix);
    await run('true');
    expect(await sb.fs.readFile('/tmp/saved-history/.bash_history')).toBe(`${historyPrefix}${saved}`);
    await sb.fs.writeFile('/tmp/saved-history/.bash_history', historyPrefix.trimEnd());
    await run('true');
    expect(await sb.fs.readFile('/tmp/saved-history/.bash_history')).toBe(historyPrefix);
    expect(await sb.fs.readFile('/home/operator/.sh_history')).toBe(legacy);
    await run('cd /tmp/saved-history');
    await sb.fs.writeFile('/tmp/saved-history/.bash_history', 'edited without newline');
    await recordUserCommand('pwd');
    expect(await sb.fs.readFile('/tmp/saved-history/.bash_history'))
      .toBe(`${historyPrefix}edited without newline\npwd\n`);
    await saveFile('/tmp/saved-history/.bash_history', 'edited via editor\n');
    expect(await sb.fs.readFile('/tmp/saved-history/.bash_history'))
      .toBe(`${historyPrefix}edited via editor\n`);
    await run('cd');
  });

  it('boots into the operator home with an HP-UX identity', async () => {
    expect(await run('pwd')).toBe('/home/operator\n');
    expect(await run('whoami')).toBe('operator\n');
    expect(await run('id')).toContain('uid=201(operator) gid=3(sys)');
    expect(await run('uname -a')).toMatch(/^HP-UX hpux01 B\.11\.11 U 9000\/800/);
    expect(await run('hostname')).toBe('hpux01\n');
    expect(await run('model')).toContain('9000/800');
    expect(await run('getconf KERNEL_BITS')).toBe('64\n');
    expect(await run('machinfo')).toContain('PA-RISC 2.0');
    expect(await run('machinfo')).toContain('9000/800/rp5470');
  });

  it('bounds sl output and supports pipelines without ANSI frame buffering', async () => {
    const out = await run('sl');
    expect(out).toContain('STEAM');
    expect(out.length).toBeLessThan(500);
    expect(out).not.toContain('\x1b');
    expect(await run('sl | grep STEAM')).toContain('STEAM');
    expect(await run('echo after-sl')).toBe('after-sl\n');
  });

  it('captures stdout from conditionals, loops and command substitutions', async () => {
    expect(await run(
      'if false; then echo wrong; elif true; then echo branch; else echo wrong; fi',
    )).toBe('branch\n');
    expect(await run('for value in one two; do echo "for:$value"; done')).toBe(
      'for:one\nfor:two\n',
    );
    expect(await run('while true; do echo while; break; done')).toBe('while\n');
    expect(await run('until false; do echo until; break; done')).toBe('until\n');
    expect(await run('echo "$(if true; then printf nested; fi)"')).toBe('nested\n');
  });

  it('keeps compound stdout and stderr attached to capture and pipelines', async () => {
    expect(await run('if true; then printf "pipe\\n"; fi | cat')).toBe('pipe\n');

    const failed = await runShell(
      'if false; then echo wrong; else echo conditional-error >&2; false; fi',
    );
    expect(failed).toMatchObject({
      output: 'conditional-error\n',
      exitCode: 1,
    });
  });

  it('preserves function streams, status and each quoted positional argument', async () => {
    expect(await run(
      'printf_args() { printf "<%s>\\n" "$@"; }; printf_args "two words" "" "a*b"',
    )).toBe('<two words>\n<>\n<a*b>\n');
    expect(await run(
      'show_args() { for arg in "$@"; do printf "<%s>\\n" "$arg"; done; }',
    )).toBe('');
    expect(await run('show_args "" "*" "two words"')).toBe('<>\n<*>\n<two words>\n');
    expect(await run('show_args "through pipe" | cat')).toBe('<through pipe>\n');
    expect(await run('show_args redirected > /tmp/function-output; cat /tmp/function-output')).toBe(
      '<redirected>\n',
    );

    const failed = await runShell(
      'fail_function() { echo function-error >&2; return 7; }; fail_function',
    );
    expect(failed).toMatchObject({
      output: 'function-error\n',
      exitCode: 7,
    });
  });

  it('resolves file tests against cwd and keeps cd and PWD in agreement', async () => {
    await run('mkdir /tmp/existence-check; cd /tmp/existence-check; touch present');
    try {
      expect(await run('ls present')).toBe('present\n');
      expect((await runShell('test -e present')).exitCode).toBe(0);
      expect(await run('pwd; echo "$PWD"')).toBe('/tmp/existence-check\n/tmp/existence-check\n');
      expect(await run('[ -e ./present ]; echo $?; test -e missing; echo $?')).toBe('0\n1\n');
      expect((await runShell('[ -e present')).exitCode).toBe(2);
      expect(await run('mkdir nested; cd nested; test -e ../present; echo $?; echo "$PWD"; cd ..; rmdir nested')).toBe('0\n/tmp/existence-check/nested\n');
      expect(await run('cd /does-not-exist; echo $?; echo "$PWD"')).toContain('1\n/tmp/existence-check\n');
      expect(await run('cd /root; echo $?; echo "$PWD"')).toContain('1\n/tmp/existence-check\n');
      expect(await run('test -r /etc/shadow; echo $?; test -e /root/.profile; echo $?')).toBe('1\n1\n');
      expect(await run('touch "with spaces"; [ -f "with spaces" ]; echo $?; rm "with spaces"')).toBe('0\n');
      expect(await run('test -d . -a ! -e missing; echo $?; test abc = abc; echo $?; test 2 -gt 1; echo $?')).toBe('0\n0\n0\n');
      expect(await run('test -f .; echo $?; test -s present; echo $?; test -r present; echo $?; test -w present; echo $?; test -x present; echo $?')).toBe('1\n1\n0\n0\n1\n');
      expect(await run('cd /tmp; cd -; pwd; echo "$PWD"')).toBe('/tmp/existence-check\n/tmp/existence-check\n/tmp/existence-check\n');
      expect((await runShell('if [ -e present ]; then true; else false; fi')).exitCode).toBe(0);
      expect((await runShell('if [ -e missing ]; then true; else false; fi')).exitCode).toBe(1);
      expect((await runShell('test -e /tmp/existence-check/present')).exitCode).toBe(0);
      expect(await run('false; echo $?; test -e /tmp/existence-check/present; echo $?')).toBe('1\n0\n');
      expect(await run('true; echo $?; test -e /tmp/existence-check/missing; echo $?')).toBe('0\n1\n');
      expect(await run('[ -e /tmp/existence-check/./present ]; echo $?')).toBe('0\n');
      await run('rm present');
      expect((await runShell('test -e /tmp/existence-check/present')).exitCode).toBe(1);
    } finally {
      await run('cd; rmdir /tmp/existence-check');
    }
  });

  it('dispatches aliases and expanded test/bracket names with original quoted operands', async () => {
    const sb = await getSandbox();
    const base = '/tmp/indirect checks';
    const filename = "literal ' $HOME ; file";
    await sb.fs.mkdir(base, { recursive: true });
    await sb.fs.writeFile(`${base}/${filename}`, 'present');
    await run(`cd "${base}"`);
    try {
      await run('alias probe_test=test; alias probe_bracket="["');
      sb.shell.getEnv().PROBE_FILE = filename;
      for (const invocation of ['probe_test', '$PROBE_COMMAND']) {
        await run('PROBE_COMMAND=test');
        expect((await runShell(`${invocation} -f "$PROBE_FILE"`)).exitCode).toBe(0);
        expect((await runShell(`${invocation} -e missing`)).exitCode).toBe(1);
        expect((await runShell(`${invocation} -r /etc/shadow`)).exitCode).toBe(1);
        expect((await runShell(`${invocation} -e /.secure/etc/passwd`)).exitCode).toBe(1);
        expect((await runShell(`${invocation} "" = ""`)).exitCode).toBe(0);
      }
      for (const invocation of ['probe_bracket', '$PROBE_COMMAND']) {
        await run('PROBE_COMMAND="["');
        expect((await runShell(`${invocation} -f "$PROBE_FILE" ]`)).exitCode).toBe(0);
        expect((await runShell(`${invocation} -e missing ]`)).exitCode).toBe(1);
        expect((await runShell(`${invocation} -r /etc/shadow ]`)).exitCode).toBe(1);
        expect((await runShell(`${invocation} -e "$PROBE_FILE"`)).exitCode).toBe(2);
      }
    } finally {
      await run('unalias probe_test; unalias probe_bracket; cd');
      delete sb.shell.getEnv().PROBE_FILE;
      delete sb.shell.getEnv().PROBE_COMMAND;
      await sb.fs.rm(base, { recursive: true });
    }
  });

  it('keeps indirect cd, PWD and OLDPWD consistent including denied paths', async () => {
    await run('mkdir "/tmp/indirect cd"; alias probe_cd=cd; CD_COMMAND=cd');
    try {
      for (const invocation of ['probe_cd', '$CD_COMMAND']) {
        expect((await runShell(`${invocation} "/tmp/indirect cd"`)).exitCode).toBe(0);
        expect(await run('pwd; echo "$PWD"')).toBe('/tmp/indirect cd\n/tmp/indirect cd\n');
        expect(await run(`${invocation} /lost+found`)).toContain('Permission denied');
        expect((await runShell(`${invocation} /etc/passwd`)).exitCode).toBe(1);
        expect(await run('pwd; echo "$PWD"; echo "$OLDPWD"'))
          .toBe('/tmp/indirect cd\n/tmp/indirect cd\n/home/operator\n');
        expect((await runShell(`${invocation} one two`)).exitCode).toBe(1);
        expect(await run(`${invocation} -`)).toBe('/home/operator\n');
        expect(await run('echo "$PWD"; echo "$OLDPWD"')).toBe('/home/operator\n/tmp/indirect cd\n');
      }
    } finally {
      await run('unalias probe_cd; cd; rmdir "/tmp/indirect cd"');
    }
  });

  it('uses compatibility dispatch inside nested sourced scripts without rewriting their contents', async () => {
    const sb = await getSandbox();
    const base = '/tmp/source checks';
    await sb.fs.mkdir(base, { recursive: true });
    await sb.fs.writeFile(`${base}/present file`, 'yes');
    const script = `cd "${base}"
test -f "present file"
SOURCE_TEST=$?
[ -e missing ]
SOURCE_MISSING=$?
test -r /etc/shadow
SOURCE_DENIED=$?
cd /lost+found
SOURCE_CD_DENIED=$?
SOURCE_PWD=$PWD
test -f "present file"`;
    await sb.fs.writeFile(`${base}/inner`, script);
    await sb.fs.writeFile(`${base}/outer`, `. "${base}/inner"`);
    try {
      for (const source of ['source', '.', '$SOURCE_COMMAND']) {
        await run('cd; SOURCE_COMMAND=source');
        expect((await runShell(`${source} "${base}/outer"`)).exitCode).toBe(0);
        expect(await run('echo "$SOURCE_TEST $SOURCE_MISSING $SOURCE_DENIED $SOURCE_CD_DENIED"'))
          .toBe('0 1 1 1\n');
        expect(await run('pwd; echo "$PWD"; echo "$SOURCE_PWD"; echo "$OLDPWD"'))
          .toBe(`${base}\n${base}\n${base}\n/home/operator\n`);
        expect(await sb.fs.readFile(`${base}/inner`)).toBe(script);
      }
    } finally {
      await run('cd');
      await sb.fs.rm(base, { recursive: true });
    }
  });

  it('lists with HP-UX modes and owners, hiding the seed marker', async () => {
    const out = await run('ls -l /etc');
    expect(out).toMatch(/^total \d+/);
    expect(out).toMatch(/-r--------\s+1 root\s+sys\s+\d+ Mar 14 {2}2003 shadow/);
    expect(out).toMatch(/-rw-r--r--\s+1 root\s+sys/);
    expect(out).not.toContain('.fwf-seed');
    expect(await run('ls -la /etc')).not.toContain('.fwf-seed');
    expect(await run('ls /nope')).toContain('/nope not found');
    expect(await run('ls /lost+found')).toContain('Permission denied');
    expect(await run('ls -ld /tmp')).toMatch(/^drwxrwxrwt/);
  });

  it('enforces the operator view on reads', async () => {
    expect(await run('cat /etc/shadow')).toContain('Cannot open /etc/shadow: Permission denied');
    expect(await run('cat /.secure/etc/passwd')).toContain('Permission denied');
    expect(await run('cat /etc/shadow')).toContain('Permission denied');
    expect(await run('head -2 /etc/passwd')).toContain('root:*:0:3:root:/:/sbin/sh');
    expect(await run('tail -1 /home/operator/.sh_history')).toBe('exit\n');
    expect(await run('more /etc/motd')).toContain('AUTHORIZED USE ONLY');
    // wrapped text tools refuse protected files too
    expect((await run('wc -c /var/spool/cron/crontabs/root')).trim()).toMatch(/Permission denied/);
    expect(await run('awk 1 /etc/shadow')).toBe('awk: /etc/shadow: Permission denied\n');
    expect(await run('wc -l /etc/passwd')).toMatch(/^\s+17\n$/);
    expect(await run("awk -F: '{print $1}' /etc/passwd | head -1")).toBe('root\n');
  });

  it('supports pipes, grep and find with permission errors', async () => {
    expect(await run('grep -c operator /etc/passwd')).toBe('1\n');
    expect(await run('cat /etc/passwd | grep operator | cut -d: -f1')).toBe('operator\n');
    const found = await run('find /home -name "*.sh"');
    expect(found).toContain('/home/backup/nightly.sh');
    expect(found).not.toContain('/home/jsmith');
    expect(found).not.toContain('/home/mchen');
    expect(await run('find /etc -name shadow -type f')).toBe('/etc/shadow\n');
    expect(await run('grep secret /etc/shadow')).toContain("grep: /etc/shadow: Permission denied");
  });

  it('keeps cwd between commands and blocks writes outside writable dirs', async () => {
    await run('cd /var/adm');
    expect(await run('pwd')).toBe('/var/adm\n');
    await run('cd');
    expect(await run('pwd')).toBe('/home/operator\n');
    expect(await run('touch /etc/evil')).toContain('Permission denied');
    expect(await run('rm /etc/passwd')).toContain('Permission denied');
    expect(await run('cp /etc/shadow /tmp/s')).toContain('Permission denied');
    expect(await run('mkdir /tmp/work')).toBe('');
    expect(await run('cp /etc/passwd /tmp/work/p')).toBe('');
    expect((await run('ls -l /tmp/work')).split('\n')[1]).toMatch(/^-rw-r--r--\s+1 operator\s+sys/);
  });

  it('saves files through the editor path helper', async () => {
    const denied = await openForEdit('/etc/newfile');
    expect(denied.writable).toBe(false);
    expect(denied.reason).toContain('Permission denied');
    const ro = await openForEdit('/etc/shadow');
    expect(ro.content).toBeNull();
    expect(ro.writable).toBe(false);
    const fresh = await openForEdit('~/scratch.txt');
    expect(fresh).toMatchObject({ path: '/home/operator/scratch.txt', exists: false, writable: true });
    await saveFile(fresh.path, 'first line\n');
    expect(await run('cat ~/scratch.txt')).toBe('first line\n');
    expect((await openForEdit('scratch.txt')).content).toBe('first line\n');
  });

  it('answers disabled-by-policy style commands in character', async () => {
    expect(await run('su -')).toContain('su: Sorry');
    expect(await run('sudo cat /etc/shadow')).toContain('not allowed to run sudo');
    expect(await run('man ls')).toContain('No manual entry for ls');
    expect(await run('bdf')).toContain('/dev/vg00/lvol3');
    expect(await run('swlist')).toContain('HPUX11i-OE');
    expect(await run('vi foo')).toContain('run it directly from the console prompt');
    expect(await run('nosuchcmd')).toMatch(/not found/);
  });

  it('offers a fictional diagnostics trail through normal readable paths', async () => {
    // Boolean assertions deliberately keep clue-bearing output out of failure diffs.
    expect((await run('id')).includes('uid=201(operator)')).toBe(true);
    expect((await run('finger operator')).includes('remove the diagnostic account')).toBe(true);
    expect((await run('grep diagnostic /etc/passwd')).includes('/usr/diag:/usr/bin/ksh')).toBe(true);
    expect((await run('last')).includes('diag       pts/7')).toBe(true);
    expect((await run('last diag')).includes('(00:05)')).toBe(true);
    expect((await run('cat /usr/diag/README')).includes('/tmp/.monitor')).toBe(true);
    expect((await run('cat /sbin/init.d/diagnostics')).includes('/usr/diag/conf/monitor.conf')).toBe(true);
    expect((await run('cat /usr/diag/conf/monitor.conf')).includes('RUNDIR=/tmp/.monitor')).toBe(true);
    expect((await run('cat /var/adm/operator.restore')).includes('/var/adm/syslog/diag.log')).toBe(true);
    expect((await run('cat /var/adm/syslog/diag.log')).includes('runtime=/tmp/.monitor')).toBe(true);
    expect((await run('ls -a /tmp')).includes('.monitor')).toBe(true);
    try {
      expect((await run('cd /tmp/.monitor; pwd')) === '/tmp/.monitor\n').toBe(true);
      expect((await run('touch /tmp/.monitor/probe')).includes('Permission denied')).toBe(true);
    } finally {
      await run('cd');
    }
    expect(await run('cat /tmp/weirdfile')).toContain('stty sane');
    expect(await run('ls /sbin/init.d')).toContain('diagnostics');
    expect(await run('ls /usr/games')).toBe('adventure  fortune\n');
    expect(await run('ls -l /usr/games')).toMatch(/-r-xr-xr-x\s+1 bin\s+bin\s+\d+ May 14 {2}1998 adventure/);
    expect(await run('cat /usr/games/fortune')).toContain('synthetic frontend command');
  });

  it('exposes monitor inspection clues as printable strings without granting write access', async () => {
    const output = await run('strings /usr/local/bin/monitor');
    expect(output.includes('/tmp/.monitor')).toBe(true);
    expect(output.includes('DEBUG MODE')).toBe(true);
    expect(output.includes('DEBUG_PASSWORD')).toBe(true);
    expect(output.includes('TODO: REMOVE BEFORE PRODUCTION')).toBe(true);
    expect(/^[\x20-\x7e\n]+$/.test(output)).toBe(true);
    expect((await run('strings /usr/local/bin/monitor | grep DEBUG')).includes('DEBUG_PASSWORD')).toBe(true);
    expect((await openForEdit('/usr/local/bin/monitor')).writable).toBe(false);
    expect((await run('echo probe > /usr/local/bin/monitor')).includes('Permission denied')).toBe(true);
    expect((await run('strings /usr/local/bin/monitor')) === output).toBe(true);
  });

  it('keeps the private operator record unreadable through every reader', async () => {
    for (const command of [
      'cat /var/adm/.operator',
      'strings /var/adm/.operator',
      'grep operator /var/adm/.operator',
      'awk 1 /var/adm/.operator',
      'sed -n 1p /var/adm/.operator',
      'tar cf /tmp/operator.tar /var/adm/.operator',
    ]) {
      expect(await run(command)).toContain('Permission denied');
    }
  });

  it('incremental lore provisioning preserves existing files and seed marker', async () => {
    const sb = await getSandbox();
    await sb.fs.writeFile('/usr/diag/README', 'locally changed\n');
    await sb.fs.writeFile('/usr/games/fortune', 'locally changed game marker\n');
    const marker = await sb.fs.readFile('/etc/.fwf-seed');
    await provisionHpuxLore(sb);
    expect(await sb.fs.readFile('/usr/diag/README')).toBe('locally changed\n');
    expect(await sb.fs.readFile('/usr/games/fortune')).toBe('locally changed game marker\n');
    expect(await sb.fs.readFile('/etc/.fwf-seed')).toBe(marker);
    expect((await sb.fs.readFile('/etc/passwd')).match(/^diag:/gm)).toHaveLength(1);
  });
});

describe('personalized shell identity', () => {
  const roster = {
    owner: { account_id: '41', home: '/home/jane-doe-41' },
    entries: [
      { home: '/home/jane-doe-41' },
      { home: '/home/jane-doe-99' },
    ],
  };

  beforeAll(async () => {
    configureShellIdentity(roster);
    await getSandbox();
  }, 30_000);

  it('uses the configured identity and home consistently', async () => {
    expect(await run('whoami')).toBe('jane-doe-41\n');
    expect(await run('id')).toContain('uid=201(jane-doe-41) gid=3(sys)');
    expect(await run('pwd')).toBe('/home/jane-doe-41\n');
    const env = await run('env');
    expect(env).toMatch(/(?:^|\n)USER=jane-doe-41(?:\n|$)/);
    expect(env).toMatch(/(?:^|\n)LOGNAME=jane-doe-41(?:\n|$)/);
    expect(env).toMatch(/(?:^|\n)HOME=\/home\/jane-doe-41(?:\n|$)/);
  });

  it('runs whoami without Node globals or cloud requests', async () => {
    const fetch = vi.fn(() => { throw new Error('whoami must stay local'); });
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('fetch', fetch);
    let output: string;
    try {
      output = await run('whoami');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(output!).toBe('jane-doe-41\n');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves groups in the shell, including pipelines, using only API memberships', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        username: 'jane.doe', groups: ['engineering', 'ctf-players'],
      })),
    )));
    try {
      expect(await run('groups')).toBe(
        'engineering\nctf-players\n',
      );
      expect(await run('groups | grep engineering')).toBe('engineering\n');
      expect(await run('groups another-user')).toContain('Usage: groups');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports unavailable memberships rather than Unix groups or command not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        username: 'jane.doe', groups: [],
      })),
    )));
    try {
      expect(await run('groups')).toContain(
        'Okta SAML sign-in did not provide any group memberships.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('seeds and owns the personalized home without changing fixture contents', async () => {
    expect(await run('cd /tmp; cd ~; pwd')).toBe('/home/jane-doe-41\n');
    expect(await run('cd /tmp; cd; pwd')).toBe('/home/jane-doe-41\n');
    expect(await run('ls -ld /home/jane-doe-41')).toMatch(/^drwx------\s+\d+\s+jane-doe-41\s+sys/);
    expect(await run('ls -l /home/jane-doe-41/notes.txt')).toMatch(/^-rw-r-----\s+1 jane-doe-41\s+sys/);
    expect(await run('tail -1 ~/.sh_history')).toBe('exit\n');
  });

  it('lists every roster home but denies all access to another account home', async () => {
    const homes = await run('ls /home');
    expect(homes).toContain('jane-doe-41');
    expect(homes).toContain('jane-doe-99');
    expect(await run('ls -l /home')).toMatch(/drwx------\s+\d+\s+jane-doe-99\s+sys/);
    expect(await run('cd /home/jane-doe-99')).toContain('Permission denied');
    expect(await run('ls /home/jane-doe-99')).toContain('Permission denied');
    expect(await run('cat /home/jane-doe-99/private.txt')).toContain('Permission denied');
  });

  it('delivers to the canonical private spool and keeps mail edits separate from delivery', async () => {
    const path = '/var/mail/jane-doe-41';
    expect(await deliverShellMail('41', 'From: CTF\nSubject: Flag result\n\nCorrect (5 points).\n')).toBe(true);
    expect(await run(`cat ${path}`)).toContain('Correct (5 points).');
    expect(await run(`more ${path}`)).toContain('Subject: Flag result');
    expect(await run(`ls -l ${path}`)).toMatch(/^-rw-------\s+1 jane-doe-41\s+mail/);
    expect(await run('cat /var/mail/jane-doe-99')).toContain('Permission denied');
    expect(await run('echo no > /var/mail/jane-doe-99')).toContain('Permission denied');
    // Even an imported/corrupt browser filesystem cannot list or read a foreign spool.
    const sb = await getSandbox();
    await sb.fs.writeFile('/var/mail/jane-doe-99', 'foreign secret');
    expect(await run('ls /var/mail')).not.toContain('jane-doe-99');
    expect(await run('find /var/mail')).not.toContain('jane-doe-99');
    expect(await run('cat /var/mail/jane-doe-99')).not.toContain('foreign secret');
    await sb.fs.rm('/var/mail/jane-doe-99');
    expect((await openForEdit('/var/mail/jane-doe-99')).writable).toBe(false);
    await expect(saveFile('/var/mail/jane-doe-99', 'no')).rejects.toThrow('Permission denied');
    expect(await run(`echo -n '' > ${path}`)).not.toContain('Permission denied');
    await saveFile(path, '');
    expect((await openForEdit(path)).content).toBe('');
    expect(await run(`rm ${path}`)).not.toContain('Permission denied');
    expect(await run(`cat ${path}`)).toContain('No such file or directory');
    expect(await deliverShellMail('99', 'wrong account')).toBe(false);
    expect(await deliverShellMail('41', 'From: CTF\n\nNew event.\n')).toBe(true);
    expect(await run(`cat ${path}`)).toContain('New event.');
  });

  it('aligns long listing columns for longer account names', async () => {
    for (const command of [
      'ls -lart /home',
      'ls -ld /home/jane-doe-41 /home/operator /home/oracle',
    ]) {
      const output = await run(command);
      const rows = output.split('\n').filter((line) => /^d[rwx-]/.test(line));
      expect(rows.length).toBeGreaterThan(1);
      expect(output).toContain('jane-doe-41');
      // Group, date and filename must begin at identical columns on every row.
      for (const column of [3, 5, 8]) {
        const positions = rows.map((row) => [...row.matchAll(/\S+/g)][column]?.index);
        expect(positions[0]).toBeDefined();
        expect(new Set(positions).size).toBe(1);
      }
    }
  });

  it('denies redirection, editor saves, copy and move into other homes', async () => {
    expect(await run('echo nope > /home/jane-doe-99/nope')).toContain('Permission denied');
    expect(await run('cp /etc/passwd /home/jane-doe-99/copied')).toContain('Permission denied');
    expect(await run('mv ~/notes.txt /home/jane-doe-99/moved')).toContain('Permission denied');
    const edit = await openForEdit('/home/jane-doe-99/editor.txt');
    expect(edit).toMatchObject({ writable: false });
    expect(edit.reason).toContain('Permission denied');
    await expect(saveFile('/home/jane-doe-99/editor.txt', 'nope')).rejects.toThrow('Permission denied');
  });

  it('keeps same display names separate by immutable account suffix', async () => {
    configureShellIdentity({
      owner: { account_id: '99', home: '/home/jane-doe-99' },
      entries: roster.entries,
    });
    expect(await run('pwd')).toBe('/home/jane-doe-99\n');
    expect(await run('cat /home/jane-doe-41/notes.txt')).toContain('Permission denied');
    expect(await run('echo mine > ~/mine.txt; cat ~/mine.txt')).toBe('mine\n');
  });
});

describe('canonical home rename safety', () => {
  it('keeps IndexedDB stores isolated by immutable account ID without adopting legacy stores', () => {
    expect(scopedDatabaseName('lifo', '501')).toBe('lifo-fwf-account-501');
    expect(scopedDatabaseName('lifo-blobs', '501')).toBe('lifo-blobs-fwf-account-501');
    expect(scopedDatabaseName('lifo', '502')).not.toBe(scopedDatabaseName('lifo', '501'));
    expect(scopedDatabaseName('unrelated', '501')).toBe('unrelated');
    expect(scopedDatabaseName('lifo', '501')).not.toBe('lifo');
  });

  it('uses the server-supplied basename everywhere while keeping roster homes private', async () => {
    configureShellIdentity({
      owner: { account_id: '504', home: '/home/brandon-helms' },
      entries: [
        { home: '/home/brandon-helms' },
        { home: '/home/brandon-helms-2' },
        { home: '/home/andy-lee' },
      ],
    });
    await getSandbox();
    expect(await run('whoami')).toBe('brandon-helms\n');
    expect(await run('pwd')).toBe('/home/brandon-helms\n');
    expect(prompt('/home/brandon-helms')).toBe('hpux01:/home/brandon-helms $ ');
    expect(await run('ls -ld /home/brandon-helms')).toMatch(
      /^drwx------\s+\d+\s+brandon-helms\s+sys/,
    );
    expect(await run('ls -l /home')).toMatch(/brandon-helms-2\s*$/m);
    expect(await run('cd /home/brandon-helms-2')).toContain('Permission denied');
    expect(await run('cat /home/andy-lee/private.txt')).toContain('Permission denied');
  });

  it('moves a marked account home intact and is safe to repeat after reload', async () => {
    configureShellIdentity({
      owner: { account_id: '501', home: '/home/brando-name-501' },
      entries: [{ home: '/home/brando-name-501' }],
    });
    const sb = await getSandbox();
    await sb.fs.mkdir('/home/brando-name-501/projects/nested', { recursive: true });
    await sb.fs.writeFile('/home/brando-name-501/projects/nested/flag.txt', 'preserve me\n');
    await sb.fs.writeFile('/home/brando-name-501/collision.txt', 'original\n');

    configureShellIdentity({
      owner: { account_id: '501', home: '/home/brandon-helms' },
      entries: [
        { home: '/home/brandon-helms' },
        { home: '/home/brandon-helms-2' },
        { home: '/home/andy-lee' },
      ],
    });
    await migrateCanonicalHome(sb);

    expect(await sb.fs.exists('/home/brando-name-501')).toBe(false);
    expect(await sb.fs.readFile('/home/brandon-helms/projects/nested/flag.txt')).toBe('preserve me\n');
    expect(await sb.fs.readFile('/home/brandon-helms/collision.txt')).toBe('original\n');
    expect(JSON.parse(await sb.fs.readFile('/.fwf-account-owner'))).toEqual({
      accountId: '501',
      home: '/home/brandon-helms',
    });
    await expect(migrateCanonicalHome(sb)).resolves.toBeUndefined();
  });

  it('fails without merging, overwriting, or advancing the marker on a collision', async () => {
    configureShellIdentity({
      owner: { account_id: '502', home: '/home/old-name-502' },
      entries: [{ home: '/home/old-name-502' }],
    });
    const sb = await getSandbox();
    await sb.fs.writeFile('/home/old-name-502/source.txt', 'source\n');
    await sb.fs.mkdir('/home/andy-lee', { recursive: true });
    await sb.fs.writeFile('/home/andy-lee/source.txt', 'destination\n');

    configureShellIdentity({
      owner: { account_id: '502', home: '/home/andy-lee' },
      entries: [{ home: '/home/andy-lee' }],
    });
    await expect(migrateCanonicalHome(sb)).rejects.toThrow(
      'Home migration stopped: destination /home/andy-lee already exists.',
    );
    expect(await sb.fs.readFile('/home/old-name-502/source.txt')).toBe('source\n');
    expect(await sb.fs.readFile('/home/andy-lee/source.txt')).toBe('destination\n');
    expect(JSON.parse(await sb.fs.readFile('/.fwf-account-owner'))).toEqual({
      accountId: '502',
      home: '/home/old-name-502',
    });
  });

  it('fails closed on another account marker or a reserved fixture home', async () => {
    configureShellIdentity({
      owner: { account_id: '503', home: '/home/old-name-503' },
      entries: [{ home: '/home/old-name-503' }],
    });
    const sb = await getSandbox();
    await sb.fs.writeFile('/home/old-name-503/private.txt', 'private\n');
    await sb.fs.writeFile(
      '/.fwf-account-owner',
      JSON.stringify({ accountId: 'different-account', home: '/home/old-name-503' }),
    );
    configureShellIdentity({
      owner: { account_id: '503', home: '/home/brandon-helms-2' },
      entries: [{ home: '/home/brandon-helms-2' }],
    });
    await expect(migrateCanonicalHome(sb)).rejects.toThrow(
      'Home migration stopped: the ownership marker belongs to another account.',
    );
    expect(await sb.fs.exists('/home/old-name-503/private.txt')).toBe(true);
    expect(await sb.fs.exists('/home/brandon-helms-2')).toBe(false);

    expect(() => configureShellIdentity({
      owner: { account_id: '503', home: '/home/operator' },
      entries: [{ home: '/home/operator' }],
    })).toThrow('Invalid home roster returned by the server.');
  });

  it('propagates a rename failure without changing either home or marker', async () => {
    configureShellIdentity({
      owner: { account_id: '505', home: '/home/old-name-505' },
      entries: [{ home: '/home/old-name-505' }],
    });
    const sb = await getSandbox();
    await sb.fs.writeFile('/home/old-name-505/keep.txt', 'keep\n');
    configureShellIdentity({
      owner: { account_id: '505', home: '/home/brandon-helms' },
      entries: [{ home: '/home/brandon-helms' }],
    });
    const rename = vi.spyOn(sb.fs, 'rename').mockRejectedValueOnce(new Error('storage failure'));
    await expect(migrateCanonicalHome(sb)).rejects.toThrow(
      'Home migration failed while moving /home/old-name-505 to /home/brandon-helms.',
    );
    rename.mockRestore();

    expect(await sb.fs.readFile('/home/old-name-505/keep.txt')).toBe('keep\n');
    expect(await sb.fs.exists('/home/brandon-helms')).toBe(false);
    expect(JSON.parse(await sb.fs.readFile('/.fwf-account-owner'))).toEqual({
      accountId: '505',
      home: '/home/old-name-505',
    });
  });

  it('propagates marker-write failure without seeding or overwriting the moved home', async () => {
    configureShellIdentity({
      owner: { account_id: '506', home: '/home/old-name-506' },
      entries: [{ home: '/home/old-name-506' }],
    });
    const sb = await getSandbox();
    await sb.fs.writeFile('/home/old-name-506/keep.txt', 'keep\n');
    configureShellIdentity({
      owner: { account_id: '506', home: '/home/andy-lee' },
      entries: [{ home: '/home/andy-lee' }],
    });
    const writeFile = vi.spyOn(sb.fs, 'writeFile')
      .mockRejectedValueOnce(new Error('marker storage failure'));
    await expect(migrateCanonicalHome(sb)).rejects.toThrow(
      'Home migration failed while saving the ownership marker.',
    );
    writeFile.mockRestore();

    expect(await sb.fs.exists('/home/old-name-506')).toBe(false);
    expect(await sb.fs.readFile('/home/andy-lee/keep.txt')).toBe('keep\n');
    expect(JSON.parse(await sb.fs.readFile('/.fwf-account-owner'))).toEqual({
      accountId: '506',
      home: '/home/old-name-506',
    });
  });

  it('allows a trusted same-account marker to move a source listed in the current roster', async () => {
    configureShellIdentity({
      owner: { account_id: '507', home: '/home/brandon-helms-2' },
      entries: [{ home: '/home/brandon-helms-2' }],
    });
    const sb = await getSandbox();
    await sb.fs.writeFile('/home/brandon-helms-2/keep.txt', 'same account\n');
    configureShellIdentity({
      owner: { account_id: '507', home: '/home/brandon-helms' },
      entries: [
        { home: '/home/brandon-helms' },
        { home: '/home/brandon-helms-2' },
      ],
    });
    await migrateCanonicalHome(sb);
    expect(await sb.fs.exists('/home/brandon-helms-2')).toBe(false);
    expect(await sb.fs.readFile('/home/brandon-helms/keep.txt')).toBe('same account\n');
  });
});
