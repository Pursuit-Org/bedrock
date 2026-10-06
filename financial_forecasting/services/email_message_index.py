"""Explode gmail-sync threads into bedrock.activity_email_message rows.

bedrock.activity is one row per Gmail THREAD, dated/attributed to the thread's
first message — which makes weekly send metrics blind to replies and follow-ups
(they update the thread row but never create a new dated send). This index
gives metrics a per-MESSAGE view: (activity_id, from_email, sent_at).

Idempotent: ON CONFLICT DO NOTHING against the (activity, message) identity.
Run with days_back=None once to backfill, then nightly with a small window —
threads whose email_messages grew get re-exploded because updates bump
activity.synced_at.

It stopped on 2026-09-24 and nobody noticed for ten days (PRO-98). The nightly
run's query died at the web pool's 30-second command_timeout with an empty
error message, and the next night's 7-day window would never have reached back
to the gap anyway. So now:
  * the refresh runs under its own `timeout`, not whatever pool it was handed;
  * `catch_up` widens the window back to when the index last grew, so a missed
    night heals itself on the next good one;
  * only threads with messages not yet indexed are read, and only the three
    fields parsed, not the bodies;
  * `index_health` says when it has fallen behind, for the nightly log and the
    Outreach tab.
"""

import json
import logging
import re
from email.utils import parsedate_to_datetime
from datetime import timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

_ADDR_RE = re.compile(r"<([^>]+)>")

# Ten minutes: a full backfill reads every gmail-sync thread.
REFRESH_TIMEOUT_SEC = 600
# How far behind the index may fall before it counts as stale (PRO-98).
STALE_AFTER_HOURS = 24


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


# The newest index row's creation time: when the index last grew. Read by
# primary key, so it costs an index probe, not a scan.
_LAST_GREW = ("(SELECT created_at FROM bedrock.activity_email_message "
              "ORDER BY id DESC LIMIT 1)")


async def refresh_email_message_index(conn, days_back: Optional[int] = None, *,
                                      catch_up: bool = False,
                                      timeout: float = REFRESH_TIMEOUT_SEC) -> dict[str, Any]:
    """Insert missing per-message rows for gmail-sync activity.

    days_back bounds the scan to recently-synced threads (nightly incremental);
    None scans everything (backfill). `catch_up` also reaches back to a day
    before the index last grew, whichever is earlier.
    """
    bound = ""
    params: list = []
    if days_back is not None:
        since = "now() - ($1 || ' days')::interval"
        if catch_up:
            since = f"least({since}, coalesce({_LAST_GREW} - interval '1 day', {since}))"
        bound = f"AND a.synced_at >= {since}"
        params = [str(days_back)]

    rows = await conn.fetch(f"""
        SELECT a.id,
               (SELECT jsonb_agg(jsonb_build_object(
                         'from', m->>'from', 'date', m->>'date', 'message_id', m->>'message_id'))
                  FROM jsonb_array_elements(a.email_messages) m) AS email_messages
        FROM bedrock.activity a
        WHERE a.source = 'gmail-sync' AND a.deleted_at IS NULL
          AND a.email_messages IS NOT NULL {bound}
          AND jsonb_array_length(a.email_messages) >
              (SELECT count(*) FROM bedrock.activity_email_message x WHERE x.activity_id = a.id)
    """, *params, timeout=timeout)

    to_insert: list[tuple] = []
    bad = 0
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

    inserted = 0
    CHUNK = 5000
    for i in range(0, len(to_insert), CHUNK):
        chunk = to_insert[i:i + CHUNK]
        result = await conn.execute("""
            INSERT INTO bedrock.activity_email_message (activity_id, message_id, from_email, sent_at)
            SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[])
            ON CONFLICT DO NOTHING
        """, [c[0] for c in chunk], [c[1] for c in chunk],
             [c[2] for c in chunk], [c[3] for c in chunk], timeout=timeout)
        # asyncpg returns "INSERT 0 <n>"
        try:
            inserted += int(result.split()[-1])
        except Exception:
            pass

    logger.info("email message index: scanned %d threads, %d messages seen, %d inserted, %d unparseable",
                len(rows), len(to_insert), inserted, bad)
    return {"threads_scanned": len(rows), "messages_seen": len(to_insert),
            "inserted": inserted, "unparseable": bad}


async def index_health(conn) -> dict[str, Any]:
    """Is the index keeping up with the sync?

    Stale when a thread that started more than STALE_AFTER_HOURS after the
    index last grew has been synced. A quiet weekend with no new mail is not
    stale. Read off the thread's start (activity_date), not synced_at: a
    manual re-sync re-stamps synced_at on every thread without giving the
    index anything new, which would raise a false alarm.
    """
    row = await conn.fetchrow(f"""
        SELECT {_LAST_GREW} AS last_indexed_at,
               (SELECT max(activity_date) FROM bedrock.activity
                 WHERE source = 'gmail-sync' AND deleted_at IS NULL
                   AND activity_date > now() - interval '30 days'
                   AND activity_date <= now()) AS last_synced_at
    """)
    last_indexed = row["last_indexed_at"] if row else None
    last_synced = row["last_synced_at"] if row else None
    lag_hours = (None if not (last_indexed and last_synced)
                 else max(0.0, (last_synced - last_indexed).total_seconds() / 3600))
    return {
        "last_indexed_at": last_indexed.isoformat() if last_indexed else None,
        "last_synced_at": last_synced.isoformat() if last_synced else None,
        "stale": lag_hours is not None and lag_hours > STALE_AFTER_HOURS,
        "lag_hours": round(lag_hours, 1) if lag_hours is not None else None,
    }
