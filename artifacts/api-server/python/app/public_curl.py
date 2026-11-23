"""Bounded public HTTP GET. IMDS is a constant fixture, never a network target."""

import asyncio
import http.client
import ipaddress
import json
import socket
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from app.curl_limits import PlayerCurlLimiter
from app.imds_fixture import metadata_response

FLAG = "always_check_ssrf_imdsv1"
PUZZLE = (
    "curl-metadata",
    "Find the built in command that is SSRF by design",
    "A server can make requests on your behalf. Explore curl and consider "
    "where an instance might learn about itself. OWASP A10:2021 SSRF.",
    FLAG,
    125,
)
SLOTS = threading.BoundedSemaphore(4)
PLAYER_LIMITS = PlayerCurlLimiter()
MAX_CHARS = 500
# Enough UTF-8 bytes for 500 Unicode characters, without downloading the site.
MAX_BYTES = MAX_CHARS * 4
# Covers interpreter startup, DNS, connect, TLS, headers, body and cleanup.
# Keep below the route's 12-second wait; cancellation still retains admission.
WORKER_TIMEOUT = 8


async def fetch_for_player(raw: str, user_id: int) -> str:
    # Admit before submitting to the executor, so one player cannot fill its
    # queue. The router supplies the immutable ID from CurrentUser.
    limiter = PLAYER_LIMITS
    limiter.acquire(user_id)

    def run():
        try:
            return fetch_public(raw)
        finally:
            # Cancelling an await cannot stop synchronous DNS/socket work.
            # Only the actual worker's exit releases the player's slot.
            limiter.release(user_id)

    try:
        future = asyncio.get_running_loop().run_in_executor(None, run)
    except BaseException:
        limiter.release(user_id)
        raise
    # Retrieve late exceptions after route timeout/disconnect without logging
    # any destination or transport exception (which could contain secrets).
    future.add_done_callback(lambda done: None if done.cancelled() else done.exception())
    return await asyncio.shield(future)


def public_address(value):
    ip = ipaddress.ip_address(value)
    # Disallow transition/mapped IPv6 too: some embed non-public IPv4 targets.
    return (
        ip.is_global
        and not ip.is_multicast
        and not (
            isinstance(ip, ipaddress.IPv6Address)
            and (
                ip.ipv4_mapped
                or ip.sixtofour
                or ip.teredo
                or ip in ipaddress.ip_network("64:ff9b::/96")
                or ip in ipaddress.ip_network("64:ff9b:1::/48")
            )
        )
    )


def _parse_url(raw):
    if len(raw) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in raw) or "\\" in raw:
        raise ValueError("Invalid URL")
    url = urlsplit(raw if "://" in raw else "http://" + raw)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username is not None
        or url.password is not None
    ):
        raise ValueError("Only HTTP(S) URLs without credentials are supported")
    host = url.hostname.encode("idna").decode("ascii")
    port = url.port or (443 if url.scheme == "https" else 80)
    if port != (443 if url.scheme == "https" else 80) or "%" in host:
        raise ValueError("Only default HTTP(S) ports are supported")
    return url, host, port


def fetch_public(raw):
    url, host, _ = _parse_url(raw)
    if host == "169.254.169.254":
        return metadata_response(url.path, FLAG)[:MAX_CHARS]
    if not SLOTS.acquire(blocking=False):
        raise ValueError("curl is busy; try again shortly")
    try:
        return _run_worker(raw)
    finally:
        # _run_worker reaps its child before returning/raising. Never make
        # capacity available while a resolver or transport is still running.
        SLOTS.release()


def _run_worker(raw):
    """Supervise a disposable interpreter, not a cancellable thread/future.

    Popen execs a fresh interpreter, avoiding fork-inherited Python locks from
    the threaded API. No destination appears in argv, stderr or server logs.
    """
    deadline = time.monotonic() + WORKER_TIMEOUT
    process = subprocess.Popen(
        [sys.executable, "-E", "-m", "app.public_curl_worker"],
        cwd=Path(__file__).resolve().parent.parent,
        # Use this interpreter and its system CA store, not API credentials,
        # proxies, Python overrides, or parent-supplied TLS trust overrides.
        env={},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        try:
            output, _ = process.communicate(
                json.dumps(raw).encode("utf-8"),
                timeout=max(0, deadline - time.monotonic()),
            )
        except subprocess.TimeoutExpired:
            raise TimeoutError("curl worker timed out") from None
        if process.returncode != 0:
            raise OSError("curl worker failed")
        try:
            result = json.loads(output)
        except (UnicodeError, json.JSONDecodeError):
            raise OSError("curl worker failed") from None
        if not isinstance(result, dict):
            raise OSError("curl worker failed")
        if result.get("status") == "invalid":
            raise ValueError("curl request blocked or invalid")
        if result.get("status") != "ok":
            raise OSError("curl request failed")
        text = result.get("output")
        if not isinstance(text, str) or len(text) > MAX_CHARS:
            raise OSError("curl worker failed")
        return text
    finally:
        # SIGKILL stops even a stuck libc resolver or TLS operation. wait()
        # reaps the child; closing pipes also covers interrupted communicate.
        try:
            if process.poll() is None:
                process.kill()
            process.wait()
        finally:
            for pipe in (process.stdin, process.stdout):
                if pipe is not None:
                    pipe.close()


def _fetch_transport(url, host, port):
    """Child-only network work; the parent enforces the whole-job deadline."""
    conn = None
    sock = None
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or any(not public_address(a[4][0]) for a in addresses):
            raise ValueError("Only public internet destinations are allowed")
        # Connect directly to a validated sockaddr: no second DNS lookup,
        # no proxy environment variables, no redirects, no forwarded cookies.
        family, kind, proto, _, address = addresses[0]
        sock = socket.socket(family, kind, proto)
        sock.settimeout(5)
        sock.connect(address)
        if url.scheme == "https":
            context = ssl.create_default_context()
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            sock = context.wrap_socket(sock, server_hostname=host)
        conn = http.client.HTTPConnection(host, port, timeout=5)
        conn.sock = sock
        path = (url.path or "/") + ("?" + url.query if url.query else "")
        conn.request(
            "GET", path, headers={"Accept-Encoding": "identity", "User-Agent": "CTF-curl/1.0"}
        )
        response = conn.getresponse()
        if 300 <= response.status < 400:
            raise ValueError("Redirects are not followed; request the public destination directly")
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            raise ValueError("Compressed responses are not supported")
        data = response.read(MAX_BYTES)
        text = data.decode("utf-8", errors="replace")[:MAX_CHARS]
        # Never pass remote ANSI/terminal control sequences to the terminal.
        return "".join(
            c for c in text if c in "\n\t" or (ord(c) >= 32 and not 127 <= ord(c) <= 159)
        )
    finally:
        try:
            if conn:
                conn.close()
        finally:
            if sock:
                sock.close()
