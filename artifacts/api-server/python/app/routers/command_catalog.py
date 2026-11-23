"""Isolated CTF simulation. No role mutation or dynamic command dispatch."""

import hmac

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.bundle_challenge import COMMANDS, FLAG, PUZZLE_VALUE
from app.security import CurrentUser

router = APIRouter(prefix="/cli", include_in_schema=False)


class Invocation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=1, max_length=256)


@router.get("/commands")
async def catalog(user: CurrentUser):
    return {
        "commands": COMMANDS,
        "invocation": {
            "method": "POST",
            "path": "/api/cli/promote_user_to_admin",
            "body": {"token": "<recovered bundle value>"},
        },
    }


@router.post("/promote_user_to_admin")
async def invoke(body: Invocation, user: CurrentUser):
    if not hmac.compare_digest(body.token.encode(), PUZZLE_VALUE.encode()):
        raise HTTPException(403, "Invalid challenge token")
    return {"flag": FLAG, "message": "Simulation only. Account privileges unchanged."}
