#!/usr/bin/env python3
"""Import Nick's contact assessments from the "Nick's Contacts" sheet tab.

Jac, 2026-08-06:
  * Nick's Assessment "Yes"   -> thumbs up on BOTH columns
  * Nick's Assessment "Maybe" -> thumbs up on both, with "maybe" recorded as a note
  * every note must say plainly that it is Nick's comment

RECORDED AS NICK'S, NOT JAC'S. connection_status is keyed (staff_user_id,
contact_id) and these are Nick's judgements, so they are written under his
staff_user_id and appear on HIS My Network. All 45 contacts are in his network, so
they will render for him. Pass --as-staff EMAIL to attribute them to someone else.

Notes are real team comments (bedrock.jobs_comment, parent_type='prospect') with the
"relationship context:" prefix the row's Note cell round-trips on, authored as Nick
so his cell shows them. The body names him too, because a reader in the thread
should not have to check the author column to know whose opinion it is.

A row with a note but NO assessment gets the note and no thumbs — two rows are in
that position, and one of them says "Let's not contact". Inferring a thumbs-down
from free text is a guess this script deliberately does not make.

    python3 scripts/import_nick_assessments.py --csv PATH --dry-run
    python3 scripts/import_nick_assessments.py --csv PATH
"""
from __future__ import annotations

import argparse
import collections
import csv
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ASSESS_COL = "Nick's Assessment"
NOTES_COL = "Notes"
PREFIX = "relationship context:"
# Thumbs-up on both columns, for either verdict. "Maybe" is still a yes with a caveat
# — the caveat lands in the note rather than weakening the vote (Jac's call).
THUMBS_UP = {"yes", "maybe"}
VOTE_YES = "expect_response"
FIT_YES = "yes"


