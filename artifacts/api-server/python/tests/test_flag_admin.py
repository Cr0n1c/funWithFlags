from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, datetime

import jwt
from sqlalchemy import func, select

from app import crack_hashes
from app.models import Challenge, GroupChallengeCredit, Solve
from app.security import FLAG_DELETE_AUDIENCE
from app.terminal_challenges import TERMINAL_CHALLENGES
from tests.conftest import make_challenge, make_user, session_cookie


async def _member(session, *, username: str = "operator"):
    user = await make_user(
        session,
        username=username,
        groups=["funwithflags-admins"],
    )
    user.okta_sub = "saml:" + (f"{len(username):064x}"[-64:])
    user.last_login_at = datetime.now(UTC)
    await session.commit()
    return user


async def test_flag_backup_export_preview_and_atomic_import(client, settings, session):
    member = await _member(session)
    denied = await make_user(session, username="ordinary")
    row = await make_challenge(session, settings, slug="backup-original", flag="CTF{offline}",
                               hidden=True, is_active=False, sort_order=19, case_sensitive=True)
    headers = session_cookie(settings, member)
    assert (await client.get("/api/flag-admin/export-flags")).status_code == 401
    assert (await client.post("/api/flag-admin/import-flags/preview", content=b"{}",
                              headers={"Content-Type": "application/json"})).status_code == 401
    assert (await client.get("/api/flag-admin/export-flags",
                             headers=session_cookie(settings, denied))).status_code == 403
    export = await client.get("/api/flag-admin/export-flags", headers=headers)
    assert export.status_code == 200
    assert export.headers["cache-control"] == "no-store"
    assert "attachment;" in export.headers["content-disposition"]
    backup = export.json()
    assert set(backup) == {"version", "key_id", "challenges"}
    assert backup["version"] == 1
    assert backup["key_id"] != settings.flag_hash_secret.get_secret_value()
    assert len(backup["challenges"]) == 1
    item = backup["challenges"][0]
    assert set(item) == {"slug", "title", "category", "description", "points",
                         "flag_hash", "case_sensitive", "is_active", "hidden", "sort_order"}
    assert item["flag_hash"] == row.flag_hash
    assert item["hidden"] is True and item["is_active"] is False
    assert str(row.id) not in item and "email" not in export.text
    preview_url = "/api/flag-admin/import-flags/preview"
    commit_url = "/api/flag-admin/import-flags"
    for path in (preview_url, commit_url):
        assert (await client.post(path, json=backup,
                                  headers=session_cookie(settings, denied))).status_code == 403
        assert (await client.post(path, json=backup)).status_code == 401

    async def post(path, payload):
        return await client.post(path, json=payload, headers=headers)

    assert (await post(preview_url, backup)).json() == {
        "missing": 0, "identical": 1, "conflicts": 0}
    assert (await post(commit_url, backup)).json() == {"created": 0, "identical": 1}
    new = {**item, "slug": "backup-new", "flag_hash": "a" * 64, "title": "New"}
    backup["challenges"].append(new)
    assert (await post(preview_url, backup)).json()["missing"] == 1
    mismatched = {**backup, "key_id": "b" * 64}
    assert (await post(preview_url, mismatched)).status_code == 400
    assert (await post(commit_url, {**backup, "version": 2})).status_code == 400
    for invalid in ({**backup, "extra": "SENSITIVE"}, {**backup, "challenges": [
        {**item, "flag_hash": "SENSITIVE"}]}, {**backup, "challenges": [item, item]}):
        response = await post(preview_url, invalid)
        assert response.status_code in (400, 409)
        assert "SENSITIVE" not in response.text
    repeated_key = await client.post(
        preview_url,
        content=b'{"version":1,"version":2,"key_id":"SENSITIVE","challenges":[]}',
        headers={**headers, "Content-Type": "application/json"},
    )
    assert repeated_key.status_code == 400 and "SENSITIVE" not in repeated_key.text
    huge = await client.post(preview_url, content=json.dumps(backup).encode() + b" " * 1_048_576,
                             headers={**headers, "Content-Type": "application/json"})
    assert huge.status_code == 413
    conflict = {**backup, "challenges": [{**item, "points": item["points"] + 1}, new]}
    assert (await post(preview_url, conflict)).json()["conflicts"] == 1
    assert (await post(commit_url, conflict)).status_code == 409
    missing_row = await session.execute(select(Challenge).where(Challenge.slug == "backup-new"))
    assert missing_row.scalar_one_or_none() is None
    duplicate = {**backup, "challenges": [{**new, "flag_hash": row.flag_hash}]}
    assert (await post(commit_url, duplicate)).status_code == 409
    assert (await post(commit_url, backup)).json() == {"created": 1, "identical": 1}
    await session.refresh(row)
    assert row.id and row.points == item["points"]
    imported_row = await session.execute(select(Challenge).where(Challenge.slug == "backup-new"))
    imported = imported_row.scalar_one()
    assert imported.flag_hash == new["flag_hash"] and imported.sort_order == 19


