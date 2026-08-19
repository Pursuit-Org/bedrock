"""Activities API router — CRUD, search, sync, match-context, AI insights.

M10: Activities Foundation (Backend Only). Syncs SF Tasks + Events into
bedrock.activity table with full-text search, soft delete, and AI insights.
"""

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query

from auth import require_auth
from db import get_db
from dependencies import _sync_lock, get_data_sync_service, get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from data_sync import DataSyncService
from models import (
    Activity, ActivityCreate, ActivityInsightsResponse, ActivityUpdate,
    ApiResponse,
)
from routes.permissions import check_permission
from security import escape_soql_string
from sf_errors import sf_http_error

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/activities", tags=["activities"])

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")


# ---------------------------------------------------------------------------
# Cross-source deduplication
# ---------------------------------------------------------------------------
# Pursuit's RMs sometimes log an email as a SF Task AND the gmail-sync
# pipeline picks up the same email. Result: two rows in bedrock.activity
# describing the same touchpoint. Audit showed 12 such groups today.
#
# Soft dedup at read time: a CTE windows email rows by
# (account_id, DATE(activity_date), LOWER(subject), email_from). Within
# each window we keep one row, preferring `gmail-sync` (has full body +
# message headers) over `salesforce` (logged metadata only) over
# everything else.
#
# Non-email rows partition by their own id, so they always survive
# (window count = 1 per row). This keeps meetings, calls, notes etc.
# untouched — the dupe pattern only shows up for emails.
#
# Inserted via _DEDUP_CTE_TEMPLATE.format(where=...) — callers append
# their own WHERE clause.
_DEDUP_CTE_TEMPLATE = """
WITH ranked AS (
    SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY
                CASE WHEN type = 'email' AND account_id IS NOT NULL
                     THEN account_id ELSE id::text END,
                CASE WHEN type = 'email' AND account_id IS NOT NULL
                     THEN DATE(activity_date) ELSE NULL END,
                CASE WHEN type = 'email' AND account_id IS NOT NULL
                     THEN LOWER(subject) ELSE NULL END,
                CASE WHEN type = 'email' AND account_id IS NOT NULL
                     THEN LOWER(COALESCE(email_from, '')) ELSE NULL END
            ORDER BY
                CASE source
                    WHEN 'gmail-sync' THEN 1
                    WHEN 'salesforce' THEN 2
                    ELSE 3
                END,
                activity_date DESC
        ) AS _dedup_rn
    FROM bedrock.activity
    WHERE {where}
)
"""


# ---------------------------------------------------------------------------
# Helper: convert asyncpg Record to Activity-compatible dict
# ---------------------------------------------------------------------------

def _row_to_dict(row) -> dict:
    """Convert an asyncpg Record to a JSON-serializable dict."""
    d = dict(row)
    # Convert UUID to str
    if "id" in d and d["id"] is not None:
        d["id"] = str(d["id"])
    if "project_task_id" in d and d["project_task_id"] is not None:
        d["project_task_id"] = str(d["project_task_id"])
    # Convert datetime to ISO string for JSON
    for key in ("activity_date", "sf_last_modified", "synced_at", "created_at", "updated_at"):
        if key in d and d[key] is not None:
            d[key] = d[key].isoformat()
    # Strip internal fields not in the response model
    d.pop("search_vector", None)
    d.pop("deleted_at", None)
    # Cap full body to prevent large payloads on account-level feeds (matches jobs.py pattern)
    if d.get("email_body_text") and len(d["email_body_text"]) > 4000:
        d["email_body_text"] = d["email_body_text"][:4000]
    return d


# ---------------------------------------------------------------------------
# 1. POST /sync/count — SF Task + Event counts (admin)
# ---------------------------------------------------------------------------

