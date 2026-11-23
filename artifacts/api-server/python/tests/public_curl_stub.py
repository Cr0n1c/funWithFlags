"""Exec-only, fully offline harness for the real curl worker entry point."""

import json
import os
import socket
import ssl
import sys
import time
from pathlib import Path
from unittest.mock import Mock

from app import public_curl as curl
from app.public_curl_worker import main


def run():
    mode, marker = sys.argv[1:]

    if mode.startswith("descriptor:"):
        # Probe only the synthetic descriptor named by the parent. Do not
        # enumerate descriptors or read any inherited application resources.
        descriptor = int(mode.removeprefix("descriptor:"))
        try:
            os.fstat(descriptor)
        except OSError as exc:
            descriptor_errno = exc.errno
        else:
            descriptor_errno = None
        Path(marker).write_text(json.dumps({"descriptor_errno": descriptor_errno}))

    if mode == "environment":
        # Observe the fresh interpreter before replacing any TLS functions.
        # Record only fixed booleans/counts, never environment values.
        context = ssl.create_default_context()
        # OpenSSL loads a certificate directory lazily, so a store configured that way
        # reports no preloaded authorities even though verification works.
        capath = ssl.get_default_verify_paths().capath
        Path(marker).write_text(
            json.dumps(
                {
                    # CPython coerces the locale, macOS injects its text-encoding
                    # variable, and the Nix interpreter wrapper can add its own
                    # library paths. None may carry parent configuration.
                    "minimal_environment": (
                        set(os.environ)
                        <= {"LC_CTYPE", "LD_LIBRARY_PATH", "__CF_USER_TEXT_ENCODING"}
                        and all(
                            path.startswith("/nix/store/")
                            for path in os.environ.get("LD_LIBRARY_PATH", "").split(":")
                            if path
                        )
                    ),
                    "python_overrides_ignored": bool(sys.flags.ignore_environment),
                    "hostname_verification": context.check_hostname,
                    "certificate_verification": context.verify_mode == ssl.CERT_REQUIRED,
                    "trusted_ca_count": context.cert_store_stats()["x509_ca"],
                    "trusted_ca_directory": bool(
                        capath and os.path.isdir(capath) and any(os.scandir(capath))
                    ),
                }
            )
        )

    def stall(*args, **kwargs):
        Path(marker).touch()
        time.sleep(60)  # Parent must kill us; this never returns in a passing test.
        raise AssertionError("Stalled child survived")

    def resolve(*args, **kwargs):
        if mode == "dns":
            return stall()
        if mode == "dns-error":
            raise OSError("synthetic destination and private response detail")
        ips = ("93.184.216.34", "10.0.0.1") if mode == "mixed" else ("93.184.216.34",)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]

    # Patch in this new interpreter, before calling production worker code.
    # No path (including unexpected lookups/connections) reaches the network.
    socket.getaddrinfo = resolve  # ty: ignore[invalid-assignment]
    sock = Mock()
    socket.socket = Mock(return_value=sock)
    context = Mock()
    context.wrap_socket.return_value = sock
    curl.ssl.create_default_context = Mock(return_value=context)
    response = Mock(status=200)
    response.getheader.return_value = "identity"
    response.read.return_value = b"synthetic safe\x1b output"
    conn = Mock()
    conn.getresponse.return_value = response
    curl.http.client.HTTPConnection = Mock(return_value=conn)
    stages = {
        "connect": sock.connect,
        "tls": context.wrap_socket,
        "headers": conn.getresponse,
        "body": response.read,
        "cleanup": conn.close,
    }
    if mode in stages:
        stages[mode].side_effect = stall
    if mode == "body-error":
        response.read.side_effect = OSError("synthetic response body failure")
    if mode == "crash":
        os._exit(7)
    if mode == "malformed":
        sys.stdout.write("not a result")
        return
    main()


if __name__ == "__main__":
    run()
