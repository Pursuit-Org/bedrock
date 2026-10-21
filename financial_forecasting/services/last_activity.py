"""Bedrock-computed "last activity" for Salesforce contacts and accounts.

Salesforce's LastActivityDate / Last_Activity_Date__c only move when a Task or
Event is logged in SF, so they never see Gmail-synced email — a contact in an
active back-and-forth can read months stale. This computes recency from what
Bedrock actually holds:

  * Email — the latest real message, per MESSAGE (bedrock.activity_email_message),
    not per thread: a gmail-sync thread row is dated to its first message, so
    replies would otherwise be invisible. Automated senders (read-receipt
    reminders, no-reply bots) never count.
      - contact: they sent the message, or were on its To/Cc. A contact dropped
        from later replies keeps the date of the last message they were on.
        Messages synced before recipients were stored (recipient_emails NULL)
        fall back to thread level: the contact is on the thread's contact_ids.
      - account: a message on one of the account's threads that involves
        someone outside Pursuit (internal-only replies inside a thread don't
        count as touching the account).
  * Everything else (calls, meetings, manual logs, SF Tasks/Events, threads not
    yet in the message index) — activity_date, past only, so a meeting booked
    for next week doesn't read as recent.

Soft-deleted rows never count. Callers merge the result with the SF fields
(frontend `lastActivityDate()` takes the max), so this can only make a date
fresher, never hide an SF-logged touch.
"""

import logging
from datetime import datetime
from typing import Iterable

logger = logging.getLogger(__name__)

PURSUIT_DOMAIN_LIKE = "%@pursuit.org"

THREAD_RECENCY_MIGRATION = "migrations/2026-10-20-activity-email-thread-latest.sql"
_schema_ready = False
_warned = False


async def thread_recency_ready(conn) -> bool:
    """Has THREAD_RECENCY_MIGRATION been applied? Readers degrade instead of
    500ing before it runs (same fail-open stance as the notification prefs
    routes). Cached once true; a missing schema is re-probed each call so the
    app picks the columns up without a restart."""
    global _schema_ready, _warned
    if _schema_ready:
        return True
    n = await conn.fetchval("""
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'bedrock'
          AND ((table_name = 'activity' AND column_name = 'last_message_at')
            OR (table_name = 'activity_email_message' AND column_name = 'is_automated'))
    """)
    if n == 2:
        _schema_ready = True
    elif not _warned:
        _warned = True
        logger.warning("thread recency columns missing; feeds and last-activity use the "
                       "pre-migration fallback until %s is applied", THREAD_RECENCY_MIGRATION)
    return _schema_ready


def _pre_migration(sql: str) -> str:
    """The same query without the migration's columns: every message counts
    (no automated flag) and every message is matched at thread level (no
    recipients)."""
    return (sql.replace("NOT aem.is_automated", "true")
               .replace("aem.recipient_emails IS NULL", "true")
               .replace("aem.recipient_emails", "NULL::text[]")
               .replace("a.last_message_at", "NULL::timestamptz"))

