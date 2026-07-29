"""One-time jobs-prospect flagging pass over classified activity — dry-run first.

Uses the SAME predicate as the (widened) nightly auto_flag_jobs_prospects —
any staff-authored activity classified 'jobs' flags its external participants
— via that function's dry_run mode, so preview and execute can't drift apart.

Dry run (default): writes a preview CSV of every contact that WOULD be
flagged, with evidence (# jobs activities, latest date), and changes nothing.
--execute: writes a backup CSV of the contact IDs it is about to flip, then
runs the real UPDATE. The flag is reversible from the backup
(is_jobs_contact=false for those IDs).

Run from financial_forecasting/:
    python -m scripts.flag_jobs_prospects_backfill                       # dry run
    python -m scripts.flag_jobs_prospects_backfill --out ~/Desktop/x.csv
    python -m scripts.flag_jobs_prospects_backfill --execute
"""
import argparse
import asyncio
import csv
import logging
import os
import sys
from datetime import date

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

load_dotenv()

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('flag_jobs_prospects_backfill')

import asyncpg
from services.jobs_activity_link import auto_flag_jobs_prospects

FIELDS = ['contact_id', 'full_name', 'email', 'current_company',
          'jobs_activities', 'last_jobs_activity']


def _write_csv(path: str, rows: list[dict]) -> None:
    path = os.path.expanduser(path)
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k) for k in FIELDS})
    logger.info("wrote %d rows to %s", len(rows), path)


async def main(args) -> None:
    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        logger.error("DATABASE_URL not set")
        sys.exit(1)
    conn = await asyncpg.connect(db_url)
    try:
        preview = await auto_flag_jobs_prospects(conn, dry_run=True)
        rows = preview['rows']
        logger.info("%d contacts would be flagged as jobs prospects", len(rows))
        out = args.out or os.path.expanduser(
            f"~/Desktop/jobs_prospect_flag_{'backup' if args.execute else 'preview'}_{date.today()}.csv"
        )
        _write_csv(out, rows)

        if not args.execute:
            logger.info("dry run — nothing changed. Review the CSV, then re-run with --execute.")
            return

        result = await auto_flag_jobs_prospects(conn)
        logger.info("EXECUTED — flagged %d contacts (backup of the flipped set: %s)",
                    result.get('flagged', 0), out)
    finally:
        await conn.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--execute', action='store_true',
                    help='Actually flip is_jobs_contact (default: dry run)')
    ap.add_argument('--out', default=None,
                    help='CSV path (default ~/Desktop/jobs_prospect_flag_*_<date>.csv)')
    asyncio.run(main(ap.parse_args()))
