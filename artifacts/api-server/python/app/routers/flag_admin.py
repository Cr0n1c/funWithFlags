"""Narrow challenge creation/deletion authority for the approved SAML group."""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationError,
    field_validator,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import crack_hashes
from app.crack_hashes import create_challenges, missing_challenges
from app.models import AuditLog, Challenge, GroupChallengeCredit, Solve, Submission
from app.schemas import (
    ChallengeImportIn,
    FlagAdminCreate,
    FlagDeleteConfirmIn,
    FlagDeletePreviewIn,
)
from app.scoreboard_projection import refresh_affected
from app.security import (
    DbDep,
    FlagAdminUser,
    SettingsDep,
    acquire_flag_mutation_lock,
    challenge_version,
    client_ip,
    decode_flag_delete_token,
    encode_flag_delete_token,
    hash_flag,
    verify_flag,
)
from app.terminal_challenges import (
    terminal_status,
)

router = APIRouter(prefix="/flag-admin", tags=["flag-admin"])

BACKUP_VERSION = 1
MAX_BACKUP_BYTES = 1_048_576
MAX_BACKUP_CHALLENGES = 1000
BACKUP_CONTEXT = b"fun-with-flags:flag-backup-key:v1"


class BackupChallenge(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)

    slug: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
    title: str = Field(min_length=1, max_length=255)
    category: str = Field(min_length=1, max_length=64)
    description: str = Field(max_length=MAX_BACKUP_BYTES)
    points: StrictInt = Field(ge=-2_147_483_648, le=2_147_483_647)
    flag_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    case_sensitive: StrictBool
    is_active: StrictBool
    hidden: StrictBool
    sort_order: StrictInt = Field(ge=-2_147_483_648, le=2_147_483_647)

    @field_validator("title", "category", "description")
    @classmethod
    def safe_postgres_text(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("Invalid text")
        return value


class FlagBackup(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)

    version: StrictInt
    key_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    challenges: list[BackupChallenge] = Field(max_length=MAX_BACKUP_CHALLENGES)


def _backup_key_id(settings: SettingsDep) -> str:
    return hmac.new(
        settings.flag_hash_secret.get_secret_value().encode("utf-8"),
        BACKUP_CONTEXT,
        hashlib.sha256,
    ).hexdigest()


def _backup_fields(row: Challenge) -> dict[str, object]:
    return {
        name: getattr(row, name)
        for name in BackupChallenge.model_fields
    }


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate backup field")
        result[key] = value
    return result


async def _read_backup(request: Request, settings: SettingsDep) -> FlagBackup:
    # Authorization is resolved by FastAPI before entering this handler.
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(400, "Expected JSON backup")
    try:
        if int(request.headers.get("content-length", "0")) > MAX_BACKUP_BYTES:
            raise HTTPException(413, "Backup exceeds size limit")
    except ValueError:
        raise HTTPException(400, "Invalid backup size") from None
    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > MAX_BACKUP_BYTES:
            raise HTTPException(413, "Backup exceeds size limit")
    try:
        parsed = json.loads(chunks, object_pairs_hook=_unique_json_object)
        backup = FlagBackup.model_validate(parsed)
    except (ValueError, UnicodeError, ValidationError):
        raise HTTPException(400, "Invalid backup format") from None
    if backup.version != BACKUP_VERSION or not hmac.compare_digest(
        backup.key_id, _backup_key_id(settings)
    ):
        raise HTTPException(400, "Incompatible backup version or flag key")
    slugs = [row.slug for row in backup.challenges]
    hashes = [row.flag_hash for row in backup.challenges]
    if len(slugs) != len(set(slugs)) or len(hashes) != len(set(hashes)):
        raise HTTPException(409, "Backup contains duplicate slugs or flags")
    return backup


async def _backup_status(db: DbDep, backup: FlagBackup) -> dict[str, int]:
    existing = (await db.execute(select(Challenge))).scalars().all()
    by_slug = {row.slug: row for row in existing}
    by_hash: dict[str, set[str]] = {}
    for row in existing:
        by_hash.setdefault(row.flag_hash, set()).add(row.slug)
    missing = identical = conflicts = 0
    for item in backup.challenges:
        row = by_slug.get(item.slug)
        if (by_hash.get(item.flag_hash, set()) - {item.slug}
            or (row is not None and _backup_fields(row) != item.model_dump())):
            conflicts += 1
        elif row is None:
            missing += 1
        else:
            identical += 1
    return {"missing": missing, "identical": identical, "conflicts": conflicts}


@router.get("/export-flags")
async def export_flags(user: FlagAdminUser, db: DbDep, settings: SettingsDep) -> Response:
    del user
    rows = (await db.execute(select(Challenge).order_by(Challenge.slug))).scalars().all()
    if len(rows) > MAX_BACKUP_CHALLENGES:
        raise HTTPException(413, "Too many challenges to export")
    payload = {"version": BACKUP_VERSION, "key_id": _backup_key_id(settings),
               "challenges": [_backup_fields(row) for row in rows]}
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_BACKUP_BYTES:
        raise HTTPException(413, "Backup exceeds size limit")
    return Response(data, media_type="application/json", headers={
        "Content-Disposition": 'attachment; filename="fun-with-flags-flags-v1.json"',
        "Cache-Control": "no-store",
        "X-Flag-Count": str(len(rows)),
    })


@router.post("/import-flags/preview")
async def preview_flags(request: Request, user: FlagAdminUser, db: DbDep,
                        settings: SettingsDep) -> dict[str, int]:
    del user
    backup = await _read_backup(request, settings)
    return await _backup_status(db, backup)


@router.post("/import-flags")
async def import_flags(request: Request, user: FlagAdminUser, db: DbDep,
                       settings: SettingsDep) -> dict[str, int]:
    backup = await _read_backup(request, settings)
    await acquire_flag_mutation_lock(db)
    counts = await _backup_status(db, backup)
    if counts["conflicts"]:
        raise HTTPException(409, "Import conflicts with existing challenge metadata or flag")
    if counts["missing"]:
        existing_slugs = set((await db.execute(select(Challenge.slug))).scalars().all())
        for item in backup.challenges:
            if item.slug not in existing_slugs:
                db.add(Challenge(**item.model_dump()))
        db.add(AuditLog(user_id=user.id, event_type="flag_admin_backup_imported",
                        detail={"created": counts["missing"]}, ip_address=client_ip(request)))
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "Import conflicts with existing challenges") from None
    return {"created": counts["missing"], "identical": counts["identical"]}


