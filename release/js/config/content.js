export const now = new Date();
export const pad = (n) => String(n).padStart(2, '0');
export const formattedTime = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

// Banner text ascii art
export const banner = `
    Initializing dbt BIOS...

    > POST (Power-On Self-Test) .......... OK
    > Memory Test ........................ OK
    > Video Output ....................... OK
    > Keyboard Interface ................. OK
    > Disk Controller .................... OK
    > Network Test ....................... OK
    > Parallel Port ...................... OK
    > Serial Port ........................ OK
    > CMOS Battery ....................... FAILED
    > Loading boot sector ................ OK

    Booting from drive A...
    Starting MS-DOS (dbt Edition)...

    HIMEM is testing extended memory...
    > 64K base memory OK
    > 256K extended memory OK
    > 1024K extended memory OK

    System clock synchronized to ${formattedTime}

    .......................................................................................

                    ██╗██╗         ██╗           ██╗      █████╗ ██████╗ ███████╗
                    ██║██║      ████████╗        ██║     ██╔══██╗██╔══██╗██╔════╝
              ████████║████████╗╚══██╔══╝        ██║     ███████║██████╔╝███████╗
              ██╔═══██║██║   ██║   ██║           ██║     ██║  ██║██╔══██╗╚════██║
              ████████║███████╔╝   ██║           ███████╗██║  ██║██████╔╝███████║
               ╚══════╝╚══════╝    ╚═╝           ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝
                                                   Secure Boot Environment v0.0.1
    
    .......................................................................................

    Type 'help' for a list of available commands.
`;

export const about = `

    * About This CTF:
        Hello, this is your awesome Security Team! We are excited that you have taken
        part in our Capture The Flag (CTF) event. This CTF is designed to test your skills
        in various areas of cybersecurity, including web security, cryptography, reverse
        engineering, and more. Throughout the event, you will encounter a series of challenges
        that will require you to think critically and creatively. We encourage you to work
        collaboratively with your teammates and share your knowledge. Remember, the goal
        of this CTF is to learn and have fun. We hope you enjoy the experience and gain
        valuable insights into the world of cybersecurity. Reach out to us if you have
        any questions or need assistance. Good luck, and may the best team win!
    .......................................................................................
`;

export const help = `
    * Available Commands:
      - help: Display a list of available commands.
      - date: Show the current date and time.
      - clear: Clear the terminal output.
      - about: Learn more about our CTF.
    .......................................................................................
`;
