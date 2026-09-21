"""Async SQLAlchemy engine/session plumbing."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import Settings


class Base(DeclarativeBase):
    pass


class Database:
    """Holds the engine + session factory for one application instance."""

    def __init__(self, settings: Settings, url: str | None = None) -> None:
        url = url or settings.sqlalchemy_url
        kwargs: dict[str, object] = {"echo": settings.db_echo, "pool_pre_ping": True}
        if not url.startswith("sqlite"):
            kwargs.update(pool_size=settings.db_pool_size, max_overflow=settings.db_max_overflow)
        self.engine: AsyncEngine = create_async_engine(url, **kwargs)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.session_factory() as session:
            yield session

    async def dispose(self) -> None:
        await self.engine.dispose()