async def test_flag_admin_access_is_narrow_and_exact(client, settings, session):
    assert (await client.get("/api/flag-admin/access")).status_code == 401

    legacy = await make_user(session, username="legacy", is_admin=True)
    wrong_case = await make_user(
        session, username="case", groups=["FunWithFlags-Admins"]
    )
    wrong_case.okta_sub = "saml:" + ("b" * 64)
    wrong_case.last_login_at = datetime.now(UTC)
    forged = await make_user(
        session, username="forged", groups=["funwithflags-admins"]
    )
    forged.last_login_at = datetime.now(UTC)
    await session.commit()

    for denied in (legacy, wrong_case, forged):
        response = await client.get(
            "/api/flag-admin/access", headers=session_cookie(settings, denied)
        )
        assert response.status_code == 403
        assert response.json() == {"detail": "Permission denied"}

    member = await _member(session)
    assert (
        await client.get(
            "/api/flag-admin/access", headers=session_cookie(settings, member)
        )
    ).json() == {"allowed": True}


async def test_hidden_flag_create_duplicate_preview_and_delete(
    client, settings, session
):
    operator = await _member(session)
    other_operator = await _member(session, username="other-operator")
    alpha = await make_user(
        session, username="alpha-player", groups=["Shared", "Alpha"]
    )
    bravo = await make_user(
        session, username="bravo-player", groups=["Shared", "Bravo"]
    )
    await make_challenge(
        session, settings, slug="retained", flag="CTF{Retained}", points=100
    )
    operator_headers = session_cookie(settings, operator)
    payload = {
        "title": "Sensitive title",
        "description": "Sensitive description",
        "flag": "CTF{Hidden}",
        "points": 750,
        "hidden": True,
    }

    created = await client.post(
        "/api/flag-admin/flags", json=payload, headers=operator_headers
    )
    assert created.status_code == 201
    body = created.json()
    assert set(body) == {
        "slug", "title", "description", "points", "hidden", "category"
    }
    assert body["category"] == "gold"
    assert "flag" not in body
    assert "sensitive" not in body["slug"].lower()

    listing = (await client.get("/api/challenges")).json()
    public = next(item for item in listing if item["slug"] == body["slug"])
    assert public["title"] == public["description"] == "<hidden>"
    assert public["hidden"] is True
    for player in (alpha, bravo):
        player_headers = session_cookie(settings, player)
        hidden_solve = await client.post(
            "/api/challenges/submit",
            json={"flag": "ctf{hidden}"},
            headers=player_headers,
        )
        retained_solve = await client.post(
            "/api/challenges/submit",
            json={"flag": "ctf{retained}"},
            headers=player_headers,
        )
        assert hidden_solve.json()["points_awarded"] == 750
        assert retained_solve.json()["points_awarded"] == 100

    personal_before = {
        row["username"]: (row["score"], row["solves"])
        for row in (
            await client.get(
                "/api/leaderboard", headers=session_cookie(settings, alpha)
            )
        ).json()
    }
    groups_before = {
        row["group_name"]: (row["score"], row["solves"])
        for row in (
            await client.get(
                "/api/leaderboard/groups", headers=session_cookie(settings, alpha)
            )
        ).json()
    }
    assert personal_before == {
        "alpha-player": (850, 2),
        "bravo-player": (850, 2),
    }
    assert groups_before == {
        "Alpha": (850, 2),
        "Bravo": (850, 2),
        "Shared": (850, 2),
    }
    assert await session.scalar(select(func.count(Solve.id))) == 4
    assert await session.scalar(select(func.count(GroupChallengeCredit.id))) == 6

    challenge = (
        await session.execute(select(Challenge).where(Challenge.slug == body["slug"]))
    ).scalar_one()
    challenge.is_active = False
    await session.commit()
    duplicate = await client.post(
        "/api/flag-admin/flags", json=payload, headers=operator_headers
    )
    assert duplicate.status_code == 409

    preview = await client.post(
        "/api/flag-admin/delete-preview",
        json={"flag": "ctf{hidden}"},
        headers=operator_headers,
    )
    assert preview.status_code == 200
    assert preview.json()["title"] == "Sensitive title"
    token = preview.json()["confirmation_token"]

    wrong_user = await client.request(
        "DELETE",
        f"/api/flag-admin/flags/{body['slug']}",
        json={"confirmation_token": token},
        headers=session_cookie(settings, other_operator),
    )
    assert wrong_user.status_code == 409

    token_payload = jwt.decode(
        token, options={"verify_signature": False}
    )
    token_payload.update({"iat": int(time.time()) - 20, "exp": int(time.time()) - 10})
    expired_token = jwt.encode(
        token_payload,
        settings.session_secret.get_secret_value(),
        algorithm="HS256",
        headers=None,
    )
    assert token_payload["aud"] == FLAG_DELETE_AUDIENCE
    expired = await client.request(
        "DELETE",
        f"/api/flag-admin/flags/{body['slug']}",
        json={"confirmation_token": expired_token},
        headers=operator_headers,
    )
    assert expired.status_code == 409

    bad = await client.request(
        "DELETE",
        f"/api/flag-admin/flags/{body['slug']}",
        json={"confirmation_token": "bad"},
        headers=operator_headers,
    )
    assert bad.status_code == 409

    challenge.title = "Changed after preview"
    await session.commit()
    stale = await client.request(
        "DELETE",
        f"/api/flag-admin/flags/{body['slug']}",
        json={"confirmation_token": token},
        headers=operator_headers,
    )
    assert stale.status_code == 409

    revoked_preview = await client.post(
        "/api/flag-admin/delete-preview",
        json={"flag": "ctf{hidden}"},
        headers=operator_headers,
    )
    assert revoked_preview.status_code == 200
    operator.groups = []
    await session.commit()
    revoked = await client.request(
        "DELETE",
        f"/api/flag-admin/flags/{body['slug']}",
        json={"confirmation_token": revoked_preview.json()["confirmation_token"]},
        headers=operator_headers,
    )
    assert revoked.status_code == 403
    assert revoked.json() == {"detail": "Permission denied"}
    assert await session.scalar(
        select(func.count(Challenge.id)).where(Challenge.slug == body["slug"])
    ) == 1

    operator.groups = ["funwithflags-admins"]
    await session.commit()
    final_preview = await client.post(
        "/api/flag-admin/delete-preview",
        json={"flag": "ctf{hidden}"},
        headers=operator_headers,
    )
    deleted = await client.request(
        "DELETE",
        f"/api/flag-admin/flags/{body['slug']}",
        json={"confirmation_token": final_preview.json()["confirmation_token"]},
        headers=operator_headers,
    )
    assert deleted.json() == {
        "deleted": True,
        "title": "Changed after preview",
        "points": 750,
    }
    personal_after = {
        row["username"]: (row["score"], row["solves"])
        for row in (
            await client.get(
                "/api/leaderboard", headers=session_cookie(settings, alpha)
            )
        ).json()
    }
    groups_after = {
        row["group_name"]: (row["score"], row["solves"])
        for row in (
            await client.get(
                "/api/leaderboard/groups", headers=session_cookie(settings, alpha)
            )
        ).json()
    }
    assert personal_after == {
        "alpha-player": (100, 1),
        "bravo-player": (100, 1),
    }
    assert groups_after == {
        "Alpha": (100, 1),
        "Bravo": (100, 1),
        "Shared": (100, 1),
    }
    assert await session.scalar(select(func.count(Solve.id))) == 2
    assert await session.scalar(select(func.count(GroupChallengeCredit.id))) == 3


