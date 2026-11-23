"""Pydantic request/response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator

from app.terminal_challenges import TERMINAL_CHALLENGES


class UserOut(BaseModel):
    account_id: str
    home: str
    username: str
    email: str | None
    full_name: str | None
    first_name: str | None = None
    last_name: str | None = None
    department_parent: str | None = None
    department_leaf: str | None = None
    level: str | None = None
    groups: list[str]
    is_admin: bool
    score: int = 0
    solves: int = 0


class HomeRosterEntry(BaseModel):
    home: str


class HomeRosterOwner(BaseModel):
    account_id: str
    home: str


class HomeRosterOut(BaseModel):
    owner: HomeRosterOwner
    entries: list[HomeRosterEntry]


class ChallengeOut(BaseModel):
    id: int
    slug: str
    title: str
    category: str
    description: str
    points: int
    solved: bool
    solve_count: int
    hidden: bool = False


class MatrixCompletionOut(BaseModel):
    solved: bool


class FlagSubmission(BaseModel):
    flag: str = Field(min_length=1, max_length=4096)


class SubmitResult(BaseModel):
    correct: bool
    already_solved: bool
    points_awarded: int
    total_score: int
    message: str
    event_id: int


class LeaderboardEntry(BaseModel):
    #: None when the player has no solves yet (unranked).
    rank: int | None
    username: str
    full_name: str | None
    score: int
    solves: int
    failed_attempts: int
    last_solve_at: datetime | None


class GroupLeaderboardEntry(BaseModel):
    rank: int
    group_name: str
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


class FlagAdminCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, hide_input_in_errors=True)

    title: str = Field(min_length=1, max_length=255)
    description: str = Field(min_length=1, max_length=1000)
    flag: str = Field(min_length=1, max_length=4096)
    points: StrictInt = Field(ge=0, le=1_000_000)
    hidden: StrictBool

    @field_validator("flag")
    @classmethod
    def flag_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Flag must not be blank")
        return value


class FlagDeletePreviewIn(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)
    flag: str = Field(min_length=1, max_length=4096)


class ChallengeImportIn(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    easy: str | None = Field(default=None, min_length=1, max_length=4096)
    medium: str | None = Field(default=None, min_length=1, max_length=4096)
    hard: str | None = Field(default=None, min_length=1, max_length=4096)
    extra_hard: str | None = Field(default=None, alias="extra-hard", min_length=1, max_length=4096)
    terminal_missing: list[str] = Field(max_length=len(TERMINAL_CHALLENGES))


class FlagDeleteConfirmIn(BaseModel):
    confirmation_token: str = Field(min_length=1, max_length=4096)


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
    challenge_slug: str | None
    correct: bool
    submitted_at: datetime
