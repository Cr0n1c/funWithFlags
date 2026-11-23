"""Process-local curl admission, keyed only by authenticated database account ID."""

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field


class CurlQuotaExceeded(Exception):
    def __init__(self, retry_after: int):
        super().__init__("curl quota exceeded")
        self.retry_after = retry_after


@dataclass
class _Player:
    starts: deque[float] = field(default_factory=deque)
    active: int = 0


class PlayerCurlLimiter:
    """Bound both request volume and bookkeeping without evicting live quotas.

    Like the public transport's four slots, this limit is per API process, not
    a distributed quota. No URLs, profile fields, or response data are retained.
    """

    def __init__(self, *, per_minute=10, concurrent=1, max_players=4096, clock=time.monotonic):
        self.per_minute = per_minute
        self.concurrent = concurrent
        self.max_players = max_players
        self.clock = clock
        self._players: dict[int, _Player] = {}
        self._lock = threading.Lock()

    def acquire(self, user_id: int) -> None:
        with self._lock:
            now = self.clock()
            # Bound memory even across account churn. Never discard a running
            # request or an unexpired quota merely to admit a different player.
            for key, player in list(self._players.items()):
                while player.starts and player.starts[0] <= now - 60:
                    player.starts.popleft()
                if not player.starts and not player.active:
                    del self._players[key]
            player = self._players.get(user_id)
            if player is None:
                if len(self._players) >= self.max_players:
                    raise CurlQuotaExceeded(1)
                player = self._players[user_id] = _Player()
            if len(player.starts) >= self.per_minute:
                raise CurlQuotaExceeded(max(1, math.ceil(player.starts[0] + 60 - now)))
            if player.active >= self.concurrent:
                raise CurlQuotaExceeded(1)
            player.starts.append(now)
            player.active += 1

    def release(self, user_id: int) -> None:
        with self._lock:
            self._players[user_id].active -= 1
