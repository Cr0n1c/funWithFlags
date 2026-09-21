"""Sessions, OIDC state, flag hashing and FastAPI auth dependencies."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models import Solve, User

SESSION_AUDIENCE = "fwf:session"
STATE_AUDIENCE = "fwf:oidc-state"
OIDC_STATE_TTL_SECONDS = 10 * 60


# ------------------------------------------------------------------ PKCE / nonce


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


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


def encode_oidc_state(settings: Settings, *, state: str, nonce: str, code_verifier: str) -> str:
    return _encode(
        settings,
        {"state": state, "nonce": nonce, "cv": code_verifier},
        STATE_AUDIENCE,
        OIDC_STATE_TTL_SECONDS,
    )


def decode_oidc_state(settings: Settings, token: str) -> dict[str, Any] | None:
    return _decode(settings, token, STATE_AUDIENCE)


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
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]
AdminUser = Annotated[User, Depends(require_admin)]


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
