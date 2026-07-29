"""Chunked historical Gmail backfill for enabled sync_staff mailboxes.

Walks calendar-year windows (oldest first) per mailbox via
sync_gmail_for_staff(override_since=…, override_until=…) — backfill mode, so
the per-mailbox watermark is neither read nor written and the nightly
incremental sync is unaffected. Progress is checkpointed per (mailbox, year)
to a local JSON state file: an interrupted run resumes at the first
unfinished chunk instead of re-paginating everything. Re-running a completed
chunk is safe (idempotent upserts) — just wasted Gmail API calls.

After the mailbox sweep it (unless skipped):
  1. classifies all newly-landed rows for jobs relevance, in batches, locally
     — so the nightly Cloud Run sync never faces the whole historical corpus
     inside its 2-hour window;
  2. refreshes bedrock.activity_email_message over the FULL history
     (days_back=None) so per-message metrics see the new threads.

It does NOT flag jobs prospects — that is a deliberate, human-reviewed step:
scripts/flag_jobs_prospects_backfill.py (dry-run first).

Run from financial_forecasting/ (needs DATABASE_URL + GOOGLE_SERVICE_ACCOUNT_JSON;
classification also needs ANTHROPIC_API_KEY):
    python -m scripts.historical_email_backfill                  # 2011→2023
    python -m scripts.historical_email_backfill --from-year 2015 --to-year 2020
    python -m scripts.historical_email_backfill --staff jukay@pursuit.org
    python -m scripts.historical_email_backfill --skip-classify --skip-index
"""
import argparse
import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
logger = logging.getLogger('historical_email_backfill')

import asyncpg
from services.gmail_sync import sync_gmail_for_staff
from services.google_dwd import is_dwd_configured

DEFAULT_STATE_FILE = '.email_backfill_state.json'


def _load_state(path: str) -> dict:
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


class State:
    """Checkpoint file — {email: {year: {upserted, errors, done_at}}}.

    Single-process; the lock serializes saves across mailbox tasks.
    """

    def __init__(self, path: str):
        self.path = path
        self.data = _load_state(path)
        self._lock = asyncio.Lock()

    def is_done(self, email: str, year: int) -> bool:
        return 'done_at' in self.data.get(email, {}).get(str(year), {})

    async def mark(self, email: str, year: int, result: dict) -> None:
        async with self._lock:
            self.data.setdefault(email, {})[str(year)] = result
            tmp = self.path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(self.data, f, indent=1, sort_keys=True)
            os.replace(tmp, self.path)


async def backfill_one_staff(
    pool, sem: asyncio.Semaphore, state: State,
    email: str, from_year: int, to_year: int,
) -> dict:
    """Backfill one mailbox, oldest year first. Returns summary dict."""
    async with sem:
        summary = {'email': email, 'upserted': 0, 'errors': 0, 'skipped_chunks': 0}
        for year in range(from_year, to_year + 1):
            if state.is_done(email, year):
                summary['skipped_chunks'] += 1
                continue
            since = datetime(year, 1, 1, tzinfo=timezone.utc)
            until = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
            t0 = time.monotonic()
            try:
                async with pool.acquire() as conn:
                    res = await sync_gmail_for_staff(
                        conn, email, override_since=since, override_until=until,
                    )
            except Exception as e:
                # Impersonation failures (deleted/suspended-without-access
                # mailbox) fail every chunk the same way — record once and
                # move on to the next mailbox rather than burning 13 attempts.
                logger.error("chunk FAIL %s %d: %r", email, year, e)
                await state.mark(email, year, {'error': repr(e)})
                summary['errors'] += 1
                if year == from_year:
                    summary['mailbox_error'] = repr(e)
                    logger.error("first chunk failed for %s — skipping mailbox "
                                 "(likely inaccessible account)", email)
                    return summary
                continue
            secs = round(time.monotonic() - t0, 1)
            upserted = res.get('upserted', 0)
            errors = res.get('errors', 0)
            await state.mark(email, year, {
                'upserted': upserted, 'errors': errors,
                'done_at': datetime.now(timezone.utc).isoformat(),
            })
            summary['upserted'] += upserted
            summary['errors'] += errors
            logger.info("done %s %d: upserted=%d errors=%d in %ss",
                        email, year, upserted, errors, secs)
        return summary


