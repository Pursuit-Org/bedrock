"""
Import Airtable Contacts → public.contacts
Link them to bedrock.jobs_opportunity via the Deals field
Update bedrock.activity subject with contact name where possible
"""
import asyncio, os, sys, httpx
sys.path.insert(0, '/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting')
from dotenv import load_dotenv
load_dotenv('/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting/.env')
load_dotenv('/Users/jacquelinereverand/dev/build/platform/server/.env', override=False)
import asyncpg

BASE_ID = "appU97D9wOfq6eidF"
CONTACTS_TABLE = "tbl6pBGyaYPevqL4D"
COMPANIES_TABLE = "tblOyUDqF6kcntIYk"

CONTACT_STAGE_MAP = {
    "Outreach Sent":           "initial_outreach",
    "Initial Outreach":        "initial_outreach",
    "Active":                  "active",
    "Active (see Deals)":      "active",
    "Lead — Ready for Outreach": "lead",
    "On Hold":                 "on_hold",
}

def _at_headers():
    return {"Authorization": f"Bearer {os.environ['AIRTABLE_PAT']}"}

def _su_url():
    return f"postgresql://{os.environ.get('PG_USER','postgres')}:{os.environ.get('PG_PASSWORD','')}@{os.environ.get('PG_HOST','34.57.101.141')}:{os.environ.get('PG_PORT','5432')}/{os.environ.get('PG_DATABASE','segundo-db')}"

async def _fetch_all(client, table_id, fields=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}/{table_id}"
    params = {"pageSize": 100}
    if fields:
        params["fields[]"] = fields
    records, offset = [], None
    while True:
        if offset:
            params["offset"] = offset
        r = await client.get(url, params=params, headers=_at_headers())
        data = r.json()
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
    return records

