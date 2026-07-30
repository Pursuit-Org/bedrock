"""Apply the 2026-07-30 jobs migration set, in order, with verification.

One command instead of five, because two of these have an ordering constraint:
the employment_records DELETE grant must land before the placement-delete
endpoint is exercised, and the stage-history table must exist before Jobs Home
reads membership_stage_entered_at.

Prints a precondition check, applies each file (each is idempotent and wraps
itself in a transaction), then re-checks. Safe to re-run: already-applied files
are no-ops.

    cd ~/bedrock/financial_forecasting
    python -m scripts.apply_2026_07_30_jobs_migrations           # dry run
    python -m scripts.apply_2026_07_30_jobs_migrations --apply   # do it
"""
import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv

MIGRATIONS = [
    "db/migrations/2026-07-28-jobs-membership-stage-history.sql",
    "db/migrations/2026-07-30-employment-records-delete.sql",
    "db/migrations/2026-07-30-jobs-account-pbd-owner.sql",
    "db/migrations/2026-07-30-remove-tkt135-test-contact.sql",
    "db/migrations/2026-07-28-recurate-jobs-prospects-cleanup.sql",
]

# The recurate cleanup is the only irreversible-ish one (it clears a flag on
# ~837 contacts). Its own header promises a backup first, so enforce that.
BACKUP = os.path.expanduser("~/Desktop/is_jobs_contact_recurate_cleanup_2026-07-28.csv")

# hist_rows is fetched separately: a subquery against the history table fails to
# parse before the table exists, so it can't live in this statement.
CHECKS = """
SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema='bedrock' AND table_name='jobs_membership_stage_history') AS hist_table,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='bedrock' AND table_name='jobs_account' AND column_name='pbd_owner_name') AS pbd_col,
  (SELECT count(*) FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='employment_records'
       AND grantee='bedrock_user' AND privilege_type='DELETE') AS delete_grant,
  (SELECT count(*) FROM public.employment_records WHERE id IN (76, 91)) AS orphan_placements,
  (SELECT count(*) FROM public.contacts WHERE contact_id=54841) AS test_contact,
  (SELECT count(*) FROM public.contacts WHERE is_jobs_contact) AS jobs_prospects
"""


def _dsn() -> str:
    missing = [k for k in ("PG_USER", "PG_PASSWORD", "PG_HOST", "PG_DATABASE") if not os.getenv(k)]
    if missing:
        sys.exit(f"ERROR: missing superuser env vars: {', '.join(missing)}")
    return (
        f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}"
        f"@{os.environ['PG_HOST']}:{os.getenv('PG_PORT', '5432')}/{os.environ['PG_DATABASE']}"
    )


def _show(label, row, hist_rows):
    print(f"\n  {label}")
    print(f"    stage-history table   {'yes' if row['hist_table'] else 'NO':>6}  ({hist_rows} rows)")
    print(f"    pbd_owner_name column {'yes' if row['pbd_col'] else 'NO':>6}")
    print(f"    employment DELETE grant {'yes' if row['delete_grant'] else 'NO':>4}")
    print(f"    orphan placements 76/91  {row['orphan_placements']:>4}  (target 0)")
    print(f"    TKT-135 test contact     {row['test_contact']:>4}  (target 0)")
    print(f"    contacts flagged jobs    {row['jobs_prospects']:>4}")


async def _snapshot(conn):
    row = await conn.fetchrow(CHECKS)
    hist = await conn.fetchval(
        "SELECT count(*) FROM bedrock.jobs_membership_stage_history") if row["hist_table"] else "n/a"
    return row, hist


async def main(apply: bool) -> None:
    import asyncpg

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # ~/bedrock/financial_forecasting
    repo = os.path.dirname(root)                                        # ~/bedrock
    files = [(p, os.path.join(repo, p)) for p in MIGRATIONS]
    for rel, full in files:
        if not os.path.exists(full):
            sys.exit(f"ERROR: missing migration file {rel}")

    if not os.path.exists(BACKUP):
        sys.exit(f"ERROR: backup missing — {BACKUP}\nThe recurate cleanup requires it. Regenerate before applying.")
    backup_rows = sum(1 for _ in open(BACKUP)) - 1
    print(f"backup present: {backup_rows} contact ids in {BACKUP}")

    conn = await asyncpg.connect(_dsn(), timeout=30)
    try:
        _show("BEFORE", *await _snapshot(conn))
        if not apply:
            print("\n  (dry run — nothing applied. re-run with --apply)")
            print("  would apply, in order:")
            for rel, _ in files:
                print(f"    - {rel}")
            return
        print()
        for rel, full in files:
            sql = open(full).read()
            await conn.execute(sql)
            print(f"  applied {rel}")
        _show("AFTER", *await _snapshot(conn))
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually run them (default is a dry run)")
    ap.add_argument("--env", default=".env")
    a = ap.parse_args()
    load_dotenv(a.env)
    asyncio.run(main(a.apply))
