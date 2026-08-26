"""Apply db/migrations/2026-06-17-jobs-roles-v2.sql as a superuser.

bedrock.jobs_role is owned by `postgres`, so the app role (bedrock_user via
DATABASE_URL) can't ALTER it. This connects with the PG_* superuser creds.

Usage (from financial_forecasting/):
    python -m scripts.apply_jobs_roles_v2

Reads PG_USER/PG_PASSWORD/PG_HOST/PG_PORT/PG_DATABASE from the environment or a
.env. If they're not in this app's .env, point at the one that has them, e.g.:
    python -m scripts.apply_jobs_roles_v2 --env ../platform/server/.env
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv


def _su_dsn() -> str:
    missing = [k for k in ("PG_USER", "PG_PASSWORD", "PG_HOST", "PG_DATABASE") if not os.getenv(k)]
    if missing:
        print(f"ERROR: missing superuser env vars: {', '.join(missing)}", file=sys.stderr)
        print("Pass --env <path-to-.env-with-PG_*> or export them.", file=sys.stderr)
        sys.exit(1)
    port = os.getenv("PG_PORT", "5432")
    return (
        f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}"
        f"@{os.environ['PG_HOST']}:{port}/{os.environ['PG_DATABASE']}"
    )


async def main(sql_path: Path) -> None:
    import asyncpg

    sql = sql_path.read_text()
    conn = await asyncpg.connect(_su_dsn(), timeout=30)
    try:
        who = await conn.fetchval("SELECT current_user")
        print(f"connected as {who}; applying {sql_path.name} …")
        await conn.execute(sql)
        cols = await conn.fetch(
            """SELECT column_name FROM information_schema.columns
               WHERE table_schema='bedrock' AND table_name='jobs_role'
                 AND column_name IN ('commitment','is_trial','converts_to_role_id',
                   'pay_rate','rate_period','end_date','pay_cadence','benefits',
                   'payment_schedule','negotiation_notes','jd_url')
               ORDER BY column_name"""
        )
        print("✓ applied. New columns present:", [c["column_name"] for c in cols])
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", default=".env", help="path to a .env containing PG_* superuser creds")
    args = ap.parse_args()
    load_dotenv(args.env)
    migration = Path(__file__).resolve().parent.parent / "db" / "migrations" / "2026-06-17-jobs-roles-v2.sql"
    asyncio.run(main(migration))
