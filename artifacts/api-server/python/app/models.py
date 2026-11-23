"""ORM models. Keep this in sync with alembic/versions."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Okta ``sub`` claim - the stable identifier for the person.
    okta_sub: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    username: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    # Immutable, human-readable Unix identity. Nullable only so a deployment can apply
    # the DDL without an Alembic data migration; normal request DML fills it.
    shell_name: Mapped[str | None] = mapped_column(String(48), unique=True)
    email: Mapped[str | None] = mapped_column(String(320), index=True)
    full_name: Mapped[str | None] = mapped_column(String(255))
    first_name: Mapped[str | None] = mapped_column(String(128))
    last_name: Mapped[str | None] = mapped_column(String(128))
    department_parent: Mapped[str | None] = mapped_column(String(255))
    department_leaf: Mapped[str | None] = mapped_column(String(255))
    level: Mapped[str | None] = mapped_column(String(128))
    groups: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    solves: Mapped[list[Solve]] = relationship(back_populates="user", cascade="all, delete-orphan")


class ShellNameRegistry(Base):
    """Names ever issued, retained after account deletion to prevent reuse."""

    __tablename__ = "shell_name_registry"

    name: Mapped[str] = mapped_column(String(48), primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), unique=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ActivityOutbox(Base):
    """Immutable safe message snapshot with delivery state; never stores raw inputs."""

    __tablename__ = "activity_outbox"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    message: Mapped[str] = mapped_column(String(600), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SamlTransaction(Base):
    __tablename__ = "saml_transactions"
    relay_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    browser_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    request_id: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    popup: Mapped[bool] = mapped_column(Boolean, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
    )


class SamlReplay(Base):
    __tablename__ = "saml_replays"
    assertion_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Challenge(Base):
    __tablename__ = "challenges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False, default="misc", index=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    points: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    #: HMAC-SHA256(flag_hash_secret, normalized flag), hex. Plaintext flags are never stored.
    flag_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    case_sensitive: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    solves: Mapped[list[Solve]] = relationship(
        back_populates="challenge", cascade="all, delete-orphan"
    )


class PlayerScoreboard(Base):
    """Transactionally maintained ranking projection; identity remains in users."""

    __tablename__ = "player_scoreboard"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    solves: Mapped[int] = mapped_column(Integer, nullable=False)
    failed_attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    last_solve_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GroupScoreboard(Base):
    __tablename__ = "group_scoreboard"
    group_name: Mapped[str] = mapped_column(String(255), primary_key=True)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    solves: Mapped[int] = mapped_column(Integer, nullable=False)
    last_solve_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Solve(Base):
    """One row per (user, challenge) the first time the correct flag is submitted."""

    __tablename__ = "solves"
    __table_args__ = (UniqueConstraint("user_id", "challenge_id", name="uq_solves_user_challenge"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    challenge_id: Mapped[int] = mapped_column(
        ForeignKey("challenges.id", ondelete="CASCADE"), nullable=False
    )
    points_awarded: Mapped[int] = mapped_column(Integer, nullable=False)
    solved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    user: Mapped[User] = relationship(back_populates="solves")
    challenge: Mapped[Challenge] = relationship(back_populates="solves")


class GroupChallengeCredit(Base):
    """The first points awarded to an IdP group for a challenge."""

    __tablename__ = "group_challenge_credits"
    __table_args__ = (
        UniqueConstraint(
            "group_name", "challenge_id", name="uq_group_challenge_credits_group_challenge"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    group_name: Mapped[str] = mapped_column(String(255), nullable=False)
    challenge_id: Mapped[int] = mapped_column(
        ForeignKey("challenges.id", ondelete="CASCADE"), nullable=False
    )
    points_awarded: Mapped[int] = mapped_column(Integer, nullable=False)
    credited_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    awarded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )


class Submission(Base):
    """Every flag attempt, right or wrong. The submitted text is deliberately not stored."""

    __tablename__ = "submissions"
    __table_args__ = (Index("ix_submissions_user_time", "user_id", "submitted_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    challenge_id: Mapped[int | None] = mapped_column(
        ForeignKey("challenges.id", ondelete="CASCADE"), nullable=True
    )
    correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    detail: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    ip_address: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
