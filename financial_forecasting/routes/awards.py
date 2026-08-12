"""Awards API — read endpoints over bedrock.award.

Award is a thin lifecycle entity layered over closed Opportunities across
Philanthropy, PBC, Debt/Equity, and Other Fee For Service record types.
Salesforce stays SoT for the Opportunity itself.

Endpoints:
    GET    /api/awards                    — list (filterable by status)
    GET    /api/awards/{award_id}         — single award by Bedrock id
    GET    /api/awards/by-opp/{opp_id}    — single award by SF opportunity id
    PATCH  /api/awards/{award_id}         — update mutable fields
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import require_auth
from db import get_db
from dependencies import get_mcp_client
from routes.projects import _enrich_opp_ids_with_sf
from security import validate_salesforce_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/awards", tags=["awards"])

# Award row + per-award report aggregates (so the table doesn't N+1).
_SELECT = """
    SELECT
        a.id, a.opportunity_id, a.award_status, a.award_date,
        a.period_end_date, a.notes, a.reporting_frequency, a.next_report_due,
        a.contract_file_link,
        a.created_at, a.updated_at,
        COALESCE(rs.report_total, 0)    AS report_total,
        COALESCE(rs.report_done, 0)     AS report_done,
        COALESCE(rs.report_overdue, 0)  AS report_overdue,
        rs.next_report_date,
        rs.next_report_status
    FROM bedrock.award a
    LEFT JOIN LATERAL (
        SELECT
            COUNT(*) FILTER (WHERE r.deleted_at IS NULL)
                AS report_total,
            COUNT(*) FILTER (WHERE r.deleted_at IS NULL
                                AND r.status IN ('Submitted', 'Approved'))
                AS report_done,
            COUNT(*) FILTER (WHERE r.deleted_at IS NULL
                                AND r.status = 'Pending'
                                AND r.due_date < CURRENT_DATE)
                AS report_overdue,
            (SELECT r2.due_date
               FROM bedrock.award_report r2
              WHERE r2.award_id = a.id
                AND r2.deleted_at IS NULL
                AND r2.status = 'Pending'
              ORDER BY r2.due_date ASC LIMIT 1) AS next_report_date,
            (SELECT r2.status
               FROM bedrock.award_report r2
              WHERE r2.award_id = a.id
                AND r2.deleted_at IS NULL
                AND r2.status = 'Pending'
              ORDER BY r2.due_date ASC LIMIT 1) AS next_report_status
        FROM bedrock.award_report r
        WHERE r.award_id = a.id
    ) rs ON TRUE
"""

_ALLOWED_STATUS = frozenset({"Active", "Closing", "Closed", "Did Not Fulfill"})


class AwardOut(BaseModel):
    id: str
    opportunity_id: str
    award_status: str
    award_date: Optional[str] = None
    period_end_date: Optional[str] = None
    notes: str
    reporting_frequency: Optional[str] = None
    next_report_due: Optional[str] = None
    contract_file_link: Optional[str] = None
    created_at: str
    updated_at: str


class AwardUpdate(BaseModel):
    award_status: Optional[str] = Field(default=None)
    award_date: Optional[str] = None
    period_end_date: Optional[str] = None
    notes: Optional[str] = None
    reporting_frequency: Optional[str] = None
    next_report_due: Optional[str] = None
    # Link to the signed source document backing this award — introduced
    # for the Commitments feature (contract_language on each commitment
    # quotes this same document; the link lives on the award since one
    # document covers a whole award's set of commitments).
    contract_file_link: Optional[str] = None


def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["id"] = str(out["id"])
    for k in (
        "award_date", "period_end_date", "next_report_due",
        "next_report_date", "created_at", "updated_at",
    ):
        v = out.get(k)
        if v is not None:
            out[k] = v.isoformat()
    return out


def _serialize_report(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["id"] = str(out["id"])
    out["award_id"] = str(out["award_id"])
    for k in ("due_date", "submitted_at", "created_at", "updated_at"):
        v = out.get(k)
        if v is not None:
            out[k] = v.isoformat()
    return out


_ALLOWED_REPORT_STATUS = frozenset({"Pending", "Submitted", "Approved", "Skipped"})


class AwardReportCreate(BaseModel):
    due_date: str
    status: str = "Pending"
    notes: str = ""
    sort_order: int = 0


class AwardReportUpdate(BaseModel):
    due_date: Optional[str] = None
    status: Optional[str] = None
    submitted_at: Optional[str] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None


_FREQUENCY_TO_MONTHS: Dict[str, int] = {
    "Monthly": 1,
    "Quarterly": 3,
    "Semi-Annual": 6,
    "Annual": 12,
}


# ── Endpoints ─────────────────────────────────────────────────────────────


@router.post("/reconcile")
async def reconcile_awards(
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Idempotently create award rows for any award-eligible opp that's
    missing one. Catches the case where someone changes the stage in
    Salesforce directly (workflow rule, data loader, SF UI), bypassing
    Bedrock's update-stage endpoint.

    Admin-only. Also runs as a daily background task; this endpoint
    just lets an admin force a run.
    """
    # Lazy imports to keep awards.py import light.
    from main import _services
    from routes.permissions import require_admin
    # Manually invoke the admin gate so we can keep this file's auth
    # imports minimal; if non-admin reaches here require_admin raises 403.
    await require_admin(user=user, db=conn)

    client = _services.get("mcp_client")
    if not client or "salesforce" not in (client.connected_services or set()):
        raise HTTPException(status_code=503, detail="Salesforce not connected")

    from services.awards_reconciler import reconcile_all
    summary = await reconcile_all(conn, client.salesforce)
    return {"success": True, "data": summary}