def _dsn() -> str | None:
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for line in env.open():
            if line.strip().startswith("DATABASE_URL="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    return None


def read_rows(path: Path) -> list[dict]:
    """The tab carries a merged-cell preamble, so the header is not row 1."""
    raw = list(csv.reader(path.open()))
    hdr_i = next((i for i, r in enumerate(raw) if "contact_id" in r and ASSESS_COL in r), None)
    if hdr_i is None:
        raise SystemExit(f"no header row containing 'contact_id' and {ASSESS_COL!r} in {path}")
    hdr = raw[hdr_i]
    return [dict(zip(hdr, r)) for r in raw[hdr_i + 1:] if any(x.strip() for x in r)]


def note_body(assessment: str, note: str) -> str | None:
    """What to write, or None when there is nothing to say beyond the thumbs."""
    parts = []
    if assessment.lower() == "maybe":
        parts.append("assessment: Maybe")
    if note:
        parts.append(note)
    if not parts:
        return None
    return f"{PREFIX} Nick's note — " + " · ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", type=Path, required=True)
    ap.add_argument("--as-staff", default="nick@pursuit.org",
                    help="whose assessment this is; votes and notes are attributed to them")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = read_rows(args.csv)
    plan = []
    skipped_no_id = 0
    for d in rows:
        cid = (d.get("contact_id") or "").strip()
        assessment = (d.get(ASSESS_COL) or "").strip()
        note = (d.get(NOTES_COL) or "").strip()
        if not (assessment or note):
            continue
        if not cid.isdigit():
            skipped_no_id += 1
            continue
        plan.append({
            "contact_id": int(cid),
            "name": (d.get("Contact") or "").strip(),
            "assessment": assessment,
            "thumbs": assessment.lower() in THUMBS_UP,
            "note": note_body(assessment, note),
        })

    counts = collections.Counter(p["assessment"] or "(none)" for p in plan)
    print(f"{len(plan)} rows to apply from {args.csv.name}"
          + (f" ({skipped_no_id} skipped: no contact_id)" if skipped_no_id else ""))
    print(f"  assessments: {dict(counts)}")
    print(f"  thumbs up on both columns: {sum(1 for p in plan if p['thumbs'])}")
    print(f"  notes to write:            {sum(1 for p in plan if p['note'])}")
    print(f"  note but no thumbs:        {sum(1 for p in plan if p['note'] and not p['thumbs'])}")

    dsn = _dsn()
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1
    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute("SELECT staff_user_id FROM bedrock.staff_user_id_map WHERE lower(email)=%s",
                    (args.as_staff.lower(),))
        row = cur.fetchone()
        if not row:
            print(f"{args.as_staff} has no staff_user_id mapping", file=sys.stderr)
            return 2
        sid = row["staff_user_id"]
        cur.execute("SELECT id FROM public.org_users WHERE lower(email)=%s", (args.as_staff.lower(),))
        au = cur.fetchone()
        author_id = au["id"] if au else None

        ids = [p["contact_id"] for p in plan]
        cur.execute("""SELECT contact_id, full_name, contact_stage,
                         EXISTS (SELECT 1 FROM public.staff_contact_relationships r
                                  WHERE r.contact_id = c.contact_id AND r.staff_user_id = %s) AS in_network
                       FROM public.contacts c WHERE contact_id = ANY(%s)""", (sid, ids))
        live = {r["contact_id"]: r for r in cur.fetchall()}
        conn.commit()

        gone = [i for i in ids if i not in live]
        merged = [i for i, r in live.items() if r["contact_stage"] == "merged"]
        outside = [i for i, r in live.items() if not r["in_network"]]
        if gone:
            print(f"  WARNING {len(gone)} contact_ids no longer exist: {gone[:8]}")
        if merged:
            print(f"  WARNING {len(merged)} are merged rows — their votes would be invisible: {merged[:8]}")
        if outside:
            print(f"  note: {len(outside)} are not in {args.as_staff}'s network, so the vote "
                  f"won't show on their My Network (it still stores): {outside[:8]}")

        print(f"\n  writing as {args.as_staff} (staff_user_id={sid})")
        for p in plan[:6]:
            nm = live.get(p["contact_id"], {}).get("full_name") or p["name"]
            print(f"    {p['contact_id']:6} {nm[:24]:26} thumbs={'yes' if p['thumbs'] else '-':3}"
                  + (f"  note={p['note'][len(PREFIX):].strip()[:52]!r}" if p["note"] else ""))
        if len(plan) > 6:
            print(f"    … and {len(plan) - 6} more")

        if args.dry_run:
            print("\n[dry-run] nothing written")
            return 0

        applied = notes = 0
        for p in plan:
            if p["contact_id"] not in live or live[p["contact_id"]]["contact_stage"] == "merged":
                continue
            if p["thumbs"]:
                # Partial by design: only the two columns this import owns.
                cur.execute("""INSERT INTO bedrock.connection_status
                                 (staff_user_id, contact_id, status, hiring_fit, updated_by, updated_at)
                               VALUES (%s,%s,%s,%s,%s, now())
                               ON CONFLICT (staff_user_id, contact_id) DO UPDATE
                                 SET status=EXCLUDED.status, hiring_fit=EXCLUDED.hiring_fit,
                                     updated_by=EXCLUDED.updated_by, updated_at=now()""",
                            (sid, p["contact_id"], VOTE_YES, FIT_YES, args.as_staff))
                applied += 1
            if p["note"]:
                # One note per (contact, author): replace rather than append, so a
                # re-run doesn't stack duplicates in the thread.
                cur.execute("""DELETE FROM bedrock.jobs_comment
                                WHERE parent_type='prospect' AND parent_id=%s
                                  AND lower(author_email)=%s AND content ILIKE %s""",
                            (str(p["contact_id"]), args.as_staff.lower(), PREFIX + "%"))
                cur.execute("""INSERT INTO bedrock.jobs_comment
                                 (parent_type, parent_id, author_id, author_email, content)
                               VALUES ('prospect', %s, %s, %s, %s)""",
                            (str(p["contact_id"]), author_id, args.as_staff, p["note"]))
                notes += 1
        conn.commit()
        print(f"\napplied: {applied} thumbs-up rows, {notes} notes")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
