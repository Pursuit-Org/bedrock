"""Jobs Scan entrypoint — scan watched companies' ATS boards for builder-fit roles.

Built to run as a Cloud Run Job on Cloud Scheduler, alongside nightly_sync.py.
Deliberately NOT part of the web app: different cadence, different failure domain.

    DATABASE_URL=...  python3 jobs_scan.py            # scan priority + secondary
    DATABASE_URL=...  python3 jobs_scan.py --tier priority
    DATABASE_URL=...  python3 jobs_scan.py --dry-run  # fetch + filter, no writes

Stage order is load-bearing (see docs/jobs-scan-design.md):

    fetch board list -> diff -> cheap pre-filter -> enrich comp -> comp band -> upsert

Enrichment costs one extra request per posting, so it runs only on pre-filter
survivors. Every drop is counted by reason and printed; silent truncation reads
as "covered everything" when it didn't.

Scoring is intentionally out of scope here. This job populates the triage queue
deterministically; LLM scoring is a separate pass so a scoring outage can never
block coverage.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from services.jobs_scan.fetchers import FetchError, ScannedRole, enrich_comp, fetch_board
from services.jobs_scan.filters import FunnelCounts, postfilter_comp, prefilter

try:
    import psycopg2
    from psycopg2.extras import Json, RealDictCursor, execute_values
except ImportError:  # pragma: no cover
    sys.exit("psycopg2 required. pip install psycopg2-binary")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("jobs_scan")

# 8 workers was the validated ceiling for these endpoints: months of weekly
# scans at this concurrency drew zero blocks.
MAX_WORKERS = 8
DEFAULT_TIERS = ("priority", "secondary")


@dataclass
class BoardTarget:
    board_id: str
    account_key: str
    display_name: str
    platform: str
    slug: str
    criteria_profile: str


@dataclass
class BoardOutcome:
    target: BoardTarget
    roles: list[ScannedRole]
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None


def connect():
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set")
    return psycopg2.connect(url)


def load_targets(conn, tiers: tuple[str, ...]) -> list[BoardTarget]:
    sql = """
        SELECT b.id::text AS board_id, c.account_key, c.display_name,
               b.platform, b.slug, c.criteria_profile
        FROM bedrock.jobs_watch_board b
        JOIN bedrock.jobs_watch_company c ON c.account_key = b.account_key
        WHERE c.active
          AND NOT c.do_not_present
          AND c.tier = ANY(%s)
          AND b.status <> 'migrated'
        ORDER BY c.tier, c.display_name
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (list(tiers),))
        return [BoardTarget(**row) for row in cur.fetchall()]


def load_criteria(conn) -> dict[str, dict]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT name, version, body FROM bedrock.jobs_scan_criteria WHERE active"
        )
        return {
            row["name"]: {"version": row["version"], **(row["body"] or {})}
            for row in cur.fetchall()
        }


def scan_board(client: httpx.Client, target: BoardTarget) -> BoardOutcome:
    """Fetch one board. A per-company failure is recorded, never fatal."""
    try:
        roles = fetch_board(client, target.platform, target.slug)
        return BoardOutcome(target, roles)
    except FetchError as exc:
        return BoardOutcome(target, [], error=str(exc))
    except Exception as exc:  # noqa: BLE001 - one bad board must not kill the run
        logger.exception("unexpected error scanning %s/%s",
                         target.platform, target.slug)
        return BoardOutcome(target, [], error=f"unexpected: {exc}")


def upsert_roles(conn, target: BoardTarget, roles: list[ScannedRole],
                 criteria_version: str) -> tuple[int, int]:
    """Upsert scan rows. Returns (new_count, seen_count).

    ON CONFLICT refreshes last_seen_at and clears closed_at, so a role that
    reappears after being closed is revived rather than duplicated. Triage state
    is deliberately NOT reset -- a human's reject must survive re-scans.
    """
    if not roles:
        return 0, 0

    rows = [(
        target.account_key, r.platform, r.slug, r.external_job_id,
        r.title, r.location, r.is_remote, r.url, r.description,
        r.salary_min, r.salary_max, r.comp_source, Json(r.raw or {}),
        r.posted_at, criteria_version, getattr(r, "drop_reason", None),
    ) for r in roles]

    sql = """
        INSERT INTO bedrock.scraped_job_posting (
            account_key, platform, slug, external_job_id,
            title, location, is_remote, url, description,
            salary_min, salary_max, comp_source, raw,
            posted_at, criteria_version, drop_reason
        ) VALUES %s
        ON CONFLICT (platform, slug, external_job_id) DO UPDATE SET
            title = EXCLUDED.title,
            location = EXCLUDED.location,
            is_remote = EXCLUDED.is_remote,
            url = EXCLUDED.url,
            description = COALESCE(EXCLUDED.description,
                                   bedrock.scraped_job_posting.description),
            salary_min = COALESCE(EXCLUDED.salary_min,
                                  bedrock.scraped_job_posting.salary_min),
            salary_max = COALESCE(EXCLUDED.salary_max,
                                  bedrock.scraped_job_posting.salary_max),
            comp_source = CASE WHEN EXCLUDED.salary_min IS NOT NULL
                               THEN EXCLUDED.comp_source
                               ELSE bedrock.scraped_job_posting.comp_source END,
            raw = EXCLUDED.raw,
            last_seen_at = now(),
            closed_at = NULL,
            liveness = 'live',
            updated_at = now()
        RETURNING (xmax = 0) AS inserted
    """
    with conn.cursor() as cur:
        results = execute_values(cur, sql, rows, fetch=True)
    new_count = sum(1 for row in results if row[0])
    return new_count, len(rows)


