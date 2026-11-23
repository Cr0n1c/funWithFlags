# XML fixtures deliberately retain long schema-qualified elements.
# ruff: noqa: E501
from __future__ import annotations

import asyncio
import base64
import secrets
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape

import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from onelogin.saml2.utils import OneLogin_Saml2_Utils
from pydantic import SecretStr
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import saml
from app.db import Base
from app.models import SamlTransaction, Solve, User
from tests.conftest import make_challenge, make_user, session_cookie

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
NAME = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Local test IdP")])
CERT = (x509.CertificateBuilder().subject_name(NAME).issuer_name(NAME)
        .public_key(KEY.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(days=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1)).sign(KEY, hashes.SHA256())
        .public_bytes(serialization.Encoding.PEM).decode())
PRIVATE = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()


@pytest.fixture
def configured(settings):
    settings.app_base_url = "https://ui.test"
    settings.saml_sp_entity_id = "https://ui.test/saml"
    settings.saml_acs_url = "https://ui.test/api/auth/saml/acs"
    settings.saml_idp_entity_id = "https://idp.test/entity"
    settings.saml_idp_sso_url = "https://idp.test/sso"
    settings.saml_idp_cert = SecretStr(CERT)
    return settings


def assertion(s, request_id, *, subject="stable-123", aid=None, expired=False,
              audience=None, issuer=None, recipient=None, attributes=None, signed=True,
              restrictions=None, name_qualifier=None, sp_name_qualifier=None,
              signing_key=PRIVATE, signing_cert=CERT):
    now = datetime.now(UTC)
    def stamp(t):
        return t.strftime("%Y-%m-%dT%H:%M:%SZ")
    expiry = stamp(now + timedelta(minutes=-10 if expired else 5))
    issuer = issuer or s.saml_idp_entity_id
    audience = audience or s.saml_sp_entity_id
    recipient = recipient or s.saml_acs_url
    restrictions = [[audience]] if restrictions is None else restrictions
    audience_xml = "".join(
        "<saml:AudienceRestriction>" + "".join(
            f"<saml:Audience>{escape(value)}</saml:Audience>" for value in clause
        ) + "</saml:AudienceRestriction>" for clause in restrictions
    )
    qualifiers = "".join(
        f' {key}="{escape(value)}"' for key, value in
        [("NameQualifier", name_qualifier), ("SPNameQualifier", sp_name_qualifier)]
        if value is not None
    )
    attrs = attributes or {"email": ["alice@example.test"], "firstname": ["Alice"],
                          "lastname": ["Example"], "departmentparent": ["Engineering"],
                          "departmentleaf": ["Security"], "level": ["L5"]}
    attrxml = "".join(f'<saml:Attribute Name="{k}">' + "".join(
        f'<saml:AttributeValue>{escape(v)}</saml:AttributeValue>' for v in values
    ) + "</saml:Attribute>" for k, values in attrs.items())
    xml = f'''<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
      ID="{aid or '_' + secrets.token_hex(16)}" Version="2.0" IssueInstant="{stamp(now)}">
      <saml:Issuer>{issuer}</saml:Issuer><saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"{qualifiers}>{subject}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
      <saml:SubjectConfirmationData InResponseTo="{request_id}" NotOnOrAfter="{expiry}" Recipient="{recipient}"/>
      </saml:SubjectConfirmation></saml:Subject>
      <saml:Conditions NotBefore="{stamp(now-timedelta(minutes=1))}" NotOnOrAfter="{expiry}">
      {audience_xml}
      </saml:Conditions><saml:AuthnStatement AuthnInstant="{stamp(now)}" SessionIndex="_session">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>
      </saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>{attrxml}</saml:AttributeStatement></saml:Assertion>'''
    if signed:
        xml = OneLogin_Saml2_Utils.add_sign(xml, signing_key, signing_cert).decode()
    response = f'''<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
      ID="_{secrets.token_hex(16)}" Version="2.0" IssueInstant="{stamp(now)}" Destination="{s.saml_acs_url}" InResponseTo="{request_id}">
      <saml:Issuer>{issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
      {xml}</samlp:Response>'''
    if signed:
        response = OneLogin_Saml2_Utils.add_sign(
            response, signing_key, signing_cert,
        ).decode()
    return base64.b64encode(response.encode()).decode()


def test_multiple_audience_clauses_and_valid_qualifiers(configured):
    encoded = assertion(
        configured, "_request",
        restrictions=[["other", configured.saml_sp_entity_id],
                      [configured.saml_sp_entity_id]],
        name_qualifier=configured.saml_idp_entity_id,
        sp_name_qualifier=configured.saml_sp_entity_id,
    )
    assert saml.validate(configured, encoded, "_request")[0] == "stable-123"


