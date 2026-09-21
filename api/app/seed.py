"""Load challenges from a YAML file and upsert them by slug."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.logging import get_logger
from app.models import Challenge
from app.security import hash_flag

log = get_logger(__name__)

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


class ChallengeSeed(BaseModel):
    slug: str
    title: str = Field(min_length=1, max_length=255)
    category: str = Field(default="misc", max_length=64)
    description: str = ""
    points: int = Field(default=100, ge=0, le=100_000)
    flag: str | None = None
    #: Precomputed HMAC (hex) - use this if you would rather not keep plaintext flags in the file.
    flag_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    case_sensitive: bool = False
    active: bool = True
    sort_order: int = 0

    @field_validator("slug")
    @classmethod
    def _slug(cls, value: str) -> str:
        if not SLUG_RE.match(value):
            raise ValueError("slug must be lowercase letters, digits and dashes")
        return value


class SeedFile(BaseModel):
    challenges: list[ChallengeSeed]


def load_seed_file(path: str | Path) -> SeedFile:
    raw: Any = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    try:
        return SeedFile.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(f"Invalid challenges file {path}: {exc}") from exc


async def upsert_challenges(db: AsyncSession, settings: Settings, seed: SeedFile) -> dict[str, int]:
    created = updated = 0
    existing = {c.slug: c for c in (await db.execute(select(Challenge))).scalars().all()}
    for item in seed.challenges:
        flag_hash = item.flag_hash
        if item.flag is not None:
            flag_hash = hash_flag(settings, item.flag, case_sensitive=item.case_sensitive)

        challenge = existing.get(item.slug)
        if challenge is None:
            if flag_hash is None:
                raise ValueError(f"challenge {item.slug!r} is new and has no flag or flag_hash")
            db.add(
                Challenge(
                    slug=item.slug,
                    title=item.title,
                    category=item.category,
                    description=item.description,
                    points=item.points,
                    flag_hash=flag_hash,
                    case_sensitive=item.case_sensitive,
                    is_active=item.active,
                    sort_order=item.sort_order,
                )
            )
            created += 1
        else:
            challenge.title = item.title
            challenge.category = item.category
            challenge.description = item.description
            challenge.points = item.points
            challenge.case_sensitive = item.case_sensitive
            challenge.is_active = item.active
            challenge.sort_order = item.sort_order
            if flag_hash is not None:
                challenge.flag_hash = flag_hash
            updated += 1
    await db.commit()
    log.info("seed.complete", created=created, updated=updated)
    return {"created": created, "updated": updated}
