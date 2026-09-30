"""Jobs targets API — Settings > Targets > Jobs.

Three things are edited here, each saved as a whole section:
  * the Jobs team: who counts as "the Jobs team" in every team-scoped Jobs
    metric, the Owner cut, and the target grid;
  * outreach targets: weekly, per team member, plus a team row per metric that
    is either the SUM of the members or a number SET directly;
  * pipeline targets: jobs per quarter, drawn on the Jobs projection chart.

View: any signed-in user. Edit: manage_jobs_targets (Admin, Executive).
Storage and fallback live in services/jobs_targets_store.py. Until the
2026-09-29 migration runs, GET reports available=false with the hardcoded
values and every PUT returns 409.
"""

import logging
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import require_auth
from db import get_db, get_pool
from routes.permissions import check_permission
from services import jobs_targets_store as store
from services.outreach_targets import OWNER_ACTIVITY_TARGETS, ACTIVITY_PIPELINE_TARGETS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs/targets", tags=["jobs-targets"])

_PENDING = "Jobs targets are pending the 2026-09-29 migration; nothing can be saved yet."


def _editor(user) -> str:
    return (user.get("email") if isinstance(user, dict) else getattr(user, "email", "")) or ""


def _fallback_view() -> dict:
    """What the hardcoded values look like in the editable shape, so the page
    can show today's numbers before the migration runs."""
    team = list(store.DEFAULT_TEAM)
    owners = {e: {m: OWNER_ACTIVITY_TARGETS.get(e, {}).get(m, {}).get("week")
                  for m in store.OUTREACH_METRIC_KEYS if m in OWNER_ACTIVITY_TARGETS.get(e, {})}
              for e in team}
    summed = {"total_outreach_activity", "total_calls", "call_discovery"}
    team_targets = {}
    for m in store.OUTREACH_METRIC_KEYS:
        wk = ACTIVITY_PIPELINE_TARGETS.get(m, {}).get("week")
        team_targets[m] = {"mode": ("sum" if m in summed else "set") if wk is not None else None,
                           "value": None if m in summed else wk, "effective": wk}
    return {"available": False, "team": team, "owners": owners,
            "team_targets": team_targets, "pipeline": []}


@router.get("")
async def get_jobs_targets(user=Depends(require_auth)):
    await store.refresh(get_pool(), force=True)
    data = store.snapshot_for_api() if store.available() else _fallback_view()
    data["metrics"] = [{"key": k, "label": lbl} for k, lbl in store.OUTREACH_METRICS]
    return {"success": True, "data": data}


def _require_available():
    if not store.available():
        raise HTTPException(409, _PENDING)


# ── Team ──────────────────────────────────────────────────────────────────────

class TeamBody(BaseModel):
    members: list[str] = Field(..., min_length=1, max_length=50)


@router.put("/team")
async def put_jobs_team(body: TeamBody, user=Depends(check_permission("manage_jobs_targets")),
                        conn=Depends(get_db)):
    await store.refresh(get_pool(), force=True)
    _require_available()
    members: list[str] = []
    for raw in body.members:
        e = (raw or "").strip().lower()
        if not store.valid_email(e):
            raise HTTPException(400, f"Not a Pursuit address: {raw!r}")
        if e not in members:
            members.append(e)
    editor = _editor(user)
    async with conn.transaction():
        # Removed people are deactivated, not deleted, so their targets and
        # history survive being taken off and put back on the team.
        await conn.execute(
            "UPDATE bedrock.jobs_team_member SET active = false, updated_at = now() "
            "WHERE NOT (email = ANY($1::text[]))", members)
        for i, e in enumerate(members):
            await conn.execute(
                """INSERT INTO bedrock.jobs_team_member (email, active, sort_order, added_by)
                   VALUES ($1, true, $2, $3)
                   ON CONFLICT (email) DO UPDATE
                     SET active = true, sort_order = EXCLUDED.sort_order, updated_at = now()""",
                e, i + 1, editor)
    await store.refresh(get_pool(), force=True)
    logger.info(f"jobs team set to {members} by {editor}")
    return {"success": True, "data": store.snapshot_for_api()}


# ── Outreach ──────────────────────────────────────────────────────────────────

class TeamTarget(BaseModel):
    mode: Literal["sum", "set"]
    value: Optional[int] = Field(None, ge=0, le=100_000)


