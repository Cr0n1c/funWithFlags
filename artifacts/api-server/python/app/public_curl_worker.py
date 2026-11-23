"""Private one-shot curl worker. Only fixed error codes cross the pipe."""

import json
import sys

from app.public_curl import _fetch_transport, _parse_url


def main():
    try:
        # The parent validates first. Bound and validate again at this boundary.
        raw = json.loads(sys.stdin.buffer.read(16384))
        if not isinstance(raw, str):
            raise ValueError
        result = {"status": "ok", "output": _fetch_transport(*_parse_url(raw))}
    except ValueError:
        result = {"status": "invalid"}
    except Exception:
        # Never serialize exception messages, destinations or response content.
        result = {"status": "failed"}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
