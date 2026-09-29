"""Prunes bedrock.notification rows older than the retention window.

Product decision (2026-09-23): notifications aren't kept past 2 weeks —
there's no bell/history use case for anything older, so we hard-delete
rather than just hiding them behind a query filter (routes/notifications.py
also filters by the same window as defense-in-depth against a stalled
cleanup cycle).

Runs on a fixed interval inside the backend's asyncio loop, same shape as
sf_notification_poller.py/intro_notification_poller.py. Postgres-only —
starts unconditionally regardless of which external services connected.
"""

from __future__ import annotations

import asyncio
import logging
import os

from dependencies import _services

logger = logging.getLogger(__name__)

RETENTION_DAYS = 14
POLL_INTERVAL_SEC = int(os.environ.get("NOTIF_CLEANUP_INTERVAL_SEC", "3600"))


async def run_forever() -> None:
    """Top-level entry — sleep-loop calling cleanup_once. Used by main.py's
    startup hook so the job lives inside the backend process."""
    import random
    await asyncio.sleep(random.uniform(5, 30))
    while True:
        try:
            deleted = await asyncio.wait_for(cleanup_once(), timeout=60.0)
            if deleted:
                logger.info("notification_cleanup: deleted %d row(s) older than %dd", deleted, RETENTION_DAYS)
        except asyncio.TimeoutError:
            logger.error("notification_cleanup: cleanup_once timed out after 60s — skipping cycle")
        except Exception as e:
            logger.exception(f"notification_cleanup crashed mid-cycle: {e}")
        await asyncio.sleep(POLL_INTERVAL_SEC)


async def cleanup_once() -> int:
    """Delete notification rows older than RETENTION_DAYS. Returns the
    number of rows deleted. Skips cleanly when db_pool isn't available."""
    pool = _services.get("db_pool")
    if not pool:
        logger.debug("cleanup_once: no db_pool")
        return 0
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM bedrock.notification "
            "WHERE created_at < now() - make_interval(days => $1)",
            RETENTION_DAYS,
        )
    try:
        return int(result.rsplit(" ", 1)[-1])
    except Exception:
        return 0
