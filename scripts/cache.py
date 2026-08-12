"""Small on-disk TTL cache.

Every X request spends part of a rate-limit budget that, once exhausted, locks
the burner out for ~15 minutes. Repeats are common in practice - the same
project resolved for many users, the same card reloaded - so anything we have
already paid for gets reused until it goes stale.

One file per entry rather than one file per namespace: concurrent requests each
write their own key instead of racing over a shared dict.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".cache"

# Project accounts almost never change their avatar; results go stale quickly
TTL_PROJECT = 30 * 24 * 3600
TTL_IMPRESSIONS = 15 * 60


def _path(namespace: str, key: str) -> Path:
    digest = hashlib.sha1(key.lower().encode()).hexdigest()[:16]
    return CACHE_DIR / namespace / f"{digest}.json"


def get(namespace: str, key: str, ttl: int) -> Any | None:
    path = _path(namespace, key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    if time.time() - payload.get("stored", 0) > ttl:
        return None
    return payload.get("value")


def set(namespace: str, key: str, value: Any) -> None:
    path = _path(namespace, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"stored": time.time(), "key": key, "value": value}),
            encoding="utf-8",
        )
    except OSError:
        pass  # a cache we cannot persist is not worth failing the run over
