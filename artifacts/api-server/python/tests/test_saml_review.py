"""Regression coverage for transport configuration and reviewed identity migration."""

import json

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import cli, saml
from app.config import Settings
from app.models import AuditLog, Solve, User
from tests.conftest import make_challenge


@pytest.mark.parametrize(
    "overrides",
    [
        {"app_base_url": "http://ui.test", "session_cookie_secure": True},
        {"app_base_url": "https://ui.test", "session_cookie_secure": False},
        {"app_base_url": "https://", "session_cookie_secure": True},
    ],
)
def test_production_transport_fails_closed(settings, overrides):
    values = settings.model_dump() | {"environment": "production"} | overrides
    with pytest.raises(ValidationError):
        Settings(**values)


def test_production_https_secure_allowed(settings):
    result = Settings(
        **(
            settings.model_dump()
            | {
                "environment": "production",
                "app_base_url": "https://ui.test",
                "session_cookie_secure": True,
            }
        )
    )
    assert result.session_cookie_secure


@pytest.mark.parametrize("case", ["success", "conflict", "relink", "stale"])
async def test_reviewed_link_atomicity(case, settings, database, session, monkeypatch, tmp_path):
    settings.saml_idp_entity_id = "https://idp.test/entity"
    previous = (
        saml.subject_key(settings.saml_idp_entity_id, "old")
        if case == "relink"
        else "legacy:legacy"
    )
    user = User(okta_sub=previous, username="legacy", is_admin=True)
    session.add(user)
    await session.commit()
    challenge = await make_challenge(session, settings)
    session.add(Solve(user_id=user.id, challenge_id=challenge.id, points_awarded=100))
    target = saml.subject_key(settings.saml_idp_entity_id, "new")
    if case == "conflict":
        session.add(User(okta_sub=target, username="already-linked"))
    await session.commit()
    path = tmp_path / "mapping.json"
    path.write_text(
        json.dumps(
            {
                "user_id": user.id,
                "previous_subject": "wrong" if case == "stale" else previous,
                "issuer": settings.saml_idp_entity_id,
                "subject": "new",
                "approval": "review-123",
            }
        )
    )
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(cli, "Database", lambda _: database)

    async def no_dispose():
        pass

    monkeypatch.setattr(database, "dispose", no_dispose)
    if case == "success":
        await cli._link_saml(str(path))
    else:
        with pytest.raises(IntegrityError if case == "conflict" else ValueError):
            await cli._link_saml(str(path))
    await session.refresh(user)
    assert user.okta_sub == (target if case == "success" else previous)
    assert user.is_admin == (case != "success")
    logs = (await session.execute(select(AuditLog))).scalars().all()
    assert len(logs) == (1 if case == "success" else 0)
    solve = (await session.execute(select(Solve))).scalar_one()
    assert solve.user_id == user.id and solve.points_awarded == 100
