"""Explicit admin provisioning of the discoverable browser Unix flags.

The answers already ship in the browser's simulated filesystem. Never return
them from the API or include them in challenge descriptions or audit events.
"""

from typing import TypedDict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bundle_challenge import DESCRIPTION, FLAG, POINTS, SLUG, TITLE
from app.config import Settings
from app.models import Challenge
from app.public_curl import PUZZLE as CURL_PUZZLE
from app.security import hash_flag
from app.talk_challenges import TALK_CHALLENGES
from app.training import PUZZLES

SOURCE_PUZZLE = (
    "everything-is-fair-game",
    "Everything is fair game",
    "sometimes we all need a little help and ask our friend Claude to run in chrome",
    "{everything_1$_fair_game}",
)

INTRO_PUZZLE = (
    "hello-world",
    "Hello World",
    "Type help to find your first flag and learn how to submit it.",
    "hello_world",
)

COMPLIANCE_PUZZLE = (
    "soc-2-prep-training",
    "SOC 2 Prep Training",
    "Ready to take on audit season? Complete the SOC 2 prep training, sharpen "
    "your security know-how, and turn everyday controls into audit-ready evidence. "
    "Claim your training flag and prove compliance is more than a checkbox!",
    "soc2_aint_4you_or_is_it",
)

COMMENT_PUZZLE = (
    "production-comments",
    "Why do comments make it to prod?",
    "there should always be a ci/cd step to sanitize comments so they dont make it into "
    "production workloads... dont you agree?",
    "so_you_found_a_way_to_s33_m3!",
)

IDLE_MATRIX_PUZZLE = (
    "enter-the-matrix",
    "Enter the Matrix",
    "wakey wakey, dont set idle at the screen too long... something might just happen... or not.",
    "neo_has_land3d",
)

# Keep the planted file clues aligned with src/js/shell/tree.ts.
TERMINAL_CHALLENGES = (
    (
        "shell-sudoers",
        "Find a least-privilege clue in system policy",
        "Inspect system policy files for a security clue.",
        "xsecurity{least_privilege_is_a_feature_not_a_bug}",
    ),
    (
        "shell-history",
        "Find sensitive data in command history",
        "Inspect historical command entries for a security clue.",
        "xsecurity{never_type_passwords_where_history_can_see}",
    ),
    (
        "shell-backups",
        "Find sensitive data in common files on system",
        "Inspect common system files for a security clue.",
        "xsecurity{backups_are_data_too_protect_them}",
    ),
    (
        "shell-floppy",
        "Find a security clue on removable media",
        "Inspect mounted removable media for a security clue.",
        "xsecurity{sneakernet_is_still_a_network}",
    ),
    (
        "shell-environment",
        "Inspect an exposed shell environment",
        "Find an environmental variable that should not have been exposed. "
        "OWASP A02:2021 Cryptographic Failures; CWE-526 Exposure of Sensitive "
        "Information Through Environmental Variables.",
        "$t0ring_secrets_n_env_i$_bad",
    ),
    (
        "browser-local-storage",
        "Find sensitive data in browser storage",
        "Inspect browser storage for sensitive data exposed to client-side scripts. "
        "OWASP A02:2021 Cryptographic Failures; CWE-922 Insecure Storage of "
        "Sensitive Information.",
        " eyJhbGci_d0nt_st0r3_h3r3",
    ),
    (
        "shell-bash-history-secret",
        "Find a secret exposed in Bash history",
        "Inspect Bash command history for a sensitive value. "
        "OWASP A02:2021 Cryptographic Failures; CWE-532 Insertion of Sensitive "
        "Information into Log File.",
        "B@sh_h1st0ry_st0res_secret$_t00",
    ),
)

