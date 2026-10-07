"""Write the Jobs metric drafts into the data dictionary (PRO-97).

Applies db/dictionary/jobs_metrics.json to bedrock.dd_metrics. A dry run by
default: it prints, field by field, what would change and changes nothing.
With --apply it writes everything in one transaction.

    python -m scripts.import_jobs_dictionary                    # dry run
    python -m scripts.import_jobs_dictionary --apply            # write
    python -m scripts.import_jobs_dictionary --markdown out.md  # readable copy, no database

Run it with the dictionary app's own login (dictionary_app), which is what
writes these rows from the app: DICTIONARY_DATABASE_URL, falling back to
DATABASE_URL. Jac runs it after reviewing PRO-97 (nobody writes to the
dictionary from scripts while he is out).

Rules:
  * A concept is found by its metric_id, else by (stage, name), so drafts
    someone already entered by hand in the app are updated, not duplicated.
    Anything else is inserted, and the new ids are printed for
    services/jobs_metrics.py CONCEPTS.
  * Only the fields present in the JSON change. Measures (`cuts`) are merged
    by key: a measure in the JSON replaces the one with the same key (keeping
    its last_result and last_validated_at), and every other measure stays.
    `caveats_append` is added to the existing caveats once.
  * Nothing is deleted.
  * Anything the group has confirmed in the app is left alone: a confirmed
    concept keeps its text, and a confirmed measure keeps all of it. They are
    listed so someone can look.
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

DRAFTS = Path(__file__).resolve().parent.parent / "db" / "dictionary" / "jobs_metrics.json"

# dd_metrics columns this file may set. Everything else in a concept object
# is bookkeeping for this script.
TEXT_COLS = ["name", "stage", "subdomain", "status", "owner_team", "owner_person", "definition",
             "numerator", "denominator", "grain", "base_population", "source_system",
             "collection_method", "time_of_measurement", "refresh_cadence", "caveats", "sql_query"]
BOOL_COLS = ["is_north_star", "hidden"]
INT_COLS = ["sort_order"]
JSON_COLS = ["segments", "aliases", "example_questions", "mappings", "cuts"]
ALL_COLS = TEXT_COLS + BOOL_COLS + INT_COLS + JSON_COLS
# Kept from a live measure when the JSON replaces it.
KEEP_FROM_LIVE = ("last_result", "last_validated_at")


def load_drafts(path: Path = DRAFTS) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def merge_cuts(live: list, drafts: list) -> tuple[list, list]:
    """(merged cuts, keys left alone because the live measure is confirmed).

    A draft replaces the live measure with its key, or else the one with its
    label: a measure typed into the app by hand gets a key like
    `cut_4_mqtpsi60`, and Bedrock reads measures by the JSON's key."""
    by_key = {c.get("key"): c for c in live}
    by_label = {(c.get("label") or "").strip().lower(): c for c in live}
    skipped = []
    out = list(live)
    for d in drafts:
        cur = by_key.get(d["key"]) or by_label.get(d["label"].strip().lower())
        if cur is None:
            out.append(d)
            continue
        if cur.get("status") == "confirmed":
            skipped.append(d["key"])
            continue
        new = {**d, **{k: cur[k] for k in KEEP_FROM_LIVE if k in cur}}
        out[out.index(cur)] = new
    return out, skipped


def target_row(concept: dict, live: dict | None) -> tuple[dict, list]:
    """The row as it should be after the import, and what was left alone."""
    notes = []
    if live is None:
        row = {c: concept[c] for c in ALL_COLS if c in concept}
        row.setdefault("stage", "Jobs")
        row.setdefault("status", "draft")
        return row, notes
    row = dict(live)
    confirmed = live.get("status") == "confirmed"
    for col in ALL_COLS:
        if col == "cuts" or col not in concept:
            continue
        if confirmed and col in TEXT_COLS:
            notes.append(f"{col}: concept is confirmed, left as is")
            continue
        row[col] = concept[col]
    if concept.get("caveats_append") and not confirmed:
        extra = concept["caveats_append"].strip()
        cur = (row.get("caveats") or "").strip()
        if extra not in cur:
            row["caveats"] = f"{cur}\n\n{extra}" if cur else extra
    if "cuts" in concept:
        row["cuts"], skipped = merge_cuts(live.get("cuts") or [], concept["cuts"])
        notes += [f"measure {k}: confirmed in the app, left as is" for k in skipped]
    return row, notes


def diff(live: dict | None, row: dict) -> list[str]:
    lines = []
    for col in ALL_COLS:
        if col not in row:
            continue
        before = (live or {}).get(col)
        after = row[col]
        if col == "cuts":
            b = {c.get("key"): c for c in (before or [])}
            for c in after:
                old = b.get(c["key"])
                if old is None:
                    lines.append(f"  + measure {c['key']}")
                elif {k: v for k, v in old.items() if k not in KEEP_FROM_LIVE} != \
                        {k: v for k, v in c.items() if k not in KEEP_FROM_LIVE}:
                    changed = sorted(k for k in set(old) | set(c)
                                     if k not in KEEP_FROM_LIVE and old.get(k) != c.get(k))
                    lines.append(f"  ~ measure {c['key']}: {', '.join(changed)}")
        elif before != after:
            show = lambda v: (repr(v)[:70] + "…") if len(repr(v)) > 70 else repr(v)
            lines.append(f"  ~ {col}: {show(before)} -> {show(after)}")
    return lines


