"""Okta login/logout. The browser never sees Okta tokens; it only gets an HttpOnly session."""

from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import APIRouter, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.config import Settings
from app.logging import get_logger
from app.models import AuditLog, User
from app.okta import OktaClient, OktaError, OktaIdentity
from app.schemas import UserOut
from app.security import (
    CurrentUser,
    DbDep,
    SettingsDep,
    client_ip,
    cookie_kwargs,
    decode_oidc_state,
    encode_oidc_state,
    encode_session,
    pkce_pair,
    random_token,
    user_score,
)

router = APIRouter(prefix="/auth", tags=["auth"])
log = get_logger(__name__)


def _okta(request: Request) -> OktaClient:
    return request.app.state.okta


def _ui_redirect(settings: Settings, *, ok: bool, error: str | None = None) -> RedirectResponse:
    query = "auth=ok" if ok else f"auth_error={quote(error or 'Login failed')}"
    response = RedirectResponse(
        f"{settings.app_base_url}/?{query}", status_code=status.HTTP_303_SEE_OTHER
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/login", summary="Start the Okta login redirect")
async def login(request: Request, settings: SettingsDep) -> Response:
    state = random_token()
    nonce = random_token()
    verifier, challenge = pkce_pair()
    try:
        url = await _okta(request).authorize_url(state=state, nonce=nonce, code_challenge=challenge)
    except OktaError as exc:
        return _ui_redirect(settings, ok=False, error=str(exc))

    response = RedirectResponse(url, status_code=status.HTTP_302_FOUND)
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        settings.oidc_state_cookie_name,
        encode_oidc_state(settings, state=state, nonce=nonce, code_verifier=verifier),
        **cookie_kwargs(settings, max_age=600),
    )
    return response


@router.get("/callback", summary="Okta redirect target")
async def callback(
    request: Request,
    settings: SettingsDep,
    db: DbDep,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
) -> Response:
    if error:
        log.warning("auth.okta_error", error=error, description=error_description)
        return _ui_redirect(settings, ok=False, error="The identity provider returned an error")

    raw_state = request.cookies.get(settings.oidc_state_cookie_name)
    saved = decode_oidc_state(settings, raw_state) if raw_state else None
    if not code or not state or saved is None or saved.get("state") != state:
        log.warning("auth.state_mismatch", has_cookie=bool(raw_state))
        return _ui_redirect(settings, ok=False, error="Login session expired, please try again")

    okta = _okta(request)
    try:
        tokens = await okta.exchange_code(code=code, code_verifier=saved["cv"])
        claims = await okta.verify_id_token(tokens["id_token"], nonce=saved["nonce"])
        userinfo = await okta.userinfo(tokens["access_token"]) if tokens.get("access_token") else {}
        identity = okta.extract_identity(claims, userinfo)
    except OktaError as exc:
        return _ui_redirect(settings, ok=False, error=str(exc))

    user = await _upsert_user(db, settings, identity)
    db.add(
        AuditLog(
            user_id=user.id,
            event_type="login",
            detail={"groups": user.groups, "is_admin": user.is_admin},
            ip_address=client_ip(request),
        )
    )
    await db.commit()
    log.info("auth.login", user_id=user.id, username=user.username, is_admin=user.is_admin)

    response = _ui_redirect(settings, ok=True)
    response.delete_cookie(
        settings.oidc_state_cookie_name, path="/", domain=settings.session_cookie_domain
    )
    response.set_cookie(
        settings.session_cookie_name,
        encode_session(settings, user),
        **cookie_kwargs(settings, max_age=settings.session_max_age_seconds),
    )
    return response


async def _upsert_user(db: DbDep, settings: SettingsDep, identity: OktaIdentity) -> User:
    is_admin = bool(set(identity.groups) & set(settings.admin_groups))
    user = (
        await db.execute(select(User).where(User.okta_sub == identity.sub))
    ).scalar_one_or_none()

    if user is None:
        # Usernames are unique; if someone else already holds this one (e.g. a renamed
        # account), fall back to a sub-suffixed name rather than failing the login.
        username = identity.username
        clash = (
            await db.execute(select(User.id).where(User.username == username))
        ).scalar_one_or_none()
        if clash is not None:
            username = f"{username}#{identity.sub[-6:]}"
        user = User(okta_sub=identity.sub, username=username)
        db.add(user)

    user.email = identity.email
    user.full_name = identity.full_name
    user.groups = identity.groups
    user.is_admin = is_admin
    user.last_login_at = datetime.now(UTC)
    await db.flush()
    return user


@router.get("/me", response_model=UserOut, summary="Current session")
async def me(user: CurrentUser, db: DbDep) -> UserOut:
    score, solves = await user_score(db, user.id)
    return UserOut(
        username=user.username,
        email=user.email,
        full_name=user.full_name,
        groups=user.groups,
        is_admin=user.is_admin,
        score=score,
        solves=solves,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="End the session")
async def logout(
    request: Request, response: Response, settings: SettingsDep, db: DbDep, user: CurrentUser
) -> Response:
    db.add(AuditLog(user_id=user.id, event_type="logout", ip_address=client_ip(request)))
    await db.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(
        settings.session_cookie_name, path="/", domain=settings.session_cookie_domain
    )
    response.headers["Cache-Control"] = "no-store"
    return response
