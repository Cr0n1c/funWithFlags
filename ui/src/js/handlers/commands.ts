const CONSOLE_COMMANDS = [
  'about',
  'challenges',
  'clear',
  'help',
  'leaderboard',
  'login',
  'logout',
  'reset-shell',
  'status',
  'submit',
];

/** Common HP-UX commands, offered by tab completion. The sandbox knows many more. */
const SHELL_COMMANDS = [
  'awk', 'bdf', 'cat', 'cd', 'cp', 'cut', 'date', 'echo', 'env', 'find', 'grep',
  'head', 'hostname', 'id', 'ioscan', 'lanscan', 'less', 'ls', 'man', 'mkdir', 'model',
  'more', 'mv', 'ps', 'pwd', 'rm', 'sed', 'sort', 'strings', 'swlist', 'tail', 'touch',
  'uname', 'uniq', 'uptime', 'vi', 'view', 'wc', 'who', 'whoami',
];

export const AVAILABLE_COMMANDS: readonly string[] = [
  ...CONSOLE_COMMANDS,
  ...SHELL_COMMANDS,
].sort();

export function getAutocompleteSuggestions(inputText: string | undefined): string[] {
  const needle = inputText?.trim().toLowerCase();
  if (!needle) return [];
  return AVAILABLE_COMMANDS.filter((command) => command.startsWith(needle));
}
