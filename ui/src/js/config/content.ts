// Helper functions
export const pad = (n: number): string => String(n).padStart(2, '0');

// System state
interface SystemStatus {
  POST: string;
  MEMORY: string;
  VIDEO: string;
  KEYBOARD: string;
  DISK: string;
  NETWORK: string;
  PARALLEL: string;
  SERIAL: string;
}

const SYSTEM_STATUS: SystemStatus = {
  POST: 'OK',
  MEMORY: 'OK',
  VIDEO: 'OK',
  KEYBOARD: 'OK',
  DISK: 'OK',
  NETWORK: 'OK',
  PARALLEL: 'OK',
  SERIAL: 'OK',
};

// CMOS and time settings
const cmosFailed: boolean = Math.random() < 0.5;
const now: Date = new Date();
const currentDate: Date = cmosFailed ? new Date(0) : now;

export const formattedTime: string = 
  `${pad(currentDate.getUTCMonth() + 1)}/${pad(currentDate.getUTCDate())}/` +
  `${currentDate.getUTCFullYear()} ${pad(currentDate.getUTCHours())}:` +
  `${pad(currentDate.getUTCMinutes())}:${pad(currentDate.getUTCSeconds())}`;

// ASCII art and content sections
const ASCII_LOGO: string = `
           _____                                         __________________
          / ___/___  ____ ___  ____ _________  ____     / ____/_  __/ ____/
          \\__ \\/ _ \\/ __ \`__ \\/ __ \`/ ___/ _ \\/ __ \\   / /     / / / /_
         ___/ /  __/ / / / / / /_/ / /  /  __/ /_/ /  / /___  / / / __/
        /____/\\___/_/ /_/ /_/\\__, /_/   \\___/ .___/   \\____/ /_/ /_/
                            /____/         /_/

        Cyber Security Awareness Month  //  Capture The Flag  //  v2.0.0`;

const DIVIDER: string = '.......................................................................................';

// Banner text with system checks
export const banner: string = `
    Initializing SEMGREP BIOS...

    > POST (Power-On Self-Test) .......... ${SYSTEM_STATUS.POST}
    > Memory Test ........................ ${SYSTEM_STATUS.MEMORY}
    > Video Output ....................... ${SYSTEM_STATUS.VIDEO}
    > Keyboard Interface ................. ${SYSTEM_STATUS.KEYBOARD}
    > Disk Controller .................... ${SYSTEM_STATUS.DISK}
    > Network Test ....................... ${SYSTEM_STATUS.NETWORK}
    > Parallel Port ...................... ${SYSTEM_STATUS.PARALLEL}
    > Serial Port ........................ ${SYSTEM_STATUS.SERIAL}
    > CMOS Battery ....................... ${cmosFailed ? 'FAILED' : 'OK'}
    > Loading boot sector ................ OK
    ${cmosFailed ? '\n    Warning: System clock reset to default factory settings.\n' : ''}
    Booting from drive A...
    Starting SG-DOS (SemGrep Security Edition)...

    HIMEM is testing extended memory...
    > 64K base memory OK
    > 256K extended memory OK
    > 1024K extended memory OK

    System clock synchronized to ${cmosFailed ? '01/01/1970 00:00:00' : formattedTime}

    ${DIVIDER}

    ${ASCII_LOGO}
    
    ${DIVIDER}

    Type 'help' for a list of available commands.
`;

// Help content
export const help: string = `
    * Available Commands:
      - help                       Display this list of commands.
      - about                      Learn more about this CTF.
      - login                      Sign in with Okta single sign-on.
      - logout                     End your current session.
      - status | whoami            Show who you are logged in as.
      - challenges [slug]          List challenges, or show one challenge's details.
      - submit <slug> <flag>       Submit a flag for a challenge (the only command that needs login).
      - leaderboard                Show the top players.
      - clear                      Clear the terminal output.

    * Everything else goes to hpux01, an HP-UX 11.11 box you are logged into as "operator".
      Try: ls -la, cd /etc, cat /etc/motd, find / -name "*.sh", grep -i password -r /home,
      more /var/adm/syslog/syslog.log, vi ~/scratch.txt (type :help inside vi).
      Pipes work. Your files persist in this browser; reset-shell restores the machine.
    ${DIVIDER}
`;

// About content
export const about: string = `
    * About This CTF:
        Hello from the Semgrep Security Team! We are excited that you have taken
        part in our Capture The Flag (CTF) event. This CTF is designed to test your skills
        in various areas of cybersecurity, including web security, cryptography, reverse
        engineering, and more.

        Throughout the event, you will encounter a series of challenges that will require
        you to think critically and creatively. We encourage you to work collaboratively
        with your teammates and share your knowledge.

        Remember, the goal of this CTF is to learn and have fun. We hope you enjoy the
        experience and gain valuable insights into the world of cybersecurity. Reach out
        to us if you have any questions or need assistance. Good luck, and may the best
        team win!
    ${DIVIDER}
`; 