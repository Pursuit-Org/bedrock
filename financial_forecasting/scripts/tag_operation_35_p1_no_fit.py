"""Tag the Operation 35 P1 / no-hiring-fit batch (Kwame, 2026-08-18).

Third batch in the pattern documented by `README-contact-tag-batches.md`.
Predecessors: `tag_operation_35_lt_nick.py`, then `tag_operation_35_lt_staff.py`
(which added the per-contact comment this one keeps).

WHERE THE BATCH CAME FROM. 141 contacts, derived in SQL, not from a pasted list:

  * closeness vote = 'expect_response' on bedrock.connection_status, AND
  * hiring_fit NEVER answered by anyone (NULL on every row for the contact), AND
  * My Network priority band = 'P1'.

The band is the important subtlety: P1 is NOT a stored tag. It is computed per
request by _net_priority_case() in routes/jobs.py from company headcount,
tri-state HQ and title seniority, with portfolio-company and account-floor
overrides. This batch was selected by running that exact CASE — extracted from
the source, not re-derived — against the closeness-yes / fit-untagged population.
Of that population (668) the bands split 141 P1 / 389 P2 / 138 unranked.

BECAUSE THE BAND IS COMPUTED, THE IDS ARE FROZEN HERE. A headcount refresh, a
LinkedIn title change, or a new row in bedrock.company_investor /
bedrock.priority_account_floor silently re-bands people. Re-deriving at apply
time would tag a different set than the one that was reviewed.

These 141 carry NO operation_35_* slug of any kind (verified 2026-08-18:
any_op35 = 0), so they were entirely absent from the Operation 35 tag set — they
fell out of the previous batch by omission, not judgment. Nobody answered the
hiring-fit question on them.

THE SPLIT, per Kwame:

  tagger                     tag                  comment
  ------------------------------------------------------------------------------
  joanna@pursuit.org  (50)   operation_35_lt      "Tagged for Operation 35 outreach by Joanna"
  david@pursuit.org   (6)    operation_35_lt      "Tagged for Operation 35 by Dave"
  everyone else       (85)   operation_35_staff   "Tagged for Operation 35 outreach by <name>"

NOTE THE WORDING IS NOT UNIFORM. Kwame's instruction quoted Joanna's line with
"outreach by" and Dave's without it, and said "do the same" between them. Both
strings are reproduced verbatim rather than normalised, because guessing which
one he meant would put invented text on 56 contacts. If they should match, change
COMMENT_JOANNA / COMMENT_DAVE below — it is a one-line edit each.

"tagger" here is whoever cast the closeness='expect_response' vote. No contact in
this batch has more than one such voter, so attribution is unambiguous — there is
no multi-name case like Benny Wong in the previous batch.

ADDITIVE ONLY, same guarantees as the predecessors:
  1. Tags written with array_append onto the current array. 77 of the 141 already
     carry a tag; all survive, as would the email_review system marker (none here
     have it). This deliberately differs from PATCH /api/jobs/contacts/{id},
     which REPLACES the curated tag set.
  2. The WHERE clause skips rows already holding the slug, so re-running is a
     no-op rather than a duplicate.
  3. Nothing is ever unset. is_jobs_contact only goes false -> true.

JOBS PROSPECT IS SET BY DEFAULT here — the opposite of the previous batch, and
deliberate. Kwame asked for it ("if these contacts are not job prospects please
add"), and the last batch's omission is exactly why the Contacts page showed only
5 of 24 LT rows under the "Jobs prospects" scope. 132 of the 141 are currently
false. He asked for it inside the Joanna paragraph and said "do the same" for
Dave; extending it to the 85 staff rows is an inference, so --prospect-scope
narrows it to the LT rows (or turns it off) without editing anything.

Setting the flag is not free: a new prospect lands in Total Leads and the funnel
counts, in the not-yet-assigned band (this script sets no pipeline stage).

COMMENTS land in bedrock.jobs_comment as real team comments — parent_type
'prospect', parent_id the contact_id as text, authored as Kwame (the person
running this), not as the staffer named in the text. Idempotent via a NOT EXISTS
on (parent_type, parent_id, content), since the table has no unique constraint.

WHICH DATABASE: DATABASE_URL from financial_forecasting/.env, or --database-url.
That .env points at segundo-db as jobs_dev, which is PRODUCTION. The script prints
the host and database it connected to first, in both modes. Read that line before
--apply. (Precedent: a dev session silently wrote to the wrong DB on 2026-04-17.)

    python3 scripts/tag_operation_35_p1_no_fit.py                          # dry run
    python3 scripts/tag_operation_35_p1_no_fit.py --apply
    python3 scripts/tag_operation_35_p1_no_fit.py --apply --prospect-scope lt
    python3 scripts/tag_operation_35_p1_no_fit.py --apply --prospect-scope none
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

TAG_LT = "operation_35_lt"
TAG_STAFF = "operation_35_staff"

# Comment author: whoever runs this is making the entry. Frozen rather than looked
# up so the attribution cannot drift.
COMMENT_AUTHOR_ID = "0103434c-399f-491e-8231-893fd033c7d3"
COMMENT_AUTHOR_EMAIL = "kwame@pursuit.org"

# Verbatim from Kwame's instruction. The asymmetry ("outreach by" vs "by") is his;
# see the docstring.
COMMENT_JOANNA = "Tagged for Operation 35 outreach by Joanna"
COMMENT_DAVE = "Tagged for Operation 35 by Dave"


def _staff_comment(who: str) -> str:
    return f"Tagged for Operation 35 outreach by {who}"


LT_TAGGERS = {"joanna@pursuit.org", "david@pursuit.org"}

# Display names for the staff comment, resolved 2026-08-18 from
# bedrock.sync_staff.display_name (all present there; staff_user_id_map agrees
# except jac@, where sync_staff's fuller "Jacqueline Reverand" is used).
# Only the non-LT taggers need an entry — Joanna's and Dave's lines are literal.
STAFF_NAMES = {
    "avni@pursuit.org": "Avni Nahar",
    "ericawong@pursuit.org": "Erica Wong",
    "guilherme@pursuit.org": "Guilherme Barros",
    "jac@pursuit.org": "Jacqueline Reverand",
    "joe@pursuit.org": "Joe Fabisevich",
    "johnny.nguyen@pursuit.org": "Johnny Nguyen",
    "laura@pursuit.org": "Laura Capucilli",
    "stefano@pursuit.org": "Stefano Barros",
    "victoriam@pursuit.org": "Victoria Mayo",
}


def _plan_for(tagger: str) -> tuple[str, str]:
    """(tag, comment body) for one contact, keyed on who voted closeness yes."""
    if tagger == "joanna@pursuit.org":
        return TAG_LT, COMMENT_JOANNA
    if tagger == "david@pursuit.org":
        return TAG_LT, COMMENT_DAVE
    return TAG_STAFF, _staff_comment(STAFF_NAMES[tagger])


# (contact_id, stored full_name, closeness-yes tagger email)
# ids frozen 2026-08-18; the set, every full_name and every tagger were compared
# against live data before this file was written (141/141, zero mismatches).
ASSIGN: list[tuple[int, str, str]] = [

    # ---- operation_35_lt — Joanna ----
    (1105, "Noam Mills", "joanna@pursuit.org"),
    (1150, "Maggie Diehl", "joanna@pursuit.org"),
    (1365, "Diego Ontaneda Benavides", "joanna@pursuit.org"),
    (3368, "Haruumi Shiode", "joanna@pursuit.org"),
    (5211, "Joe Zhou", "joanna@pursuit.org"),
    (5555, "Chuchu J Ajukwu", "joanna@pursuit.org"),
    (6557, "Liya Shuster-Bier", "joanna@pursuit.org"),
    (8248, "Taylor Babcock", "joanna@pursuit.org"),
    (8647, "Bill White", "joanna@pursuit.org"),
    (8654, "Holman Gao", "joanna@pursuit.org"),
    (8689, "Sofia Madden", "joanna@pursuit.org"),
    (8692, "Christina Pan", "joanna@pursuit.org"),
    (8734, "Andy Feis", "joanna@pursuit.org"),
    (8819, "Hunter Armistead", "joanna@pursuit.org"),
    (8851, "Peter Russell", "joanna@pursuit.org"),
    (8871, "Christian Battaglia", "joanna@pursuit.org"),
    (8880, "Greg Banbury", "joanna@pursuit.org"),
    (8887, "Jeff Nemetsky", "joanna@pursuit.org"),
    (8997, "Andrew Hennessy", "joanna@pursuit.org"),
    (9084, "Kyle DeVivo", "joanna@pursuit.org"),
    (9089, "Roni Alvandi", "joanna@pursuit.org"),
    (9135, "Francesco Balestra", "joanna@pursuit.org"),
    (9140, "Michael Kahn", "joanna@pursuit.org"),
    (9193, "Jonathan Slonim", "joanna@pursuit.org"),
    (9233, "David Davis", "joanna@pursuit.org"),
    (9337, "Richard Dulude", "joanna@pursuit.org"),
    (9340, "Jeff Hopfenbeck", "joanna@pursuit.org"),
    (9383, "Chad Olin", "joanna@pursuit.org"),
    (9408, "Hendrik Isebaert", "joanna@pursuit.org"),
    (9419, "Colin Fraser", "joanna@pursuit.org"),
    (9496, "Brian Alvarez", "joanna@pursuit.org"),
    (9499, "Erik Snyder", "joanna@pursuit.org"),
    (9558, "Kat Stillman", "joanna@pursuit.org"),
    (9614, "Nate Mazonson", "joanna@pursuit.org"),
    (9657, "Stuart Allan", "joanna@pursuit.org"),
    (9720, "Eytan Bensoussan", "joanna@pursuit.org"),
    (9796, "Andrew Seidman", "joanna@pursuit.org"),
    (9920, "Caitlin Bartley (Caitlin MacDonald)", "joanna@pursuit.org"),
    (9921, "Jonathan Scherr", "joanna@pursuit.org"),
    (10000, "Meeka Charles", "joanna@pursuit.org"),
    (10064, "Sander Duncan", "joanna@pursuit.org"),
    (10198, "JB Cholnoky", "joanna@pursuit.org"),
    (10259, "Greg Kalil", "joanna@pursuit.org"),
    (10780, "Ryan Chang", "joanna@pursuit.org"),
    (11364, "Chan Park", "joanna@pursuit.org"),
    (11583, "John Murphy", "joanna@pursuit.org"),
    (11929, "Matt Jorgensen", "joanna@pursuit.org"),
    (12095, "Ryan Good", "joanna@pursuit.org"),
    (12562, "John Murphy", "joanna@pursuit.org"),
    (12590, "Chris Lawlor", "joanna@pursuit.org"),

    # ---- operation_35_lt — Dave (David Yang) ----
    (2342, "Reshma Saujani", "david@pursuit.org"),
    (2893, "Bishop Mitchell G. Taylor", "david@pursuit.org"),
    (5652, "Ebony Young, MSOL", "david@pursuit.org"),
    (6784, "Jasmin Hume", "david@pursuit.org"),
    (6797, "Michael Movshovich", "david@pursuit.org"),
    (7111, "Jessica Lawrence Quinn, SPHR, CFRE", "david@pursuit.org"),

    # ---- operation_35_staff — avni ----
    (16718, "Jill Borrero", "avni@pursuit.org"),
    (16802, "Nikita Srivastava Rel", "avni@pursuit.org"),
    (16863, "Carly Oosten", "avni@pursuit.org"),
    (16917, "David Lee", "avni@pursuit.org"),
    (16959, "Adam Newman", "avni@pursuit.org"),
    (16975, "Louisa Caçoilo", "avni@pursuit.org"),
    (17004, "Benya Kraus", "avni@pursuit.org"),
    (17007, "Cairn Cross", "avni@pursuit.org"),
    (17306, "Olamide Babatunde", "avni@pursuit.org"),
    (17682, "Maria Flynn", "avni@pursuit.org"),
    (17873, "Barbara Carlson", "avni@pursuit.org"),
    (18112, "Kailey Burger Ayogu", "avni@pursuit.org"),
    (18393, "Bryan Bu", "avni@pursuit.org"),
    (18624, "Jonathan Jeffrey", "avni@pursuit.org"),
    (18936, "Austin Sowa", "avni@pursuit.org"),
    (19125, "Rachel Star", "avni@pursuit.org"),

    # ---- operation_35_staff — ericawong ----
    (2268, "Steven Lee", "ericawong@pursuit.org"),
    (2458, "Kalani Leifer", "ericawong@pursuit.org"),
    (3362, "Joshua Winter", "ericawong@pursuit.org"),
    (9110, "Ray Batra", "ericawong@pursuit.org"),
    (19773, "Peter Gault", "ericawong@pursuit.org"),
    (27347, "Philip Courtney", "ericawong@pursuit.org"),
    (27394, "Christina Brown", "ericawong@pursuit.org"),
    (27437, "Mary Zhu", "ericawong@pursuit.org"),
    (27621, "Jared Chung", "ericawong@pursuit.org"),
    (27745, "Dan Rhoton", "ericawong@pursuit.org"),
    (28030, "Christina Lewis", "ericawong@pursuit.org"),
    (28075, "Jim Shelton", "ericawong@pursuit.org"),
    (28091, "Daquan Oliver", "ericawong@pursuit.org"),
    (28131, "Jessica Patton", "ericawong@pursuit.org"),
    (28163, "Markus Ward", "ericawong@pursuit.org"),
    (28179, "Peter Boyce II", "ericawong@pursuit.org"),
    (28199, "Nathan Esquenazi", "ericawong@pursuit.org"),
    (28268, "Mandi Ndikum-Moffor, CPACC", "ericawong@pursuit.org"),
    (28326, "Dean Curnutt", "ericawong@pursuit.org"),
    (28333, "Rachel Rodriguez", "ericawong@pursuit.org"),
    (28486, "Tope Awotona", "ericawong@pursuit.org"),
    (28616, "Amanda Rosenblum", "ericawong@pursuit.org"),
    (28624, "Daniel Alejandro Leon-Davis", "ericawong@pursuit.org"),
    (29155, "Ethan Barhydt", "ericawong@pursuit.org"),
    (29266, "Ajay Suresh", "ericawong@pursuit.org"),
    (29408, "Jamie Lonie", "ericawong@pursuit.org"),
    (29433, "Jordan Watson", "ericawong@pursuit.org"),
    (29448, "Kelly Greenwood", "ericawong@pursuit.org"),
    (29462, "Kaleb Steinhauer", "ericawong@pursuit.org"),
    (29493, "Libby Falck", "ericawong@pursuit.org"),
    (29664, "Chris Garcia", "ericawong@pursuit.org"),
    (29812, "Harris Kenny", "ericawong@pursuit.org"),

    # ---- operation_35_staff — guilherme ----
    (10529, "John McIntosh John", "guilherme@pursuit.org"),
    (10576, "Kat Pattillo Kat", "guilherme@pursuit.org"),
    (31434, "Max Stier", "guilherme@pursuit.org"),
    (31448, "Liz Weingartner", "guilherme@pursuit.org"),
    (31563, "Luciana Frazao", "guilherme@pursuit.org"),
    (31735, "Sonia Aviv", "guilherme@pursuit.org"),
    (31827, "Fernando Fabre", "guilherme@pursuit.org"),
    (31864, "Alexandra Yellin", "guilherme@pursuit.org"),
    (31980, "Sasha Dichter", "guilherme@pursuit.org"),

    # ---- operation_35_staff — jac ----
    (5125, "David Dobrynin", "jac@pursuit.org"),

    # ---- operation_35_staff — joe ----
    (51208, "Chris Maddern", "joe@pursuit.org"),

    # ---- operation_35_staff — johnny.nguyen ----
    (26854, "Kamaal Martin", "johnny.nguyen@pursuit.org"),

    # ---- operation_35_staff — laura ----
    (24340, "Eli Tedesco", "laura@pursuit.org"),
    (24412, "Avdeep Dhillon", "laura@pursuit.org"),
    (24630, "C. Andrew Warren", "laura@pursuit.org"),
    (24713, "Anthony Dedousis", "laura@pursuit.org"),
    (24721, "Marc Ricks", "laura@pursuit.org"),
    (24737, "Lana Lee", "laura@pursuit.org"),
    (24819, "Christopher Macies", "laura@pursuit.org"),
    (25101, "Simon Lim", "laura@pursuit.org"),
    (25120, "Adam Ilowite", "laura@pursuit.org"),
    (25199, "Coby Lerner", "laura@pursuit.org"),
    (25316, "Camille van Horne", "laura@pursuit.org"),
    (25557, "Ben Jacobson", "laura@pursuit.org"),

    # ---- operation_35_staff — stefano ----
    (7772, "Winston Tuggle", "stefano@pursuit.org"),
    (7833, "Mark DeJong", "stefano@pursuit.org"),
    (7869, "Lucy Herz", "stefano@pursuit.org"),
    (7927, "Lauren Klein", "stefano@pursuit.org"),
    (7956, "Tanya Thompson (Mascary), M.S", "stefano@pursuit.org"),
    (8033, "Keila Barros", "stefano@pursuit.org"),
    (15918, "Vidhya Kelly", "stefano@pursuit.org"),
    (16310, "Khalif Jackson", "stefano@pursuit.org"),

    # ---- operation_35_staff — victoriam ----
    (1196, "Mark Goloboy", "victoriam@pursuit.org"),
    (1404, "Michael Brown", "victoriam@pursuit.org"),
    (1665, "Devon Winter", "victoriam@pursuit.org"),
    (1676, "Ed Tekeian", "victoriam@pursuit.org"),
    (1981, "Bela Bogdanovic", "victoriam@pursuit.org"),
]


def _norm(s: str | None) -> str:
    return " ".join((s or "").split()).casefold()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="write the changes; without it the script only reports")
    ap.add_argument("--prospect-scope", choices=("all", "lt", "none"), default="all",
                    help="which rows get is_jobs_contact set true where false: "
                         "all 141 (default), only the Joanna/Dave LT rows, or none")
    ap.add_argument("--database-url", default=None,
                    help="target DB; overrides DATABASE_URL from .env")
    args = ap.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = args.database_url or os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set (or pass --database-url)", file=sys.stderr)
        return 1

    ids = [cid for cid, _, _ in ASSIGN]
    if len(set(ids)) != len(ids):
        print("duplicate contact_id in ASSIGN", file=sys.stderr)
        return 1
    unknown = sorted({t for _, _, t in ASSIGN} - LT_TAGGERS - STAFF_NAMES.keys())
    if unknown:
        print(f"no display name for: {', '.join(unknown)}", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(dsn)
    try:
        # Name the target before touching it. Staging and production differ only by
        # a substring buried in a URL, which is not a thing to eyeball.
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
            ids)
        by_id = {r["contact_id"]: r for r in rows}

        # Guard: every frozen id must still exist, still be live, and still be the
        # person resolved on 2026-08-18. Abort the whole batch on any drift — a
        # partial apply over a half-stale list is worse than doing nothing.
        problems = []
        for cid, name, _tagger in ASSIGN:
            r = by_id.get(cid)
            if r is None:
                problems.append(f"{cid} ({name}): row is gone")
                continue
            if (r["contact_stage"] or "") == "merged":
                problems.append(f"{cid} ({name}): merged away")
            if _norm(r["full_name"]) != _norm(name):
                problems.append(
                    f"{cid}: expected {name!r}, found {r['full_name']!r}")
        if problems:
            print("ABORT — contact list is stale, re-resolve before running:",
                  file=sys.stderr)
            for p in problems:
                print(f"  {p}", file=sys.stderr)
            return 1

        # Which comment bodies are already present, so a re-run reports honestly
        # and writes nothing twice.
        existing_comments = {
            (r["parent_id"], r["content"])
            for r in await conn.fetch(
                "SELECT parent_id, content FROM bedrock.jobs_comment "
                " WHERE parent_type = 'prospect' AND parent_id = ANY($1::text[])",
                [str(c) for c in ids])
        }

        plan = []  # (cid, tag, body, needs_tag, needs_comment, needs_flag)
        for cid, _name, tagger in ASSIGN:
            tag, body = _plan_for(tagger)
            r = by_id[cid]
            want_flag = args.prospect_scope == "all" or (
                args.prospect_scope == "lt" and tag == TAG_LT)
            plan.append((
                cid, tag, body,
                tag not in r["tags"],
                (str(cid), body) not in existing_comments,
                want_flag and not r["is_jobs_contact"],
            ))

        for tag in (TAG_LT, TAG_STAFF):
            sel = [p for p in plan if p[1] == tag]
            print(f"{tag:<20} {len(sel):>3} contacts | "
                  f"{sum(1 for p in sel if p[3]):>3} need tag | "
                  f"{sum(1 for p in sel if p[4]):>3} need comment")
        n_false = sum(1 for p in plan if not by_id[p[0]]["is_jobs_contact"])
        print(f"{'jobs prospect':<20} {sum(1 for p in plan if p[5]):>3} to set true "
              f"(of {n_false} currently false)  --prospect-scope={args.prospect_scope}")

        if not args.apply:
            print("\nDRY RUN — nothing written. Re-run with --apply.\n")
            for cid, tag, body, needs_tag, needs_comment, needs_flag in plan:
                r = by_id[cid]
                marks = ("tag" if needs_tag else "---") + "/" + \
                        ("cmt" if needs_comment else "---")
                print(f"  {marks} {cid:>6} {r['full_name'][:26]:<26} "
                      f"{(r['current_company'] or '-')[:30]:<30} "
                      f"tags=[{','.join(r['tags']) or '-'}]"
                      f"{'  +prospect' if needs_flag else ''}")
                print(f"            -> {tag}  |  {body}")
            return 0

        # One transaction: tags, comments and flags land together, so a failure
        # cannot leave tagged contacts with no comment explaining why.
        async with conn.transaction():
            tagged = 0
            for tag in (TAG_LT, TAG_STAFF):
                sel = [p[0] for p in plan if p[1] == tag and p[3]]
                if not sel:
                    continue
                # array_append onto the existing array: purely additive, and the
                # WHERE keeps it idempotent across re-runs.
                res = await conn.execute(
                    "UPDATE public.contacts "
                    "   SET tags = array_append(coalesce(tags, '{}'::text[]), $2), "
                    "       updated_at = now() "
                    " WHERE contact_id = ANY($1::int[]) "
                    "   AND NOT ($2 = ANY(coalesce(tags, '{}'::text[])))",
                    sel, tag)
                tagged += int(res.split()[-1])

            commented = 0
            for cid, _tag, body, _nt, needs_comment, _nf in plan:
                if not needs_comment:
                    continue
                # NOT EXISTS stands in for the unique constraint this table lacks.
                res = await conn.execute(
                    "INSERT INTO bedrock.jobs_comment "
                    "  (parent_type, parent_id, author_id, author_email, content) "
                    "SELECT 'prospect', $1, $2::uuid, $3, $4 "
                    " WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_comment "
                    "   WHERE parent_type = 'prospect' AND parent_id = $1 "
                    "     AND content = $4)",
                    str(cid), COMMENT_AUTHOR_ID, COMMENT_AUTHOR_EMAIL, body)
                commented += int(res.split()[-1])

            flagged = 0
            sel = [p[0] for p in plan if p[5]]
            if sel:
                res = await conn.execute(
                    "UPDATE public.contacts "
                    "   SET is_jobs_contact = true, updated_at = now() "
                    " WHERE contact_id = ANY($1::int[]) "
                    "   AND is_jobs_contact IS DISTINCT FROM true",
                    sel)
                flagged = int(res.split()[-1])

        print(f"\ntag added:         {tagged}")
        print(f"comments posted:   {commented}")
        print(f"prospect flag set: {flagged}  (--prospect-scope={args.prospect_scope})")

        for tag in (TAG_LT, TAG_STAFF):
            total = await conn.fetchval(
                "SELECT count(*) FROM public.contacts "
                " WHERE $1 = ANY(coalesce(tags, '{}'::text[]))", tag)
            print(f"{tag} now on {total} contacts")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
