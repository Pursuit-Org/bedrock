"""Thread-safe in-memory TTL cache for server-side response caching."""

import threading
import time
from typing import Any, Dict


class TTLCache:
    """Thread-safe in-memory cache with per-key TTL."""

    def __init__(self):
        self._store: Dict[str, Any] = {}
        self._expiry: Dict[str, float] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Any:
        with self._lock:
            if key in self._store and time.time() < self._expiry.get(key, 0):
                return self._store[key]
            # Expired or missing
            self._store.pop(key, None)
            self._expiry.pop(key, None)
            return None

    def set(self, key: str, value: Any, ttl_seconds: int = 300):
        with self._lock:
            self._store[key] = value
            self._expiry[key] = time.time() + ttl_seconds

    def invalidate(self, key: str):
        with self._lock:
            self._store.pop(key, None)
            self._expiry.pop(key, None)

    def invalidate_prefix(self, prefix: str):
        with self._lock:
            keys_to_remove = [k for k in self._store if k.startswith(prefix)]
            for k in keys_to_remove:
                self._store.pop(k, None)
                self._expiry.pop(k, None)

    def clear(self):
        with self._lock:
            self._store.clear()
            self._expiry.clear()


# Singleton cache instance
cache = TTLCache()

# Cache TTLs (seconds)
CACHE_TTL_OPPORTUNITIES = 300   # 5 minutes
CACHE_TTL_STAGE_HISTORY = 300   # 5 minutes
CACHE_TTL_ACCOUNTS = 600        # 10 minutes
CACHE_TTL_USERS = 900           # 15 minutes
CACHE_TTL_CASHFLOW = 600        # 10 minutes
CACHE_TTL_REVENUE_SNAPSHOT = 60  # 1 minute — this panel is pitched as SF-live;
                                 # 10 min (CACHE_TTL_CASHFLOW) made edits in SF
                                 # look like they weren't taking effect.
