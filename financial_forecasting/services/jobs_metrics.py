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
  * interviews: an application's first move into interview, from its stage
    history (PRO-117);
  * the job-ready pool: builders ever enrolled in an L3+ course;
  * one stage map, old stage names folded into current ones on read;
  * who an outcome belongs to (the owner rules; D6 is still open, PRO-101).
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
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
    "moved_to_outreach":      Measure("employer_outreach", "moved_to_outreach"),
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
    "interviews":             Measure("employer_pipeline", "interviews", "interviews"),
    # Conversion
    "converted_opportunities": Measure("employer_conversion", "contacts_converted"),
    "milestone_to_interview": Measure("employer_conversion", "milestone_to_interview", "rate_pct"),
    "campaign_conversion":    Measure("employer_conversion", "campaign_conversion"),
    "interview_to_hire":      Measure("employer_conversion", "interview_to_hire", "rate_pct"),
    # Targets
    "activity_target":        Measure("jobs_targets", "activity_vs_target"),
    "jobs_projection":        Measure("jobs_targets", "jobs_vs_target"),
}

# Measures that exist in the dictionary and follow the rules below, but no
# card shows yet. The checks still run them.
UNSHOWN_MEASURES: dict[str, Measure] = {
    "stalled_contacts":       Measure("employer_pipeline", "stalled_contacts"),
    "stalled_accounts":       Measure("employer_pipeline", "stalled_accounts"),
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
    inner = depth_sql(p_since="(SELECT since FROM w)", p_senders="(SELECT senders FROM w)",
                      exclude=internal_contact_sql("c"))
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


# ── Whose activity it is (D5, D15; PRO-101) ──────────────────────────────────
# Activity is logged once, where it happened: on an opportunity, or with a
# contact (a synced email, a meeting they attended, a call logged on them). It
# counts on the contact, on that contact's opportunities and on the account.
#
#   * An opportunity's contacts are the ones linked to it: the contact's
#     converted opportunity (jobs_contact_membership.opportunity_id) or the
#     opportunity's contact list (sf_contact_ids). An opportunity with none
#     borrows everyone at its account (same name), the fallback the contacts
#     list already uses for a contact's opportunity (Nina, 10/13).
#   * An opportunity's activity: logged on it, with one of its contacts, or on
#     its Salesforce account.
#   * An account's activity: its opportunities' and its contacts'.
#
# Accounts are names (jobs_account.account_key = lower(trim(name))) until the
# merges in PRO-101 part 5 give them ids.

def account_key_sql(col: str) -> str:
    return f"lower(btrim({col}))"


def opportunity_links_sql(scope: Optional[str] = None) -> str:
    """SQL: (opp_id, contact_id) for every contact linked to an opportunity,
    from the contact (its converted opportunity) or from the opportunity's
    contact list: pub:<contact_id>, airtable:<id>, or a Salesforce contact id
    (D15). `scope`, when given, names a relation whose `id` column limits the
    opportunities. No account fallback: a link is a link."""
    if scope:
        opps = f"{scope} os JOIN bedrock.jobs_opportunity o ON o.id = os.id"
    else:
        opps = "bedrock.jobs_opportunity o"
    m_join = (f"JOIN {scope} os ON os.id = m.opportunity_id" if scope
              else "WHERE m.opportunity_id IS NOT NULL")
    return f"""
  SELECT m.opportunity_id AS opp_id, m.contact_id
  FROM bedrock.jobs_contact_membership m {m_join}
  UNION
  SELECT o.id, c.contact_id
  FROM {opps}
  CROSS JOIN LATERAL unnest(o.sf_contact_ids) r(ref)
  JOIN public.contacts c
    ON c.contact_id = CASE WHEN r.ref ~ '^pub:[0-9]{{1,9}}$' THEN substring(r.ref from 5)::int END
  UNION
  SELECT o.id, c.contact_id
  FROM {opps}
  CROSS JOIN LATERAL unnest(o.sf_contact_ids) r(ref)
  JOIN public.contacts c ON c.airtable_id = substring(r.ref from 10)
  WHERE r.ref LIKE 'airtable:%'
  UNION
  SELECT o.id, scl.public_contact_id
  FROM {opps}
  CROSS JOIN LATERAL unnest(o.sf_contact_ids) r(ref)
  JOIN bedrock.sf_contact_link scl ON scl.sf_contact_id = r.ref
  WHERE r.ref NOT LIKE 'pub:%' AND r.ref NOT LIKE 'airtable:%' AND scl.public_contact_id IS NOT NULL
"""


def activity_scope_ctes(*, opps: str = "TRUE", accounts: Optional[str] = None,
                        activity: Optional[str] = None) -> str:
    """CTEs (no leading WITH) naming whose activity each row is.

    `opps` is a predicate on `o` (bedrock.jobs_opportunity) choosing the
    opportunities in scope. `accounts`, when given, chooses accounts by their
    key, written with a `{k}` placeholder ("{k} = $1", "TRUE"), and adds their
    opportunities to the scope.
    `activity` is a predicate on `a` (bedrock.activity); the default is
    external_activity_sql (no notes, jobs-related only). Put any date bound in it.

      opp_scope(id, k, account_id)
      opp_contacts(opp_id, contact_id, linked)
      contact_touches(contact_id, activity_id, at)
      opp_touches(opp_id, activity_id, at)
      account_touches(k, activity_id, at)      -- only when `accounts` is given
    """
    act = activity or external_activity_sql("a")
    o_key = account_key_sql("o.account_name")
    c_key = account_key_sql("c.current_company")
    on_key = lambda expr: accounts.replace("{k}", expr)
    acct_opps = f" OR ({on_key(o_key)})" if accounts else ""
    ctes = [f"""opp_scope AS (
  SELECT o.id, {o_key} AS k, o.account_id FROM bedrock.jobs_opportunity o
  WHERE o.deleted_at IS NULL AND (({opps}){acct_opps})
)""", f"""opp_links AS (
  SELECT l.opp_id, l.contact_id FROM ({opportunity_links_sql("opp_scope")}) l
)""", f"""opp_contacts AS (
  SELECT opp_id, contact_id, true AS linked FROM opp_links
  UNION ALL
  -- No linked contacts: everyone at the opportunity's account.
  SELECT os.id, c.contact_id, false
  FROM opp_scope os JOIN public.contacts c ON {c_key} = os.k
  WHERE os.k <> '' AND NOT EXISTS (SELECT 1 FROM opp_links l WHERE l.opp_id = os.id)
)"""]
    if accounts:
        ctes.append(f"""account_contacts AS (
  SELECT {c_key} AS k, c.contact_id FROM public.contacts c
  WHERE btrim(coalesce(c.current_company, '')) <> '' AND {on_key(c_key)}
)""")
    scope_contacts = ("SELECT contact_id FROM opp_contacts"
                      + (" UNION SELECT contact_id FROM account_contacts" if accounts else ""))
    ctes.append(f"""scope_contacts AS ({scope_contacts})""")
    ctes.append(f"""contact_touches AS (
  SELECT a.participant_public_contact_id AS contact_id, a.id AS activity_id, a.activity_date AS at
  FROM bedrock.activity a
  WHERE a.participant_public_contact_id IN (SELECT contact_id FROM scope_contacts)
    AND {act}
  UNION
  -- Calendar rows carry attendees, not a participant link.
  SELECT c.contact_id, a.id, a.activity_date
  FROM bedrock.activity a,
       jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att
  JOIN public.contacts c ON lower(c.email) = lower(att->>'email')
  WHERE a.source = 'calendar-sync' AND {act}
    AND c.contact_id IN (SELECT contact_id FROM scope_contacts)
)""")
    ctes.append(f"""opp_touches AS (
  SELECT os.id AS opp_id, a.id AS activity_id, a.activity_date AS at
  FROM opp_scope os JOIN bedrock.activity a ON a.jobs_opportunity_id = os.id
  WHERE {act}
  UNION
  SELECT os.id, a.id, a.activity_date
  FROM opp_scope os JOIN bedrock.activity a ON a.account_id = os.account_id
  WHERE os.account_id LIKE '001%' AND {act}
  UNION
  SELECT oc.opp_id, t.activity_id, t.at
  FROM opp_contacts oc JOIN contact_touches t ON t.contact_id = oc.contact_id
)""")
    if accounts:
        ctes.append(f"""account_touches AS (
  SELECT ac.k, t.activity_id, t.at
  FROM account_contacts ac JOIN contact_touches t ON t.contact_id = ac.contact_id
  UNION
  SELECT os.k, t.activity_id, t.at
  FROM opp_scope os JOIN opp_touches t ON t.opp_id = os.id
  WHERE os.k <> '' AND {on_key('os.k')}
)""")
    return ",\n".join(ctes)


def dictionary_open_opportunities_sql(open_opp_stages: Iterable[str]) -> str:
    """WITH w, the activity scope and open_set: the opportunities open at the
    end of the dictionary window, each with its last movement (created, a stage
    change, or activity by activity_scope_ctes). Opportunities open, Time in
    stage and Stalled opportunities all start here."""
    opp_in = ", ".join(f"'{s}'" for s in open_opp_stages)
    end = "(SELECT end_at FROM w)"
    scope = activity_scope_ctes(
        opps=f"o.created_at < {end} AND (o.closed_at IS NULL OR o.closed_at >= {end})",
        activity=f"{external_activity_sql('a')} AND a.activity_date < {end}")
    return f"""WITH w AS (SELECT {DD_START} AS start_at, {DD_END} AS end_at),
{scope},
opp_last AS (
  SELECT opp_id, max(at) AS at FROM opp_touches GROUP BY opp_id
),
open_set AS (
  -- Opportunities open at the end of the window.
  SELECT o.*,
         greatest(o.created_at,
                  (SELECT max(h.changed_at) FROM bedrock.jobs_stage_history h
                    WHERE h.opportunity_id = o.id AND h.changed_at < {end}),
                  ol.at) AS last_movement
  FROM bedrock.jobs_opportunity o
  LEFT JOIN opp_last ol ON ol.opp_id = o.id
  WHERE o.deleted_at IS NULL
    AND o.created_at < {end}
    AND (o.closed_at IS NULL OR o.closed_at >= {end})
    AND (o.stage IN ({opp_in}) OR (o.closed_at IS NOT NULL AND o.closed_at >= {end}))
)"""


def dictionary_stalled_sql(entity: str, open_opp_stages: Iterable[str],
                           open_member_stages: Iterable[str]) -> str:
    """The reference query for Stalled contacts, opportunities or accounts (D3),
    reading activity by activity_scope_ctes. The open stage lists come from
    routes/jobs.py (OPPORTUNITY_STAGES_ACTIVE_ANY, the open membership stages)."""
    opp_in = ", ".join(f"'{s}'" for s in open_opp_stages)
    mem_in = ", ".join(f"'{s}'" for s in open_member_stages)
    ext = external_activity_sql("a")
    if entity == "contacts":
        return f"""WITH last AS (
  SELECT m.contact_id,
         greatest(m.assigned_at,
                  (SELECT max(h.changed_at) FROM bedrock.jobs_membership_stage_history h
                    WHERE h.contact_id = m.contact_id),
                  (SELECT max(a.activity_date) FROM bedrock.activity a
                    WHERE a.participant_public_contact_id = m.contact_id AND {ext})) AS last_at
  FROM bedrock.jobs_contact_membership m
  WHERE m.stage IN ({mem_in})
)
SELECT count(*) FILTER (WHERE last_at IS NULL OR last_at < now() - interval '2 weeks') AS stalled_contacts,
       count(*) AS open_contacts
FROM last"""
    if entity == "opportunities":
        end = "(SELECT end_at FROM w)"
        return dictionary_open_opportunities_sql(open_opp_stages) + f"""
SELECT count(*) FILTER (WHERE last_movement < least({end}, now()) - interval '4 weeks') AS stalled_opportunities,
       count(*) AS opportunities_open
FROM open_set"""
    if entity == "accounts":
        scope = activity_scope_ctes(opps="FALSE", accounts="TRUE")
        return f"""WITH open_accounts AS (
  SELECT DISTINCT lower(btrim(c.current_company)) AS k
  FROM bedrock.jobs_contact_membership m JOIN public.contacts c ON c.contact_id = m.contact_id
  WHERE m.stage IN ({mem_in})
    AND btrim(coalesce(c.current_company, '')) <> ''
  UNION
  SELECT DISTINCT lower(btrim(o.account_name)) FROM bedrock.jobs_opportunity o
  WHERE o.deleted_at IS NULL AND o.stage IN ({opp_in}) AND btrim(coalesce(o.account_name, '')) <> ''
),
{scope},
touched AS (
  SELECT k, max(at) AS at FROM account_touches GROUP BY k
),
moved AS (
  SELECT lower(btrim(o.account_name)) AS k, max(h.changed_at) AS at
  FROM bedrock.jobs_stage_history h JOIN bedrock.jobs_opportunity o ON o.id = h.opportunity_id
  WHERE o.deleted_at IS NULL GROUP BY 1
)
SELECT count(*) FILTER (WHERE greatest(t.at, mv.at) IS NULL
                          OR greatest(t.at, mv.at) < now() - interval '6 weeks') AS stalled_accounts,
       count(*) AS open_accounts
FROM open_accounts oa LEFT JOIN touched t USING (k) LEFT JOIN moved mv USING (k)"""
    raise ValueError(entity)


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


# ── Interviews (PRO-117) ─────────────────────────────────────────────────────
# An interview is a builder application's first move into the interview stage,
# dated by its entry in public.job_applications.stage_history. That array is the
# platform's record, one entry per stage change: {date, stage, notes,
# changed_by}, `date` a New York day. Counting the history rather than the
# current stage keeps an interview counted once the application moves on to
# accepted or rejected. A second entry into interview is the same interview.
#
# Only the Jobs team's applications count (Nina 10/7): the ones Pursuit
# referred or staff sourced. Interview → hire (D11) counts only applications
# that reached interview: of the interviews in a period, those whose
# application is accepted now. An application logged straight at accepted had
# no recorded interview and isn't in it.
#
# Bedrock has recorded every stage change it makes since 2026-09-29 (the first
# entry it wrote; creating an application at a stage too, since PRO-117). An
# application at interview with no dated entry got there earlier or through
# another writer. It is reported as interviewing with no recorded date, never
# placed in a week it can't be placed in.

STAFF_SOURCED = ("Pursuit_referred", "staff_sourced")
INTERVIEW_HISTORY_FROM = date(2026, 9, 29)


def stage_entry_sql(stage: str, changed_by: str) -> str:
    """SQL: one stage_history entry in the platform's shape, dated today in
    New York (the database runs in UTC, so its own date is tomorrow after 8pm).
    `stage` and `changed_by` are SQL expressions, normally parameters."""
    return ("jsonb_build_object('date', to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'), "
            f"'stage', {stage}, 'notes', NULL, 'changed_by', {changed_by})")


# The Jobs team's applications, with what the count and its records need. The
# opportunity's owner and deal type are the Pipeline tab's filters.
INTERVIEW_APPLICATIONS_SQL = """
    SELECT ja.job_application_id, ja.builder_id, ja.stage, ja.stage_history::text AS stage_history,
           coalesce(nullif(trim(bb.full_name), ''), nullif(trim(split_part(ja.notes, ':', 1)), '')) AS builder,
           ja.company_name, ja.role_title, ja.jobs_opportunity_id,
           o.owner_email, o.deal_type
    FROM public.job_applications ja
    LEFT JOIN bedrock.jobs_opportunity o ON o.id = ja.jobs_opportunity_id AND o.deleted_at IS NULL
    LEFT JOIN LATERAL bedrock.builder_by_id(ja.builder_id) bb ON true
    WHERE ja.source_type IN ('Pursuit_referred', 'staff_sourced')
"""


def _history(raw) -> list:
    if raw is None:
        return []
    if isinstance(raw, (str, bytes)):
        raw = json.loads(raw)
    return raw if isinstance(raw, list) else []


def entered_interview(history) -> Optional[date]:
    """The day an application first moved into interview, from its stage
    history, or None if the history has no dated interview entry."""
    days = []
    for e in _history(history):
        if not isinstance(e, Mapping) or e.get("stage") != "interview":
            continue
        try:
            days.append(date.fromisoformat(str(e.get("date"))[:10]))
        except ValueError:
            continue
    return min(days) if days else None


@dataclass(frozen=True)
class Interviews:
    dated: list          # (day entered interview, application row), earliest first
    undated: list        # application rows at interview now with no dated entry

    def in_window(self, d_from: date, d_to: date) -> list:
        """Applications that entered interview on New York days d_from..d_to,
        both inclusive."""
        return [r for d, r in self.dated if d_from <= d <= d_to]

    @staticmethod
    def hired(rows: Iterable[Mapping]) -> list:
        """Of these interviews, the ones whose application is accepted now."""
        return [r for r in rows if r["stage"] == "accepted"]


def interviews(rows: Iterable[Mapping], *, owner: Optional[str] = None,
               deal_types: Optional[list] = None) -> Interviews:
    """The interviews among these application rows (INTERVIEW_APPLICATIONS_SQL).

    `owner` and `deal_types` narrow to applications on an opportunity with that
    owner / deal type ("unset" for none), so an application on no opportunity
    counts only when neither is set."""
    dated, undated = [], []
    for r in rows:
        if owner and (r.get("owner_email") or "").lower() != owner.lower():
            continue
        if deal_types is not None:
            if r.get("jobs_opportunity_id") is None:
                continue
            dt = r.get("deal_type")
            if not (dt in deal_types or (dt is None and "unset" in deal_types)):
                continue
        d = entered_interview(r.get("stage_history"))
        if d is not None:
            dated.append((d, r))
        elif r["stage"] == "interview":
            undated.append(r)
    dated.sort(key=lambda x: (x[0], x[1]["job_application_id"]))
    return Interviews(dated=dated, undated=undated)


def interviews_reference_sql() -> str:
    """The reference query for Interviews and Interview → hire: the Jobs team's
    applications whose first interview entry falls in the dictionary window,
    and how many of them are accepted now. The SQL twin of interviews()."""
    return (
        f"WITH w AS (SELECT {DD_FROM} AS d_from, {DD_TO} AS d_to),\n"
        "iv AS (\n"
        "  SELECT ja.job_application_id, ja.stage,\n"
        "         (SELECT min(left(e->>'date', 10)::date)\n"
        "            FROM jsonb_array_elements(coalesce(ja.stage_history, '[]'::jsonb)) e\n"
        "           WHERE e->>'stage' = 'interview' AND e->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}') AS entered\n"
        "  FROM public.job_applications ja\n"
        "  WHERE ja.source_type IN ('Pursuit_referred', 'staff_sourced')\n"
        ")\n"
        "SELECT count(*) AS interviews,\n"
        "       count(*) FILTER (WHERE stage = 'accepted') AS hired,\n"
        "       round(100.0 * count(*) FILTER (WHERE stage = 'accepted') / nullif(count(*), 0)) AS rate_pct\n"
        "FROM iv\n"
        "WHERE entered >= (SELECT d_from FROM w) AND entered < (SELECT d_to FROM w)"
    )


# ── Conversion between milestones (D11; PRO-100) ─────────────────────────────
# Conversion runs between core milestones, anchored on interviews: first stage
# → interview → hire. A rate counts only records that STARTED at the earlier
# milestone, by the dates stages changed, so its numerator is always part of
# its denominator and it can never pass 100%. A contact added straight at
# Call Booked never started at Assigned, so it is in neither number.
#
#   * First stage → interview: of the contacts whose first recorded stage is
#     Assigned (opportunities: In Discussions) and who started in the period,
#     the share whose opportunity has a Jobs-team application that entered
#     interview on or after that start. A contact's opportunities are the ones
#     linked to it (opportunity_links_sql); there is no account fallback.
#   * Interview → hire: interviews() above (PRO-117).
#
# Stage-to-stage rates (entries ÷ entries, standing count ÷ standing count)
# are retired: they read 400% when a backlog cleared and 4% = 2 ÷ 55 when they
# didn't (OVR-09).

FIRST_CONTACT_STAGE = "assigned"
FIRST_OPPORTUNITY_STAGE = "active_in_discussions"

# Every membership with the stage it started at, when, and its linked
# opportunities. The first stage is where the earliest history row starts:
# its from-stage, or its to-stage for a row written on entry (Assigned first
# among rows written in the same instant, as the July backfill did); with no
# history, a contact still at Assigned started there when it was assigned.
# It started at the earlier of that row and the membership's creation.
CONTACT_STARTS_SQL = f"""
    WITH first AS (
      SELECT DISTINCT ON (h.contact_id) h.contact_id,
             coalesce(h.from_stage, h.to_stage) AS stage, h.changed_at
      FROM bedrock.jobs_membership_stage_history h
      WHERE h.to_stage <> 'unflagged'
      ORDER BY h.contact_id, h.changed_at, (h.to_stage <> 'assigned'), h.id
    ),
    links AS ({opportunity_links_sql()}),
    linked AS (SELECT contact_id, array_agg(opp_id) AS opp_ids FROM links GROUP BY 1)
    SELECT m.contact_id, c.full_name AS name, c.current_company AS company,
           lower(coalesce(m.owner_email, '')) AS owner_email,
           CASE WHEN f.contact_id IS NOT NULL THEN f.stage
                WHEN m.stage = 'assigned' THEN 'assigned' END AS first_stage,
           least(f.changed_at, m.assigned_at) AS started_at,
           coalesce(l.opp_ids, '{{}}') AS opp_ids
    FROM bedrock.jobs_contact_membership m
    JOIN public.contacts c ON c.contact_id = m.contact_id
    LEFT JOIN first f ON f.contact_id = m.contact_id
    LEFT JOIN linked l ON l.contact_id = m.contact_id
"""

# Every live opportunity with the stage it was created at: the first history
# row's from-stage (or its to-stage, for a row written at creation), else its
# stage now. Created is when it started.
OPPORTUNITY_STARTS_SQL = """
    SELECT o.id, o.account_name AS name, o.owner_email, o.deal_type,
           coalesce((SELECT coalesce(h.from_stage, h.to_stage)
                       FROM bedrock.jobs_stage_history h
                      WHERE h.opportunity_id = o.id
                      ORDER BY h.changed_at, h.id LIMIT 1), o.stage) AS first_stage,
           o.created_at AS started_at
    FROM bedrock.jobs_opportunity o
    WHERE o.deleted_at IS NULL
"""


def interview_by_opportunity(application_rows: Iterable[Mapping]) -> dict:
    """opportunity id -> the days its Jobs-team applications entered
    interview, one per application, earliest first. Every one is kept, not
    just the first: a contact linked to a deal after its first interview
    still reaches a later one. `application_rows` are
    INTERVIEW_APPLICATIONS_SQL rows."""
    out: dict = {}
    for r in application_rows:
        opp = r.get("jobs_opportunity_id")
        d = entered_interview(r.get("stage_history"))
        if opp is None or d is None:
            continue
        out.setdefault(str(opp), []).append(d)
    return {k: sorted(v) for k, v in out.items()}


@dataclass(frozen=True)
class Milestone:
    """One conversion between milestones: who started at the earlier one, and
    which of them reached the later one."""
    key: str
    started: list
    reached: list

    @property
    def rate(self) -> Optional[int]:
        return round(100 * len(self.reached) / len(self.started)) if self.started else None


def _ny_day(ts: datetime) -> date:
    return ts.astimezone(NY).date() if ts.tzinfo else ts.date()


def first_stage_to_interview(starts: Iterable[Mapping], interviewed: Mapping, *,
                             first_stage: str, start: Optional[datetime] = None,
                             end: Optional[datetime] = None) -> Milestone:
    """Of `starts` (CONTACT_STARTS_SQL or OPPORTUNITY_STARTS_SQL rows) that
    started at `first_stage` in [start, end) (either bound may be None), the
    ones whose opportunity entered interview on or after the day they
    started. `interviewed` is interview_by_opportunity(). A row's
    opportunities are its `opp_ids`, or itself when it is an opportunity."""
    started, reached = [], []
    for r in starts:
        at = r.get("started_at")
        fs = (canon_membership_stage(r.get("first_stage")) if "opp_ids" in r
              else canon_stage(r.get("first_stage")))
        if at is None or fs != first_stage:
            continue
        if (start is not None and at < start) or (end is not None and at >= end):
            continue
        started.append(r)
        opps = r["opp_ids"] if "opp_ids" in r else [r["id"]]
        days = [d for o in (opps or []) for d in interviewed.get(str(o), [])]
        on_or_after = [d for d in days if d >= _ny_day(at)]
        if on_or_after:
            reached.append({**r, "interview_on": min(on_or_after)})
    return Milestone("first_stage_to_interview", started, reached)


def interview_to_hire(iv: "Interviews", d_from: Optional[date] = None,
                      d_to: Optional[date] = None) -> Milestone:
    """Of the interviews in d_from..d_to (New York days, inclusive; all of them
    when unbounded), the ones whose application is accepted now (PRO-117)."""
    rows = ([r for _, r in iv.dated] if d_from is None or d_to is None
            else iv.in_window(d_from, d_to))
    return Milestone("interview_to_hire", rows, Interviews.hired(rows))


def milestone_reference_sql() -> str:
    """The reference query for First stage → interview, contacts: of contacts
    that started at Assigned in the dictionary window, the share whose linked
    opportunity has a Jobs-team application that entered interview on or after
    that day. The SQL twin of first_stage_to_interview over CONTACT_STARTS_SQL."""
    return (
        f"WITH w AS (SELECT {DD_START} AS start_at, {DD_END} AS end_at),\n"
        f"starts AS ({CONTACT_STARTS_SQL}),\n"
        "iv AS (                   -- one row per application: every interview counts\n"
        "  SELECT ja.jobs_opportunity_id AS opp_id,\n"
        "         (SELECT min(left(e->>'date', 10)::date)\n"
        "                FROM jsonb_array_elements(coalesce(ja.stage_history, '[]'::jsonb)) e\n"
        "               WHERE e->>'stage' = 'interview' AND e->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}') AS entered\n"
        "  FROM public.job_applications ja\n"
        "  WHERE ja.source_type IN ('Pursuit_referred', 'staff_sourced') AND ja.jobs_opportunity_id IS NOT NULL\n"
        "),\n"
        "cohort AS (\n"
        "  SELECT s.contact_id,\n"
        "         EXISTS (SELECT 1 FROM iv WHERE iv.opp_id = ANY(s.opp_ids)\n"
        "                    AND iv.entered >= (s.started_at AT TIME ZONE 'America/New_York')::date) AS reached\n"
        "  FROM starts s\n"
        f"  WHERE s.first_stage = '{FIRST_CONTACT_STAGE}'\n"
        "    AND s.started_at >= (SELECT start_at FROM w) AND s.started_at < (SELECT end_at FROM w)\n"
        ")\n"
        "SELECT count(*) AS started, count(*) FILTER (WHERE reached) AS interviewed,\n"
        "       round(100.0 * count(*) FILTER (WHERE reached) / nullif(count(*), 0)) AS rate_pct\n"
        "FROM cohort"
    )


# ── Campaigns (D10, D14; PRO-100) ────────────────────────────────────────────
# A campaign is a curated contact tag (bedrock.contact_tag_catalog), except
# where one push spans several slugs: the alumni cohorts are one "Fellow
# Alumni" and the five operation_35_* segments one "Operation 35". A slug
# belongs to a group when it IS the prefix or starts with prefix + "_", so a
# future `board_advisors` can never fold into `board`.
#
# Only the current campaign shows by default (D10); the others are archived
# and can still be picked, with their results. `is_current` on the catalog
# marks it, every slug of the group alike. A retired tag is `active = false`
# and is not a campaign at all (D14: Tristate SMB Leaders).
#
# Who counts (Nina, 10/13):
#   * in pipeline: the contact has a pipeline membership. The jobs-prospect
#     flag (contacts.is_jobs_contact) is a different, larger set (Op 35: 449
#     flagged, 117 members), and every campaign number used to divide by it;
#   * Pursuit's own staff are never in a campaign (internal_contact_sql);
#   * contacted: reached by activity (outreach_counting.activity_by_contact);
#     an account is reached when one of its contacts is;
#   * conversion: of the contacted contacts, the share converted to an
#     opportunity.

CAMPAIGN_GROUPS: tuple = (
    ("alumni", "Fellow Alumni"),
    ("operation_35", "Operation 35"),
)
CAMPAIGN_GROUP_LABELS = dict(CAMPAIGN_GROUPS)


def campaign_key(slug: str) -> str:
    for prefix, _ in CAMPAIGN_GROUPS:
        if slug == prefix or slug.startswith(prefix + "_"):
            return prefix
    return slug


def campaign_group_sql(col: str) -> str:
    """campaign_key as an SQL expression. Underscores inside a prefix are
    escaped because `_` is LIKE's single-character wildcard."""
    whens = " ".join(
        f"WHEN {col} = '{p}' OR {col} LIKE '{p.replace('_', chr(92) + '_')}{chr(92)}_%' THEN '{p}'"
        for p, _ in CAMPAIGN_GROUPS
    )
    return f"(CASE {whens} ELSE {col} END)"


def internal_contact_sql(c: str = "c") -> str:
    """SQL: the contact is Pursuit's own staff, so in no campaign. Their
    address is a current staffer's (an active org_users login, or an enabled
    sync_staff mailbox or one of its aliases), or they work at Pursuit and
    aren't an alumnus (fellows often list Pursuit as their employer). A former
    staffer's old address doesn't count: Erick Chang, erick@c4q.nyc, is a
    hiring partner at Uber now. Contact records often have no address at all,
    which is why the company is read too (David Yang, 10/13)."""
    return f"""(
      (lower(btrim(coalesce({c}.current_company, ''))) = 'pursuit'
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce({c}.tags, '{{}}'::text[])) it WHERE it LIKE 'alumni%'))
      -- coalesce: no address is "not staff", never NULL, which NOT would
      -- turn into dropping the contact from every campaign.
      OR coalesce(lower(btrim({c}.email)) IN (
           SELECT lower(o.email) FROM public.org_users o WHERE o.is_active AND o.email IS NOT NULL
           UNION SELECT lower(s.email) FROM bedrock.sync_staff s WHERE s.enabled AND s.email IS NOT NULL
           UNION SELECT lower(x) FROM bedrock.sync_staff s, unnest(s.aliases) x
                  WHERE s.enabled AND x IS NOT NULL), false))"""


# Every campaign contact, one row per (campaign, contact): `$1` the active
# slugs. `in_pipeline` is the membership; staff are left out here, once.
CAMPAIGN_CONTACTS_SQL = f"""
    SELECT DISTINCT ON (g.campaign, c.contact_id)
           g.campaign, c.contact_id, c.full_name, c.current_company AS company,
           nullif(lower(btrim(coalesce(c.current_company, ''))), '') AS account_key,
           m.contact_id IS NOT NULL AS in_pipeline,
           {canon_membership_sql('m.stage')} AS stage, m.owner_email,
           coalesce(m.converted_at, m.first_outreach_at, m.assigned_at) AS stage_entered_at
    FROM public.contacts c
    CROSS JOIN LATERAL (SELECT {campaign_group_sql('t')} AS campaign
                          FROM unnest(c.tags) t WHERE t = ANY($1::text[])) g
    LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = c.contact_id
    WHERE NOT {internal_contact_sql('c')}
    ORDER BY g.campaign, c.contact_id
"""


@dataclass
class CampaignNumbers:
    """One campaign's numbers. `contacts` is everyone tagged; every other
    number is over the in-pipeline contacts."""
    contacts: int = 0
    in_pipeline: int = 0
    accounts: int = 0
    contacted: int = 0
    accounts_reached: int = 0
    converted: int = 0
    converted_contacted: int = 0
    stages: dict = field(default_factory=dict)
    stages_contacted: dict = field(default_factory=dict)

    @property
    def conversion(self) -> Optional[int]:
        """Of the contacted contacts, the share converted to an opportunity."""
        return round(100 * self.converted_contacted / self.contacted) if self.contacted else None


def campaign_numbers(rows: Iterable[Mapping], contacted: Iterable[int]) -> CampaignNumbers:
    """The numbers for one campaign's CAMPAIGN_CONTACTS_SQL rows, given the
    contacts that have been contacted (activity_by_contact's keys)."""
    reached = set(contacted)
    n = CampaignNumbers(stages={s: 0 for s in MEMBERSHIP_STAGES},
                        stages_contacted={s: 0 for s in MEMBERSHIP_STAGES})
    accounts, accounts_reached = set(), set()
    for r in rows:
        n.contacts += 1
        if not r["in_pipeline"]:
            continue
        n.in_pipeline += 1
        stage, hit = r["stage"], r["contact_id"] in reached
        if stage in n.stages:
            n.stages[stage] += 1
        if r["account_key"]:
            accounts.add(r["account_key"])
        if hit:
            n.contacted += 1
            if stage in n.stages_contacted:
                n.stages_contacted[stage] += 1
            if r["account_key"]:
                accounts_reached.add(r["account_key"])
        if stage == "converted_to_opportunity":
            n.converted += 1
            n.converted_contacted += int(hit)
    n.accounts, n.accounts_reached = len(accounts), len(accounts_reached)
    return n


def campaign_reference_sql() -> str:
    """The reference query for the campaign measures: per campaign, everyone
    tagged, the pipeline, its accounts, who has been contacted (by anyone at
    Pursuit, ever, by outreach_counting's rules) and conversion. The SQL twin
    of campaign_numbers over CAMPAIGN_CONTACTS_SQL. Archived campaigns are
    listed too, with `current` saying which is shown by default."""
    from services.outreach_counting import counted_once_ctes
    slugs = "(SELECT array_agg(slug) FROM bedrock.contact_tag_catalog WHERE active)"
    contacts = CAMPAIGN_CONTACTS_SQL.replace("$1::text[]", f"{slugs}::text[]")
    return (
        f"WITH w AS (SELECT {DD_PURSUIT} AS senders),\n"
        f"{counted_once_ctes(p_start='NULL', p_end='NULL', p_senders='(SELECT senders FROM w)')},\n"
        "reached AS (\n"
        "  SELECT DISTINCT x.cid FROM once o, unnest(o.contact_ids || o.contact_id) x(cid)\n"
        "  WHERE o.kind <> 'call_booked' AND x.cid IS NOT NULL\n"
        "),\n"
        f"camp AS ({contacts}),\n"
        "cur AS (\n"
        f"  SELECT {campaign_group_sql('slug')} AS campaign, bool_or(is_current) AS current\n"
        "  FROM bedrock.contact_tag_catalog WHERE active GROUP BY 1\n"
        ")\n"
        "SELECT p.campaign, cur.current,\n"
        "       count(*) AS contacts,\n"
        "       count(*) FILTER (WHERE p.in_pipeline) AS in_pipeline,\n"
        "       count(DISTINCT p.account_key) FILTER (WHERE p.in_pipeline) AS accounts,\n"
        "       count(*) FILTER (WHERE p.in_pipeline AND r.cid IS NOT NULL) AS contacted,\n"
        "       count(DISTINCT p.account_key) FILTER (WHERE p.in_pipeline AND r.cid IS NOT NULL) AS accounts_reached,\n"
        "       round(100.0 * count(*) FILTER (WHERE p.in_pipeline AND r.cid IS NOT NULL\n"
        "                                        AND p.stage = 'converted_to_opportunity')\n"
        "             / nullif(count(*) FILTER (WHERE p.in_pipeline AND r.cid IS NOT NULL), 0)) AS conversion_pct\n"
        "FROM camp p LEFT JOIN reached r ON r.cid = p.contact_id LEFT JOIN cur USING (campaign)\n"
        "GROUP BY p.campaign, cur.current\n"
        "ORDER BY cur.current DESC NULLS LAST, p.campaign"
    )


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
