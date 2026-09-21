"""Container entrypoint: `funwithflags-api migrate|seed|serve|migrate-and-serve`."""

from __future__ import annotations

import argparse
import asyncio
import sys

import uvicorn
from alembic import command

from app.config import get_settings
from app.db import Database
from app.logging import configure_logging, get_logger
from app.migrations import alembic_config, upgrade_head
from app.seed import load_seed_file, upsert_challenges

log = get_logger(__name__)


def _migrate() -> None:
    settings = get_settings()
    log.info("migrate.start")
    asyncio.run(upgrade_head(settings))
    log.info("migrate.done")


def _seed(path: str | None) -> None:
    settings = get_settings()
    target = path or settings.challenges_file
    if not target:
        log.error("seed.no_file", hint="pass a path or set CHALLENGES_FILE")
        sys.exit(2)

    async def run() -> None:
        db = Database(settings)
        try:
            async with db.session_factory() as session:
                await upsert_challenges(session, settings, load_seed_file(target))
        finally:
            await db.dispose()

    asyncio.run(run())


def _serve() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.asgi:app",
        host=settings.host,
        port=settings.port,
        proxy_headers=True,
        forwarded_allow_ips=settings.forwarded_allow_ips,
        log_config=None,
        access_log=False,
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="funwithflags-api")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate", help="Run alembic upgrade head")
    seed = sub.add_parser("seed", help="Upsert challenges from a YAML file")
    seed.add_argument("path", nargs="?", help="defaults to $CHALLENGES_FILE")
    sub.add_parser("serve", help="Run the API server")
    sub.add_parser("migrate-and-serve", help="Migrate, seed if CHALLENGES_FILE is set, then serve")
    rev = sub.add_parser("revision", help="Autogenerate an alembic revision (dev only)")
    rev.add_argument("-m", "--message", required=True)

    args = parser.parse_args(argv)
    configure_logging(get_settings())

    if args.cmd == "migrate":
        _migrate()
    elif args.cmd == "seed":
        _seed(args.path)
    elif args.cmd == "serve":
        _serve()
    elif args.cmd == "migrate-and-serve":
        _migrate()
        if get_settings().challenges_file:
            _seed(None)
        _serve()
    elif args.cmd == "revision":
        command.revision(alembic_config(get_settings()), message=args.message, autogenerate=True)


if __name__ == "__main__":
    main()