async def test_flag_validation_never_reflects_plaintext(client, settings, session):
    operator = await _member(session)
    secret = "DO-NOT-REFLECT-" + ("x" * 4096)
    response = await client.post(
        "/api/flag-admin/flags",
        json={
            "title": "Title",
            "description": "Description",
            "flag": secret,
            "points": True,
            "hidden": False,
        },
        headers=session_cookie(settings, operator),
    )
    assert response.status_code == 422
    assert secret not in response.text


async def test_explicit_hash_import_authorization_submission_and_validation(
    monkeypatch, client, settings, session
):
    words = {name: f"offline-{name}-word" for name in ("easy", "medium", "hard")}
    monkeypatch.setattr(crack_hashes, "PUZZLES", tuple(
        (f"crack-the-hash-{name}", f"Crack The Hash: {name.title()}", points,
         "MD5", hashlib.md5(words[name].encode()).hexdigest(), "")
        for name, points in (("easy", 50), ("medium", 150), ("hard", 400))
    ))
    endpoint = "/api/flag-admin/import-challenges"
    assert (await client.get("/api/flag-admin/import-hash-challenges")).status_code == 404
    assert (await client.get("/api/flag-admin/import-terminal-challenges")).status_code == 404
    assert (await client.post(endpoint, json=words)).status_code == 401
    assert (await client.get(endpoint)).status_code == 401
    ordinary = await make_user(session, username="ordinary", is_admin=True)
    assert (await client.post(
        endpoint, json=words, headers=session_cookie(settings, ordinary)
    )).status_code == 403
    denied = await client.get(endpoint, headers=session_cookie(settings, ordinary))
    assert denied.status_code == 403
    operator = await _member(session)
    headers = session_cookie(settings, operator)
    terminal_missing = [p["slug"] for p in (await client.get(endpoint, headers=headers)).json()["terminal"]]
    payload = {**words, "terminal_missing": terminal_missing}
    assert (await client.post(endpoint, json=words, headers=headers)).status_code == 422
    invalid = await client.post(endpoint, json={**payload, "easy": "wrong"}, headers=headers)
    assert invalid.status_code == 400
    assert words["medium"] not in invalid.text
    secret = "DO-NOT-REFLECT-" + "x" * 4096
    rejected = await client.post(
        endpoint, json={**payload, "easy": secret}, headers=headers
    )
    assert rejected.status_code == 422
    assert secret not in rejected.text
    assert await session.scalar(select(func.count(Challenge.id))) == 0
    preview = (await client.get(endpoint, headers=headers)).json()["puzzles"]
    assert len(preview) == 3
    assert (await client.post(endpoint, json=payload, headers=headers)).json() == {
        "created": 3 + len(TERMINAL_CHALLENGES), "unchanged": 0
    }
    assert (await client.post(endpoint, json={"terminal_missing": []}, headers=headers)).json() == {
        "created": 0, "unchanged": 3 + len(TERMINAL_CHALLENGES)
    }
    assert (await client.post(endpoint, json=payload, headers=headers)).status_code == 409
    preview = (await client.get(endpoint, headers=headers)).json()["puzzles"]
    assert preview == []
    medium = (await session.execute(select(Challenge).where(
        Challenge.slug == "crack-the-hash-medium"
    ))).scalar_one()
    medium.title = "Edited by another operator"
    await session.commit()
    conflict = await client.post(endpoint, json=payload, headers=headers)
    assert conflict.status_code == 409
    assert await session.scalar(select(func.count(Challenge.id))) == 3 + len(TERMINAL_CHALLENGES)
    medium.title = "Crack The Hash: Medium"
    operator.groups = []
    await session.commit()
    assert (await client.post(endpoint, json=payload, headers=headers)).status_code == 403
    operator.groups = ["funwithflags-admins"]
    await session.commit()
    player = await make_user(session, username="player")
    answer = hashlib.sha1(words["easy"].encode()).hexdigest().upper()
    submission = await client.post(
        "/api/challenges/submit", json={"flag": answer},
        headers=session_cookie(settings, player),
    )
    assert submission.json()["points_awarded"] == 50


