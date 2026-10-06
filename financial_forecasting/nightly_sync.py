"""Nightly interaction-sync entrypoint — for a Cloud Run Job (separate from the
web app). Runs the full pipeline server-side: Gmail (sent+inbox) + Calendar sync
per staff (incremental via each staff member's watermark), domain enrichment,
activity→prospect relink, auto-flag, and the candidate pipeline (link-or-queue
new counterparties). Exits 0 on success, non-zero on failure.

Env required: DATABASE_URL, GOOGLE_SERVICE_ACCOUNT_JSON, ANTHROPIC_API_KEY.
Optional: SYNC_SINCE_DAYS (force a historical backfill window instead of the
incremental watermark — used for the first multi-year capture, then unset).
Optional: SYNC_STAFF_EMAILS (comma-separated — restrict the run to these staff,
for chunked backfills that would blow the task timeout run all-at-once).
"""
import asyncio
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("nightly_sync")


async def main() -> int:
    from services.interaction_sync import run_interaction_sync, sync_pool

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL not set"); return 2

    since_days = os.environ.get("SYNC_SINCE_DAYS")
    since_days = int(since_days) if since_days and since_days.isdigit() else None
    staff_emails = [e.strip().lower() for e in os.environ.get("SYNC_STAFF_EMAILS", "").split(",") if e.strip()] or None
    if staff_emails:
        logger.info("restricted to %d staff: %s", len(staff_emails), staff_emails)

    async with sync_pool() as pool:
        summary = await run_interaction_sync(pool, since_days=since_days, staff_emails=staff_emails)
        logger.info("nightly sync complete: %s", summary)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
