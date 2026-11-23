"""Container entrypoint: `funwithflags-api migrate|seed|serve|migrate-and-serve`."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import uvicorn
from alembic import command
from sqlalchemy import select

from app.config import get_settings
from app.crack_hashes import provision, read_words, verify_words
from app.db import Database
from app.logging import configure_logging, get_logger
from app.migrations import alembic_config, upgrade_head
from app.models import AuditLog, User
from app.saml import subject_key
from app.seed import load_seed_file, upsert_challenges

log = get_logger(__name__)


async def _link_saml(path: str) -> None:
    """Explicit, reviewed local mapping. Never link from email or profile attributes."""
    settings = get_settings()
    mapping = json.loads(await asyncio.to_thread(Path(path).read_text))
    if (set(mapping) != {"user_id", "previous_subject", "issuer", "subject", "approval"}
            or not all(isinstance(mapping[k], str) and mapping[k] for k in
                       ["previous_subject", "issuer", "subject", "approval"])
            or type(mapping["user_id"]) is not int
            or len(mapping["subject"]) > 255 or len(mapping["approval"]) > 128
            or mapping["issuer"] != settings.saml_idp_entity_id):
        raise ValueError("Invalid reviewed identity mapping")
    db = Database(settings)
    try:
        async with db.session_factory() as session:
            user = (await session.execute(
                select(User).where(User.id == mapping["user_id"]).with_for_update()
            )).scalar_one_or_none()
            if user is None or not user.is_active or user.okta_sub != mapping["previous_subject"]:
                raise ValueError("Identity mapping precondition failed")
            if user.okta_sub.startswith("saml:"):
                raise ValueError("Already-linked SAML identities cannot be relinked")
            user.okta_sub = subject_key(mapping["issuer"], mapping["subject"])
            user.is_admin = False
            session.add(AuditLog(
                user_id=user.id, event_type="saml.identity_linked",
                detail={"approval_reference": mapping["approval"]},
            ))
            await session.commit()
    finally:
        await db.dispose()


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


def _provision_crack_hashes() -> None:
    settings = get_settings()
    if settings.environment != "development" or os.environ.get("ENVIRONMENT") != "development":
        sys.exit("Explicit ENVIRONMENT=development is required")
    if settings.database_url is None:
        sys.exit("Explicit development DATABASE_URL is required")
    words = read_words()
    verify_words(words)  # Do not connect to a database until every hash matches.

    async def run() -> dict[str, int]:
        db = Database(settings)
        try:
            async with db.session_factory() as session:
                return await provision(session, settings, words)
        finally:
            await db.dispose()

    result = asyncio.run(run())
    print(f"Crack The Hash: created={result['created']}, unchanged={result['unchanged']}")


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
    sub.add_parser("provision-crack-hashes", help="Explicit development-only hash puzzles")
    sub.add_parser("serve", help="Run the API server")
    sub.add_parser("migrate-and-serve", help="Migrate, seed if CHALLENGES_FILE is set, then serve")
    rev = sub.add_parser("revision", help="Autogenerate an alembic revision (dev only)")
    rev.add_argument("-m", "--message", required=True)
    link = sub.add_parser("link-saml", help="Apply one explicitly reviewed stable identity mapping")
    link.add_argument("mapping_file")

    args = parser.parse_args(argv)
    configure_logging(get_settings())

    if args.cmd == "migrate":
        _migrate()
    elif args.cmd == "seed":
        _seed(args.path)
    elif args.cmd == "provision-crack-hashes":
        try:
            _provision_crack_hashes()
        except ValueError as exc:
            sys.exit(str(exc))
    elif args.cmd == "serve":
        _serve()
    elif args.cmd == "migrate-and-serve":
        _migrate()
        if get_settings().challenges_file:
            _seed(None)
        _serve()
    elif args.cmd == "revision":
        command.revision(alembic_config(get_settings()), message=args.message, autogenerate=True)
    elif args.cmd == "link-saml":
        try:
            asyncio.run(_link_saml(args.mapping_file))
        except Exception:
            # SQL errors can contain identity values; never emit exception details.
            sys.exit("Identity mapping failed; verify approval, configuration and uniqueness.")


if __name__ == "__main__":
    main()
