"""Stable simulated-Unix names, separate from authentication identity."""

from __future__ import annotations

import re
import unicodedata

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ShellNameRegistry, User

MAX_SHELL_NAME = 48
# Accounts and conventional system-owned homes that must never be assigned.
RESERVED_SHELL_NAMES = frozenset(
    {
        "adm",
        "apache",
        "backup",
        "bin",
        "daemon",
        "dbus",
        "ftp",
        "games",
        "gnats",
        "irc",
        "list",
        "lp",
        "mail",
        "man",
        "messagebus",
        "news",
        "nobody",
        "operator",
        "oracle",
        "polkitd",
        "postfix",
        "proxy",
        "root",
        "shutdown",
        "smbnull",
        "sshd",
        "sync",
        "sys",
        "systemd-network",
        "systemd-resolve",
        "systemd-timesync",
        "uucp",
        "user",
        "www-data",
    }
)
_ALLOCATION_LOCK = 719_328_613


def normalize_shell_name(value: str | None) -> str:
    """Normalize a profile label to a portable, lower-case Unix name."""
    label = unicodedata.normalize("NFKD", value or "")
    label = "".join(ch for ch in label if not unicodedata.combining(ch)).lower()
    return re.sub(r"[^a-z0-9]+", "-", label).strip("-")[:MAX_SHELL_NAME].rstrip("-") or "player"


def _candidate(base: str, ordinal: int) -> str:
    if ordinal == 1:
        return base
    suffix = f"-{ordinal}"
    return base[: MAX_SHELL_NAME - len(suffix)].rstrip("-") + suffix


async def acquire_shell_name_lock(db: AsyncSession) -> None:
    """Acquire the allocator lock before taking any user row lock."""
    bind = db.get_bind()
    if bind.dialect.name == "postgresql":
        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _ALLOCATION_LOCK})


async def ensure_shell_names(db: AsyncSession) -> bool:
    """Backfill every account in creation order and reserve each issued name.

    PostgreSQL's transaction advisory lock serializes the read/choose/write
    sequence across workers. Unique constraints remain the final invariant.
    """
    # Steady-state /me requests do one indexed nullable-column probe and avoid
    # serializing on the advisory lock or locking the complete user table.
    pending = await db.scalar(select(User.id).where(User.shell_name.is_(None)).limit(1))
    if pending is None:
        return False

    await acquire_shell_name_lock(db)
    # Another allocator may have completed while this transaction waited.
    pending = await db.scalar(select(User.id).where(User.shell_name.is_(None)).limit(1))
    if pending is None:
        return False

    users = (
        (await db.execute(select(User).order_by(User.created_at, User.id).with_for_update()))
        .scalars()
        .all()
    )
    registry = {
        row.name: row for row in (await db.execute(select(ShellNameRegistry))).scalars().all()
    }
    used = set(registry) | set(RESERVED_SHELL_NAMES)
    owned = {row.user_id: row for row in registry.values() if row.user_id is not None}

    # Repair the registry if a schema/data copy retained user names but omitted
    # registry rows (or vice versa), but fail explicitly on contradictory data.
    for user in users:
        reservation = owned.get(user.id)
        if user.shell_name is None and reservation is not None:
            user.shell_name = reservation.name
        elif user.shell_name is not None and reservation is not None:
            if reservation.name != user.shell_name:
                raise RuntimeError("shell name registry is inconsistent")
        if user.shell_name is None:
            continue
        existing = registry.get(user.shell_name)
        if existing is not None and existing.user_id != user.id:
            raise RuntimeError("shell name registry has a conflicting owner")
        if existing is None:
            row = ShellNameRegistry(name=user.shell_name, user_id=user.id)
            db.add(row)
            registry[user.shell_name] = row
            used.add(user.shell_name)

    for user in users:
        if user.shell_name is not None:
            continue
        base = normalize_shell_name(user.full_name or user.username)
        ordinal = 1
        candidate = _candidate(base, ordinal)
        while candidate in used:
            ordinal += 1
            candidate = _candidate(base, ordinal)
        user.shell_name = candidate
        db.add(ShellNameRegistry(name=candidate, user_id=user.id))
        used.add(candidate)

    await db.flush()
    return True