@router.post("/sync/count")
async def activity_sync_count(
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("trigger_data_sync")),
):
    """Count SF Tasks + Events to estimate sync volume."""
    try:
        salesforce = client.salesforce
        task_result = await salesforce.query("SELECT COUNT() FROM Task")
        event_result = await salesforce.query("SELECT COUNT() FROM Event")
        task_count = task_result.get("totalSize", 0)
        event_count = event_result.get("totalSize", 0)
        return ApiResponse(
            success=True,
            data={"task_count": task_count, "event_count": event_count, "total": task_count + event_count},
        )
    except Exception as e:
        logger.error(f"Error counting SF activities: {e}")
        raise sf_http_error(e, "activity count")


# ---------------------------------------------------------------------------
# 2. POST /sync/trigger — Activity-only sync (admin, uses shared lock)
# ---------------------------------------------------------------------------

@router.post("/sync/trigger")
async def activity_sync_trigger(
    background_tasks: BackgroundTasks,
    sync_service: DataSyncService = Depends(get_data_sync_service),
    user=Depends(check_permission("trigger_data_sync")),
):
    """Trigger activity-only sync from Salesforce."""
    if _sync_lock.locked():
        raise HTTPException(status_code=409, detail="Sync already in progress")

    async def _locked_activity_sync():
        async with _sync_lock:
            await sync_service.sync_activities()

    background_tasks.add_task(_locked_activity_sync)
    return ApiResponse(
        success=True,
        data={"message": "Activity sync triggered"},
        meta={"triggered_by": user["user_id"]},
    )


# ---------------------------------------------------------------------------
# 3. GET /sync/status — Sync health
# ---------------------------------------------------------------------------

