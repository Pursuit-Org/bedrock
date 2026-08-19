"""Commitments API — grant obligation tracking over bedrock.grant_commitment.

A commitment is one discrete obligation from a signed grant contract
(e.g. "50 Builders enrolled by 2027-06-30"). Every commitment anchors to
an existing bedrock.award row — Award is already the "contract" grain
(one funder, one signed document, 1:1 with a closed-won Opportunity), so
there's no separate Contract entity here.

Status (on-track / ahead / under / complete) is never stored — it's
computed at read time by services.commitment_status from the deadline
plus the latest bedrock.commitment_progress_log entry.

Endpoints:
    GET    /api/commitments                      — list (tracking_tier / award_id filters)
    GET    /api/commitments/{id}                 — single, SF-enriched
    GET    /api/commitments/by-award/{award_id}   — all commitments for one award
    POST   /api/commitments                      — create
    PATCH  /api/commitments/{id}                 — update mutable fields
    DELETE /api/commitments/{id}                 — soft delete
    GET    /api/commitments/{id}/log              — progress history
    POST   /api/commitments/{id}/log              — append a progress entry
    DELETE /api/commitments/log/{log_id}          — soft-delete a mistaken entry
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import get_db
from dependencies import get_mcp_client
from routes.permissions import check_permission
from routes.projects import _enrich_opp_ids_with_sf
from services.commitment_status import compute_commitment_status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/commitments", tags=["commitments"])

_ALLOWED_COMMITMENT_TYPE = frozenset({"quantitative", "qualitative"})
_ALLOWED_TRACKING_TIER = frozenset({"tracked", "reference"})
_ALLOWED_QUAL_STATUS = frozenset(
    {"not-started", "in-progress", "met", "not-met", "pending-verification"}
)

# Base query — the LATERAL join computes "latest progress" from the
# append-only log at read time, exactly mirroring how award_report
# aggregates are computed for award in routes/awards.py's _SELECT. There
# is deliberately no denormalized current-value column on
# grant_commitment for this to drift against.
_SELECT = """
    SELECT
        c.id, c.award_id, c.commitment_type, c.title, c.contract_language,
        c.delivery_plan, c.tracking_tier, c.target_value, c.target_unit,
        c.start_date, c.deadline, c.owner, c.owner_ids, c.notes, c.sort_order,
        c.created_at, c.updated_at, c.created_by,
        a.award_date,
        log.latest_value, log.latest_qualitative_status,
        log.last_update_at, log.last_update_by,
        COALESCE(log.update_count, 0) AS update_count
    FROM bedrock.grant_commitment c
    JOIN bedrock.award a ON a.id = c.award_id
    LEFT JOIN LATERAL (
        SELECT
            l.recorded_value AS latest_value,
            l.recorded_status AS latest_qualitative_status,
            l.recorded_at AS last_update_at,
            l.recorded_by_email AS last_update_by,
            (SELECT COUNT(*) FROM bedrock.commitment_progress_log l2
               WHERE l2.commitment_id = c.id AND l2.deleted_at IS NULL) AS update_count
        FROM bedrock.commitment_progress_log l
        WHERE l.commitment_id = c.id AND l.deleted_at IS NULL
        ORDER BY l.recorded_at DESC, l.created_at DESC
        LIMIT 1
    ) log ON TRUE
