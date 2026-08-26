#!/usr/bin/env python3
"""
Operation 35 — Pursuit · P1 + P2 tagging · psql-free runner.

Runs the same .sql files psql would, for people who don't have psql installed.
The .sql files stay the source of truth — this only translates the handful of
psql-specific constructs they use (\\i, \\echo, \\set/\\if, :'owner').

    python3 scripts/op35/run.py preview
    python3 scripts/op35/run.py apply-contacts          # tags only; no extra grant needed
    python3 scripts/op35/run.py apply --owner you@pursuit.org   # needs the jobs-table grant
    python3 scripts/op35/run.py rollback

Reads DATABASE_URL from the environment. Run it from the repo root.

preview and rollback always roll back. apply commits only if every statement
succeeds and the script's own verification block passes.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from pathlib import Path

try:
    import asyncpg
except ImportError:
    sys.exit(
        "asyncpg is not installed.\n"
        "  pip3 install asyncpg==0.30.0\n"
        "(or: pip3 install -r financial_forecasting/requirements.txt)"
    )

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent

SCRIPTS = {
    "preview": "01-preview.sql",
    "apply": "02-apply.sql",
    "apply-contacts": "02a-apply-contacts.sql",
    "rollback": "03-rollback.sql",
}

COMMITTING = {"apply", "apply-contacts"}


# ── psql translation ─────────────────────────────────────────────────────────

def expand_includes(text: str, depth: int = 0) -> str:
    """Inline `\\i path` the way psql would."""
    if depth > 5:
        raise RuntimeError("\\i nested too deeply")
    out = []
    for line in text.splitlines():
        m = re.match(r"\s*\\i\s+(\S+)\s*$", line)
        if m:
            target = REPO / m.group(1)
            if not target.exists():
                target = HERE / Path(m.group(1)).name
            out.append(expand_includes(target.read_text(encoding="utf-8"), depth + 1))
        else:
            out.append(line)
    return "\n".join(out)


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def strip_leading_comments(stmt: str) -> str:
    """Drop leading -- comment lines so the real verb is visible."""
    return re.sub(r"^(?:[ \t]*--[^\n]*(?:\n|$)|\s*\n)+", "", stmt).strip()


def split_statements(sql: str):
    """
    Split on semicolons at depth zero, respecting '...' literals, dollar-quoted
    blocks ($$ ... $$, $tag$ ... $tag$) and -- comments. Postgres' U&'...'
    escapes pass through untouched.
    """
    stmts, buf, i, n = [], [], 0, len(sql)
    in_single = False
    in_line_comment = False
    dollar_tag = None

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if dollar_tag:
            if sql.startswith(dollar_tag, i):
                buf.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
                continue
            buf.append(ch)
            i += 1
            continue

        if in_single:
            buf.append(ch)
            if ch == "'":
                if nxt == "'":          # escaped quote
                    buf.append(nxt)
                    i += 2
                    continue
                in_single = False
            i += 1
            continue

        if ch == "-" and nxt == "-":
            in_line_comment = True
            buf.append(ch)
            i += 1
            continue

        if ch == "'":
            in_single = True
            buf.append(ch)
            i += 1
            continue

        m = re.match(r"\$[A-Za-z_]*\$", sql[i:])
        if m:
            dollar_tag = m.group(0)
            buf.append(dollar_tag)
            i += len(dollar_tag)
            continue

        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                stmts.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        stmts.append(tail)
    return stmts


def parse(path: Path, owner: str):
    """Yield ('echo', text) and ('sql', statement) in file order."""
    text = expand_includes(path.read_text(encoding="utf-8"))
    text = text.replace(":'owner'", quote_literal(owner))

    segments, pending = [], []

    def flush():
        if not pending:
            return
        for stmt in split_statements("\n".join(pending)):
            body = strip_leading_comments(stmt)
            if not body:
                continue            # comment-only fragment
            # Transaction control is managed by this runner, not the file.
            if body.rstrip(";").strip().upper() in {"BEGIN", "COMMIT", "ROLLBACK"}:
                continue
            segments.append(("sql", stmt))
        pending.clear()

    for line in text.splitlines():
        s = line.strip()
        if s.startswith("\\echo"):
            flush()
            body = s[len("\\echo"):].strip()
            if body.startswith("'") and body.endswith("'") and len(body) >= 2:
                body = body[1:-1].replace("''", "'")
            segments.append(("echo", body))
        elif s.startswith("\\"):
            # \set, \if, \else, \endif — owner is supplied via --owner.
            continue
        else:
            pending.append(line)
    flush()
    return segments


# ── output ───────────────────────────────────────────────────────────────────

def render(rows) -> str:
    if not rows:
        return "(0 rows)"
    cols = list(rows[0].keys())

    def cell(v):
        if v is None:
            return ""
        if isinstance(v, bool):
            return "t" if v else "f"
        if isinstance(v, (list, tuple)):
            return "{" + ",".join(str(x) for x in v) + "}"
        return str(v)

    table = [cols] + [[cell(r[c]) for c in cols] for r in rows]
    widths = [max(len(row[i]) for row in table) for i in range(len(cols))]
    out = [" | ".join(c.ljust(widths[i]) for i, c in enumerate(cols)).rstrip(),
           "-+-".join("-" * w for w in widths)]
    for r in table[1:]:
        out.append(" | ".join(c.ljust(widths[i]) for i, c in enumerate(r)).rstrip())
    out.append(f"({len(rows)} row{'s' if len(rows) != 1 else ''})")
    return "\n".join(out)


# ── main ─────────────────────────────────────────────────────────────────────

async def run(mode: str, owner: str, dsn: str) -> int:
    path = HERE / SCRIPTS[mode]
    if not path.exists():
        sys.exit(f"missing {path}")

    segments = parse(path, owner)
    commit = mode in COMMITTING

    conn = await asyncpg.connect(dsn)
    conn.add_log_listener(lambda _c, msg: print(f"NOTICE:  {msg}"))
    tx = conn.transaction()
    await tx.start()

    try:
        for kind, payload in segments:
            if kind == "echo":
                print(payload)
                continue
            if strip_leading_comments(payload).upper().startswith(("SELECT", "WITH", "TABLE")):
                rows = await conn.fetch(payload)
                print(render(rows))
            else:
                status = await conn.execute(payload)
                if status and not str(status).startswith("DO"):
                    print(str(status))
    except asyncpg.PostgresError as e:
        await tx.rollback()
        await conn.close()
        print(f"\nABORTED — {type(e).__name__}: {e}", file=sys.stderr)
        print("Nothing was written.", file=sys.stderr)
        return 1
    except Exception:
        await tx.rollback()
        await conn.close()
        raise

    if commit:
        await tx.commit()
        print("\nCommitted.")
    else:
        await tx.rollback()
        print("\nRolled back — nothing written.")

    await conn.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=SCRIPTS.keys())
    ap.add_argument("--owner", default="kwame@pursuit.org",
                    help="owner_email stamped on new jobs rows (default: %(default)s)")
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL is not set.\n"
                 '  export DATABASE_URL="$(gcloud secrets versions access latest '
                 '--secret=jobs-dev-database-url --project=pursuit-ops)"')

    if args.mode in COMMITTING:
        scope = ("contacts only — tags + is_jobs_contact"
                 if args.mode == "apply-contacts" else "full — contacts + jobs pipeline")
        print(f"APPLY — will COMMIT. scope: {scope}")
        if args.mode == "apply":
            print(f"owner_email = {args.owner}")
        if input("Type 'apply' to continue: ").strip() != "apply":
            print("Cancelled.")
            return 1

    return asyncio.run(run(args.mode, args.owner, dsn))


if __name__ == "__main__":
    raise SystemExit(main())
