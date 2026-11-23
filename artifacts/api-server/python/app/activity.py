"""Request-owned Slack activity delivery. No secret values or raw inputs are logged."""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.logging import get_logger
from app.models import ActivityOutbox

log = get_logger(__name__)
_PATH = re.compile(r"/services/[A-Za-z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]+")


def webhook_url(settings: Settings) -> str | None:
    if not settings.slack_activity_enabled:
        return None
    value = settings.slack_activity_webhook_url.get_secret_value()
    if not value:
        return None
    try:
        parts = urlsplit(value)
        if (parts.scheme == "https" and parts.netloc == "hooks.slack.com"
                and _PATH.fullmatch(parts.path) and not parts.query and not parts.fragment
                and not any(ord(c) < 33 or c == "\\" for c in value)):
            return value
    except ValueError:
        pass
    log.warning("activity.webhook_invalid")
    return None


def safe_text(value: str, limit: int = 255) -> str:
    """Slack fallback text cannot create markup, mentions, or multiline messages."""
    single = re.sub(r"[\x00-\x1f\x7f-\x9f\s]+", " ", value)[:limit]
    return (single.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace("@", "\uff20"))


def shell_username(user) -> str:
    # Never send profile names, subjects, email, ticket identifiers or user IDs.
    return safe_text(user.shell_name or "player", 48)


def score_message(user, points: int, title: str) -> str:
    return f"{shell_username(user)} earned {points} points by completing {safe_text(title)}."


async def enqueue(db: AsyncSession, settings: Settings, key: str, message: str) -> None:
    """Insert in the caller's award/login transaction, or disable if the table has not been deployed."""
    if webhook_url(settings) is None:
        return
    try:
        # A savepoint prevents a missing table from aborting a committed award.
        async with db.begin_nested():
            await db.execute(select(ActivityOutbox.id).limit(0))
            db.add(ActivityOutbox(
                event_key=key, message=message, next_attempt_at=datetime.now(UTC),
            ))
            await db.flush()
    except Exception:
        log.warning("activity.outbox_unavailable")


async def _post(url: str, message: str) -> bool:
    try:
        async with asyncio.timeout(0.85):
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(0.65), follow_redirects=False, trust_env=False,
            ) as client:
                response = await client.post(url, json={
                    "text": message,
                    "blocks": [{"type": "section", "text": {
                        "type": "plain_text", "text": message, "emoji": False,
                    }}],
                    "unfurl_links": False, "unfurl_media": False,
                })
                return response.status_code == 200
    except (Exception, TimeoutError):
        # Never stringify an exception: HTTP errors may contain the webhook URL.
        return False


async def drain(db: AsyncSession, settings: Settings) -> None:
    """One due event per request. Row lock prevents overlap across Autoscale replicas.

    HTTP completion can be ambiguous (response lost after Slack accepts a message).
    Retry is at-least-once; a crash before recording success can duplicate delivery.
    """
    url = webhook_url(settings)
    if url is None:
        return
    try:
        now = datetime.now(UTC)
        row = (await db.execute(
            select(ActivityOutbox).where(
                ActivityOutbox.delivered_at.is_(None),
                ActivityOutbox.next_attempt_at <= now,
            ).order_by(ActivityOutbox.id).limit(1).with_for_update(skip_locked=True)
        )).scalar_one_or_none()
        if row is None:
            await db.commit()
            return
        success = await _post(url, row.message)
        if success:
            row.delivered_at = datetime.now(UTC)
        else:
            row.attempts += 1
            row.next_attempt_at = datetime.now(UTC) + timedelta(
                seconds=min(3600, 2 ** min(row.attempts, 11))
            )
            log.warning("activity.delivery_failed")
        await db.commit()
    except Exception:
        await db.rollback()
        log.warning("activity.delivery_unavailable")


async def drain_request(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings,
) -> None:
    """A separate session keeps a delivery failure from expiring auth/scoring objects."""
    if webhook_url(settings) is None:
        return
    try:
        async with asyncio.timeout(1.3), session_factory() as db:
            await drain(db, settings)
    except TimeoutError:
        log.warning("activity.delivery_unavailable")