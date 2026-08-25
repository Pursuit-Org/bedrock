#!/usr/bin/env python3
"""Apply a Bedrock SQL migration over asyncpg, for machines with no psql.

Dry run (default) -- runs everything, reports the row counts, rolls back:
    python3 run_migration.py db/migrations/<file>.sql

Apply for real:
    python3 run_migration.py db/migrations/<file>.sql --apply

Reads DATABASE_URL from the environment. The migration file's own BEGIN/COMMIT
are stripped so this script owns the transaction -- that is what makes the dry
run possible, and it keeps apply-mode all-or-nothing exactly as psql would.
"""
import asyncio, os, re, sys

import asyncpg


class _Rollback(Exception):
    """Raised to unwind the dry-run transaction. Never escapes main()."""


def load_sql(path):
    with open(path) as fh:
        raw = fh.read()
    # Drop the file's own transaction control; this script supplies it.
    body = re.sub(r'(?im)^\s*(BEGIN|COMMIT)\s*;\s*$', '', raw)
    if not body.strip():
        sys.exit(f"{path}: nothing to run")
    return body


async def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    apply = '--apply' in sys.argv
    if len(args) != 1:
        sys.exit(__doc__)
    path = args[0]

    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        sys.exit("DATABASE_URL is not set. Export it first.")

    body = load_sql(path)
    conn = await asyncpg.connect(dsn)
    # Surface RAISE NOTICE from the migration (e.g. the skipped-funnel-stage
    # message) -- asyncpg swallows these otherwise.
    conn.add_log_listener(lambda _c, msg: print(f"NOTICE: {msg}"))
    try:
        db = await conn.fetchval('select current_database()')
        print(f"connected to {db}")
        print("MODE: APPLY (changes will be committed)" if apply
              else "MODE: DRY RUN (everything rolls back)")
        print("-" * 52)

        try:
            async with conn.transaction():
                # Simple-query protocol runs the whole multi-statement script,
                # DO blocks and temp tables included.
                await conn.execute(body)
                await report(conn)
                if not apply:
                    raise _Rollback
        except _Rollback:
            print("-" * 52)
            print("ROLLED BACK -- nothing was written.")
            print("Re-run with --apply to commit.")
            return

        print("-" * 52)
        print("COMMITTED.")
    finally:
        await conn.close()


async def report(conn):
    """Post-change state of the 29 Operation 35 contacts, inside the txn."""
    rows = await conn.fetch("""
        SELECT c.contact_id, c.full_name, c.current_company,
               c.tags @> ARRAY['operation_35_pursuit'] AS tagged,
               c.is_jobs_contact AS prospect,
               m.stage,
               EXISTS (SELECT 1 FROM bedrock.jobs_comment jc
                        WHERE jc.parent_type = 'prospect'
                          AND jc.parent_id = c.contact_id::text
                          AND jc.content = 'Added because >5 Builders Hired in the past'
                      ) AS commented
          FROM public.contacts c
          LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = c.contact_id
         WHERE c.contact_id = ANY($1::int[])
         ORDER BY c.full_name
    """, IDS)

    for r in rows:
        # The funnel stage is optional -- a SELECT-only role skips it by design
        # (see step 2 of the migration), so it is reported, not required.
        ok = r['tagged'] and r['prospect'] and r['commented']
        print(f"{'  ok ' if ok else ' MISS'} {r['full_name'][:26]:<26} "
              f"{(r['current_company'] or '')[:22]:<22} {r['stage'] or '(no stage)'}")

    print("-" * 52)
    print(f"{len(rows)}/29 contacts | "
          f"tagged {sum(bool(r['tagged']) for r in rows)} | "
          f"in pipeline {sum(bool(r['prospect']) for r in rows)} | "
          f"commented {sum(bool(r['commented']) for r in rows)}")
    staged = sum(bool(r['stage']) for r in rows)
    if staged < len(rows):
        print(f"funnel stage set on {staged}/{len(rows)} (optional -- needs bedrock_user)")


IDS = [45254, 36527, 34615, 5193, 45230, 45219, 45454, 27983, 45558, 33100,
       25263, 10770, 31502, 38202, 10678, 37824, 4779, 37617, 44987, 26749,
       35776, 34624, 17282, 30738, 35477, 45172, 33953, 33565, 45595]

if __name__ == '__main__':
    asyncio.run(main())
