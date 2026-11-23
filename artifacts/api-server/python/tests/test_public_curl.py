import asyncio
import errno
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from app import public_curl as curl
from app.curl_limits import CurlQuotaExceeded, PlayerCurlLimiter
from app.terminal_challenges import prepare_terminal_challenges, terminal_status
from tests.conftest import make_user, session_cookie

run_real_worker = curl._run_worker
real_popen = subprocess.Popen


@pytest.fixture(autouse=True)
def isolated_curl_limits(monkeypatch):
    monkeypatch.setattr(curl, "PLAYER_LIMITS", PlayerCurlLimiter())
    monkeypatch.setattr(curl, "SLOTS", threading.BoundedSemaphore(4))
    # Transport unit tests run inline so DNS/socket mocks remain observable.
    # Process-lifecycle tests below restore the real supervisor and exec an
    # offline fixture that patches DNS and sockets inside the child itself.
    monkeypatch.setattr(
        curl, "_run_worker", lambda raw: curl._fetch_transport(*curl._parse_url(raw)),
    )
    # Tests must explicitly supply synthetic DNS results; never resolve a real
    # target, including IMDS and private addresses.
    monkeypatch.setattr(socket, "getaddrinfo", Mock(side_effect=AssertionError("No real DNS")))
    monkeypatch.setattr(
        curl.subprocess, "Popen", Mock(side_effect=AssertionError("No unmocked child network")),
    )


@pytest.fixture
def subprocess_workers(monkeypatch, tmp_path):
    """Use real exec/IPC/kill/reap, with only child network calls replaced."""
    state = {"mode": "success", "children": [], "markers": []}

    def launch(command, **kwargs):
        assert command == [sys.executable, "-E", "-m", "app.public_curl_worker"]
        assert kwargs["stderr"] == subprocess.DEVNULL
        assert kwargs["env"] == {}
        marker = tmp_path / str(len(state["children"]))
        process = real_popen(
            [sys.executable, "-E", "-m", "tests.public_curl_stub", state["mode"], str(marker)],
            **kwargs,
        )
        state["children"].append(process)
        state["markers"].append(marker)
        return process

    monkeypatch.setattr(curl, "_run_worker", run_real_worker)
    # Exercise the production deadline: interpreter startup on shared/read-only
    # runners can itself take several seconds. A shortened budget can kill a
    # healthy child before it reaches the synthetic stall or recovery response.
    monkeypatch.setattr(curl.subprocess, "Popen", launch)
    yield state
    for process in state["children"]:
        # Failures must not leave synthetic sleepers behind in the test runner.
        if process.poll() is None:
            process.kill()
        process.wait()


def assert_workers_reaped(state):
    import os

    for process in state["children"]:
        assert process.returncode is not None
        assert process.stdin.closed and process.stdout.closed
        with pytest.raises(ChildProcessError):
            os.waitpid(process.pid, os.WNOHANG)


async def wait_for_stalled_workers(state, count):
    async def ready():
        while len(state["markers"]) < count or not all(p.exists() for p in state["markers"]):
            await asyncio.sleep(0.01)
    await asyncio.wait_for(ready(), timeout=curl.WORKER_TIMEOUT - 1)


@pytest.mark.parametrize("url", [
    "169.254.169.254", "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
])
def test_imds_is_fixture_only(monkeypatch, url):
    dns = Mock(side_effect=AssertionError("No network allowed"))
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    assert curl.FLAG not in curl.fetch_public(url)
    dns.assert_not_called()


def test_imds_browsable_tree_and_only_role_credentials_reveal_flag(monkeypatch):
    import json
    from app.imds_fixture import ROLE, METADATA
    dns = Mock(side_effect=AssertionError("No DNS allowed"))
    sockets = Mock(side_effect=AssertionError("No sockets allowed"))
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    monkeypatch.setattr(socket, "socket", sockets)
    def get(path):
        output = curl.fetch_public("http://169.254.169.254" + path)
        assert len(output) <= 500
        return output
    assert "latest" in get("/")
    assert "meta-data/" in get("/latest/")
    assert "iam/" in get("/latest/meta-data/")
    assert "security-credentials/" in get("/latest/meta-data/iam/")
    assert get("/latest/meta-data/iam/security-credentials/").strip() == ROLE
    for version in ("latest", "1.0", "2021-07-15"):
        for suffix in ("", "/"):
            assert json.loads(get(f"/{version}/meta-data/iam/security-credentials/{ROLE}{suffix}")) == {"flag": curl.FLAG}
    for path in METADATA:
        assert curl.FLAG not in get("/latest/meta-data/" + path)
    assert "accountId" in get("/latest/dynamic/instance-identity/document")
    assert "404" in get("/latest/meta-data/iam/security-credentials/wrong-role")
    assert "404" in get("/unknown")
    assert "404" in get("/latest/meta-data/../../")
    dns.assert_not_called()
    sockets.assert_not_called()


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1",
])
def test_internal_resolution_blocked(monkeypatch, ip):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80))])
    connect = Mock(side_effect=AssertionError("Never connect"))
    monkeypatch.setattr(socket, "socket", connect)
    with pytest.raises(ValueError):
        curl.fetch_public("http://internal.example/")
    connect.assert_not_called()


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://example.com/", "http://user:pass@example.com",
    "http://example.com:8080", "http://example.com/\r\nHost: localhost",
    "http://[fe80::1%25eth0]/", "http://example.com\\@127.0.0.1",
])
def test_unsafe_url_rejected(url):
    with pytest.raises(ValueError):
        curl.fetch_public(url)