async def _resolve_flag(
    db: DbDep, settings: SettingsDep, plaintext: str
) -> Challenge | None:
    """Resolve against active and inactive rows; ambiguity is never actionable."""
    candidates = (await db.execute(select(Challenge))).scalars().all()
    matches = [
        challenge
        for challenge in candidates
        if verify_flag(
            settings,
            plaintext,
            challenge.flag_hash,
            case_sensitive=challenge.case_sensitive,
        )
    ]
    return matches[0] if len(matches) == 1 else None


async def _flag_exists(db: DbDep, settings: SettingsDep, plaintext: str) -> bool:
    candidates = (await db.execute(select(Challenge))).scalars().all()
    return any(
        verify_flag(
            settings,
            plaintext,
            challenge.flag_hash,
            case_sensitive=challenge.case_sensitive,
        )
        for challenge in candidates
    )


@router.get("/access")
async def access(user: FlagAdminUser) -> dict[str, bool]:
    del user
    return {"allowed": True}


@router.post("/import-challenges")
async def import_challenges(
    body: ChallengeImportIn,
    user: FlagAdminUser,
    db: DbDep,
    settings: SettingsDep,
) -> dict[str, int]:
    del user
    try:
        if len(body.terminal_missing) != len(set(body.terminal_missing)):
            raise ValueError("Challenge list changed; preview again before importing")
        return await create_challenges(db, settings, {
            f"crack-the-hash-{name}": value for name in ("easy", "medium", "hard", "extra-hard")
            if (value := getattr(body, name.replace("-", "_"))) is not None
        }, set(body.terminal_missing))
    except ValueError as exc:
        # Only fixed, server-owned puzzle slugs can occur in this message.
        raise HTTPException(
            status.HTTP_409_CONFLICT if any(
                word in str(exc) for word in ("collision", "differs", "changed")
            )
            else status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from None


@router.get("/import-challenges")
async def import_challenge_status(
    user: FlagAdminUser, db: DbDep, settings: SettingsDep,
) -> dict[str, list[dict[str, object]]]:
    del user
    try:
        missing = await missing_challenges(db)
        terminal = [item for item in await terminal_status(db, settings) if item["missing"]]
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from None
    return {"terminal": terminal, "puzzles": [
        {"slug": slug, "title": title, "points": points}
        for slug, title, points, *_ in crack_hashes.PUZZLES
        if slug in missing
    ]}


@router.post("/flags", status_code=status.HTTP_201_CREATED)
async def create_flag(
    body: FlagAdminCreate,
    request: Request,
    user: FlagAdminUser,
    db: DbDep,
    settings: SettingsDep,
) -> dict[str, object]:
    await acquire_flag_mutation_lock(db)
    if await _flag_exists(db, settings, body.flag):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Flag already exists")

    challenge = Challenge(
        slug=uuid.uuid4().hex,
        title=body.title,
        category="gold",
        description=body.description,
        points=body.points,
        flag_hash=hash_flag(settings, body.flag, case_sensitive=False),
        case_sensitive=False,
        is_active=True,
        hidden=body.hidden,
    )
    db.add(challenge)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Flag already exists") from None
    db.add(
        AuditLog(
            user_id=user.id,
            event_type="flag_admin_challenge_created",
            detail={
                "challenge": challenge.slug,
                "points": challenge.points,
                "hidden": challenge.hidden,
            },
            ip_address=client_ip(request),
        )
    )
    await db.commit()
    return {
        "slug": challenge.slug,
        "title": challenge.title,
        "description": challenge.description,
        "points": challenge.points,
        "hidden": challenge.hidden,
        "category": "gold",
    }


@router.post("/delete-preview")
async def delete_preview(
    body: FlagDeletePreviewIn,
    user: FlagAdminUser,
    db: DbDep,
    settings: SettingsDep,
) -> dict[str, object]:
    challenge = await _resolve_flag(db, settings, body.flag)
    if challenge is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Flag not found")
    return {
        "slug": challenge.slug,
        "title": challenge.title,
        "points": challenge.points,
        "confirmation_token": encode_flag_delete_token(settings, user.id, challenge),
    }


@router.delete("/flags/{slug}")
async def delete_flag(
    slug: str,
    body: FlagDeleteConfirmIn,
    request: Request,
    user: FlagAdminUser,
    db: DbDep,
    settings: SettingsDep,
) -> dict[str, object]:
    payload = decode_flag_delete_token(settings, body.confirmation_token)
    if (
        payload is None
        or payload.get("sub") != str(user.id)
        or payload.get("slug") != slug
        or not isinstance(payload.get("cid"), int)
        or not isinstance(payload.get("version"), str)
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Invalid confirmation token")

    challenge = (
        await db.execute(
            select(Challenge)
            .where(Challenge.id == payload["cid"], Challenge.slug == slug)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if challenge is None or payload["version"] != challenge_version(challenge):
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Challenge changed or no longer exists"
        )

    title, points = challenge.title, challenge.points
    affected_users = set((await db.execute(
        select(Solve.user_id).where(Solve.challenge_id == challenge.id)
    )).scalars())
    # Deletion cascades to failed attempts too. Include players who never
    # solved this challenge so an existing/recovered failed count cannot linger.
    affected_users.update((await db.scalars(
        select(Submission.user_id).where(
            Submission.challenge_id == challenge.id, Submission.correct.is_(False),
        )
    )).all())
    affected_groups = set((await db.execute(
        select(GroupChallengeCredit.group_name).where(
            GroupChallengeCredit.challenge_id == challenge.id,
        )
    )).scalars())
    await db.delete(challenge)
    await db.flush()
    await refresh_affected(db, affected_users, affected_groups)
    db.add(
        AuditLog(
            user_id=user.id,
            event_type="flag_admin_challenge_deleted",
            detail={"challenge": slug, "points": points},
            ip_address=client_ip(request),
        )
    )
    await db.commit()
    return {"deleted": True, "title": title, "points": points}