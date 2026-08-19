#!/usr/bin/env python3
"""Merge cross-batch LinkedIn re-import duplicates in the staff network.

Signature (user-approved 2026-07-01 audit): the SAME staff member is connected
to 2+ contact rows with the SAME normalized name, imported on DIFFERENT dates,
with no conflicting linkedin_urls. LinkedIn exports are full point-in-time
dumps, so two genuinely different same-name people would both appear in every
batch (same created date) — those groups are skipped. A pair split across
batches is one person re-imported after a job change (importer keys name+company).

Survivor: row with linkedin_url > email > most activity > oldest id.
Company/title: taken from the NEWEST snapshot. All FKs repointed
(activity, aliases, sf links, statuses, tasks/comments, relationships,
intro_requests, outreach); loser marked contact_stage='merged'; audited in
bedrock.contact_merge_audit. Idempotent — merged rows are excluded from the scan.
"""
import os, asyncio, asyncpg
from dotenv import load_dotenv

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(HERE, ".env"))
load_dotenv("/Users/jacquelinereverand/dev/build/platform/server/.env", override=False)

REASON = "network dedupe: same staff + same name, cross-batch linkedin reimport (job change)"


def _su_url():
    return f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}@{os.environ['PG_HOST']}:{os.environ['PG_PORT']}/{os.environ['PG_DATABASE']}"


