#!/usr/bin/env python3
"""Repair the outreach-import mislinks caused by rotated linkedin_urls.

The 2026-02-25 linkedin_import batch attached each contact's linkedin_url to a
DIFFERENT contact (rotated), so absorb_old_outreach's URL-first matching linked
~50 outreach rows to the wrong person. This script, for every outreach row
whose linked contact's name doesn't resemble outreach.contact_name:

  1. reverts what the import wrote onto the wrong contact (note block,
     fill-only enrichment values that equal the outreach row's, imported
     connection_status), and
  2. relinks by NAME (+company → unique-name → create), reapplying the
     enrichment/note/stage/status and moving the imported activity row.

Also backfills full_name for contacts created by the import (INSERT omitted it).
Idempotent — a second run finds nothing suspicious.
"""
import os, asyncio, asyncpg
from difflib import SequenceMatcher
from dotenv import load_dotenv

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(HERE, ".env"))
load_dotenv("/Users/jacquelinereverand/dev/build/platform/server/.env", override=False)

STAGE_MAP = {
    "Initial Outreach": "initial_outreach", "Active Lead": "active",
    "Qualified": "active", "Follow Up": "active",
    "Not Interested": "on_hold", "Closed": "on_hold", "Close Loss": "on_hold",
}


def _su_url():
    return f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}@{os.environ['PG_HOST']}:{os.environ['PG_PORT']}/{os.environ['PG_DATABASE']}"


async def main():
    conn = await asyncpg.connect(_su_url(), statement_cache_size=0)

    # 0) full_name backfill for import-created contacts
    n = await conn.execute("""UPDATE contacts SET full_name = trim(first_name || ' ' || last_name)
        WHERE source='outreach_import' AND (full_name IS NULL OR full_name='')""")
    print("full_name backfilled:", n)

    rows = await conn.fetch("""
      SELECT o.*, c.full_name AS linked_name FROM public.outreach o
      JOIN contacts c ON c.contact_id = o.contact_id""")
    fixed = 0
    for o in rows:
        sim = SequenceMatcher(None, (o["contact_name"] or "").strip().lower(),
                              (o["linked_name"] or "").strip().lower()).ratio()
        if sim >= 0.72:
            continue
        name = (o["contact_name"] or "").strip()
        email = (o["contact_email"] or "").strip() or None
        title = (o["contact_title"] or "").strip() or None
        company = (o["company_name"] or "").strip() or None
        stage = STAGE_MAP.get(o["stage"] or "", None)
        wrong = o["contact_id"]
        async with conn.transaction():
            # 1) revert on the wrong contact
            note_bits = [b for b in [o["notes"], o["response_notes"]] if b]
            if o["next_steps"]:
                note_bits.append(f"Next steps: {o['next_steps']}")
            block = f"[Old outreach tracker {o['outreach_date'] or ''}] " + " | ".join(str(b) for b in note_bits) if note_bits else None
            if block:
                await conn.execute("""UPDATE contacts SET notes = nullif(trim(both E'\n' from replace(coalesce(notes,''), $2, '')), '')
                    WHERE contact_id=$1""", wrong, block)
            await conn.execute("""UPDATE contacts SET
                  email = CASE WHEN email = $2 THEN NULL ELSE email END,
                  current_title = CASE WHEN current_title = $3 THEN NULL ELSE current_title END,
                  contact_stage = CASE WHEN contact_stage = $4 AND NOT EXISTS
                      (SELECT 1 FROM public.outreach oo WHERE oo.contact_id=$1 AND oo.id<>$5) THEN NULL ELSE contact_stage END,
                  updated_at = now()
                WHERE contact_id=$1""", wrong, email, title, stage, o["id"])
            if (o["stage"] or "") == "Not Interested":
                await conn.execute("""DELETE FROM bedrock.connection_status
                    WHERE contact_id=$1 AND staff_user_id=$2 AND updated_by='outreach_import'""", wrong, o["staff_user_id"])
            # 2) re-match by NAME (never URL — that's the corrupted field)
            cid = None
            if company:
                cid = await conn.fetchval("""SELECT contact_id FROM contacts WHERE lower(full_name)=lower($1)
                    AND current_company ILIKE '%'||$2||'%' AND coalesce(contact_stage,'')<>'merged' LIMIT 1""", name, company[:40])
            if not cid:
                m = await conn.fetch("SELECT contact_id FROM contacts WHERE lower(full_name)=lower($1) AND coalesce(contact_stage,'')<>'merged' LIMIT 2", name)
                if len(m) == 1:
                    cid = m[0]["contact_id"]
            if not cid:
                parts = name.split()
                first, last = parts[0], " ".join(parts[1:]) or "—"
                # don't re-take an email another contact holds
                e = email
                if e and await conn.fetchval("SELECT 1 FROM contacts WHERE lower(email)=lower($1) LIMIT 1", e):
                    e = None
                cid = await conn.fetchval("""
                    INSERT INTO contacts (first_name, last_name, full_name, email, current_title, current_company,
                                          source, is_jobs_contact, contact_stage, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,$6,'outreach_import',true,$7,now(),now()) RETURNING contact_id""",
                    first, last, f"{first} {last}".strip(), e, title, company, stage)
            # 3) re-apply on the right contact
            e = email
            if e and await conn.fetchval("SELECT 1 FROM contacts WHERE lower(email)=lower($1) AND contact_id<>$2 LIMIT 1", e, cid):
                e = None
            await conn.execute("""UPDATE contacts SET
                  email = coalesce(email, $2), current_title = coalesce(current_title, $3),
                  current_company = coalesce(current_company, $4),
                  contact_stage = coalesce(contact_stage, $5), is_jobs_contact = true, updated_at=now()
                WHERE contact_id=$1""", cid, e, title, company, stage)
            if block:
                await conn.execute("""UPDATE contacts SET notes = CASE
                    WHEN notes IS NULL OR notes='' THEN $2
                    WHEN position($2 in notes) > 0 THEN notes
                    ELSE notes || E'\n' || $2 END WHERE contact_id=$1""", cid, block)
            await conn.execute("UPDATE public.outreach SET contact_id=$2, updated_at=now() WHERE id=$1", o["id"], cid)
            await conn.execute("""UPDATE bedrock.activity SET participant_public_contact_id=$2
                WHERE description LIKE $1 AND participant_public_contact_id=$3""",
                f"[outreach-import:{o['id']}]%", cid, wrong)
            if (o["stage"] or "") == "Not Interested":
                await conn.execute("""INSERT INTO bedrock.connection_status (staff_user_id, contact_id, status, reason, updated_by, updated_at)
                    VALUES ($1,$2,'declined','not interested — imported from old outreach tracker','outreach_import',now())
                    ON CONFLICT (staff_user_id, contact_id) DO UPDATE SET status='declined', reason=EXCLUDED.reason, updated_at=now()""",
                    o["staff_user_id"], cid)
            fixed += 1
            print(f"  outreach {o['id']} '{name}': {wrong} → {cid}")
    print(f"relinked {fixed} outreach rows")
    await conn.close()

asyncio.run(main())
