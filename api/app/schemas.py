"""Pydantic request/response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class UserOut(BaseModel):
    username: str
    email: str | None
    full_name: str | None
    groups: list[str]
    is_admin: bool
    score: int = 0
    solves: int = 0


class ChallengeOut(BaseModel):
    slug: str
    title: str
    category: str
    description: str
    points: int
    solved: bool
    solve_count: int


class FlagSubmission(BaseModel):
    flag: str = Field(min_length=1, max_length=4096)


class SubmitResult(BaseModel):
    correct: bool
    already_solved: bool
    points_awarded: int
    total_score: int
    message: str


class LeaderboardEntry(BaseModel):
    #: None when the player has no solves yet (unranked).
    rank: int | None
    username: str
    full_name: str | None
    score: int
    solves: int
    last_solve_at: datetime | None


class MyRank(BaseModel):
    entry: LeaderboardEntry
    #: Number of players with at least one solve.
    total_players: int


# ------------------------------------------------------------------------ admin


class ChallengeUpsert(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    category: str = Field(default="misc", min_length=1, max_length=64)
    description: str = ""
    points: int = Field(default=100, ge=0, le=100_000)
    #: Plaintext flag. Hashed before storage; omit to keep the existing flag on update.
    flag: str | None = Field(default=None, min_length=1, max_length=4096)
    case_sensitive: bool = False
    is_active: bool = True
    sort_order: int = 0


class AdminChallengeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    slug: str
    title: str
    category: str
    description: str
    points: int
    case_sensitive: bool
    is_active: bool
    sort_order: int
    solve_count: int = 0
    created_at: datetime
    updated_at: datetime


class AdminUserOut(BaseModel):
    id: int
    username: str
    email: str | None
    full_name: str | None
    groups: list[str]
    is_admin: bool
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None
    score: int = 0
    solves: int = 0


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int | None
    event_type: str
    detail: dict[str, object]
    ip_address: str | None
    created_at: datetime


class SubmissionOut(BaseModel):
    id: int
    username: str
    challenge_slug: str
    correct: bool
    submitted_at: datetime