def test_mixed_public_private_dns_is_rejected(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80))
        for ip in ("93.184.216.34", "10.0.0.1")
    ])
    connect = Mock(side_effect=AssertionError("Never connect"))
    monkeypatch.setattr(socket, "socket", connect)
    with pytest.raises(ValueError, match="public"):
        curl.fetch_public("http://mixed.example")
    connect.assert_not_called()


def test_public_pinned_connection_and_no_redirect(monkeypatch):
    dns = Mock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))])
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    sock = Mock()
    monkeypatch.setattr(socket, "socket", Mock(return_value=sock))
    response = Mock(status=200)
    response.getheader.return_value = "identity"
    response.read.return_value = b"public body"
    conn = Mock()
    conn.getresponse.return_value = response
    monkeypatch.setattr(curl.http.client, "HTTPConnection", Mock(return_value=conn))
    assert curl.fetch_public("http://example.com/path") == "public body"
    sock.connect.assert_called_once_with(("93.184.216.34", 80))
    dns.assert_called_once()
    response.status = 302
    with pytest.raises(ValueError, match="Redirects"):
        curl.fetch_public("http://example.com")
    response.status = 200
    response.read.return_value = b"x" * (curl.MAX_BYTES + 1)
    assert curl.fetch_public("http://example.com") == "x" * 500
    response.read.assert_called_with(curl.MAX_BYTES)
    response.read.return_value = ("😀" * 600).encode()
    assert curl.fetch_public("http://example.com") == "😀" * 500
    assert all(call.args[0] == "GET" for call in conn.request.call_args_list)


async def test_route_auth_and_scorable_puzzle(client, session, settings):
    assert (await client.post("/api/cli/curl", json={"url": "169.254.169.254"})).status_code == 401
    user = await make_user(session)
    headers = session_cookie(settings, user)
    root = await client.post("/api/cli/curl", json={"url": "169.254.169.254"}, headers=headers)
    assert "latest" in root.json()["output"] and curl.FLAG not in root.json()["output"]
    result = await client.post("/api/cli/curl", json={
        "url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/ctf-instance-role",
    }, headers=headers)
    assert result.status_code == 200
    assert curl.FLAG in result.json()["output"]
    assert (await client.post("/api/cli/curl", json={
        "url": "169.254.169.254", "method": "POST",
    }, headers=headers)).status_code == 422
    missing = {r["slug"] for r in await terminal_status(session, settings) if r["missing"]}
    session.add_all(await prepare_terminal_challenges(session, settings, missing))
    await session.commit()
    submission = await client.post("/api/challenges/submit", json={"flag": curl.FLAG}, headers=headers)
    assert submission.status_code == 200
    assert submission.json()["correct"] and submission.json()["points_awarded"] == 125


@pytest.mark.parametrize("customized", [False, True])
async def test_existing_metadata_correction_preserves_record(client, session, settings, customized):
    from app.crack_hashes import normalize_hash_categories
    from tests.conftest import make_challenge
    row = await make_challenge(session, settings, slug=curl.PUZZLE[0],
                               flag=curl.FLAG, points=150, category="OWASP")
    row.title = "Custom title" if customized else "A request in the wrong direction"
    row.description = curl.PUZZLE[2]
    await session.commit()
    old_id, old_hash = row.id, row.flag_hash
    headers = session_cookie(settings, await make_user(session))
    solved = await client.post("/api/challenges/submit", json={"flag": curl.FLAG}, headers=headers)
    assert solved.json()["points_awarded"] == 150
    assert await normalize_hash_categories(session) == (0 if customized else 1)
    await session.refresh(row)
    assert row.id == old_id and row.flag_hash == old_hash
    assert row.points == (150 if customized else 125)
    assert row.title == ("Custom title" if customized else curl.PUZZLE[1])
    assert await normalize_hash_categories(session) == 0
    rankings = await client.get("/api/leaderboard", headers=headers)
    assert rankings.json()[0]["score"] == 150