"""


class CommitmentCreate(BaseModel):
    award_id: str
    commitment_type: str
    title: str
    contract_language: str = ""
    delivery_plan: str = ""
    tracking_tier: str = "tracked"
    target_value: Optional[float] = None
    target_unit: Optional[str] = None
    start_date: str
    deadline: str
    owner: str = ""
    owner_ids: List[str] = []
    notes: str = ""
    sort_order: int = 0


class CommitmentUpdate(BaseModel):
    title: Optional[str] = None
    contract_language: Optional[str] = None
    delivery_plan: Optional[str] = None
    tracking_tier: Optional[str] = None
    target_value: Optional[float] = None
    target_unit: Optional[str] = None
    start_date: Optional[str] = None
    deadline: Optional[str] = None
    owner: Optional[str] = None
    owner_ids: Optional[List[str]] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None


class ProgressLogCreate(BaseModel):
    recorded_value: Optional[float] = None
    recorded_status: Optional[str] = None
    note: str = ""
    recorded_at: Optional[str] = None


def _parse_date(raw: str, field: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {field}: expected YYYY-MM-DD, got {raw!r}")


def _parse_owner_ids(raw: List[str]) -> List[uuid.UUID]:
    try:
        return [uuid.UUID(x) for x in raw]
    except ValueError:
        raise HTTPException(status_code=400, detail="owner_ids must be valid UUIDs")


def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["id"] = str(out["id"])
    out["award_id"] = str(out["award_id"])
    out["owner_ids"] = [str(u) for u in (out.get("owner_ids") or [])]

    status = compute_commitment_status(
        commitment_type=out["commitment_type"],
        target_value=out.get("target_value"),
        latest_value=out.get("latest_value"),
        latest_qualitative_status=out.get("latest_qualitative_status"),
        start_date=out["start_date"],
        deadline=out["deadline"],
    )
    out["status"] = status

    for k in ("start_date", "deadline", "award_date", "created_at", "updated_at", "last_update_at"):
        v = out.get(k)
        if v is not None:
            out[k] = v.isoformat()
    return out


def _serialize_log(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["id"] = str(out["id"])
    out["commitment_id"] = str(out["commitment_id"])
    for k in ("recorded_at", "created_at"):
        v = out.get(k)
        if v is not None:
            out[k] = v.isoformat()
    return out


# ── Commitments ──────────────────────────────────────────────────────────


@router.get("")
async def list_commitments(
    tracking_tier: Optional[str] = Query(
        "tracked", description="Filter by tracking_tier — 'tracked' (default), 'reference', or 'all'"
    ),
    award_id: Optional[str] = Query(None),
    user=Depends(check_permission("view_commitments")),
    conn=Depends(get_db),
) -> List[Dict[str, Any]]:
    if tracking_tier not in (None, "all", *_ALLOWED_TRACKING_TIER):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid tracking_tier. Must be one of: {sorted(_ALLOWED_TRACKING_TIER)} or 'all'",
        )

    clauses = ["c.deleted_at IS NULL"]
    vals: List[Any] = []
    if tracking_tier and tracking_tier != "all":
        vals.append(tracking_tier)
        clauses.append(f"c.tracking_tier = ${len(vals)}")
    if award_id:
        try:
            vals.append(uuid.UUID(award_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid award_id")
        clauses.append(f"c.award_id = ${len(vals)}")

    sql = _SELECT + "WHERE " + " AND ".join(clauses) + " ORDER BY c.deadline ASC, c.sort_order ASC"
    rows = await conn.fetch(sql, *vals)
    return [_serialize(r) for r in rows]


@router.get("/by-award/{award_id}")
async def get_commitments_by_award(
    award_id: str,
    user=Depends(check_permission("view_commitments")),
    conn=Depends(get_db),
) -> List[Dict[str, Any]]:
    try:
        aid = uuid.UUID(award_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid award_id")
    rows = await conn.fetch(
        _SELECT + "WHERE c.award_id = $1 AND c.deleted_at IS NULL "
        "ORDER BY c.deadline ASC, c.sort_order ASC",
        aid,
    )
    return [_serialize(r) for r in rows]


@router.get("/{commitment_id}")
async def get_commitment(
    commitment_id: str,
    user=Depends(check_permission("view_commitments")),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
) -> Dict[str, Any]:
    try:
        cid = uuid.UUID(commitment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid commitment_id")
    row = await conn.fetchrow(_SELECT + "WHERE c.id = $1 AND c.deleted_at IS NULL", cid)
    if not row:
        raise HTTPException(status_code=404, detail="Commitment not found")
    out = _serialize(row)

    # SF-enrich for funder/opp display context, same as get_award.
    award_opp = await conn.fetchval(
        "SELECT opportunity_id FROM bedrock.award WHERE id = $1", row["award_id"]
    )
    opp_lookup = await _enrich_opp_ids_with_sf([award_opp], client)
    sf = opp_lookup.get(award_opp) or {}
    out["opportunity_id"] = award_opp
    out["opportunity_name"] = sf.get("Name")
    out["account_name"] = sf.get("AccountName")
    return out


@router.post("")
async def create_commitment(
    body: CommitmentCreate,
    user=Depends(check_permission("manage_commitments")),
    conn=Depends(get_db),
) -> Dict[str, Any]:
    if body.commitment_type not in _ALLOWED_COMMITMENT_TYPE:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid commitment_type. Must be one of: {sorted(_ALLOWED_COMMITMENT_TYPE)}",
        )
    if body.tracking_tier not in _ALLOWED_TRACKING_TIER:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid tracking_tier. Must be one of: {sorted(_ALLOWED_TRACKING_TIER)}",
        )
    if body.commitment_type == "quantitative" and body.target_value is None:
        raise HTTPException(status_code=400, detail="target_value is required for quantitative commitments")
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="title is required")

    try:
        aid = uuid.UUID(body.award_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid award_id")

    award_exists = await conn.fetchval(
        "SELECT 1 FROM bedrock.award WHERE id = $1 AND deleted_at IS NULL", aid
    )
    if not award_exists:
        raise HTTPException(status_code=404, detail="Award not found")

    start_date_val = _parse_date(body.start_date, "start_date")
    deadline_val = _parse_date(body.deadline, "deadline")
    if deadline_val < start_date_val:
        raise HTTPException(status_code=400, detail="deadline cannot be before start_date")
    owner_ids = _parse_owner_ids(body.owner_ids)

    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.grant_commitment
            (award_id, commitment_type, title, contract_language, delivery_plan,
             tracking_tier, target_value, target_unit, start_date, deadline,
             owner, owner_ids, notes, sort_order, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
        """,
        aid, body.commitment_type, body.title, body.contract_language, body.delivery_plan,
        body.tracking_tier, body.target_value, body.target_unit, start_date_val, deadline_val,
        body.owner, owner_ids, body.notes, body.sort_order, user.get("email"),
    )
    created = await conn.fetchrow(_SELECT + "WHERE c.id = $1", row["id"])
    return _serialize(created)