async def start(client, configured, session, *, popup=True):
    response = await client.get("/api/auth/login?popup=true" if popup else "/api/auth/login")
    assert response.status_code == 302
    relay = parse_qs(urlsplit(response.headers["location"]).query)["RelayState"][0]
    transaction = await session.get(SamlTransaction, saml.digest(relay))
    cookie = response.cookies[configured.saml_transaction_cookie_name]
    assert "SameSite=none" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]
    return relay, transaction.request_id, cookie


async def finish(client, s, flow, **kwargs):
    relay, request_id, cookie = flow
    return await client.post("/api/auth/saml/acs",
        data={"SAMLResponse": assertion(s, request_id, **kwargs), "RelayState": relay},
        headers={"Cookie": f"{s.saml_transaction_cookie_name}={cookie}"})


async def test_same_window_callback_restores_session(client, configured, session):
    flow = await start(client, configured, session, popup=False)
    response = await finish(client, configured, flow)
    assert response.headers["location"] == configured.app_base_url + "/?auth=ok"
    token = response.cookies[configured.session_cookie_name]
    me = await client.get("/api/auth/me", headers={
        "Cookie": f"{configured.session_cookie_name}={token}",
    })
    assert me.status_code == 200
    assert me.json()["first_name"] == "Alice"


async def test_same_window_failed_callback_returns_error_without_session(
    client, configured, session,
):
    flow = await start(client, configured, session, popup=False)
    response = await finish(client, configured, flow, expired=True)
    assert response.headers["location"].startswith(configured.app_base_url + "/?auth_error=")
    assert "auth_popup" not in response.headers["location"]
    assert configured.session_cookie_name not in response.cookies


async def test_jit_profile_repeat_and_replay(client, configured, session):
    flow = await start(client, configured, session)
    response = await finish(client, configured, flow)
    assert response.headers["location"].endswith("auth=ok&auth_popup=1")
    user = (await session.execute(select(User))).scalar_one()
    assert user.email == "alice@example.test"
    assert user.first_name == "Alice"
    assert user.last_name == "Example"
    assert user.department_parent == "Engineering"
    assert user.department_leaf == "Security"
    assert user.level == "L5"
    assert not user.is_admin
    assert "auth_error=" in (await finish(client, configured, flow)).headers["location"]
    next_flow = await start(client, configured, session)
    assert "auth=ok" in (await finish(client, configured, next_flow)).headers["location"]
    assert len((await session.execute(select(User))).scalars().all()) == 1


async def test_non_admin_groups_are_display_only_refreshed_and_cleared(client, configured, session):
    async def login_with_groups(values):
        flow = await start(client, configured, session, popup=False)
        attributes = {"email": ["alice@example.test"]}
        if values is not None:
            attributes["groups"] = values
        response = await finish(client, configured, flow, attributes=attributes)
        assert "auth=ok" in response.headers["location"]
        token = response.cookies[configured.session_cookie_name]
        me = await client.get("/api/auth/me", headers={
            "Cookie": f"{configured.session_cookie_name}={token}",
        })
        assert me.status_code == 200
        assert me.json()["is_admin"] is False
        return me.json()["groups"]

    assert await login_with_groups([" Developers ", "Admins", "Developers", " "]) == [
        "Admins", "Developers",
    ]
    assert await login_with_groups(["Reviewers"]) == ["Reviewers"]
    assert await login_with_groups(None) == []
    user = (await session.execute(select(User))).scalar_one()
    assert user.groups == []


async def test_verified_okta_admin_group_grants_and_revokes_app_access(client, configured, session, monkeypatch):
    # Real locally signed SAML assertions exercise the same provisioning path as Okta.
    for groups, allowed in [
        (["funwithflags-admins"], True),
        (["FunWithFlags-Admins"], False),
        (["funwithflags-admins-extra"], False),
        (["funwithflags-admins"], True),
        ([], False),
    ]:
        response = await finish(
            client, configured, await start(client, configured, session),
            attributes={"email": ["alice@example.test"], "groups": groups},
        )
        assert "auth=ok" in response.headers["location"]
        headers = {"Cookie": f"{configured.session_cookie_name}={response.cookies[configured.session_cookie_name]}"}
        me = await client.get("/api/auth/me", headers=headers)
        assert me.json()["is_admin"] is allowed
        for endpoint in ("users", "challenges", "audit", "submissions"):
            result = await client.get(f"/api/admin/{endpoint}", headers=headers)
            assert result.status_code == (200 if allowed else 403)
            if endpoint == "users" and allowed:
                assert result.json()[0]["is_admin"] is True
        stored = (await session.execute(select(User))).scalar_one()
        await session.refresh(stored)
        assert stored.is_admin is False  # No sticky authority after a later group removal.


