"""Export the anonymized activity fixture behind tests/test_outreach_counting.py.

Read-only. Runs services.outreach_counting.events_sql against the database in
DATABASE_URL (use the read-only nina_dev login) and writes every candidate
event in the fixture window, for every Pursuit sender, plus the earliest
earlier event per (account, sender) on the accounts the window touched — all
activation needs to know whether an account was worked before.

Anonymized in SQL, so nothing identifying leaves the database:
  * Pursuit staff addresses are kept: they ARE the attribution under test.
  * Contacts, accounts, activity and intro ids are replaced by salted hashes.
  * Subjects and bodies are dropped, except the leading "Appointment booked:"
    style prefix of an automatic calendar notice and a generic marker for an
    automatic reply, which is what the counting rules read.

The window (Mon 9/21 - Wed 9/30, New York) covers the 9/30 audit's rolling
week (Wed 9/23 - Tue 9/29) and the calendar week D8 asks to pin
(Mon 9/21 - Sun 9/27). Rerun after the email index is backfilled to see how
the pins move.

Usage (from financial_forecasting/):
    python -m scripts.export_outreach_fixture [out.json]
"""
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from services.outreach_counting import AUTOREPLY_SUBJECTS, events_sql

WINDOW_START = "2026-09-21T04:00:00+00:00"   # Mon 9/21 00:00 New York
WINDOW_END = "2026-09-30T04:00:00+00:00"     # Wed 9/30 00:00 New York
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "outreach_2026_09_21.json"

# Postgres spelling of services.outreach_counting._CALENDAR_NOTICE.
_NOTICE_SQL = (r"^\s*(appointment (booked|canceled|cancelled|rescheduled)"
               r"|(updated |new )?invitation|accepted|declined|tentatively accepted"
               r"|(canceled|cancelled) event)( with note)?\s*:")


def fixture_sql() -> str:
    """One statement. $1 window start, $2 window end."""
    senders = ("(SELECT array_agg(DISTINCT lower(email)) FROM ("
               "SELECT email FROM public.org_users WHERE is_active AND email IS NOT NULL "
               "UNION SELECT email FROM bedrock.jobs_team_member) s)")
    autoreply = " OR ".join(f"lower(e.subject) LIKE '%{p}%'" for p in AUTOREPLY_SUBJECTS)
    win = events_sql(p_start="$1", p_end="$2", p_senders=senders)
    prior = events_sql(restrict_companies=True, p_start="NULL", p_end="$1", p_senders=senders,
                       p_companies="(SELECT array_agg(DISTINCT c) FROM win, unnest(win.companies) c)")
    anon = lambda src: f"""
        SELECT e.kind, e.ts, e.sender,
               CASE WHEN e.activity_id IS NOT NULL THEN 'act_' || left(md5('pro98:' || e.activity_id::text), 12) END AS activity_id,
               CASE WHEN e.intro_id IS NOT NULL THEN 'ir_' || left(md5('pro98:' || e.intro_id::text), 12) END AS intro_id,
               CASE WHEN e.contact_id IS NOT NULL THEN ('x' || left(md5('pro98:c' || e.contact_id), 7))::bit(28)::int END AS contact_id,
               ARRAY(SELECT ('x' || left(md5('pro98:c' || x), 7))::bit(28)::int FROM unnest(e.contact_ids) x ORDER BY 1) AS contact_ids,
               ARRAY(SELECT 'acct_' || left(md5('pro98:a' || x), 10) FROM unnest(e.companies) x ORDER BY 1) AS companies,
               CASE WHEN e.subject ~* '{_NOTICE_SQL}' THEN substring(e.subject from '^[^:]*:')
                    WHEN {autoreply} THEN 'Automatic reply:' END AS subject,
               CASE WHEN e.kind = 'email' THEN e.sender END AS email_from,
               e.source, e.call_kind
        FROM {src} e"""
    return f"""
    WITH win AS ({win}),
    prior AS ({prior}),
    firsts AS (
      -- The earliest earlier event per (account, sender) on the window's
      -- accounts, skipping mail the counting rules ignore, so the one kept is
      -- one the rules count.
      SELECT DISTINCT ON (c, p.sender) p.kind, p.ts, p.sender, p.activity_id, p.intro_id
      FROM prior p, unnest(p.companies) c
      WHERE c IN (SELECT unnest(companies) FROM win)
        AND NOT (p.kind = 'email' AND (coalesce(p.subject, '') ~* '{_NOTICE_SQL}'
                 OR {autoreply.replace("e.subject", "coalesce(p.subject, '')")}))
      ORDER BY c, p.sender, p.ts
    ),
    prior_first AS (
      -- Each of those events WHOLE, with every account it reached: one event
      -- cut into a row per account would read as copies of itself and be
      -- counted once, losing the others' history.
      SELECT DISTINCT p.kind, p.ts, p.sender, p.activity_id, p.intro_id, p.contact_id,
             p.contact_ids, p.companies, p.subject, p.email_from, p.source, p.call_kind
      FROM prior p JOIN firsts f
        ON f.kind = p.kind AND f.ts = p.ts AND f.sender = p.sender
       AND f.activity_id IS NOT DISTINCT FROM p.activity_id
       AND f.intro_id IS NOT DISTINCT FROM p.intro_id
    )
    SELECT json_agg(json_build_array({", ".join(COLUMNS)})
                    ORDER BY part DESC, ts, kind, sender, activity_id, intro_id)
    FROM (
      SELECT 'window' AS part, * FROM ({anon('win')}) w
      UNION ALL
      SELECT 'prior', * FROM ({anon('prior_first')}) p
    ) x
    """


# One row per event, as an array in this order (keeps the fixture small).
COLUMNS = ("part", "kind", "ts", "sender", "activity_id", "intro_id", "contact_id",
           "contact_ids", "companies", "subject", "email_from", "source", "call_kind")


async def main() -> None:
    import asyncpg

    load_dotenv()
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        rows = json.loads(await conn.fetchval(
            fixture_sql(), datetime.fromisoformat(WINDOW_START),
            datetime.fromisoformat(WINDOW_END), timeout=300) or "[]")
    finally:
        await conn.close()
    payload = {
        "exported": datetime.now(timezone.utc).date().isoformat(),
        "window": [WINDOW_START, WINDOW_END],
        "columns": list(COLUMNS),
        "rows": rows,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("{\n" + ",\n".join(
        [f' "{k}": {json.dumps(v)}' for k, v in payload.items() if k != "rows"]
        + [' "rows": [\n' + ",\n".join("  " + json.dumps(r) for r in rows) + "\n ]"]) + "\n}\n")
    print(f"wrote {len(rows)} rows to {out}")


if __name__ == "__main__":
    asyncio.run(main())
