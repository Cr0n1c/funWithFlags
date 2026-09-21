"""Minimal OpenID Connect client for Okta (authorization code + PKCE, confidential client).

Only the pieces we need: discovery, authorize URL, code exchange, ID-token verification against
the tenant's JWKS, and the userinfo call. No SDK, so the behaviour is easy to audit.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

from app.config import Settings
from app.logging import get_logger

log = get_logger(__name__)


class OktaError(Exception):
    """Raised for any failure in the OIDC flow. Message is safe to show to the user."""


@dataclass(slots=True)
class OktaIdentity:
    sub: str
    username: str
    email: str | None
    full_name: str | None
    groups: list[str] = field(default_factory=list)


class OktaClient:
    def __init__(self, settings: Settings, http: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._http = http or httpx.AsyncClient(timeout=settings.okta_http_timeout_seconds)
        self._discovery: dict[str, Any] | None = None
        self._jwks: dict[str, Any] | None = None
        self._jwks_fetched_at = 0.0

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------- discovery
    async def discovery(self) -> dict[str, Any]:
        if self._discovery is None:
            url = f"{self._settings.okta_issuer}/.well-known/openid-configuration"
            try:
                resp = await self._http.get(url)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                log.error("okta.discovery_failed", url=url, error=str(exc))
                raise OktaError("Could not reach the identity provider") from exc
            doc = resp.json()
            if doc.get("issuer", "").rstrip("/") != self._settings.okta_issuer:
                log.error(
                    "okta.issuer_mismatch",
                    expected=self._settings.okta_issuer,
                    got=doc.get("issuer"),
                )
                raise OktaError("Identity provider issuer mismatch")
            self._discovery = doc
        return self._discovery

    async def _jwks_keys(self, *, force: bool = False) -> dict[str, Any]:
        stale = time.monotonic() - self._jwks_fetched_at > self._settings.okta_jwks_cache_seconds
        if self._jwks is None or stale or force:
            disc = await self.discovery()
            try:
                resp = await self._http.get(disc["jwks_uri"])
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                log.error("okta.jwks_failed", error=str(exc))
                raise OktaError("Could not fetch identity provider signing keys") from exc
            self._jwks = resp.json()
            self._jwks_fetched_at = time.monotonic()
        return self._jwks

    # ------------------------------------------------------------- authorize
    async def authorize_url(self, *, state: str, nonce: str, code_challenge: str) -> str:
        disc = await self.discovery()
        params = {
            "client_id": self._settings.okta_client_id,
            "response_type": "code",
            "scope": " ".join(self._settings.scope_list),
            "redirect_uri": self._settings.okta_redirect_uri,
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{disc['authorization_endpoint']}?{urlencode(params)}"

    async def logout_url(self, id_token_hint: str | None = None) -> str | None:
        post = self._settings.okta_post_logout_redirect_uri
        if not post:
            return None
        disc = await self.discovery()
        endpoint = disc.get("end_session_endpoint")
        if not endpoint:
            return None
        params = {"post_logout_redirect_uri": post}
        if id_token_hint:
            params["id_token_hint"] = id_token_hint
        return f"{endpoint}?{urlencode(params)}"

    # ---------------------------------------------------------- token exchange
    async def exchange_code(self, *, code: str, code_verifier: str) -> dict[str, Any]:
        disc = await self.discovery()
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self._settings.okta_redirect_uri,
            "code_verifier": code_verifier,
        }
        auth = (self._settings.okta_client_id, self._settings.okta_client_secret.get_secret_value())
        try:
            resp = await self._http.post(
                disc["token_endpoint"],
                data=data,
                auth=auth,
                headers={"Accept": "application/json"},
            )
        except httpx.HTTPError as exc:
            log.error("okta.token_request_failed", error=str(exc))
            raise OktaError("Could not reach the identity provider token endpoint") from exc
        if resp.status_code != 200:
            body = resp.json() if "json" in resp.headers.get("content-type", "") else {}
            log.warning(
                "okta.token_exchange_rejected",
                status=resp.status_code,
                error=body.get("error"),
                description=body.get("error_description"),
            )
            raise OktaError("The identity provider rejected the login")
        tokens = resp.json()
        if "id_token" not in tokens:
            raise OktaError("Identity provider did not return an ID token")
        return tokens

    # ----------------------------------------------------------- verification
    async def verify_id_token(self, id_token: str, *, nonce: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(id_token)
        except jwt.InvalidTokenError as exc:
            raise OktaError("Malformed ID token") from exc
        kid = header.get("kid")
        key = await self._signing_key(kid)
        if key is None:
            # Key rotation: refetch once before giving up.
            key = await self._signing_key(kid, force=True)
        if key is None:
            raise OktaError("ID token signed with an unknown key")
        try:
            claims = jwt.decode(
                id_token,
                key,
                algorithms=["RS256"],
                audience=self._settings.okta_client_id,
                issuer=self._settings.okta_issuer,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
                leeway=30,
            )
        except jwt.InvalidTokenError as exc:
            log.warning("okta.id_token_invalid", error=str(exc))
            raise OktaError("ID token failed verification") from exc
        if claims.get("nonce") != nonce:
            raise OktaError("ID token nonce mismatch")
        return claims

    async def _signing_key(self, kid: str | None, *, force: bool = False) -> Any | None:
        jwks = await self._jwks_keys(force=force)
        for jwk_dict in jwks.get("keys", []):
            if jwk_dict.get("kid") == kid and jwk_dict.get("kty") == "RSA":
                return jwt.PyJWK(jwk_dict, algorithm="RS256").key
        return None

    async def userinfo(self, access_token: str) -> dict[str, Any]:
        disc = await self.discovery()
        endpoint = disc.get("userinfo_endpoint")
        if not endpoint:
            return {}
        try:
            resp = await self._http.get(
                endpoint, headers={"Authorization": f"Bearer {access_token}"}
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            # Userinfo is best-effort; the ID token already authenticated the user.
            log.warning("okta.userinfo_failed", error=str(exc))
            return {}
        return resp.json()

    # --------------------------------------------------------------- identity
    def extract_identity(self, claims: dict[str, Any], userinfo: dict[str, Any]) -> OktaIdentity:
        merged = {**userinfo, **claims}  # ID-token claims win over userinfo
        s = self._settings

        username = _first_str(merged, s.okta_username_claim, "preferred_username", "email", "sub")
        email = _first_str(merged, "email")
        full_name = _first_str(merged, "name")
        if not full_name:
            parts = [merged.get("given_name"), merged.get("family_name")]
            full_name = " ".join(str(p) for p in parts if p) or None

        raw_groups = merged.get(s.okta_groups_claim) or userinfo.get(s.okta_groups_claim) or []
        if isinstance(raw_groups, str):
            raw_groups = [raw_groups]
        groups = sorted({str(g) for g in raw_groups if g})

        if not username:
            raise OktaError("Identity provider did not return a usable username")
        return OktaIdentity(
            sub=str(merged["sub"]),
            username=username,
            email=email,
            full_name=full_name,
            groups=groups,
        )


def _first_str(source: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
