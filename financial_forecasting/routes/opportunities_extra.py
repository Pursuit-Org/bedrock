"""Opportunity bulk operations and stage management endpoints."""

import re
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db
from dependencies import get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from models import OpportunityStage
from routes.permissions import check_permission
from security import validate_salesforce_id, escape_soql_string
from sf_errors import sf_http_error
from services.awards_service import ensure_for_opp as ensure_award_for_opp
from services.record_authorization import enforce_opportunity_mutation
from services.cache import cache, CACHE_TTL_STAGE_HISTORY

logger = logging.getLogger(__name__)

router = APIRouter(tags=["opportunities-extra"])


# ---------------------------------------------------------------------------
# Prior-stage lookup (used by the AccountDetail "Closed lost / withdrawn"
# section so account owners can see at what stage each opp was lost).
# ---------------------------------------------------------------------------


@router.get("/api/salesforce/opportunities/prior-stages")
async def get_prior_stages(
    ids: str = Query(
        ...,
        description=(
            "Comma-separated opportunity Ids. Capped at 200 per request "
            "to stay well below SOQL IN-clause limits."
        ),
    ),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """For each opp Id, return the StageName the opp was in just before
    its most recent transition (i.e. the OldValue of the most recent
    OpportunityFieldHistory row for the StageName field).

    Use case: an account owner viewing a closed-lost / withdrawn opp
    wants to know "where in the funnel did this die?".

    Response shape:
        {
          "0061U000004ABCD": {
              "prior_stage": "Proposal Submitted",
              "transitioned_at": "2026-04-12T14:33:01.000+0000"
          },
          ...
        }

    Opps with no history rows (e.g. created directly into a closed
    stage) are omitted from the response — the frontend renders "—".
    """
    raw_ids = [s.strip() for s in ids.split(",") if s.strip()]
    valid_ids: List[str] = []
    for i in raw_ids[:200]:
        try:
            validate_salesforce_id(i, "id")
            valid_ids.append(i)
        except HTTPException:
            continue
    if not valid_ids:
        return {}

    salesforce = client.salesforce
    quoted = ", ".join(f"'{i}'" for i in valid_ids)
    query = f"""
    SELECT OpportunityId, OldValue, NewValue, CreatedDate
    FROM OpportunityFieldHistory
    WHERE Field = 'StageName'
      AND OpportunityId IN ({quoted})
    ORDER BY OpportunityId, CreatedDate ASC
    """
    try:
        result = await salesforce.query_all(query)
    except Exception as e:
        logger.warning("prior-stages query failed: %s", e)
        raise sf_http_error(e, "stage history")

    rows = result.get("records", [])
    # Take the *last* (most recent) history row per opp; its OldValue is
    # the stage the opp was in immediately before its current StageName.
    by_opp: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        opp_id = r.get("OpportunityId")
        if not opp_id:
            continue
        by_opp[opp_id] = {
            "prior_stage": str(r.get("OldValue") or "") or None,
            "transitioned_at": r.get("CreatedDate"),
        }
    return by_opp


# ---------------------------------------------------------------------------
# Stage history
# ---------------------------------------------------------------------------

@router.get("/api/salesforce/opportunities/{opportunity_id}/stage-history")
async def get_opp_stage_history(
    opportunity_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Full stage-transition history for one opportunity, oldest-first.

    Pulls from OpportunityFieldHistory which retains StageName changes
    for ~18 months by default in SF; older opps may have a truncated
    history. The frontend's StageProgression component combines this
    with the opp's CreatedDate to compute time-in-stage per bucket.
    """
    validate_salesforce_id(opportunity_id, "opportunity_id")
    safe_id = escape_soql_string(opportunity_id)
    cache_key = f"stage_history:opp:{opportunity_id}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        query = f"""
        SELECT OldValue, NewValue, CreatedDate
        FROM OpportunityFieldHistory
        WHERE Field = 'StageName'
          AND OpportunityId = '{safe_id}'
        ORDER BY CreatedDate ASC
        """
        result = await salesforce.query_all(query)
        records = result.get("records", [])
        formatted = [
            {
                "old_value": r.get("OldValue"),
                "new_value": r.get("NewValue"),
                "created_date": r.get("CreatedDate"),
            }
            for r in records
        ]
        cache.set(cache_key, formatted, CACHE_TTL_STAGE_HISTORY)
        return formatted
    except Exception as e:
        logger.warning(f"per-opp stage history failed for %s: %s", opportunity_id, e)
        raise sf_http_error(e, "stage history")


@router.get("/api/salesforce/opportunities/stage-history")
async def get_stage_history(
    days: int = Query(30, ge=1, le=365),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Get StageName changes from OpportunityFieldHistory within the given window."""
    cache_key = f"stage_history:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        query = f"""
        SELECT OpportunityId, Opportunity.Name, Opportunity.Amount,
               Opportunity.StageName, Opportunity.OwnerId, OldValue, NewValue, CreatedDate
        FROM OpportunityFieldHistory
        WHERE Field = 'StageName'
          AND CreatedDate = LAST_N_DAYS:{days}
        ORDER BY CreatedDate DESC
        """
        result = await salesforce.query_all(query)
        records = result.get("records", [])

        formatted = []
        for r in records:
            opp = r.get("Opportunity") or {}
            formatted.append({
                "OpportunityId": r.get("OpportunityId"),
                "OpportunityName": opp.get("Name"),
                "Amount": opp.get("Amount") or 0,
                "CurrentStage": opp.get("StageName"),
                "OwnerId": opp.get("OwnerId"),
                "OldValue": r.get("OldValue"),
                "NewValue": r.get("NewValue"),
                "CreatedDate": r.get("CreatedDate"),
            })

        cache.set(cache_key, formatted, CACHE_TTL_STAGE_HISTORY)
        return formatted

    except Exception as e:
        logger.warning(f"OpportunityFieldHistory query failed: {e}")
        raise sf_http_error(e, "stage history")


# ---------------------------------------------------------------------------
# Ownership history
# ---------------------------------------------------------------------------

_SF_USER_ID_RE = re.compile(r"^005[a-zA-Z0-9]{12,15}$")


@router.get("/api/salesforce/opportunities/ownership-history")
async def get_ownership_history(
    days: int = Query(7, ge=1, le=365),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Get Owner changes from OpportunityFieldHistory within the given window.

    OldValue/NewValue in Salesforce FieldHistory may be User IDs or display
    names depending on org configuration.  When IDs are detected the endpoint
    resolves them to names via a secondary User query so the frontend always
    has human-readable values.
    """
    if "salesforce" not in (client.connected_services or []):
        return []
    cache_key = f"ownership_history:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        query = f"""
        SELECT OpportunityId, Opportunity.Name, Opportunity.Amount,
               Opportunity.StageName, Opportunity.OwnerId, Opportunity.Owner.Name,
               OldValue, NewValue, CreatedDate, CreatedById, CreatedBy.Name
        FROM OpportunityFieldHistory
        WHERE Field = 'Owner'
          AND CreatedDate = LAST_N_DAYS:{days}
        ORDER BY CreatedDate DESC
        """
        result = await salesforce.query_all(query)
        records = result.get("records", [])

        # Collect any OldValue/NewValue that look like Salesforce User IDs so
        # we can resolve them to display names.
        id_values: set[str] = set()
        for r in records:
            for val in (r.get("OldValue"), r.get("NewValue")):
                if val and _SF_USER_ID_RE.match(val):
                    id_values.add(val)

        user_names: Dict[str, str] = {}
        if id_values:
            id_list = ", ".join(f"'{uid}'" for uid in id_values)
            users_result = await salesforce.query(
                f"SELECT Id, Name FROM User WHERE Id IN ({id_list})"
            )
            for u in users_result.get("records", []):
                user_names[u["Id"]] = u["Name"]

        formatted = []
        for r in records:
            opp = r.get("Opportunity") or {}
            opp_owner = opp.get("Owner") or {}
            created_by = r.get("CreatedBy") or {}
            old_raw = r.get("OldValue") or ""
            new_raw = r.get("NewValue") or ""

            formatted.append({
                "OpportunityId": r.get("OpportunityId"),
                "OpportunityName": opp.get("Name"),
                "Amount": opp.get("Amount") or 0,
                "CurrentStage": opp.get("StageName"),
                "CurrentOwnerId": opp.get("OwnerId"),
                "CurrentOwnerName": opp_owner.get("Name"),
                "OldValue": old_raw,
                "NewValue": new_raw,
                "OldOwnerName": user_names.get(old_raw, old_raw),
                "NewOwnerName": user_names.get(new_raw, new_raw),
                "ChangedById": r.get("CreatedById"),
                "ChangedByName": created_by.get("Name"),
                "CreatedDate": r.get("CreatedDate"),
            })

        cache.set(cache_key, formatted, CACHE_TTL_STAGE_HISTORY)
        return formatted

    except Exception as e:
        logger.warning(f"OpportunityFieldHistory ownership query failed: {e}")
        raise sf_http_error(e, "ownership history")


# ---------------------------------------------------------------------------
# Bulk update
# ---------------------------------------------------------------------------

@router.put("/api/salesforce/opportunities/bulk-update")
async def bulk_update_opportunities(
    body: dict,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("bulk_update_opportunities")),
    db=Depends(get_db),
):
    """Bulk update multiple Salesforce opportunities at once."""
    try:
        salesforce = client.salesforce
        opp_ids = body.get("opportunity_ids", [])
        updates = body.get("updates", {})

        if not opp_ids or not updates:
            raise HTTPException(status_code=400, detail="Missing opportunity_ids or updates")

        success_count = 0
        failed_ids = []

        for opp_id in opp_ids:
            try:
                validate_salesforce_id(opp_id, "opportunity_id")
                await enforce_opportunity_mutation(salesforce, opp_id, user, db, updates)
                if not await salesforce.update_record("Opportunity", opp_id, updates):
                    raise HTTPException(502, "Salesforce did not confirm the update")
                success_count += 1
            except Exception as e:
                logger.warning(f"Failed to update opportunity {opp_id}: {e}")
                failed_ids.append(opp_id)

        cache.invalidate_prefix("opps:")
        cache.invalidate_prefix("stage_history")
        cache.invalidate_prefix("accounts:")

        return {
            "success": True,
            "total": len(opp_ids),
            "success_count": success_count,
            "failed_count": len(failed_ids),
            "failed_ids": failed_ids,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in bulk_update_opportunities")
        raise sf_http_error(e, "opportunity update")


# ---------------------------------------------------------------------------
# Stage validation (shared logic used by both endpoint and update-stage)
# ---------------------------------------------------------------------------

async def _validate_stage_change_logic(
    opp_id: str,
    new_stage: str,
    salesforce,
) -> Dict[str, Any]:
    """Core validation: checks payment schedule before allowing 'Collecting / In Effect'."""
    if new_stage != OpportunityStage.COLLECTING.value:
        return {"success": True, "can_proceed": True}

    validate_salesforce_id(opp_id, "opportunity_id")
    safe_id = escape_soql_string(opp_id)

    # Get opportunity
    opp_result = await salesforce.query(
        f"SELECT Id, Name, Amount FROM Opportunity WHERE Id = '{safe_id}'"
    )
    if not opp_result.get("records"):
        raise HTTPException(status_code=404, detail="Opportunity not found")

    opp = opp_result["records"][0]
    opp_amount = float(opp.get("Amount") or 0)

    # Check for payment schedule
    payment_result = await salesforce.query(
        f"""SELECT Id, npe01__Payment_Amount__c, npe01__Scheduled_Date__c
        FROM npe01__OppPayment__c
        WHERE npe01__Opportunity__c = '{safe_id}'
        ORDER BY npe01__Scheduled_Date__c ASC"""
    )
    payments = payment_result.get("records", [])

    if not payments:
        return {
            "success": False,
            "can_proceed": False,
            "error": "Payment schedule required",
            "message": (
                f"Cannot move to '{OpportunityStage.COLLECTING.value}' without a payment schedule.\n\n"
                f"Please create a payment schedule for this ${opp_amount:,.0f} opportunity first."
            ),
            "action_required": "create_payment_schedule",
        }

    payment_total = sum(float(p.get("npe01__Payment_Amount__c", 0)) for p in payments)

    if abs(payment_total - opp_amount) > 0.01:
        return {
            "success": False,
            "can_proceed": False,
            "error": "Payment schedule total doesn't match opportunity amount",
            "message": (
                f"Payment schedule total (${payment_total:,.0f}) doesn't match "
                f"opportunity amount (${opp_amount:,.0f}).\n\n"
                "Please adjust the payment schedule in Salesforce."
            ),
            "opportunity_amount": opp_amount,
            "payment_total": payment_total,
            "difference": payment_total - opp_amount,
            "action_required": "fix_payment_schedule",
        }

    return {
        "success": True,
        "can_proceed": True,
        "message": f"Payment schedule validated: {len(payments)} payment(s) totaling ${payment_total:,.0f}",
        "payment_count": len(payments),
        "payment_total": payment_total,
    }


@router.post("/api/opportunities/validate-stage-change")
async def validate_stage_change(
    request: dict,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Validate that opportunity can move to 'Collecting / In Effect'."""
    try:
        salesforce = client.salesforce
        opp_id = request.get("opportunity_id")
        new_stage = request.get("new_stage")
        return await _validate_stage_change_logic(opp_id, new_stage, salesforce)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in validate_stage_change")
        raise sf_http_error(e, "stage validation")


# ---------------------------------------------------------------------------
# Stage update (with validation)
# ---------------------------------------------------------------------------

@router.post("/api/opportunities/update-stage")
async def update_opportunity_stage(
    request: dict,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    conn=Depends(get_db),
    user=Depends(check_permission("edit_own_opportunities")),
):
    """Update opportunity stage with validation.

    Side effect: when an opp transitions into a closed/active-grant
    Philanthropy stage, idempotently ensure a `bedrock.award` row exists.
    Failures here are logged but do not fail the stage update — the SF
    write has already succeeded.
    """
    # TODO: Phase 3 — use per-user SF tokens when available for write attribution
    try:
        salesforce = client.salesforce
        opp_id = request.get("opportunity_id")
        new_stage = request.get("new_stage")

        validate_salesforce_id(opp_id, "opportunity_id")

        await enforce_opportunity_mutation(salesforce, opp_id, user, conn)

        # Validate stage change
        validation_result = await _validate_stage_change_logic(opp_id, new_stage, salesforce)
        if not validation_result.get("can_proceed"):
            raise HTTPException(status_code=400, detail=validation_result)

        # Update stage
        if not await salesforce.update_record("Opportunity", opp_id, {"StageName": new_stage}):
            raise HTTPException(502, "Salesforce did not confirm the update")
        cache.invalidate_prefix("opps:")
        cache.invalidate_prefix("stage_history")
        # Account status (Prospect/Pursuing/Stewarding) is derived
        # from the opp's stage — bust the accounts cache so the new
        # status is visible without waiting for the 10-min TTL.
        cache.invalidate_prefix("accounts:")

        # Side effect: auto-create Award row for eligible opps that have
        # reached an award-eligible stage. Idempotent. Best-effort —
        # never fails the SF write.
        award_created = False
        award_id: Optional[str] = None
        try:
            award = await ensure_award_for_opp(
                conn, salesforce, opp_id,
                stage_name_hint=new_stage,
            )
            award_created = award is not None
            if award is not None:
                # Return the award id so the client can route the user
                # into the post-stage award setup workflow.
                award_id = str(award.get("id")) if isinstance(award, dict) else str(award.id)
        except Exception:
            logger.exception(
                "awards.ensure_for_opp failed for opp=%s after stage update; "
                "stage write succeeded, award lifecycle row may be missing.",
                opp_id,
            )

        return {
            "success": True,
            "message": f"Opportunity stage updated to '{new_stage}'",
            "stage": new_stage,
            "validation": validation_result,
            "award_created": award_created,
            "award_id": award_id,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in update_opportunity_stage")
        raise sf_http_error(e, "opportunity stage update")


# ---------------------------------------------------------------------------
# Opportunity → Projects reverse lookup
# ---------------------------------------------------------------------------

@router.get("/api/opportunities/{opportunity_id}/projects")
async def get_opportunity_projects(
    opportunity_id: str,
    user=Depends(check_permission("view_projects")),
    conn=Depends(get_db),
):
    """Return all projects linked to a given Opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    rows = await conn.fetch(
        """
        SELECT po.id, po.project_id, po.role, po.created_at,
               p.name AS project_name, p.status AS project_status
        FROM bedrock.project_opportunity po
        JOIN bedrock.project p ON p.id = po.project_id AND p.deleted_at IS NULL
        WHERE po.opportunity_id = $1
        ORDER BY po.created_at
        """,
        opportunity_id,
    )
    return {"success": True, "data": [
        {
            "id": str(r["id"]),
            "project_id": str(r["project_id"]),
            "role": r["role"],
            "project_name": r["project_name"],
            "project_status": r["project_status"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in rows
    ]}
