"""Check every Jobs number against its data dictionary entry (PRO-97).

For each number: run the dictionary measure's reference query and Bedrock's
own calculation (the endpoint handler, called directly) over the same dates,
and print whether they match.

    python -m scripts.check_jobs_metrics                          # last completed week
    python -m scripts.check_jobs_metrics --from 2026-09-21 --to 2026-09-27
    python -m scripts.check_jobs_metrics --snapshot               # also save to dd_metric_snapshots

The reference queries read the drafts (db/dictionary/jobs_metrics.json), so
this runs before and after they are imported. Use a login that can read
public.users (CHECK_DATABASE_URL, falling back to DATABASE_URL): the app role
can't (row-level security), so the dictionary's test-account filter would
see nobody and the placement numbers would differ by the test accounts.

--snapshot writes the dictionary's values to bedrock.dd_metric_snapshots for
the concepts that have an id. Only after Jac has reviewed PRO-97.
"""
import argparse
import asyncio
import os
import sys
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Optional

from dotenv import load_dotenv

from scripts.import_jobs_dictionary import load_drafts
from services import jobs_metrics


@dataclass
class Check:
    number: str                  # a jobs_metrics.MEASURES key
    column: str                  # column of the reference query's result
    bedrock: Callable            # async (ctx) -> value


class Ctx:
    """What Bedrock's handlers need, plus a cache so each runs once."""
    def __init__(self, conn, d_from: date, d_to: date):
        self.conn, self.d_from, self.d_to = conn, d_from, d_to
        self._cache: dict = {}

    async def once(self, key, fn):
        if key not in self._cache:
            self._cache[key] = await fn()
        return self._cache[key]


async def _placements(ctx):
    from routes import jobs
    return await ctx.once("placements", lambda: jobs.get_placements(segment=None, user=None, conn=ctx.conn))


async def _summary(ctx):
    from routes import jobs
    return await ctx.once("summary", lambda: jobs.outreach_summary(
        granularity="week", scope="team", owner=None, date_from=ctx.d_from.isoformat(),
        date_to=ctx.d_to.isoformat(), user=None, conn=ctx.conn))


async def _scorecard(ctx):
    from routes import jobs
    return await ctx.once("scorecard", lambda: jobs.outreach_scorecard(
        granularity="week", scope="team", owner=None, date_from=ctx.d_from.isoformat(),
        date_to=ctx.d_to.isoformat(), user=None, conn=ctx.conn))


async def _overview(ctx):
    from routes import jobs
    return await ctx.once("overview", lambda: jobs.opportunities_overview(
        owner=None, deal_type=None, week_end=ctx.d_to.isoformat(), start=ctx.d_from.isoformat(),
        user=None, conn=ctx.conn))


async def _segments(ctx):
    from routes import jobs
    return await ctx.once("segments", lambda: jobs.builder_segments(user=None, conn=ctx.conn))


async def _in_role(ctx):
    d = (await _placements(ctx))["data"]
    return d["ft_builders"] - d["ft_no_longer_in_role"]


def _row(metric):
    async def get(ctx):
        rows = (await _scorecard(ctx))["data"]["activity_pipeline"]
        return next(r["this_period"] for r in rows if r["metric"] == metric)
    return get


def _data(fetch, *path):
    async def get(ctx):
        v = (await fetch(ctx))["data"]
        for p in path:
            v = v[p]
        return v
    return get


CHECKS = [
    Check("placed_ft", "full_time", _data(_placements, "ft_builders")),
    Check("placed_ft_in_role", "full_time", _in_role),
    Check("paid_work", "builders_with_paid_work", _data(_placements, "any_builders")),
    Check("ft_roles_secured", "ft_roles_secured", _data(_placements, "ft_roles_secured")),
    Check("placed_ft_rate", "rate_pct", _data(_placements, "placed_ft_rate")),
    Check("trials_running", "trials_running", _data(_placements, "committed_trial_active")),
    Check("committed_roles", "committed_roles", _data(_placements, "committed_ft_roles")),
    Check("avg_ft_salary_placed", "avg_ft_salary", _data(_placements, "avg_salary_ft_placed")),
    Check("avg_ft_salary_secured", "avg_ft_salary", _data(_placements, "avg_salary_ft_secured")),
    Check("job_ready_pool", "job_ready_pool", _data(_segments, "total")),
    Check("accounts_activated", "accounts_activated", _data(_summary, "accounts_activated")),
    Check("outreach", "outreach", _data(_summary, "outreach_activity")),
    Check("calls", "calls", _data(_summary, "calls_booked")),
    Check("converted_opportunities", "converted", _data(_summary, "converted")),
    Check("direct_email", "direct_email", _row("direct_email_sent")),
    Check("linkedin", "linkedin", _row("linkedin_message_sent")),
    Check("text", "text", _row("text_sent")),
    Check("intro", "intro", _row("facilitated_intro_sent")),
    Check("call_discovery", "call_discovery", _row("call_discovery")),
    Check("call_general", "call_general", _row("call_general")),
    Check("opportunities_open", "opportunities_open", _data(_overview, "summary", "in_set")),
    Check("opportunities_new", "opportunities_new", _data(_overview, "summary", "net_new")),
    Check("stalled_opportunities", "stalled_opportunities", _data(_overview, "summary", "stalled")),
    Check("closed_won", "closed_won", _data(_overview, "summary", "moved_committed")),
    Check("closed_lost", "closed_lost", _data(_overview, "summary", "closed_lost")),
]


