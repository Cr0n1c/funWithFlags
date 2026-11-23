const CONSOLE_COMMANDS = [
  'lab',
  'about',
  'autocopy',
  'adventure',
  'challenges',
  'challenge',
  'clear',
  'create_flag',
  'delete_flag',
  'export_flags',
  'help',
  'import_challenges',
  'import_user_points',
  'import_flags',
  'fortune',
  'reset',
  'scoreboard',
  'login',
  'logout',
  'matrix_test',
  'reset-shell',
  'status',
  'stty',
  'submit',
];

/** Common HP-UX commands, offered by tab completion. The sandbox knows many more. */
const SHELL_COMMANDS = [
  'awk', 'bdf', 'cat', 'cd', 'cp', 'cut', 'date', 'echo', 'env', 'find', 'finger', 'getconf', 'grep',
  'head', 'hostname', 'id', 'ioscan', 'lanscan', 'last', 'less', 'ls', 'machinfo', 'man', 'mkdir', 'model',
  'more', 'mv', 'ps', 'pwd', 'rm', 'sed', 'sort', 'strings', 'swlist', 'tail', 'touch',
  'uname', 'uniq', 'uptime', 'vi', 'view', 'wc', 'who', 'whoami',
];

export const AVAILABLE_COMMANDS: readonly string[] = [
  ...CONSOLE_COMMANDS,
  ...SHELL_COMMANDS,
].sort();

export function getAutocompleteSuggestions(
  inputText: string | undefined,
  flagAdmin = false,
  admin = false,
): string[] {
  const needle = inputText?.trim().toLowerCase();
  if (!needle) return [];
  if (needle.startsWith('autocopy ')) {
    return ['autocopy on', 'autocopy off'].filter(command => command.startsWith(needle));
  }
  if (needle.startsWith('scoreboard ')) {
    return ['scoreboard users', 'scoreboard groups'].filter((command) => command.startsWith(needle));
  }
  if (needle.startsWith('challenges ') || needle.startsWith('challenge ')) {
    const prefix = needle.startsWith('challenges ') ? 'challenges' : 'challenge';
    return ['cracking', 'gold', 'describe'].map(part => `${prefix} ${part}`)
      .filter(command => command.startsWith(needle));
  }
  return [...AVAILABLE_COMMANDS, ...(admin ? ['user_stats'] : [])].filter((command) =>
    (flagAdmin || !['create_flag', 'delete_flag', 'export_flags', 'import_flags', 'import_challenges', 'import_user_points'].includes(command))
    && command.startsWith(needle));
}
