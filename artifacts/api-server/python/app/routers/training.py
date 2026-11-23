"""Intentionally flawed toy operations on constants, behind normal sign-in."""
import posixpath

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from app.security import CurrentUser
from app.training import PUZZLES

router = APIRouter(prefix="/training", tags=["training"])


@router.get("/invoices/{invoice_id}")
async def invoice(invoice_id: int, user: CurrentUser):
    if invoice_id == 1042:
        return {"id": 1042, "owner": "training-learner", "amount": 25,
                "notice": "Fictional billing records are numbered sequentially."}
    if invoice_id == 1043:
        return {"id": 1043, "owner": "training-finance", "amount": 300,
                "flag": PUZZLES[0][3]}
    raise HTTPException(404, "No such training invoice")


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(default="learner", max_length=80)
    role: str = Field(default="reader", max_length=40)


@router.post("/profile")
async def profile(body: Profile, user: CurrentUser):
    result = {"profile": body.model_dump(), "notice": "Fictional profile only; nothing is saved."}
    if body.role == "admin":
        result["flag"] = PUZZLES[1][3]
    return result


@router.get("/files")
async def file(user: CurrentUser, path: str = Query(max_length=256)):
    # String lookup ONLY. Never replace this with open(), pathlib or host storage.
    files = {
        "/public/welcome.txt": "Public reading room. Operations keeps release.txt in /internal.",
        "/internal/release.txt": PUZZLES[2][3],
    }
    resolved = posixpath.normpath("/public/" + path)
    if resolved not in files:
        raise HTTPException(404, "No such training document")
    return {"content": files[resolved], "notice": "Fictional document store only."}
