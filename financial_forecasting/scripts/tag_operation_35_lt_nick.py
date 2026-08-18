"""Tag a named batch of contacts with 'operation_35_lt_nick' (Kwame, 2026-08-18).

WHAT THIS IS: a bulk version of two actions the Contacts page already supports
per-row — the "Jobs prospect" checkbox (public.contacts.is_jobs_contact) and the
Tags picker (public.contacts.tags). No schema change, no new catalog row: the
'operation_35_lt_nick' slug has existed since 2026-08-07-operation-35-tags.sql.
64 names by hand is the only reason this is a script.

ADDITIVE ONLY. Two guarantees the code enforces, not just intends:
  1. Existing tags are never touched. The write is array_append onto the current
     array, so curated tags (influence, staff_network, board, …) AND system
     markers (email_review) all survive. Note this deliberately differs from
     PATCH /api/jobs/contacts/{id}, which REPLACES the curated tag set — that
     endpoint is why doing this through the UI one contact at a time means
     re-sending every existing tag on every row.
  2. Contacts already carrying the tag are skipped by the WHERE clause, so the
     31 contacts tagged before today are untouched — including the three that
     also appear in this batch (Emma Bloomberg, Robin Selden, Phil Piro).
Nothing is ever unset: is_jobs_contact only goes false -> true, never true -> false.

IDs, NOT NAMES, are the input. Each name in CONTACTS was resolved against
public.contacts once (2026-08-18) and the contact_id frozen here, so a re-run
cannot silently pick a different row as the table changes. Five names matched
more than one row and were disambiguated on the title supplied with the batch,
then confirmed by Kwame; those calls are marked WHY below. As a cross-check every
resolved row's company was compared against the company column of the batch —
57 of 60 matched exactly and the three that differed were spelling variants of
the same employer, not different people.

CREATES: four names in the batch had no row at all. Kwame supplied their
companies and asked for them to be created and tagged, so NEW_CONTACTS inserts
them the same way POST /api/jobs/contacts does (source 'manual', a
manual-<uuid> airtable_id, contact_stage 'lead') and they then flow through the
same tag/flag pass as everyone else. The insert is keyed on name + company, so a
re-run reuses the row it made rather than adding a second one.

Guarded: before writing, the script re-reads every frozen id and aborts if a
full_name no longer matches the name recorded here (a merge or a rename since
resolution).

WHICH DATABASE: read from DATABASE_URL in financial_forecasting/.env, or from
--database-url. Per DEV_SETUP_GUIDE that .env points at the SHARED STAGING DB in
local dev, not production — so running this with a default local setup tags
staging and nothing shows up in the Bedrock the team uses. The script prints the
host and database name it connected to before doing anything, in both modes, so
the target is something you read rather than assume. (There is precedent: a dev
session silently wrote to the wrong DB on 2026-04-17.)

    python3 scripts/tag_operation_35_lt_nick.py              # dry run (default)
    python3 scripts/tag_operation_35_lt_nick.py --apply
    python3 scripts/tag_operation_35_lt_nick.py --database-url "$PROD_DATABASE_URL" --apply
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

TAG = "operation_35_lt_nick"

# (contact_id, name as supplied in the batch)
CONTACTS: list[tuple[int, str]] = [
    (20119, "James Kvaal"),
    (23434, "Evan Stone"),
    (24294, "Sharyar Aziz"),
    (23229, "Lindsay Vail Clark"),
    (24116, "Matt Virtue"),
    # WHY 24059: two Peter Johnsons. 24059 is "Peter Johnson (PJ)", Co-Founder at
    # Reach — an exact title match. 22782 is a Senior Director at Avison Young.
    (24059, "Peter Johnson (PJ)"),
    (23296, "Sarah Toomey Peaslee"),
    (24211, "Will Gahagan"),
    (24243, "Samuel Goldsmith"),
    (24146, "Alex Faherty"),
    (22622, "Lenny Mendonca"),
    (19992, "Ericka Miller"),
    (12308, "Joey Mejias"),
    (24234, "Joyce Lin"),
    (21349, "Luke Cohler"),
    (23975, "Jason Guss"),
    (22797, "Zander Sebenius"),
    (23522, "Libby van Beuren"),
    (21505, "Sita Chantramonklasri"),
    (24150, "William Reed"),
    (22317, "Paul Needham"),
    (20626, "Paul Toomath"),
    (22716, "Colby Farber"),
    (24123, "Garrett Spitzer"),
    # WHY 22720: two Vijay Kedars, both at Tomorrow Health. 22720 carries the
    # title ("Co-Founder and CEO"), the email and four tags; 33262 is an empty
    # airtable-jobs stub. Merging the two is a separate call, not this batch.
    (22720, "Vijay Kedar"),
    (10819, "annie rittgers"),
    (21909, "Bob DeAngelo"),
    (22363, "Jarrett McGovern"),
    (23223, "Nasir C. Qadree"),
    (22413, "Rebecca Sanders"),
    (23057, "Olivia Bercow"),
    (24185, "Nicholas Thorne"),
    (33735, "Soo Kim"),
    (22828, "Damola Adamolekun"),
    (24102, "Josh Gordon"),
    (23830, "Dixon Mallory"),
    (21994, "Seth Harper"),
    (16366, "Valerie Avila"),
    (26749, "Tony Xu"),
    (2424,  "Sarah Favreau"),
    (19786, "Emma Bloomberg"),          # already tagged — skipped by the WHERE
    (6676,  "Brandon Levesque"),
    (18054, "Bari Greenfield"),
    (15991, "Tiffany Reaves"),
    (30596, "Pamela Lewy"),
    (23020, "Lindsay Zara"),
    (1373,  "Susan Warner"),
    (34615, "Dara Khosrowshahi"),
    # WHY 4738: two Raymond Lius. 4738 is "VP, International" at MLB — an exact
    # title match. 50663 is a bare email_candidate stub with no title or company.
    (4738,  "Raymond Liu"),
    (2276,  "Julie Samuels"),
    (5531,  "Iain Roberts"),
    (33961, "Antonio Gonzalez"),
    (11570, "Jen Hensley"),
    (20512, "William Gaybrick"),
    (23462, "Sam Hanson"),
    # WHY 23981: two Robin Seldens. 23981 is "Business Operations" at Selden
    # Catering — title match, and it already carries the tag. 33273 is an empty stub.
    (23981, "Robin Selden"),            # already tagged — skipped by the WHERE
    (31415, "Ghislaine Liendo Vidal"),
    # WHY 12434: three Sophia Schneiders. 12434 is titled "Events" (Uniswap Labs)
    # — an exact title match. 46365 is Pursuit staff (sophiaschneider@pursuit.org),
    # a different person; 51830 is a bare email_candidate stub.
    (12434, "Sophia Schneider"),
    # "Ben Sun, Founder" — stored as "Benjamin Sun" (ben@bensun.net, Primary VC).
    (47298, "Ben Sun"),
    (33058, "Phil Piro"),               # already tagged — skipped by the WHERE
]

# In the batch, absent from public.contacts — searched on surname, on the full
# name, on nickname/spelling variants (Cassandra Moulton, Mary Tunney) and on the
# company. Created here rather than dropped, per Kwame.
#
# Company spelling follows what is already in the table where the employer is
# unambiguously the same one, so the contact rolls up to the existing account
# (accounts key on lower(trim(current_company))):
#   WHOOP     — 6 contacts already stored under that casing, not "Whoop"
#   Lovevery  — the company's own spelling; the batch read "LoveEvery"
# The other two are taken verbatim from the batch:
#   Taylor Farms  — no contact at that company yet, so nothing to match
#   Vail Mountain — the table has "Vail Resorts" (5 contacts). Vail Mountain is
#                   a Vail Resorts property, but they are not the same string
#                   and picking one is a business call, so the batch's wording
#                   stands and this rolls up as its own account. Flagged to
#                   Kwame; a one-field edit on the Contacts page moves it.
#
# (full_name, current_title, current_company)
NEW_CONTACTS: list[tuple[str, str | None, str]] = [
    ("Alex Vannoni",  "Head of Healthcare Product", "WHOOP"),
    ("Cassie Moulton", None,                        "Vail Mountain"),
    ("Marry Tunney",   None,                        "Lovevery"),
    ("Bruce Taylor",  "Chairman/ CEO",              "Taylor Farms"),
]

# Names resolved here whose stored full_name differs from the batch spelling.
# The guard compares against these instead of the batch name.
STORED_NAME_OVERRIDES = {
    47298: "Benjamin Sun",
    24059: "Peter Johnson (PJ)",
}


def _norm(s: str | None) -> str:
    return " ".join((s or "").split()).casefold()


async def _resolve_new(conn, apply: bool) -> tuple[list[int], list[str]]:
    """Find-or-create the four contacts that had no row. Returns (ids, notes).

    Keyed on name + company so a second run reuses the row the first run made.
    In dry-run nothing is inserted and the id list simply comes back short — the
    caller reports the creates it would do rather than pretending they exist.
    """
    import uuid

    ids, notes = [], []
    for full_name, title, company in NEW_CONTACTS:
        row = await conn.fetchrow(
            "SELECT contact_id, full_name FROM public.contacts "
            " WHERE lower(btrim(full_name)) = lower(btrim($1)) "
            "   AND lower(btrim(coalesce(current_company,''))) = lower(btrim($2)) "
            "   AND coalesce(contact_stage,'') <> 'merged' LIMIT 1",
            full_name, company)
        if row:
            ids.append(row["contact_id"])
            notes.append(f"  exists {row['contact_id']:>6} {full_name} — {company}")
            continue
        if not apply:
            notes.append(f"  CREATE    ---- {full_name} — {company}"
                         + (f" ({title})" if title else ""))
            continue
        first, _, last = full_name.partition(" ")
        cid = await conn.fetchval(
            "INSERT INTO public.contacts "
            "  (first_name, last_name, full_name, current_title, current_company, "
            "   source, airtable_id, contact_stage) "
            "VALUES ($1,$2,$3,$4,$5,'manual',$6,'lead') RETURNING contact_id",
            first, last, full_name, title, company,
            f"manual-{uuid.uuid4().hex[:8]}")
        ids.append(cid)
        notes.append(f"  created {cid:>6} {full_name} — {company}")
    return ids, notes


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="write the changes; without it the script only reports")
    ap.add_argument("--database-url", default=None,
                    help="target DB; overrides DATABASE_URL from .env")
    args = ap.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = args.database_url or os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set (or pass --database-url)", file=sys.stderr)
        return 1

    frozen = [cid for cid, _ in CONTACTS]
    if len(set(frozen)) != len(frozen):
        print("duplicate contact_id in CONTACTS", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(dsn)
    try:
        # Name the target before touching it. Staging and production differ only
        # by a substring buried in a URL, which is not a thing to eyeball.
        where = await conn.fetchrow(
            "SELECT current_database() AS db, "
            "       inet_server_addr()::text AS host, current_user AS role")
        src = "--database-url" if args.database_url else ".env DATABASE_URL"
        print(f"target: {where['db']} on {where['host'] or 'local socket'} "
              f"as {where['role']}  (from {src})\n")

        rows = await conn.fetch(
            "SELECT contact_id, full_name, current_company, contact_stage, "
            "       is_jobs_contact, coalesce(tags, '{}'::text[]) AS tags "
            "  FROM public.contacts WHERE contact_id = ANY($1::int[])",
            frozen)
        by_id = {r["contact_id"]: r for r in rows}

        # Guard: every frozen id must still exist, still be live, and still be
        # the person we resolved. Abort the whole batch on any drift — a partial
        # apply on a half-stale list is worse than doing nothing.
        problems = []
        for cid, name in CONTACTS:
            r = by_id.get(cid)
            if r is None:
                problems.append(f"{cid} ({name}): row is gone")
                continue
            if (r["contact_stage"] or "") == "merged":
                problems.append(f"{cid} ({name}): merged away")
            expected = STORED_NAME_OVERRIDES.get(cid, name)
            if _norm(r["full_name"]) != _norm(expected):
                problems.append(
                    f"{cid}: expected {expected!r}, found {r['full_name']!r}")
        if problems:
            print("ABORT — contact list is stale, re-resolve before running:",
                  file=sys.stderr)
            for p in problems:
                print(f"  {p}", file=sys.stderr)
            return 1

        already = [cid for cid, _ in CONTACTS if TAG in by_id[cid]["tags"]]
        to_tag  = [cid for cid, _ in CONTACTS if TAG not in by_id[cid]["tags"]]
        to_flag = [cid for cid, _ in CONTACTS if not by_id[cid]["is_jobs_contact"]]

        print(f"resolved      {len(CONTACTS)} contacts (ids frozen 2026-08-18)")
        print(f"to create     {len(NEW_CONTACTS)} contacts")
        print(f"already {TAG}: {len(already)} — left untouched: "
              + ", ".join(f"{by_id[c]['full_name']} ({c})" for c in already))
        print(f"tag to add    {len(to_tag)} existing + {len(NEW_CONTACTS)} new")
        print(f"prospect flag {len(to_flag)} of {len(CONTACTS)} existing to set true "
              f"({len(CONTACTS) - len(to_flag)} already true), plus all "
              f"{len(NEW_CONTACTS)} new rows = {len(to_flag) + len(NEW_CONTACTS)} total")

        if not args.apply:
            print("\nDRY RUN — nothing written. Re-run with --apply.")
            _, notes = await _resolve_new(conn, apply=False)
            print("\nnew contacts:")
            for n in notes:
                print(n)
            print("\nexisting contacts:")
            for cid, _name in CONTACTS:
                r = by_id[cid]
                mark = "skip" if cid in already else " tag"
                flag = "" if r["is_jobs_contact"] else "  +prospect"
                print(f"  {mark} {cid:>6} {r['full_name']:<26} "
                      f"{(r['current_company'] or '-'):<34} "
                      f"tags=[{','.join(r['tags']) or '-'}]{flag}")
            return 0

        # One transaction: the creates and the tag/flag pass land together, so a
        # failure can never leave four untagged contacts behind.
        async with conn.transaction():
            new_ids, notes = await _resolve_new(conn, apply=True)
            ids = frozen + new_ids
            flagged = await conn.execute(
                "UPDATE public.contacts SET is_jobs_contact = true, updated_at = now() "
                " WHERE contact_id = ANY($1::int[]) AND is_jobs_contact IS DISTINCT FROM true",
                ids)
            # array_append onto the existing array: purely additive, and the
            # WHERE keeps it idempotent across re-runs.
            tagged = await conn.execute(
                "UPDATE public.contacts "
                "   SET tags = array_append(coalesce(tags, '{}'::text[]), $2), "
                "       updated_at = now() "
                " WHERE contact_id = ANY($1::int[]) "
                "   AND NOT ($2 = ANY(coalesce(tags, '{}'::text[])))",
                ids, TAG)
        for n in notes:
            print(n)
        print(f"\nprospect flag set: {flagged}")
        print(f"tag added:         {tagged}")

        total = await conn.fetchval(
            "SELECT count(*) FROM public.contacts WHERE $1 = ANY(coalesce(tags,'{}'::text[]))",
            TAG)
        print(f"{TAG} now on {total} contacts")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
