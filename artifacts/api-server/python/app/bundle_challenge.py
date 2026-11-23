"""Public CTF puzzle material, NOT credentials or authorization."""

SLUG = "undocumented-command"
TITLE = "Find the undocumented command"
DESCRIPTION = (
    "We have a lot of things documented but sometimes we hide security through obscurity "
    "but failing to document a sensitive command or endpoint. can you find it and provide "
    "a way to interact with it. Hint.... wouldn't you love a command to escalate a person to admin?"
)
FLAG = "I_l0ve_me_some_tokens_n_bundles"
# Deliberately recoverable puzzle answer; never accepted by real auth/admin routes.
PUZZLE_VALUE = "ctf-only.7e19b42d.93ac608f.bundle"
POINTS = 200

# Application commands and supported shell entry points. Discovery grants no permissions.
COMMANDS = sorted(
    set(
        """
about adventure challenges challenge clear create_flag delete_flag lab
export_flags help import_challenges import_flags fortune reset scoreboard login logout
reset-shell status stty submit leaderboard top groups vim ex sl
awk bdf cat cd cp cut date echo env find finger getconf grep head hostname id ioscan
lanscan last less ls machinfo man mkdir model more mv ps pwd rm sed sort strings
swlist tail touch uname uniq uptime vi view wc who whoami promote_user_to_admin
base64 basename chmod chown curl df diff dig dirname du file free gunzip gzip ln
mktemp nl node ping printf realpath rev rmdir seq sha256sum sleep stat tac tar tee
tr tree unzip wget which xargs yes zip dir ll pg egrep fgrep w users su sudo passwd
shutdown reboot swinstall sam crontab mount exit ed emacs nano test [
alias unalias export unset set source . true false read shift return break continue
history jobs wait kill type command eval exec umask
""".split()
    )
)
