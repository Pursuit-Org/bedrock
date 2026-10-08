"""Jobs team list + Jobs targets, read from the DB with a hardcoded fallback.

Settings > Targets > Jobs edits two tables (migration 2026-09-29-jobs-targets):
  bedrock.jobs_team_member  who is "the Jobs team"
  bedrock.jobs_target       weekly outreach targets (per person + team rows),
                            quarterly jobs targets (pipeline), and weekly
                            team targets per funnel stage (stage; migration
                            2026-10-08-jobs-stage-targets widens the CHECKs)

Many Jobs query builders are synchronous and interpolate the team's addresses
into SQL, so this module keeps a process-wide snapshot that those builders read
synchronously. `refresh()` reloads it at most once per TTL; the Jobs routers
call it per request (a router dependency) and writes call it with force=True.
With several app instances, another instance's edit shows up within the TTL.

Until the migration runs, `available()` is False and every reader returns the
hardcoded values (DEFAULT_TEAM, and the dicts in services/outreach_targets.py),
so behaviour is unchanged on deploy.

Addresses are validated on load as well as on write: they end up inside SQL
literals and ILIKE patterns, which is only safe because EMAIL_RE admits no
quote, whitespace or LIKE wildcard.
"""

import logging
import re
import time
from datetime import date
from typing import Optional

logger = logging.getLogger(__name__)

# The team before it became editable. Also the fallback when the table is
# missing or empty (an empty team would silently zero every team metric).
DEFAULT_TEAM = ["avni@pursuit.org", "damon.kornhauser@pursuit.org", "devika@pursuit.org"]

# No quotes or whitespace (the addresses end up inside SQL literals), and no
# % or _ either: they're LIKE wildcards, and the team predicates match with
# ILIKE '%<email>%', so "%@pursuit.org" would quietly widen the team to all
# of Pursuit.
EMAIL_RE = re.compile(r"^[a-z0-9.+-]+@pursuit\.org$")

# Outreach metrics that carry a weekly target, in display order.
OUTREACH_METRICS = [
    ("accounts_activated",      "Accounts activated"),
    ("total_outreach_activity", "Outreach activity"),
    ("total_calls",             "Calls booked"),
    ("call_discovery",          "Discovery calls"),
    ("converted_opportunities", "Opportunities converted"),
]
OUTREACH_METRIC_KEYS = [k for k, _ in OUTREACH_METRICS]

TTL_SECONDS = 60


def valid_email(e: str) -> bool:
    return bool(EMAIL_RE.match(e or ""))


class _Snapshot:
    def __init__(self):
        self.available = False
        self.loaded_at = 0.0
        self.team: list[str] = list(DEFAULT_TEAM)
        # owner -> metric -> weekly value (None = explicitly no target)
        self.owner: dict[str, dict[str, Optional[int]]] = {}
        # metric -> {"mode": "sum"|"set", "value": int|None}
        self.team_cfg: dict[str, dict] = {}
        # quarter start -> jobs target
        self.pipeline: dict[date, int] = {}
        # Stage targets need the 2026-10-08 migration, which widens the
        # section CHECK to admit 'stage'. Until then the Overview's Stage Flow
        # target column reads "pending migration".
        self.stage_available = False
        # stage key -> weekly team target
        self.stage: dict[str, int] = {}


_snap = _Snapshot()


def reset() -> None:
    """Back to the hardcoded fallback. Tests use this."""
    global _snap
    _snap = _Snapshot()


async def _tables_exist(pool) -> bool:
    found = await pool.fetchval(
        "SELECT to_regclass('bedrock.jobs_target') IS NOT NULL "
        "AND to_regclass('bedrock.jobs_team_member') IS NOT NULL")
    return bool(found)


