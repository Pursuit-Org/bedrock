#!/usr/bin/env python3
"""Merge network duplicates PROVEN identical by their LinkedIn profile identity.

The gap this closes: scripts/network_dedupe_merge.py (approved 2026-07-01, ran
2026-07-02, merged 130 pairs) required the same NORMALIZED NAME. It therefore
missed every duplicate where the display name changed between exports — a
credential suffix added ("Jennifer Willemsen" -> "Jennifer Willemsen, Ph.D."), a
married name ("Betsy Kuhns" -> "Betsy (Kuhns) Flynt"), or a middle name appearing.
39 such groups remain in the network.

SIGNATURE — deliberately narrower than name similarity:
  * the SAME staff member is connected to two live contact rows, AND
  * their LinkedIn profile fragment is IDENTICAL.

The 2026-07-01 script also required the two rows to come from DIFFERENT import
batches, on the reasoning that a LinkedIn export is a full point-in-time dump so one
person cannot appear twice in it. That heuristic exists because names alone are weak
evidence. A profile fragment is not weak, so it is NOT applied here — and applying it
would skip 9 genuine duplicates that happen to share a created date.

Name similarity is NOT used as evidence at all. A separate population of ~61 pairs
looks like duplicates by name but has no profile fragment on one or both rows; those
are left for a human, because fusing two real people is far harder to undo than
leaving a duplicate.

Scope is contacts that appear in at least one staff network — this is a My Network
cleanup. One further duplicate group exists among contacts with no staff
relationship and is deliberately out of scope.

Survivor: linkedin_url > email > most activity > oldest contact_id (same rule as the
2026-07-01 script). Employer and title are taken from the NEWEST row, because that
is the current job — the whole reason the duplicate exists.

All FK repointing, the connection_status composite-key collision, jobs_comment,
marking the loser merged, and the audit row are handled by
bedrock.merge_contacts(), a SECURITY DEFINER function bedrock_user may call.

    python3 scripts/network_dedupe_linkedin_id.py --dry-run
    python3 scripts/network_dedupe_linkedin_id.py
"""
from __future__ import annotations

import argparse
import collections
import os
import re
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

REASON = ("network dedupe: cross-batch reimport, same LinkedIn profile id, "
          "display name changed (credential suffix / married name / middle name)")

# Credential and generational suffixes that ride on a display name. Only used to
# report the pair readably — never as merge evidence.
_SUFFIX = re.compile(
    r'\b(cfa|cpa|mba|phd|ph d|md|jr|sr|ii|iii|iv|shrm[- ]?scp|pmp|esq|ms|m s|ma|m ed|'
    r'bs|rn|pe|cscp|asp|asid|pmi|bcba|vmd|mph|lcsw|pa|do)\b')


def _norm_tokens(name: str) -> list[str]:
    s = re.sub(r'[(),.]', ' ', (name or '').lower())
    return [t for t in _SUFFIX.sub(' ', s).split() if t]


def _slug(row) -> str | None:
    r"""LinkedIn slug from the dedup_key or the URL, whichever carries it.

    Takes everything after the marker up to a / or ? rather than matching a
    character class. A class of [a-z0-9-]+ silently drops any slug containing a
    URL-encoded character — "%E2%9C%85-tony-brown-268676162" (a ✅ in the display
    name) returned None and left a real duplicate behind on the first run.
    """
    for src in (row["dedup_key"] or "", row["linkedin_url"] or ""):
        m = re.search(r'(?:linkedin:|/in/)([^/?#\s]+)', src, re.I)
        if m:
            return m.group(1).rstrip('/').lower()
    return None


def _profile_frag(row) -> str | None:
    r"""LinkedIn's per-profile hash fragment, e.g. the b01782115 in
    /in/max-rispoli-b01782115. Survives a display-name change, which is exactly
    why it can identify a duplicate that name matching cannot.

    The optional LEADING LETTER IS PART OF THE FRAGMENT and must be kept: a regex
    of trailing-digits-only turns b7164360 into 7164360 and would then match an
    unrelated profile whose fragment really is 7164360 — that mistake inflated an
    earlier run of this script from 38 groups to 44 bogus pairs. Verified across all 4,232 contacts
    carrying a fragment: 39 fragments are shared, and in none of them do the two
    contacts turn out to be different people.
    """
    m = re.search(r'-([a-z]?\d{6,})$', _slug(row) or "")
    return m.group(1) if m else None


