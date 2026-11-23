# XML fixtures and PEM environment values are intentionally verbose.
from __future__ import annotations

import base64
import os
import zlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, unquote, urlsplit
from xml.etree import ElementTree

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import saml
from app.config import Settings
from app.db import Base, Database
from app.main import create_app
from app.models import SamlTransaction, User
from tests.test_auth import assertion


def _credentials(common_name: str) -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(days=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .sign(key, hashes.SHA256())
        .public_bytes(serialization.Encoding.PEM)
        .decode()
    )
    private = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return private, cert


DEV_IDP_KEY, DEV_IDP_CERT = _credentials("Synthetic development IdP")
PROD_IDP_KEY, PROD_IDP_CERT = _credentials("Synthetic production IdP")
DEV_SP_KEY, DEV_SP_CERT = _credentials("Synthetic development SP")
PROD_SP_KEY, PROD_SP_CERT = _credentials("Synthetic production SP")
DEV_ROLLOVER_KEY, DEV_ROLLOVER_CERT = _credentials("Synthetic development rollover IdP")
PROD_ROLLOVER_KEY, PROD_ROLLOVER_CERT = _credentials("Synthetic production rollover IdP")

ENVIRONMENTS = {
    "development": {
        "origin": "https://development.example.test",
        "idp_entity": "https://development-idp.example.test/entity",
        "idp_sso": "https://development-idp.example.test/sso",
        "idp_key": DEV_IDP_KEY,
        "idp_cert": DEV_IDP_CERT,
        "sp_key": DEV_SP_KEY,
        "sp_cert": DEV_SP_CERT,
    },
    "production": {
        "origin": "https://production.example.test",
        "idp_entity": "https://production-idp.example.test/entity",
        "idp_sso": "https://production-idp.example.test/sso",
        "idp_key": PROD_IDP_KEY,
        "idp_cert": PROD_IDP_CERT,
        "sp_key": PROD_SP_KEY,
        "sp_cert": PROD_SP_CERT,
    },
}


@pytest.fixture(autouse=True)
def sanitized_deployment_environment(monkeypatch: pytest.MonkeyPatch):
    """Prevent the test runner's deployment state from selecting an environment."""
    settings_names = {name.upper() for name in Settings.model_fields}
    for key in list(os.environ):
        if (
            key in settings_names
            or key == "NODE_ENV"
            or key.startswith(("DB_", "DATABASE_", "SAML_"))
        ):
            monkeypatch.delenv(key, raising=False)


