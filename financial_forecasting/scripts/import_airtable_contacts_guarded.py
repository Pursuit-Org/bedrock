"""
Guarded Airtable Contacts re-pull → public.contacts

This is a non-destructive re-pull of the Airtable Contacts table that respects
this week's manual cleanup of public.contacts. Unlike import_airtable_contacts.py,
it NEVER overwrites a non-empty DB value, NEVER touches is_jobs_contact, NEVER
overwrites an already-set contact_stage, NEVER deletes, and NEVER merges.

Matching order per Airtable row:
  1. Match by airtable_id (source of truth for re-pulls) → fill BLANK columns only.
  2. Else match by exact email (case-insensitive) → fill BLANK columns only,
     and set airtable_id if it's empty.
  3. Else INSERT a new contact (with airtable_id), WITHOUT setting is_jobs_contact.

Fill-blanks-only target columns: email, current_title, current_company,
linkedin_url, notes. (contact_stage is set on insert / when blank but never
overwritten if already set.)

Collisions: each row is wrapped in try/except. If an update/insert would violate
the unique constraint on contacts.email or contacts.linkedin_url (e.g. two
Airtable rows resolving to an email already owned by a different DB row), the row
is skipped and logged — never forced.

The script is mutating and runs against prod; the user runs/approves it
separately. It is intentionally idempotent and safe to re-run.
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
    "Outreach Sent":             "initial_outreach",
    "Initial Outreach":          "initial_outreach",
    "Active":                    "active",
    "Active (see Deals)":        "active",
    "Lead — Ready for Outreach": "lead",
    "On Hold":                   "on_hold",
}

# Blank-fill target columns (besides airtable_id / contact_stage handled inline).
FILL_COLUMNS = ["email", "current_title", "current_company", "linkedin_url", "notes"]


def _at_headers():
    return {"Authorization": f"Bearer {os.environ['AIRTABLE_PAT']}"}


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


def _is_blank(v):
    return v is None or (isinstance(v, str) and v.strip() == "")


def _fill_blanks(row, candidates):
    """Return {column: value} only for DB columns that are currently blank and
    have a non-empty Airtable value to fill them with."""
    updates = {}
    for col, val in candidates.items():
        if not _is_blank(val) and _is_blank(row[col]):
            updates[col] = val
    return updates


async def main():
    conn = await asyncpg.connect(os.environ['DATABASE_URL'])

    async with httpx.AsyncClient(timeout=30) as client:
        print("Fetching Airtable contacts and companies...")
        contacts = await _fetch_all(client, CONTACTS_TABLE)
        companies = await _fetch_all(client, COMPANIES_TABLE, ["Company Name", "Website"])

    company_names = {r["id"]: r["fields"].get("Company Name", "") for r in companies}
    print(f"  {len(contacts)} contacts, {len(companies)} companies")

    matched_airtable = 0
    matched_email = 0
    inserted = 0
    skipped_collision = 0
    fields_filled = 0

    for rec in contacts:
        f = rec["fields"]
        at_id = rec["id"]
        first = (f.get("First Name", "") or "").strip()
        last = (f.get("Last Name", "") or "").strip()
        email = (f.get("Email", "") or "").strip()
        title = (f.get("Title", "") or "").strip()
        linkedin = (f.get("LinkedIn", "") or "").strip()
        notes = f.get("Notes", "") or ""
        dk_notes = f.get("DK Notes", "") or ""
        combined_notes = "\n".join(filter(None, [notes, dk_notes])).strip()
        stage = CONTACT_STAGE_MAP.get(f.get("Contact Stage", ""), None)

        company_refs = f.get("Company", [])
        company_name = company_names.get(company_refs[0], "") if company_refs else ""

        full_name = f"{first} {last}".strip()
        if not full_name:
            continue

        # Candidate values for blank-fill (excludes name fields, is_jobs_contact).
        candidates = {
            "email": email or None,
            "current_title": title or None,
            "current_company": company_name or None,
            "linkedin_url": linkedin or None,
            "notes": combined_notes or None,
        }

        try:
            # ── 1. Match by airtable_id ──
            row = await conn.fetchrow(
                f"SELECT contact_id, airtable_id, contact_stage, "
                f"{', '.join(FILL_COLUMNS)} FROM public.contacts WHERE airtable_id=$1",
                at_id,
            )
            matched_via = None
            if row:
                matched_via = "airtable"
            else:
                # ── 2. Match by exact email (case-insensitive) ──
                if email:
                    row = await conn.fetchrow(
                        f"SELECT contact_id, airtable_id, contact_stage, "
                        f"{', '.join(FILL_COLUMNS)} FROM public.contacts "
                        f"WHERE lower(email)=lower($1) LIMIT 1",
                        email,
                    )
                    if row:
                        matched_via = "email"

            if row:
                updates = _fill_blanks(row, candidates)
                # Set airtable_id only when matched by email and DB row lacks one.
                if matched_via == "email" and _is_blank(row["airtable_id"]):
                    updates["airtable_id"] = at_id
                # Set contact_stage only when currently blank (never overwrite).
                if stage is not None and _is_blank(row["contact_stage"]):
                    updates["contact_stage"] = stage

                if updates:
                    set_cols = list(updates.keys())
                    set_clause = ", ".join(f"{c}=${i+2}" for i, c in enumerate(set_cols))
                    vals = [updates[c] for c in set_cols]
                    await conn.execute(
                        f"UPDATE public.contacts SET {set_clause}, updated_at=now() "
                        f"WHERE contact_id=$1",
                        row["contact_id"], *vals,
                    )
                    # Count only the true blank-fills (exclude airtable_id/stage bookkeeping).
                    fields_filled += sum(1 for c in set_cols if c in FILL_COLUMNS)

                if matched_via == "airtable":
                    matched_airtable += 1
                else:
                    matched_email += 1
            else:
                # ── 3. INSERT new — do NOT set is_jobs_contact (leave default) ──
                await conn.execute(
                    """
                    INSERT INTO public.contacts
                        (first_name, last_name, full_name, email, current_title,
                         current_company, linkedin_url, notes, source,
                         airtable_id, contact_stage)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    """,
                    first, last, full_name, email or None, title or None,
                    company_name or None, linkedin or None,
                    combined_notes or None, "airtable-jobs",
                    at_id, stage,
                )
                inserted += 1

        except asyncpg.UniqueViolationError as e:
            # Email / linkedin_url unique constraint collision → skip, never force.
            skipped_collision += 1
            print(f"  SKIP collision for {full_name} <{email or 'no-email'}> "
                  f"(airtable_id={at_id}): {e}")
        except Exception as e:
            skipped_collision += 1
            print(f"  SKIP {full_name} <{email or 'no-email'}> "
                  f"(airtable_id={at_id}): {type(e).__name__}: {e}")

    print(f"""
── Guarded re-pull summary ──
  Matched by airtable_id:        {matched_airtable}
  Matched by email:              {matched_email}
  Inserted (new):                {inserted}
  Skipped (collision/error):     {skipped_collision}
  Blank fields filled:           {fields_filled}
""")

    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