def _dsn() -> str | None:
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for line in env.open():
            if line.strip().startswith("DATABASE_URL="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    return None


def _survivor(a, b):
    """(keep, drop) by linkedin_url > email > activity > oldest id."""
    for key in (lambda r: bool(r["linkedin_url"]), lambda r: bool(r["email"]),
                lambda r: r["acts"]):
        ka, kb = key(a), key(b)
        if ka != kb:
            return (a, b) if ka > kb else (b, a)
    return (a, b) if a["contact_id"] <= b["contact_id"] else (b, a)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    dsn = _dsn()
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1
    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT r.staff_user_id AS sid, c.contact_id, c.full_name, c.current_title,
               c.current_company, c.company_id, c.created_at::date AS cd,
               c.linkedin_url, c.dedup_key, c.email,
               (SELECT count(*) FROM bedrock.activity a
                 WHERE a.participant_public_contact_id = c.contact_id) AS acts
          FROM public.staff_contact_relationships r
          JOIN public.contacts c ON c.contact_id = r.contact_id
         WHERE coalesce(c.contact_stage,'') <> 'merged'
           AND coalesce(btrim(c.full_name),'') <> ''
    """)
    rows = cur.fetchall()
    conn.commit()

    by_staff = collections.defaultdict(list)
    for r in rows:
        by_staff[r["sid"]].append(r)

    # Grouped by fragment, not paired: a group of three would otherwise yield three
    # overlapping merges, the second of which operates on an already-merged row.
    # (Every group is currently size 2, but the shape shouldn't depend on that.)
    seen: dict[int, dict] = {}
    groups: dict[str, dict[int, dict]] = collections.defaultdict(dict)
    for lst in by_staff.values():
        for r in lst:
            frag = _profile_frag(r)
            if frag:
                groups[frag][r["contact_id"]] = r
            seen[r["contact_id"]] = r
    dupes = {f: list(m.values()) for f, m in groups.items() if len(m) > 1}

    print(f"{len(dupes)} duplicate groups proven by LinkedIn profile fragment "
          f"({sum(len(v) for v in dupes.values())} contacts, "
          f"{sum(len(v) - 1 for v in dupes.values())} merges)")
    sizes = collections.Counter(len(v) for v in dupes.values())
    print(f"  group sizes: {dict(sorted(sizes.items()))}")
    if not dupes:
        return 0

    plan = []
    for members in dupes.values():
        keep = members[0]
        for cand in members[1:]:
            keep, _loser = _survivor(keep, cand)
        newest = max(members, key=lambda r: r["cd"])
        take_employer = (
            newest["contact_id"] != keep["contact_id"]
            and (newest["current_company"] or "") != (keep["current_company"] or ""))
        for drop in members:
            if drop["contact_id"] == keep["contact_id"]:
                continue
            plan.append((keep, drop, newest if take_employer else None))

    print()
    for keep, drop, employer_src in plan:
        ev = _profile_frag(keep)
        print(f"  keep {keep['contact_id']:6} {keep['full_name'][:30]!r:32} @ {str(keep['current_company'])[:22]:22}")
        print(f"  drop {drop['contact_id']:6} {drop['full_name'][:30]!r:32} @ {str(drop['current_company'])[:22]:22}   [{ev}]")
        if employer_src:
            print(f"       -> employer updated to {employer_src['current_company']!r} "
                  f"/ {employer_src['current_title']!r} (newest snapshot)")

    if args.dry_run:
        print(f"\n[dry-run] would merge {len(plan)} pairs")
        return 0

    merged = 0
    try:
        for keep, drop, employer_src in plan:
            if employer_src:
                cur.execute("""UPDATE public.contacts
                                  SET current_title=%s, current_company=%s, company_id=%s,
                                      updated_at=now()
                                WHERE contact_id=%s""",
                            (employer_src["current_title"], employer_src["current_company"],
                             employer_src["company_id"], keep["contact_id"]))
            cur.execute("SELECT bedrock.merge_contacts(%s,%s,%s)",
                        (keep["contact_id"], drop["contact_id"], REASON))
            merged += 1
        conn.commit()
    except Exception:
        conn.rollback()
        print(f"\nrolled back after {merged} merges — nothing committed", file=sys.stderr)
        raise
    finally:
        conn.close()
    print(f"\nmerged {merged} pairs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
