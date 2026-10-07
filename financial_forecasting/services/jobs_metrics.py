"""Jobs metrics: one definition per number, read from the data dictionary (PRO-97).

Pursuit keeps its metric definitions in the data dictionary
(`bedrock.dd_metrics`, the app at data-dictionary-866060457933.us-central1.run.app).
Every number on the Jobs Overview, Outreach, Pipeline and Campaigns tabs is tied
to one entry there: a concept (a `dd_metrics` row) and one of its measures (an
element of the row's `cuts`). Bedrock doesn't keep its own copy of the words.
It reads the definition and its status from the dictionary and returns them
beside each number (`define`), which is what the "How is this calculated?"
icon shows (PRO-105).

The drafts of every entry live in `db/dictionary/jobs_metrics.json`, with a
reference query per measure. `scripts/import_jobs_dictionary.py` writes them
to the dictionary, and `scripts/check_jobs_metrics.py` runs each reference
query beside Bedrock's own calculation over the same dates. If a rule here
changes, change the entry there.

The shared rules live here too, so each is written once:

  * the week (D8): calendar weeks, Monday to Sunday, New York time;
  * activity (D17): `services/outreach_counting.py`, re-exported below;
  * stalled (D3): no jobs-related activity for 2 weeks on a contact, 4 on an
    opportunity, 6 on an account;
  * placed and paid work (D2, D4; Nina 10/7): who counts, from employment
    records;
  * committed roles: open, committed, not a trial, full-time;
  * the job-ready pool: builders ever enrolled in an L3+ course;
  * one stage map, old stage names folded into current ones on read;
  * who an outcome belongs to (the owner rules; D6 is still open, PRO-101).
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Iterable, Mapping, Optional
from zoneinfo import ZoneInfo

from services.outreach_counting import (  # noqa: F401  (the activity rule, D17)
    jobs_relevant_sql, not_autoreply_sql,
)

logger = logging.getLogger(__name__)

NY = ZoneInfo("America/New_York")


# ── The dictionary ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Concept:
    metric_id: Optional[int]    # dd_metrics.metric_id; None until it is entered
    name: str                   # dd_metrics.name, as entered in the app


# The concepts the Jobs numbers belong to. Ids are pinned once an entry exists
# in the dictionary. The app assigns them, so a new concept has none until
# someone enters it, and its numbers read "not in the dictionary yet".
CONCEPTS: dict[str, Concept] = {
    "employment":          Concept(171, "Employment"),
    "salary":              Concept(164, "Post-program salary"),
    "job_ready_pool":      Concept(176, "Job-ready pool (L3+)"),
    "retention":           Concept(123, "Job retention"),
    "employer_outreach":   Concept(None, "Employer outreach"),
    "employer_pipeline":   Concept(None, "Employer pipeline"),
    "employer_conversion": Concept(None, "Employer conversion"),
    "jobs_targets":        Concept(None, "Jobs targets"),
    "jobs_conventions":    Concept(None, "Jobs conventions"),
}


@dataclass(frozen=True)
class Measure:
    concept: str            # a CONCEPTS key
    cut: str                # the measure's `key` in dd_metrics.cuts
    column: Optional[str] = None   # which column of the measure's query, when it returns several


# Every number Bedrock shows on the four tabs, by the name the code uses for
# it, and the dictionary measure that defines it. A number used on two tabs is
# one entry here. Its filters (a campaign, an owner, a cohort) are reported
# beside it rather than making it a different measure.
MEASURES: dict[str, Measure] = {
    # Outcomes (Overview)
    "ft_roles_secured":       Measure("employment", "ft_roles_secured"),
    "placed_ft":              Measure("employment", "ever_employed_count", "full_time"),
    "placed_ft_in_role":      Measure("employment", "actively_employed_count", "full_time"),
    "placed_ft_rate":         Measure("employment", "placed_ft_rate", "rate_pct"),
    "trials_running":         Measure("employment", "trials_running"),
    "paid_work":              Measure("employment", "builders_with_paid_work"),
    "avg_ft_salary_placed":   Measure("salary", "avg_ft_salary_placed"),
    "avg_ft_salary_secured":  Measure("salary", "avg_ft_salary_secured"),
    "job_ready_pool":         Measure("job_ready_pool", "pool"),
    "committed_roles":        Measure("employer_pipeline", "committed_roles"),
    # Outreach
    "accounts_activated":     Measure("employer_outreach", "accounts_activated"),
    "outreach":               Measure("employer_outreach", "outreach_sent"),
    "direct_email":           Measure("employer_outreach", "direct_email_sent"),
    "linkedin":               Measure("employer_outreach", "linkedin_message_sent"),
    "text":                   Measure("employer_outreach", "text_sent"),
    "intro":                  Measure("employer_outreach", "facilitated_intro_sent"),
    "calls":                  Measure("employer_outreach", "calls"),
    "call_discovery":         Measure("employer_outreach", "call_discovery"),
    "call_general":           Measure("employer_outreach", "call_general"),
    "contacted":              Measure("employer_outreach", "contacted"),
    "activity_depth":         Measure("employer_outreach", "activity_depth"),
    "campaign_contacts":      Measure("employer_outreach", "campaign_contacts"),
    "campaign_accounts":      Measure("employer_outreach", "campaign_accounts"),
    "campaign_reached":       Measure("employer_outreach", "campaign_reached"),
    # Pipeline
    "contacts_by_stage":      Measure("employer_pipeline", "contacts_by_stage"),
    "contacts_entering_stage": Measure("employer_pipeline", "contacts_entering_stage"),
    "opportunities_by_stage": Measure("employer_pipeline", "opportunities_by_stage"),
    "opportunities_entering_stage": Measure("employer_pipeline", "opportunities_entering_stage"),
    "opportunities_open":     Measure("employer_pipeline", "opportunities_open"),
    "opportunities_new":      Measure("employer_pipeline", "opportunities_new"),
    "stalled_opportunities":  Measure("employer_pipeline", "stalled_opportunities"),
    "closed_won":             Measure("employer_pipeline", "closed_won"),
    "closed_lost":            Measure("employer_pipeline", "closed_lost"),
    "won_open_tasks":         Measure("employer_pipeline", "won_open_tasks"),
    "time_in_stage":          Measure("employer_pipeline", "time_in_stage"),
    # Conversion
    "converted_opportunities": Measure("employer_conversion", "contacts_converted"),
    "contact_cohort_conversion": Measure("employer_conversion", "contact_cohort_conversion"),
    "stage_flow_conversion":  Measure("employer_conversion", "stage_flow_conversion"),
    "opportunity_stage_ratio": Measure("employer_conversion", "opportunity_stage_ratio"),
    "campaign_conversion":    Measure("employer_conversion", "campaign_conversion"),
    # Targets
    "activity_target":        Measure("jobs_targets", "activity_vs_target"),
    "jobs_projection":        Measure("jobs_targets", "jobs_vs_target"),
}

# Measures that exist in the dictionary and follow the rules below, but no
# card shows yet. The checks still run them.
UNSHOWN_MEASURES: dict[str, Measure] = {
    "stalled_contacts":       Measure("employer_pipeline", "stalled_contacts"),
    "stalled_accounts":       Measure("employer_pipeline", "stalled_accounts"),
    "milestone_to_interview": Measure("employer_conversion", "milestone_to_interview"),
    "interview_to_hire":      Measure("employer_conversion", "interview_to_hire"),
}

TTL_SECONDS = 60


class _Snapshot:
    def __init__(self):
        self.loaded_at = 0.0
        self.available = False
        self.rows: dict[int, dict] = {}      # metric_id -> dd_metrics row


_snap = _Snapshot()


def reset() -> None:
    """Forget what was read. Tests use this."""
    global _snap
    _snap = _Snapshot()


def load(rows: Iterable[Mapping]) -> None:
    """Replace the snapshot with these dd_metrics rows. refresh() calls it;
    tests call it with rows of their own."""
    global _snap
    fresh = _Snapshot()
    fresh.loaded_at = time.monotonic()
    fresh.available = True
    for r in rows:
        r = dict(r)
        if isinstance(r.get("cuts"), str):            # selected as text below
            r["cuts"] = json.loads(r["cuts"])
        fresh.rows[r["metric_id"]] = r
    _snap = fresh


async def refresh(pool, force: bool = False) -> None:
    """Re-read the Jobs entries if the snapshot is older than the TTL. The
    dictionary is edited by people in its own app, so a change shows here
    within a minute. A failed read keeps the previous snapshot: never take a
    Jobs page down over the words beside a number."""
    if pool is None:
        return
    if not force and time.monotonic() - _snap.loaded_at < TTL_SECONDS:
        return
    ids = [c.metric_id for c in CONCEPTS.values() if c.metric_id is not None]
    try:
        rows = await pool.fetch(
            "SELECT metric_id, name, status, hidden, definition, numerator, denominator, "
            "       base_population, caveats, cuts::text AS cuts, updated_at "
            "FROM bedrock.dd_metrics WHERE metric_id = ANY($1::int[])", ids)
    except Exception as e:
        logger.warning(f"data dictionary read failed, keeping previous snapshot: {e!r}")
        _snap.loaded_at = time.monotonic()
        return
    load(rows)


def _entry(key: str) -> tuple[Optional[Measure], Optional[Concept], Optional[dict], Optional[dict]]:
    m = MEASURES.get(key) or UNSHOWN_MEASURES.get(key)
    if m is None:
        return None, None, None, None
    concept = CONCEPTS[m.concept]
    row = _snap.rows.get(concept.metric_id) if concept.metric_id is not None else None
    cut = None
    if row:
        cut = next((c for c in (row.get("cuts") or []) if c.get("key") == m.cut), None)
    return m, concept, row, cut


def define(key: str, *, value=None, window: Optional[tuple] = None,
           filters: Optional[Mapping] = None, records: Optional[Mapping] = None) -> dict:
    """What a number means, for the response beside it.

    `window` is the half-open [start, end) the number covers (aware datetimes,
    New York midnights) or None for a number "as of now". `filters` are what
    the viewer narrowed it by. `records` is how to fetch the rows behind the
    number: {"endpoint": "/api/jobs/...", "params": {...}}.

    The words come only from the dictionary. An entry that isn't there yet
    says so (`status: "not_in_dictionary"`); Bedrock never fills the gap with
    text of its own.
    """
    m, concept, row, cut = _entry(key)
    if m is None:
        raise KeyError(f"jobs_metrics: no measure registered for {key!r}")
    out = {
        "key": key,
        "value": value,
        "metric_id": concept.metric_id,
        "concept": row["name"] if row else concept.name,
        "measure": m.cut,
        "column": m.column,
        "label": None,
        "definition": None,
        "numerator": None,
        "denominator": None,
        "status": "not_in_dictionary",
        "window": _window_json(window),
        "filters": {k: v for k, v in (filters or {}).items() if v not in (None, "", "all")},
        "records": dict(records) if records else None,
    }
    if row is None:
        return out
    if cut is None:
        # The concept is there but this measure isn't yet.
        out["definition"] = row.get("definition")
        out["status"] = "measure_not_in_dictionary"
        return out
    out.update({
        "label": cut.get("label"),
        "definition": cut.get("definition") or row.get("definition"),
        "numerator": cut.get("numerator"),
        "denominator": cut.get("denominator"),
        "status": cut.get("status") or row.get("status"),
    })
    return out


def define_many(keys: Iterable[str], **common) -> dict:
    """`define` for several numbers sharing a window and filters."""
    return {k: define(k, **common) for k in keys}


def available() -> bool:
    return _snap.available


# ── The dictionary's own queries ─────────────────────────────────────────────
# Each measure's reference query stands on its own, so the dictionary app can
# run it and anyone can check Bedrock's number against it. A query with a
# date window reads it from two settings, New York dates, both inclusive:
#     SET dd.window_from = '2026-09-21'; SET dd.window_to = '2026-09-27';
# With neither set it covers the last completed calendar week (D8). The Jobs
# team is whoever was on it in Settings › Targets › Jobs when they did the work.

DD_FROM = ("coalesce(nullif(current_setting('dd.window_from', true), '')::date, "
           "date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7)")
DD_TO = ("(coalesce(nullif(current_setting('dd.window_to', true), '')::date, "
         "date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1)")
DD_START = f"(({DD_FROM})::timestamp AT TIME ZONE 'America/New_York')"
DD_END = f"(({DD_TO})::timestamp AT TIME ZONE 'America/New_York')"
DD_TODAY = "(now() AT TIME ZONE 'America/New_York')::date"
# Everyone ever on the Jobs team. Which of their activity counts is decided per
# event by who was on the team at the time (reference_sql team_history;
# decided 2026-10-07), so a change in Settings never recounts a past week.
DD_TEAM = ("(SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM ("
           "SELECT email FROM bedrock.jobs_team_member "
           "UNION SELECT email FROM bedrock.jobs_team_change) t)")
DD_PURSUIT = ("(SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') "
              "FROM public.org_users WHERE is_active AND email IS NOT NULL)")

# The columns of outreach_counting.reference_sql, by measure.
OUTREACH_COLUMNS = {
    "outreach_sent": "outreach", "direct_email_sent": "direct_email",
    "linkedin_message_sent": "linkedin", "text_sent": "text",
    "facilitated_intro_sent": "intro", "calls": "calls",
    "call_discovery": "call_discovery", "call_general": "call_general",
    "accounts_activated": "accounts_activated",
}


def dictionary_outreach_sql(cut: str) -> str:
    """The reference query for one outreach measure: the Jobs team's activity
    in the dictionary window, by the rules in services/outreach_counting."""
    from services.outreach_counting import reference_sql
    col = OUTREACH_COLUMNS[cut]
    inner = reference_sql(p_start="(SELECT start_at FROM w)", p_end="(SELECT end_at FROM w)",
                          p_senders="(SELECT team FROM w)", team_history=True)
    return (f"WITH w AS (SELECT {DD_START} AS start_at, {DD_END} AS end_at, {DD_TEAM} AS team)\n"
            f"SELECT {col} FROM ({inner}) q")


def dictionary_depth_sql() -> str:
    """The reference query for Activity depth: contacts in Initial Outreach
    now, by how much activity anyone at Pursuit sent them in the last four
    weeks."""
    from services.outreach_counting import depth_sql
    inner = depth_sql(p_since="(SELECT since FROM w)", p_senders="(SELECT senders FROM w)")
    return (f"WITH w AS (SELECT now() - interval '4 weeks' AS since, {DD_PURSUIT} AS senders)\n"
            "SELECT CASE WHEN activity >= 4 THEN '4+' ELSE activity::text END AS bucket, "
            f"count(*) AS contacts FROM ({inner}) d GROUP BY 1 ORDER BY 1")


# ── The week (D8) ────────────────────────────────────────────────────────────
# A week is a calendar week, Monday to Sunday, in New York. The Monday meeting
# looks at the week that just ended; the Thursday meeting at the week it is
# in. Any range can be picked. Dates arriving from the browser are New York
# dates, both ends inclusive.

def ny_midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=NY)


def ny_today() -> date:
    return datetime.now(NY).date()


def calendar_week(d: date) -> tuple[date, date]:
    """The Monday and Sunday of the week holding d."""
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=6)


def meeting_week(meeting: str, today: Optional[date] = None) -> tuple[date, date]:
    """The week a meeting reviews: Monday's is the week just ended, Thursday's
    the current one."""
    today = today or ny_today()
    monday, sunday = calendar_week(today)
    if meeting == "monday":
        return monday - timedelta(days=7), monday - timedelta(days=1)
    if meeting == "thursday":
        return monday, sunday
    raise ValueError(f"unknown meeting {meeting!r}")


def parse_date(v) -> date:
    return v if isinstance(v, date) else date.fromisoformat(str(v))


def date_window(date_from, date_to) -> tuple[datetime, datetime]:
    """[start, end) for New York dates `date_from`..`date_to`, both inclusive.
    Raises ValueError on a malformed date or a range that ends before it
    starts."""
    d_from, d_to = parse_date(date_from), parse_date(date_to)
    if d_to < d_from:
        raise ValueError("the range ends before it starts")
    return ny_midnight(d_from), ny_midnight(d_to + timedelta(days=1))


def prior_window(start: datetime, end: datetime) -> tuple[datetime, datetime]:
    """The same number of days immediately before [start, end). Counted in
    New York days, not hours, so a span across a clock change stays whole
    days."""
    days = (end.date() - start.date()).days
    s = start.date() - timedelta(days=days)
    return ny_midnight(s), ny_midnight(start.date())


def _window_json(window: Optional[tuple]) -> Optional[dict]:
    if not window:
        return None
    start, end = window
    return {
        "from": start.astimezone(NY).date().isoformat() if start else None,
        # Inclusive last day, the way people read a range.
        "to": (end.astimezone(NY) - timedelta(seconds=1)).date().isoformat() if end else None,
        "tz": "America/New_York",
    }


# ── Stalled (D3) ─────────────────────────────────────────────────────────────
# No jobs-related activity for 2 weeks on a contact, 4 weeks on an
# opportunity, 6 weeks on an account. Comments are not activity. An account
# is stalled only when none of its contacts were touched and none of its
# opportunities moved, which is what "the latest activity on anything at the
# account" measures.

ACTIVITY_TYPES = ("email", "call", "meeting", "linkedin", "text")


def external_activity_sql(alias: str = "a") -> str:
    """SQL: a live, jobs-related activity row that is an external touch
    (email, call, meeting, LinkedIn, text). Notes are comments and don't
    count (D3, D17)."""
    types = ", ".join(f"'{t}'" for t in ACTIVITY_TYPES)
    return (f"({alias}.deleted_at IS NULL AND {alias}.type IN ({types}) "
            f"AND {jobs_relevant_sql(alias)})")


STALLED_AFTER: dict[str, timedelta] = {
    "contact": timedelta(weeks=2),
    "opportunity": timedelta(weeks=4),
    "account": timedelta(weeks=6),
}


def is_stalled(entity: str, last_activity: Optional[datetime], as_of: datetime) -> bool:
    """True when nothing has happened on it for longer than its limit.
    Nothing ever (no activity at all) is stalled."""
    if last_activity is None:
        return True
    return as_of - last_activity > STALLED_AFTER[entity]


def stalled_label(entity: str) -> str:
    return f"No activity in {STALLED_AFTER[entity].days // 7}+ weeks"


# ── The stage map ────────────────────────────────────────────────────────────
# Read-time normalisation to the current vocabulary. The migrations that
# rewrite stored stages are applied by Jac, so until they land the database
# still holds retired names. Folding them on READ means every count shows the
# current stages at once; after the migration it is a no-op.

STAGE_CANON = {
    "initial_outreach": "active_in_discussions",
    # Retired 2026-09-21. Each maps exactly where the migration sends the rows,
    # so pre- and post-migration reads agree. builder_submitted is the earlier
    # of the two stages reviewing_builders straddled, so the fold never claims
    # an interview that may not have happened.
    "lead_submitted": "active_in_discussions",
    "reviewing_builders": "builder_submitted",
    "active_builder_interview": "builder_submitted",
    "on_hold_not_interested": "closed_lost",
    "on_hold_not_responsive": "closed_lost",
    "on_hold_not_selected": "closed_lost",
}
MEMBERSHIP_CANON = {"on_hold": "revisit"}

# The contact pipeline, in order. The last two are off-ramps.
MEMBERSHIP_STAGE_ORDER = [
    ("assigned", "Assigned"),
    ("initial_outreach", "Initial Outreach"),
    ("scheduling", "Scheduling"),
    ("call_booked", "Call Booked"),
    ("converted_to_opportunity", "Converted to Opportunity"),
    ("revisit", "Revisit"),
    ("not_a_fit", "Not a Fit"),
]
MEMBERSHIP_STAGES = [k for k, _ in MEMBERSHIP_STAGE_ORDER]


def canon_stage(stage: Optional[str]) -> Optional[str]:
    return STAGE_CANON.get(stage, stage) if stage else stage


def canon_membership_stage(stage: Optional[str]) -> Optional[str]:
    return MEMBERSHIP_CANON.get(stage, stage) if stage else stage


def canon_stage_sql(col: str = "o.stage") -> str:
    """The same mapping as an SQL expression, for GROUP BY and filters."""
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in STAGE_CANON.items())
    return f"(CASE {col} {whens} ELSE {col} END)"


def canon_membership_sql(col: str = "m.stage") -> str:
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in MEMBERSHIP_CANON.items())
    return f"(CASE {col} {whens} ELSE {col} END)"


# ── Owners ───────────────────────────────────────────────────────────────────
# Who an outcome belongs to. D6 (who owns a contact who needs Nick's intro) is
# still open, so these are today's rules, written once; PRO-101 settles them.
#   * outreach: whoever did it (outreach_counting: the sender, never the mailbox);
#   * a conversion: the membership's owner, else the account's, else whoever
#     did the first outreach;
#   * a campaign contact: the membership's owner, else the account's;
#   * an opportunity: its own owner.

CONVERSION_OWNER_SQL = "lower(coalesce(m.owner_email, ja.owner_email, m.first_outreach_by))"
CONTACT_OWNER_SQL = "coalesce(m.owner_email, ja.owner_email)"
# The membership and its account, for the two owner rules above.
MEMBERSHIP_WITH_ACCOUNT_SQL = """
    FROM bedrock.jobs_contact_membership m
    JOIN public.contacts c ON c.contact_id = m.contact_id
    LEFT JOIN bedrock.jobs_account ja
      ON ja.account_key = nullif(lower(btrim(coalesce(c.current_company, ''))), '')
