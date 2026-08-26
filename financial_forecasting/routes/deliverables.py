"""Salesforce deliverables (npsp__Grant_Deadline__c) — CRUD over SF REST."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from dependencies import require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from security import validate_salesforce_id, escape_soql_string
from sf_errors import sf_http_error

logger = logging.getLogger(__name__)

router = APIRouter(tags=["deliverables"])

_SOQL_FIELDS = """
    Id, Name, npsp__Opportunity__c,
    npsp__Grant_Deadline_Due_Date__c,
    npsp__Grant_Deliverable_Close_Date__c,
    npsp__Grant_Deliverable_Requirements__c,
    npsp__Type__c
"""

_SOQL_FIELDS_WITH_OPP = """
    Id, Name, npsp__Opportunity__c, npsp__Opportunity__r.Name,
    npsp__Grant_Deadline_Due_Date__c,
    npsp__Grant_Deliverable_Close_Date__c,
    npsp__Grant_Deliverable_Requirements__c,
    npsp__Type__c
"""


class DeliverableCreate(BaseModel):
    name: str
    type: Optional[str] = None
    due_date: Optional[str] = None
    requirements: Optional[str] = None
    close_date: Optional[str] = None


class DeliverablePatch(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    due_date: Optional[str] = None
    requirements: Optional[str] = None
    close_date: Optional[str] = None


def _to_sf(data: dict) -> dict:
    """Map camelCase/snake_case frontend fields to SF API names."""
    mapping = {
        "name": "Name",
        "type": "npsp__Type__c",
        "due_date": "npsp__Grant_Deadline_Due_Date__c",
        "requirements": "npsp__Grant_Deliverable_Requirements__c",
        "close_date": "npsp__Grant_Deliverable_Close_Date__c",
    }
    return {mapping[k]: v for k, v in data.items() if k in mapping and v is not None}


def _format_record(r: dict) -> dict:
    return {
        "id": r["Id"],
        "name": r.get("Name"),
        "opportunity_id": r.get("npsp__Opportunity__c"),
        "type": r.get("npsp__Type__c"),
        "due_date": r.get("npsp__Grant_Deadline_Due_Date__c"),
        "close_date": r.get("npsp__Grant_Deliverable_Close_Date__c"),
        "requirements": r.get("npsp__Grant_Deliverable_Requirements__c"),
    }


def _format_record_with_opp(r: dict) -> dict:
    opp_rel = r.get("npsp__Opportunity__r") or {}
    return {
        **_format_record(r),
        "opportunity_name": opp_rel.get("Name"),
    }


@router.get("/api/opportunities/{opp_id}/deliverables")
async def list_deliverables(
    opp_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    validate_salesforce_id(opp_id, "opp_id")
    safe_id = escape_soql_string(opp_id)
    try:
        result = await client.salesforce.query_all(
            f"""
            SELECT {_SOQL_FIELDS}
            FROM npsp__Grant_Deadline__c
            WHERE npsp__Opportunity__c = '{safe_id}'
            ORDER BY npsp__Grant_Deadline_Due_Date__c ASC NULLS LAST
            """
        )
        return [_format_record(r) for r in result.get("records", [])]
    except Exception as e:
        raise sf_http_error(e, "deliverables")


@router.post("/api/opportunities/{opp_id}/deliverables", status_code=201)
async def create_deliverable(
    opp_id: str,
    body: DeliverableCreate,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    validate_salesforce_id(opp_id, "opp_id")
    sf_data = _to_sf(body.model_dump(exclude_none=False))
    sf_data["npsp__Opportunity__c"] = opp_id
    if "Name" not in sf_data:
        sf_data["Name"] = body.name or "New deliverable"
    try:
        result = await client.salesforce.create_record("npsp__Grant_Deadline__c", sf_data)
        new_id = result.get("id")
        # Fetch the full record so the client gets all fields back
        fetch = await client.salesforce.query(
            f"SELECT {_SOQL_FIELDS} FROM npsp__Grant_Deadline__c WHERE Id = '{new_id}'"
        )
        records = fetch.get("records", [])
        if not records:
            raise HTTPException(status_code=500, detail="Created but could not fetch deliverable")
        return _format_record(records[0])
    except HTTPException:
        raise
    except Exception as e:
        raise sf_http_error(e, "deliverable")


@router.patch("/api/deliverables/{deliverable_id}")
async def update_deliverable(
    deliverable_id: str,
    body: DeliverablePatch,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    validate_salesforce_id(deliverable_id, "deliverable_id")
    # exclude_unset=True ensures only fields actually sent in the request body
    # are written to SF — absent fields keep their current SF values.
    set_fields = body.model_dump(exclude_unset=True)
    updates = _to_sf(set_fields)
    # Preserve explicit None values (user clearing a field) for fields that
    # _to_sf filtered out because v is None.
    sf_key_map = {
        "type": "npsp__Type__c",
        "due_date": "npsp__Grant_Deadline_Due_Date__c",
        "requirements": "npsp__Grant_Deliverable_Requirements__c",
        "close_date": "npsp__Grant_Deliverable_Close_Date__c",
    }
    for k, v in set_fields.items():
        if v is None and k in sf_key_map:
            updates[sf_key_map[k]] = None
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    try:
        await client.salesforce.update_record("npsp__Grant_Deadline__c", deliverable_id, updates)
        fetch = await client.salesforce.query(
            f"SELECT {_SOQL_FIELDS} FROM npsp__Grant_Deadline__c WHERE Id = '{deliverable_id}'"
        )
        records = fetch.get("records", [])
        if not records:
            raise HTTPException(status_code=404, detail="Deliverable not found after update")
        return _format_record(records[0])
    except HTTPException:
        raise
    except Exception as e:
        raise sf_http_error(e, "deliverable")


@router.delete("/api/deliverables/{deliverable_id}", status_code=204)
async def delete_deliverable(
    deliverable_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    validate_salesforce_id(deliverable_id, "deliverable_id")
    try:
        await client.salesforce.delete_record("npsp__Grant_Deadline__c", deliverable_id)
    except Exception as e:
        raise sf_http_error(e, "deliverable")


@router.get("/api/accounts/{account_id}/deliverables/upcoming")
async def account_upcoming_deliverables(
    account_id: str,
    days: int = Query(default=30, ge=1, le=365),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Deliverables on open opps for this account that are due within `days` days."""
    validate_salesforce_id(account_id, "account_id")
    safe_id = escape_soql_string(account_id)
    cutoff = (date.today() + timedelta(days=days)).isoformat()
    try:
        result = await client.salesforce.query_all(
            f"""
            SELECT {_SOQL_FIELDS_WITH_OPP}
            FROM npsp__Grant_Deadline__c
            WHERE npsp__Opportunity__r.AccountId = '{safe_id}'
              AND (npsp__Opportunity__r.IsClosed = false OR npsp__Opportunity__r.IsWon = true)
              AND npsp__Grant_Deadline_Due_Date__c >= TODAY
              AND npsp__Grant_Deadline_Due_Date__c <= {cutoff}
              AND npsp__Grant_Deliverable_Close_Date__c = null
            ORDER BY npsp__Grant_Deadline_Due_Date__c ASC
            """
        )
        return [_format_record_with_opp(r) for r in result.get("records", [])]
    except Exception as e:
        raise sf_http_error(e, "deliverables")