def test_quota_window_is_bounded_and_recovers_without_resetting_other_players():
    now = [0.0]
    limits = PlayerCurlLimiter(per_minute=2, max_players=2, clock=lambda: now[0])
    for _ in range(2):
        limits.acquire(1)
        limits.release(1)
    with pytest.raises(CurlQuotaExceeded) as rejected:
        limits.acquire(1)
    assert rejected.value.retry_after == 60
    now[0] = 30
    limits.acquire(2)
    limits.release(2)
    # A full table fails closed, without evicting a live rate window.
    with pytest.raises(CurlQuotaExceeded):
        limits.acquire(3)
    assert len(limits._players) == 2
    now[0] = 59.1
    with pytest.raises(CurlQuotaExceeded) as rejected:
        limits.acquire(1)
    assert rejected.value.retry_after == 1
    now[0] = 60
    limits.acquire(3)  # Expired idle account 1 is reclaimed.
    limits.release(3)
    assert set(limits._players) == {2, 3}
    assert list(limits._players[2].starts) == [30]
    now[0] = 120
    limits.acquire(1)
    limits.release(1)
    assert set(limits._players) == {1}


def test_parallel_admission_is_atomic():
    limits = PlayerCurlLimiter()
    barrier = threading.Barrier(8)

    def attempt(_):
        barrier.wait(timeout=5)
        try:
            limits.acquire(1)
            return True
        except CurlQuotaExceeded:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(attempt, range(8))) == 1
    limits.release(1)
    limits.acquire(1)
    limits.release(1)


async def test_route_quota_uses_authenticated_account_and_recovers(
    client, session, settings, monkeypatch,
):
    now = [0.0]
    monkeypatch.setattr(curl, "PLAYER_LIMITS", PlayerCurlLimiter(clock=lambda: now[0]))
    fetch = Mock(return_value="synthetic response")
    monkeypatch.setattr(curl, "fetch_public", fetch)
    alice = await make_user(session)
    bob = await make_user(session, username="bob")
    alice_headers = session_cookie(settings, alice)
    bob_headers = session_cookie(settings, bob)
    payload = {"url": "https://example.com/"}
    assert (await client.post("/api/cli/curl", json=payload)).status_code == 401
    assert fetch.call_count == 0
    for _ in range(10):
        response = await client.post("/api/cli/curl", json=payload, headers=alice_headers)
        assert response.status_code == 200
    # Neither a claimed ID in headers/query nor a different URL resets quota.
    rejected = await client.post(
        f"/api/cli/curl?user_id={bob.id}",
        json={"url": "https://different.example/"},
        headers={**alice_headers, "X-User-ID": str(bob.id)},
    )
    assert rejected.status_code == 429
    assert rejected.headers["Retry-After"] == "60"
    assert rejected.json() == {"detail": "curl: too many requests; try again shortly"}
    assert fetch.call_count == 10
    spoofed = await client.post(
        "/api/cli/curl", json={**payload, "user_id": bob.id}, headers=alice_headers,
    )
    assert spoofed.status_code == 422
    assert (await client.post("/api/cli/curl", json=payload, headers=bob_headers)).status_code == 200
    now[0] = 60
    assert (await client.post("/api/cli/curl", json=payload, headers=alice_headers)).status_code == 200
    assert fetch.call_count == 12


@pytest.mark.parametrize("interruption", ["cancel", "timeout"])
@pytest.mark.parametrize("worker_fails", [False, True])
async def test_interrupted_wait_keeps_slot_until_worker_exits(
    monkeypatch, interruption, worker_fails,
):
    now = [0.0]
    limits = PlayerCurlLimiter(clock=lambda: now[0])
    monkeypatch.setattr(curl, "PLAYER_LIMITS", limits)
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    finished = asyncio.Event()
    unblock = threading.Event()
    release = limits.release

    def release_and_notify(user_id):
        release(user_id)
        if user_id == 1:
            loop.call_soon_threadsafe(finished.set)

    monkeypatch.setattr(limits, "release", release_and_notify)

    def fetch(raw):
        if raw == "slow":
            loop.call_soon_threadsafe(started.set)
            assert unblock.wait(timeout=5), "worker was not released"
            if worker_fails:
                raise OSError("synthetic private transport detail")
        return "ok"

    monkeypatch.setattr(curl, "fetch_public", fetch)
    request = asyncio.create_task(curl.fetch_for_player("slow", 1))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        with pytest.raises(CurlQuotaExceeded):
            await curl.fetch_for_player("another", 1)
        assert await curl.fetch_for_player("independent", 2) == "ok"
        if interruption == "cancel":
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
        else:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(request, timeout=0.01)
        now[0] = 61  # Even an expired rate window cannot release a live worker.
        with pytest.raises(CurlQuotaExceeded):
            await curl.fetch_for_player("another", 1)
        assert limits._players[1].active == 1
    finally:
        unblock.set()
        await asyncio.wait_for(finished.wait(), timeout=2)
        await asyncio.gather(request, return_exceptions=True)
    assert await curl.fetch_for_player("recovered", 1) == "ok"