@router.patch("/{commitment_id}")
async def update_commitment(
    commitment_id: str,
    body: CommitmentUpdate,
    user=Depends(check_permission("manage_commitments")),
    conn=Depends(get_db),
) -> Dict[str, Any]:
    try:
        cid = uuid.UUID(commitment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid commitment_id")

    if body.tracking_tier is not None and body.tracking_tier not in _ALLOWED_TRACKING_TIER:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid tracking_tier. Must be one of: {sorted(_ALLOWED_TRACKING_TIER)}",
        )

    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    existing = await conn.fetchrow(
        "SELECT commitment_type, start_date, deadline FROM bedrock.grant_commitment "
        "WHERE id = $1 AND deleted_at IS NULL",
        cid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Commitment not found")

    if "title" in fields and fields["title"] is not None and not fields["title"].strip():
        raise HTTPException(status_code=400, detail="title cannot be empty")
    if (
        "target_value" in fields
        and fields["target_value"] is None
        and existing["commitment_type"] == "quantitative"
    ):
        raise HTTPException(status_code=400, detail="target_value cannot be cleared on a quantitative commitment")

    if "owner_ids" in fields and fields["owner_ids"] is not None:
        fields["owner_ids"] = _parse_owner_ids(fields["owner_ids"])
    if "start_date" in fields and fields["start_date"] is not None:
        fields["start_date"] = _parse_date(fields["start_date"], "start_date")
    if "deadline" in fields and fields["deadline"] is not None:
        fields["deadline"] = _parse_date(fields["deadline"], "deadline")

    effective_start = fields.get("start_date", existing["start_date"])
    effective_deadline = fields.get("deadline", existing["deadline"])
    if effective_deadline < effective_start:
        raise HTTPException(status_code=400, detail="deadline cannot be before start_date")

    sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
    vals = [cid] + list(fields.values())
    updated = await conn.fetchrow(
        f"UPDATE bedrock.grant_commitment SET {sets}, updated_at = now() "
        f"WHERE id = $1 AND deleted_at IS NULL RETURNING id",
        *vals,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Commitment not found")
    row = await conn.fetchrow(_SELECT + "WHERE c.id = $1", cid)
    return _serialize(row)


@router.delete("/{commitment_id}")
async def delete_commitment(
    commitment_id: str,
    user=Depends(check_permission("manage_commitments")),
    conn=Depends(get_db),
) -> Dict[str, Any]:
    try:
        cid = uuid.UUID(commitment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid commitment_id")
    row = await conn.fetchrow(
        "UPDATE bedrock.grant_commitment SET deleted_at = now(), deleted_by = $2 "
        "WHERE id = $1 AND deleted_at IS NULL RETURNING id",
        cid, user.get("email"),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Commitment not found")
    return {"ok": True, "id": str(row["id"])}


# ── Progress log ─────────────────────────────────────────────────────────


@router.get("/{commitment_id}/log")
async def list_progress_log(
    commitment_id: str,
    user=Depends(check_permission("view_commitments")),
    conn=Depends(get_db),
) -> List[Dict[str, Any]]:
    try:
        cid = uuid.UUID(commitment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid commitment_id")
    rows = await conn.fetch(
        """
        SELECT id, commitment_id, recorded_value, recorded_status, note,
               recorded_by_email, recorded_at, created_at
        FROM bedrock.commitment_progress_log
        WHERE commitment_id = $1 AND deleted_at IS NULL
        ORDER BY recorded_at DESC, created_at DESC
        """,
        cid,
    )
    return [_serialize_log(r) for r in rows]


@router.post("/{commitment_id}/log")
async def create_progress_log(
    commitment_id: str,
    body: ProgressLogCreate,
    user=Depends(check_permission("manage_commitments")),
    conn=Depends(get_db),
) -> Dict[str, Any]:
    try:
        cid = uuid.UUID(commitment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid commitment_id")

    commitment = await conn.fetchrow(
        "SELECT commitment_type FROM bedrock.grant_commitment WHERE id = $1 AND deleted_at IS NULL",
        cid,
    )
    if not commitment:
        raise HTTPException(status_code=404, detail="Commitment not found")

    if body.recorded_value is None and body.recorded_status is None:
        raise HTTPException(status_code=400, detail="recorded_value or recorded_status is required")

    if commitment["commitment_type"] == "quantitative" and body.recorded_value is None:
        raise HTTPException(status_code=400, detail="recorded_value is required for a quantitative commitment")
    if commitment["commitment_type"] == "qualitative" and body.recorded_status is None:
        raise HTTPException(status_code=400, detail="recorded_status is required for a qualitative commitment")
    if body.recorded_status is not None and body.recorded_status not in _ALLOWED_QUAL_STATUS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid recorded_status. Must be one of: {sorted(_ALLOWED_QUAL_STATUS)}",
        )

    recorded_at = datetime.now(timezone.utc)
    if body.recorded_at:
        try:
            recorded_at = datetime.fromisoformat(body.recorded_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="recorded_at must be an ISO datetime")
        if recorded_at.tzinfo is None:
            # A bare "YYYY-MM-DDTHH:MM:SS" with no offset — treat as UTC
            # explicitly rather than letting asyncpg/Postgres silently
            # interpret it under the session's local timezone.
            recorded_at = recorded_at.replace(tzinfo=timezone.utc)

    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.commitment_progress_log
            (commitment_id, recorded_value, recorded_status, note, recorded_by_email, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, commitment_id, recorded_value, recorded_status, note,
                  recorded_by_email, recorded_at, created_at
        """,
        cid, body.recorded_value, body.recorded_status, body.note, user.get("email"), recorded_at,
    )
    return _serialize_log(row)


@router.delete("/log/{log_id}")
async def delete_progress_log(
    log_id: str,
    user=Depends(check_permission("manage_commitments")),
    conn=Depends(get_db),
) -> Dict[str, Any]:
    try:
        lid = uuid.UUID(log_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid log_id")
    row = await conn.fetchrow(
        "UPDATE bedrock.commitment_progress_log SET deleted_at = now() "
        "WHERE id = $1 AND deleted_at IS NULL RETURNING id",
        lid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Progress log entry not found")
    return {"ok": True, "id": str(row["id"])}