def _settings(monkeypatch: pytest.MonkeyPatch, environment: str) -> Settings:
    values = ENVIRONMENTS[environment]
    env = {
        "ENVIRONMENT": environment,
        "APP_BASE_URL": values["origin"],
        "SESSION_SECRET": f"{environment}-session-secret-that-is-at-least-32-characters",
        "SESSION_COOKIE_SECURE": "true",
        "FLAG_HASH_SECRET": f"{environment}-flag-secret-that-is-at-least-32-characters",
        "SAML_IDP_ENTITY_ID": values["idp_entity"],
        "SAML_IDP_SSO_URL": values["idp_sso"],
        "SAML_IDP_CERT": values["idp_cert"],
        "SAML_SP_PRIVATE_KEY": values["sp_key"],
        "SAML_SP_CERT": values["sp_cert"],
        "SAML_SP_ENTITY_ID": values["origin"] + "/saml",
        "SAML_ACS_URL": values["origin"] + "/api/auth/saml/acs",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    settings = Settings()
    assert settings.environment == environment
    return settings


def _request_xml_and_verify(location: str, settings: Settings) -> ElementTree.Element:
    split = urlsplit(location)
    assert f"{split.scheme}://{split.netloc}{split.path}" == settings.saml_idp_sso_url
    query = parse_qs(split.query)
    assert set(query) >= {"SAMLRequest", "RelayState", "SigAlg", "Signature"}
    compressed = base64.b64decode(query["SAMLRequest"][0])
    request = ElementTree.fromstring(zlib.decompress(compressed, -15))

    # Redirect-binding signatures cover the original percent-encoded values.
    raw = dict(item.split("=", 1) for item in split.query.split("&"))
    signed = "&".join(
        f"{name}={raw[name]}" for name in ("SAMLRequest", "RelayState", "SigAlg")
    ).encode()
    signature = base64.b64decode(unquote(raw["Signature"]))
    cert = x509.load_pem_x509_certificate(
        settings.saml_sp_cert.get_secret_value().encode(),
    )
    key = cert.public_key()
    assert isinstance(key, rsa.RSAPublicKey)
    key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
    return request


@asynccontextmanager
async def _client_and_database(settings: Settings):
    db = Database.__new__(Database)
    db.engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    db.session_factory = async_sessionmaker(db.engine, expire_on_commit=False)
    async with db.engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    app = create_app(settings, database=db)
    try:
        async with (
            httpx.ASGITransport(app=app) as transport,
            httpx.AsyncClient(
                transport=transport,
                base_url=settings.app_base_url,
            ) as client,
            app.router.lifespan_context(app),
        ):
            yield client, db
    finally:
        await db.dispose()


@pytest.mark.parametrize("environment", ["development", "production"])
async def test_environment_metadata_and_signed_login_route(monkeypatch, environment):
    settings = _settings(monkeypatch, environment)
    async with _client_and_database(settings) as (client, _):
        metadata_response = await client.get("/api/auth/saml/metadata")
        assert metadata_response.status_code == 200
        metadata = ElementTree.fromstring(metadata_response.text)
        assert metadata.get("entityID") == settings.saml_sp_entity_id
        acs = metadata.find(
            ".//{urn:oasis:names:tc:SAML:2.0:metadata}AssertionConsumerService",
        )
        assert acs is not None
        assert acs.get("Location") == settings.saml_acs_url
        assert settings.saml_sp_cert.get_secret_value().splitlines()[1] in metadata_response.text

        login = await client.get("/api/auth/login", follow_redirects=False)
        assert login.status_code == 302
        request = _request_xml_and_verify(login.headers["location"], settings)
        assert request.get("Destination") == settings.saml_idp_sso_url
        assert request.get("AssertionConsumerServiceURL") == settings.saml_acs_url
        issuer = request.find("{urn:oasis:names:tc:SAML:2.0:assertion}Issuer")
        assert issuer is not None and issuer.text == settings.saml_sp_entity_id
        relay = parse_qs(urlsplit(login.headers["location"]).query)["RelayState"][0]
        values = ENVIRONMENTS[environment]
        callback = await client.post(
            "/api/auth/saml/acs",
            data={
                "RelayState": relay,
                "SAMLResponse": assertion(
                    settings,
                    request.get("ID"),
                    signing_key=values["idp_key"],
                    signing_cert=values["idp_cert"],
                ),
            },
        )
        assert callback.status_code == 303
        assert callback.headers["location"] == settings.app_base_url + "/?auth=ok"
        assert settings.session_cookie_name in callback.cookies
        assert (await client.get("/api/auth/me")).status_code == 200


@pytest.mark.parametrize("environment", ["development", "production"])
def test_each_environment_accepts_its_own_signed_assertion(monkeypatch, environment):
    settings = _settings(monkeypatch, environment)
    values = ENVIRONMENTS[environment]
    encoded = assertion(
        settings,
        "_request",
        signing_key=values["idp_key"],
        signing_cert=values["idp_cert"],
    )
    assert saml.validate(settings, encoded, "_request")[0] == "stable-123"


@pytest.mark.parametrize(
    ("target_environment", "opposite_environment"),
    [("development", "production"), ("production", "development")],
)
@pytest.mark.parametrize("opposite_field", ["issuer", "cert", "audience", "recipient"])
def test_opposite_environment_values_are_independently_rejected(
    monkeypatch,
    target_environment,
    opposite_environment,
    opposite_field,
):
    target = _settings(monkeypatch, target_environment)
    opposite = _settings(monkeypatch, opposite_environment)
    target_values = ENVIRONMENTS[target_environment]
    opposite_values = ENVIRONMENTS[opposite_environment]
    kwargs = {
        "issuer": target.saml_idp_entity_id,
        "audience": target.saml_sp_entity_id,
        "recipient": target.saml_acs_url,
        "signing_key": target_values["idp_key"],
        "signing_cert": target_values["idp_cert"],
    }
    if opposite_field == "issuer":
        kwargs["issuer"] = opposite.saml_idp_entity_id
    elif opposite_field == "audience":
        kwargs["audience"] = opposite.saml_sp_entity_id
    elif opposite_field == "recipient":
        kwargs["recipient"] = opposite.saml_acs_url
    else:
        kwargs["signing_key"] = opposite_values["idp_key"]
        kwargs["signing_cert"] = opposite_values["idp_cert"]

    encoded = assertion(target, "_request", **kwargs)
    with pytest.raises(saml.SamlError):
        saml.validate(target, encoded, "_request")


REQUIRED_SAML_ENV = [
    "SAML_IDP_ENTITY_ID",
    "SAML_IDP_SSO_URL",
    "SAML_IDP_CERT",
    "SAML_SP_ENTITY_ID",
    "SAML_ACS_URL",
]


async def _assert_http_configuration_failure(settings: Settings):
    async with _client_and_database(settings) as (client, db):
        login = await client.get("/api/auth/login", follow_redirects=False)
        assert login.status_code == 303
        assert login.headers["location"].startswith(settings.app_base_url + "/?auth_error=")
        assert "PRIVATE KEY" not in login.headers["location"]
        assert "CERTIFICATE" not in login.headers["location"]

        metadata = await client.get("/api/auth/saml/metadata")
        assert metadata.status_code == 503
        assert metadata.text == "SAML metadata is unavailable."
        async with db.session_factory() as session:
            assert not (await session.execute(select(User))).scalars().all()
            assert not (await session.execute(select(SamlTransaction))).scalars().all()


@pytest.mark.parametrize("environment", ["development", "production"])
@pytest.mark.parametrize("missing", REQUIRED_SAML_ENV)
async def test_missing_active_saml_setting_has_no_prefixed_fallback(
    monkeypatch,
    environment,
    missing,
):
    _settings(monkeypatch, environment)
    plausible = {
        "SAML_IDP_ENTITY_ID": "https://unused-idp.example.test/entity",
        "SAML_IDP_SSO_URL": "https://unused-idp.example.test/sso",
        "SAML_IDP_CERT": DEV_IDP_CERT,
        "SAML_SP_ENTITY_ID": "https://unused-sp.example.test/saml",
        "SAML_ACS_URL": "https://unused-sp.example.test/api/auth/saml/acs",
    }[missing]
    # These look like possible environment-specific alternatives, but only the
    # explicitly active unprefixed setting may configure the process.
    for prefix in ("OTHER_", "DEV_", "PROD_"):
        monkeypatch.setenv(prefix + missing, plausible)
    monkeypatch.setenv(missing, "")

    settings = Settings()
    assert (
        getattr(settings, missing.lower()).get_secret_value() == ""
        if missing == "SAML_IDP_CERT"
        else getattr(settings, missing.lower()) == ""
    )
    await _assert_http_configuration_failure(settings)


@pytest.mark.parametrize("environment", ["development", "production"])
@pytest.mark.parametrize("certificate", ["SAML_IDP_CERT", "SAML_IDP_ROLLOVER_CERT"])
async def test_malformed_primary_or_rollover_certificate_fails_closed(
    monkeypatch,
    environment,
    certificate,
):
    _settings(monkeypatch, environment)
    malformed = "-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----"
    monkeypatch.setenv(certificate, malformed)
    settings = Settings()

    await _assert_http_configuration_failure(settings)


@pytest.mark.parametrize("environment", ["development", "production"])
def test_same_environment_rollover_is_accepted(monkeypatch, environment):
    _settings(monkeypatch, environment)
    rollover_key, rollover_cert = {
        "development": (DEV_ROLLOVER_KEY, DEV_ROLLOVER_CERT),
        "production": (PROD_ROLLOVER_KEY, PROD_ROLLOVER_CERT),
    }[environment]
    monkeypatch.setenv("SAML_IDP_ROLLOVER_CERT", rollover_cert)
    settings = Settings()
    encoded = assertion(
        settings,
        "_request",
        signing_key=rollover_key,
        signing_cert=rollover_cert,
    )

    assert saml.validate(settings, encoded, "_request")[0] == "stable-123"


@pytest.mark.parametrize(
    ("environment", "opposite_environment"),
    [("development", "production"), ("production", "development")],
)
def test_rollover_does_not_implicitly_trust_opposite_environment(
    monkeypatch,
    environment,
    opposite_environment,
):
    _settings(monkeypatch, environment)
    rollover_cert = {
        "development": DEV_ROLLOVER_CERT,
        "production": PROD_ROLLOVER_CERT,
    }[environment]
    monkeypatch.setenv("SAML_IDP_ROLLOVER_CERT", rollover_cert)
    settings = Settings()
    opposite = ENVIRONMENTS[opposite_environment]
    encoded = assertion(
        settings,
        "_request",
        signing_key=opposite["idp_key"],
        signing_cert=opposite["idp_cert"],
    )

    with pytest.raises(saml.SamlError):
        saml.validate(settings, encoded, "_request")
