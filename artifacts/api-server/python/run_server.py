"""Run the upstream API without containers or startup-time schema changes."""
import os
import sys

import uvicorn

from app.config import get_settings, public_https_origin, resolve_environment
from app.logging import configure_logging


def configure_environment():
    try:
        mode = resolve_environment(
            os.environ.get("ENVIRONMENT"), os.environ.get("NODE_ENV", ""),
        )
    except ValueError as exc:
        sys.exit(str(exc))
    os.environ["ENVIRONMENT"] = mode
    base = os.environ.get("APP_BASE_URL", "").rstrip("/")
    if not public_https_origin(base, production=mode == "production"):
        sys.exit("APP_BASE_URL must be configured as the public HTTPS origin.")
    os.environ["SESSION_COOKIE_SECURE"] = "true"
    os.environ["RUN_MIGRATIONS_ON_STARTUP"] = "false"
    os.environ["SEED_ON_STARTUP"] = "false"


def main():
    configure_environment()
    settings = get_settings()
    configure_logging(settings)
    uvicorn.run(
        "app.asgi:app",
        host="0.0.0.0",  # noqa: S104 - managed service must accept proxy connections
        port=int(os.environ["PORT"]),
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    main()