def close_missing(conn, target: BoardTarget, seen_ids: list[str]) -> int:
    """Mark roles absent from a SUCCESSFUL scan as closed.

    Only ever called for a board that fetched cleanly. Closing on a failed scan
    would let a single 403 mark a whole company's roles dead.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE bedrock.scraped_job_posting
               SET closed_at = now(), updated_at = now()
             WHERE platform = %s AND slug = %s
               AND closed_at IS NULL
               AND NOT (external_job_id = ANY(%s))
            """,
            (target.platform, target.slug, seen_ids or [""]),
        )
        return cur.rowcount


def record_board_result(conn, outcome: BoardOutcome) -> None:
    """Update board health. A board going N->0 is a migration trigger."""
    role_count = len(outcome.roles)
    status_text = "ok" if outcome.ok else (outcome.error or "error")[:200]

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE bedrock.jobs_watch_board SET
                last_scan_at = now(),
                last_scan_status = %s,
                last_role_count = %s,
                -- Empty streaks only count on a SUCCESSFUL fetch; a network
                -- failure says nothing about whether the board is stale.
                consecutive_empty_scans = CASE
                    WHEN %s AND %s = 0 THEN consecutive_empty_scans + 1
                    WHEN %s THEN 0
                    ELSE consecutive_empty_scans END,
                status = CASE
                    WHEN %s AND %s > 0 THEN 'verified'
                    WHEN %s AND %s = 0 AND consecutive_empty_scans + 1 >= 3
                        THEN 'stale'
                    ELSE status END,
                verified_at = CASE WHEN %s AND %s > 0 THEN now() ELSE verified_at END,
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (status_text, role_count,
             outcome.ok, role_count, outcome.ok,
             outcome.ok, role_count, outcome.ok, role_count,
             outcome.ok, role_count,
             outcome.target.board_id),
        )


def run(tiers: tuple[str, ...], dry_run: bool, limit: Optional[int]) -> int:
    conn = connect()
    conn.autocommit = False
    try:
        targets = load_targets(conn, tiers)
        criteria_map = load_criteria(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    if limit:
        targets = targets[:limit]
    if not targets:
        logger.warning("no active boards for tiers %s — nothing to scan", tiers)
        return 0

    logger.info("scanning %d boards across tiers %s", len(targets), ",".join(tiers))

    counts = FunnelCounts()
    skipped: list[tuple[str, str]] = []
    totals = {"new": 0, "seen": 0, "closed": 0, "boards_ok": 0}

    with httpx.Client(follow_redirects=True) as client:
        outcomes: list[BoardOutcome] = []
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(scan_board, client, t): t for t in targets}
            for future in as_completed(futures):
                outcomes.append(future.result())

        for outcome in outcomes:
            target = outcome.target
            if not outcome.ok:
                skipped.append((target.display_name, outcome.error or "unknown"))
                if not dry_run:
                    record_board_result(conn, outcome)
                    conn.commit()
                continue

            totals["boards_ok"] += 1
            criteria = criteria_map.get(target.criteria_profile) or {}
            criteria_version = f"{target.criteria_profile}:v{criteria.get('version', 0)}"

            # Cheap filter on list data only.
            survivors, counts = prefilter(outcome.roles, criteria, counts)

            # Expensive stage, survivors only.
            for role in survivors:
                enrich_comp(client, role)
            survivors = postfilter_comp(survivors, criteria, counts)

            if dry_run:
                for role in survivors[:5]:
                    logger.info("  [dry] %s — %s (%s) %s-%s",
                                target.display_name, role.title, role.location,
                                role.salary_min, role.salary_max)
                continue

            try:
                new_count, seen = upsert_roles(conn, target, survivors, criteria_version)
                # Close against the FULL board, not just survivors: a role that
                # stopped matching our criteria is still open at the company.
                closed = close_missing(
                    conn, target, [r.external_job_id for r in outcome.roles]
                )
                record_board_result(conn, outcome)
                conn.commit()
            except Exception:
                conn.rollback()
                logger.exception("write failed for %s — rolled back", target.display_name)
                skipped.append((target.display_name, "db write failed"))
                continue

            totals["new"] += new_count
            totals["seen"] += seen
            totals["closed"] += closed
            if new_count:
                logger.info("%s: %d new, %d closed", target.display_name,
                            new_count, closed)

    conn.close()

    print("\n" + "=" * 62)
    print(f"  Jobs Scan {'(DRY RUN)' if dry_run else ''}")
    print("=" * 62)
    print(f"  boards targeted     {len(targets)}")
    print(f"  boards fetched OK   {totals['boards_ok']}")
    print(counts.render())
    print(f"  upserted (new)      {totals['new']}")
    print(f"  upserted (total)    {totals['seen']}")
    print(f"  marked closed       {totals['closed']}")

    # Skips are printed, never swallowed.
    if skipped:
        print(f"\n  SKIPPED BOARDS ({len(skipped)}):")
        for name, reason in skipped[:40]:
            print(f"    {name:<34} {reason[:70]}")
        if len(skipped) > 40:
            print(f"    ... and {len(skipped) - 40} more")
    print()

    # Non-zero when every board failed: that is an egress or credential problem,
    # not a quiet "no new jobs this week".
    return 1 if targets and totals["boards_ok"] == 0 else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", action="append", choices=["priority", "secondary", "archive"],
                    help="tier(s) to scan; repeatable. default: priority + secondary")
    ap.add_argument("--dry-run", action="store_true", help="fetch and filter, no writes")
    ap.add_argument("--limit", type=int, help="scan only the first N boards")
    args = ap.parse_args()
    tiers = tuple(args.tier) if args.tier else DEFAULT_TIERS
    return run(tiers, args.dry_run, args.limit)


if __name__ == "__main__":
    raise SystemExit(main())