async def refresh(pool, force: bool = False) -> None:
    """Reload the snapshot if it's older than the TTL (or `force`)."""
    global _snap
    if pool is None:
        return
    if not force and time.monotonic() - _snap.loaded_at < TTL_SECONDS:
        return
    try:
        if not await _tables_exist(pool):
            fresh = _Snapshot()
            fresh.loaded_at = time.monotonic()
            _snap = fresh
            return
        members = await pool.fetch(
            "SELECT email FROM bedrock.jobs_team_member WHERE active ORDER BY sort_order, email")
        targets = await pool.fetch(
            "SELECT section, metric, owner_email, period_start, value, team_mode "
            "FROM bedrock.jobs_target")
    except Exception as e:  # never take a Jobs page down over targets
        logger.warning(f"jobs targets refresh failed, keeping previous snapshot: {e}")
        _snap.loaded_at = time.monotonic()
        return
    # Separate from the reads above: a failed probe only means "no stage
    # targets yet", never a lost team or outreach snapshot.
    try:
        section_check = await pool.fetchval(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = 'bedrock.jobs_target'::regclass "
            "AND conname = 'jobs_target_section_check'")
    except Exception as e:
        logger.warning(f"jobs targets: stage-target probe failed, treating as pending: {e}")
        section_check = None

    fresh = _Snapshot()
    fresh.available = True
    fresh.loaded_at = time.monotonic()
    team = [m["email"] for m in members if valid_email(m["email"])]
    fresh.team = team or list(DEFAULT_TEAM)
    fresh.stage_available = isinstance(section_check, str) and "'stage'" in section_check
    for t in targets:
        if t["section"] == "pipeline":
            if t["period_start"] is not None and t["value"] is not None:
                fresh.pipeline[t["period_start"]] = int(t["value"])
        elif t["section"] == "stage":
            if t["value"] is not None:
                fresh.stage[t["metric"]] = int(t["value"])
        elif t["owner_email"]:
            if valid_email(t["owner_email"]):
                fresh.owner.setdefault(t["owner_email"], {})[t["metric"]] = t["value"]
        else:
            fresh.team_cfg[t["metric"]] = {"mode": t["team_mode"] or "sum", "value": t["value"]}
    _snap = fresh


def available() -> bool:
    return _snap.available


def team_emails() -> list[str]:
    """The Jobs team, lowercased and validated. Never empty."""
    return list(_snap.team)


def owner_weekly(email: str, metric: str) -> Optional[int]:
    """A team member's weekly target, or None. Only meaningful when available()."""
    e = (email or "").strip().lower()
    if e not in _snap.team:
        return None
    return _snap.owner.get(e, {}).get(metric)


def owner_has_target(email: str, metric: str) -> bool:
    e = (email or "").strip().lower()
    return e in _snap.team and metric in _snap.owner.get(e, {})


def team_weekly(metric: str) -> Optional[int]:
    """The team's weekly target: set directly, or the sum of the team's people.

    'sum' with nobody carrying the metric is no target (None), not 0: a zero
    renders as a goal of zero, which nobody set.
    """
    cfg = _snap.team_cfg.get(metric)
    if cfg is None:
        return None
    if cfg["mode"] == "set":
        return cfg["value"]
    vals = [_snap.owner.get(e, {}).get(metric) for e in _snap.team]
    vals = [v for v in vals if v is not None]
    return sum(vals) if vals else None


def team_mode(metric: str) -> Optional[str]:
    cfg = _snap.team_cfg.get(metric)
    return cfg["mode"] if cfg else None


def pipeline_targets() -> dict[date, int]:
    """Quarter start → jobs target."""
    return dict(_snap.pipeline)


def stage_targets_available() -> bool:
    """True once the stage-targets migration has run."""
    return _snap.available and _snap.stage_available


def stage_weekly(stage: str) -> Optional[int]:
    """The team's weekly target for entries into `stage`, or None."""
    return _snap.stage.get(stage)


def snapshot_for_api() -> dict:
    """Everything the Settings page needs to render, as plain JSON."""
    return {
        "available": _snap.available,
        "team": team_emails(),
        "owners": {e: {m: _snap.owner.get(e, {}).get(m) for m in OUTREACH_METRIC_KEYS
                       if m in _snap.owner.get(e, {})} for e in _snap.team},
        "team_targets": {m: {"mode": team_mode(m), "value": (_snap.team_cfg.get(m) or {}).get("value"),
                             "effective": team_weekly(m)} for m in OUTREACH_METRIC_KEYS},
        "pipeline": [{"period_start": d.isoformat(), "value": v}
                     for d, v in sorted(_snap.pipeline.items())],
    }