class OutreachBody(BaseModel):
    # email -> metric -> weekly target (null = no target for that person)
    owners: dict[str, dict[str, Optional[int]]] = {}
    # metric -> team row. A metric left out has no team target.
    team: dict[str, TeamTarget] = {}


@router.put("/outreach")
async def put_outreach_targets(body: OutreachBody,
                               user=Depends(check_permission("manage_jobs_targets")),
                               conn=Depends(get_db)):
    await store.refresh(get_pool(), force=True)
    _require_available()
    team = set(store.team_emails())
    keys = set(store.OUTREACH_METRIC_KEYS)
    rows: list[tuple] = []
    seen: set[str] = set()
    for raw_email, metrics in body.owners.items():
        e = raw_email.strip().lower()
        if e not in team:
            raise HTTPException(400, f"{raw_email} is not on the Jobs team")
        if e in seen:
            raise HTTPException(400, f"{raw_email} appears more than once")
        seen.add(e)
        for m, v in metrics.items():
            if m not in keys:
                raise HTTPException(400, f"Unknown metric: {m}")
            if v is None:
                continue
            if not 0 <= v <= 100_000:
                raise HTTPException(400, f"Target out of range for {e} / {m}")
            rows.append((m, e, v, None))
    for m, t in body.team.items():
        if m not in keys:
            raise HTTPException(400, f"Unknown metric: {m}")
        if t.mode == "set" and t.value is None:
            raise HTTPException(400, f"Team target for {m} is set to a number but none was given")
        rows.append((m, None, t.value if t.mode == "set" else None, t.mode))

    editor = _editor(user)
    async with conn.transaction():
        # Replace what the page shows: the team rows and the current members'
        # rows (the page always sends that full grid, so a cleared cell must
        # disappear). People taken off the team keep their rows, so putting
        # them back restores their targets.
        await conn.execute(
            "DELETE FROM bedrock.jobs_target WHERE section = 'outreach' "
            "AND (owner_email IS NULL OR owner_email = ANY($1::text[]))",
            sorted(team))
        for m, e, v, mode in rows:
            await conn.execute(
                """INSERT INTO bedrock.jobs_target (section, metric, owner_email, value, team_mode, updated_by)
                   VALUES ('outreach', $1, $2, $3, $4, $5)""",
                m, e, v, mode, editor)
    await store.refresh(get_pool(), force=True)
    logger.info(f"jobs outreach targets saved ({len(rows)} rows) by {editor}")
    return {"success": True, "data": store.snapshot_for_api()}


# ── Pipeline ──────────────────────────────────────────────────────────────────

class QuarterTarget(BaseModel):
    period_start: date
    value: Optional[int] = Field(None, ge=0, le=100_000)


class PipelineBody(BaseModel):
    quarters: list[QuarterTarget] = Field(..., max_length=40)


@router.put("/pipeline")
async def put_pipeline_targets(body: PipelineBody,
                               user=Depends(check_permission("manage_jobs_targets")),
                               conn=Depends(get_db)):
    await store.refresh(get_pool(), force=True)
    _require_available()
    for q in body.quarters:
        d = q.period_start
        if d.day != 1 or d.month not in (1, 4, 7, 10):
            raise HTTPException(400, f"{d.isoformat()} is not the first day of a quarter")
    editor = _editor(user)
    async with conn.transaction():
        for q in body.quarters:
            if q.value is None:
                await conn.execute(
                    "DELETE FROM bedrock.jobs_target WHERE section = 'pipeline' AND metric = 'jobs' "
                    "AND period_start = $1", q.period_start)
            else:
                await conn.execute(
                    """INSERT INTO bedrock.jobs_target (section, metric, period_start, value, updated_by)
                       VALUES ('pipeline', 'jobs', $1, $2, $3)
                       ON CONFLICT (section, metric, coalesce(owner_email, ''),
                                    coalesce(period_start, '1900-01-01'::date))
                       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
                                     updated_at = now()""",
                    q.period_start, q.value, editor)
    await store.refresh(get_pool(), force=True)
    logger.info(f"jobs pipeline targets saved ({len(body.quarters)} quarters) by {editor}")
    return {"success": True, "data": store.snapshot_for_api()}
