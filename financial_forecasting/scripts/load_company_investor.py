"""Load the portfolio sheet into bedrock.company_investor.

Source: ~/employer-prospect-ranking/data/portfolio_all.csv, produced by that
repo's parse_portfolio_sheet.py from the "Portfolio_Pursuit_MultiFirm" Google
Sheet. 348 rows, 17 firms.

Idempotent — upserts on (account_key, firm), so a re-run after the sheet changes
refreshes rows in place. Nothing is deleted: a company dropping off the sheet
keeps its row rather than silently losing its portco status mid-quarter. Pass
--prune if you actually want the table to mirror the sheet exactly.

Run AFTER db/migrations/2026-08-05-company-investor.sql has been applied.

    python3 scripts/load_company_investor.py [--csv PATH] [--prune] [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

DEFAULT_CSV = Path.home() / "employer-prospect-ranking" / "data" / "portfolio_all.csv"

# CSV column → table column. The sheet's headers are lowercase already.
FIELDS = ("what_they_do", "currently_hiring", "tristate", "headcount", "stage",
          "majority_stake", "tier")


def norm(s: str | None) -> str | None:
    """Trim, and treat blank as NULL — the sheet uses '' for 'not recorded'."""
    v = (s or "").strip()
    return v or None


def account_key(name: str) -> str:
    """The jobs app's normalised company identity."""
    return name.strip().lower()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    ap.add_argument("--prune", action="store_true",
                    help="delete rows whose (account_key, firm) is no longer in the CSV")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.csv.exists():
        print(f"CSV not found: {args.csv}", file=sys.stderr)
        return 1

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    rows, skipped = [], 0
    for raw in csv.DictReader(args.csv.open()):
        company = (raw.get("company") or "").strip()
        firm = (raw.get("firm") or "").strip()
        if not company or not firm:
            skipped += 1          # a header artifact or a blank spacer row
            continue
        rows.append({
            "account_key": account_key(company),
            "company_name": company,
            "firm": firm,
            "firm_type": norm(raw.get("firm_type")),
            **{f: norm(raw.get(f)) for f in FIELDS},
        })

    keys = {(r["account_key"], r["firm"]) for r in rows}
    print(f"read {len(rows)} rows ({len(keys)} distinct company+firm pairs, "
          f"{len({r['account_key'] for r in rows})} companies, "
          f"{len({r['firm'] for r in rows})} firms)"
          + (f", skipped {skipped} blank" if skipped else ""))

    conn = await asyncpg.connect(dsn)
    try:
        if not await conn.fetchval("SELECT to_regclass('bedrock.company_investor') IS NOT NULL"):
            print("bedrock.company_investor does not exist — apply "
                  "db/migrations/2026-08-05-company-investor.sql first", file=sys.stderr)
            return 2

        before = await conn.fetchval("SELECT count(*) FROM bedrock.company_investor")
        if args.dry_run:
            print(f"[dry-run] table has {before} rows; would upsert {len(rows)}")
            # Report how much of the network this would actually band as portco —
            # the number that decides whether the rule is worth anything.
            reach = await conn.fetchval(
                """SELECT count(*) FROM public.staff_contact_relationships r
                   JOIN public.contacts c ON c.contact_id = r.contact_id
                   WHERE coalesce(c.contact_stage,'') <> 'merged'
                     AND lower(btrim(coalesce(c.current_company,''))) = ANY($1::text[])""",
                sorted({r["account_key"] for r in rows}))
            total = await conn.fetchval(
                """SELECT count(*) FROM public.staff_contact_relationships r
                   JOIN public.contacts c ON c.contact_id = r.contact_id
                   WHERE coalesce(c.contact_stage,'') <> 'merged'""")
            print(f"[dry-run] would mark {reach} of {total} network connections as portco")
            return 0

        async with conn.transaction():
            await conn.executemany(
                """INSERT INTO bedrock.company_investor
                     (account_key, company_name, firm, firm_type, what_they_do,
                      currently_hiring, tristate, headcount, stage, majority_stake, tier,
                      source, loaded_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'portfolio_sheet',now())
                   ON CONFLICT (account_key, firm) DO UPDATE SET
                     company_name = EXCLUDED.company_name,
                     firm_type = EXCLUDED.firm_type,
                     what_they_do = EXCLUDED.what_they_do,
                     currently_hiring = EXCLUDED.currently_hiring,
                     tristate = EXCLUDED.tristate,
                     headcount = EXCLUDED.headcount,
                     stage = EXCLUDED.stage,
                     majority_stake = EXCLUDED.majority_stake,
                     tier = EXCLUDED.tier,
                     loaded_at = now()""",
                [(r["account_key"], r["company_name"], r["firm"], r["firm_type"],
                  r["what_they_do"], r["currently_hiring"], r["tristate"], r["headcount"],
                  r["stage"], r["majority_stake"], r["tier"]) for r in rows])

            if args.prune:
                gone = await conn.fetch(
                    """DELETE FROM bedrock.company_investor ci
                       WHERE ci.source = 'portfolio_sheet'
                         AND NOT (ci.account_key || '\x00' || ci.firm) = ANY($1::text[])
                       RETURNING ci.company_name, ci.firm""",
                    [f"{k}\x00{f}" for k, f in keys])
                for g in gone:
                    print(f"  pruned {g['company_name']} / {g['firm']}")

        after = await conn.fetchval("SELECT count(*) FROM bedrock.company_investor")
        print(f"done: {before} -> {after} rows")

        reach = await conn.fetchval(
            """SELECT count(*) FROM public.staff_contact_relationships r
               JOIN public.contacts c ON c.contact_id = r.contact_id
               LEFT JOIN bedrock.company_investor ci
                 ON ci.account_key = lower(btrim(coalesce(c.current_company,'')))
               WHERE coalesce(c.contact_stage,'') <> 'merged' AND ci.id IS NOT NULL""")
        print(f"network connections now at a portfolio company: {reach}")
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
