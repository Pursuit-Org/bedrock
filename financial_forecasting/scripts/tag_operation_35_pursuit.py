"""Tag the top-3 senior contacts at 18 accounts with 'operation_35_pursuit' (Kwame, 2026-08-18).

Same shape as tag_operation_35_lt_nick.py — see README-contact-tag-batches.md for
the runbook. What differs: the input was "the top 3 senior contacts at these
accounts" rather than a flat name list, so the per-account pick is itself a
judgement and each one is recorded below with the title it was picked on.

CATALOG: 'operation_35_pursuit' ("Operation 35 — Pursuit", sort_order 160,
active) already exists — verified 2026-08-18. No migration needed.

ADDITIVE ONLY, exactly as the LT_Nick run:
  1. array_append onto the existing array, so curated tags AND the email_review
     system marker survive. This deliberately differs from
     PATCH /api/jobs/contacts/{id}, which REPLACES the curated tag set.
  2. The WHERE skips contacts already carrying the tag, so re-runs are idempotent.
  3. is_jobs_contact only ever goes false -> true. Nothing is ever unset.

Three contacts here already carry operation_35_lt_nick (John Flynn, Jen Hensley,
Dara Khosrowshahi). Both tags coexist; the LT_Nick tag is not touched.

IDS ARE FROZEN. Every name was resolved against public.contacts on 2026-08-18 and
the id written in below, so a re-run cannot silently pick a different row. Names
that matched more than one row were disambiguated on the supplied title and are
marked WHY. Before writing, the script re-reads every id and aborts if a
full_name no longer matches what was recorded here.

WHICH DATABASE: DATABASE_URL from financial_forecasting/.env, or --database-url.
That .env points at segundo-db as jobs_dev, which is PRODUCTION. The script
prints the host and database it connected to before doing anything, in both
modes. Read that line before applying.

    cd /Users/kwameassoku/bedrock/financial_forecasting
    source .venv/bin/activate
    python3 scripts/tag_operation_35_pursuit.py           # dry run (default)
    python3 scripts/tag_operation_35_pursuit.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

TAG = "operation_35_pursuit"

# (contact_id, name as supplied, account, title the pick was made on)
# Ordered by account; within an account, in the seniority order Kwame supplied.
CONTACTS: list[tuple[int, str, str, str]] = [
    # --- TPG ------------------------------------------------------------------
    # Only 1 of 3. Anna Edwin and "Jackie" are unresolved — see UNRESOLVED below.
    # WHY 19577: three John Flynns. 19577 is "Partner" at TPG — exact title and
    # company match. 4370 is a VP at Citi, 21251 a President at Integrated UVC.
    (19577, "John Flynn",            "TPG",             "Partner"),

    # --- Adobe ----------------------------------------------------------------
    (19809, "Rachel Itwaru",         "Adobe",           "Global Lead, Nonprofit Skilling Partnerships"),
    (10746, "Jack Sisson",           "Adobe",           "Senior Director Of Engineering, Photoshop"),
    (37014, "Judy Truong",           "Adobe",           "Sr. Technical Talent Partner"),

    # --- American Express -----------------------------------------------------
    (35306, "Hilary Packer",         "American Express","EVP and CTO"),
    (45435, "Andie Kortes",          "American Express","Chief Talent Officer"),
    # Stored full_name is "Anna Marrs Anna" (a duplicated-token import artefact).
    (10486, "Anna Marrs",            "American Express","Group President, Global Commercial Services"),

    # --- Blackstone -----------------------------------------------------------
    (34624, "John Stecher",          "Blackstone",      "CTO"),
    (33783, "Adam Fletcher",         "Blackstone",      "Senior MD, BXTI, Chief Security Officer"),
    # Named in Kwame's note: "David Drew indicated that Blackstone will not commit
    # to a hiring mandate now. Invited us to apply for open positions." Stored
    # company is "Blackstone BXMA", a separate account string from "Blackstone".
    # Takes the slot freed by dropping the legacy Murphy CTO record (36142);
    # displaces Paige Ross (45179), who was the earlier swap candidate.
    (16605, "David Drew",            "Blackstone",      "Senior Vice President (BXMA)"),

    # --- Citi -----------------------------------------------------------------
    (45254, "Mark Mason",            "Citi",            "Chief Financial Officer, Citi"),
    (37295, "Edward Skyler",         "Citi",            "EVP Global Public Affairs"),
    # Stored company is "Citigroup" — the duplicate account Kwame flagged.
    (45259, "Erika Brown",           "Citi",            "Chief Diversity, Equity and Inclusion Officer"),

    # --- Con Edison -----------------------------------------------------------
    (11570, "Jen Hensley",           "Con Edison",      "SVP, Corporate Affairs"),   # has operation_35_lt_nick
    (46706, "Joan Jacobs",           "Con Edison",      "Vice President Learning & Inclusion"),
    (46705, "Allisyn Glasser",       "Con Edison",      "Vice President IT"),

    # --- Goldman Sachs --------------------------------------------------------
    # Only 2 of 3. Jared Cohen is not in public.contacts — see UNRESOLVED below.
    (45458, "Susie Scher",           "Goldman Sachs",   "Partner"),
    # Stored current_company reads "Morgan Stanley" but the email is
    # megan.hogan@gs.com and the title matches exactly — same person, stale
    # company field. Flagged to Kwame; a one-field edit fixes it.
    (45459, "Megan Hogan",           "Goldman Sachs",   "Chief Diversity Officer"),

    # --- Gutter Capital -------------------------------------------------------
    (15100, "Dan Teran",             "Gutter Capital",  "Co-Founder & Managing Partner"),
    (12304, "James Gettinger",       "Gutter Capital",  "Co-Founder and Managing Partner"),
    # Stored company is the misspelled "Gutter Captial" — the duplicate Jobs
    # account. Tagging is unaffected; the spelling is a separate fix.
    (2173,  "Richard Hughes",        "Gutter Capital",  "Operating Partner"),

    # --- Macquarie ------------------------------------------------------------
    # WHY 34153: two John Stowes. 34153 is "COO" at Macquarie — exact title and
    # company match, and carries the influence tag. 46909 is an empty stub with
    # no title or company.
    (34153, "John Stowe",            "Macquarie",       "COO"),
    (46209, "William Gerald Demas",  "Macquarie",       "Senior MD & Head of Americas, Green Investment Group"),
    (33724, "Pritha Mittal",         "Macquarie",       "Interim Americas Head, Macquarie Group Foundation"),

    # --- Mastercard -----------------------------------------------------------
    (45597, "Lucrecia Borgonovo",    "Mastercard",      "Chief Talent and Organizational Effectiveness Officer"),
    # WHY 12420: two Sarah Walkers. 12420 is "SVP, Engineering Digital Marketing
    # Programs" at Mastercard and carries the opboard tag. 29477 is an Improv
    # Dojo Teacher at Pan Theater.
    (12420, "Sarah Walker",          "Mastercard",      "SVP, Engineering Digital Marketing Programs"),
    (42844, "Lois Bruu",             "Mastercard",      "Vice President, Humanitarian & Development"),

    # --- Maycomb Capital ------------------------------------------------------
    # Only 2 of 3. Danielle Schweitzer exists only as an email stub — see
    # UNRESOLVED below.
    # 33787 has no title and no company stored — just a name and an email. It is
    # the only Andrea Phillips in the table.
    (33787, "Andrea Phillips",       "Maycomb Capital", "(no title stored — Founder / Managing Partner)"),
    (35904, "Shelby Kohn",           "Maycomb Capital", "Director of Public-Private Partnerships"),

    # --- OpenRouter -----------------------------------------------------------
    # Only 2 exist at this account; neither has a title stored.
    (33296, "Alex Atallah",          "OpenRouter",      "(no title stored — co-founder)"),
    (32937, "Emma Cryer",            "OpenRouter",      "(no title stored)"),

    # --- Peloton --------------------------------------------------------------
    # Barry McCarthy (45230) dropped — stale record, he has stepped down, and
    # Kwame's note reads "Filed bankruptcy. Not actively hiring."
    (35267, "Paul Bouzakis",         "Peloton",         "Senior Director Of Engineering"),
    (35551, "Matt Skavenski",        "Peloton",         "Vice President of Software Engineering, App"),
    (33831, "Francis Shanahan",      "Peloton",         "VP, Cardio Software"),

    # --- Red Canary -----------------------------------------------------------
    (47091, "Bryan Beyer",           "Red Canary",      "Co-Founder and CEO"),
    (47089, "Keith McCammon",        "Red Canary",      "Co-Founder and CSO"),
    (33934, "Joe Moles",             "Red Canary",      "CTO"),

    # --- Spotify --------------------------------------------------------------
    (23687, "Nora Wessel",           "Spotify",         "Head of Strategy and Business Development"),
    # Stored with the accent: "Máuhan M Zonoozy". contact_stage is 'on_hold'.
    (5193,  "Mauhan M Zonoozy",      "Spotify",         "Head of Innovation"),
    (54496, "Maya Prohovnik",        "Spotify",         "VP, Head of Podcast Product"),

    # --- Tripadvisor ----------------------------------------------------------
    # 36723 has no current_company stored and only the personal gmail Kwame
    # flagged. Title matches exactly.
    (36723, "Aaron Rudenstine",      "Tripadvisor",     "Senior Director, Product"),
    (22015, "Kat Krieger",           "Tripadvisor",     "Head of Strategy"),
    (7994,  "Max Magao",             "Tripadvisor",     "Senior Product Manager - Hotels Partner Products"),

    # --- Uber -----------------------------------------------------------------
    (34615, "Dara Khosrowshahi",     "Uber",            "CEO"),                      # has operation_35_lt_nick
    (46985, "Tony West",             "Uber",            "SVP, Chief Legal Officer and Corporate Secretary"),
    # Named in Kwame's note: "Tried several times to activate Josh Gold. Not
    # responsive." Displaces Bo Young Lee (34288, Chief D&I Officer), who was the
    # third pick on title alone.
    (33899, "Josh Gold",             "Uber",            "Director, Public Policy and Communications"),

    # --- Wells Fargo ----------------------------------------------------------
    (34510, "Krissy Moore",          "Wells Fargo",     "SVP & Community Relations Northeast Sr. Manager"),
    (34509, "Wendy Takahisa",        "Wells Fargo",     "(no title stored — CRA Leader)"),
    # Named in Kwame's note: "In conversation with Luisa to kick start jobs
    # conversation." Stored as "Luisa P Perez" with no title or company — only
    # the wellsfargo.com email identifies her. Displaces Catherine Domenech
    # (34751, Community Development Officer).
    (33470, "Luisa P Perez",         "Wells Fargo",     "(no title stored — named in owner note)"),
]

# Stored full_name differs from the batch spelling; the guard compares against
# these instead.
STORED_NAME_OVERRIDES = {
    10486: "Anna Marrs Anna",
    7994:  "Max (Maksim) Magao",
    5193:  "Máuhan M Zonoozy",
}

# ---------------------------------------------------------------------------
# UNRESOLVED — deliberately NOT tagged. Each needs a call from Kwame.
#
#   TPG / Anna Edwin (Global Head of HR)
#       No contact record. The nearest thing is contact_id 47843, a bare
#       email_candidate stub: full_name 'aedwin@tpg.com', company 'tpg', tagged
#       email_review, no name or title. Almost certainly her, but the record is
#       an address rather than a person. Options: tag the stub as-is, or fill in
#       name/title/company first, or create a fresh contact.
#
#   TPG / "Jackie" (MD, Chief of Staff, HR)
#       43 contacts named Jackie, none at TPG. No surname was ever captured, so
#       there is nothing to match on. Needs the surname.
#
#   Goldman Sachs / Jared Cohen (President of Global Affairs)
#       Not in public.contacts. The only Jared Cohen (23720) is a Vice President,
#       FinTech & Financial Services at General Atlantic — a different person.
#       The Goldman Jared Cohen exists only as a Salesforce affiliation.
#
#   Maycomb Capital / Danielle Schweitzer (loan servicing)
#       Only contact_id 49042, a stub: full_name 'dschweitzer@maycombcapital.com',
#       company 'maycombcapital', is_jobs_contact already true, no name or title.
#       The address matches the sender of the 2026-06-01 Maycomb loan invoice, so
#       this is her record. Same options as Anna Edwin.
#
#   Northwell — no contacts at all
#       Nothing with a name or title exists in any system. Only six raw
#       @northwell.edu email stubs (baquart, dangle, amancini, lphipps, evfeuer,
#       kcasler), all unnamed and untitled. Cannot pick a "top 3 senior".
#
# SUBSTITUTES available if you want a full 3 at every account (all verified
# present, ids frozen the same day):
#   Goldman Sachs  34978 Christopher Strazzella — MD, Global Head of Engineering Recruiting
#                  33970 Margaret Anadu        — Head of Urban Investment Group
#                  37069 Andrew Trout          — MD, Human Capital Management
#                  46586 Stratford Dennis      — Co-Head of EM Equities, Americas/EMEA
#   Amex           11000 Madge Thomas          — President, Amex Foundation (Kwame's
#                                                "best route for a foundation ask")
#   Blackstone     45179 Paige Ross            — Sr. MD, Global Head of HR
#   Peloton        35267 Paul Bouzakis         — Senior Director of Engineering
#                  34915 Adam Mattina          — MD Deputy CISO
#   Wells Fargo    27496 Bonnie Wallace        — Head of Financial Health Philanthropy
#                  26786 Ebony A. Burt         — Head of Diversity, Equity and Inclusion
#   Maycomb        5522  Luis Schwedler        — Senior Investment Associate
# ---------------------------------------------------------------------------


def _norm(s: str | None) -> str:
    return " ".join((s or "").split()).casefold()


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

    frozen = [cid for cid, *_ in CONTACTS]
    if len(set(frozen)) != len(frozen):
        print("duplicate contact_id in CONTACTS", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(dsn)
    try:
        # Name the target before touching it.
        where = await conn.fetchrow(
            "SELECT current_database() AS db, "
            "       inet_server_addr()::text AS host, current_user AS role")
        src = "--database-url" if args.database_url else ".env DATABASE_URL"
        print(f"target: {where['db']} on {where['host'] or 'local socket'} "
              f"as {where['role']}  (from {src})\n")

        # The tag must already be in the catalog — a slug that is not there is
        # invisible in the Tags picker and is not treated as curated anywhere.
        cat = await conn.fetchrow(
            "SELECT label, active FROM bedrock.contact_tag_catalog WHERE slug = $1", TAG)
        if cat is None:
            print(f"ABORT — '{TAG}' is not in bedrock.contact_tag_catalog. "
                  f"It needs a db/migrations/ file first.", file=sys.stderr)
            return 1
        print(f"tag: {TAG} — {cat['label']!r} (active={cat['active']})\n")

        rows = await conn.fetch(
            "SELECT contact_id, full_name, current_company, contact_stage, "
            "       is_jobs_contact, coalesce(tags, '{}'::text[]) AS tags "
            "  FROM public.contacts WHERE contact_id = ANY($1::int[])",
            frozen)
        by_id = {r["contact_id"]: r for r in rows}

        # Guard: abort the whole batch on any drift. A partial apply on a
        # half-stale list is worse than doing nothing.
        problems = []
        for cid, name, acct, _ttl in CONTACTS:
            r = by_id.get(cid)
            if r is None:
                problems.append(f"{cid} ({name}, {acct}): row is gone")
                continue
            if (r["contact_stage"] or "") == "merged":
                problems.append(f"{cid} ({name}, {acct}): merged away")
            expected = STORED_NAME_OVERRIDES.get(cid, name)
            if _norm(r["full_name"]) != _norm(expected):
                problems.append(
                    f"{cid} ({acct}): expected {expected!r}, found {r['full_name']!r}")
        if problems:
            print("ABORT — contact list is stale, re-resolve before running:",
                  file=sys.stderr)
            for p in problems:
                print(f"  {p}", file=sys.stderr)
            return 1

        already = [cid for cid, *_ in CONTACTS if TAG in by_id[cid]["tags"]]
        to_tag  = [cid for cid, *_ in CONTACTS if TAG not in by_id[cid]["tags"]]
        to_flag = [cid for cid, *_ in CONTACTS if not by_id[cid]["is_jobs_contact"]]

        accounts = sorted({acct for _, _, acct, _ in CONTACTS})
        print(f"resolved      {len(CONTACTS)} contacts across {len(accounts)} accounts "
              f"(ids frozen 2026-08-18)")
        print(f"already {TAG}: {len(already)}"
              + (" — left untouched: " + ", ".join(
                  f"{by_id[c]['full_name']} ({c})" for c in already) if already else ""))
        print(f"tag to add    {len(to_tag)}")
        print(f"prospect flag {len(to_flag)} of {len(CONTACTS)} to set true "
              f"({len(CONTACTS) - len(to_flag)} already true)")

        if not args.apply:
            print("\nDRY RUN — nothing written. Re-run with --apply.\n")
            last = None
            for cid, name, acct, ttl in CONTACTS:
                if acct != last:
                    print(f"  {acct}")
                    last = acct
                r = by_id[cid]
                mark = "skip" if cid in already else " tag"
                flag = "" if r["is_jobs_contact"] else "  +prospect"
                print(f"    {mark} {cid:>6} {r['full_name']:<24} "
                      f"{(r['current_company'] or '-'):<18} "
                      f"tags=[{','.join(r['tags']) or '-'}]{flag}")
            return 0

        async with conn.transaction():
            flagged = await conn.execute(
                "UPDATE public.contacts SET is_jobs_contact = true, updated_at = now() "
                " WHERE contact_id = ANY($1::int[]) AND is_jobs_contact IS DISTINCT FROM true",
                frozen)
            # array_append onto the existing array: purely additive, and the
            # WHERE keeps it idempotent across re-runs.
            tagged = await conn.execute(
                "UPDATE public.contacts "
                "   SET tags = array_append(coalesce(tags, '{}'::text[]), $2), "
                "       updated_at = now() "
                " WHERE contact_id = ANY($1::int[]) "
                "   AND NOT ($2 = ANY(coalesce(tags, '{}'::text[])))",
                frozen, TAG)
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
