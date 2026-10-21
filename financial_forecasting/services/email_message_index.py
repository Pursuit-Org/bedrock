"""Explode gmail-sync threads into bedrock.activity_email_message rows.

bedrock.activity is one row per Gmail THREAD, dated/attributed to the thread's
first message — which makes weekly send metrics blind to replies and follow-ups
(they update the thread row but never create a new dated send). This index
gives metrics a per-MESSAGE view: (activity_id, from_email, sent_at).

Each message row also carries its recipients (To + Cc, for "was this contact on
this message?" recency) and whether its sender is automated (read-receipt
reminders, no-reply bots), so recency can ignore machine nudges.

Idempotent: re-exploding a thread upserts its messages and prunes rows for
messages no longer in it (the cross-mailbox dedup can swap a thread's stored
copy for a richer one from another inbox, whose Gmail message ids differ).
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


def _recipients(m: dict) -> Optional[list[str]]:
    """To + Cc addresses, or None for messages synced before recipients were
    stored (readers fall back to thread-level matching for those)."""
    if "to" not in m and "cc" not in m:
        return None
    return sorted({a.lower() for a in (m.get("to") or []) + (m.get("cc") or []) if a})


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
    """Upsert per-message rows for gmail-sync activity and prune stale ones.

    days_back bounds the scan to recently-synced threads (nightly incremental);
    None scans everything (backfill).
    """
    from services.gmail_sync import _is_automated_sender

    bound = ""
    params: list = []
    if days_back is not None:
        bound = "AND a.synced_at >= now() - ($1 || ' days')::interval"
        params = [str(days_back)]

    # Bodies are stripped server-side: a full backfill would otherwise pull
    # every email body in the table across the wire just to read headers.
    rows = await conn.fetch(f"""
        SELECT a.id,
               (SELECT jsonb_agg(m - 'body_text' - 'snippet')
                FROM jsonb_array_elements(a.email_messages::jsonb) m) AS email_messages
        FROM bedrock.activity a
        WHERE a.source = 'gmail-sync' AND a.deleted_at IS NULL
          AND a.email_messages IS NOT NULL {bound}
    """, *params)

    parsed: list[tuple] = []  # (activity_id, message_id, from, sent_at, recipients, is_automated)
    scanned_ids: list = []
    bad = 0
    for r in rows:
        try:
            raw = r["email_messages"]
            msgs = json.loads(raw) if isinstance(raw, str) else (raw or [])
        except Exception:
            bad += 1
            continue
        scanned_ids.append(r["id"])
        for m in msgs or []:
            frm = _parse_from(m.get("from"))
            dt = _parse_date(m.get("date"))
            if not frm or not dt:
                bad += 1
                continue
            parsed.append((r["id"], m.get("message_id") or None, frm, dt, _recipients(m),
                           _is_automated_sender(m.get("from") or "")))

    upserted = 0
    pruned = 0
    CHUNK = 5000
    with_mid = [p for p in parsed if p[1]]
    without_mid = [p for p in parsed if not p[1]]

    # asyncpg can't bind a text[][] with ragged rows, so recipients travel as
    # one comma-joined string per message and are split back server-side.
    def _cols(chunk):
        return ([c[0] for c in chunk], [c[1] for c in chunk], [c[2] for c in chunk],
                [c[3] for c in chunk],
                [",".join(c[4]) if c[4] is not None else None for c in chunk],
                [c[5] for c in chunk])

    select_rows = """
        SELECT aid, mid, frm, sent,
               CASE WHEN rcpt IS NULL THEN NULL
                    ELSE coalesce(string_to_array(nullif(rcpt, ''), ','), '{}') END,
               auto
        FROM unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[], $5::text[], $6::bool[])
             AS t(aid, mid, frm, sent, rcpt, auto)
    """
    for group, conflict in (
        (with_mid, "(activity_id, message_id) WHERE message_id IS NOT NULL"),
        (without_mid, "(activity_id, from_email, sent_at) WHERE message_id IS NULL"),
    ):
        for i in range(0, len(group), CHUNK):
            result = await conn.execute(f"""
                INSERT INTO bedrock.activity_email_message
                    (activity_id, message_id, from_email, sent_at, recipient_emails, is_automated)
                {select_rows}
                ON CONFLICT {conflict} DO UPDATE SET
                    recipient_emails = COALESCE(EXCLUDED.recipient_emails,
                                                bedrock.activity_email_message.recipient_emails),
                    is_automated     = EXCLUDED.is_automated
            """, *_cols(group[i:i + CHUNK]))
            try:
                upserted += int(result.split()[-1])  # "INSERT 0 <n>"
            except Exception:
                pass

    # Prune rows whose message is no longer in its thread's stored copy.
    by_activity: dict = {}
    for p in parsed:
        by_activity.setdefault(p[0], []).append(p)
    ACT_CHUNK = 2000
    for i in range(0, len(scanned_ids), ACT_CHUNK):
        ids = scanned_ids[i:i + ACT_CHUNK]
        keep = [p for aid in ids for p in by_activity.get(aid, ())]
        result = await conn.execute("""
            DELETE FROM bedrock.activity_email_message aem
            WHERE aem.activity_id = ANY($1::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM unnest($2::uuid[], $3::text[], $4::text[], $5::timestamptz[])
                     AS k(aid, mid, frm, sent)
                WHERE k.aid = aem.activity_id
                  AND ((k.mid IS NOT NULL AND k.mid = aem.message_id)
                    OR (k.mid IS NULL AND aem.message_id IS NULL
                        AND k.frm = aem.from_email AND k.sent = aem.sent_at)))
        """, ids, [k[0] for k in keep], [k[1] for k in keep],
             [k[2] for k in keep], [k[3] for k in keep])
        try:
            pruned += int(result.split()[-1])  # "DELETE <n>"
        except Exception:
            pass

    logger.info("email message index: scanned %d threads, %d messages seen, %d upserted, "
                "%d pruned, %d unparseable", len(rows), len(parsed), upserted, pruned, bad)
    # "inserted" kept for interaction_sync's existing summary key.
    return {"threads_scanned": len(rows), "messages_seen": len(parsed),
            "inserted": upserted, "upserted": upserted, "pruned": pruned, "unparseable": bad}