@pytest.mark.parametrize("changes", [
    {"signed": False}, {"expired": True}, {"audience": "wrong"},
    {"issuer": "https://evil.test/entity"}, {"recipient": "https://evil.test/acs"},
    {"recipient": "https://ui.test/api/auth/saml/acs/evil"},
    {"attributes": {"email": ["a", "b"]}},
    {"attributes": {"groups": ["x" * 256]}},
    {"attributes": {"groups": ["group"] * 201}},
    {"attributes": {"groups": ["group\nspoofed"]}},
    {"attributes": {"groups": ["group\u202espoofed"]}},
    {"restrictions": [["https://ui.test/saml"], ["https://other.test/saml"]]},
    {"restrictions": []},
    {"name_qualifier": "https://other.test/entity"},
    {"sp_name_qualifier": "https://other.test/saml"},
])
async def test_invalid_assertions_create_no_accounts(client, configured, session, changes):
    flow = await start(client, configured, session)
    result = await finish(client, configured, flow, **changes)
    assert "auth_error=" in result.headers["location"]
    assert not (await session.execute(select(User))).scalars().all()


async def test_disabled_and_no_email_link(client, configured, session):
    legacy = User(okta_sub="legacy:old", username="alice", email="alice@example.test")
    session.add(legacy)
    await session.commit()
    flow = await start(client, configured, session)
    await finish(client, configured, flow)
    users = (await session.execute(select(User).order_by(User.id))).scalars().all()
    assert len(users) == 2
    users[1].is_active = False
    await session.commit()
    result = await finish(client, configured, await start(client, configured, session))
    assert "disabled" in result.headers["location"]


async def test_browser_binding(client, configured, session):
    relay, request_id, _ = await start(client, configured, session)
    result = await client.post("/api/auth/saml/acs",
        data={"SAMLResponse": assertion(configured, request_id), "RelayState": relay})
    assert "auth_error=" in result.headers["location"]
    assert not (await session.execute(select(User))).scalars().all()


async def test_unconfigured_and_old_routes(client):
    assert "auth_error=" in (await client.get("/api/auth/login")).headers["location"]
    assert (await client.get("/api/auth/saml/metadata")).status_code == 503
    assert (await client.get("/api/callback")).status_code == 404
    assert (await client.get("/api/auth/callback")).status_code == 404
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.get("/api/auth/home-roster")).status_code == 401


