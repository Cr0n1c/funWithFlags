"""Only server-owned identity and an enumerated terminal command reach Slack."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Request, Response
from sqlalchemy import func, select

from app.activity import _post, drain_request, safe_text, shell_username, webhook_url
from app.models import AuditLog, User
from app.security import CurrentUser, DbDep, SettingsDep

router = APIRouter(prefix="/activity", tags=["activity"])

# Explicitly synchronized with the browser's command metadata list. Unknown shell
# source is represented by one generic token, never by a user-provided executable.
COMMANDS = frozenset(
    """
about adventure challenges challenge clear create_flag delete_flag
export_flags help import_challenges import_flags fortune reset scoreboard login logout
reset-shell status stty submit awk bdf cat cd cp cut date echo env find finger
getconf grep head hostname id ioscan lanscan last less ls machinfo man mkdir model
more mv ps pwd rm sed sort strings swlist tail touch uname uniq uptime vi view wc
who whoami leaderboard top rank groups history mail
""".split()
) | {"shell command"}


@router.post("/command", status_code=204)
async def command_activity(  # noqa: PLR0911
    request: Request,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
) -> Response:
    # Browser fetches are same-origin; third-party forms cannot spend session cookies.
    if (
        request.headers.get("origin") != settings.app_base_url
        or request.headers.get("sec-fetch-site", "same-origin") != "same-origin"
    ):
        return Response(status_code=403)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 128:
            return Response(status_code=422)
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError):
        return Response(status_code=422)
    if (
        not isinstance(data, dict)
        or set(data) != {"command"}
        or not isinstance(data["command"], str)
        or data["command"] not in COMMANDS
    ):
        return Response(status_code=422)
    url = webhook_url(settings)
    if url is None:
        return Response(status_code=204)
    # Bound accepted traffic per trusted DB account across all replicas. Row lock
    # serializes concurrent same-account submissions, not unrelated users.
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    count = (
        await db.execute(
            select(func.count(AuditLog.id)).where(
                AuditLog.user_id == user.id,
                AuditLog.event_type == "activity.command",
                AuditLog.created_at >= datetime.now(UTC) - timedelta(minutes=1),
            )
        )
    ).scalar_one()
    if count >= 10:
        await db.rollback()
        return Response(status_code=204)
    db.add(AuditLog(user_id=user.id, event_type="activity.command", detail={}))
    await db.commit()
    await _post(url, f"{shell_username(user)} ran {safe_text(data['command'])}.")
    await drain_request(request.app.state.db.session_factory, settings)
    return Response(status_code=204)
