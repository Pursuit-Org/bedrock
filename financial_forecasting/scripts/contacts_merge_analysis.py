"""
READ-ONLY analysis for merging airtable-jobs contacts into their canonical
linkedin_import counterparts. Classifies each pair by safety and checks for
FK references that would need repointing before any delete.
"""
import asyncio, os, sys, json
sys.path.insert(0, '/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting')
from dotenv import load_dotenv
load_dotenv('/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting/.env')
load_dotenv('/Users/jacquelinereverand/dev/build/platform/server/.env', override=False)
import asyncpg

def _su_url():
    return f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}@{os.environ['PG_HOST']}:{os.environ['PG_PORT']}/{os.environ['PG_DATABASE']}"

async def main():
    conn = await asyncpg.connect(_su_url(), timeout=30)

    # All airtable-jobs contacts
    at_contacts = await conn.fetch("""
        SELECT contact_id, full_name, email, current_title, current_company,
               linkedin_url, notes, airtable_id, contact_stage, is_jobs_contact
        FROM public.contacts WHERE source = 'airtable-jobs'
    """)

    classifications = {"SAFE": [], "AMBIGUOUS": [], "EMAIL_CONFLICT": [], "EMPLOYER_ONLY": []}

    for at in at_contacts:
        name = (at["full_name"] or "").strip()
        if not name:
            classifications["EMPLOYER_ONLY"].append({"at_id": at["contact_id"], "name": name, "reason": "no name"})
            continue

        # Find linkedin_import matches by exact normalized name
        li_matches = await conn.fetch("""
            SELECT contact_id, full_name, email, current_title, current_company, linkedin_url, notes
            FROM public.contacts
            WHERE source = 'linkedin_import'
              AND lower(trim(full_name)) = lower(trim($1))
        """, name)

        if len(li_matches) == 0:
            classifications["EMPLOYER_ONLY"].append({"at_id": at["contact_id"], "name": name})
            continue

        if len(li_matches) > 1:
            classifications["AMBIGUOUS"].append({
                "at_id": at["contact_id"], "name": name,
                "li_ids": [m["contact_id"] for m in li_matches],
                "li_companies": [m["current_company"] for m in li_matches],
            })
            continue

        li = li_matches[0]
        # Email conflict check: if both have emails and they differ, DANGER
        at_email = (at["email"] or "").lower().strip()
        li_email = (li["email"] or "").lower().strip()
        if at_email and li_email and at_email != li_email:
            classifications["EMAIL_CONFLICT"].append({
                "at_id": at["contact_id"], "li_id": li["contact_id"], "name": name,
                "at_email": at_email, "li_email": li_email,
            })
            continue

        # FK references on the airtable-jobs record that would block delete
        fk_refs = {}
        for tbl in ("staff_contact_relationships", "intro_requests", "outreach"):
            cnt = await conn.fetchval(f"SELECT count(*) FROM public.{tbl} WHERE contact_id = $1", at["contact_id"])
            if cnt:
                fk_refs[tbl] = cnt

        # Deal references
        deal_refs = await conn.fetch("""
            SELECT id, account_name FROM bedrock.jobs_opportunity
            WHERE deleted_at IS NULL AND ('airtable:' || $1) = ANY(sf_contact_ids)
        """, at["airtable_id"])

        classifications["SAFE"].append({
            "at_id": at["contact_id"], "li_id": li["contact_id"], "name": name,
            "at_email": at_email or None, "li_email": li_email or None,
            "at_company": at["current_company"], "li_company": li["current_company"],
            "at_title": at["current_title"], "li_title": li["current_title"],
            "li_linkedin": li["linkedin_url"],
            "contact_stage": at["contact_stage"],
            "airtable_id": at["airtable_id"],
            "at_notes": at["notes"],
            "li_notes": li["notes"],
            "fk_refs": fk_refs,
            "deal_refs": [{"id": str(d["id"]), "name": d["account_name"]} for d in deal_refs],
        })

    # Print summary
    print("=" * 70)
    print("MERGE ANALYSIS — airtable-jobs → linkedin_import")
    print("=" * 70)
    print(f"  SAFE to merge:       {len(classifications['SAFE'])}")
    print(f"  AMBIGUOUS (skip):    {len(classifications['AMBIGUOUS'])}")
    print(f"  EMAIL_CONFLICT:      {len(classifications['EMAIL_CONFLICT'])}")
    print(f"  EMPLOYER_ONLY (keep):{len(classifications['EMPLOYER_ONLY'])}")
    print()

    print("── SAFE merges (sample of 15) ──")
    for s in classifications["SAFE"][:15]:
        fk = f" [FK: {s['fk_refs']}]" if s["fk_refs"] else ""
        deals = f" [{len(s['deal_refs'])} deals]" if s["deal_refs"] else ""
        comp = ""
        if s["at_company"] and s["li_company"] and s["at_company"].lower() != s["li_company"].lower():
            comp = f"  ⚠ company: AT='{s['at_company']}' LI='{s['li_company']}'"
        print(f"  {s['name']:<28} li={s['li_id']}{fk}{deals}{comp}")

    if classifications["EMAIL_CONFLICT"]:
        print("\n── EMAIL CONFLICTS (will skip — possibly different people) ──")
        for c in classifications["EMAIL_CONFLICT"]:
            print(f"  {c['name']}: AT={c['at_email']} vs LI={c['li_email']}")

    if classifications["AMBIGUOUS"]:
        print("\n── AMBIGUOUS (multiple LI matches — will skip) ──")
        for a in classifications["AMBIGUOUS"]:
            print(f"  {a['name']}: {len(a['li_ids'])} matches, companies={a['li_companies']}")

    # How many SAFE have FK refs that need repointing
    with_fk = [s for s in classifications["SAFE"] if s["fk_refs"]]
    with_deals = [s for s in classifications["SAFE"] if s["deal_refs"]]
    print(f"\n  SAFE merges with FK refs to repoint: {len(with_fk)}")
    print(f"  SAFE merges with deal links (auto-resolve via airtable_id): {len(with_deals)}")

    # Company mismatches within SAFE — worth eyeballing
    comp_mismatch = [s for s in classifications["SAFE"]
                     if s["at_company"] and s["li_company"]
                     and s["at_company"].lower() != s["li_company"].lower()]
    print(f"  SAFE merges with company mismatch (review): {len(comp_mismatch)}")
    if comp_mismatch:
        print("\n── Company mismatches in SAFE set ──")
        for s in comp_mismatch:
            print(f"  {s['name']:<28} AT='{s['at_company']}'  vs  LI='{s['li_company']}'")

    with open("/tmp/merge_plan.json", "w") as f:
        json.dump(classifications, f, indent=2, default=str)
    print("\n→ Full plan saved to /tmp/merge_plan.json")

    await conn.close()

asyncio.run(main())