@router.get("/sync/status")
async def activity_sync_status(
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Activity sync health: counts, last_sync, pending."""
    try:
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.activity WHERE deleted_at IS NULL"
        )
        last_sync = await conn.fetchval(
            "SELECT MAX(synced_at) FROM bedrock.activity WHERE deleted_at IS NULL"
        )
        pending = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.activity WHERE sf_sync_status = 'pending' AND deleted_at IS NULL"
        )
        sf_count = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.activity WHERE source = 'salesforce' AND deleted_at IS NULL"
        )
        return ApiResponse(
            success=True,
            data={
                "total_activities": total,
                "sf_synced": sf_count,
                "last_sync": last_sync.isoformat() if last_sync else None,
                "pending_sync": pending,
                "sync_in_progress": _sync_lock.locked(),
            },
        )
    except Exception as e:
        logger.error(f"Error fetching sync status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 4. GET /search — Full-text search
# ---------------------------------------------------------------------------

@router.get("/search")
async def activity_search(
    q: str = Query(..., min_length=1, max_length=500),
    opportunity_id: Optional[str] = None,
    account_id: Optional[str] = None,
    contact_id: Optional[str] = None,
    months: int = Query(12, ge=1, le=120),
    limit: int = Query(20, ge=1, le=100),
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Full-text search on activities. Scoped by entity or global."""
    try:
        # Build query — plainto_tsquery is safe against injection
        where_parts = [
            "deleted_at IS NULL",
            "search_vector @@ plainto_tsquery('english', $1)",
            f"activity_date > now() - interval '{int(months)} months'",
        ]
        params: list = [q]
        idx = 2  # next param index

        if opportunity_id:
            where_parts.append(f"opportunity_id = ${idx}")
            params.append(opportunity_id)
            idx += 1
        if account_id:
            where_parts.append(f"account_id = ${idx}")
            params.append(account_id)
            idx += 1
        if contact_id:
            where_parts.append(f"${idx} = ANY(contact_ids)")
            params.append(contact_id)
            idx += 1

        where_clause = " AND ".join(where_parts)
        rows = await conn.fetch(
            f"""
            SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
            FROM bedrock.activity
            WHERE {where_clause}
            ORDER BY rank DESC, activity_date DESC
            LIMIT ${idx}
            """,
            *params, limit,
        )
        return [_row_to_dict(r) for r in rows]

    except Exception as e:
        logger.error(f"Activity search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 5. GET /match-context — Smart Contact matching for extension
# ---------------------------------------------------------------------------

@router.get("/match-context")
async def activity_match_context(
    email: Optional[str] = None,
    name: Optional[str] = None,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Match email/name to Contacts and their Opportunities (3-tier matching)."""
    if not email and not name:
        raise HTTPException(status_code=400, detail="Provide email or name")

    salesforce = client.salesforce
    contacts = []
    opportunities = []
    match_tier = 0

    try:
        # Tier 1: Exact email match
        if email:
            safe_email = escape_soql_string(email)
            contact_result = await salesforce.query(
                f"SELECT Id, AccountId, Name, Email, Title FROM Contact WHERE Email = '{safe_email}' LIMIT 5"
            )
            tier1_contacts = contact_result.get("records", [])

            if tier1_contacts:
                match_tier = 1
                for c in tier1_contacts:
                    contacts.append({
                        "id": c["Id"], "name": c.get("Name"), "email": c.get("Email"),
                        "title": c.get("Title"), "confidence": "high",
                    })
                    # Get open opportunities for this contact's account
                    if c.get("AccountId"):
                        opp_result = await salesforce.query(
                            f"SELECT Id, Name, StageName, Amount FROM Opportunity "
                            f"WHERE AccountId = '{c['AccountId']}' AND IsClosed = false "
                            f"ORDER BY Amount DESC NULLS LAST LIMIT 10"
                        )
                        for o in opp_result.get("records", []):
                            opportunities.append({
                                "id": o["Id"], "name": o.get("Name"),
                                "stage": o.get("StageName"), "amount": o.get("Amount"),
                            })

        # Tier 2: Domain match (if no Tier 1 results)
        if not contacts and email and "@" in email:
            domain = email.split("@")[1].lower()
            # Skip common free email domains
            if domain not in ("gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com"):
                safe_domain = escape_soql_string(domain)
                account_result = await salesforce.query(
                    f"SELECT Id, Name, Website FROM Account WHERE Website LIKE '%{safe_domain}%' LIMIT 5"
                )
                tier2_accounts = account_result.get("records", [])

                if tier2_accounts:
                    match_tier = 2
                    for acct in tier2_accounts:
                        # Get contacts for this account. Org accounts link
                        # people via npe5__Affiliation__c, not Contact.AccountId
                        # (the Household) — resolve affiliated ids first, then
                        # OR them in (SOQL forbids semi-join + OR).
                        safe_acct_id = escape_soql_string(acct["Id"])
                        contact_where = f"AccountId = '{safe_acct_id}'"
                        try:
                            aff = await salesforce.query(
                                f"SELECT npe5__Contact__c FROM npe5__Affiliation__c "
                                f"WHERE npe5__Organization__c = '{safe_acct_id}' AND npe5__Contact__c != null"
                            )
                            aff_ids = [r["npe5__Contact__c"] for r in aff.get("records", []) if r.get("npe5__Contact__c")]
                            if aff_ids:
                                id_list = ", ".join(f"'{i}'" for i in aff_ids[:2000])
                                contact_where = f"(AccountId = '{safe_acct_id}' OR Id IN ({id_list}))"
                        except Exception:
                            pass
                        acct_contacts = await salesforce.query(
                            f"SELECT Id, Name, Email, Title FROM Contact "
                            f"WHERE {contact_where} LIMIT 20"
                        )
                        for c in acct_contacts.get("records", []):
                            # Rank by name similarity if name provided
                            confidence = "medium"
                            if name:
                                ratio = SequenceMatcher(None, (name or "").lower(), (c.get("Name") or "").lower()).ratio()
                                confidence = "high" if ratio > 0.8 else "medium" if ratio > 0.5 else "low"
                            contacts.append({
                                "id": c["Id"], "name": c.get("Name"), "email": c.get("Email"),
                                "title": c.get("Title"), "confidence": confidence,
                            })
                        # Get open opportunities for this account
                        opp_result = await salesforce.query(
                            f"SELECT Id, Name, StageName, Amount FROM Opportunity "
                            f"WHERE AccountId = '{acct['Id']}' AND IsClosed = false "
                            f"ORDER BY Amount DESC NULLS LAST LIMIT 10"
                        )
                        for o in opp_result.get("records", []):
                            opportunities.append({
                                "id": o["Id"], "name": o.get("Name"),
                                "stage": o.get("StageName"), "amount": o.get("Amount"),
                            })

        # Tier 3: Fuzzy name match (if still no results)
        if not contacts and name:
            safe_name = escape_soql_string(name)
            name_result = await salesforce.query(
                f"SELECT Id, Name, Email, Title, AccountId FROM Contact "
                f"WHERE Name LIKE '%{safe_name}%' LIMIT 20"
            )
            tier3_contacts = name_result.get("records", [])

            if tier3_contacts:
                match_tier = 3
                for c in tier3_contacts:
                    ratio = SequenceMatcher(None, name.lower(), (c.get("Name") or "").lower()).ratio()
                    contacts.append({
                        "id": c["Id"], "name": c.get("Name"), "email": c.get("Email"),
                        "title": c.get("Title"), "confidence": "possible",
                        "similarity": round(ratio, 2),
                    })
                # Sort by similarity descending
                contacts.sort(key=lambda x: x.get("similarity", 0), reverse=True)

                # Get opportunities for best match
                if contacts and tier3_contacts:
                    best = tier3_contacts[0]
                    if best.get("AccountId"):
                        opp_result = await salesforce.query(
                            f"SELECT Id, Name, StageName, Amount FROM Opportunity "
                            f"WHERE AccountId = '{best['AccountId']}' AND IsClosed = false "
                            f"ORDER BY Amount DESC NULLS LAST LIMIT 10"
                        )
                        for o in opp_result.get("records", []):
                            opportunities.append({
                                "id": o["Id"], "name": o.get("Name"),
                                "stage": o.get("StageName"), "amount": o.get("Amount"),
                            })

        # Deduplicate opportunities by ID
        seen_opp_ids = set()
        unique_opps = []
        for o in opportunities:
            if o["id"] not in seen_opp_ids:
                seen_opp_ids.add(o["id"])
                unique_opps.append(o)

        return ApiResponse(
            success=True,
            data={
                "contacts": contacts,
                "opportunities": unique_opps,
                "match_tier": match_tier,
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Match-context error: {e}")
        raise sf_http_error(e, "match lookup")


# ---------------------------------------------------------------------------
# 6. POST /insights — AI insights with structured output
# ---------------------------------------------------------------------------

@router.post("/insights")
async def activity_insights(
    opportunity_id: Optional[str] = None,
    account_id: Optional[str] = None,
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Generate AI insights from activity history for an opportunity or account.
    If both provided, opportunity_id takes priority (more specific scope)."""
    if not opportunity_id and not account_id:
        raise HTTPException(status_code=400, detail="Provide opportunity_id or account_id")

    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="AI insights not configured (missing ANTHROPIC_API_KEY)")

    try:
        # Fetch activities from local DB
        if opportunity_id:
            rows = await conn.fetch(
                "SELECT type, subject, description, activity_date, source, email_snippet, "
                "meeting_duration_minutes, meeting_attendees "
                "FROM bedrock.activity WHERE opportunity_id = $1 AND deleted_at IS NULL "
                "ORDER BY activity_date DESC LIMIT 50",
                opportunity_id,
            )
        else:
            rows = await conn.fetch(
                "SELECT type, subject, description, activity_date, source, email_snippet, "
                "meeting_duration_minutes, meeting_attendees "
                "FROM bedrock.activity WHERE account_id = $1 AND deleted_at IS NULL "
                "ORDER BY activity_date DESC LIMIT 50",
                account_id,
            )

        if not rows:
            return ActivityInsightsResponse(
                summary="No activities found for this entity.",
                key_findings=[],
                action_items=["Start logging activities to enable AI insights."],
                momentum=None,
                generated_at=datetime.now(timezone.utc).isoformat(),
                confidence="none",
            )

        # Build prompt with activity summary
        activities_text = []
        for r in rows:
            date_str = r["activity_date"].strftime("%Y-%m-%d") if r["activity_date"] else "?"
            snippet = r.get("email_snippet") or r.get("description") or ""
            if len(snippet) > 200:
                snippet = snippet[:200] + "..."
            activities_text.append(f"- [{r['type']}] {date_str}: {r['subject']} — {snippet}")

        prompt = f"""You are an activity analyst for a nonprofit fundraising team.

ACTIVITY HISTORY ({len(rows)} most recent activities):
{chr(10).join(activities_text)}

Analyze this activity history and return a JSON object with these fields:
- "summary": 2-3 sentence overview of the relationship/engagement
- "key_findings": array of 3-5 specific observations
- "action_items": array of 2-3 recommended next steps
- "momentum": one of "increasing", "stable", "declining", "new"

Return ONLY the JSON object, no other text."""

        import anthropic
        ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = ai_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw_text = response.content[0].text.strip()

        # Parse structured response with graceful degradation
        try:
            parsed = json.loads(raw_text)
            return ActivityInsightsResponse(
                summary=parsed.get("summary", raw_text),
                key_findings=parsed.get("key_findings", []),
                action_items=parsed.get("action_items", []),
                momentum=parsed.get("momentum"),
                generated_at=datetime.now(timezone.utc).isoformat(),
                confidence="structured",
            )
        except json.JSONDecodeError:
            return ActivityInsightsResponse(
                summary=raw_text,
                key_findings=[],
                action_items=[],
                momentum=None,
                generated_at=datetime.now(timezone.utc).isoformat(),
                confidence="raw",
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Activity insights error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 7a. GET /account/{account_id}/full — All activities for an account plus
#     its related opportunities and contacts, enriched with context.
# ---------------------------------------------------------------------------

@router.get("/account/{account_id}/full")
async def list_account_activities_full(
    account_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Activities where account_id = X OR opportunity belongs to X OR a
    contact belongs to X. Each row is enriched with _context_type
    (account | opportunity | contact) and _context_name so the frontend
    can label and group the feed without extra round-trips.
    """
    from security import validate_salesforce_id
    validate_salesforce_id(account_id, "account_id")

    opp_map: dict = {}
    contact_map: dict = {}

    try:
        sf = client.salesforce
        opp_res = await sf.query(
            f"SELECT Id, Name FROM Opportunity WHERE AccountId = '{escape_soql_string(account_id)}'"
        )
        opp_map = {r["Id"]: r["Name"] for r in opp_res.get("records", [])}

        # NPSP: org accounts link contacts via npe5__Affiliation__c, not
        # Contact.AccountId (the Household). Resolve affiliated ids first, then
        # match AccountId OR Id IN (...) — SOQL forbids semi-join + OR.
        aff_where = f"AccountId = '{escape_soql_string(account_id)}'"
        try:
            aff = await sf.query(
                f"SELECT npe5__Contact__c FROM npe5__Affiliation__c "
                f"WHERE npe5__Organization__c = '{escape_soql_string(account_id)}' AND npe5__Contact__c != null")
            aff_ids = [r["npe5__Contact__c"] for r in aff.get("records", []) if r.get("npe5__Contact__c")]
            if aff_ids:
                id_list = ", ".join(f"'{i}'" for i in aff_ids[:2000])
                aff_where = f"(AccountId = '{escape_soql_string(account_id)}' OR Id IN ({id_list}))"
        except Exception:
            pass
        contact_res = await sf.query(f"SELECT Id, Name FROM Contact WHERE {aff_where}")
        contact_map = {r["Id"]: r["Name"] for r in contact_res.get("records", [])}
    except Exception as e:
        logger.warning(f"SF lookup for account {account_id} failed, falling back to account-only: {e}")

    opp_ids = list(opp_map.keys())
    contact_ids_list = list(contact_map.keys())

    try:
        # Build OR conditions so one DB round-trip covers all three scopes.
        # Use proven asyncpg patterns: single-value ANY(column) for contacts,
        # single-value = for opps (with ANY(array_param) for bulk).
        or_parts = ["account_id = $1"]
        params: list = [account_id]
        idx = 2

        if opp_ids:
            or_parts.append(f"opportunity_id = ANY(${idx})")
            params.append(opp_ids)
            idx += 1

        # Use "$N = ANY(contact_ids)" per contact — same pattern as the
        # existing GET / endpoint, which is known to work with asyncpg.
        for cid in contact_ids_list:
            or_parts.append(f"${idx} = ANY(contact_ids)")
            params.append(cid)
            idx += 1

        where_clause = f"deleted_at IS NULL AND ({' OR '.join(or_parts)})"
        count_params = list(params)

        cte = _DEDUP_CTE_TEMPLATE.format(where=where_clause)
        rows = await conn.fetch(
            f"""
            {cte}
            SELECT * FROM ranked
            WHERE _dedup_rn = 1
            ORDER BY activity_date DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params, limit, offset,
        )

        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM bedrock.activity WHERE {where_clause}",
            *count_params,
        )
    except Exception as e:
        logger.error(f"DB query failed for account full activities {account_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    enriched = []
    for row in rows:
        d = _row_to_dict(row)
        opp_id = d.get("opportunity_id")
        row_contacts = d.get("contact_ids") or []

        if opp_id and opp_id in opp_map:
            d["_context_type"] = "opportunity"
            d["_context_name"] = opp_map[opp_id]
        elif any(cid in contact_map for cid in row_contacts):
            first_match = next(cid for cid in row_contacts if cid in contact_map)
            d["_context_type"] = "contact"
            d["_context_name"] = contact_map[first_match]
        else:
            d["_context_type"] = "account"
            d["_context_name"] = None

        enriched.append(d)

    return ApiResponse(
        success=True,
        data=enriched,
        meta={"total": total, "limit": limit, "offset": offset},
    )


# ---------------------------------------------------------------------------
# 7. GET / — List activities with filters
# ---------------------------------------------------------------------------

@router.get("/")
async def list_activities(
    opportunity_id: Optional[str] = None,
    account_id: Optional[str] = None,
    contact_id: Optional[str] = None,
    owner_email: Optional[str] = None,
    owner_id: Optional[str] = None,
    type: Optional[str] = None,
    source: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """List activities with optional filters and pagination."""
    try:
        where_parts = ["deleted_at IS NULL"]
        params: list = []
        idx = 1

        if opportunity_id:
            where_parts.append(f"opportunity_id = ${idx}")
            params.append(opportunity_id)
            idx += 1
        if account_id:
            where_parts.append(f"account_id = ${idx}")
            params.append(account_id)
            idx += 1
        if contact_id:
            where_parts.append(f"${idx} = ANY(contact_ids)")
            params.append(contact_id)
            idx += 1
        if owner_id:
            where_parts.append(f"owner_id = ${idx}")
            params.append(owner_id)
            idx += 1
        if type:
            where_parts.append(f"type = ${idx}")
            params.append(type)
            idx += 1
        if source:
            where_parts.append(f"source = ${idx}")
            params.append(source)
            idx += 1
        if start_date:
            where_parts.append(f"activity_date >= ${idx}::timestamptz")
            params.append(start_date)
            idx += 1
        if end_date:
            where_parts.append(f"activity_date <= ${idx}::timestamptz")
            params.append(end_date)
            idx += 1

        where_clause = " AND ".join(where_parts)

        cte = _DEDUP_CTE_TEMPLATE.format(where=where_clause)
        rows = await conn.fetch(
            f"""
            {cte}
            SELECT * FROM ranked
            WHERE _dedup_rn = 1
            ORDER BY activity_date DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params, limit, offset,
        )

        # Total count must match the deduped result set, not the raw row
        # count — otherwise the frontend pager would show a phantom page
        # for the suppressed dupes.
        total = await conn.fetchval(
            f"""
            {cte}
            SELECT COUNT(*) FROM ranked WHERE _dedup_rn = 1
            """,
            *params,
        )

        return ApiResponse(
            success=True,
            data=[_row_to_dict(r) for r in rows],
            meta={"total": total, "limit": limit, "offset": offset},
        )

    except Exception as e:
        logger.error(f"Error listing activities: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 8. POST / — Create activity (local INSERT only; SF write-through in M15)
# ---------------------------------------------------------------------------

@router.post("/")
async def create_activity(
    body: ActivityCreate,
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Create a new activity. Local DB insert only (SF write-through deferred to M15)."""
    try:
        # Convert project_task_id to UUID if provided
        ptid = uuid.UUID(body.project_task_id) if body.project_task_id else None

        row = await conn.fetchrow(
            """
            INSERT INTO bedrock.activity (
                type, subject, activity_date, source, description, description_html,
                opportunity_id, account_id, contact_ids,
                project_task_id, sf_task_id,
                source_ref, source_thread_id,
                email_from, email_to, email_cc, email_snippet,
                meeting_duration_minutes, meeting_attendees, meeting_location,
                logged_by, owner_id
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9,
                $10, $11,
                $12, $13,
                $14, $15, $16, $17,
                $18, $19, $20,
                $21, $22
            )
            RETURNING *
            """,
            body.type.value, body.subject, body.activity_date, body.source.value,
            body.description, body.description_html,
            body.opportunity_id, body.account_id, body.contact_ids,
            ptid, body.sf_task_id,
            body.source_ref, body.source_thread_id,
            body.email_from, body.email_to, body.email_cc, body.email_snippet,
            body.meeting_duration_minutes,
            body.meeting_attendees,  # asyncpg handles list → JSONB natively
            body.meeting_location,
            body.logged_by or user.get("user_id"), body.owner_id,
        )
        return ApiResponse(success=True, data=_row_to_dict(row))

    except Exception as e:
        logger.error(f"Error creating activity: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 9. GET /{id} — Get single activity
# ---------------------------------------------------------------------------

@router.get("/{activity_id}")
async def get_activity(
    activity_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Get a single activity by UUID."""
    try:
        aid = uuid.UUID(activity_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid activity ID format")

    row = await conn.fetchrow(
        "SELECT * FROM bedrock.activity WHERE id = $1 AND deleted_at IS NULL",
        aid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Activity not found")
    return _row_to_dict(row)


# ---------------------------------------------------------------------------
# 10. PUT /{id} — Update activity
# ---------------------------------------------------------------------------

@router.put("/{activity_id}")
async def update_activity(
    activity_id: str,
    body: ActivityUpdate,
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Update an activity (partial update)."""
    try:
        aid = uuid.UUID(activity_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid activity ID format")

    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Convert enum values to their string form for DB
    if "type" in fields:
        fields["type"] = fields["type"].value if hasattr(fields["type"], "value") else fields["type"]

    # Convert project_task_id to UUID
    if "project_task_id" in fields and fields["project_task_id"] is not None:
        fields["project_task_id"] = uuid.UUID(fields["project_task_id"])

    # meeting_attendees: asyncpg handles list → JSONB natively, no conversion needed

    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields))
    vals = [aid] + list(fields.values())
    result = await conn.execute(
        f"UPDATE bedrock.activity SET {sets} WHERE id = $1 AND deleted_at IS NULL",
        *vals,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Activity not found")
    return ApiResponse(success=True, data={"message": "Activity updated"})


# ---------------------------------------------------------------------------
# 11. DELETE /{id} — Soft delete
# ---------------------------------------------------------------------------

@router.delete("/{activity_id}")
async def delete_activity(
    activity_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Soft-delete an activity (sets deleted_at, never hard deletes)."""
    try:
        aid = uuid.UUID(activity_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid activity ID format")

    result = await conn.execute(
        "UPDATE bedrock.activity SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
        aid,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Activity not found")
    return ApiResponse(success=True, data={"message": "Activity deleted"})
