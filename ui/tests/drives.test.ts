import { describe, expect, it } from 'vitest';
import { detectDrive } from '../src/js/shell/drives.js';

describe('detectDrive', () => {
  it('spots floppy and cdrom paths in arguments', () => {
    expect(detectDrive('ls -la /floppy', '/home/operator')).toBe('floppy');
    expect(detectDrive('cat /floppy/PW.TXT', '/')).toBe('floppy');
    expect(detectDrive('dd if=/dev/rfloppy/c0t0d0', '/')).toBe(null); // dd's if= is not a bare path
    expect(detectDrive('ls /SD_CDROM/catalog', '/')).toBe('cdrom');
    expect(detectDrive('more README', '/cdrom')).toBe('cdrom');
    expect(detectDrive('cat ../floppy/README.TXT', '/tmp')).toBe('floppy');
  });

  it('ignores unrelated commands and leaving the media', () => {
    expect(detectDrive('ls -la /etc', '/home/operator')).toBe(null);
    expect(detectDrive('cd /', '/cdrom')).toBe(null);
    expect(detectDrive('cd /cdrom', '/')).toBe('cdrom');
    expect(detectDrive('pwd', '/home/operator')).toBe(null);
  });
});
