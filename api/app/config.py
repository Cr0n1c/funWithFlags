"""Runtime configuration.

Every knob is an environment variable so the same image runs under docker compose and
under the Helm chart. Secrets are typed as ``SecretStr`` so they never appear in reprs or
logs by accident.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _split_csv(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, list | tuple | set):
        return [str(item).strip() for item in value if str(item).strip()]
    raise TypeError("expected a comma-separated string or a list")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    # ------------------------------------------------------------------ general
    app_name: str = "funwithflags-api"
    environment: str = Field(default="development", pattern=r"^(development|production|test)$")
    log_level: str = "INFO"
    log_json: bool = True
    host: str = "0.0.0.0"  # noqa: S104 - container listen address
    port: int = 8000
    #: Public origin of the UI. Post-login redirects land here and it is the only CORS origin
    #: allowed by default (the UI normally shares an origin via nginx, so CORS is rarely used).
    app_base_url: str = "http://localhost:8080"
    cors_origins: Annotated[list[str], NoDecode] = []
    #: Comma-separated list of trusted proxy IPs/CIDRs for X-Forwarded-* handling ("*" = any).
    forwarded_allow_ips: str = "*"

    # ----------------------------------------------------------------- database
    #: Full SQLAlchemy URL. If unset, it is assembled from the DB_* parts below.
    database_url: SecretStr | None = None
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "funwithflags"
    db_user: str = "funwithflags"
    db_password: SecretStr = SecretStr("")
    db_pool_size: int = 5
    db_max_overflow: int = 10
    db_echo: bool = False

    # --------------------------------------------------------------------- okta
    #: e.g. https://acme.okta.com/oauth2/default (custom AS) or https://acme.okta.com (org AS)
    okta_issuer: str
    okta_client_id: str
    okta_client_secret: SecretStr
    #: Must exactly match a "Sign-in redirect URI" on the Okta app, e.g.
    #: http://localhost:8080/api/auth/callback
    okta_redirect_uri: str
    okta_scopes: str = "openid profile email groups"
    #: Name of the claim carrying group membership in the ID token / userinfo response.
    okta_groups_claim: str = "groups"
    #: Claim used as the player's username. Falls back to ``email`` then ``sub``.
    okta_username_claim: str = "preferred_username"
    #: Where Okta sends the browser after a global sign-out. Unset = local logout only.
    okta_post_logout_redirect_uri: str | None = None
    okta_http_timeout_seconds: float = 10.0
    okta_jwks_cache_seconds: int = 3600

    #: Members of any of these Okta groups get the admin API.
    admin_groups: Annotated[list[str], NoDecode] = []

    # ----------------------------------------------------------------- sessions
    session_secret: SecretStr = Field(min_length=32)
    session_cookie_name: str = "fwf_session"
    oidc_state_cookie_name: str = "fwf_oidc"
    session_max_age_seconds: int = 8 * 60 * 60
    session_cookie_secure: bool = True
    session_cookie_domain: str | None = None
    session_cookie_samesite: str = Field(default="lax", pattern=r"^(lax|strict)$")

    # -------------------------------------------------------------------- flags
    #: HMAC key used to store flags. Rotating it invalidates every stored flag hash.
    flag_hash_secret: SecretStr = Field(min_length=32)
    submit_rate_limit_per_minute: int = 10
    max_flag_length: int = 512
    #: Optional YAML file of challenges to upsert at startup / via ``funwithflags-api seed``.
    challenges_file: str | None = None
    run_migrations_on_startup: bool = False
    seed_on_startup: bool = False

    @field_validator("cors_origins", "admin_groups", mode="before")
    @classmethod
    def _csv(cls, value: object) -> list[str]:
        return _split_csv(value)

    @field_validator("okta_issuer", "app_base_url", mode="after")
    @classmethod
    def _strip_slash(cls, value: str) -> str:
        return value.rstrip("/")

    # -------------------------------------------------------------- derived bits
    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def sqlalchemy_url(self) -> str:
        if self.database_url is not None:
            url = self.database_url.get_secret_value()
            # Accept the plain libpq-style scheme and upgrade it to the async driver.
            for prefix in ("postgresql://", "postgres://"):
                if url.startswith(prefix):
                    return "postgresql+asyncpg://" + url[len(prefix) :]
            return url
        password = self.db_password.get_secret_value()
        auth = self.db_user if not password else f"{self.db_user}:{password}"
        return f"postgresql+asyncpg://{auth}@{self.db_host}:{self.db_port}/{self.db_name}"

    @property
    def scope_list(self) -> list[str]:
        return [s for s in self.okta_scopes.replace(",", " ").split() if s]

    @property
    def allowed_origins(self) -> list[str]:
        origins = [self.app_base_url, *self.cors_origins]
        return list(dict.fromkeys(o.rstrip("/") for o in origins if o))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