@pytest.mark.parametrize("interruption", ["cancel", "timeout"])
async def test_interrupted_queued_work_keeps_account_admission(monkeypatch, interruption):
    now = [0.0]
    limits = PlayerCurlLimiter(clock=lambda: now[0])
    monkeypatch.setattr(curl, "PLAYER_LIMITS", limits)
    fetch = Mock(return_value="synthetic queued response")
    monkeypatch.setattr(curl, "fetch_public", fetch)
    loop = asyncio.get_running_loop()
    blocker_started = asyncio.Event()
    submitted = asyncio.Event()
    unblock = threading.Event()
    futures = []
    request = None
    run_in_executor = loop.run_in_executor

    def block_executor():
        loop.call_soon_threadsafe(blocker_started.set)
        assert unblock.wait(timeout=5), "executor blocker was not released"

    # Do not replace the loop's default executor or occupy application workers.
    with ThreadPoolExecutor(max_workers=1) as pool:
        blocker = asyncio.wrap_future(pool.submit(block_executor))

        def submit(executor, function, *args):
            assert executor is None
            # Admission must happen before even a queued job is submitted.
            assert limits._players[1].active == 1
            future = run_in_executor(pool, function, *args)
            futures.append(future)
            submitted.set()
            return future

        monkeypatch.setattr(loop, "run_in_executor", submit)
        try:
            await asyncio.wait_for(blocker_started.wait(), timeout=2)
            request = asyncio.create_task(curl.fetch_for_player("queued", 1))
            await asyncio.wait_for(submitted.wait(), timeout=2)
            assert len(futures) == 1
            assert not futures[0].done()
            fetch.assert_not_called()
            with pytest.raises(CurlQuotaExceeded):
                await curl.fetch_for_player("another-before-interruption", 1)
            assert len(futures) == 1

            if interruption == "cancel":
                request.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await request
            else:
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(request, timeout=0.01)
            assert request.cancelled()
            now[0] = 61  # Expiring rate history must not free queued admission.
            with pytest.raises(CurlQuotaExceeded):
                await curl.fetch_for_player("another-after-interruption", 1)
            assert limits._players[1].active == 1
            assert len(futures) == 1  # Rejection must not enqueue more work.
            assert not futures[0].done()  # Nor cancel the queued worker future.
            assert not blocker.done()
            fetch.assert_not_called()
        finally:
            # Join the executor futures, not just the already-cancelled caller.
            # Release even when setup or an assertion fails.
            unblock.set()
            if request is not None and not request.done():
                request.cancel()
            await asyncio.wait_for(
                asyncio.gather(
                    blocker, *futures, *([request] if request is not None else []),
                    return_exceptions=True,
                ),
                timeout=3,
            )

        assert blocker.result() is None
        assert futures[0].result() == "synthetic queued response"
        fetch.assert_called_once_with("queued")
        assert limits._players[1].active == 0
        assert curl.PLAYER_LIMITS is limits
        assert await asyncio.wait_for(
            curl.fetch_for_player("recovered", 1), timeout=2,
        ) == "synthetic queued response"
        assert len(futures) == 2
        assert limits._players[1].active == 0
        assert fetch.call_count == 2
        fetch.assert_called_with("recovered")


@pytest.mark.parametrize("failure,status", [(ValueError, 400), (OSError, 502)])
async def test_worker_errors_release_slot_and_hide_details(
    client, session, settings, monkeypatch, failure, status,
):
    fetch = Mock(side_effect=failure("https://secret:credential@example.com/private response"))
    monkeypatch.setattr(curl, "fetch_public", fetch)
    headers = session_cookie(settings, await make_user(session))
    response = await client.post("/api/cli/curl", json={"url": "example.com"}, headers=headers)
    assert response.status_code == status
    assert "secret" not in response.text and "private" not in response.text
    fetch.side_effect = None
    fetch.return_value = "ok"
    assert (await client.post("/api/cli/curl", json={"url": "example.com"}, headers=headers)).status_code == 200


async def test_executor_submission_failure_releases_player(monkeypatch):
    loop = asyncio.get_running_loop()
    with monkeypatch.context() as patch:
        patch.setattr(loop, "run_in_executor", Mock(side_effect=RuntimeError("executor stopped")))
        with pytest.raises(RuntimeError):
            await curl.fetch_for_player("example.com", 1)
    assert curl.PLAYER_LIMITS._players[1].active == 0
    monkeypatch.setattr(curl, "fetch_public", Mock(return_value="ok"))
    assert await curl.fetch_for_player("example.com", 1) == "ok"