async def classify_all_new(pool, batch: int = 500) -> int:
    """Classify every unclassified activity row, in batches, until none remain."""
    from services.activity_classifier import classify_new_activity
    total = 0
    while True:
        async with pool.acquire() as conn:
            res = await classify_new_activity(conn, limit=batch)
        n = res.get('classified', 0)
        if res.get('error'):
            logger.error("classification aborted: %s", res['error'])
            break
        total += n
        logger.info("classification progress: %d rows so far (%s)", total, res.get('counts', {}))
        if n == 0:
            break
    return total


async def main(args) -> None:
    if not is_dwd_configured():
        logger.error("GOOGLE_SERVICE_ACCOUNT_JSON not set — aborting")
        sys.exit(1)
    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        logger.error("DATABASE_URL not set")
        sys.exit(1)

    state = State(args.state_file)
    pool = await asyncpg.create_pool(db_url, min_size=2, max_size=max(args.concurrency + 3, 4))
    try:
        if args.staff:
            staff = args.staff
        else:
            rows = await pool.fetch(
                "SELECT email FROM bedrock.sync_staff WHERE enabled = true ORDER BY email"
            )
            staff = [r['email'] for r in rows]
        logger.info("backfilling %d mailboxes, years %d-%d, concurrency=%d, state=%s",
                    len(staff), args.from_year, args.to_year, args.concurrency,
                    args.state_file)

        sem = asyncio.Semaphore(args.concurrency)
        t0 = time.monotonic()
        results = await asyncio.gather(
            *(backfill_one_staff(pool, sem, state, e, args.from_year, args.to_year)
              for e in staff),
        )
        elapsed = round(time.monotonic() - t0, 1)
        total_upserted = sum(r['upserted'] for r in results)
        total_errors = sum(r['errors'] for r in results)
        dead = [r['email'] for r in results if r.get('mailbox_error')]
        logger.info("SWEEP DONE — %d mailboxes in %ss · upserted=%d · errors=%d",
                    len(results), elapsed, total_upserted, total_errors)
        if dead:
            logger.warning("inaccessible mailboxes (skipped): %s", ", ".join(dead))

        if not args.skip_classify:
            logger.info("classifying new rows for jobs relevance…")
            classified = await classify_all_new(pool)
            logger.info("classification done: %d rows", classified)
        if not args.skip_index:
            from services.email_message_index import refresh_email_message_index
            logger.info("refreshing per-message index over full history…")
            async with pool.acquire() as conn:
                idx = await refresh_email_message_index(conn, days_back=None)
            logger.info("message index refresh: %s", idx)
    finally:
        await pool.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--from-year', type=int, default=2011,
                    help='First calendar year to pull (default 2011)')
    ap.add_argument('--to-year', type=int, default=2023,
                    help='Last calendar year to pull, inclusive (default 2023 — '
                         '2024+ is already covered by the incremental sync)')
    ap.add_argument('--concurrency', type=int, default=4,
                    help='Max concurrent mailboxes (default 4)')
    ap.add_argument('--staff', action='append', default=None,
                    help='Restrict to specific mailbox(es); repeatable')
    ap.add_argument('--state-file', default=DEFAULT_STATE_FILE,
                    help=f'Checkpoint JSON path (default {DEFAULT_STATE_FILE})')
    ap.add_argument('--skip-classify', action='store_true',
                    help='Skip the jobs-relevance classification stage')
    ap.add_argument('--skip-index', action='store_true',
                    help='Skip the per-message index refresh stage')
    asyncio.run(main(ap.parse_args()))
