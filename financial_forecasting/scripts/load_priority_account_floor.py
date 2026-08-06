"""Load the "Work now" quadrant into bedrock.priority_account_floor.

Source: the employer-prospect ranking's accounts_final.csv, which is what the
"Jobs priority list - July 2026" sheet was built from. Anyone at one of these
accounts is P2 at minimum on My Network.

STATIC by decision (Jac, 2026-08-06) — a snapshot, not a live sheet read. Re-run
this after re-quadranting. It REPLACES the whole snapshot rather than upserting:
an account that has dropped out of the quadrant must lose its floor, and an
upsert-only pass would leave it there forever.

    python3 scripts/load_priority_account_floor.py --dry-run
    python3 scripts/load_priority_account_floor.py
    python3 scripts/load_priority_account_floor.py --csv /path/to/exported_tab.csv
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

DEFAULT_CSV = Path.home() / "employer-prospect-ranking" / "out" / "accounts_final.csv"
# The quadrant label is prefixed, not exact — the full value is
# "Work now — exec-sponsored outreach". Matching on the prefix means an em-dash or
# a reworded suffix doesn't silently drop all 976 rows.
QUADRANT_PREFIX = "work now"
FLOOR_BAND = "P2"


def norm_key(name: str) -> str:
    return (name or "").strip().lower()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    ap.add_argument("--run-label", default=None,
                    help="free text recorded on every row, e.g. 'sheet export 2026-08-06'")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.csv.exists():
        print(f"CSV not found: {args.csv}", file=sys.stderr)
        return 1

    rows, seen, skipped = [], set(), 0
    for raw in csv.DictReader(args.csv.open()):
        quadrant = (raw.get("quadrant") or "").strip()
        if not quadrant.lower().startswith(QUADRANT_PREFIX):
            continue
        company = (raw.get("company") or "").strip()
        key = norm_key(company)
        if not key:
            skipped += 1
            continue
        if key in seen:          # two spellings folding to one key
            continue
        seen.add(key)

        def num(field, cast):
            v = (raw.get(field) or "").strip()
            try:
                return cast(v)
            except (TypeError, ValueError):
                return None

        rows.append((key, company, FLOOR_BAND, quadrant,
                     num("final_rank", int), num("combined_score", float),
                     args.run_label or f"{args.csv.name} {QUADRANT_PREFIX}"))

    print(f"read {len(rows)} '{QUADRANT_PREFIX}' accounts from {args.csv.name}"
          + (f", skipped {skipped} with no company name" if skipped else ""))
    if not rows:
        print("nothing matched — check the quadrant column and its wording", file=sys.stderr)
        return 1

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(dsn)
    try:
        if not await conn.fetchval("SELECT to_regclass('bedrock.priority_account_floor') IS NOT NULL"):
            print("bedrock.priority_account_floor does not exist — apply "
                  "db/migrations/2026-08-06-priority-account-floor.sql first", file=sys.stderr)
            return 2

        before = await conn.fetchval("SELECT count(*) FROM bedrock.priority_account_floor")
        keys = [r[0] for r in rows]
        # What this would actually change, measured the same way the banding does.
        reach, promote = await conn.fetchrow(
            """SELECT count(*) AS reach,
                      count(*) FILTER (
                        WHERE NOT (lower(btrim(coalesce(c.current_company,''))) ~ '^pursuit($|[^a-z])'
                              OR EXISTS (SELECT 1 FROM unnest(coalesce(c.tags,'{}'::text[])) t
                                         WHERE t LIKE 'alumni%'))) AS eligible
                 FROM public.staff_contact_relationships r
                 JOIN public.contacts c ON c.contact_id = r.contact_id
                WHERE coalesce(c.contact_stage,'') <> 'merged'
                  AND lower(btrim(coalesce(c.current_company,''))) = ANY($1::text[])""", keys)
        unmatched = await conn.fetchval(
            """SELECT count(*) FROM unnest($1::text[]) k
                WHERE NOT EXISTS (SELECT 1 FROM public.companies co
                                  WHERE lower(btrim(co.name)) = k)""", keys)
        print(f"  network contacts at these accounts: {reach}  "
              f"({promote} not blocked by the Pursuit/alumni exclusion)")
        print(f"  account names matching no company row: {unmatched} of {len(keys)}")

        if args.dry_run:
            print(f"[dry-run] table has {before} rows; would replace with {len(rows)}")
            return 0

        async with conn.transaction():
            # Full replace: a de-quadranted account must lose its floor.
            await conn.execute("DELETE FROM bedrock.priority_account_floor WHERE source = $1",
                               "employer_prospect_ranking")
            await conn.executemany(
                """INSERT INTO bedrock.priority_account_floor
                     (account_key, company_name, floor_band, quadrant, final_rank,
                      combined_score, source, run_label, loaded_at)
                   VALUES ($1,$2,$3,$4,$5,$6,'employer_prospect_ranking',$7, now())
                   ON CONFLICT (account_key) DO UPDATE SET
                     company_name = EXCLUDED.company_name,
                     floor_band = EXCLUDED.floor_band,
                     quadrant = EXCLUDED.quadrant,
                     final_rank = EXCLUDED.final_rank,
                     combined_score = EXCLUDED.combined_score,
                     run_label = EXCLUDED.run_label,
                     loaded_at = now()""", rows)
        after = await conn.fetchval("SELECT count(*) FROM bedrock.priority_account_floor")
        print(f"done: {before} -> {after} rows")
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
