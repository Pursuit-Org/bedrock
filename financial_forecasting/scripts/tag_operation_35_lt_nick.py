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

IDs, NOT NAMES, are the input. Each name below was resolved against
public.contacts once (2026-08-18) and the contact_id frozen here, so a re-run
cannot silently pick a different row as the table changes. Five names matched
more than one row and were disambiguated on the title supplied with the batch;
those calls are marked WHY below. Four names had no match at all and are listed
in UNRESOLVED so they stay visible instead of vanishing into a count.

Guarded: before writing, the script re-reads every id and aborts if a full_name
no longer matches the name recorded here (a merge or a rename since resolution).

    python3 scripts/tag_operation_35_lt_nick.py              # dry run (default)
    python3 scripts/tag_operation_35_lt_nick.py --apply
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

# In the batch, absent from public.contacts. Searched on surname, on the full
# name, and on nickname/spelling variants (Cassandra Moulton, Mary Tunney) —
# no row. They need creating before they can be tagged; that is a separate ask.
UNRESOLVED = [
    ("Alex Vannoni",  "Head of Healthcare Product"),
    ("Cassie Moulton", ""),
    ("Marry Tunney",   ""),
    ("Bruce Taylor",  "Chairman/ CEO"),
]

# Names resolved here whose stored full_name differs from the batch spelling.
# The guard compares against these instead of the batch name.
STORED_NAME_OVERRIDES = {
    47298: "Benjamin Sun",
    24059: "Peter Johnson (PJ)",
}


def _norm(s: str | None) -> str:
    return " ".join((s or "").split()).casefold()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="write the changes; without it the script only reports")
    args = ap.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    ids = [cid for cid, _ in CONTACTS]
    if len(set(ids)) != len(ids):
        print("duplicate contact_id in CONTACTS", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(
            "SELECT contact_id, full_name, current_company, contact_stage, "
            "       is_jobs_contact, coalesce(tags, '{}'::text[]) AS tags "
            "  FROM public.contacts WHERE contact_id = ANY($1::int[])",
            ids)
        by_id = {r["contact_id"]: r for r in rows}

        # Guard: every id must still exist, still be live, and still be the
        # person we resolved. Abort the whole batch on any drift — a partial
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

        to_tag = [cid for cid, _ in CONTACTS if TAG not in by_id[cid]["tags"]]
        to_flag = [cid for cid, _ in CONTACTS if not by_id[cid]["is_jobs_contact"]]
        already = [cid for cid, _ in CONTACTS if TAG in by_id[cid]["tags"]]

        print(f"resolved      {len(CONTACTS)} contacts")
        print(f"unresolved    {len(UNRESOLVED)} names (not in public.contacts): "
              + ", ".join(n for n, _ in UNRESOLVED))
        print(f"already {TAG}: {len(already)} — left untouched: "
              + ", ".join(f"{by_id[c]['full_name']} ({c})" for c in already))
        print(f"tag to add    {len(to_tag)}")
        print(f"prospect flag {len(to_flag)} to set true "
              f"({len(CONTACTS) - len(to_flag)} already true)")

        if not args.apply:
            print("\nDRY RUN — nothing written. Re-run with --apply.")
            for cid, name in CONTACTS:
                r = by_id[cid]
                mark = "skip" if cid in already else " tag"
                flag = "" if r["is_jobs_contact"] else "  +prospect"
                print(f"  {mark} {cid:>6} {r['full_name']:<26} "
                      f"{(r['current_company'] or '-'):<34} "
                      f"tags=[{','.join(r['tags']) or '-'}]{flag}")
            return 0

        async with conn.transaction():
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
