"""Programmatic Alembic helpers so the CLI, tests and startup hook share one code path.

The migration scripts live inside the package (``app/alembic``) so they ship in the wheel and
are available in the container without relying on the source checkout layout.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from alembic import command
from alembic.config import Config

from app.config import Settings

SCRIPT_LOCATION = Path(__file__).resolve().parent / "alembic"


def alembic_config(settings: Settings) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(SCRIPT_LOCATION))
    cfg.set_main_option("file_template", "%%(rev)s_%%(slug)s")
    cfg.set_main_option("sqlalchemy.url", settings.sqlalchemy_url.replace("%", "%%"))
    return cfg


async def upgrade_head(settings: Settings) -> None:
    # Alembic drives the async engine itself inside env.py; run it off the event loop thread.
    await asyncio.to_thread(command.upgrade, alembic_config(settings), "head")