async def fetch_live(conn, concept: dict) -> dict | None:
    sel = "SELECT * FROM bedrock.dd_metrics WHERE "
    r = None
    if concept.get("metric_id"):
        r = await conn.fetchrow(sel + "metric_id = $1", concept["metric_id"])
    if r is None:
        r = await conn.fetchrow(sel + "stage = $1 AND name = $2 ORDER BY metric_id LIMIT 1",
                                concept.get("stage", "Jobs"), concept["name"])
    if r is None:
        return None
    row = dict(r)
    for col in JSON_COLS:
        if isinstance(row.get(col), str):
            row[col] = json.loads(row[col])
    return row


async def write(conn, live: dict | None, row: dict) -> int:
    cols = [c for c in ALL_COLS if c in row]
    vals = [json.dumps(row[c]) if c in JSON_COLS else row[c] for c in cols]
    cast = lambda c, i: f"${i}::jsonb" if c in JSON_COLS else f"${i}"
    if live is None:
        sql = (f"INSERT INTO bedrock.dd_metrics ({', '.join(cols)}) "
               f"VALUES ({', '.join(cast(c, i + 1) for i, c in enumerate(cols))}) RETURNING metric_id")
        return await conn.fetchval(sql, *vals)
    sets = ", ".join(f"{c} = {cast(c, i + 2)}" for i, c in enumerate(cols))
    await conn.execute(f"UPDATE bedrock.dd_metrics SET {sets}, updated_at = now() WHERE metric_id = $1",
                       live["metric_id"], *vals)
    return live["metric_id"]


async def run(apply: bool) -> None:
    import asyncpg
    drafts = load_drafts()
    url = os.environ.get("DICTIONARY_DATABASE_URL") or os.environ["DATABASE_URL"]
    conn = await asyncpg.connect(url)
    try:
        plan = []
        for concept in drafts["concepts"]:
            live = await fetch_live(conn, concept)
            row, notes = target_row(concept, live)
            plan.append((concept, live, row))
            where = f"#{live['metric_id']}" if live else "NEW"
            print(f"\n{concept['name']} ({where})")
            for line in diff(live, row) or ["  (no change)"]:
                print(line)
            for n in notes:
                print(f"  ! {n}")
        if not apply:
            print("\nDry run: nothing written. Re-run with --apply to write.")
            return
        new_ids = {}
        async with conn.transaction():
            for concept, live, row in plan:
                mid = await write(conn, live, row)
                if live is None or not concept.get("metric_id"):
                    new_ids[concept["bedrock_key"]] = (mid, concept["name"])
        print("\nWritten.")
        if new_ids:
            print("Pin these in services/jobs_metrics.py CONCEPTS and in the JSON:")
            for key, (mid, name) in new_ids.items():
                print(f'    "{key}": Concept({mid}, "{name}"),')
    finally:
        await conn.close()


def markdown(drafts: dict) -> str:
    """A readable copy, for entering drafts in the dictionary app by hand."""
    out = ["# Jobs metrics: dictionary drafts (PRO-97)", "",
           "Generated from `db/dictionary/jobs_metrics.json` by "
           "`python -m scripts.import_jobs_dictionary --markdown`. Edit the JSON, not this file.", "",
           drafts["about"], ""]
    for c in drafts["concepts"]:
        where = f"#{c['metric_id']}, update" if c.get("metric_id") else "new"
        out += [f"## {c['name']} ({where})", ""]
        if c.get("_update"):
            out += [f"*{c['_update']}*", ""]
        for label, col in (("Stage / area", "subdomain"), ("Definition", "definition"),
                           ("Base population", "base_population"), ("When measured", "time_of_measurement"),
                           ("Segments", "segments"), ("Caveats", "caveats"),
                           ("Add to caveats", "caveats_append")):
            v = c.get(col)
            if v:
                out += [f"**{label}:** {', '.join(v) if isinstance(v, list) else v}", ""]
        for m in c.get("cuts", []):
            out += [f"### {m['label']} (`{m['key']}`, {m['status']})", "", m["definition"], ""]
            if m.get("numerator"):
                out.append(f"- Counts: {m['numerator']}")
            if m.get("denominator"):
                out.append(f"- Divided by: {m['denominator']}")
            for a in m.get("time_anchors", []):
                out.append(f"- Date: {a.get('label')}")
            if m.get("caveat"):
                out.append(f"- Caveat: {m['caveat']}")
            if m.get("sql_query"):
                out += ["", "<details><summary>Reference query</summary>", "", "```sql",
                        m["sql_query"], "```", "", "</details>"]
            out.append("")
    return "\n".join(out)


if __name__ == "__main__":
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--markdown", metavar="PATH", help="write a readable copy and exit")
    a = ap.parse_args()
    if a.markdown:
        Path(a.markdown).write_text(markdown(load_drafts()), encoding="utf-8")
        sys.exit(0)
    asyncio.run(run(a.apply))
