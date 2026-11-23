"""Sessions, flag hashing and FastAPI auth dependencies."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models import Solve, User

SESSION_AUDIENCE = "fwf:okta-saml-session:v1"
FLAG_DELETE_AUDIENCE = "fwf:flag-delete:v1"
FLAG_ADMIN_GROUP = "funwithflags-admins"
FLAG_DELETE_TTL_SECONDS = 300


# ------------------------------------------------------------------ PKCE / nonce


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


# ------------------------------------------------------------ signed cookies


def _encode(settings: Settings, payload: dict[str, Any], audience: str, ttl: int) -> str:
    now = int(time.time())
    return jwt.encode(
        {**payload, "aud": audience, "iat": now, "exp": now + ttl},
        settings.session_secret.get_secret_value(),
        algorithm="HS256",
    )


def _decode(settings: Settings, token: str, audience: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(
            token,
            settings.session_secret.get_secret_value(),
            algorithms=["HS256"],
            audience=audience,
            options={"require": ["exp", "iat", "aud"]},
        )
    except jwt.InvalidTokenError:
        return None


def encode_session(settings: Settings, user: User) -> str:
    return _encode(
        settings,
        {"sub": str(user.id), "username": user.username},
        SESSION_AUDIENCE,
        settings.session_max_age_seconds,
    )


def decode_session(settings: Settings, token: str) -> int | None:
    payload = _decode(settings, token, SESSION_AUDIENCE)
    if not payload:
        return None
    try:
        return int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        return None


def encode_flag_delete_token(settings: Settings, user_id: int, challenge: Any) -> str:
    """Bind a short-lived confirmation to one immutable row and its current metadata."""
    return _encode(
        settings,
        {
            "sub": str(user_id),
            "cid": challenge.id,
            "slug": challenge.slug,
            "version": challenge_version(challenge),
        },
        FLAG_DELETE_AUDIENCE,
        FLAG_DELETE_TTL_SECONDS,
    )


def decode_flag_delete_token(settings: Settings, token: str) -> dict[str, Any] | None:
    return _decode(settings, token, FLAG_DELETE_AUDIENCE)


def challenge_version(challenge: Any) -> str:
    fields = (
        str(challenge.id),
        challenge.slug,
        challenge.title,
        challenge.description,
        str(challenge.points),
        challenge.category,
        challenge.flag_hash,
        str(challenge.case_sensitive),
        str(challenge.is_active),
        str(challenge.hidden),
    )
    return hashlib.sha256("\0".join(fields).encode()).hexdigest()


def cookie_kwargs(settings: Settings, *, max_age: int) -> dict[str, Any]:
    return {
        "max_age": max_age,
        "httponly": True,
        "secure": settings.session_cookie_secure,
        "samesite": settings.session_cookie_samesite,
        "domain": settings.session_cookie_domain,
        "path": "/",
    }


# ------------------------------------------------------------------ flags


def normalize_flag(flag: str, *, case_sensitive: bool) -> str:
    normalized = flag.strip()
    return normalized if case_sensitive else normalized.lower()


def hash_flag(settings: Settings, flag: str, *, case_sensitive: bool) -> str:
    normalized = normalize_flag(flag, case_sensitive=case_sensitive)
    return hmac.new(
        settings.flag_hash_secret.get_secret_value().encode("utf-8"),
        normalized.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_flag(
    settings: Settings, submitted: str, stored_hash: str, *, case_sensitive: bool
) -> bool:
    candidate = hash_flag(settings, submitted, case_sensitive=case_sensitive)
    return hmac.compare_digest(candidate, stored_hash)


async def acquire_flag_mutation_lock(db: AsyncSession) -> None:
    """Serialize flag mutations across PostgreSQL workers, including an empty table."""
    bind = db.get_bind()
    if bind.dialect.name == "postgresql":
        # Fixed application namespace; held until the surrounding transaction ends.
        await db.execute(text("SELECT pg_advisory_xact_lock(1180124743)"))


# ------------------------------------------------------------- dependencies


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.db.session_factory() as session:
        yield session


SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
DbDep = Annotated[AsyncSession, Depends(get_db)]


async def get_optional_user(request: Request, settings: SettingsDep, db: DbDep) -> User | None:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        return None
    user_id = decode_session(settings, token)
    if user_id is None:
        return None
    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        return None
    return user


async def get_current_user(user: Annotated[User | None, Depends(get_optional_user)]) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


async def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if not has_app_admin_access(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


def has_verified_admin_group(user: User) -> bool:
    """Only group claims stored from an authenticated, issuer-qualified SAML login."""
    qualified_identity = (
        len(user.okta_sub) == 69
        and user.okta_sub.startswith("saml:")
        and all(char in "0123456789abcdef" for char in user.okta_sub[5:])
    )
    return (
        user.last_login_at is not None
        and qualified_identity
        and isinstance(user.groups, list)
        and FLAG_ADMIN_GROUP in user.groups
    )


def has_app_admin_access(user: User) -> bool:
    # Keep the persisted bit for the existing explicit subject allowlist only.
    # Group-derived authority is evaluated afresh, never latched into that bit.
    return bool(user.is_admin or has_verified_admin_group(user))


async def require_flag_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    """Flag mutations still require verified group membership, not an allowlist bit."""
    if not has_verified_admin_group(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Permission denied")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]
AdminUser = Annotated[User, Depends(require_admin)]
FlagAdminUser = Annotated[User, Depends(require_flag_admin)]


async def user_score(db: AsyncSession, user_id: int) -> tuple[int, int]:
    """Return (total points, number of solves) for a user."""
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(Solve.points_awarded), 0),
                func.count(Solve.id),
            ).where(Solve.user_id == user_id)
        )
    ).one()
    return int(row[0]), int(row[1])


def client_ip(request: Request) -> str | None:
    # uvicorn rewrites request.client from X-Forwarded-For when --proxy-headers is set.
    return request.client.host if request.client else None
