#!/usr/bin/env python3
"""Operation 35 — Pursuit: tag the contacts David Yang marked on the Pursuit
Network tab (2026-08-24, 15:42-15:59 UTC).

Per contact:
  1. append the 'operation_35_pursuit' tag        (additive only)
  2. set public.contacts.is_jobs_contact = true   (jobs prospect)
  3. add the team comment

The pipeline membership row is NOT written here: jobs_dev/jobs_team hold SELECT
only on bedrock.jobs_contact_membership and bedrock.jobs_membership_stage_history.
Do that half through the app, whose backend connects as bedrock_user:

    POST /api/jobs/contacts/flag-jobs   {"contact_ids": [...]}

(see op35-pursuit-dy-relationships-partB.sh). That endpoint runs the app's own
_flag_contacts path, so membership + stage history + the prospect flag are
written together and existing stages are never downgraded.

Guarantees, by construction:
  * tags are appended, never reordered or removed. Deliberately NOT the
    PATCH /contacts/{id} behaviour, which REPLACES the curated tag set.
  * comments are insert-only and deduped on exact content, so re-runs are
    no-ops and existing comments are untouched.
  * no DDL.

Dry run by default: does all the work in a transaction, prints real counts,
then rolls back.

    python3 scripts/op35_pursuit_dy.py            # dry run
    python3 scripts/op35_pursuit_dy.py --apply    # commit
"""
import os, sys, asyncio, asyncpg

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Keep identical to CONTACT_IDS in op35-pursuit-dy-relationships-partB.sh.
# The four marked (n) got a note from David but no thumbs/hiring-fit rating —
# delete them here and in part B if you only want the 12 he actually rated.
CONTACT_IDS = [
      882,  # Kalila Hoggard   DREAM
     2210,  # Greg Levin       New Leaf Climite      (n)
     7169,  # Bernie Mehl      Kisi                  (n)
    16563,  # Emma Pfohman     ABNY
    16711,  # My Chang         Asian Americans for Equality
    22827,  # Andrew Cone      MoMA PS1
    34154,  # Daniel Chait     Greenhouse Software
    34424,  # Justin Le        The Knot Worldwide
    34665,  # orta therox      Artsy
    34776,  # Jeff Byrnes      Peloton
    35409,  # Josh Goldberg    Codecademy
    36976,  # Erica Jain       Healthie
    42712,  # Neil Daftary     Codecademy
    45526,  # Howie Liu        Airtable
    37729,  # Zainab Ebrahimi  Skillshare            (n)
    45230,  # Barry McCarthy   Peloton               (n)
]

ACTOR = "kwame@pursuit.org"
TAG = "operation_35_pursuit"
COMMENT = "Tagged for Operation 35 Outreach based on DY Pursuit Relationship"


