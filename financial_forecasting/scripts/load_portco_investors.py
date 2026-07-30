#!/usr/bin/env python3
"""Load investor → portfolio-company links from a curated portfolio sheet.

Reads scripts/data/portfolio_multifirm_top10.csv (exported from the
Portfolio_Pursuit_MultiFirm Google Sheet, "Top 10" tab) and:

  1. ensures every VC/PE firm exists as a public.companies row (the firm is a
     company like any other — that is what makes the hierarchy a self-join)
  2. resolves each portfolio company to a public.companies row by exact name
  3. stamps bedrock.jobs_account.company_id so the account points at an entity
     instead of only a display string
  4. upserts bedrock.company_investor

Deliberately does NOT guess: a portfolio company whose only same-named row in
our data is a DIFFERENT company (Flex/Flextronics, Coherent/Coherent Corp,
GARAGE/Garage Gym Reviews) is left unlinked and reported, because a wrong link
is worse than a missing one. Resolve those by hand, then re-run.

Idempotent. Dry run by default; pass --apply to commit.

    python3 scripts/load_portco_investors.py            # dry run
    python3 scripts/load_portco_investors.py --apply
"""
import csv
import os
import sys

import psycopg2
import psycopg2.extras

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, "data", "portfolio_multifirm_top10.csv")
SOURCE = "portfolio_sheet:Portfolio_Pursuit_MultiFirm"
AS_OF = "2026-07-24"          # sheet's last-modified date, not today
APPLY = "--apply" in sys.argv

# Firm label on the sheet → the name we store. Only for labels that are unsafe
# as-is: "Apollo" collides with The Apollo Opportunity Foundation already in our
# data, and "a16z" already exists as the fuller Andreessen Horowitz row.
FIRM_CANON = {
    "Apollo": "Apollo Global Management",
    "a16z": "Andreessen Horowitz",
}
INDUSTRY_BY_TYPE = {"VC": "Venture Capital", "PE": "Private Equity"}
ROLE_BY_STAKE = {"Yes": "majority", "No": "minority"}

# Portfolio company → the name it is actually filed under in public.companies.
# Same company, our row just carries the fuller legal name.
COMPANY_ALIAS = {
    "Crunch Fitness": "Crunch Fitness Corporate",
    "Life Time": "Life Time Inc.",
}

# Names where a row DOES exist under the exact name but is a different company,
# so exact-name resolution would confidently mislink. Verified 2026-07-30 by
# domain. Skipped until someone creates/renames the right row.
KNOWN_COLLISION = {
    "Coherent": "our row is coherent.com (Coherent Corp, photonics); the portco is the no-code SaaS (coherent.global)",
    "Flex":     "our row is Flex Ltd / Flextronics (5000+); the portco is the ~66-person fintech",
    "Garage":   "our row is garagegymreviews.com; the portco is the used-emergency-vehicle marketplace",
}


def load(cur):
    """Do the work on an open cursor. Caller owns the transaction — which is what
    lets the migration + this load be dry-run together and rolled back."""
    rows = list(csv.DictReader(open(CSV_PATH)))

    # ── firms ────────────────────────────────────────────────────────────────
    firms = {}
    for r in rows:
        firms.setdefault(FIRM_CANON.get(r["firm"], r["firm"]), r["firm_type"])

    firm_id, created_firms = {}, []
    for name, ftype in sorted(firms.items()):
        cur.execute("SELECT company_id, industry FROM public.companies "
                    "WHERE lower(trim(name)) = lower(%s) ORDER BY company_id LIMIT 1", (name,))
        hit = cur.fetchone()
        if hit:
            firm_id[name] = hit["company_id"]
            continue
        cur.execute("""INSERT INTO public.companies (name, source, industry, enrichment_source, enriched_at)
                       VALUES (%s, 'manual', %s, 'portfolio_sheet', now())
                       ON CONFLICT (lower(name)) DO NOTHING
                       RETURNING company_id""",
                    (name, INDUSTRY_BY_TYPE.get(ftype)))
        got = cur.fetchone()
        if got:
            firm_id[name] = got[0]
            created_firms.append(name)

    # ── portfolio companies ──────────────────────────────────────────────────
    linked, unresolved, acct_stamped = [], [], 0
    for r in rows:
        firm = FIRM_CANON.get(r["firm"], r["firm"])
        if r["company"] in KNOWN_COLLISION:
            unresolved.append((r["company"], firm, KNOWN_COLLISION[r["company"]]))
            continue
        lookup = COMPANY_ALIAS.get(r["company"], r["company"])
        cur.execute("SELECT company_id FROM public.companies "
                    "WHERE lower(trim(name)) = lower(%s) ORDER BY company_id LIMIT 1", (lookup,))
        hit = cur.fetchone()
        if not hit:
            unresolved.append((r["company"], firm, "no company row under this exact name"))
            continue
        cid = hit["company_id"]

        # point the jobs account at the entity (first time only; cheap and idempotent)
        cur.execute("""UPDATE bedrock.jobs_account SET company_id = %s, updated_at = now()
                        WHERE account_key = %s AND company_id IS DISTINCT FROM %s""",
                    (cid, r["account_key"], cid))
        acct_stamped += cur.rowcount

        cur.execute("""
            INSERT INTO bedrock.company_investor
                   (company_id, firm_company_id, role, confidence, source, as_of)
            VALUES (%s, %s, %s, 'reported', %s, %s)
            ON CONFLICT (company_id, firm_company_id) DO UPDATE
               SET role = EXCLUDED.role, source = EXCLUDED.source,
                   as_of = EXCLUDED.as_of, until = NULL, updated_at = now()
        """, (cid, firm_id[firm], ROLE_BY_STAKE.get(r["majority_stake"], "investor"),
              SOURCE, AS_OF))
        linked.append((r["company"], firm))

    print(f"firms:              {len(firms)} ({len(created_firms)} created: {', '.join(created_firms) or '—'})")
    print(f"investor links:     {len(linked)}")
    print(f"jobs_account.company_id stamped: {acct_stamped}")
    if unresolved:
        print(f"\nUNRESOLVED — left unlinked on purpose ({len(unresolved)}). "
              f"Resolve by hand, then re-run:")
        for name, firm, why in unresolved:
            print(f"  {name} ({firm}) — {why}")
    return {"firms": len(firms), "created_firms": created_firms,
            "links": len(linked), "stamped": acct_stamped, "unresolved": unresolved}


def main():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    load(cur)
    if APPLY:
        conn.commit()
        print("\nCOMMITTED")
    else:
        conn.rollback()
        print("\nDRY RUN — rolled back")


if __name__ == "__main__":
    main()
