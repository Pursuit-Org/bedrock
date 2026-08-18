"""Tag the Operation 35 hiring-fit batch: 'operation_35_lt' + 'operation_35_staff' (Kwame, 2026-08-18).

WHAT THIS IS: the second batch in the pattern documented by
`README-contact-tag-batches.md`; `tag_operation_35_lt_nick.py` is the reference.
Two tags this time, split by who made the call, plus a per-contact comment — that
comment is the only thing here the LT_Nick batch did not do.

WHERE THE BATCH CAME FROM. Not a pasted list of names. These 100 contacts were
derived in SQL from bedrock.connection_status: contacts whose closeness vote is
'expect_response' AND who carry hiring_fit='yes' from at least one staff member
other than nick@pursuit.org. So contact_ids came straight out of the join — there
was no name-matching step to get them wrong, which is why this file has no
STORED_NAME_OVERRIDES and no ambiguous-match notes. The name guard below still
runs: it exists to catch a merge or rename between resolution and apply.

    WITH c AS (
      SELECT contact_id,
        bool_or(status = 'expect_response')                          AS close_yes,
        bool_or(hiring_fit = 'yes'
                AND updated_by <> 'nick@pursuit.org')                AS fit_yes_non_nick,
        string_agg(DISTINCT updated_by, '|')
          FILTER (WHERE hiring_fit = 'yes'
                  AND updated_by <> 'nick@pursuit.org')              AS non_nick
      FROM bedrock.connection_status GROUP BY contact_id)
    SELECT * FROM c WHERE close_yes AND fit_yes_non_nick;

THE SPLIT. 'operation_35_lt' for the contacts where david@pursuit.org is the ONLY
non-nick staffer who called the fit (24). 'operation_35_staff' for the rest (76).
Kwame's wording was "all the contacts under David" -> LT, "anything else on this
list" -> Staff.

  Benny Wong (14877, david+joe) and Alexis Medina (12632, david+joe+victoriam)
  have David among their taggers but were not "under David" in the list Kwame was
  reading — they were listed separately as multi-tagger rows. They are assigned
  STAFF here and both are called out for confirmation. Moving either to LT is a
  one-line edit to ASSIGN below.

  Joey Mejias (12308) already carries 'operation_35_lt_nick' from the previous
  batch. Tags are additive, so he ends up with both slugs — that is correct, not a
  collision. His non-nick tagger is Erica Wong, so the comment names her; nick also
  called his fit but nick is excluded from this batch by definition.

NEITHER TAG IS ON ANY OF THESE 100 ROWS YET (checked 2026-08-18), so every row is
a real write and nothing is being re-tagged.

ADDITIVE ONLY, same three guarantees as the reference script:
  1. Tags are written with array_append onto the current array. Curated tags
     (influence, staff_network, volunteer_current, tristate_smb_leaders,
     bash_attendee, alumni_ai_native, operation_35_lt_nick) and the email_review
     system marker all survive. 32 of the 100 already carry at least one tag.
     This deliberately differs from PATCH /api/jobs/contacts/{id}, which REPLACES
     the curated set.
  2. The WHERE clause skips rows that already have the slug, so re-running is a
     no-op rather than a duplicate.
  3. Nothing is ever unset.

is_jobs_contact IS NOT TOUCHED. The LT_Nick batch also ticked "Jobs prospect";
Kwame did not ask for it here, and it is not free — a new prospect flag lands in
Total Leads and the funnel counts. 84 of the 100 are not currently prospects. Pass
--set-prospect to do it, or leave it off. Off is the default because the ask was
tag + comment.

COMMENTS land in bedrock.jobs_comment as real team comments — parent_type
'prospect', parent_id the contact_id as text, which is how the Contacts page reads
a contact's thread (724 existing rows use exactly that shape). Authored as Kwame
(the person running this), not as the staffer being named in the text, because
Kwame is who is making the entry:

    LT    -> "Tagged for Operation 35 set by David"     (Kwame's exact wording)
    STAFF -> "Tagged for Operation 35 by <staffer>"

There is no unique constraint on jobs_comment, so idempotency is enforced by a
NOT EXISTS on (parent_type, parent_id, content) — re-running will not post a
second copy of the same line.

WHAT TAGGING MOVES (from the runbook, so it is not a surprise):
  1. My Network -> Pursuit scope admits any contact with a curated tag other than
     alumni_*/influence, so this batch starts appearing there.
  2. The nightly jobs-prospect recuration keeps any contact with a curated tag —
     these stop being sweepable.
  3. Only relevant with --set-prospect: new flags land in Total Leads in the
     not-yet-assigned band (this script sets no pipeline stage).

WHICH DATABASE: DATABASE_URL from financial_forecasting/.env, or --database-url.
That .env points at segundo-db as jobs_dev, which is PRODUCTION. The script prints
the host and database it connected to before doing anything, in both modes. Read
that line before --apply. (Precedent: a dev session silently wrote to the wrong DB
on 2026-04-17.)

    python3 scripts/tag_operation_35_lt_staff.py              # dry run (default)
    python3 scripts/tag_operation_35_lt_staff.py --apply
    python3 scripts/tag_operation_35_lt_staff.py --apply --set-prospect
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

COMMENT_LT = "Tagged for Operation 35 set by David"


def _staff_comment(who: str) -> str:
    return f"Tagged for Operation 35 by {who}"


# Staff display names, resolved 2026-08-18 from bedrock.sync_staff.display_name,
# falling back to bedrock.staff_user_id_map.display_name. Frozen here so the text
# written into a comment is reviewable in the diff rather than assembled at runtime.
#   joe@pursuit.org         — absent from sync_staff; name from staff_user_id_map
#   kalila.green@pursuit.org — absent from BOTH tables. "Kalila Green" is derived
#     from the email local part and corroborated by a public.contacts row of that
#     name (Operations Program Manager, Long Island City NY). Lowest-confidence
#     name here; say so if it should read differently.
STAFF_NAMES = {
    "avni@pursuit.org": "Avni Nahar",
    "damon.kornhauser@pursuit.org": "Damon Kornhauser",
    "david@pursuit.org": "David Yang",
    "ericawong@pursuit.org": "Erica Wong",
    "jac@pursuit.org": "Jacqueline Reverand",
    "joe@pursuit.org": "Joe Fabisevich",
    "johnny.nguyen@pursuit.org": "Johnny Nguyen",
    "kalila.green@pursuit.org": "Kalila Green",
    "stefano@pursuit.org": "Stefano Barros",
    "victoriam@pursuit.org": "Victoria Mayo",
    "yoshi@pursuit.org": "Yoshiyuki Minami",
}


def _names(emails: str) -> str:
    """'a|b|c' -> 'A, B and C' — reads as a sentence in the comment body."""
    people = [STAFF_NAMES[e] for e in emails.split("|")]
    if len(people) == 1:
        return people[0]
    return ", ".join(people[:-1]) + " and " + people[-1]


# (contact_id, stored full_name, tag, tagger emails joined by '|')
# ids frozen 2026-08-18 from the connection_status query in the docstring.
ASSIGN: list[tuple[int, str, str, str]] = [
    # ---- operation_35_lt — david@pursuit.org is the only non-nick tagger (24) ----
    (2210,  "Greg Levin",             TAG_LT, "david@pursuit.org"),
    (2352,  "Sam Mandel",             TAG_LT, "david@pursuit.org"),
    (2367,  "Greg Marsh",             TAG_LT, "david@pursuit.org"),
    (2382,  "Octavian Costache",      TAG_LT, "david@pursuit.org"),
    (2703,  "Jimmy Chen",             TAG_LT, "david@pursuit.org"),
    (6548,  "Benjamin Goldberg",      TAG_LT, "david@pursuit.org"),
    (6562,  "Ramon De Jesus",         TAG_LT, "david@pursuit.org"),
    (6590,  "Isaac Botier",           TAG_LT, "david@pursuit.org"),
    (6629,  "Brad Baer",              TAG_LT, "david@pursuit.org"),
    (6702,  "Akshay Shrimanker",      TAG_LT, "david@pursuit.org"),
    (6704,  "\U0001f4bb Jonathan Gottfried", TAG_LT, "david@pursuit.org"),
    (6762,  "Sei-Wook Kim",           TAG_LT, "david@pursuit.org"),
    (6779,  "Adam Greene",            TAG_LT, "david@pursuit.org"),
    (6821,  "Peter Kang",             TAG_LT, "david@pursuit.org"),
    (7156,  "Sebastian Cwilich",      TAG_LT, "david@pursuit.org"),
    (7169,  "Bernie Mehl",            TAG_LT, "david@pursuit.org"),
    (7209,  "Genevieve Nielsen",      TAG_LT, "david@pursuit.org"),
    (7215,  "Jeff Kaiser",            TAG_LT, "david@pursuit.org"),
    (7273,  "Greg Hausheer",          TAG_LT, "david@pursuit.org"),
    (11200, "Adam Lilly",             TAG_LT, "david@pursuit.org"),
    (14837, "Orta Therox",            TAG_LT, "david@pursuit.org"),
    (15047, "Sam Charney",            TAG_LT, "david@pursuit.org"),
    (15131, "Charles Kuang",          TAG_LT, "david@pursuit.org"),
    (15151, "Alan Johnson",           TAG_LT, "david@pursuit.org"),

    # ---- operation_35_staff (76) ----
    # avni@pursuit.org
    (16711, "My Chang",               TAG_STAFF, "avni@pursuit.org"),
    (17740, "Rachel Munsie",          TAG_STAFF, "avni@pursuit.org"),
    (17955, "Grace C. Bonilla, Esq.", TAG_STAFF, "avni@pursuit.org"),
    (18241, "Daniel Tartakovsky",     TAG_STAFF, "avni@pursuit.org"),
    (18295, "Minden Koopmans",        TAG_STAFF, "avni@pursuit.org"),
    # damon.kornhauser@pursuit.org
    (2191,  "Ying Zhou",              TAG_STAFF, "damon.kornhauser@pursuit.org"),
    (30278, "Ady Arguelles-Sabatier", TAG_STAFF, "damon.kornhauser@pursuit.org"),
    (30685, "Anthony Lee",            TAG_STAFF, "damon.kornhauser@pursuit.org"),
    (30982, "Tiffany Green",          TAG_STAFF, "damon.kornhauser@pursuit.org"),
    # CONFIRM: David is among the taggers on these two, but they were listed as
    # multi-tagger rows rather than "under David". Move to TAG_LT if that was the
    # intent — the comment text follows the tag automatically.
    (14877, "Benny Wong",             TAG_STAFF, "david@pursuit.org|joe@pursuit.org"),
    (12632, "Alexis Medina",          TAG_STAFF, "david@pursuit.org|joe@pursuit.org|victoriam@pursuit.org"),
    # ericawong@pursuit.org
    (2684,  "Ellie Bertani",          TAG_STAFF, "ericawong@pursuit.org"),
    (12308, "Joey Mejias",            TAG_STAFF, "ericawong@pursuit.org"),  # also has operation_35_lt_nick
    (27527, "Aly Murray",             TAG_STAFF, "ericawong@pursuit.org"),
    (27566, "Eric Talbert",           TAG_STAFF, "ericawong@pursuit.org"),
    (27798, "Aquila Leon-Soon",       TAG_STAFF, "ericawong@pursuit.org"),
    (27894, "David Henderson",        TAG_STAFF, "ericawong@pursuit.org"),
    (28143, "Mollie Newton",          TAG_STAFF, "ericawong@pursuit.org"),
    (28228, "Kevin Hylant",           TAG_STAFF, "ericawong@pursuit.org"),
    (28278, "John Kodumal",           TAG_STAFF, "ericawong@pursuit.org"),
    (28341, "Alicia Gansley",         TAG_STAFF, "ericawong@pursuit.org"),
    (28980, "Jason Decastro",         TAG_STAFF, "ericawong@pursuit.org"),
    # jac@pursuit.org
    (7,     "Murat Aktihanoglu",      TAG_STAFF, "jac@pursuit.org"),
    (2507,  "Kyle Kerchaert",         TAG_STAFF, "jac@pursuit.org"),
    (12715, "Guylendy House",         TAG_STAFF, "jac@pursuit.org"),
    # joe@pursuit.org
    (53898, "Bridget Williams",       TAG_STAFF, "joe@pursuit.org"),
    (53909, "Alaina Kafkes",          TAG_STAFF, "joe@pursuit.org"),
    (53996, "Ben Rosen",              TAG_STAFF, "joe@pursuit.org"),
    (54004, "Tony Haile",             TAG_STAFF, "joe@pursuit.org"),
    (54007, "Erik Froese",            TAG_STAFF, "joe@pursuit.org"),
    (54009, "Rob Kischuk",            TAG_STAFF, "joe@pursuit.org"),
    (54021, "Gabriel Savit",          TAG_STAFF, "joe@pursuit.org"),
    (54024, "Michael Simmons",        TAG_STAFF, "joe@pursuit.org"),
    (54074, "Javier Soto",            TAG_STAFF, "joe@pursuit.org"),
    (54080, "Benjamin Goh",           TAG_STAFF, "joe@pursuit.org"),
    (54088, "Bill Couch",             TAG_STAFF, "joe@pursuit.org"),
    (54113, "Pau Tomàs",         TAG_STAFF, "joe@pursuit.org"),
    (54126, "Justine De Caires",      TAG_STAFF, "joe@pursuit.org"),
    (54133, "Lien M",                 TAG_STAFF, "joe@pursuit.org"),
    (54140, "Mada Aflak",             TAG_STAFF, "joe@pursuit.org"),
    (54148, "Amandeep Grewal",        TAG_STAFF, "joe@pursuit.org"),
    (54161, "Jonah Grant",            TAG_STAFF, "joe@pursuit.org"),
    (54189, "David Carr",             TAG_STAFF, "joe@pursuit.org"),
    (54199, "Nick Takayama",          TAG_STAFF, "joe@pursuit.org"),
    (54292, "Andrew Guttormsen",      TAG_STAFF, "joe@pursuit.org"),
    (54313, "DJ Mitchell",            TAG_STAFF, "joe@pursuit.org"),
    (54351, "Sid Yadav",              TAG_STAFF, "joe@pursuit.org"),
    (54498, "Dennis Pilarinos",       TAG_STAFF, "joe@pursuit.org"),
    (54560, "Rebecca Sloane",         TAG_STAFF, "joe@pursuit.org"),
    (54585, "Thomas Catterall",       TAG_STAFF, "joe@pursuit.org"),
    (54640, "Albert Tong",            TAG_STAFF, "joe@pursuit.org"),
    (54674, "Brian Donohue",          TAG_STAFF, "joe@pursuit.org"),
    (54704, "Joshua Auerbach",        TAG_STAFF, "joe@pursuit.org"),
    (54779, "Jon Torodash",           TAG_STAFF, "joe@pursuit.org"),
    # johnny.nguyen@pursuit.org
    (25768, "Liz Anthony",            TAG_STAFF, "johnny.nguyen@pursuit.org"),
    (26026, "Harrison Pak",           TAG_STAFF, "johnny.nguyen@pursuit.org"),
    (26332, "Dyllan Liu",             TAG_STAFF, "johnny.nguyen@pursuit.org"),
    # kalila.green@pursuit.org
    (12301, "Felix Chong",            TAG_STAFF, "kalila.green@pursuit.org"),
    (33755, "Hasani Blackwell",       TAG_STAFF, "kalila.green@pursuit.org"),
    (52423, "Erica Holloway",         TAG_STAFF, "kalila.green@pursuit.org"),
    (53577, "Eddy Bayardelle",        TAG_STAFF, "kalila.green@pursuit.org"),
    (53616, "Zach Dane, Ed.D.",       TAG_STAFF, "kalila.green@pursuit.org"),
    (53624, "Rafael Richardson, Ed.D.", TAG_STAFF, "kalila.green@pursuit.org"),
    (53706, "Jemel Fanfan",           TAG_STAFF, "kalila.green@pursuit.org"),
    # stefano@pursuit.org
    (8040,  "Ryan Neveu",             TAG_STAFF, "stefano@pursuit.org"),
    (15543, "Albert Kim",             TAG_STAFF, "stefano@pursuit.org"),
    (15898, "Tad DeBarros",           TAG_STAFF, "stefano@pursuit.org"),
    (15974, "Sheila DeCaprio, CIMA®", TAG_STAFF, "stefano@pursuit.org"),
    # victoriam@pursuit.org
    (1539,  "Jeffrey Tardiff",        TAG_STAFF, "victoriam@pursuit.org"),
    (1663,  "Aviel Tanzer",           TAG_STAFF, "victoriam@pursuit.org"),
    (11585, "Stephen Hawes",          TAG_STAFF, "victoriam@pursuit.org"),
    (12382, "Laziah Bernstine",       TAG_STAFF, "victoriam@pursuit.org"),
    (12406, "Yong Kang",              TAG_STAFF, "victoriam@pursuit.org"),
    (12462, "Jordan Manley",          TAG_STAFF, "victoriam@pursuit.org"),
    # yoshi@pursuit.org
    (6914,  "Kyle Benford",           TAG_STAFF, "yoshi@pursuit.org"),
    (7033,  "Holly Yeager",           TAG_STAFF, "yoshi@pursuit.org"),
]


def _norm(s: str | None) -> str:
    return " ".join((s or "").split()).casefold()


def _comment_for(tag: str, taggers: str) -> str:
    return COMMENT_LT if tag == TAG_LT else _staff_comment(_names(taggers))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="write the changes; without it the script only reports")
    ap.add_argument("--set-prospect", action="store_true",
                    help="also tick Jobs prospect (is_jobs_contact) where false. "
                         "Off by default: not part of the ask, and new flags land "
                         "in Total Leads and the funnel counts.")
    ap.add_argument("--database-url", default=None,
                    help="target DB; overrides DATABASE_URL from .env")
    args = ap.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = args.database_url or os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set (or pass --database-url)", file=sys.stderr)
        return 1

    ids = [cid for cid, _, _, _ in ASSIGN]
    if len(set(ids)) != len(ids):
        print("duplicate contact_id in ASSIGN", file=sys.stderr)
        return 1
    unknown = sorted({e for _, _, _, t in ASSIGN for e in t.split("|")}
                     - STAFF_NAMES.keys())
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
        for cid, name, _tag, _taggers in ASSIGN:
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

        plan = []  # (cid, tag, comment, needs_tag, needs_comment, needs_flag)
        for cid, _name, tag, taggers in ASSIGN:
            r, body = by_id[cid], _comment_for(tag, taggers)
            plan.append((
                cid, tag, body,
                tag not in r["tags"],
                (str(cid), body) not in existing_comments,
                not r["is_jobs_contact"],
            ))

        for tag in (TAG_LT, TAG_STAFF):
            sel = [p for p in plan if p[1] == tag]
            print(f"{tag:<20} {len(sel):>3} contacts | "
                  f"{sum(1 for p in sel if p[3]):>3} need tag | "
                  f"{sum(1 for p in sel if p[4]):>3} need comment")
        n_flag = sum(1 for p in plan if p[5])
        print(f"{'jobs prospect':<20} {n_flag:>3} of {len(plan)} currently false — "
              + ("will set true" if args.set_prospect
                 else "NOT touched (pass --set-prospect)"))

        if not args.apply:
            print("\nDRY RUN — nothing written. Re-run with --apply.\n")
            for cid, tag, body, needs_tag, needs_comment, needs_flag in plan:
                r = by_id[cid]
                marks = ("tag" if needs_tag else "---") + "/" + \
                        ("cmt" if needs_comment else "---")
                flag = "  +prospect" if (needs_flag and args.set_prospect) else ""
                print(f"  {marks} {cid:>6} {r['full_name'][:26]:<26} "
                      f"{(r['current_company'] or '-')[:32]:<32} "
                      f"tags=[{','.join(r['tags']) or '-'}]{flag}")
                print(f"            -> {tag}  |  {body}")
            return 0

        # One transaction: tags, comments and (optionally) flags land together, so
        # a failure cannot leave tagged contacts with no comment explaining why.
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
            if args.set_prospect:
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
        print(f"prospect flag set: {flagged}"
              + ("" if args.set_prospect else "  (--set-prospect not passed)"))

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
