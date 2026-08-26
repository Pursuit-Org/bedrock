#!/usr/bin/env python3
"""Absorb the legacy public.outreach tracker (161 rows, stale since 2026-05-20)
into the current contacts + activity model so no old staff-outreach data is lost.

Per row: match to a contact (linkedin_url > email > name+company > unique name),
create the contact if net-new, link outreach.contact_id, enrich missing contact
fields, map stage → contact_stage (only when unset), append notes, and log one
bedrock.activity 'note' dated outreach_date so it shows in the activity feed.

Idempotent: rows with outreach.contact_id already set are skipped; the activity
insert is keyed on a [outreach-import:{id}] marker in the description.
"""
import os, asyncio, asyncpg
from dotenv import load_dotenv

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(HERE, ".env"))
# public.outreach/contacts writes need the postgres superuser (same as
# contacts_merge_execute.py) — bedrock_user only owns the bedrock schema.
load_dotenv("/Users/jacquelinereverand/dev/build/platform/server/.env", override=False)


def _su_url():
    return f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}@{os.environ['PG_HOST']}:{os.environ['PG_PORT']}/{os.environ['PG_DATABASE']}"

STAGE_MAP = {
    "Initial Outreach": "initial_outreach", "Active Lead": "active",
    "Qualified": "active", "Follow Up": "active",
    "Not Interested": "on_hold", "Closed": "on_hold", "Close Loss": "on_hold",
}


async def main():
    conn = await asyncpg.connect(_su_url(), statement_cache_size=0)
    rows = await conn.fetch("SELECT * FROM public.outreach WHERE contact_id IS NULL ORDER BY id")
    staff = {r["staff_user_id"]: r["email"] for r in await conn.fetch("SELECT staff_user_id, email FROM bedrock.staff_user_id_map")}
    linked = created = enriched = acts = 0
    for o in rows:
        name = (o["contact_name"] or "").strip()
        if not name:
            continue
        email = (o["contact_email"] or "").strip() or None
        url = (o["linkedin_url"] or "").strip() or None
        title = (o["contact_title"] or "").strip() or None
        company = (o["company_name"] or "").strip() or None
        cid = None
        if url:
            cid = await conn.fetchval("SELECT contact_id FROM contacts WHERE lower(linkedin_url)=lower($1) AND coalesce(contact_stage,'')<>'merged' LIMIT 1", url)
        # Email holder: follow merged rows to their canonical (the unique
        # constraint spans merged rows, so we must never re-insert that email).
        email_holder = None
        if email:
            h = await conn.fetchrow("SELECT contact_id, coalesce(contact_stage,'') st FROM contacts WHERE lower(email)=lower($1) LIMIT 1", email)
            if h:
                email_holder = h["contact_id"]
                if h["st"] == "merged":
                    email_holder = await conn.fetchval(
                        "SELECT canonical_id FROM bedrock.contact_merge_audit WHERE loser_id=$1 ORDER BY merged_at DESC LIMIT 1",
                        h["contact_id"]) or h["contact_id"]
        if not cid and email_holder:
            cid = email_holder
        if not cid and company:
            cid = await conn.fetchval("""SELECT contact_id FROM contacts WHERE lower(full_name)=lower($1)
                AND current_company ILIKE '%'||$2||'%' AND coalesce(contact_stage,'')<>'merged' LIMIT 1""",
                name, company[:40])
        if not cid:
            m = await conn.fetch("SELECT contact_id FROM contacts WHERE lower(full_name)=lower($1) AND coalesce(contact_stage,'')<>'merged' LIMIT 2", name)
            if len(m) == 1:
                cid = m[0]["contact_id"]
        stage = STAGE_MAP.get(o["stage"] or "", None)
        # don't write an email that a *different* contact already holds
        if email and email_holder and email_holder != cid:
            email = None
        if not cid:
            parts = name.split()
            first, last = parts[0], " ".join(parts[1:]) or "—"
            cid = await conn.fetchval("""
                INSERT INTO contacts (first_name, last_name, email, linkedin_url, current_title, current_company,
                                      source, is_jobs_contact, contact_stage, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,'outreach_import',true,$7,now(),now()) RETURNING contact_id""",
                first, last, email, url, title, company, stage)
            created += 1
        else:
            await conn.execute("""
                UPDATE contacts SET
                  email = coalesce(email, $2), linkedin_url = coalesce(linkedin_url, $3),
                  current_title = coalesce(current_title, $4), current_company = coalesce(current_company, $5),
                  contact_stage = coalesce(contact_stage, $6), is_jobs_contact = true, updated_at = now()
                WHERE contact_id = $1""",
                cid, email, url, title, company, stage)
            enriched += 1
        await conn.execute("UPDATE public.outreach SET contact_id=$2, is_migrated=true, updated_at=now() WHERE id=$1", o["id"], cid)
        linked += 1
        # notes → contact notes (dated block, only once)
        note_bits = [b for b in [o["notes"], o["response_notes"]] if b]
        if o["next_steps"]:
            note_bits.append(f"Next steps: {o['next_steps']}")
        if note_bits:
            block = f"[Old outreach tracker {o['outreach_date'] or ''}] " + " | ".join(str(b) for b in note_bits)
            await conn.execute("""UPDATE contacts SET notes = CASE
                WHEN notes IS NULL OR notes='' THEN $2
                WHEN position($3 in notes) > 0 THEN notes
                ELSE notes || E'\n' || $2 END WHERE contact_id=$1""",
                cid, block, f"[Old outreach tracker {o['outreach_date'] or ''}]")
        # one activity row dated the outreach date
        marker = f"[outreach-import:{o['id']}]"
        exists = await conn.fetchval("SELECT 1 FROM bedrock.activity WHERE description LIKE $1 LIMIT 1", f"%{marker}%")
        if not exists and o["outreach_date"]:
            desc = f"{marker} Imported from the old staff outreach tracker. Stage: {o['stage'] or '—'}." + (f" Method: {o['contact_method']}." if o["contact_method"] else "")
            await conn.execute("""
                INSERT INTO bedrock.activity (type, subject, description, activity_date, source, logged_by, participant_public_contact_id)
                VALUES ('note', $1, $2, $3, 'manual', $4, $5)""",
                f"Outreach — {name}", desc, o["outreach_date"], staff.get(o["staff_user_id"]), cid)
            acts += 1
    print(f"linked {linked} outreach rows: {created} contacts created, {enriched} enriched, {acts} activity rows logged")
    await conn.close()

asyncio.run(main())
