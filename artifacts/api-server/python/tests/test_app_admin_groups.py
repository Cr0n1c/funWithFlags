from datetime import UTC, datetime

import pytest

from tests.conftest import make_user, session_cookie
from tests.test_flag_admin import _member


async def test_existing_verified_member_session_has_admin_role(client, settings, session):
    user = await _member(session)
    assert not user.is_admin
    headers = session_cookie(settings, user)
    assert (await client.get("/api/auth/me", headers=headers)).json()["is_admin"] is True
    assert (await client.get("/api/admin/users", headers=headers)).status_code == 200
    # A refreshed server-side membership applies to the same existing cookie.
    user.groups = []
    await session.commit()
    assert (await client.get("/api/auth/me", headers=headers)).json()["is_admin"] is False
    assert (await client.get("/api/admin/users", headers=headers)).status_code == 403


@pytest.mark.parametrize(
    "identity,logged_in,groups",
    [
        ("unverified-subject", True, ["funwithflags-admins"]),
        ("saml:" + "a" * 64, False, ["funwithflags-admins"]),
        ("saml:" + "a" * 64, True, ["FunWithFlags-Admins"]),
        ("saml:" + "a" * 64, True, ["funwithflags-admins-extra"]),
        ("saml:" + "a" * 64, True, []),
    ],
)
async def test_unverified_and_nonmember_admin_denied(
    client, settings, session, identity, logged_in, groups
):
    user = await make_user(session, username="not-an-admin", groups=groups)
    user.okta_sub = identity
    user.last_login_at = datetime.now(UTC) if logged_in else None
    await session.commit()
    headers = session_cookie(settings, user)
    assert (await client.get("/api/auth/me", headers=headers)).json()["is_admin"] is False
    for endpoint in ("users", "audit", "challenges", "submissions"):
        assert (await client.get(f"/api/admin/{endpoint}", headers=headers)).status_code == 403


async def test_signed_out_and_disabled_member_denied(client, settings, session):
    assert (await client.get("/api/admin/users")).status_code == 401
    user = await _member(session)
    user.is_active = False
    await session.commit()
    assert (
        await client.get("/api/admin/users", headers=session_cookie(settings, user))
    ).status_code == 401
