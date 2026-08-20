"""Apply a .sql migration file as the Postgres superuser.

Some bedrock tables (jobs_task, jobs_comment, jobs_role, public.contacts) are
owned by `postgres`, so the app role (DATABASE_URL / bedrock_user) can't ALTER
them. This connects with the PG_* superuser creds and runs the given file.

Reads PG_USER/PG_PASSWORD/PG_HOST/PG_PORT/PG_DATABASE from the environment or a
.env. If they live in another service's .env, point at it:

    python -m scripts.apply_sql db/migrations/2026-06-18-jobs-parent-account.sql --env ../platform/server/.env
"""
import argparse
import asyncio
import os
import sys

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


async def main(path: str) -> None:
    import asyncpg

    sql = open(path).read()
    conn = await asyncpg.connect(_su_dsn(), timeout=30)
    try:
        await conn.execute(sql)
        print(f"applied {path} as {os.environ['PG_USER']}")
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("sql_file")
    ap.add_argument("--env", help="path to a .env with PG_* superuser creds")
    args = ap.parse_args()
    if args.env:
        load_dotenv(args.env, override=True)
    else:
        load_dotenv()
    asyncio.run(main(args.sql_file))
