"""Awards service — manages bedrock.award rows.

Award is a thin lifecycle entity layered over closed Opportunities across
Philanthropy, PBC, Debt/Equity, and Other Fee For Service record types.
Salesforce stays SoT for the Opportunity itself; this service owns only the
post-award lifecycle bits (status, period, notes) that don't belong on the
Opportunity record.

See `tasks/bedrock-redesign-data-model.md` for the full plan.

Public surface:
    - `is_award_eligible(stage_name, record_type_name)` — pure predicate
    - `ensure_for_opp(conn, sf_client, opp_id)` — idempotent auto-create
    - `get_for_opp(conn, opp_id)` — fetch by SF opp id
"""

from __future__ import annotations

import logging
from datetime import date as date_type
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Eligible record types and their stage allowlists.
#
# Verified against the joinpursuit SF org via backfill_awards --verify-stages
# on 2026-05-02.
#
# award_status mapping:
#   'Active'         — money in flight / ongoing
#   'Closing'        — wrapping up
#   'Closed'         — fully paid out and reported
#   'Did Not Fulfill'— award was made but not fulfilled
# ---------------------------------------------------------------------------

PHILANTHROPY_RECORD_TYPE_NAME = "Philanthropy"

# Stages eligible for an award row, per record type.
ELIGIBLE_STAGES_BY_RECORD_TYPE: Dict[str, frozenset] = {
    "Philanthropy": frozenset({
        "closed-won",
        "Closed Won",
        "Closed / Completed",
        "Closed / Fulfilled",
        "Collecting / In Effect",
        "Collecting",
        "In Effect",
        "Closed / Did not Fulfill",
    }),
    "PBC": frozenset({
        "Closed / Completed",
        "Collecting / In Effect",
        "Closed / Full-Time or Successful Conversion",
        "Closed / Temporary Hire",
        "Closed / Fulfilled",
        "Closed / Contract or Agreement But No Fellows Hired",
        "Closed / Did not Fulfill",
        "Closed / Sourcing",
    }),
    "Debt / Equity": frozenset({
        "Closed / Completed",
    }),
    "Other Fee For Service": frozenset({
        "Closed / Completed",
    }),
}

# Convenience flat set for fast lookups when record type is already known eligible.
WON_PHILANTHROPY_STAGES: frozenset[str] = ELIGIBLE_STAGES_BY_RECORD_TYPE["Philanthropy"]

# Stage → award_status mapping (applies across all record types).
_DID_NOT_FULFILL_STAGES: frozenset[str] = frozenset({
    "Closed / Did not Fulfill",
    "Closed / Contract or Agreement But No Fellows Hired",
})

_CLOSING_STAGES: frozenset[str] = frozenset({
    "Closed / Fulfilled",
})
# Public alias used by tests and external callers.
CLOSING_PHILANTHROPY_STAGES = _CLOSING_STAGES

_CLOSED_STAGES: frozenset[str] = frozenset({
    "Closed / Completed",
    "Closed Won",
    "closed-won",
    "Closed / Full-Time or Successful Conversion",
    "Closed / Temporary Hire",
    "Closed / Sourcing",
})


def is_award_eligible(stage_name: Optional[str], record_type_name: Optional[str]) -> bool:
    """Pure predicate: should this opp have a Bedrock award row?"""
    if not stage_name or not record_type_name:
        return False
    eligible = ELIGIBLE_STAGES_BY_RECORD_TYPE.get(record_type_name)
    if eligible is None:
        return False
    return stage_name in eligible


def initial_award_status(stage_name: str) -> str:
    if stage_name in _DID_NOT_FULFILL_STAGES:
        return "Did Not Fulfill"
    if stage_name in _CLOSED_STAGES:
        return "Closed"
    if stage_name in _CLOSING_STAGES:
        return "Closing"
    return "Active"


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

async def get_for_opp(conn, opp_id: str) -> Optional[Dict[str, Any]]:
    """Return the active (non-deleted) award for the given opp, if any."""
    row = await conn.fetchrow(
        """
        SELECT id, opportunity_id, award_status, award_date, period_end_date,
               notes, created_at, updated_at
        FROM bedrock.award
        WHERE opportunity_id = $1 AND deleted_at IS NULL
        """,
        opp_id,
    )
    return dict(row) if row else None