# Keep the historical tuple order stable for existing imports.
TERMINAL_CHALLENGES = (
    *TERMINAL_CHALLENGES[:-1],
    (SLUG, TITLE, DESCRIPTION, FLAG),
    *(item[:4] for item in PUZZLES),
    CURL_PUZZLE[:4],
    *TALK_CHALLENGES,
    SOURCE_PUZZLE,
    INTRO_PUZZLE,
    COMMENT_PUZZLE,
    IDLE_MATRIX_PUZZLE,
    TERMINAL_CHALLENGES[-1],
    COMPLIANCE_PUZZLE,
)


def metadata(slug: str) -> tuple[str, int]:
    # First match wins, in this order.
    known: list[tuple[str, tuple[str, int]]] = [
        (COMPLIANCE_PUZZLE[0], ("gold", 50)),
        (IDLE_MATRIX_PUZZLE[0], ("OWASP", 25)),
        (COMMENT_PUZZLE[0], ("OWASP", 15)),
        (INTRO_PUZZLE[0], ("Intro", 5)),
        (SOURCE_PUZZLE[0], ("OWASP", 25)),
        *((item[0], ("Talks", 500)) for item in TALK_CHALLENGES),
        (CURL_PUZZLE[0], ("OWASP", CURL_PUZZLE[4])),
        *((item[0], ("OWASP", item[4])) for item in PUZZLES),
        (SLUG, ("OWASP", POINTS)),
    ]
    return next((value for key, value in known if key == slug), ("OWASP", 50))


class TerminalStatus(TypedDict):
    slug: str
    title: str
    points: int
    missing: bool


async def terminal_status(db: AsyncSession, settings: Settings) -> list[TerminalStatus]:
    rows = (
        (
            await db.execute(
                select(Challenge).where(
                    Challenge.slug.in_([item[0] for item in TERMINAL_CHALLENGES])
                )
            )
        )
        .scalars()
        .all()
    )
    by_slug = {row.slug: row for row in rows}
    result: list[TerminalStatus] = []
    for slug, title, description, flag in TERMINAL_CHALLENGES:
        category, points = metadata(slug)
        row = by_slug.get(slug)
        if row is not None and (
            row.title != title
            or row.description != description
            or (
                row.category.lower() != category.lower()
                and not (slug == SLUG and row.category == "gold")
            )
            or (row.points != points and not (slug == SLUG and row.points == 150))
            or row.hidden
            or not row.is_active
            or row.case_sensitive
            or row.flag_hash != hash_flag(settings, flag, case_sensitive=False)
        ):
            raise ValueError(f"Existing {slug} differs; no challenges provisioned")
        result.append({"slug": slug, "title": title, "points": points, "missing": row is None})
    return result


async def prepare_terminal_challenges(
    db: AsyncSession,
    settings: Settings,
    expected_missing: set[str],
    additional: list[Challenge] | None = None,
) -> list[Challenge]:
    """Caller holds the mutation lock; validate and stage without committing."""
    status = await terminal_status(db, settings)
    missing = {item["slug"] for item in status if item["missing"]}
    if expected_missing != missing:
        raise ValueError("Challenge list changed; preview again before importing")
    existing = (await db.execute(select(Challenge))).scalars().all()
    # Explicit admin import upgrades this one verified built-in's future value.
    # Existing solve/award ledgers are deliberately not rewritten.
    for row in existing:
        if row.slug == SLUG:
            row.category = "OWASP"
            if row.points == 150:
                row.points = POINTS
    pending: list[Challenge] = []
    for slug, title, description, flag in TERMINAL_CHALLENGES:
        category, points = metadata(slug)
        if slug not in missing:
            continue
        digest = hash_flag(settings, flag, case_sensitive=False)
        candidates = [*existing, *(additional or []), *pending]
        if any(row.case_sensitive or row.flag_hash == digest for row in candidates):
            raise ValueError(f"Flag collision for {slug}; no challenges provisioned")
        pending.append(
            Challenge(
                slug=slug,
                title=title,
                description=description,
                category=category,
                points=points,
                flag_hash=digest,
                case_sensitive=False,
                hidden=False,
                is_active=True,
            )
        )
    return pending