def _reference_sql(number: str, drafts: dict) -> Optional[str]:
    m = jobs_metrics.MEASURES[number]
    concept = next(c for c in drafts["concepts"] if c["bedrock_key"] == m.concept)
    cut = next((c for c in concept.get("cuts", []) if c["key"] == m.cut), None)
    return cut and cut["sql_query"] or None


def _same(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) < 0.51        # rounding: SQL half-up vs Python half-even


async def compare(conn, d_from: date, d_to: date) -> list[dict]:
    """[{number, dictionary, bedrock, match, error}] for every check."""
    drafts = load_drafts()
    ctx = Ctx(conn, d_from, d_to)
    out = []
    for chk in CHECKS:
        rec = {"number": chk.number, "dictionary": None, "bedrock": None, "match": False, "error": None}
        try:
            sql = _reference_sql(chk.number, drafts)
            async with conn.transaction():
                await conn.execute(f"SET LOCAL dd.window_from = '{d_from.isoformat()}'")
                await conn.execute(f"SET LOCAL dd.window_to = '{d_to.isoformat()}'")
                row = await conn.fetchrow(sql)
            rec["dictionary"] = row[chk.column] if row else None
            rec["bedrock"] = await chk.bedrock(ctx)
            rec["match"] = _same(rec["dictionary"], rec["bedrock"])
        except Exception as e:      # report and carry on
            rec["error"] = repr(e)
        out.append(rec)
    return out


async def snapshot(conn, results: list[dict], on: date) -> int:
    """Save the dictionary's values for concepts that have an id."""
    n = 0
    for r in results:
        m = jobs_metrics.MEASURES[r["number"]]
        concept = jobs_metrics.CONCEPTS[m.concept]
        if concept.metric_id is None or r["error"] or r["dictionary"] is None:
            continue
        chk = next(c for c in CHECKS if c.number == r["number"])
        await conn.execute("""
            INSERT INTO bedrock.dd_metric_snapshots
                (snapshot_date, metric_id, concept, measure, column_name, value_num)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (snapshot_date, metric_id, measure, column_name)
            DO UPDATE SET value_num = EXCLUDED.value_num, captured_at = now(), error = NULL
        """, on, concept.metric_id, concept.name, m.cut, chk.column, float(r["dictionary"]))
        n += 1
    return n


async def main(d_from: date, d_to: date, save: bool) -> int:
    import asyncpg
    from services import jobs_targets_store
    url = os.environ.get("CHECK_DATABASE_URL") or os.environ["DATABASE_URL"]
    pool = await asyncpg.create_pool(url, min_size=1, max_size=2)
    try:
        await jobs_targets_store.refresh(pool, force=True)
        await jobs_metrics.refresh(pool, force=True)
        async with pool.acquire() as conn:
            results = await compare(conn, d_from, d_to)
            print(f"Jobs metrics, {d_from} to {d_to} (New York):\n")
            print(f"  {'number':<26}{'dictionary':>12}{'bedrock':>12}")
            for r in results:
                mark = "ok" if r["match"] else ("ERROR " + r["error"][:60] if r["error"] else "DIFFERENT")
                print(f"  {r['number']:<26}{str(r['dictionary']):>12}{str(r['bedrock']):>12}   {mark}")
            bad = [r for r in results if not r["match"]]
            print(f"\n{len(results) - len(bad)} of {len(results)} match.")
            if save:
                print(f"Saved {await snapshot(conn, results, date.today())} values to dd_metric_snapshots.")
            return 1 if bad else 0
    finally:
        await pool.close()


if __name__ == "__main__":
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    monday, sunday = jobs_metrics.meeting_week("monday")
    ap.add_argument("--from", dest="d_from", type=date.fromisoformat, default=monday)
    ap.add_argument("--to", dest="d_to", type=date.fromisoformat, default=sunday)
    ap.add_argument("--snapshot", action="store_true", help="save to dd_metric_snapshots (after review)")
    a = ap.parse_args()
    sys.exit(asyncio.run(main(a.d_from, a.d_to, a.snapshot)))