async def ensure_for_opp(
    conn,
    sf_client,
    opp_id: str,
    *,
    stage_name_hint: Optional[str] = None,
    record_type_hint: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Idempotently ensure a bedrock.award row exists for a Philanthropy opp
    that has reached a closed/active-grant stage.

    Returns the award row (existing or newly created), or None if the opp
    doesn't qualify (wrong record type, wrong stage, or already
    soft-deleted award we don't want to revive automatically).

    Inputs:
        conn:              asyncpg.Connection
        sf_client:         simple_salesforce-style client (must support
                           `.query()` returning {records: [...]}).
        opp_id:            18-char SF Opportunity Id.
        stage_name_hint:   Optional; if known by caller (e.g., from the
                           write that just succeeded), saves a SOQL round
                           trip. Still verified against SF if absent.
        record_type_hint:  Optional; same pattern as stage_name_hint.

    Idempotency:
        Uses `INSERT ... ON CONFLICT (opportunity_id) WHERE deleted_at IS
        NULL DO NOTHING` (via the partial unique index from the migration).
        Safe to call on every stage-change write or sync poll.
    """
    # asyncpg expects datetime.date, not a string. SF returns "YYYY-MM-DD".
    def _to_date(v):
        if isinstance(v, date_type):
            return v
        if isinstance(v, str):
            try:
                return date_type.fromisoformat(v)
            except ValueError:
                return None
        return None

    # 1. Fetch stage + record type if not provided. The same SOQL also pulls
    # CloseDate and the grant period fields — the Opportunity is the source of
    # truth for the grant period, seeding award_date / period_end_date below.
    stage_name = stage_name_hint
    record_type_name = record_type_hint
    close_date = None
    grant_start = None
    grant_end = None

    _SOQL = (
        f"SELECT StageName, RecordType.Name, CloseDate, "
        f"Grant_Start_Date__c, Grant_End_Date__c "
        f"FROM Opportunity WHERE Id = '{opp_id}' LIMIT 1"
    )

    def _absorb(rec: Dict[str, Any]) -> None:
        nonlocal stage_name, record_type_name, close_date, grant_start, grant_end
        stage_name = stage_name or rec.get("StageName")
        rt = rec.get("RecordType") or {}
        record_type_name = record_type_name or rt.get("Name")
        close_date = _to_date(rec.get("CloseDate"))
        grant_start = _to_date(rec.get("Grant_Start_Date__c"))
        grant_end = _to_date(rec.get("Grant_End_Date__c"))

    fetched = False
    if stage_name is None or record_type_name is None:
        try:
            # `sf_client.query` is async on the unified MCP client wrapper —
            # the prior synchronous-style call returned a coroutine that then
            # blew up on `.get("records")`. Await it.
            result = await sf_client.query(_SOQL)
        except Exception:
            logger.exception("awards.ensure_for_opp: SF query failed for %s", opp_id)
            return None
        records = result.get("records") or []
        if not records:
            logger.info("awards.ensure_for_opp: opp %s not found in SF", opp_id)
            return None
        _absorb(records[0])
        fetched = True

    # 2. Eligibility gate
    if not is_award_eligible(stage_name, record_type_name):
        logger.info(
            "awards.ensure_for_opp: opp=%s not eligible (stage=%r, record_type=%r)",
            opp_id, stage_name, record_type_name,
        )
        return None

    # 3. Existing? Return as-is.
    existing = await get_for_opp(conn, opp_id)
    if existing:
        return existing

    # 4. Insert. Grant period flows down from the Opportunity when present:
    # award_date is the grant start (falling back to CloseDate as a proxy),
    # period_end_date is the grant end. Both editable on the award later.
    # Hinted callers skipped the SOQL above (their fast path — and the common
    # case of an already-existing award never needs SF at all); fetch the
    # dates now, best-effort, only because we're actually creating the row.
    if not fetched:
        try:
            result = await sf_client.query(_SOQL)
            records = result.get("records") or []
            if records:
                _absorb(records[0])
        except Exception:
            logger.warning(
                "awards.ensure_for_opp: date fetch failed for %s; "
                "creating award without grant dates.", opp_id)

    initial_status = initial_award_status(stage_name)
    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.award (opportunity_id, award_status, award_date,
                                   period_end_date, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (opportunity_id) WHERE deleted_at IS NULL DO NOTHING
        RETURNING id, opportunity_id, award_status, award_date, period_end_date,
                  notes, created_at, updated_at
        """,
        opp_id,
        initial_status,
        grant_start or close_date,  # may be None — fine; user can edit later
        grant_end,
        f"Auto-created on stage transition to {stage_name}",
    )

    # ON CONFLICT DO NOTHING + race: another caller created the row between
    # get_for_opp and INSERT. Refetch.
    if row is None:
        return await get_for_opp(conn, opp_id)

    logger.info(
        "awards.ensure_for_opp: created award for opp=%s stage=%s status=%s",
        opp_id, stage_name, initial_status,
    )

    # Cascade: if the source opportunity was already linked to projects (so the
    # RM could plan work before the award officially existed), copy those links
    # onto the new award. Idempotent via ON CONFLICT.
    await _cascade_opp_projects_to_award(conn, opp_id, row["id"])

    return dict(row)


async def _cascade_opp_projects_to_award(conn, opp_id: str, award_id) -> int:
    """Mirror project_opportunity links onto project_award when an award is born.

    Returns the count of new project_award rows inserted. Safe to call repeatedly:
    ON CONFLICT DO NOTHING means re-running on an already-cascaded award is a no-op.
    """
    inserted = await conn.fetch(
        """
        INSERT INTO bedrock.project_award (project_id, award_id)
        SELECT po.project_id, $2
        FROM bedrock.project_opportunity po
        WHERE po.opportunity_id = $1
        ON CONFLICT DO NOTHING
        RETURNING id
        """,
        opp_id, award_id,
    )
    if inserted:
        logger.info(
            "awards.cascade: opp=%s award=%s linked %d project(s)",
            opp_id, award_id, len(inserted),
        )
    return len(inserted)