def test_global_slots_still_bound_public_fetches_but_not_offline_imds(monkeypatch):
    slots = threading.BoundedSemaphore(4)
    monkeypatch.setattr(curl, "SLOTS", slots)
    for _ in range(4):
        assert slots.acquire(blocking=False)
    with pytest.raises(ValueError, match="busy"):
        curl.fetch_public("https://example.com")
    assert "latest" in curl.fetch_public("169.254.169.254")
    socket.getaddrinfo.assert_not_called()
    for _ in range(4):
        slots.release()


def test_tls_uses_default_verification_and_original_host(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", Mock(return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
    ]))
    sock = Mock()
    monkeypatch.setattr(socket, "socket", Mock(return_value=sock))
    context = Mock()
    default_context = Mock(return_value=context)
    monkeypatch.setattr(curl.ssl, "create_default_context", default_context)
    conn = Mock()
    conn.getresponse.return_value.status = 200
    conn.getresponse.return_value.getheader.return_value = "identity"
    conn.getresponse.return_value.read.return_value = b"safe\x1b\x00output"
    monkeypatch.setattr(curl.http.client, "HTTPConnection", Mock(return_value=conn))
    assert curl.fetch_public("https://example.com/") == "safeoutput"
    sock.connect.assert_called_once_with(("93.184.216.34", 443))
    default_context.assert_called_once_with()
    context.wrap_socket.assert_called_once_with(sock, server_hostname="example.com")
    assert conn.sock is context.wrap_socket.return_value
    context.wrap_socket.return_value.close.assert_called_once()


@pytest.mark.parametrize("scheme", ["http", "https"])
async def test_worker_environment_excludes_parent_secrets_and_overrides(
    subprocess_workers, monkeypatch, tmp_path, scheme, capsys, caplog,
):
    # Only synthetic values, with no settings lookup or credential access.
    for name in (
        "DATABASE_URL", "SESSION_SECRET", "FLAG_HASH_SECRET",
        "OKTA_CLIENT_ID", "OKTA_CLIENT_SECRET", "OKTA_ISSUER",
        "SLACK_ACTIVITY_WEBHOOK_URL", "UNRECOGNIZED_FUTURE_SECRET",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "all_proxy", "no_proxy",
        "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
        "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "HOME",
    ):
        monkeypatch.setenv(name, str(tmp_path / "synthetic-nonexistent-override"))
    state = subprocess_workers
    state["mode"] = "environment"
    assert await curl.fetch_for_player(f"{scheme}://synthetic.example", 1) == "synthetic safe output"
    facts = json.loads(state["markers"][0].read_text())
    assert facts["minimal_environment"]
    assert facts["python_overrides_ignored"]
    assert facts["hostname_verification"]
    assert facts["certificate_verification"]
    assert facts["trusted_ca_count"] > 0
    assert_workers_reaped(state)
    assert curl.PLAYER_LIMITS._players[1].active == 0
    captured = capsys.readouterr()
    assert not captured.out and not captured.err and not caplog.text


@pytest.mark.parametrize("scheme", ["http", "https"])
async def test_worker_cannot_access_inheritable_parent_descriptor(
    subprocess_workers, scheme, capsys, caplog,
):
    # A pipe contains only synthetic bytes: no application files or sockets.
    read_fd, write_fd = os.pipe()
    probe_fd = None
    try:
        # Keep the probe away from descriptors reused during interpreter
        # startup. F_DUPFD (unlike F_DUPFD_CLOEXEC) permits exec inheritance.
        probe_fd = fcntl.fcntl(read_fd, fcntl.F_DUPFD, 256)
        os.set_inheritable(probe_fd, True)
        assert os.get_inheritable(probe_fd)
        os.set_blocking(probe_fd, False)
        payload = b"synthetic-parent-pipe"
        assert os.write(write_fd, payload) == len(payload)
        state = subprocess_workers
        state["mode"] = f"descriptor:{probe_fd}"
        # The fixture forwards production Popen kwargs unchanged: do not set
        # close_fds here, or the test would hide a production inheritance leak.
        assert await curl.fetch_for_player(
            f"{scheme}://synthetic.example", 1,
        ) == "synthetic safe output"
        assert len(state["children"]) == 1
        facts = json.loads(state["markers"][0].read_text())
        assert facts == {"descriptor_errno": errno.EBADF}
        assert state["children"][0].returncode == 0
        assert_workers_reaped(state)
        assert curl.PLAYER_LIMITS._players[1].active == 0
        # Closing descriptors in the worker must not close or consume ours.
        assert os.get_inheritable(probe_fd)
        assert os.read(probe_fd, len(payload)) == payload
        captured = capsys.readouterr()
        assert not captured.out and not captured.err and not caplog.text
    finally:
        if probe_fd is not None:
            os.close(probe_fd)
        os.close(read_fd)
        os.close(write_fd)


