import { beforeAll, describe, expect, it } from 'vitest';
import { getSandbox, openForEdit, runShell, saveFile } from '../src/js/shell/hpux.js';

const run = async (cmd: string): Promise<string> => (await runShell(cmd)).output;

describe('hpux01 sandbox', () => {
  beforeAll(async () => {
    await getSandbox();
  }, 30_000);

  it('boots into the operator home with an HP-UX identity', async () => {
    expect(await run('pwd')).toBe('/home/operator\n');
    expect(await run('whoami')).toBe('operator\n');
    expect(await run('id')).toContain('uid=201(operator) gid=3(sys)');
    expect(await run('uname -a')).toMatch(/^HP-UX hpux01 B\.11\.11 U 9000\/800/);
    expect(await run('hostname')).toBe('hpux01\n');
    expect(await run('model')).toContain('9000/800');
  });

  it('lists with HP-UX modes and owners, hiding the seed marker', async () => {
    const out = await run('ls -l /etc');
    expect(out).toMatch(/^total \d+/);
    expect(out).toMatch(/-r--------\s+1 root\s+sys\s+\d+ Mar 14 {2}2003 shadow/);
    expect(out).toMatch(/-rw-r--r--\s+1 root\s+sys/);
    expect(out).not.toContain('.fwf-seed');
    expect(await run('ls -la /etc')).not.toContain('.fwf-seed');
    expect(await run('ls /nope')).toContain('/nope not found');
    expect(await run('ls /lost+found')).toContain('unreadable');
    expect(await run('ls -ld /tmp')).toMatch(/^drwxrwxrwt/);
  });

  it('enforces the operator view on reads', async () => {
    expect(await run('cat /etc/shadow')).toContain('Cannot open /etc/shadow: Permission denied');
    expect(await run('cat /.secure/etc/passwd')).toContain('Permission denied');
    expect(await run('cat /home/mchen/audit_findings_2003.txt')).toContain('Permission denied');
    expect(await run('head -2 /etc/passwd')).toContain('root:*:0:3:root:/:/sbin/sh');
    expect(await run('tail -1 /home/operator/.sh_history')).toBe('exit\n');
    expect(await run('more /etc/motd')).toContain('Hewlett-Packard');
    // wrapped text tools refuse protected files too
    expect((await run('wc -c /var/spool/cron/crontabs/root')).trim()).toMatch(/Permission denied/);
    expect(await run('awk 1 /etc/shadow')).toBe('awk: /etc/shadow: Permission denied\n');
    expect(await run('wc -l /etc/passwd')).toMatch(/^\s+18\n$/);
    expect(await run("awk -F: '{print $1}' /etc/passwd | head -1")).toBe('root\n');
  });

  it('supports pipes, grep and find with permission errors', async () => {
    expect(await run('grep -c operator /etc/passwd')).toBe('1\n');
    expect(await run('cat /etc/passwd | grep jsmith | cut -d: -f1')).toBe('jsmith\n');
    const found = await run('find /home -name "*.sh"');
    expect(found).toContain('/home/backup/nightly.sh');
    expect(found).toContain('/home/jsmith/bin/payroll_push.sh');
    expect(found).toContain('find: cannot open /home/mchen: Permission denied');
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
});