async def test_home_roster_is_minimal_active_login_roster(client, configured, session):
    owner = await make_user(session, username="owner")
    owner.okta_sub = "saml:owner"
    owner.full_name = "Same Name"
    owner.last_login_at = datetime.now(UTC)
    peer = await make_user(session, username="peer")
    peer.okta_sub = "saml:peer"
    peer.full_name = "Same Name"
    peer.last_login_at = datetime.now(UTC)
    boundary = await make_user(session, username="boundary")
    boundary.okta_sub = "saml:boundary"
    boundary.full_name = f"{'a' * 47} b"
    boundary.last_login_at = datetime.now(UTC)
    never_logged_in = await make_user(session, username="new")
    never_logged_in.okta_sub = "saml:new"
    never_logged_in.last_login_at = None
    disabled = await make_user(session, username="disabled")
    disabled.okta_sub = "saml:disabled"
    disabled.last_login_at = datetime.now(UTC)
    disabled.is_active = False
    legacy = await make_user(session, username="legacy")
    legacy.last_login_at = datetime.now(UTC)
    await session.commit()

    headers = session_cookie(configured, owner)
    response = await client.get("/api/auth/home-roster", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["owner"] == {
        "account_id": str(owner.id),
        "home": "/home/same-name",
    }
    assert body["entries"] == [
        {"home": "/home/same-name"},
        {"home": "/home/same-name-2"},
        {"home": f"/home/{'a' * 47}"},
    ]
    assert set(body) == {"owner", "entries"}
    assert all(set(entry) == {"home"} for entry in body["entries"])
    serialized = response.text.lower()
    for private_value in (
        owner.email, owner.okta_sub, owner.department_parent,
        peer.email, peer.okta_sub,
    ):
        if private_value:
            assert private_value.lower() not in serialized

    me = await client.get("/api/auth/me", headers=headers)
    assert me.json()["account_id"] == str(owner.id)
    assert me.json()["home"] == "/home/same-name"


async def test_assertion_replay_across_transactions(client, configured, session):
    first = await start(client, configured, session)
    assert "auth=ok" in (await finish(client, configured, first, aid="_same")).headers["location"]
    second = await start(client, configured, session)
    assert "auth_error=" in (
        await finish(client, configured, second, aid="_same")
    ).headers["location"]


async def test_wrong_request_and_tampering(client, configured, session):
    for tamper in (False, True):
        relay, req, cookie = await start(client, configured, session)
        encoded = assertion(configured, req if tamper else "_wrong_request")
        if tamper:
            xml = base64.b64decode(encoded).replace(b"Alice", b"Mallory")
            encoded = base64.b64encode(xml).decode()
        result = await client.post("/api/auth/saml/acs",
            data={"SAMLResponse": encoded, "RelayState": relay},
            headers={"Cookie": f"{configured.saml_transaction_cookie_name}={cookie}"})
        assert "auth_error=" in result.headers["location"]
    assert not (await session.execute(select(User))).scalars().all()


async def test_admin_me_logout_and_old_session(client, configured, session):
    configured.saml_admin_subjects = ["stable-123"]
    result = await finish(client, configured, await start(client, configured, session))
    token = result.cookies[configured.session_cookie_name]
    headers = {"Cookie": f"{configured.session_cookie_name}={token}"}
    me = await client.get("/api/auth/me", headers=headers)
    assert me.json()["is_admin"] is True
    assert me.json()["department_parent"] == "Engineering"
    assert (await client.post("/api/auth/logout", headers=headers)).status_code == 204
    user = (await session.execute(select(User))).scalar_one()
    old = jwt.encode({"aud": "fwf:legacy-session", "sub": str(user.id),
                      "iat": int(time.time()), "exp": int(time.time())+600},
                     configured.session_secret.get_secret_value(), algorithm="HS256")
    assert (await client.get("/api/auth/me", headers={
        "Cookie": f"{configured.session_cookie_name}={old}",
    })).status_code == 401


async def test_required_and_metadata(client, configured, session):
    configured.saml_required_attributes = ["level"]
    result = await finish(client, configured, await start(client, configured, session),
                          attributes={"email": ["alice@example.test"]})
    assert "auth_error=" in result.headers["location"]
    assert not (await session.execute(select(User))).scalars().all()
    metadata = await client.get("/api/auth/saml/metadata")
    assert metadata.status_code == 200
    assert configured.saml_acs_url in metadata.text


async def test_repeat_refresh_preserves_score(client, configured, session):
    await finish(client, configured, await start(client, configured, session))
    user = (await session.execute(select(User))).scalar_one()
    challenge = await make_challenge(session, configured)
    session.add(Solve(user_id=user.id, challenge_id=challenge.id, points_awarded=100))
    await session.commit()
    result = await finish(client, configured, await start(client, configured, session),
                          attributes={"firstname": ["Updated"], "level": ["L6"]})
    token = result.cookies[configured.session_cookie_name]
    me = await client.get("/api/auth/me", headers={
        "Cookie": f"{configured.session_cookie_name}={token}",
    })
    assert me.json()["score"] == 100
    assert me.json()["first_name"] == "Updated"
    assert me.json()["email"] is None
    assert me.json()["level"] == "L6"


async def test_expired_transaction_and_unsolicited(client, configured, session):
    flow = await start(client, configured, session)
    transaction = await session.get(SamlTransaction, saml.digest(flow[0]))
    transaction.expires_at = datetime.now(UTC) - timedelta(seconds=10)
    await session.commit()
    assert "auth_error=" in (await finish(client, configured, flow)).headers["location"]
    arbitrary = ("unknown-relay", "_unrequested", "browser")
    assert "auth_error=" in (await finish(client, configured, arbitrary)).headers["location"]
    assert not (await session.execute(select(User))).scalars().all()


async def test_oversized_and_control_attributes(client, configured, session):
    for attributes in ({"level": ["x" * 129]}, {"firstname": ["bad\nname"]},
                       {"firstname": ["Alice", "Other"]}):
        result = await finish(client, configured, await start(client, configured, session),
                              attributes=attributes)
        assert "auth_error=" in result.headers["location"]
    assert not (await session.execute(select(User))).scalars().all()


async def test_transaction_consumption_is_atomic(tmp_path):
    """Separate DB connections compete for the same DELETE RETURNING row."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'transactions.db'}")
    factory = async_sessionmaker(engine)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with factory() as db:
        db.add(SamlTransaction(relay_hash="r", browser_hash="b", request_id="_r", popup=True,
                               expires_at=datetime.now(UTC) + timedelta(minutes=5)))
        await db.commit()
    async def consume():
        async with factory() as db:
            row = (await db.execute(delete(SamlTransaction).where(
                SamlTransaction.relay_hash == "r",
            ).returning(SamlTransaction.request_id))).first()
            await db.commit()
            return row is not None
    try:
        assert sum(await asyncio.gather(consume(), consume())) == 1
    finally:
        await engine.dispose()