"""Backfill bedrock.award rows for all currently-won award-eligible opportunities
(Grant, Donation, PBC, Debt / Equity, Other Fee For Service — see
services/awards_service.ELIGIBLE_STAGES_BY_RECORD_TYPE).

One-shot, idempotent. Re-running creates no duplicates (relies on the
partial UNIQUE INDEX on opportunity_id WHERE deleted_at IS NULL).

Authenticates to Salesforce using credentials in .env — no browser token needed.

Usage (from financial_forecasting/):

    # Verify which stages exist per record type and which are eligible
    python -m scripts.backfill_awards --verify-stages

    # Dry-run — counts only, no DB writes
    python -m scripts.backfill_awards --dry-run

    # Real run
    python -m scripts.backfill_awards --yes

Requires DATABASE_URL and Salesforce credentials in .env:
    SALESFORCE_USERNAME, SALESFORCE_PASSWORD, SALESFORCE_DOMAIN
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional

import asyncpg
from datetime import date
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.awards_service import (  # noqa: E402
    ELIGIBLE_STAGES_BY_RECORD_TYPE,
    is_award_eligible,
    initial_award_status,
)

load_dotenv(override=False)
logger = logging.getLogger("backfill_awards")


# ── SF helpers ────────────────────────────────────────────────────────────


def _build_sf_client():
    from simple_salesforce import Salesforce

    instance = os.getenv("SF_INSTANCE_URL")
    session_id = os.getenv("SF_SESSION_ID")
    if instance and session_id:
        return Salesforce(instance_url=instance, session_id=session_id)

    username = os.getenv("SALESFORCE_USERNAME")
    password = os.getenv("SALESFORCE_PASSWORD")
    domain = os.getenv("SALESFORCE_DOMAIN", "login")
    client_id = os.getenv("SALESFORCE_CLIENT_ID")
    client_secret = os.getenv("SALESFORCE_CLIENT_SECRET")
    token = os.getenv("SALESFORCE_SECURITY_TOKEN", "")

    if not (username and password):
        raise SystemExit(
            "No SF credentials found. Set SALESFORCE_USERNAME + SALESFORCE_PASSWORD in .env"
        )

    # Try username+password with connected app credentials (no security token
    # needed when org has trusted IP ranges)
    if client_id and client_secret:
        try:
            return Salesforce(
                username=username,
                password=password,
                security_token=token,
                consumer_key=client_id,
                consumer_secret=client_secret,
                domain=domain,
            )
        except Exception:
            pass

    # Fallback: plain username+password+security_token
    return Salesforce(
        username=username,
        password=password,
        security_token=token,
        domain=domain,
    )


def _verify_stages(sf) -> None:
    rt_result = sf.query_all("SELECT Id, Name FROM RecordType WHERE SObjectType = 'Opportunity' ORDER BY Name")
    record_types = {r["Id"]: r["Name"] for r in rt_result.get("records", [])}

    stage_result = sf.query_all(
        "SELECT RecordTypeId, StageName, COUNT(Id) total "
        "FROM Opportunity WHERE IsDeleted = false "
        "GROUP BY RecordTypeId, StageName ORDER BY RecordTypeId, COUNT(Id) DESC"
    )

    from collections import defaultdict
    by_rt: Dict[str, List] = defaultdict(list)
    for r in stage_result.get("records", []):
        rt_name = record_types.get(r.get("RecordTypeId"), "(none)")
        by_rt[rt_name].append((r.get("StageName") or "(null)", r.get("total", 0)))

    eligible_rts = set(ELIGIBLE_STAGES_BY_RECORD_TYPE.keys())
    for rt_name in sorted(by_rt.keys()):
        marker = "✅" if rt_name in eligible_rts else "  "
        print(f"\n  {marker} {rt_name}")
        print(f"    {'StageName':<55} {'Count':>8}   {'Backfilled?'}")
        print(f"    {'-'*55} {'-'*8}   {'-'*11}")
        for stage, count in by_rt[rt_name]:
            eligible_stages = ELIGIBLE_STAGES_BY_RECORD_TYPE.get(rt_name, frozenset())
            flag = "✅ yes" if stage in eligible_stages else "❌ no"
            print(f"    {stage:<55} {count:>8}   {flag}")
    print()


def _query_eligible_opps(sf) -> List[Dict[str, Any]]:
    all_stages: set = set()
    for stages in ELIGIBLE_STAGES_BY_RECORD_TYPE.values():
        all_stages.update(stages)
    rt_names = sorted(ELIGIBLE_STAGES_BY_RECORD_TYPE.keys())
    stage_clause = ", ".join(f"'{s}'" for s in sorted(all_stages))
    rt_clause = ", ".join(f"'{rt}'" for rt in rt_names)
    soql = (
        "SELECT Id, Name, StageName, CloseDate, RecordType.Name "
        "FROM Opportunity "
        f"WHERE RecordType.Name IN ({rt_clause}) "
        f"  AND StageName IN ({stage_clause}) "
        "  AND IsDeleted = false"
    )
    result = sf.query_all(soql)
    return [
        {
            "Id": r.get("Id"),
            "Name": r.get("Name"),
            "StageName": r.get("StageName"),
            "CloseDate": r.get("CloseDate"),
            "RecordTypeName": (r.get("RecordType") or {}).get("Name"),
        }
        for r in result.get("records", [])
    ]


# ── DB helpers ────────────────────────────────────────────────────────────


async def _connect_db() -> asyncpg.Connection:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL is not set.")
    return await asyncpg.connect(db_url)


async def _insert_awards(
    conn: asyncpg.Connection,
    opps: Iterable[Dict[str, Any]],
    *,
    dry_run: bool,
) -> Dict[str, int]:
    counts: Dict[str, int] = {"eligible": 0, "inserted": 0, "skipped_existing": 0}
    for opp in opps:
        if not is_award_eligible(opp["StageName"], opp["RecordTypeName"]):
            continue
        counts["eligible"] += 1

        if dry_run:
            continue

        existing = await conn.fetchval(
            "SELECT id FROM bedrock.award "
            "WHERE opportunity_id = $1 AND deleted_at IS NULL",
            opp["Id"],
        )
        if existing:
            counts["skipped_existing"] += 1
            continue

        await conn.execute(
            """
            INSERT INTO bedrock.award
                (opportunity_id, award_status, award_date, notes)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            """,
            opp["Id"],
            initial_award_status(opp["StageName"]),
            date.fromisoformat(opp["CloseDate"]) if opp.get("CloseDate") else None,
            f"Backfilled 2026-05-02 from SF stage={opp['StageName']}",
        )
        counts["inserted"] += 1
    return counts


# ── Entrypoint ────────────────────────────────────────────────────────────


async def _main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="Count only, no DB writes.")
    parser.add_argument("--verify-stages", action="store_true",
                        help="Print per-record-type stage distribution and exit.")
    parser.add_argument("--yes", action="store_true",
                        help="Confirm production write.")
    args = parser.parse_args(argv)

    if not (args.dry_run or args.verify_stages or args.yes):
        parser.error("Pass --dry-run, --verify-stages, or --yes.")

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    print("  Connecting to Salesforce…")
    sf = _build_sf_client()
    print(f"  Connected as {sf.sf_type} — {sf.base_url}\n")

    if args.verify_stages:
        _verify_stages(sf)
        return 0

    print(f"  Backfill mode: {'DRY-RUN' if args.dry_run else 'WRITE'}")
    opps = _query_eligible_opps(sf)
    print(f"  SF returned {len(opps)} eligible opps.\n")

    conn = await _connect_db()
    try:
        counts = await _insert_awards(conn, opps, dry_run=args.dry_run)
    finally:
        await conn.close()

    print("  Summary:")
    print(f"    eligible (passed predicate): {counts['eligible']}")
    print(f"    inserted:                    {counts['inserted']}")
    print(f"    skipped (already existed):   {counts['skipped_existing']}\n")

    if args.dry_run:
        print("  (Dry run — no writes performed. Re-run with --yes to apply.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
