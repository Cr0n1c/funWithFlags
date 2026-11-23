"""Explicit provisioning of verified hash puzzles.

Supply the original words as JSON on stdin to the CLI; no answers or plaintext
flags are persisted in source, logs, or the challenge descriptions.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
from getpass import getpass

import bcrypt
from sqlalchemy import and_, case, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models import Challenge
from app.talk_challenges import TALK_CHALLENGES
from app.security import acquire_flag_mutation_lock, hash_flag
from app.terminal_challenges import TERMINAL_CHALLENGES, prepare_terminal_challenges
from app import bundle_challenge

PUZZLES = (
    (
        "crack-the-hash-easy",
        "Crack The Hash: Easy",
        50,
        "MD5",
        "5f4dcc3b5aa765d61d8327deb882cf99",
        "sometimes all you have to do is google",
    ),
    (
        "crack-the-hash-medium",
        "Crack The Hash: Medium",
        150,
        "SHA256",
        "f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7",
        "sometimes dictionaries work",
    ),
    (
        "crack-the-hash-hard",
        "Crack The Hash: Hard",
        400,
        "bcrypt",
        "$2y$06$f7wRnFl7ax/fC.liSOPbW./vGaQj6TrSqnwRdED103PGDYtiybzQG",
        "",
    ),
    (
        "crack-the-hash-extra-hard",
        "Crack The Hash: Extra Hard",
        750,
        "bcrypt",
        "$2a$08$VP3PiYeRMjPBBqpLizfKduLJ7qBTOiaBRZ1pmoGh3sbR3/jluJl7e",
        'The string starts with "security" and contains only lowercase letters and numbers. '
        "No spaces, special characters, or uppercase letters.",
    ),
)


def puzzle_description(algorithm: str, digest: str, hint: str) -> str:
    return (
        f"Algorithm: {algorithm}\nHash: {digest}\n"
        "Crack the hash to find the original plaintext. "
        "The flag is the SHA1 of the original plaintext (hex, no wrapper)."
        + (f"\nHint: {hint}" if hint else "")
    )


async def normalize_hash_categories(db: AsyncSession) -> int:
    """One atomic, repeat-safe UPDATE of only unmodified legacy puzzle metadata.

    Never infer puzzle identity from category or title alone. This does not
    create records, recompute flags, or touch the solve and credit ledgers.
    """
    matches = [
        and_(
            Challenge.slug == slug,
            Challenge.title == title,
            Challenge.points == points,
            Challenge.description == puzzle_description(algorithm, digest, hint),
        )
        for slug, title, points, algorithm, digest, hint in PUZZLES
    ]
    # A deployment applies schema, not content changes. Reclassify only the exact
    # legacy bundled-token puzzle; preserve its flag, points and earned credit.
    matches.append(and_(
        Challenge.slug == bundle_challenge.SLUG,
        Challenge.title == bundle_challenge.TITLE,
        Challenge.description == bundle_challenge.DESCRIPTION,
        Challenge.points.in_([150, bundle_challenge.POINTS]),
    ))
    from app.public_curl import PUZZLE as curl_puzzle
    # Existing Demo Day records only: deployment does not copy development data.
    # Match the complete original metadata, leaving customized records alone.
    legacy_talk = or_(*[
        and_(
            Challenge.slug == slug,
            Challenge.title == title,
            Challenge.description == description,
            Challenge.points == 500,
        )
        for slug, title, description, _ in TALK_CHALLENGES
    ])
    matches.append(legacy_talk)
    legacy_curl = and_(
        Challenge.slug == curl_puzzle[0],
        Challenge.title == "A request in the wrong direction",
        Challenge.description == curl_puzzle[2],
        Challenge.category == "OWASP",
        Challenge.points == 150,
    )
    result = await db.execute(
        update(Challenge)
        .where(
            Challenge.case_sensitive.is_(False),
            Challenge.is_active.is_(True),
            Challenge.hidden.is_(False),
            or_(and_(Challenge.category == "gold", or_(*matches)), legacy_curl),
        )
        .values(category=case(
            (legacy_talk, "Talks"),
            (Challenge.slug == bundle_challenge.SLUG, "OWASP"),
            (Challenge.slug == curl_puzzle[0], "OWASP"), else_="cracking",
        ), title=case((legacy_curl, curl_puzzle[1]), else_=Challenge.title),
            points=case((legacy_curl, curl_puzzle[4]), else_=Challenge.points),
            updated_at=Challenge.updated_at)
        .returning(Challenge.id)
    )
    changed = len(result.scalars().all())
    await db.commit()
    return changed


def verify_words(words: dict[str, str], required: set[str] | None = None) -> None:
    """Reject any missing or incorrect supplied digest without echoing the words."""
    required = required if required is not None else {puzzle[0] for puzzle in PUZZLES}
    if set(words) != required or not all(
        isinstance(value, str) and value for value in words.values()
    ):
        raise ValueError("Supply nonempty original words for exactly the missing puzzles")
    for slug, _, _, algorithm, expected, _ in PUZZLES:
        if slug not in words:
            continue
        word = words[slug].encode("utf-8")
        if algorithm == "bcrypt":
            matches = bcrypt.checkpw(word, expected.encode("ascii"))
        else:
            matches = hmac.compare_digest(hashlib.new(algorithm, word).hexdigest(), expected)
        if not matches:
            raise ValueError(f"Hash mismatch for {slug}; no challenges provisioned")


async def missing_challenges(db: AsyncSession) -> list[str]:
    """Only metadata is returned; existing answers are never needed or disclosed."""
    rows = (await db.execute(select(Challenge).where(
        Challenge.slug.in_([p[0] for p in PUZZLES])
    ))).scalars().all()
    by_slug = {row.slug: row for row in rows}
    missing = []
    for slug, title, points, algorithm, digest, hint in PUZZLES:
        row = by_slug.get(slug)
        if row is None:
            missing.append(slug)
        elif (
            row.title != title or row.points != points
            or row.category not in ("gold", "cracking")
            or row.description != puzzle_description(algorithm, digest, hint)
            or row.case_sensitive or not row.is_active or row.hidden
        ):
            raise ValueError(f"Existing {slug} differs; no challenges provisioned")
    return missing


async def create_challenges(
    db: AsyncSession, settings: Settings, words: dict[str, str],
    terminal_missing: set[str] | None = None,
) -> dict[str, int]:
    """Explicitly requested atomic import; caller enforces its own authorization."""
    await acquire_flag_mutation_lock(db)
    missing = await missing_challenges(db)
    # A stale preview cannot create an unconfirmed subset or overwrite a new row.
    if set(words) != set(missing):
        raise ValueError("Challenge list changed; preview again before importing")
    verify_words(words, set(missing))
    existing = (await db.execute(select(Challenge))).scalars().all()
    pending: list[Challenge] = []
    seen_flag_hashes: set[str] = set()
    for slug, title, points, algorithm, digest, hint in PUZZLES:
        if slug not in words:
            continue
        description = puzzle_description(algorithm, digest, hint)
        flag = hashlib.sha1(words[slug].encode("utf-8")).hexdigest()  # noqa: S324 - puzzle specification
        flag_digest = hash_flag(settings, flag, case_sensitive=False)
        # Never replace another challenge's answer or any existing row/solves.
        # A case-sensitive row may hold any mixed-case rendering of the SHA1 hex.
        # Its HMAC cannot be reversed to rule that out; refuse rather than create
        # an ambiguous case-insensitive answer.
        if flag_digest in seen_flag_hashes or any(
            challenge.slug != slug and (
                challenge.case_sensitive or challenge.flag_hash == flag_digest
            )
            for challenge in existing
        ):
            raise ValueError(f"Flag collision for {slug}; no challenges provisioned")
        seen_flag_hashes.add(flag_digest)
        pending.append(
            Challenge(
                slug=slug, title=title, category="cracking", description=description,
                points=points, flag_hash=flag_digest, case_sensitive=False,
                is_active=True, hidden=False,
            )
        )
    if terminal_missing is not None:
        terminal_pending = await prepare_terminal_challenges(
            db, settings, terminal_missing, pending
        )
        pending.extend(terminal_pending)
    db.add_all(pending)
    await db.commit()
    total = len(PUZZLES) + (len(TERMINAL_CHALLENGES) if terminal_missing is not None else 0)
    return {"created": len(pending), "unchanged": total - len(pending)}


async def provision(db: AsyncSession, settings: Settings, words: dict[str, str]) -> dict[str, int]:
    """Preserve the separate, explicit development-only CLI guard."""
    if settings.environment != "development" or os.environ.get("ENVIRONMENT") != "development":
        raise ValueError("Explicit ENVIRONMENT=development is required")
    if not settings.database_url:
        raise ValueError("Explicit development DATABASE_URL is required")
    return await create_challenges(db, settings, words)


def read_words() -> dict[str, str]:
    """Read secret inputs without echoing, saving, or including them in errors."""
    try:
        if sys.stdin.isatty():
            return {slug: getpass(f"{slug} plaintext: ") for slug, *_ in PUZZLES}
        raw = json.load(sys.stdin)
        if not isinstance(raw, dict):
            raise ValueError("Expected a JSON object")
        return raw
    except (ValueError, UnicodeError):
        raise ValueError("Invalid plaintext input") from None