async def test_partial_hash_import_preserves_existing_answer_and_rejects_stale_preview(
    monkeypatch, client, settings, session
):
    words = {name: f"offline-{name}" for name in ("easy", "medium", "hard")}
    monkeypatch.setattr(crack_hashes, "PUZZLES", tuple(
        (f"crack-the-hash-{name}", f"Crack The Hash: {name.title()}", points,
         "MD5", hashlib.md5(words[name].encode()).hexdigest(), "")
        for name, points in (("easy", 50), ("medium", 150), ("hard", 400))
    ))
    operator = await _member(session)
    headers = session_cookie(settings, operator)
    endpoint = "/api/flag-admin/import-challenges"
    terminal_missing = [p["slug"] for p in (await client.get(endpoint, headers=headers)).json()["terminal"]]
    assert (await client.post(endpoint, json={**words, "terminal_missing": terminal_missing}, headers=headers)).status_code == 200
    easy = (await session.execute(select(Challenge).where(
        Challenge.slug == "crack-the-hash-easy"
    ))).scalar_one()
    old_id, old_hash, old_updated = easy.id, easy.flag_hash, easy.updated_at
    hard = (await session.execute(select(Challenge).where(
        Challenge.slug == "crack-the-hash-hard"
    ))).scalar_one()
    medium = (await session.execute(select(Challenge).where(
        Challenge.slug == "crack-the-hash-medium"
    ))).scalar_one()
    await session.delete(hard)
    await session.delete(medium)
    await session.commit()
    assert [p["slug"] for p in (await client.get(endpoint, headers=headers)).json()["puzzles"]] == [
        "crack-the-hash-medium", "crack-the-hash-hard"
    ]
    assert (await client.post(endpoint, json={**words, "terminal_missing": []}, headers=headers)).status_code == 409
    stale = await client.post(endpoint, json={"medium": words["medium"], "terminal_missing": []}, headers=headers)
    assert stale.status_code == 409
    result = await client.post(
        endpoint, json={"medium": words["medium"], "hard": words["hard"], "terminal_missing": []}, headers=headers
    )
    assert result.json() == {"created": 2, "unchanged": 1 + len(TERMINAL_CHALLENGES)}
    assert (easy.id, easy.flag_hash, easy.updated_at) == (old_id, old_hash, old_updated)
    stale = await client.post(endpoint, json={"hard": words["hard"], "terminal_missing": []}, headers=headers)
    assert stale.status_code == 409


