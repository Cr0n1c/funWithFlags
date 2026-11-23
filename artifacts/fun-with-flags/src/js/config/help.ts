import type { CurrentUser } from '../services/authService.js';

type HelpUser = Pick<CurrentUser, 'is_admin' | 'groups'> | null;

// These visibility rules mirror the existing permissions; the API still
// authorizes every administrative request.
export function getHelp(user: HelpUser): string {
  const commands: [string, string][] = [
    ['lab', 'Explore isolated OWASP training exercises using fictional data.'],
    ['about', 'Learn about the CTF.'],
    ['autocopy [on|off]', 'Show or change automatic copying of selected output (default: on). Saved in this browser. Ctrl+C / Ctrl+V (⌘C / ⌘V on Mac) still work when off.'],
    ['adventure', 'Play a small fictional Unix adventure; type quit to return.'],
    ['challenges', 'List Gold track challenges (alias: challenge).'],
    ['challenges <slug>', "Read a challenge's details (alias: challenge)."],
    ['challenges describe <id>', 'Read fresh details by numeric challenge ID.'],
    ['challenges cracking', 'View Crack The Hash and other Cracking category challenges.'],
    ['challenges gold', 'View id/category/title/points; select an id or title for details. Hidden titles show as <hidden>.'],
    ['clear', 'Clear terminal output.'],
    ['date', 'Show the terminal clock.'],
    ['ex <file>', 'Edit a file (alias: vi).'],
    ['finger [user]', 'Show the fictional HP-UX user directory.'],
    ['fortune', 'Print a rotating fortune (occasionally with a simulated core dump).'],
    ['getconf KERNEL_BITS', 'Show the simulated HP-UX kernel width.'],
    ['groups', 'Show your Okta SAML groups (not Unix groups).'],
    ['help', 'Show this guide.'],
    ['leaderboard', 'Show player scores (alias: scoreboard).'],
    ['last [user]', 'Show fictional login history.'],
    ['login', 'Show sign-in status; use Sign in with Okta to sign in.'],
    ['logout', 'End your session.'],
    ['machinfo', 'Show simulated PA-RISC machine information.'],
    ['reset', 'Recover the simulated terminal after /tmp/weirdfile garbles it.'],
    ['reset-shell', 'Restore the simulated machine (resets your local files).'],
    ['scoreboard [users|groups]', 'View player or group scores. Try: scoreboard groups'],
    ['status', 'Refresh your profile, role, and score.'],
    ['stty sane', 'Restore sane simulated terminal settings.'],
    ['submit <flag>', 'Submit a discovered flag to earn its points.\n        Try: submit hello_world    Earn 5 pts for your first claim!\n        Each flag awards points once per player and once per group.'],
    ['curl <url>', 'Show the first 500 characters from a public HTTP(S) URL using GET. Only --help is supported; redirects are not followed.'],
    ['top', 'Show player scores (alias: scoreboard).'],
    ['vi <file>', 'Edit a file; type :help inside the editor.'],
    ['view <file>', 'Open a file read-only.'],
    ['vim <file>', 'Edit a file (alias: vi).'],
    ['whoami', 'Show your shell username.'],
  ];
  if (user?.is_admin) {
    commands.push(['user_stats', 'Show login totals, people with points, and average daily unique sign-ins.']);
  }
  commands.push(['matrix_test', 'Replay Enter the Matrix after earning its points.']);
  if (user?.groups.includes('funwithflags-admins')) {
    commands.push(
      ['create_flag', 'Guided title, description, flag, points, and hidden prompts.\n        Requires funwithflags-admins. Press Escape or Ctrl+C to cancel.'],
      ['delete_flag <flag>', "Preview title/points and confirm permanent deletion.\n        Deletion removes this flag's earned points from all players and groups.\n        Requires funwithflags-admins. Press Escape or Ctrl+C to cancel."],
      ['export_flags', 'Download all challenge metadata and flag hashes as a sensitive JSON backup. Requires funwithflags-admins. Keep the file private.'],
      ['import_flags', 'Choose a local JSON backup, preview missing/identical/conflicting challenges and confirm missing-only import. Requires the same flag hashing key. Escape or Ctrl+C cancels.'],
      ['import_challenges', 'Preview and import all missing built-in Gold track challenges (Intro, Cracking, OWASP, and Talks).\n        Enter original words only for missing hash puzzles in masked prompts. Requires funwithflags-admins. Escape or Ctrl+C cancels.'],
      ['import_user_points [--preview] <challenge-slug> <full name or username>', 'Award an existing Gold-track challenge to one player. Exact names only; duplicate awards are skipped. Credits the player, not historical groups. Requires funwithflags-admins.'],
    );
  }
  commands.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `
    * Commands (alphabetical):
${commands.map(([name, description]) => `      - ${name.padEnd(27)}${description}`).join('\n')}

    * Explore the Shell:
      Many Linux commands work in this simulated HP-UX shell. Look around, inspect
      files, and follow your curiosity—you may find clues worth investigating!
      Try: cat /etc/motd, cd /etc, find / -name "*.sh",
      grep -i password -r /home, ls -la, more /var/adm/syslog/syslog.log, pwd
      Pipes work, too. Your shell files persist in this browser.
    .......................................................................................
`;
}