"""


# ── Placed and paid work (D2, D4; Nina 2026-10-07) ───────────────────────────
# From employment records. A record counts as a placement when:
#   * the person isn't a test account (users.exclude_from_metrics);
#   * a pay amount is recorded (unpriced work doesn't count: dictionary, 8/16);
#   * it isn't pro bono, and isn't a `pipeline` record (not a job yet);
#   * it has started (no start date is counted, and flagged as a data gap);
#   * its opportunity wasn't deleted as a data-entry error (TKT-161).
# Pursuit's own hires count, whatever their role is now (dictionary, 9/24).
# A builder counts once. Full-time is the core number; all paid work can be
# viewed (D4). A builder who has left the role still counts as placed, and
# the card says how many are still in it.
# Trials: D2 says trials count; how is PRO-99's to build. Today a running
# trial is reported beside the number, not in it.

def live_placement(a: str = "") -> str:
    """SQL: the record's opportunity wasn't soft-deleted (TKT-161).
    Self-sourced placements, with no opportunity, stay."""
    col = f"{a}.opportunity_id" if a else "opportunity_id"
    return (f"({col} IS NULL OR NOT EXISTS (SELECT 1 FROM bedrock.jobs_opportunity dop "
            f"WHERE dop.id = {col} AND dop.deleted_at IS NOT NULL))")


def trial_running_sql(a: str = "r") -> str:
    """SQL: a committed trial actually under way. A builder is in it and it
    hasn't ended. Staff close a trial by putting an end date on the role (it
    stays `filled`, since it was), so a past end date marks it finished. A
    future end date still reads as running."""
    return (f"{a}.commitment = 'committed' AND {a}.is_trial = true "
            f"AND {a}.filled_by_user_id IS NOT NULL AND {a}.status <> 'cancelled' "
            f"AND ({a}.end_date IS NULL OR {a}.end_date >= CURRENT_DATE)")


EMPLOYMENT_FN = "bedrock.jobs_employment_records()"
# Before migrations/2026-10-07-jobs-employment-records-fn.sql runs: the same
# rows, without the test-account flag or end dates.
EMPLOYMENT_FN_FALLBACK = "bedrock.secured_jobs()"
_fallback_warned = False


def employment_sql(fn: str = EMPLOYMENT_FN) -> str:
    """Every employment record on a live opportunity (or none), with the
    columns the placement rule reads."""
    if fn == EMPLOYMENT_FN:
        cols = "s.*"
    else:
        cols = ("s.id, s.user_id, s.builder, s.role_title, s.company_name, s.employment_type, "
                "s.engagement_stage, s.payment_amount, s.influenced, s.opportunity_id, "
                "s.start_date, NULL::date AS end_date, s.source, false AS excluded")
    return f"SELECT {cols} FROM {fn} s WHERE {live_placement('s')}"


async def employment_records(conn) -> list[dict]:
    """The rows the placement rule runs over (see `counts_as_placement`)."""
    global _fallback_warned
    try:
        rows = await conn.fetch(employment_sql())
    except Exception as e:
        # UndefinedFunctionError: the migration hasn't run yet.
        if "jobs_employment_records" not in str(e):
            raise
        if not _fallback_warned:
            logger.warning("bedrock.jobs_employment_records() is missing; run "
                           "migrations/2026-10-07-jobs-employment-records-fn.sql. "
                           "Test accounts are counted until then.")
            _fallback_warned = True
        rows = await conn.fetch(employment_sql(EMPLOYMENT_FN_FALLBACK))
    return [dict(r) for r in rows]


def counts_as_placement(r: Mapping, today: Optional[date] = None) -> bool:
    today = today or ny_today()
    start = r.get("start_date")
    return (not r.get("excluded")
            and (r.get("payment_amount") or 0) > 0
            and r.get("employment_type") != "pro_bono"
            and r.get("engagement_stage") != "pipeline"
            and (start is None or start <= today))


def in_role(r: Mapping, today: Optional[date] = None) -> bool:
    """The builder is in this job now."""
    today = today or ny_today()
    end = r.get("end_date")
    return r.get("engagement_stage") == "active" and (end is None or end >= today)


@dataclass
class Placements:
    """The placement numbers for one set of employment records."""
    records: list            # the records that count, one or more per builder
    ft_uids: set
    paid_uids: set
    ft_in_role_uids: set
    influenced_uids: set
    ft_salary: dict          # user_id -> highest full-time pay

    @property
    def placed_ft(self) -> int:
        return len(self.ft_uids)

    @property
    def paid_work(self) -> int:
        return len(self.paid_uids)

    @property
    def ft_no_longer_in_role(self) -> int:
        return len(self.ft_uids - self.ft_in_role_uids)

    @property
    def avg_ft_salary_placed(self) -> Optional[int]:
        vals = list(self.ft_salary.values())
        return round(sum(vals) / len(vals)) if vals else None

    def avg_ft_salary_secured(self, committed_salaries: Iterable[float]) -> Optional[int]:
        """Placed builders' salaries blended with the expected salary of
        committed, unfilled full-time roles."""
        vals = list(self.ft_salary.values()) + [float(s) for s in committed_salaries if s]
        return round(sum(vals) / len(vals)) if vals else None


def placements(rows: Iterable[Mapping], *, user_ids: Optional[set] = None,
               today: Optional[date] = None) -> Placements:
    """Apply the placement rule. `user_ids` narrows to some builders (an L3
    cohort, the job-ready pool)."""
    today = today or ny_today()
    counted = [r for r in rows if counts_as_placement(r, today)
               and (user_ids is None or r["user_id"] in user_ids)]
    ft = [r for r in counted if r["employment_type"] == "full_time"]
    salary: dict = {}
    for r in ft:
        salary[r["user_id"]] = max(salary.get(r["user_id"], 0), float(r["payment_amount"]))
    return Placements(
        records=counted,
        ft_uids={r["user_id"] for r in ft},
        paid_uids={r["user_id"] for r in counted},
        ft_in_role_uids={r["user_id"] for r in ft if in_role(r, today)},
        influenced_uids={r["user_id"] for r in counted if r.get("influenced") is True},
        ft_salary=salary,
    )


# ── Committed roles ──────────────────────────────────────────────────────────
# Full-time seats an employer has committed to and nobody fills yet: open,
# committed (not open-market), not a trial (a trial converts into a separate
# full-time role, and that role is the commitment), on a live opportunity, and
# full-time, either typed so or untyped on a full-time deal.

COMMITTED_ROLE_SQL = (
    "r.status = 'open' AND o.deleted_at IS NULL "
    "AND r.commitment = 'committed' AND r.is_trial = false "
    "AND (r.employment_type = 'full_time' OR (r.employment_type IS NULL AND o.deal_type = 'ft'))"
)


def committed_roles_sql(cols: str = "r.*", order: str = "") -> str:
    return (f"SELECT {cols} FROM bedrock.jobs_role r "
            f"JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id "
            f"WHERE {COMMITTED_ROLE_SQL}" + (f" ORDER BY {order}" if order else ""))


# ── The job-ready pool ───────────────────────────────────────────────────────
# Builders who ever enrolled in an L3+ course, each tagged with the L3 cohort
# they took (their most recent), which is the Overview's segment dimension.
# Builders with no L3 enrollment fall in "Other L3+".

L3PLUS_POOL_CTE = """
  l3plus AS (
    SELECT DISTINCT ue.user_id
    FROM public.user_enrollment ue
    JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
    JOIN public.course co ON co.course_id = ch.course_id
    WHERE co.level = 'L3+'
  ),
  l3cohort AS (
    SELECT DISTINCT ON (ue.user_id) ue.user_id, ch.name AS segment
    FROM public.user_enrollment ue
    JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
    JOIN public.course co ON co.course_id = ch.course_id
    WHERE co.level = 'L3' AND ue.user_id IN (SELECT user_id FROM l3plus)
    ORDER BY ue.user_id, ue.enrolled_date DESC
  ),
  pool AS (
    SELECT lp.user_id, COALESCE(lc.segment, 'Other L3+') AS segment
    FROM l3plus lp LEFT JOIN l3cohort lc ON lc.user_id = lp.user_id
  )
"""


async def job_ready_pool(conn) -> dict:
    """user_id -> L3 cohort segment, for every builder in the pool."""
    rows = await conn.fetch(f"WITH {L3PLUS_POOL_CTE} SELECT user_id, segment FROM pool")
    return {r["user_id"]: r["segment"] for r in rows}


async def segment_user_ids(conn, segment: Optional[str]) -> Optional[set]:
    """The builders in one L3 cohort segment, or None for no segment."""
    if not segment or segment == "all":
        return None
    pool = await job_ready_pool(conn)
    return {uid for uid, seg in pool.items() if seg == segment}