@pytest.mark.parametrize("stage", ["dns", "connect", "tls", "headers", "body", "cleanup"])
async def test_whole_worker_deadline_kills_stalled_stage_and_recovers(
    subprocess_workers, stage, caplog, capsys,
):
    state = subprocess_workers
    state["mode"] = stage
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="timed out"):
        await curl.fetch_for_player("https://synthetic.example/private-query", 1)
    assert state["markers"][0].exists(), "The child must actually reach the stalled stage"
    assert time.monotonic() - started < curl.WORKER_TIMEOUT + 2
    assert_workers_reaped(state)
    assert state["children"][0].returncode < 0  # Killed, not merely abandoned.
    assert curl.PLAYER_LIMITS._players[1].active == 0
    state["mode"] = "success"
    assert await curl.fetch_for_player("https://synthetic.example", 1) == "synthetic safe output"
    assert_workers_reaped(state)
    captured = capsys.readouterr()
    assert not captured.out and not captured.err and not caplog.text


async def test_all_stalled_dns_slots_recover_even_after_waiters_leave(subprocess_workers):
    state = subprocess_workers
    state["mode"] = "dns"
    requests = [
        asyncio.create_task(curl.fetch_for_player("https://synthetic.example", user_id))
        for user_id in range(1, 5)
    ]
    try:
        await wait_for_stalled_workers(state, 4)
        requests[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await requests[0]
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(requests[1], timeout=0.01)
        for user_id in (1, 2):
            with pytest.raises(CurlQuotaExceeded):
                await curl.fetch_for_player("https://synthetic.example", user_id)
        with pytest.raises(ValueError, match="busy"):
            await curl.fetch_for_player("https://synthetic.example", 5)
        # Offline IMDS never spawns a child, even with every network slot busy.
        assert "latest" in await curl.fetch_for_player("169.254.169.254", 6)
        assert len(state["children"]) == 4
        results = await asyncio.gather(*requests[2:], return_exceptions=True)
        assert all(isinstance(result, TimeoutError) for result in results)

        async def all_released():
            while any(curl.PLAYER_LIMITS._players[user_id].active for user_id in range(1, 5)):
                await asyncio.sleep(0.01)
        await asyncio.wait_for(all_released(), timeout=3)
        assert_workers_reaped(state)
        # All four global permits, not just one, are available again.
        for _ in range(4):
            assert curl.SLOTS.acquire(blocking=False)
        assert not curl.SLOTS.acquire(blocking=False)
        for _ in range(4):
            curl.SLOTS.release()
        state["mode"] = "success"
        for user_id in range(1, 6):
            assert await curl.fetch_for_player("https://synthetic.example", user_id) == "synthetic safe output"
        assert_workers_reaped(state)
    finally:
        await asyncio.gather(*requests, return_exceptions=True)


@pytest.mark.parametrize("mode,error", [
    ("dns-error", OSError), ("crash", OSError), ("malformed", OSError), ("mixed", ValueError),
])
async def test_child_failure_reaps_worker_and_releases_capacity(
    subprocess_workers, mode, error, capsys, caplog,
):
    state = subprocess_workers
    state["mode"] = mode
    with pytest.raises(error) as caught:
        await curl.fetch_for_player("https://synthetic.example/private-query", 1)
    assert "synthetic" not in str(caught.value) and "private" not in str(caught.value)
    assert_workers_reaped(state)
    assert curl.PLAYER_LIMITS._players[1].active == 0
    state["mode"] = "success"
    assert await curl.fetch_for_player("https://synthetic.example", 1) == "synthetic safe output"
    assert_workers_reaped(state)
    captured = capsys.readouterr()
    assert not captured.out and not captured.err and not caplog.text


async def test_repeated_child_failures_keep_parent_descriptors_stable(
    subprocess_workers, capsys, caplog,
):
    state = subprocess_workers
    url = "https://synthetic.example"

    def descriptor_count():
        # Count Linux procfs entry names only. Never follow descriptor symlinks,
        # open their targets, or inspect/read inherited application resources.
        # listdir closes its own directory descriptor before returning.
        return len(os.listdir("/proc/self/fd"))

    def assert_capacity_and_cleanup():
        # Keep Popen objects alive in state: GC must not hide missing cleanup.
        assert_workers_reaped(state)
        assert all(player.active == 0 for player in curl.PLAYER_LIMITS._players.values())
        acquired = 0
        try:
            for _ in range(4):
                assert curl.SLOTS.acquire(blocking=False)
                acquired += 1
            extra = curl.SLOTS.acquire(blocking=False)
            if extra:
                acquired += 1
            assert not extra
        finally:
            for _ in range(acquired):
                curl.SLOTS.release()

    # Warm up the executor and one full exec/IPC lifecycle before measuring.
    assert await curl.fetch_for_player(url, 0) == "synthetic safe output"
    assert_capacity_and_cleanup()
    baseline = descriptor_count()
    failures = (
        ("dns-error", OSError),
        ("crash", OSError),
        ("malformed", OSError),
        ("mixed", ValueError),
        ("body-error", OSError),
    )
    for cycle in range(3):
        # Ten admitted requests per account; use a new synthetic account each
        # cycle without resetting either limiter or waiting for its rate window.
        user_id = cycle + 1
        for mode, error in failures:
            for recovering in (False, True):
                state["mode"] = "success" if recovering else mode
                children_before = len(state["children"])
                if recovering:
                    assert await curl.fetch_for_player(url, user_id) == "synthetic safe output"
                else:
                    with pytest.raises(error):
                        await curl.fetch_for_player(url, user_id)
                assert len(state["children"]) == children_before + 1
                assert_capacity_and_cleanup()
                expected_exit = 7 if state["mode"] == "crash" else 0
                assert state["children"][-1].returncode == expected_exit
                assert descriptor_count() == baseline, (
                    f"Parent descriptor count changed: cycle={cycle}, mode={state['mode']}"
                )
    assert len(state["children"]) == 1 + 3 * 2 * len(failures)
    captured = capsys.readouterr()
    assert not captured.out and not captured.err and not caplog.text


@pytest.mark.parametrize("interruption,interrupt_at", [
    pytest.param(None, None, id="retained"),
    pytest.param("cancel", 0, id="cancel-before-kill"),
    pytest.param("timeout", 0, id="timeout-before-kill"),
    pytest.param("cancel", 1, id="cancel-before-reap"),
    pytest.param("timeout", 1, id="timeout-before-reap"),
])
async def test_parent_communicate_failure_reaps_worker_and_releases_both_limits(
    subprocess_workers, monkeypatch, capsys, caplog, interruption, interrupt_at,
):
    state = subprocess_workers
    url = "https://synthetic.example"
    launch = curl.subprocess.Popen
    failure = OSError("synthetic parent IPC failure")
    communicate = Mock()
    loop = asyncio.get_running_loop()
    cleanup_started = [asyncio.Event(), asyncio.Event()]
    cleanup_allowed = [threading.Event(), threading.Event()]
    cleanup_timeout = curl.WORKER_TIMEOUT + 5
    finished = asyncio.Event()
    release = curl.PLAYER_LIMITS.release

    def release_and_notify(user_id):
        release(user_id)
        if user_id == 1:
            loop.call_soon_threadsafe(finished.set)

    monkeypatch.setattr(curl.PLAYER_LIMITS, "release", release_and_notify)

    def launch_with_broken_communication(command, **kwargs):
        process = launch(command, **kwargs)
        kill, wait = process.kill, process.wait

        def gated_kill():
            loop.call_soon_threadsafe(cleanup_started[0].set)
            try:
                assert cleanup_allowed[0].wait(cleanup_timeout), "kill was not released"
            finally:
                kill()

        def gated_wait(*args, **kwargs):
            loop.call_soon_threadsafe(cleanup_started[1].set)
            try:
                assert cleanup_allowed[1].wait(cleanup_timeout), "wait was not released"
            finally:
                # Bound teardown too, including when a gate assertion fails.
                returncode = wait(timeout=cleanup_timeout)
            return returncode

        def fail_communication(input, *, timeout):
            assert json.loads(input) == url
            assert 0 < timeout <= curl.WORKER_TIMEOUT
            # A real exec child is alive but cannot finish: its stdin has not
            # received a request or EOF. Leave both pipes open so production
            # cleanup, not the injection or fixture teardown, must close them.
            assert process.poll() is None
            assert not process.stdin.closed and not process.stdout.closed
            assert curl.PLAYER_LIMITS._players[1].active == 1
            raise failure

        communicate.side_effect = fail_communication
        patch.setattr(process, "communicate", communicate)
        patch.setattr(process, "kill", gated_kill)
        patch.setattr(process, "wait", gated_wait)
        return process

    with monkeypatch.context() as patch:
        patch.setattr(curl.subprocess, "Popen", launch_with_broken_communication)
        request = asyncio.create_task(curl.fetch_for_player(url, 1))
        try:
            for stage, (started, allowed) in enumerate(zip(cleanup_started, cleanup_allowed)):
                await asyncio.wait_for(started.wait(), timeout=cleanup_timeout)
                if stage == interrupt_at:
                    assert not request.done()
                    if interruption == "cancel":
                        request.cancel()
                        with pytest.raises(asyncio.CancelledError):
                            await request
                    else:
                        with pytest.raises(TimeoutError):
                            await asyncio.wait_for(request, timeout=0.01)
                caller_left = interrupt_at is not None and stage >= interrupt_at
                assert request.done() == caller_left
                assert request.cancelled() == caller_left
                assert not finished.is_set()
                assert len(state["children"]) == 1
                process = state["children"][0]
                # Do not poll/waitpid here: that could reap the killed child
                # on behalf of production and hide an ordering regression.
                assert process.returncode is None
                assert not process.stdin.closed and not process.stdout.closed
                assert curl.PLAYER_LIMITS._players[1].active == 1
                with pytest.raises(CurlQuotaExceeded):
                    await asyncio.wait_for(curl.fetch_for_player(url, 1), timeout=2)

                acquired = 0
                try:
                    # Three permits remain usable; the fourth must belong to
                    # the failed worker until wait() actually reaps its child.
                    for _ in range(3):
                        assert curl.SLOTS.acquire(blocking=False)
                        acquired += 1
                    extra = curl.SLOTS.acquire(blocking=False)
                    if extra:
                        acquired += 1
                    assert not extra
                    with pytest.raises(ValueError, match="busy"):
                        await asyncio.wait_for(curl.fetch_for_player(url, 2), timeout=2)
                    assert curl.PLAYER_LIMITS._players[2].active == 0
                    assert len(state["children"]) == 1
                finally:
                    for _ in range(acquired):
                        curl.SLOTS.release()
                assert request.done() == caller_left
                assert not finished.is_set()
                allowed.set()
        finally:
            # Never strand an executor thread/child when an assertion fails.
            for allowed in cleanup_allowed:
                allowed.set()
            # A cancelled caller is already done; joining it alone would let
            # fixture teardown reap the child and hide a supervisor failure.
            await asyncio.wait_for(
                asyncio.gather(request, finished.wait(), return_exceptions=True),
                timeout=cleanup_timeout,
            )
        if interruption is None:
            with pytest.raises(OSError) as caught:
                await request
            assert caught.value is failure  # Not a child error or deadline expiry.
        else:
            assert request.cancelled()
    communicate.assert_called_once()
    assert len(state["children"]) == 1
    assert state["children"][0].returncode == -signal.SIGKILL
    assert_workers_reaped(state)
    assert curl.PLAYER_LIMITS._players[1].active == 0
    acquired = 0
    try:
        for _ in range(4):
            assert curl.SLOTS.acquire(blocking=False)
            acquired += 1
        extra = curl.SLOTS.acquire(blocking=False)
        if extra:
            acquired += 1
        assert not extra
    finally:
        for _ in range(acquired):
            curl.SLOTS.release()

    # Do not reset either limiter: the same account must recover normally.
    assert await curl.fetch_for_player(url, 1) == "synthetic safe output"
    assert len(state["children"]) == 2
    assert state["children"][1].returncode == 0
    assert_workers_reaped(state)
    assert curl.PLAYER_LIMITS._players[1].active == 0
    captured = capsys.readouterr()
    assert not captured.out and not captured.err and not caplog.text


async def test_process_start_failure_releases_both_limits(subprocess_workers, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(curl.subprocess, "Popen", Mock(side_effect=OSError("cannot start worker")))
        with pytest.raises(OSError):
            await curl.fetch_for_player("https://synthetic.example", 1)
    assert curl.PLAYER_LIMITS._players[1].active == 0
    for _ in range(4):
        assert curl.SLOTS.acquire(blocking=False)
    for _ in range(4):
        curl.SLOTS.release()
    assert await curl.fetch_for_player("https://synthetic.example", 1) == "synthetic safe output"
    assert_workers_reaped(subprocess_workers)


async def test_worker_deadline_route_error_is_sanitized_and_recovers(
    client, session, settings, subprocess_workers,
):
    headers = session_cookie(settings, await make_user(session))
    subprocess_workers["mode"] = "dns"
    response = await client.post(
        "/api/cli/curl", json={"url": "https://synthetic.example/private-query"}, headers=headers,
    )
    assert response.status_code == 502
    assert response.json() == {"detail": "curl: request failed or timed out"}
    assert_workers_reaped(subprocess_workers)
    subprocess_workers["mode"] = "success"
    response = await client.post(
        "/api/cli/curl", json={"url": "https://synthetic.example"}, headers=headers,
    )
    assert response.status_code == 200 and response.json()["output"] == "synthetic safe output"
    assert_workers_reaped(subprocess_workers)
