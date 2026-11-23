"""SP-initiated Okta SAML and application-only logout."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, quote

from fastapi import APIRouter, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app import saml
from app.activity import drain_request, enqueue, shell_username
from app.config import LOCAL_HOSTS
from app.models import AuditLog, SamlReplay, SamlTransaction, User
from app.schemas import HomeRosterEntry, HomeRosterOut, HomeRosterOwner, UserOut
from app.security import (
    CurrentUser,
    DbDep,
    SettingsDep,
    cookie_kwargs,
    encode_session,
    has_app_admin_access,
    random_token,
    user_score,
)
from app.shell_names import acquire_shell_name_lock, ensure_shell_names

router = APIRouter(prefix="/auth", tags=["auth"])
ACS_PATH = "/api/auth/saml/acs"


def _account_id(user: User) -> str:
    """Public, immutable account key. It deliberately reveals no Okta subject."""
    return str(user.id)


def _home_name(user: User) -> str:
    if user.shell_name is None:
        raise RuntimeError("shell name was not allocated")
    return f"/home/{user.shell_name}"


def _redirect(settings, *, popup=False, error=None):
    query = "auth=ok" if error is None else "auth_error=" + quote(error)
    if popup:
        query += "&auth_popup=1"
    response = RedirectResponse(f"{settings.app_base_url}/?{query}", status_code=303)
    response.delete_cookie(settings.saml_transaction_cookie_name, path=ACS_PATH, secure=True,
                           httponly=True, samesite="none")
    response.headers["Cache-Control"] = "no-store"
    return response


async def _local_dev_login(request: Request, settings, db, *, popup: bool):
    """Sign in a fixed local account. Reachable only when Settings accepted LOCAL_DEV_LOGIN."""
    client = request.client.host if request.client else ""
    if (settings.environment != "development" or client not in LOCAL_HOSTS
            or settings.saml_idp_sso_url):
        return _redirect(settings, popup=popup, error="Local sign-in is not available.")
    user = await _provision(db, settings, "local-dev", {
        "email": "dev@localhost", "first_name": "Local", "last_name": "Developer",
        "groups": ["funwithflags-admins"],
    })
    db.add(AuditLog(user_id=user.id, event_type="local_dev.login", detail={}))
    await db.commit()
    response = _redirect(settings, popup=popup)
    response.set_cookie(settings.session_cookie_name, encode_session(settings, user),
                        **cookie_kwargs(settings, max_age=settings.session_max_age_seconds))
    return response


@router.get("/login")
async def login(request: Request, settings: SettingsDep, db: DbDep, popup: bool = False):
    if settings.local_dev_login:
        return await _local_dev_login(request, settings, db, popup=popup)
    relay, browser = random_token(), random_token()
    try:
        client = saml.auth(settings)
        url = client.login(return_to=relay)
        request_id = client.get_last_request_id()
        if not request_id:
            raise saml.SamlError("Could not start Okta SAML sign-in.")
    except saml.SamlError as exc:
        return _redirect(settings, popup=popup, error=str(exc))
    except Exception:
        return _redirect(settings, popup=popup, error="Could not start Okta SAML sign-in.")
    await db.execute(delete(SamlTransaction).where(SamlTransaction.expires_at < datetime.now(UTC)))
    db.add(SamlTransaction(
        relay_hash=saml.digest(relay), browser_hash=saml.digest(browser),
        request_id=request_id, popup=popup, expires_at=datetime.now(UTC) + timedelta(minutes=10),
    ))
    await db.commit()
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(settings.saml_transaction_cookie_name, browser, max_age=600,
                        path=ACS_PATH, secure=True, httponly=True, samesite="none")
    return response


@router.get("/saml/metadata")
async def metadata(settings: SettingsDep):
    try:
        return Response(saml.metadata(settings), media_type="application/samlmetadata+xml")
    except saml.SamlError as exc:
        return Response(str(exc), status_code=503, media_type="text/plain")


async def _provision(db, settings, subject, profile):
    # All allocator/provisioning paths take locks in this order: advisory lock,
    # then user row locks. This prevents inversion with global backfill.
    await acquire_shell_name_lock(db)
    key = saml.subject_key(settings.saml_idp_entity_id, subject)
    user = (await db.execute(
        select(User).where(User.okta_sub == key).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        # Deterministic subject-derived username cannot collide with profile-name changes.
        # Database uniqueness + savepoint handles concurrent JIT requests on any replica.
        try:
            async with db.begin_nested():
                user = User(okta_sub=key, username="saml-" + key[5:], groups=[])
                db.add(user)
                await db.flush()
        except IntegrityError:
            user = (await db.execute(
                select(User).where(User.okta_sub == key).with_for_update()
            )).scalar_one_or_none()
            if user is None:
                raise saml.SamlError(
                    "Account provisioning conflict; contact the administrator."
                ) from None
    if not user.is_active:
        raise saml.SamlError("This account is disabled.")
    for name, value in profile.items():
        setattr(user, name, value)
    user.full_name = " ".join(filter(None, [user.first_name, user.last_name]))[:255] or None
    user.is_admin = subject in settings.saml_admin_subjects
    user.last_login_at = datetime.now(UTC)
    await db.flush()
    await ensure_shell_names(db)
    return user


@router.post("/saml/acs")
async def callback(request: Request, settings: SettingsDep, db: DbDep):
    popup = False
    try:
        saml.toolkit_settings(settings)
        content_type = request.headers.get("content-type", "").split(";")[0]
        if content_type != "application/x-www-form-urlencoded":
            raise saml.SamlError("Invalid SAML response binding.")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 262144:
                raise saml.SamlError("SAML response exceeds the size limit.")
        try:
            form = parse_qs(body.decode("ascii"), strict_parsing=True, max_num_fields=4)
        except (ValueError, UnicodeError):
            raise saml.SamlError("Invalid SAML response form.") from None
        if set(form) != {"SAMLResponse", "RelayState"} or any(len(v) != 1 for v in form.values()):
            raise saml.SamlError("Invalid SAML response form.")
        relay = form["RelayState"][0]
        browser = request.cookies.get(settings.saml_transaction_cookie_name, "")
        if len(relay) > 128 or len(browser) > 128 or not browser:
            raise saml.SamlError("Sign-in session expired; please try again.")
        # Atomic DELETE RETURNING consumes once, even under concurrent callbacks.
        result = await db.execute(delete(SamlTransaction).where(
            SamlTransaction.relay_hash == saml.digest(relay),
            SamlTransaction.browser_hash == saml.digest(browser),
            SamlTransaction.expires_at > datetime.now(UTC),
        ).returning(SamlTransaction.request_id, SamlTransaction.popup))
        transaction = result.first()
        await db.commit()
        if transaction is None:
            raise saml.SamlError("Sign-in session expired; please try again.")
        popup = transaction.popup
        subject, assertion_id, profile = await asyncio.to_thread(
            saml.validate, settings, form["SAMLResponse"][0], transaction.request_id,
        )
        db.add(SamlReplay(
            assertion_hash=saml.subject_key(settings.saml_idp_entity_id, assertion_id)[5:],
        ))
        await db.flush()
        user = await _provision(db, settings, subject, profile)
        audit = AuditLog(user_id=user.id, event_type="saml.login", detail={})
        db.add(audit)
        await db.flush()
        await enqueue(db, settings, f"login:{audit.id}",
                      f"{shell_username(user)} logged into Fun With Flags.")
        await db.commit()
    except (saml.SamlError, IntegrityError) as exc:
        await db.rollback()
        error = str(exc) if isinstance(exc, saml.SamlError) else "SAML response was already used."
        return _redirect(settings, popup=popup, error=error)
    await drain_request(request.app.state.db.session_factory, settings)
    response = _redirect(settings, popup=popup)
    response.set_cookie(settings.session_cookie_name, encode_session(settings, user),
                        **cookie_kwargs(settings, max_age=settings.session_max_age_seconds))
    return response


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser, db: DbDep):
    if await ensure_shell_names(db):
        await db.commit()
    score, solves = await user_score(db, user.id)
    return UserOut(
        account_id=_account_id(user), home=_home_name(user),
        username=user.username, email=user.email, full_name=user.full_name,
        first_name=user.first_name, last_name=user.last_name,
        department_parent=user.department_parent, department_leaf=user.department_leaf,
        level=user.level, groups=user.groups, is_admin=has_app_admin_access(user), score=score, solves=solves,
    )


@router.get("/home-roster", response_model=HomeRosterOut)
async def home_roster(user: CurrentUser, db: DbDep):
    """Return only the simulated-home data needed by the browser shell."""
    if await ensure_shell_names(db):
        await db.commit()
    users = (await db.execute(
        select(User).where(
            User.is_active.is_(True),
            User.last_login_at.is_not(None),
            User.okta_sub.like("saml:%"),
        ).order_by(User.id)
    )).scalars().all()
    return HomeRosterOut(
        owner=HomeRosterOwner(account_id=_account_id(user), home=_home_name(user)),
        entries=[HomeRosterEntry(home=_home_name(entry)) for entry in users],
    )


@router.post("/logout", status_code=204)
async def logout(settings: SettingsDep, db: DbDep, user: CurrentUser):
    db.add(AuditLog(user_id=user.id, event_type="logout", detail={}))
    await db.commit()
    response = Response(status_code=204)
    response.delete_cookie(
        settings.session_cookie_name, path="/", domain=settings.session_cookie_domain,
    )
    return response