async def main():
    conn    = await asyncpg.connect(os.environ['DATABASE_URL'])
    su_conn = await asyncpg.connect(_su_url())

    async with httpx.AsyncClient(timeout=30) as client:
        print("Fetching Airtable contacts and companies...")
        contacts  = await _fetch_all(client, CONTACTS_TABLE)
        companies = await _fetch_all(client, COMPANIES_TABLE, ["Company Name", "Website"])

    company_names = {r["id"]: r["fields"].get("Company Name", "") for r in companies}
    company_websites = {r["id"]: r["fields"].get("Website", "") for r in companies}

    print(f"  {len(contacts)} contacts, {len(companies)} companies")

    # Ensure public.contacts has airtable_id column
    col = await su_conn.fetchrow("""
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='contacts' AND column_name='airtable_id'
    """)
    if not col:
        await su_conn.execute("ALTER TABLE public.contacts ADD COLUMN airtable_id TEXT")
        await su_conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_airtable_id ON public.contacts(airtable_id) WHERE airtable_id IS NOT NULL")
        print("✓ Added airtable_id to public.contacts")

    # Also add contact_stage column if missing
    col2 = await su_conn.fetchrow("""
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='contacts' AND column_name='contact_stage'
    """)
    if not col2:
        await su_conn.execute("ALTER TABLE public.contacts ADD COLUMN contact_stage TEXT")
        print("✓ Added contact_stage to public.contacts")

    # Import contacts
    imported = updated = 0
    # airtable_id → public.contacts contact_id map
    contact_id_map = {}

    for rec in contacts:
        f = rec["fields"]
        at_id = rec["id"]
        first  = f.get("First Name", "")
        last   = f.get("Last Name", "")
        email  = f.get("Email", "")
        title  = f.get("Title", "")
        linkedin = f.get("LinkedIn", "")
        notes  = f.get("Notes", "") or ""
        dk_notes = f.get("DK Notes", "") or ""
        combined_notes = "\n".join(filter(None, [notes, dk_notes]))
        stage  = CONTACT_STAGE_MAP.get(f.get("Contact Stage", ""), None)

        company_refs = f.get("Company", [])
        company_name = company_names.get(company_refs[0], "") if company_refs else ""
        company_website = company_websites.get(company_refs[0], "") if company_refs else ""
        domain = company_website.replace("https://","").replace("http://","").replace("www.","").rstrip("/").split("/")[0] if company_website else ""

        full_name = f"{first} {last}".strip()
        if not full_name:
            continue

        # Check if already exists by airtable_id
        existing_id = await su_conn.fetchval(
            "SELECT contact_id FROM public.contacts WHERE airtable_id=$1", at_id
        )

        if existing_id:
            await su_conn.execute("""
                UPDATE public.contacts SET
                    first_name=COALESCE(NULLIF($2,''), first_name),
                    last_name=COALESCE(NULLIF($3,''), last_name),
                    email=COALESCE(NULLIF($4,''), email),
                    current_title=COALESCE(NULLIF($5,''), current_title),
                    linkedin_url=COALESCE(NULLIF($6,''), linkedin_url),
                    notes=COALESCE(NULLIF($7,''), notes),
                    contact_stage=COALESCE($8, contact_stage),
                    current_company=$9,
                    updated_at=now()
                WHERE contact_id=$1
            """, existing_id, first, last, email, title, linkedin, combined_notes, stage, company_name)
            contact_id_map[at_id] = existing_id
            updated += 1
        else:
            # Check if exists by email
            match_id = None
            if email:
                match_id = await su_conn.fetchval(
                    "SELECT contact_id FROM public.contacts WHERE lower(email)=lower($1) LIMIT 1", email
                )
            if not match_id and first and last:
                match_id = await su_conn.fetchval(
                    """SELECT contact_id FROM public.contacts
                       WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2)
                         AND (current_company IS NULL OR lower(current_company)=lower($3))
                       LIMIT 1""",
                    first, last, company_name
                )

            if match_id:
                await su_conn.execute("""
                    UPDATE public.contacts SET
                        airtable_id=$2,
                        current_title=COALESCE(NULLIF($3,''), current_title),
                        linkedin_url=COALESCE(NULLIF($4,''), linkedin_url),
                        notes=COALESCE(NULLIF($5,''), notes),
                        contact_stage=$6,
                        current_company=COALESCE(NULLIF($7,''), current_company),
                        updated_at=now()
                    WHERE contact_id=$1
                """, match_id, at_id, title, linkedin, combined_notes, stage, company_name)
                contact_id_map[at_id] = match_id
                updated += 1
            else:
                # Insert new
                cid = await su_conn.fetchval("""
                    INSERT INTO public.contacts
                        (first_name, last_name, full_name, email, current_title,
                         current_company, linkedin_url, notes, source,
                         airtable_id, contact_stage)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    RETURNING contact_id
                """, first, last, full_name, email or None, title or None,
                    company_name or None, linkedin or None,
                    combined_notes or None, "airtable-jobs",
                    at_id, stage)
                contact_id_map[at_id] = cid
                imported += 1

    print(f"  Imported {imported} new contacts, updated {updated} existing")

    # ── Link contacts → deals via the "Deals" field on each contact ──
    print("\n── Linking contacts to deals ──")
    linked = 0
    for rec in contacts:
        f = rec["fields"]
        at_id = rec["id"]
        deal_refs = f.get("Deals", [])
        if not deal_refs or at_id not in contact_id_map:
            continue

        contact_id = contact_id_map[at_id]

        # Get SF contact ID if this contact is in sf_contact_link
        sf_contact_id = await conn.fetchval(
            "SELECT scl.sf_contact_id FROM bedrock.sf_contact_link scl JOIN public.contacts c ON c.contact_id=scl.public_contact_id WHERE c.contact_id=$1 LIMIT 1",
            contact_id
        )

        for deal_at_id in deal_refs:
            opp = await conn.fetchrow(
                "SELECT id, sf_contact_ids FROM bedrock.jobs_opportunity WHERE airtable_id=$1", deal_at_id
            )
            if not opp:
                continue
            # Store contact's airtable_id or SF ID in the deal's contact list
            existing_ids = opp["sf_contact_ids"] or []
            contact_ref = sf_contact_id or f"airtable:{at_id}"
            if contact_ref not in existing_ids:
                new_ids = existing_ids + [contact_ref]
                await conn.execute(
                    "UPDATE bedrock.jobs_opportunity SET sf_contact_ids=$1 WHERE id=$2",
                    new_ids, opp["id"]
                )
                linked += 1

    print(f"  Linked {linked} contact→deal relationships")

    # ── Summary ──
    total_contacts = await su_conn.fetchval("SELECT count(*) FROM public.contacts WHERE source='airtable-jobs'")
    staged = await su_conn.fetchval("SELECT count(*) FROM public.contacts WHERE contact_stage IS NOT NULL")
    print(f"""
── Final state ──
  Airtable contacts in public.contacts: {total_contacts}
  Contacts with stage:                  {staged}
  Contact→deal links updated:           {linked}
""")

    await conn.close()
    await su_conn.close()

asyncio.run(main())
