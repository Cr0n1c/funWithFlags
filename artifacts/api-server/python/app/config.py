"""Runtime configuration.

Every knob is an environment variable so the same image runs under docker compose and
under the Helm chart. Secrets are typed as ``SecretStr`` so they never appear in reprs or
logs by accident.
"""

from __future__ import annotations

from functools import lru_cache
from ipaddress import ip_address
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import make_url


def resolve_environment(explicit: str | None, node_env: str = "") -> str:
    """One fail-closed mode contract for the launcher, ASGI, and CLI."""
    modes = {"development", "production", "test"}
    if explicit is not None and explicit not in modes:
        raise ValueError("ENVIRONMENT must be development, production, or test")
    if node_env and node_env not in modes:
        raise ValueError("NODE_ENV must be development, production, or test")
    signals = {value for value in (explicit, node_env) if value}
    if len(signals) > 1:
        raise ValueError("Conflicting runtime environment signals")
    return next(iter(signals), "development")


def public_https_origin(value: str, *, production: bool = False) -> bool:
    """Validate origins without reflecting configuration into diagnostics."""
    try:
        origin = urlsplit(value)
        host = (origin.hostname or "").lower().rstrip(".")
        port = origin.port
        try:
            nonpublic_ip = not ip_address(host).is_global
        except ValueError:
            nonpublic_ip = False
        return bool(
            origin.scheme == "https" and host and not origin.username
            and not origin.password and not origin.path and not origin.query
            and not origin.fragment and port != 0
            and not any(c.isspace() or ord(c) < 32 or c == "\\" for c in value)
            and (not production or (
                host != "localhost" and not host.endswith(".localhost")
                and not nonpublic_ip
            ))
        )
    except ValueError:
        return False


def _split_csv(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, list | tuple | set):
        return [str(item).strip() for item in value if str(item).strip()]
    raise TypeError("expected a comma-separated string or a list")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        extra="ignore", case_sensitive=False, hide_input_in_errors=True,
    )

    # ------------------------------------------------------------------ general
    app_name: str = "funwithflags-api"
    environment: str = Field(default="development", pattern=r"^(development|production|test)$")
    node_env: str = Field(default="", exclude=True, repr=False)
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

    # Competition opt-outs use stable identities, never names or admin roles.
    scoreboard_excluded_subjects: Annotated[list[str], NoDecode] = Field(
        default_factory=list, repr=False,
    )

    # --------------------------------------------------------------- Okta SAML
    saml_idp_entity_id: str = ""
    saml_idp_sso_url: str = ""
    saml_idp_cert: SecretStr = SecretStr("")
    saml_idp_rollover_cert: SecretStr = SecretStr("")
    saml_sp_cert: SecretStr = SecretStr("")
    saml_sp_private_key: SecretStr = SecretStr("")
    saml_sp_entity_id: str = ""
    saml_acs_url: str = ""
    saml_admin_subjects: Annotated[list[str], NoDecode] = []
    saml_required_attributes: Annotated[list[str], NoDecode] = []
    saml_transaction_cookie_name: str = "__Secure-fwf_saml_transaction"

    # ----------------------------------------------------------------- sessions
    session_secret: SecretStr = Field(min_length=32)
    session_cookie_name: str = "fwf_saml_session"
    session_max_age_seconds: int = 8 * 60 * 60
    session_cookie_secure: bool = True
    session_cookie_domain: str | None = None
    session_cookie_samesite: str = Field(default="lax", pattern=r"^(lax|strict)$")

    # -------------------------------------------------------------------- flags
    #: HMAC key used to store flags. Rotating it invalidates every stored flag hash.
    flag_hash_secret: SecretStr = Field(min_length=32)
    # Optional Slack destination for activity notifications.
    slack_activity_webhook_url: SecretStr = SecretStr("")
    # Health-alert authorization does not authorize player identity/activity exports.
    slack_activity_enabled: bool = False
    submit_rate_limit_per_minute: int = 10
    max_flag_length: int = 512
    #: Optional YAML file of challenges to upsert at startup / via ``funwithflags-api seed``.
    challenges_file: str | None = None
    run_migrations_on_startup: bool = False
    seed_on_startup: bool = False

    @field_validator("cors_origins", "saml_admin_subjects", "scoreboard_excluded_subjects",
                     "saml_required_attributes", mode="before")
    @classmethod
    def _csv(cls, value: object) -> list[str]:
        return _split_csv(value)

    @field_validator("app_base_url", mode="after")
    @classmethod
    def _strip_slash(cls, value: str) -> str:
        return value.rstrip("/")

    # -------------------------------------------------------------- derived bits
    @model_validator(mode="before")
    @classmethod
    def _runtime_mode(cls, values: dict) -> dict:
        values = dict(values)
        values["environment"] = resolve_environment(
            values.get("environment"), values.get("node_env", ""),
        )
        return values

    @model_validator(mode="after")
    def _production_transport(self) -> Settings:
        if self.is_production:
            if not public_https_origin(self.app_base_url, production=True):
                raise ValueError("Production APP_BASE_URL must be a public HTTPS origin")
            if not self.session_cookie_secure:
                raise ValueError("Production session cookies must be Secure")
        return self

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
                    url = "postgresql+asyncpg://" + url[len(prefix) :]
                    break
            if url.startswith("postgresql+asyncpg://"):
                parsed = make_url(url)
                query = dict(parsed.query)
                if "sslmode" in query:
                    query["ssl"] = query.pop("sslmode")
                return parsed.set(query=query).render_as_string(hide_password=False)
            return url
        password = self.db_password.get_secret_value()
        auth = self.db_user if not password else f"{self.db_user}:{password}"
        return f"postgresql+asyncpg://{auth}@{self.db_host}:{self.db_port}/{self.db_name}"

    @property
    def allowed_origins(self) -> list[str]:
        origins = [self.app_base_url, *self.cors_origins]
        return list(dict.fromkeys(o.rstrip("/") for o in origins if o))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
