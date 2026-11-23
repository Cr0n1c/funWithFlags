/**
 * Add-only HP-UX story material. These paths are provisioned independently of the original
 * filesystem seed marker so an existing account receives new clues without resetting its disk.
 */
export const HPUX_LORE_PATHS = [
  '/usr/local',
  '/usr/local/bin',
  '/var',
  '/var/adm',
  '/var/adm/syslog',
  '/sbin/init.d',
  '/sbin/init.d/diagnostics',
  '/usr/diag',
  '/usr/diag/README',
  '/usr/diag/conf',
  '/usr/diag/conf/monitor.conf',
  '/usr/games',
  '/usr/games/adventure',
  '/usr/games/fortune',
  '/usr/local/bin/monitor',
  '/var/adm/.operator',
  '/var/adm/operator.restore',
  '/var/adm/syslog/diag.log',
  '/tmp/.monitor',
  '/tmp/weirdfile',
] as const;

export const DIAG_PASSWD_RECORD =
  'diag:*:104:20:diagnostic service account:/usr/diag:/usr/bin/ksh';