async def test_terminal_owasp_import_requires_exact_group_and_lists_distinct_objectives(
    monkeypatch, client, settings, session
):
    monkeypatch.setattr(crack_hashes, "PUZZLES", ())
    endpoint = "/api/flag-admin/import-challenges"
    assert (await client.get(endpoint)).status_code == 401
    assert (await client.post(endpoint, json={"terminal_missing": []})).status_code == 401
    other = await make_user(session, username="nonmember", is_admin=True)
    other_headers = session_cookie(settings, other)
    assert (await client.get(endpoint, headers=other_headers)).status_code == 403
    denied = await client.post(endpoint, json={"terminal_missing": []}, headers=other_headers)
    assert denied.status_code == 403
    operator = await _member(session)
    headers = session_cookie(settings, operator)
    puzzles = (await client.get(endpoint, headers=headers)).json()["terminal"]
    assert len(puzzles) == len(TERMINAL_CHALLENGES)
    assert len({p["title"] for p in puzzles}) == len(TERMINAL_CHALLENGES)
    assert all(p["missing"] for p in puzzles)
    assert (await client.post(endpoint, json={"terminal_missing": []}, headers=headers)).status_code == 409
    result = await client.post(
        endpoint, json={"terminal_missing": [p["slug"] for p in puzzles]}, headers=headers
    )
    assert result.json() == {"created": len(TERMINAL_CHALLENGES), "unchanged": 0}
    listing = (await client.get("/api/challenges", headers=headers)).json()
    owasp = [c for c in listing if c["category"] == "OWASP"]
    assert len(owasp) == len(TERMINAL_CHALLENGES) - 5
    compliance = next(c for c in listing if c["slug"] == "soc-2-prep-training")
    assert compliance["category"] == "gold"
    assert compliance["title"] == "SOC 2 Prep Training"
    assert compliance["points"] == 50
    assert "audit-ready evidence" in compliance["description"]
    assert "soc2_aint_4you_or_is_it" not in str(listing)
    assert "soc2_aint_4you_or_is_it" not in str(puzzles)
    talks = [c for c in listing if c["category"] == "Talks"]
    assert len(talks) == 3
    assert all(c["points"] == 500 for c in talks)
    from app.talk_challenges import TALK_CHALLENGES
    from app.security import hash_flag
    for slug, title, description, flag in TALK_CHALLENGES:
        row = (await session.execute(select(Challenge).where(Challenge.slug == slug))).scalar_one()
        assert row.title == title and row.description == description
        assert row.flag_hash == hash_flag(settings, flag, case_sensitive=False)
        assert flag not in result.text and flag not in str(listing)
    assert {c["title"] for c in listing} == {p["title"] for p in puzzles}
    assert all("xsecurity{" not in c["description"] for c in owasp)
    env_row = next(c for c in owasp if c["slug"] == "shell-environment")
    assert "CWE-526" in env_row["description"]
    assert "A02:2021" in env_row["description"]
    assert "$t0ring_secrets_n_env_i$_bad" not in env_row["description"]
    browser_row = next(c for c in owasp if c["slug"] == "browser-local-storage")
    assert browser_row["title"] == "Find sensitive data in browser storage"
    assert "CWE-922" in browser_row["description"]
    assert "A02:2021" in browser_row["description"]
    assert "eyJhbGci_d0nt_st0r3_h3r3" not in browser_row["description"]
    assert all("eyJhbGci_d0nt_st0r3_h3r3" not in str(p) for p in puzzles)
    history_row = next(c for c in owasp if c["slug"] == "shell-bash-history-secret")
    assert history_row["title"] != next(c for c in owasp if c["slug"] == "shell-history")["title"]
    assert "Bash history" in history_row["title"]
    assert "CWE-532" in history_row["description"]
    assert "A02:2021" in history_row["description"]
    assert "B@sh_h1st0ry_st0res_secret$_t00" not in str(puzzles)
    solved = await client.post(
        "/api/challenges/submit",
        json={"flag": "$t0ring_secrets_n_env_i$_bad"},
        headers=headers,
    )
    assert solved.status_code == 200
    assert solved.json()["correct"] is True
    assert solved.json()["points_awarded"] == 50
    browser_solved = await client.post(
        "/api/challenges/submit",
        json={"flag": " eyJhbGci_d0nt_st0r3_h3r3"},
        headers=headers,
    )
    assert browser_solved.status_code == 200
    assert browser_solved.json()["correct"] is True
    assert browser_solved.json()["points_awarded"] == 50
    history_solved = await client.post(
        "/api/challenges/submit",
        json={"flag": "B@sh_h1st0ry_st0res_secret$_t00"},
        headers=headers,
    )
    assert history_solved.status_code == 200
    assert history_solved.json()["correct"] is True
    assert history_solved.json()["points_awarded"] == 50
    source_row = next(c for c in owasp if c["slug"] == "everything-is-fair-game")
    assert source_row["title"] == "Everything is fair game"
    assert source_row["points"] == 25
    assert source_row["description"] == "sometimes we all need a little help and ask our friend Claude to run in chrome"
    source_solved = await client.post(
        "/api/challenges/submit",
        json={"flag": "{everything_1$_fair_game}"}, headers=headers,
    )
    assert source_solved.status_code == 200
    assert source_solved.json()["correct"] is True
    assert source_solved.json()["points_awarded"] == 25
    repeated = await client.post(
        "/api/challenges/submit",
        json={"flag": "{everything_1$_fair_game}"}, headers=headers,
    )
    assert repeated.json()["points_awarded"] == 0
    stale = await client.post(endpoint, json={"terminal_missing": [puzzles[0]["slug"]]}, headers=headers)
    assert stale.status_code == 409
    assert (await client.get(endpoint, headers=headers)).json()["terminal"] == []


