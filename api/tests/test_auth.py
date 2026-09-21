from __future__ import annotations

import time
from urllib.parse import parse_qs, urlparse

import jwt
import jwt.algorithms
import pytest
import respx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import Response
from sqlalchemy import select

from app.models import AuditLog, User
from app.security import decode_oidc_state

ISSUER = "https://okta.test/oauth2/default"
KID = "test-kid"

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_JWK = jwt.algorithms.RSAAlgorithm.to_jwk(_KEY.public_key(), as_dict=True) | {
    "kid": KID,
    "use": "sig",
    "alg": "RS256",
}
_PRIVATE_PEM = _KEY.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
)


def _id_token(*, nonce: str, aud: str = "test-client-id", **extra: object) -> str:
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": aud,
        "sub": "00u123",
        "iat": now,
        "exp": now + 300,
        "nonce": nonce,
        "email": "alice@semgrep.com",
        "preferred_username": "alice@semgrep.com",
        "name": "Alice Example",
        **extra,
    }
    return jwt.encode(claims, _PRIVATE_PEM, algorithm="RS256", headers={"kid": KID})


@pytest.fixture
def okta_mock():
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{ISSUER}/.well-known/openid-configuration").mock(
            return_value=Response(
                200,
                json={
                    "issuer": ISSUER,
                    "authorization_endpoint": f"{ISSUER}/v1/authorize",
                    "token_endpoint": f"{ISSUER}/v1/token",
                    "userinfo_endpoint": f"{ISSUER}/v1/userinfo",
                    "jwks_uri": f"{ISSUER}/v1/keys",
                    "end_session_endpoint": f"{ISSUER}/v1/logout",
                },
            )
        )
        mock.get(f"{ISSUER}/v1/keys").mock(return_value=Response(200, json={"keys": [_PUBLIC_JWK]}))
        yield mock


async def _start_login(client, settings):
    resp = await client.get("/api/auth/login")
    assert resp.status_code == 302
    location = urlparse(resp.headers["location"])
    qs = parse_qs(location.query)
    assert location.path == "/oauth2/default/v1/authorize"
    assert qs["client_id"] == ["test-client-id"]
    assert qs["code_challenge_method"] == ["S256"]
    assert qs["scope"] == ["openid profile email groups"]
    state_cookie = resp.cookies[settings.oidc_state_cookie_name]
    saved = decode_oidc_state(settings, state_cookie)
    assert saved is not None
    assert saved["state"] == qs["state"][0]
    assert saved["nonce"] == qs["nonce"][0]
    return saved


async def test_login_redirects_to_okta_with_pkce(client, settings, okta_mock):
    await _start_login(client, settings)


async def test_callback_creates_user_with_groups_and_admin(client, settings, session, okta_mock):
    saved = await _start_login(client, settings)
    id_token = _id_token(nonce=saved["nonce"], groups=["Everyone", "ctf-admins"])
    token_route = okta_mock.post(f"{ISSUER}/v1/token").mock(
        return_value=Response(
            200, json={"id_token": id_token, "access_token": "at", "token_type": "Bearer"}
        )
    )
    okta_mock.get(f"{ISSUER}/v1/userinfo").mock(
        return_value=Response(
            200, json={"sub": "00u123", "groups": ["Everyone", "ctf-admins", "eng"]}
        )
    )

    resp = await client.get("/api/auth/callback", params={"code": "abc", "state": saved["state"]})
    assert resp.status_code == 303
    assert resp.headers["location"] == "http://ui.test/?auth=ok"
    assert settings.session_cookie_name in resp.cookies

    token_call = token_route.calls.last.request
    assert token_call.headers["authorization"].startswith("Basic ")
    body = parse_qs(token_call.content.decode())
    assert body["grant_type"] == ["authorization_code"]
    assert body["code_verifier"] == [saved["cv"]]

    user = (await session.execute(select(User))).scalar_one()
    assert user.username == "alice@semgrep.com"
    assert user.full_name == "Alice Example"
    assert user.email == "alice@semgrep.com"
    assert user.groups == ["Everyone", "ctf-admins"]  # ID-token claim wins over userinfo
    assert user.is_admin is True
    assert user.last_login_at is not None
    audit = (await session.execute(select(AuditLog))).scalar_one()
    assert audit.event_type == "login"

    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json() == {
        "username": "alice@semgrep.com",
        "email": "alice@semgrep.com",
        "full_name": "Alice Example",
        "groups": ["Everyone", "ctf-admins"],
        "is_admin": True,
        "score": 0,
        "solves": 0,
    }

    out = await client.post("/api/auth/logout")
    assert out.status_code == 204
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_callback_groups_from_userinfo_when_missing_in_id_token(
    client, settings, session, okta_mock
):
    saved = await _start_login(client, settings)
    okta_mock.post(f"{ISSUER}/v1/token").mock(
        return_value=Response(
            200, json={"id_token": _id_token(nonce=saved["nonce"]), "access_token": "at"}
        )
    )
    okta_mock.get(f"{ISSUER}/v1/userinfo").mock(
        return_value=Response(200, json={"sub": "00u123", "groups": ["eng"]})
    )
    resp = await client.get("/api/auth/callback", params={"code": "abc", "state": saved["state"]})
    assert resp.status_code == 303
    user = (await session.execute(select(User))).scalar_one()
    assert user.groups == ["eng"]
    assert user.is_admin is False


async def test_callback_rejects_state_mismatch(client, settings, okta_mock):
    await _start_login(client, settings)
    resp = await client.get("/api/auth/callback", params={"code": "abc", "state": "forged"})
    assert resp.status_code == 303
    assert "auth_error=" in resp.headers["location"]
    assert settings.session_cookie_name not in resp.cookies


async def test_callback_rejects_bad_nonce_and_audience(client, settings, okta_mock):
    saved = await _start_login(client, settings)
    okta_mock.post(f"{ISSUER}/v1/token").mock(
        return_value=Response(
            200, json={"id_token": _id_token(nonce="wrong"), "access_token": "at"}
        )
    )
    resp = await client.get("/api/auth/callback", params={"code": "abc", "state": saved["state"]})
    assert (
        "auth_error=ID+token+nonce+mismatch" in resp.headers["location"]
        or "nonce" in resp.headers["location"]
    )

    saved = await _start_login(client, settings)
    okta_mock.post(f"{ISSUER}/v1/token").mock(
        return_value=Response(
            200,
            json={"id_token": _id_token(nonce=saved["nonce"], aud="other"), "access_token": "at"},
        )
    )
    resp = await client.get("/api/auth/callback", params={"code": "abc", "state": saved["state"]})
    assert "auth_error=" in resp.headers["location"]
    assert settings.session_cookie_name not in resp.cookies


async def test_callback_token_endpoint_error(client, settings, okta_mock):
    saved = await _start_login(client, settings)
    okta_mock.post(f"{ISSUER}/v1/token").mock(
        return_value=Response(401, json={"error": "invalid_client", "error_description": "nope"})
    )
    resp = await client.get("/api/auth/callback", params={"code": "abc", "state": saved["state"]})
    assert "auth_error=" in resp.headers["location"]


async def test_me_requires_session(client):
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (
        await client.get("/api/auth/me", headers={"Cookie": "fwf_session=garbage"})
    ).status_code == 401