@router.get("")
async def list_awards(
    status: Optional[str] = Query(None, description="Filter by award_status"),
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> List[Dict[str, Any]]:
    if status is not None and status not in _ALLOWED_STATUS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {sorted(_ALLOWED_STATUS)}",
        )
    if status:
        rows = await conn.fetch(
            _SELECT + "WHERE a.deleted_at IS NULL AND a.award_status = $1 "
            "ORDER BY a.award_date DESC NULLS LAST, a.created_at DESC",
            status,
        )
    else:
        rows = await conn.fetch(
            _SELECT + "WHERE a.deleted_at IS NULL "
            "ORDER BY a.award_date DESC NULLS LAST, a.created_at DESC"
        )
    return [_serialize(r) for r in rows]


@router.get("/by-opp/{opp_id}")
async def get_award_by_opp(
    opp_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    validate_salesforce_id(opp_id, "opportunity_id")
    row = await conn.fetchrow(
        _SELECT + "WHERE a.opportunity_id = $1 AND a.deleted_at IS NULL",
        opp_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Award not found for this opportunity")
    return _serialize(row)


@router.get("/{award_id}")
async def get_award(
    award_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
    client=Depends(get_mcp_client),
) -> Dict[str, Any]:
    try:
        aid = uuid.UUID(award_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid award_id")
    row = await conn.fetchrow(
        _SELECT + "WHERE a.id = $1 AND a.deleted_at IS NULL",
        aid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Award not found")
    out = _serialize(row)
    # Enrich with SF Opportunity display fields so the AwardDetail page
    # can render headline data (account, opp name, amount, paid, owner,
    # record type) for users who haven't connected their own Salesforce
    # session — uses the service-account SF via get_mcp_client.
    opp_lookup = await _enrich_opp_ids_with_sf([out.get("opportunity_id")], client)
    sf = opp_lookup.get(out.get("opportunity_id")) or {}
    out["opportunity_name"] = sf.get("Name")
    out["account_id"] = sf.get("AccountId")
    out["account_name"] = sf.get("AccountName")
    out["amount"] = sf.get("Amount")
    out["stage_name"] = sf.get("StageName")
    out["owner_id"] = sf.get("OwnerId")
    out["owner_name"] = sf.get("OwnerName")
    out["record_type_name"] = sf.get("RecordTypeName")
    out["payments_made"] = sf.get("PaymentsMade")
    return out


@router.patch("/{award_id}")
async def update_award(
    award_id: str,
    payload: AwardUpdate,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    try:
        aid = uuid.UUID(award_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid award_id")

    if payload.award_status is not None and payload.award_status not in _ALLOWED_STATUS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid award_status. Must be one of: {sorted(_ALLOWED_STATUS)}",
        )

    sets: List[str] = []
    vals: List[Any] = []

    # asyncpg needs datetime.date for DATE columns. Convert ISO date
    # strings ("YYYY-MM-DD") on the way in; non-date columns pass
    # through untouched.
    DATE_FIELDS = {"award_date", "period_end_date", "next_report_due"}
    from datetime import date as _date  # local import to avoid module-level churn

    for field, col in [
        ("award_status", "award_status"),
        ("award_date", "award_date"),
        ("period_end_date", "period_end_date"),
        ("notes", "notes"),
        ("reporting_frequency", "reporting_frequency"),
        ("next_report_due", "next_report_due"),
        ("contract_file_link", "contract_file_link"),
    ]:
        v = getattr(payload, field)
        if v is not None:
            if field in DATE_FIELDS and isinstance(v, str):
                try:
                    v = _date.fromisoformat(v)
                except ValueError:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid {field}: expected YYYY-MM-DD, got {v!r}",
                    )
            sets.append(f"{col} = ${len(vals) + 2}")
            vals.append(v)

    if not sets:
        raise HTTPException(status_code=400, detail="No fields to update")

    sql = (
        f"UPDATE bedrock.award SET {', '.join(sets)}, updated_at = now() "
        f"WHERE id = $1 AND deleted_at IS NULL RETURNING id"
    )
    updated = await conn.fetchrow(sql, aid, *vals)
    if not updated:
        raise HTTPException(status_code=404, detail="Award not found")
    row = await conn.fetchrow(
        _SELECT + "WHERE a.id = $1 AND a.deleted_at IS NULL",
        aid,
    )
    return _serialize(row)


# ── Reports endpoints ─────────────────────────────────────────────────────


@router.get("/{award_id}/reports")
async def list_reports(
    award_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> List[Dict[str, Any]]:
    try:
        aid = uuid.UUID(award_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid award_id")
    rows = await conn.fetch(
        """
        SELECT id, award_id, due_date, status, submitted_at, submitted_by_email,
               notes, sort_order, created_at, updated_at
        FROM bedrock.award_report
        WHERE award_id = $1 AND deleted_at IS NULL
        ORDER BY due_date ASC, sort_order ASC
        """,
        aid,
    )
    return [_serialize_report(r) for r in rows]


@router.post("/{award_id}/reports")
async def create_report(
    award_id: str,
    payload: AwardReportCreate,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    try:
        aid = uuid.UUID(award_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid award_id")
    if payload.status not in _ALLOWED_REPORT_STATUS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {sorted(_ALLOWED_REPORT_STATUS)}",
        )
    try:
        due = date.fromisoformat(payload.due_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="due_date must be YYYY-MM-DD")
    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.award_report (award_id, due_date, status, notes, sort_order)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, award_id, due_date, status, submitted_at, submitted_by_email,
                  notes, sort_order, created_at, updated_at
        """,
        aid, due, payload.status, payload.notes, payload.sort_order,
    )
    return _serialize_report(row)


@router.patch("/reports/{report_id}")
async def update_report(
    report_id: str,
    payload: AwardReportUpdate,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    try:
        rid = uuid.UUID(report_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid report_id")

    if payload.status is not None and payload.status not in _ALLOWED_REPORT_STATUS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {sorted(_ALLOWED_REPORT_STATUS)}",
        )

    sets: List[str] = []
    vals: List[Any] = []

    for field in ("due_date", "status", "submitted_at", "notes", "sort_order"):
        v = getattr(payload, field)
        if v is None:
            continue
        if field == "due_date":
            try:
                v = date.fromisoformat(v)
            except ValueError:
                raise HTTPException(status_code=400, detail="due_date must be YYYY-MM-DD")
        if field == "submitted_at":
            try:
                v = datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(status_code=400, detail="submitted_at must be ISO datetime")
        sets.append(f"{field} = ${len(vals) + 2}")
        vals.append(v)

    # Auto-stamp submitted_at when status flips to Submitted/Approved without one provided
    if payload.status in ("Submitted", "Approved") and payload.submitted_at is None:
        sets.append(f"submitted_at = COALESCE(submitted_at, now())")

    if not sets:
        raise HTTPException(status_code=400, detail="No fields to update")

    sql = (
        f"UPDATE bedrock.award_report SET {', '.join(sets)}, updated_at = now() "
        f"WHERE id = $1 AND deleted_at IS NULL "
        f"RETURNING id, award_id, due_date, status, submitted_at, submitted_by_email, "
        f"notes, sort_order, created_at, updated_at"
    )
    row = await conn.fetchrow(sql, rid, *vals)
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")
    return _serialize_report(row)


@router.delete("/reports/{report_id}")
async def delete_report(
    report_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    try:
        rid = uuid.UUID(report_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid report_id")
    row = await conn.fetchrow(
        "UPDATE bedrock.award_report SET deleted_at = now() "
        "WHERE id = $1 AND deleted_at IS NULL RETURNING id",
        rid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"ok": True, "id": str(row["id"])}


@router.post("/{award_id}/reports/generate")
async def generate_schedule(
    award_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> List[Dict[str, Any]]:
    """Stamp out a schedule of Pending reports from frequency + period_end_date.

    Replaces any existing **Pending** reports for the award (keeps Submitted /
    Approved / Skipped rows untouched). If the award already has Pending rows
    that aren't in the generated set, they're hard-deleted so the schedule
    reflects the current frequency choice.
    """
    try:
        aid = uuid.UUID(award_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid award_id")

    award = await conn.fetchrow(
        "SELECT award_date, period_end_date, reporting_frequency "
        "FROM bedrock.award WHERE id = $1 AND deleted_at IS NULL",
        aid,
    )
    if not award:
        raise HTTPException(status_code=404, detail="Award not found")

    freq = award["reporting_frequency"]
    period_end = award["period_end_date"]
    award_date = award["award_date"]

    if freq == "Final Only" or freq is None or freq == "None":
        if period_end is None:
            raise HTTPException(status_code=400, detail="period_end_date required to generate Final Only schedule")
        dates = [period_end]
    elif freq == "Interim + Final":
        if period_end is None or award_date is None:
            raise HTTPException(status_code=400, detail="award_date and period_end_date required")
        midpoint = award_date + (period_end - award_date) / 2
        dates = [midpoint, period_end]
    else:
        months = _FREQUENCY_TO_MONTHS.get(freq)
        if months is None:
            raise HTTPException(status_code=400, detail=f"Unsupported frequency: {freq}")
        if award_date is None or period_end is None:
            raise HTTPException(status_code=400, detail="award_date and period_end_date required")
        dates = []
        cur = award_date
        # Step forward; first report is one period after the award_date.
        cur = _add_months(cur, months)
        while cur <= period_end:
            dates.append(cur)
            cur = _add_months(cur, months)
        # Always include the period end as the final report if not already there
        if not dates or dates[-1] != period_end:
            dates.append(period_end)

    async with conn.transaction():
        await conn.execute(
            "DELETE FROM bedrock.award_report "
            "WHERE award_id = $1 AND status = 'Pending'",
            aid,
        )
        for i, d in enumerate(dates):
            await conn.execute(
                "INSERT INTO bedrock.award_report (award_id, due_date, status, sort_order) "
                "VALUES ($1, $2, 'Pending', $3)",
                aid, d, i,
            )
        rows = await conn.fetch(
            "SELECT id, award_id, due_date, status, submitted_at, submitted_by_email, "
            "notes, sort_order, created_at, updated_at "
            "FROM bedrock.award_report "
            "WHERE award_id = $1 AND deleted_at IS NULL "
            "ORDER BY due_date ASC, sort_order ASC",
            aid,
        )
    return [_serialize_report(r) for r in rows]


def _add_months(d: date, months: int) -> date:
    """Add `months` to a date, clamping the day to the new month's last day."""
    month = d.month - 1 + months
    year = d.year + month // 12
    month = month % 12 + 1
    # Find the last valid day of the resulting month
    if month == 12:
        next_first = date(year + 1, 1, 1)
    else:
        next_first = date(year, month + 1, 1)
    last_day = (next_first - timedelta(days=1)).day
    return date(year, month, min(d.day, last_day))
