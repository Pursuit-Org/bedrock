import asyncio, os, sys
sys.path.insert(0, '/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting')
from dotenv import load_dotenv
load_dotenv('/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting/.env')
load_dotenv('/Users/jacquelinereverand/dev/build/platform/server/.env', override=False)
import asyncpg

def _su_url():
    return f"postgresql://{os.environ.get('PG_USER','postgres')}:{os.environ.get('PG_PASSWORD','')}@{os.environ.get('PG_HOST','34.57.101.141')}:{os.environ.get('PG_PORT','5432')}/{os.environ.get('PG_DATABASE','segundo-db')}"

async def main():
    conn    = await asyncpg.connect(os.environ['DATABASE_URL'])
    su_conn = await asyncpg.connect(_su_url())

    print("=" * 60)
    print("DATA AUDIT — Jobs Pipeline")
    print("=" * 60)

    # ── 1. jobs_opportunity duplicates ─────────────────────────────
    print("\n── bedrock.jobs_opportunity ──")
    total_opps = await conn.fetchval("SELECT count(*) FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL")
    print(f"  Total deals: {total_opps}")

    dup_opps = await conn.fetch("""
        SELECT account_name, count(*) as cnt
        FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL
        GROUP BY account_name
        HAVING count(*) > 1
        ORDER BY count(*) DESC
    """)
    if dup_opps:
        print(f"  ⚠ Duplicate account names ({len(dup_opps)} companies with multiple deals):")
        for r in dup_opps:
            rows = await conn.fetch(
                "SELECT id, stage, deal_type, airtable_id FROM bedrock.jobs_opportunity WHERE account_name=$1 AND deleted_at IS NULL",
                r['account_name']
            )
            print(f"    {r['account_name']} ({r['cnt']}x):")
            for row in rows:
                print(f"      stage={row['stage']} type={row['deal_type']} airtable_id={row['airtable_id']}")
    else:
        print("  ✓ No duplicate account names")

    # Stage breakdown
    stages = await conn.fetch("""
        SELECT stage, count(*) FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL GROUP BY stage ORDER BY count DESC
    """)
    print(f"\n  Stage breakdown:")
    for r in stages:
        print(f"    {r['stage']}: {r['count']}")

    # Salary coverage
    with_salary = await conn.fetchval("SELECT count(*) FROM bedrock.jobs_opportunity WHERE salary_expected IS NOT NULL AND deleted_at IS NULL")
    avg_sal_won = await conn.fetchval("SELECT round(avg(salary_expected)) FROM bedrock.jobs_opportunity WHERE salary_expected IS NOT NULL AND stage='closed_won'")
    print(f"\n  Deals with salary: {with_salary}/{total_opps}")
    print(f"  Avg salary (closed_won): ${avg_sal_won:,}" if avg_sal_won else "  Avg salary (closed_won): N/A")

    # ── 2. activity linked to deals ─────────────────────────────────
    print("\n── bedrock.activity (jobs) ──")
    total_act = await conn.fetchval("SELECT count(*) FROM bedrock.activity WHERE jobs_opportunity_id IS NOT NULL")
    by_type   = await conn.fetch("""
        SELECT type, count(*) FROM bedrock.activity WHERE jobs_opportunity_id IS NOT NULL GROUP BY type ORDER BY count DESC
    """)
    print(f"  Total engagement rows: {total_act}")
    for r in by_type:
        print(f"    {r['type']}: {r['count']}")

    dup_acts = await conn.fetchval("""
        SELECT count(*) FROM (
            SELECT logged_by, activity_date, description, count(*)
            FROM bedrock.activity WHERE jobs_opportunity_id IS NOT NULL
            GROUP BY logged_by, activity_date, description HAVING count(*) > 1
        ) sub
    """)
    print(f"  ⚠ Duplicate activity rows: {dup_acts}" if dup_acts > 0 else "  ✓ No duplicate activity rows")

    # ── 3. public.job_applications ────────────────────────────────
    print("\n── public.job_applications (Pursuit-referred) ──")
    total_apps = await su_conn.fetchval("SELECT count(*) FROM public.job_applications WHERE source_type='Pursuit_referred'")
    app_stages = await su_conn.fetch("""
        SELECT stage, count(*) FROM public.job_applications WHERE source_type='Pursuit_referred' GROUP BY stage ORDER BY count DESC
    """)
    print(f"  Total Pursuit-referred applications: {total_apps}")
    for r in app_stages:
        print(f"    {r['stage']}: {r['count']}")

    dup_apps = await su_conn.fetch("""
        SELECT company_name, role_title, notes, count(*)
        FROM public.job_applications WHERE source_type='Pursuit_referred'
        GROUP BY company_name, role_title, notes HAVING count(*) > 1
        ORDER BY count(*) DESC LIMIT 5
    """)
    if dup_apps:
        print(f"  ⚠ Possible duplicate applications:")
        for r in dup_apps:
            print(f"    {r['company_name']} / {r['role_title']} x{r['count']}")
    else:
        print("  ✓ No duplicate applications")

    linked_to_deal = await su_conn.fetchval("SELECT count(*) FROM public.job_applications WHERE jobs_opportunity_id IS NOT NULL")
    print(f"  Linked to deals: {linked_to_deal}/{total_apps}")

    # ── 4. public.employment_records (hired) ─────────────────────
    print("\n── public.employment_records (airtable hired) ──")
    total_placed = await su_conn.fetchval("SELECT count(*) FROM public.employment_records WHERE source='imported'")
    print(f"  Airtable-imported placements: {total_placed}")

    # ── 5. public.contacts (employer contacts) ───────────────────
    print("\n── public.contacts (employer contacts) ──")
    total_at_contacts = await su_conn.fetchval("SELECT count(*) FROM public.contacts WHERE source='airtable-jobs'")
    with_email = await su_conn.fetchval("SELECT count(*) FROM public.contacts WHERE source='airtable-jobs' AND email IS NOT NULL")

    # SF link coverage
    sf_linked = await conn.fetchval("""
        SELECT count(DISTINCT c.contact_id)
        FROM public.contacts c
        JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
        WHERE c.source = 'airtable-jobs'
    """)
    print(f"  Airtable-imported contacts: {total_at_contacts}")
    print(f"  With email: {with_email}")
    print(f"  Linked to SF contact: {sf_linked} ({'✓ some matched' if sf_linked > 0 else '⚠ none matched — employer contacts not in SF'})")

    # Duplicate check by name
    dup_contacts = await su_conn.fetch("""
        SELECT full_name, count(*) FROM public.contacts
        WHERE source='airtable-jobs'
        GROUP BY full_name HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 5
    """)
    if dup_contacts:
        print(f"  ⚠ Duplicate contact names:")
        for r in dup_contacts:
            print(f"    {r['full_name']} x{r['count']}")
    else:
        print("  ✓ No duplicate contact names")

    # Contacts with stage
    stages_c = await su_conn.fetch("""
        SELECT contact_stage, count(*) FROM public.contacts WHERE airtable_id IS NOT NULL
        GROUP BY contact_stage ORDER BY count DESC
    """)
    print(f"\n  Contact stage breakdown (all airtable contacts):")
    for r in stages_c:
        print(f"    {r['contact_stage'] or 'none'}: {r['count']}")

    # ── 6. Cross-check: deals missing contacts ────────────────────
    print("\n── Deal coverage ──")
    deals_no_contacts = await conn.fetchval("""
        SELECT count(*) FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL
          AND (sf_contact_ids IS NULL OR array_length(sf_contact_ids,1) = 0)
          AND stage NOT IN ('lead_submitted','initial_outreach')
    """)
    deals_no_activity = await conn.fetchval("""
        SELECT count(*) FROM bedrock.jobs_opportunity jo
        WHERE jo.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM bedrock.activity a WHERE a.jobs_opportunity_id = jo.id)
          AND jo.stage NOT IN ('lead_submitted')
    """)
    print(f"  Active deals with no contacts linked: {deals_no_contacts}")
    print(f"  Active deals with no activity logged: {deals_no_activity}")

    await conn.close()
    await su_conn.close()

asyncio.run(main())