async def main():
    conn = await asyncpg.connect(_su_url(), statement_cache_size=0)
    groups = await conn.fetch("""
      SELECT r.staff_user_id, lower(trim(c.first_name)||' '||trim(c.last_name)) nm,
             array_agg(DISTINCT c.contact_id) ids
      FROM public.staff_contact_relationships r
      JOIN public.contacts c ON c.contact_id = r.contact_id
      WHERE coalesce(c.contact_stage,'') <> 'merged'
      GROUP BY 1,2
      HAVING count(DISTINCT c.contact_id) > 1
         AND count(DISTINCT lower(c.linkedin_url)) FILTER (WHERE c.linkedin_url IS NOT NULL) <= 1
         AND count(DISTINCT c.created_at::date) > 1""")
    seen, merged = set(), 0
    for g in groups:
        key = tuple(sorted(g["ids"]))
        if key in seen:
            continue
        seen.add(key)
        rows = await conn.fetch("""
          SELECT c.contact_id, c.email, c.linkedin_url, c.current_company, c.current_title, c.created_at,
                 coalesce(c.contact_stage,'') stage,
                 (SELECT count(*) FROM bedrock.activity a WHERE a.participant_public_contact_id=c.contact_id) n_act
          FROM contacts c WHERE c.contact_id = ANY($1)""", list(g["ids"]))
        rows = [r for r in rows if r["stage"] != "merged"]
        if len(rows) < 2:
            continue
        surv = sorted(rows, key=lambda r: (r["linkedin_url"] is None, r["email"] is None, -r["n_act"], r["contact_id"]))[0]
        newest = max(rows, key=lambda r: r["created_at"])
        losers = [r for r in rows if r["contact_id"] != surv["contact_id"]]
        async with conn.transaction():
            for l in losers:
                lid, sid = l["contact_id"], surv["contact_id"]
                await conn.execute("UPDATE bedrock.activity SET participant_public_contact_id=$2 WHERE participant_public_contact_id=$1", lid, sid)
                await conn.execute("UPDATE bedrock.activity SET contact_ids=array_replace(contact_ids,$1::text,$2::text) WHERE contact_ids @> ARRAY[$1::text]", str(lid), str(sid))
                await conn.execute("""UPDATE bedrock.contact_email_alias SET public_contact_id=$2 WHERE public_contact_id=$1
                    AND NOT EXISTS (SELECT 1 FROM bedrock.contact_email_alias x WHERE x.public_contact_id=$2 AND lower(x.address)=lower(bedrock.contact_email_alias.address))""", lid, sid)
                await conn.execute("DELETE FROM bedrock.contact_email_alias WHERE public_contact_id=$1", lid)
                await conn.execute("""UPDATE bedrock.sf_contact_link SET public_contact_id=$2 WHERE public_contact_id=$1
                    AND NOT EXISTS (SELECT 1 FROM bedrock.sf_contact_link x WHERE x.public_contact_id=$2 AND x.sf_contact_id=bedrock.sf_contact_link.sf_contact_id)""", lid, sid)
                await conn.execute("DELETE FROM bedrock.sf_contact_link WHERE public_contact_id=$1", lid)
                await conn.execute("""UPDATE bedrock.connection_status SET contact_id=$2 WHERE contact_id=$1
                    AND NOT EXISTS (SELECT 1 FROM bedrock.connection_status x WHERE x.contact_id=$2 AND x.staff_user_id=bedrock.connection_status.staff_user_id)""", lid, sid)
                await conn.execute("DELETE FROM bedrock.connection_status WHERE contact_id=$1", lid)
                await conn.execute("UPDATE bedrock.email_candidate SET contact_id=$2 WHERE contact_id=$1", lid, sid)
                await conn.execute("UPDATE bedrock.intro_request SET contact_id=$2 WHERE contact_id=$1", lid, sid)
                await conn.execute("UPDATE public.intro_requests SET contact_id=$2, updated_at=now() WHERE contact_id=$1", lid, sid)
                await conn.execute("UPDATE public.outreach SET contact_id=$2, updated_at=now() WHERE contact_id=$1", lid, sid)
                await conn.execute("""UPDATE public.staff_contact_relationships SET contact_id=$2 WHERE contact_id=$1
                    AND NOT EXISTS (SELECT 1 FROM public.staff_contact_relationships x WHERE x.contact_id=$2 AND x.staff_user_id=public.staff_contact_relationships.staff_user_id)""", lid, sid)
                await conn.execute("DELETE FROM public.staff_contact_relationships WHERE contact_id=$1", lid)
                await conn.execute("UPDATE bedrock.jobs_task SET parent_id=$2 WHERE parent_type='prospect' AND parent_id=$1", str(lid), str(sid))
                await conn.execute("UPDATE bedrock.jobs_comment SET parent_id=$2 WHERE parent_type='prospect' AND parent_id=$1", str(lid), str(sid))
                # keep the loser's email reachable as an alias of the survivor
                if l["email"]:
                    await conn.execute("""INSERT INTO bedrock.contact_email_alias (address, public_contact_id, source)
                        SELECT lower($1), $2, 'merge'
                        WHERE NOT EXISTS (SELECT 1 FROM bedrock.contact_email_alias x WHERE lower(x.address)=lower($1))""",
                        l["email"], sid)
                # release the loser's email BEFORE the survivor enrich (unique constraint)
                await conn.execute("UPDATE contacts SET contact_stage='merged', is_jobs_contact=false, email=NULL, updated_at=now() WHERE contact_id=$1", lid)
                await conn.execute("INSERT INTO bedrock.contact_merge_audit (loser_id, canonical_id, reason, merged_at) VALUES ($1,$2,$3,now())", lid, sid, REASON)
                merged += 1
            await conn.execute("""
              UPDATE contacts SET
                current_company = coalesce($2, current_company),
                current_title   = coalesce($3, current_title),
                email        = coalesce(email, $4),
                linkedin_url = coalesce(linkedin_url, $5),
                updated_at = now()
              WHERE contact_id = $1""",
              surv["contact_id"], newest["current_company"], newest["current_title"],
              next((l["email"] for l in losers if l["email"]), None),
              next((l["linkedin_url"] for l in losers if l["linkedin_url"]), None))
    print(f"merged {merged} duplicate rows across {len(seen)} groups")
    left = await conn.fetchval("""
      SELECT count(*) FROM (
        SELECT 1 FROM public.staff_contact_relationships r
        JOIN public.contacts c ON c.contact_id = r.contact_id
        WHERE coalesce(c.contact_stage,'') <> 'merged'
        GROUP BY r.staff_user_id, lower(trim(c.first_name)||' '||trim(c.last_name))
        HAVING count(DISTINCT c.contact_id) > 1
           AND count(DISTINCT lower(c.linkedin_url)) FILTER (WHERE c.linkedin_url IS NOT NULL) <= 1
           AND count(DISTINCT c.created_at::date) > 1) x""")
    print(f"remaining cross-batch groups after merge: {left}")
    await conn.close()

asyncio.run(main())