@router.get("/api/portfolio/deliverables/upcoming")
async def portfolio_upcoming_deliverables(
    sf_user_id: str = Query(...),
    days: int = Query(default=30, ge=1, le=365),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Deliverables due within `days` days for opps owned by `sf_user_id` or
    under accounts owned by `sf_user_id`."""
    safe_uid = escape_soql_string(sf_user_id)
    cutoff = (date.today() + timedelta(days=days)).isoformat()
    try:
        result = await client.salesforce.query_all(
            f"""
            SELECT {_SOQL_FIELDS_WITH_OPP}
            FROM npsp__Grant_Deadline__c
            WHERE (npsp__Opportunity__r.OwnerId = '{safe_uid}'
                   OR npsp__Opportunity__r.Account.OwnerId = '{safe_uid}')
              AND (npsp__Opportunity__r.IsClosed = false OR npsp__Opportunity__r.IsWon = true)
              AND npsp__Grant_Deadline_Due_Date__c >= TODAY
              AND npsp__Grant_Deadline_Due_Date__c <= {cutoff}
              AND npsp__Grant_Deliverable_Close_Date__c = null
            ORDER BY npsp__Grant_Deadline_Due_Date__c ASC
            """
        )
        return [_format_record_with_opp(r) for r in result.get("records", [])]
    except Exception as e:
        raise sf_http_error(e, "deliverables")