_CONTACT_SQL = """
WITH input AS (
    SELECT DISTINCT sfid, lower(nullif(trim(email), '')) AS email
    FROM unnest($1::text[], $2::text[]) AS t(sfid, email)
),
ids AS (SELECT DISTINCT sfid FROM input),
emails AS (
    SELECT sfid, email FROM input WHERE email IS NOT NULL
    UNION
    SELECT scl.sf_contact_id, lower(pc.email)
    FROM bedrock.sf_contact_link scl
    JOIN public.contacts pc ON pc.contact_id = scl.public_contact_id
    WHERE scl.sf_contact_id IN (SELECT sfid FROM ids)
      AND nullif(trim(pc.email), '') IS NOT NULL
),
hits AS (
    -- The contact sent it.
    SELECT e.sfid, aem.sent_at AS at
    FROM emails e
    JOIN bedrock.activity_email_message aem ON aem.from_email = e.email
    JOIN bedrock.activity a ON a.id = aem.activity_id AND a.deleted_at IS NULL
    WHERE NOT aem.is_automated AND aem.sent_at <= now()
    UNION ALL
    -- The contact was on its To/Cc.
    SELECT e.sfid, aem.sent_at
    FROM bedrock.activity_email_message aem
    CROSS JOIN LATERAL unnest(aem.recipient_emails) AS r(email)
    JOIN emails e ON e.email = r.email
    JOIN bedrock.activity a ON a.id = aem.activity_id AND a.deleted_at IS NULL
    WHERE aem.recipient_emails && (SELECT array_agg(email) FROM emails)
      AND NOT aem.is_automated AND aem.sent_at <= now()
    UNION ALL
    -- Pre-recipient messages: thread-level match.
    SELECT u.sfid, aem.sent_at
    FROM bedrock.activity a
    CROSS JOIN LATERAL unnest(a.contact_ids) AS u(sfid)
    JOIN bedrock.activity_email_message aem ON aem.activity_id = a.id
    WHERE a.contact_ids && (SELECT array_agg(sfid) FROM ids)
      AND u.sfid IN (SELECT sfid FROM ids)
      AND a.deleted_at IS NULL
      AND aem.recipient_emails IS NULL
      AND NOT aem.is_automated AND aem.sent_at <= now()
    UNION ALL
    -- Non-email activity, and email threads not in the message index.
    SELECT u.sfid, COALESCE(a.last_message_at, a.activity_date)
    FROM bedrock.activity a
    CROSS JOIN LATERAL unnest(a.contact_ids) AS u(sfid)
    WHERE a.contact_ids && (SELECT array_agg(sfid) FROM ids)
      AND u.sfid IN (SELECT sfid FROM ids)
      AND a.deleted_at IS NULL
      AND COALESCE(a.last_message_at, a.activity_date) <= now()
      AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
)
SELECT sfid, max(at) AS last_at FROM hits GROUP BY sfid
"""

_ACCOUNT_SQL = f"""
WITH hits AS (
    SELECT a.account_id AS aid, aem.sent_at AS at
    FROM bedrock.activity a
    JOIN bedrock.activity_email_message aem ON aem.activity_id = a.id
    WHERE a.account_id = ANY($1::text[])
      AND a.deleted_at IS NULL
      AND NOT aem.is_automated AND aem.sent_at <= now()
      AND (aem.recipient_emails IS NULL
           OR aem.from_email NOT LIKE '{PURSUIT_DOMAIN_LIKE}'
           OR EXISTS (SELECT 1 FROM unnest(aem.recipient_emails) AS r(email)
                      WHERE r.email NOT LIKE '{PURSUIT_DOMAIN_LIKE}'))
    UNION ALL
    SELECT a.account_id, COALESCE(a.last_message_at, a.activity_date)
    FROM bedrock.activity a
    WHERE a.account_id = ANY($1::text[])
      AND a.deleted_at IS NULL
      AND COALESCE(a.last_message_at, a.activity_date) <= now()
      AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
)
SELECT aid, max(at) AS last_at FROM hits GROUP BY aid
"""


async def last_activity_for_contacts(
    conn, contacts: Iterable[tuple[str, Iterable[str | None]]]
) -> dict[str, datetime]:
    """{sf_contact_id: latest activity} for (sf_contact_id, [emails]) pairs.

    Emails come from the SF record (Email plus any NPSP alternates); addresses
    linked through bedrock.sf_contact_link are added server-side.
    """
    sfids: list[str] = []
    emails: list[str | None] = []
    for sfid, addrs in contacts:
        if not sfid:
            continue
        addrs = [a for a in addrs if a] or [None]
        for addr in addrs:
            sfids.append(sfid)
            emails.append(addr)
    if not sfids:
        return {}
    sql = _CONTACT_SQL if await thread_recency_ready(conn) else _pre_migration(_CONTACT_SQL)
    rows = await conn.fetch(sql, sfids, emails)
    return {r["sfid"]: r["last_at"] for r in rows if r["last_at"]}


async def last_activity_for_accounts(conn, account_ids: Iterable[str]) -> dict[str, datetime]:
    """{sf_account_id: latest activity}."""
    ids = list({a for a in account_ids if a})
    if not ids:
        return {}
    sql = _ACCOUNT_SQL if await thread_recency_ready(conn) else _pre_migration(_ACCOUNT_SQL)
    rows = await conn.fetch(sql, ids)
    return {r["aid"]: r["last_at"] for r in rows if r["last_at"]}
