"""Backfill thread recency + message-index flags after
migrations/2026-10-20-activity-email-thread-latest.sql.

1. bedrock.activity.last_message_at / last_message_from / message_count for
   every gmail-sync thread, computed from its stored email_messages with the
   same function the sync uses (services.gmail_sync.summarize_thread_messages),
   so backfilled and freshly-synced rows follow identical rules. Rows the sync
   already filled are left alone, unless --all (use once after deploying the
   new sync: threads that grew while the old code ran have stale values).
2. bedrock.activity_email_message.is_automated (and recipients, where the
   stored thread has them) via a full refresh_email_message_index pass.

Messages synced before recipients were stored keep recipient_emails NULL; the
nightly sync fills them as threads are re-synced, and readers fall back to
thread-level matching until then. Idempotent — safe to re-run.

Connects with PG_* superuser creds when set (like scripts/apply_sql.py),
otherwise DATABASE_URL:

    python -m scripts.backfill_email_thread_latest [--env path/to/.env] [--dry-run] [--all]
"""
import argparse
import asyncio
import json
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BATCH = 2000


def _dsn() -> str:
    if os.getenv("PG_USER") and os.getenv("PG_PASSWORD") and os.getenv("PG_HOST"):
        return (
            f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}"
            f"@{os.environ['PG_HOST']}:{os.getenv('PG_PORT', '5432')}/{os.environ['PG_DATABASE']}"
        )
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        sys.exit("ERROR: set PG_* superuser vars or DATABASE_URL (or pass --env)")
    return dsn


async def main(dry_run: bool, recompute_all: bool) -> None:
    import asyncpg

    from services.email_message_index import refresh_email_message_index
    from services.gmail_sync import summarize_thread_messages

    conn = await asyncpg.connect(_dsn(), timeout=60)
    try:
        last_id = None
        scanned = updated = 0
        while True:
            # Bodies stripped server-side — only headers are needed here.
            rows = await conn.fetch(
                """
                SELECT a.id,
                       (SELECT jsonb_agg(m - 'body_text')
                        FROM jsonb_array_elements(a.email_messages) m) AS msgs
                FROM bedrock.activity a
                WHERE a.source = 'gmail-sync'
                  AND a.email_messages IS NOT NULL
                  AND ($3 OR a.last_message_at IS NULL)
                  AND ($1::uuid IS NULL OR a.id > $1)
                ORDER BY a.id
                LIMIT $2
                """,
                last_id, BATCH, recompute_all,
            )
            if not rows:
                break
            last_id = rows[-1]["id"]
            scanned += len(rows)

            ids, ats, froms, counts = [], [], [], []
            for r in rows:
                raw = r["msgs"]
                msgs = json.loads(raw) if isinstance(raw, str) else (raw or [])
                summary = summarize_thread_messages(msgs or [])
                if summary["last_message_at"] is None:
                    continue
                ids.append(r["id"])
                ats.append(summary["last_message_at"])
                froms.append(summary["last_message_from"])
                counts.append(summary["message_count"])

            if ids and not dry_run:
                result = await conn.execute(
                    """
                    UPDATE bedrock.activity a SET
                        last_message_at   = t.at,
                        last_message_from = t.frm,
                        message_count     = t.n
                    FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::int[])
                         AS t(id, at, frm, n)
                    WHERE a.id = t.id AND ($5 OR a.last_message_at IS NULL)
                    """,
                    ids, ats, froms, counts, recompute_all,
                )
                updated += int(result.split()[-1])
            elif ids:
                updated += len(ids)
            print(f"  threads scanned={scanned} updated={updated}", flush=True)

        print(f"activity recency: scanned={scanned} updated={updated}{' (dry run)' if dry_run else ''}")

        if not dry_run:
            idx = await refresh_email_message_index(conn, days_back=None)
            print(f"message index: {idx}")
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", help="path to a .env with PG_* superuser creds or DATABASE_URL")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all", action="store_true", help="recompute rows the sync already filled")
    args = ap.parse_args()
    if args.env:
        load_dotenv(args.env, override=True)
    else:
        load_dotenv()
    asyncio.run(main(args.dry_run, args.all))
