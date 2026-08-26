"""
Execute SAFE merges: airtable-jobs contact → canonical linkedin_import contact.
Per-pair transaction. Repoints FK refs + deal arrays, deletes dupe, enriches canonical.
"""
import asyncio, os, sys, json
sys.path.insert(0, '/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting')
from dotenv import load_dotenv
load_dotenv('/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting/.env')
load_dotenv('/Users/jacquelinereverand/dev/build/platform/server/.env', override=False)
import asyncpg

def _su_url():
    return f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}@{os.environ['PG_HOST']}:{os.environ['PG_PORT']}/{os.environ['PG_DATABASE']}"

FK_TABLES = ("staff_contact_relationships", "intro_requests", "outreach")

async def main():
    with open("/tmp/merge_plan.json") as f:
        plan = json.load(f)
    safe = plan["SAFE"]
    print(f"Executing {len(safe)} SAFE merges...\n")

    conn = await asyncpg.connect(_su_url(), timeout=30)
    merged = 0
    failed = []

    for s in safe:
        at_id = int(s["at_id"])
        li_id = int(s["li_id"])
        airtable_id = s["airtable_id"]
        name = s["name"]
        try:
            async with conn.transaction():
                # Capture the airtable-jobs record fresh (avoid stale plan data)
                at = await conn.fetchrow(
                    "SELECT email, current_title, current_company, notes, contact_stage, airtable_id "
                    "FROM public.contacts WHERE contact_id=$1", at_id)
                li = await conn.fetchrow(
                    "SELECT email, current_title, current_company, notes FROM public.contacts WHERE contact_id=$1", li_id)
                if not at or not li:
                    failed.append((name, "record vanished")); continue

                # 1. Repoint FK references from at_id → li_id (defensive; analysis found 0)
                for tbl in FK_TABLES:
                    await conn.execute(
                        f"UPDATE public.{tbl} SET contact_id=$1 WHERE contact_id=$2", li_id, at_id)

                # 2. Repoint deal sf_contact_ids: pub:{at_id} → pub:{li_id}
                #    (airtable:{airtable_id} auto-resolves once we move airtable_id to li)
                await conn.execute("""
                    UPDATE bedrock.jobs_opportunity
                    SET sf_contact_ids = array_replace(sf_contact_ids, $1, $2)
                    WHERE $1 = ANY(sf_contact_ids)
                """, f"pub:{at_id}", f"pub:{li_id}")

                # 3. Delete the airtable-jobs duplicate (frees unique slots: airtable_id, email, linkedin_url)
                await conn.execute("DELETE FROM public.contacts WHERE contact_id=$1", at_id)

                # 4. Enrich canonical linkedin_import record
                # email: only copy if LI null and AT has one and it's free
                new_email = li["email"]
                if not li["email"] and at["email"]:
                    clash = await conn.fetchval(
                        "SELECT 1 FROM public.contacts WHERE lower(email)=lower($1) AND contact_id!=$2 LIMIT 1",
                        at["email"], li_id)
                    if not clash:
                        new_email = at["email"]

                # notes: concatenate distinct
                notes_parts = [p for p in [li["notes"], at["notes"]] if p and p.strip()]
                merged_notes = "\n---\n".join(dict.fromkeys(notes_parts)) if notes_parts else None

                await conn.execute("""
                    UPDATE public.contacts SET
                        is_jobs_contact = true,
                        airtable_id     = $2,
                        contact_stage   = COALESCE($3, contact_stage),
                        current_company = COALESCE($4, current_company),
                        current_title   = COALESCE($5, current_title),
                        email           = $6,
                        notes           = $7,
                        updated_at      = now()
                    WHERE contact_id = $1
                """, li_id, at["airtable_id"], at["contact_stage"],
                    at["current_company"], at["current_title"], new_email, merged_notes)

                merged += 1
                print(f"  ✓ {name:<28} at={at_id} → li={li_id}")
        except Exception as e:
            failed.append((name, str(e)[:120]))
            print(f"  ✗ {name}: {str(e)[:120]}")

    print(f"\n── Done: {merged} merged, {len(failed)} failed ──")
    if failed:
        for name, err in failed:
            print(f"  FAILED {name}: {err}")

    # Verify final state
    dupes = await conn.fetchval("""
        SELECT count(*) FROM public.contacts a
        WHERE a.source='airtable-jobs'
          AND EXISTS (SELECT 1 FROM public.contacts l
                      WHERE l.source='linkedin_import'
                        AND lower(trim(l.full_name))=lower(trim(a.full_name)))
    """)
    print(f"\n  Remaining airtable-jobs↔linkedin_import name dupes: {dupes}")
    total_jobs = await conn.fetchval("SELECT count(*) FROM public.contacts WHERE is_jobs_contact=true")
    print(f"  Total is_jobs_contact=true: {total_jobs}")

    await conn.close()

asyncio.run(main())