async def test_one_import_includes_hashes_and_terminal_flags_atomically(
    monkeypatch, client, settings, session,
):
    words = {name: f"offline-combined-{name}" for name in ("easy", "medium", "hard")}
    monkeypatch.setattr(crack_hashes, "PUZZLES", tuple(
        (f"crack-the-hash-{name}", f"Crack The Hash: {name.title()}", points,
         "MD5", hashlib.md5(words[name].encode()).hexdigest(), "")
        for name, points in (("easy", 50), ("medium", 150), ("hard", 400))
    ))
    operator = await _member(session)
    headers = session_cookie(settings, operator)
    endpoint = "/api/flag-admin/import-challenges"
    preview = (await client.get(endpoint, headers=headers)).json()
    terminal_missing = [p["slug"] for p in preview["terminal"]]
    assert len(preview["puzzles"]) == 3 and len(terminal_missing) == len(TERMINAL_CHALLENGES)
    assert (await client.post(
        endpoint, json={**words, "terminal_missing": terminal_missing[:-1]}, headers=headers
    )).status_code == 409
    assert await session.scalar(select(func.count(Challenge.id))) == 0
    result = await client.post(
        endpoint, json={**words, "terminal_missing": terminal_missing}, headers=headers
    )
    assert result.json() == {"created": 3 + len(TERMINAL_CHALLENGES), "unchanged": 0}
    assert (await client.get(endpoint, headers=headers)).json() == {
        "puzzles": [], "terminal": [],
    }
    assert (await client.post(
        endpoint, json={"terminal_missing": terminal_missing}, headers=headers
    )).status_code == 409
    assert await session.scalar(select(func.count(Challenge.id))) == 3 + len(TERMINAL_CHALLENGES)
    # The normal command must proceed when hash puzzles exist but OWASP rows are absent.
    terminal = (await session.execute(select(Challenge).where(
        Challenge.slug == terminal_missing[0]
    ))).scalar_one()
    await session.delete(terminal)
    await session.commit()
    preview = (await client.get(endpoint, headers=headers)).json()
    assert preview["puzzles"] == []
    assert [p["slug"] for p in preview["terminal"]] == [terminal_missing[0]]
    assert (await client.post(
        endpoint, json={"terminal_missing": [terminal_missing[0]]}, headers=headers
    )).json() == {"created": 1, "unchanged": 2 + len(TERMINAL_CHALLENGES)}