def db_url() -> str:
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env = os.path.join(HERE, ".env")
    if os.path.exists(env):
        for line in open(env):
            if line.strip().startswith("DATABASE_URL="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    print("DATABASE_URL not set and not found in financial_forecasting/.env", file=sys.stderr)
    sys.exit(1)


async def snapshot(conn, header):
    rows = await conn.fetch(
        """SELECT c.contact_id, c.full_name, c.current_company,
                  ($2 = ANY(coalesce(c.tags,'{}'))) AS has_tag,
                  c.is_jobs_contact,
                  coalesce(m.stage,'(part B)') AS stage,
                  (SELECT count(*) FROM bedrock.jobs_comment jc
                    WHERE jc.parent_type='prospect' AND jc.parent_id = c.contact_id::text
                      AND jc.content = $3) AS op35_comments
             FROM public.contacts c
             LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = c.contact_id
            WHERE c.contact_id = ANY($1::int[])
            ORDER BY c.full_name""",
        CONTACT_IDS, TAG, COMMENT)
    print(f"\n=== {header} " + "=" * (68 - len(header)))
    print(f"  {'tag':^5} {'jobs':^5} {'cmt':^4}  {'name':<22} {'company':<32} stage")
    for r in rows:
        print(f"  {'yes' if r['has_tag'] else ' - ':^5} "
              f"{'yes' if r['is_jobs_contact'] else ' - ':^5} "
              f"{r['op35_comments']:^4}  "
              f"{(r['full_name'] or '')[:22]:<22} "
              f"{(r['current_company'] or '')[:32]:<32} {r['stage']}")
    return rows


async def main():
    apply = "--apply" in sys.argv
    conn = await asyncpg.connect(db_url(), statement_cache_size=0)
    try:
        who = await conn.fetchrow("SELECT current_user AS u, current_database() AS d")
        print(f"connected as {who['u']} on {who['d']}")
        print(f"mode: {'APPLY (will commit)' if apply else 'DRY RUN (will roll back)'}")

        tx = conn.transaction()
        await tx.start()
        done = False
        try:
            await snapshot(conn, "BEFORE")

            missing = await conn.fetchval(
                """SELECT count(*) FROM unnest($1::int[]) AS cid
                    WHERE NOT EXISTS (SELECT 1 FROM public.contacts c
                                       WHERE c.contact_id = cid
                                         AND coalesce(c.contact_stage,'') <> 'merged')""",
                CONTACT_IDS)
            if missing:
                raise RuntimeError(f"{missing} target id(s) missing or merged — resolve before writing")

            # 1 ── tag: pure append, existing tags keep values AND order
            tagged = await conn.execute(
                """UPDATE public.contacts
                      SET tags = coalesce(tags,'{}') || ARRAY[$2::text], updated_at = now()
                    WHERE contact_id = ANY($1::int[])
                      AND NOT ($2 = ANY(coalesce(tags,'{}')))""",
                CONTACT_IDS, TAG)

            # 2 ── jobs prospect flag
            flagged = await conn.execute(
                """UPDATE public.contacts
                      SET is_jobs_contact = true, updated_at = now()
                    WHERE contact_id = ANY($1::int[]) AND NOT is_jobs_contact""",
                CONTACT_IDS)

            # 3 ── comment: insert-only, deduped on exact content
            commented = await conn.execute(
                """INSERT INTO bedrock.jobs_comment (parent_type, parent_id, author_email, content)
                   SELECT 'prospect', cid::text, $2, $3
                     FROM unnest($1::int[]) AS cid
                    WHERE NOT EXISTS (
                          SELECT 1 FROM bedrock.jobs_comment jc
                           WHERE jc.parent_type='prospect'
                             AND jc.parent_id = cid::text
                             AND jc.content = $3)""",
                CONTACT_IDS, ACTOR, COMMENT)

            print(f"\n  tagged   {tagged.split()[-1]}")
            print(f"  flagged  {flagged.split()[-1]}")
            print(f"  comments {commented.split()[-1]}")

            await snapshot(conn, "AFTER")

            # post-conditions
            for label, sql in (
                ("not tagged", "SELECT count(*) FROM public.contacts WHERE contact_id = ANY($1::int[]) "
                               "AND NOT ($2 = ANY(coalesce(tags,'{}')))"),
                ("not jobs prospects", "SELECT count(*) FROM public.contacts WHERE contact_id = ANY($1::int[]) "
                                       "AND NOT is_jobs_contact"),
            ):
                bad = await conn.fetchval(sql, CONTACT_IDS, TAG)
                if bad:
                    raise RuntimeError(f"guard failed: {bad} contact(s) {label}")
            bad = await conn.fetchval(
                """SELECT count(*) FROM unnest($1::int[]) AS cid
                    WHERE (SELECT count(*) FROM bedrock.jobs_comment jc
                            WHERE jc.parent_type='prospect' AND jc.parent_id = cid::text
                              AND jc.content = $2) <> 1""",
                CONTACT_IDS, COMMENT)
            if bad:
                raise RuntimeError(f"guard failed: {bad} contact(s) have a wrong comment count")

            if apply:
                await tx.commit()
                done = True
                print("\n>>> COMMITTED.")
                print(">>> Next: the pipeline rows — run")
                print(">>>   ./db/scripts/op35-pursuit-dy-relationships-partB.sh --apply")
            else:
                await tx.rollback()
                done = True
                print("\n>>> DRY RUN — everything above ran for real, now rolled back.")
                print(">>> Re-run with  --apply  to commit.")
        except Exception:
            if not done:
                try:
                    await tx.rollback()
                except Exception:
                    pass
            raise
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
