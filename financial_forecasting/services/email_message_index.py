"""Explode gmail-sync threads into bedrock.activity_email_message rows.

bedrock.activity is one row per Gmail THREAD, dated/attributed to the thread's
first message — which makes weekly send metrics blind to replies and follow-ups
(they update the thread row but never create a new dated send). This index
gives metrics a per-MESSAGE view: (activity_id, from_email, sent_at).

Idempotent: ON CONFLICT DO NOTHING against the (activity, message) identity.
Run with days_back=None once to backfill, then nightly with a small window —
threads whose email_messages grew get re-exploded because updates bump
activity.synced_at.
"""

import json
import logging
import re
from email.utils import parsedate_to_datetime
from datetime import timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

_ADDR_RE = re.compile(r"<([^>]+)>")


def _parse_from(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    m = _ADDR_RE.search(raw)
    addr = (m.group(1) if m else raw).strip().lower()
    return addr if "@" in addr else None


def _parse_date(raw: Optional[str]):
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
    except Exception:
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


async def refresh_email_message_index(conn, days_back: Optional[int] = None) -> dict[str, Any]:
    """Insert missing per-message rows for gmail-sync activity.

    days_back bounds the scan to recently-synced threads (nightly incremental);
    None scans everything (backfill).
    """
    bound = ""
    params: list = []
    if days_back is not None:
        bound = "AND a.synced_at >= now() - ($2 || ' days')::interval"
        params = [str(days_back)]

    # Keyset-paginate over activity ids: email_messages carries full message
    # bodies, so fetching every thread at once holds the whole corpus in
    # memory (OOM-killed the 1Gi Cloud Run Job on the first full-history
    # pass after the 15-year backfill). Process a bounded batch at a time.
    BATCH_THREADS = 1000
    scanned = 0
    messages_seen = 0
    inserted = 0
    bad = 0
    last_id = None

    while True:
        rows = await conn.fetch(f"""
            SELECT a.id, a.email_messages
            FROM bedrock.activity a
            WHERE a.source = 'gmail-sync' AND a.deleted_at IS NULL
              AND a.email_messages IS NOT NULL
              AND ($1::uuid IS NULL OR a.id > $1) {bound}
            ORDER BY a.id
            LIMIT {BATCH_THREADS}
        """, last_id, *params)
        if not rows:
            break
        last_id = rows[-1]["id"]
        scanned += len(rows)

        to_insert: list[tuple] = []
        for r in rows:
            try:
                msgs = json.loads(r["email_messages"])
            except Exception:
                bad += 1
                continue
            for m in msgs or []:
                frm = _parse_from(m.get("from"))
                dt = _parse_date(m.get("date"))
                if not frm or not dt:
                    bad += 1
                    continue
                to_insert.append((r["id"], m.get("message_id"), frm, dt))
        messages_seen += len(to_insert)

        CHUNK = 5000
        for i in range(0, len(to_insert), CHUNK):
            chunk = to_insert[i:i + CHUNK]
            result = await conn.execute("""
                INSERT INTO bedrock.activity_email_message (activity_id, message_id, from_email, sent_at)
                SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[])
                ON CONFLICT DO NOTHING
            """, [c[0] for c in chunk], [c[1] for c in chunk],
                 [c[2] for c in chunk], [c[3] for c in chunk])
            # asyncpg returns "INSERT 0 <n>"
            try:
                inserted += int(result.split()[-1])
            except Exception:
                pass

    logger.info("email message index: scanned %d threads, %d messages seen, %d inserted, %d unparseable",
                scanned, messages_seen, inserted, bad)
    return {"threads_scanned": scanned, "messages_seen": messages_seen,
            "inserted": inserted, "unparseable": bad}