async def test_compliance_training_awards_50_points_once(client, settings, session):
    from app.terminal_challenges import prepare_terminal_challenges

    session.add_all(await prepare_terminal_challenges(
        session, settings, {item[0] for item in TERMINAL_CHALLENGES},
    ))
    await session.commit()
    player = await make_user(session, username="training-player")
    for expected_points in (50, 0):
        solved = await client.post(
            "/api/challenges/submit",
            json={"flag": "soc2_aint_4you_or_is_it"},
            headers=session_cookie(settings, player),
        )
        assert solved.status_code == 200
        assert solved.json()["correct"] is True
        assert solved.json()["points_awarded"] == expected_points


async def test_existing_terminal_flags_gain_only_missing_bash_history_challenge(
    client, settings, session,
):
    operator = await _member(session)
    headers = session_cookie(settings, operator)
    for slug, title, description, flag in TERMINAL_CHALLENGES:
        if slug == "shell-bash-history-secret":
            continue
        from app.terminal_challenges import metadata
        category, points = metadata(slug)
        row = await make_challenge(
            session, settings, slug=slug, flag=flag, points=points,
        )
        row.title = title
        row.description = description
        row.category = category
    for slug, title, points, algorithm, digest, hint in crack_hashes.PUZZLES:
        row = await make_challenge(
            session, settings, slug=slug, flag=f"existing-{slug}", points=points,
        )
        row.title = title
        row.description = crack_hashes.puzzle_description(algorithm, digest, hint)
        row.category = "cracking"
    await session.commit()
    original = {
        row.slug: (row.id, row.flag_hash)
        for row in (await session.execute(select(Challenge))).scalars()
    }
    endpoint = "/api/flag-admin/import-challenges"
    preview = (await client.get(endpoint, headers=headers)).json()
    assert preview["puzzles"] == []
    assert [item["slug"] for item in preview["terminal"]] == ["shell-bash-history-secret"]
    # The normal import needs no hash words when those rows already exist.
    imported = await client.post(
        endpoint, json={"terminal_missing": ["shell-bash-history-secret"]}, headers=headers,
    )
    assert imported.status_code == 200
    assert imported.json() == {
        "created": 1, "unchanged": len(TERMINAL_CHALLENGES) + len(crack_hashes.PUZZLES) - 1,
    }
    assert (await client.get(endpoint, headers=headers)).json()["terminal"] == []
    assert {
        row.slug: (row.id, row.flag_hash)
        for row in (await session.execute(select(Challenge))).scalars()
        if row.slug in original
    } == original


async def test_combined_import_collision_rolls_back_all_missing_hashes(
    monkeypatch, client, settings, session,
):
    words = {name: f"offline-collision-{name}" for name in ("easy", "medium", "hard")}
    monkeypatch.setattr(crack_hashes, "PUZZLES", tuple(
        (f"crack-the-hash-{name}", f"Crack The Hash: {name.title()}", points,
         "MD5", hashlib.md5(words[name].encode()).hexdigest(), "")
        for name, points in (("easy", 50), ("medium", 150), ("hard", 400))
    ))
    operator = await _member(session)
    await make_challenge(
        session, settings, slug="other-flag", flag=TERMINAL_CHALLENGES[0][3]
    )
    headers = session_cookie(settings, operator)
    endpoint = "/api/flag-admin/import-challenges"
    preview = (await client.get(endpoint, headers=headers)).json()
    response = await client.post(endpoint, json={
        **words, "terminal_missing": [p["slug"] for p in preview["terminal"]],
    }, headers=headers)
    assert response.status_code == 409
    assert await session.scalar(select(func.count(Challenge.id))) == 1