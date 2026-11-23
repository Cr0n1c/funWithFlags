from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.models import ShellNameRegistry, User
from app.routers import auth
from app.shell_names import ensure_shell_names, normalize_shell_name


def user(subject: str, full_name: str, created_at: datetime) -> User:
    return User(
        okta_sub=f"saml:{subject}",
        username=f"saml-{subject}",
        full_name=full_name,
        groups=[],
        created_at=created_at,
    )


async def test_duplicate_names_backfill_in_creation_order_not_request_order(session):
    now = datetime.now(UTC)
    newer = user("newer", "Brandon Helms", now)
    older = user("older", "Brandon Helms", now - timedelta(days=1))
    session.add_all([newer, older])
    await session.commit()

    # Allocation is global, so a request by the newer account cannot take the base.
    await ensure_shell_names(session)
    await session.commit()
    assert older.shell_name == "brandon-helms"
    assert newer.shell_name == "brandon-helms-2"


async def test_shell_name_is_stable_after_profile_rename(session):
    account = user("stable", "Brandon Helms", datetime.now(UTC))
    session.add(account)
    await session.commit()
    await ensure_shell_names(session)
    await session.commit()

    account.full_name = "Completely Different"
    await ensure_shell_names(session)
    await session.commit()
    assert account.shell_name == "brandon-helms"


@pytest.mark.parametrize(
    ("label", "normalized"),
    [
        (" Brändon   Helms ", "brandon-helms"),
        ("---", "player"),
        ("A" * 60, "a" * 48),
    ],
)
def test_normalization(label, normalized):
    assert normalize_shell_name(label) == normalized


async def test_reserved_and_preexisting_suffix_collisions_are_skipped(session):
    now = datetime.now(UTC)
    accounts = [
        user("root", "root", now),
        user("first", "Analyst", now + timedelta(seconds=1)),
        user("literal-two", "Analyst 2", now + timedelta(seconds=2)),
        user("second", "Analyst", now + timedelta(seconds=3)),
    ]
    session.add_all(accounts)
    await session.commit()
    await ensure_shell_names(session)
    await session.commit()

    assert [account.shell_name for account in accounts] == [
        "root-2",
        "analyst",
        "analyst-2",
        "analyst-3",
    ]


@pytest.mark.parametrize("fixture_home", ["backup", "operator", "oracle", "smbnull"])
async def test_all_fixture_system_homes_are_reserved(session, fixture_home):
    account = user(fixture_home, fixture_home, datetime.now(UTC))
    session.add(account)
    await session.commit()
    assert await ensure_shell_names(session)
    await session.commit()
    assert account.shell_name == f"{fixture_home}-2"


async def test_steady_state_does_not_relock_or_rewrite_users(session):
    account = user("stable", "Stable User", datetime.now(UTC))
    session.add(account)
    await session.commit()
    assert await ensure_shell_names(session)
    await session.commit()

    assert not await ensure_shell_names(session)
    assert not session.dirty
    assert not session.new


async def test_provision_acquires_allocator_lock_before_user_access(session, settings, monkeypatch):
    acquired = False
    original = auth.acquire_shell_name_lock

    async def tracked_lock(db):
        nonlocal acquired
        acquired = True
        await original(db)

    monkeypatch.setattr(auth, "acquire_shell_name_lock", tracked_lock)
    provisioned = await auth._provision(
        session,
        settings,
        "lock-order",
        {"first_name": "Lock", "last_name": "Order"},
    )
    assert acquired
    assert provisioned.shell_name == "lock-order"


async def test_deleted_names_remain_reserved(session):
    now = datetime.now(UTC)
    original = user("original", "Brandon Helms", now)
    session.add(original)
    await session.commit()
    await ensure_shell_names(session)
    await session.commit()
    original_id = original.id

    await session.execute(delete(User).where(User.id == original_id))
    await session.commit()
    registry = await session.get(ShellNameRegistry, "brandon-helms")
    assert registry is not None
    assert registry.user_id is None

    replacement = user("replacement", "Brandon Helms", now + timedelta(days=1))
    session.add(replacement)
    await session.commit()
    await ensure_shell_names(session)
    await session.commit()
    assert replacement.shell_name == "brandon-helms-2"


async def test_database_constraints_reject_duplicate_assignments(session):
    now = datetime.now(UTC)
    first = user("first", "First", now)
    second = user("second", "Second", now)
    first.shell_name = second.shell_name = "collision"
    session.add_all([first, second])
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()

    session.add(ShellNameRegistry(name="retired", user_id=None))
    await session.commit()
    session.add(ShellNameRegistry(name="retired", user_id=None))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()

    assert (await session.execute(select(ShellNameRegistry.name))).scalars().all() == ["retired"]
