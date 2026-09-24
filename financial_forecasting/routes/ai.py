"""AI pipeline analysis and automation review endpoints.

Ported from simple_server.py: POST /api/ai/pipeline-analysis, POST /api/automation-review/ingest-pipeline
Extracted from main.py: POST /api/slack/webhook, GET /api/automation-review/pending,
    GET /api/automation-review/all, POST /api/automation-review/{item_id}/approve,
    POST /api/automation-review/{item_id}/reject
"""

import json
import logging
import os
import re
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, HTTPException

from auth import require_auth
from db import get_db
from dependencies import get_mcp_client
from mcp_client import UnifiedMCPClient
from models import ApiResponse
from security import validate_salesforce_id
from sf_errors import sf_http_error
from services.crm_parser import parse_crm_message, get_opp_cache

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ai"])

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
SLACK_PIPELINE_CHANNEL = os.getenv("SLACK_PIPELINE_CHANNEL", "pipeline-updates")

# ---------------------------------------------------------------------------
# Module-level state (production: move to DB)
# ---------------------------------------------------------------------------

_automation_queue: Dict[str, Dict[str, Any]] = {}
_ingested_slack_ts: set = set()

# Strict YYYY-MM-DD. The character class is deliberately narrow: digits and
# hyphen only. That lets us interpolate validated values directly into SOQL
# datetime literals (`CreatedDate >= 2026-01-01T00:00:00Z`) without escaping,
# because no SOQL-breaking character (quote, whitespace, comment, wildcard,
# operator) can pass the regex. Same discipline as validate_salesforce_id.
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_pipeline_time_window(
    payload: Dict[str, Any],
) -> Tuple[int, Optional[str], Optional[str]]:
    """Parse the time-window section of an /api/ai/pipeline-analysis payload.

    Returns (days, start_or_none, end_or_none).
    - If `start`/`end` provided: both returned as validated YYYY-MM-DD strings,
      and `days` is computed as an integer span (inclusive day count) for
      backward-compatible response shape.
    - Otherwise: `days` is the validated int (default 30), start/end are None.

    Raises HTTPException(400) on any validation failure.
    """
    raw_days = payload.get("days")
    raw_start = payload.get("start")
    raw_end = payload.get("end")

    has_days = raw_days is not None
    has_start = raw_start is not None
    has_end = raw_end is not None

    if has_start != has_end:
        raise HTTPException(
            status_code=400, detail="start and end must be provided together"
        )
    if (has_start or has_end) and has_days:
        raise HTTPException(
            status_code=400,
            detail="provide either days or start+end, not both",
        )

    if has_start and has_end:
        if not isinstance(raw_start, str) or not isinstance(raw_end, str):
            raise HTTPException(
                status_code=400, detail="start and end must be YYYY-MM-DD strings"
            )
        if not _ISO_DATE_RE.match(raw_start) or not _ISO_DATE_RE.match(raw_end):
            raise HTTPException(
                status_code=400,
                detail="start and end must match YYYY-MM-DD format",
            )
        try:
            start_dt = datetime.strptime(raw_start, "%Y-%m-%d").replace(
                tzinfo=timezone.utc
            )
            end_dt = datetime.strptime(raw_end, "%Y-%m-%d").replace(
                tzinfo=timezone.utc, hour=23, minute=59, second=59
            )
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="start and end must be valid calendar dates",
            )
        if start_dt > end_dt:
            raise HTTPException(
                status_code=400, detail="start must be on or before end"
            )
        now_utc = datetime.now(timezone.utc)
        if start_dt < now_utc - timedelta(days=365):
            raise HTTPException(
                status_code=400,
                detail="start must be within the last 365 days",
            )
        # Allow end up to end-of-today by permitting one extra day of slack.
        if end_dt > now_utc + timedelta(days=1):
            raise HTTPException(
                status_code=400, detail="end cannot be in the future"
            )
        span_days = (end_dt.date() - start_dt.date()).days + 1
        return span_days, raw_start, raw_end

    days = raw_days if has_days else 30
    if not isinstance(days, int) or isinstance(days, bool) or days < 1 or days > 365:
        raise HTTPException(
            status_code=400, detail="days must be an integer between 1 and 365"
        )
    return days, None, None


# ---------------------------------------------------------------------------
# POST /api/ai/pipeline-analysis
# ---------------------------------------------------------------------------

@router.post("/api/ai/pipeline-analysis")
async def ai_pipeline_analysis(
    payload: Dict[str, Any] = Body(...),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """On-demand AI analysis of pipeline stage changes and funnel health.

    Optional owner_ids list scopes both the snapshot and history queries to
    those Salesforce User IDs so the LLM analysis is per-RM (or per subset).
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI analysis not configured (missing ANTHROPIC_API_KEY)",
        )

    days, start, end = _parse_pipeline_time_window(payload)

    raw_owner_ids = payload.get("owner_ids") or []
    if not isinstance(raw_owner_ids, list):
        raise HTTPException(
            status_code=400, detail="owner_ids must be a list of Salesforce User IDs"
        )
    owner_ids: List[str] = []
    for oid in raw_owner_ids:
        if not isinstance(oid, str):
            raise HTTPException(status_code=400, detail="owner_ids must be strings")
        validate_salesforce_id(oid, "owner_id")
        owner_ids.append(oid)

    owner_filter_clause = ""
    snapshot_owner_clause = ""
    owner_names_lookup: Dict[str, str] = {}
    if owner_ids:
        # IDs already validated to match the strict SF ID regex, so direct
        # interpolation is safe (no string escaping needed).
        id_list = ", ".join(f"'{oid}'" for oid in owner_ids)
        owner_filter_clause = f" AND Opportunity.OwnerId IN ({id_list})"
        snapshot_owner_clause = f" AND OwnerId IN ({id_list})"

    try:
        import anthropic

        salesforce = client.salesforce

        # Resolve owner IDs to display names so the prompt can reference RMs
        if owner_ids:
            try:
                id_list = ", ".join(f"'{oid}'" for oid in owner_ids)
                users_result = await salesforce.query(
                    f"SELECT Id, Name FROM User WHERE Id IN ({id_list})"
                )
                for u in users_result.get("records", []):
                    owner_names_lookup[u["Id"]] = u.get("Name") or u["Id"]
            except Exception as e:
                logger.warning(f"Failed to resolve owner names for analysis: {e}")

        # SOQL date literal: either LAST_N_DAYS:n (preset) or an explicit
        # range (custom). start/end are regex-validated (digits + hyphen
        # only) so direct interpolation is injection-safe — matches the
        # validate_salesforce_id pattern used for owner_filter_clause above.
        if start is not None and end is not None:
            time_clause = (
                f"CreatedDate >= {start}T00:00:00Z "
                f"AND CreatedDate <= {end}T23:59:59Z"
            )
        else:
            time_clause = f"CreatedDate = LAST_N_DAYS:{days}"

        history_query = f"""
        SELECT OpportunityId, Opportunity.Name, Opportunity.Amount,
               Opportunity.StageName, OldValue, NewValue, CreatedDate
        FROM OpportunityFieldHistory
        WHERE Field = 'StageName'
          AND {time_clause}{owner_filter_clause}
        ORDER BY CreatedDate DESC
        """
        history_result = await salesforce.query_all(history_query)
        changes = history_result.get("records", [])

        snapshot_query = f"""
        SELECT StageName, COUNT(Id) cnt, SUM(Amount) total
        FROM Opportunity
        WHERE IsClosed = false{snapshot_owner_clause}
        GROUP BY StageName
        ORDER BY StageName
        """
        snapshot_result = await salesforce.query_all(snapshot_query)
        stage_snapshot = [
            {
                "stage": r["StageName"],
                "count": r["cnt"],
                "totalAmount": r.get("total") or 0,
            }
            for r in snapshot_result.get("records", [])
        ]

        formatted_changes = []
        for r in changes:
            opp = r.get("Opportunity") or {}
            formatted_changes.append(
                {
                    "opportunity": opp.get("Name"),
                    "amount": opp.get("Amount") or 0,
                    "from": r.get("OldValue"),
                    "to": r.get("NewValue"),
                    "date": r.get("CreatedDate"),
                }
            )

        if owner_ids:
            owner_names = [owner_names_lookup.get(oid, oid) for oid in owner_ids]
            scope_line = f"SCOPE: This analysis covers {len(owner_ids)} Relationship Manager(s): {', '.join(owner_names)}."
        else:
            scope_line = "SCOPE: This analysis covers the entire team's pipeline."

        if start is not None and end is not None:
            window_heading = f"STAGE CHANGES FROM {start} TO {end}"
        else:
            window_heading = f"STAGE CHANGES IN THE LAST {days} DAYS"

        prompt = f"""You are a pipeline analyst for a nonprofit fundraising team managing grant opportunities.

{scope_line}

CURRENT PIPELINE SNAPSHOT (open opportunities by stage):
{json.dumps(stage_snapshot, indent=1)}

{window_heading} ({len(formatted_changes)} total):
{json.dumps(formatted_changes[:50], default=str, indent=1)}

Analyze the pipeline health in 3-5 concise bullet points covering:
- Pipeline velocity: Are opportunities moving forward through stages?
- Stagnation risk: Any stages with many opps but little movement?
- Stage conversion: Which transitions are happening most/least?
- Actionable recommendations: What should the team focus on?

Be specific — reference actual stage names, counts, and dollar amounts. Keep each bullet to 1-2 sentences. Use plain text, no markdown formatting."""

        ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = ai_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        analysis_text = response.content[0].text.strip()

        return {
            "analysis": analysis_text,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "changes_count": len(formatted_changes),
            "days": days,
            "start": start,
            "end": end,
            "owner_ids": owner_ids,
            "owner_names": [owner_names_lookup.get(oid, oid) for oid in owner_ids],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"AI pipeline analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# POST /api/automation-review/ingest-pipeline
# ---------------------------------------------------------------------------

@router.post("/api/automation-review/ingest-pipeline")
async def ingest_pipeline_updates(
    limit: int = 20,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Fetch new messages from #pipeline-updates and feed them through
    parse_crm_message -> _automation_queue. Deduplicates by Slack timestamp."""
    try:
        slack_service = client.services.get("slack")
        if not slack_service:
            raise HTTPException(status_code=503, detail="Slack service not connected")

        # Find the channel
        channels = await slack_service.get_channels(limit=200)
        target_channel = None
        for ch in channels:
            if ch.get("name") == SLACK_PIPELINE_CHANNEL:
                target_channel = ch
                break

        if not target_channel:
            return {
                "ingested": 0,
                "error": f"Channel #{SLACK_PIPELINE_CHANNEL} not found",
            }

        channel_id = target_channel["id"]
        messages = await slack_service.get_channel_history(channel_id, limit=limit)
        if not messages:
            return {"ingested": 0, "total_queued": len(_automation_queue)}

        # Normalize: get_channel_history may return a list or a dict with "messages"
        if isinstance(messages, dict):
            messages = messages.get("messages", [])

        # Resolve user names
        user_cache_local: Dict[str, str] = {}
        try:
            users = await slack_service.get_users(limit=200)
            for u in users:
                user_cache_local[u["id"]] = (
                    u.get("real_name") or u.get("name", u["id"])
                )
        except Exception:
            pass

        ingested = 0
        for msg in messages:
            ts = msg.get("ts", "")
            if not ts or ts in _ingested_slack_ts:
                continue

            text = msg.get("text", "").strip()
            if not text:
                continue

            _ingested_slack_ts.add(ts)

            uid = msg.get("user", "")
            user_name = user_cache_local.get(uid, uid)
            parsed = parse_crm_message(text)

            item_id = str(_uuid.uuid4())
            _automation_queue[item_id] = {
                "id": item_id,
                "source": f"slack:#{SLACK_PIPELINE_CHANNEL}",
                "user_name": user_name,
                "raw_text": text,
                "parsed": parsed,
                "status": "pending",
                "created_at": datetime.utcnow().isoformat(),
                "slack_ts": ts,
                "reviewed_by": None,
                "reviewed_at": None,
            }
            ingested += 1

        return {"ingested": ingested, "total_queued": len(_automation_queue)}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Pipeline ingest error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# POST /api/slack/webhook
# ---------------------------------------------------------------------------

@router.post("/api/slack/webhook")
async def slack_webhook(
    payload: Dict[str, Any],
    user=Depends(require_auth),
    db=Depends(get_db),
):
    """Receive a Slack message and parse it as a CRM update."""
    text = payload.get("text", "")
    channel = payload.get("channel", "")
    user_name = payload.get("user_name", user.get("name", "Unknown"))

    if not text:
        raise HTTPException(status_code=400, detail="Empty message text")

    parsed = parse_crm_message(text, get_opp_cache())

    item_id = str(_uuid.uuid4())
    _automation_queue[item_id] = {
        "id": item_id,
        "source": "slack",
        "source_detail": {"channel": channel, "user": user_name},
        "raw_text": text,
        "parsed": parsed,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
    }

    return ApiResponse(
        success=True,
        data={"id": item_id, "parsed": parsed},
        meta={"message": "CRM update queued for review"},
    )


# ---------------------------------------------------------------------------
# GET /api/automation-review/pending
# ---------------------------------------------------------------------------

@router.get("/api/automation-review/pending")
async def get_pending_reviews(user=Depends(require_auth)):
    """List all pending CRM updates awaiting review."""
    pending = [
        item
        for item in _automation_queue.values()
        if item["status"] == "pending"
    ]
    pending.sort(key=lambda x: x["created_at"], reverse=True)
    return ApiResponse(success=True, data=pending, meta={"count": len(pending)})


# ---------------------------------------------------------------------------
# GET /api/automation-review/all
# ---------------------------------------------------------------------------

@router.get("/api/automation-review/all")
async def get_all_reviews(user=Depends(require_auth)):
    """List all CRM updates (pending, approved, rejected)."""
    items = list(_automation_queue.values())
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return ApiResponse(success=True, data=items, meta={"count": len(items)})


# ---------------------------------------------------------------------------
# POST /api/automation-review/{item_id}/approve
# ---------------------------------------------------------------------------

@router.post("/api/automation-review/{item_id}/approve")
async def approve_review(
    item_id: str,
    edits: Optional[Dict[str, Any]] = None,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
    db=Depends(get_db),
):
    """Approve a pending CRM update and apply to Salesforce."""
    item = _automation_queue.get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Review item not found")
    if item["status"] != "pending":
        raise HTTPException(
            status_code=400, detail=f"Item already {item['status']}"
        )

    parsed = item["parsed"]
    if edits:
        parsed.update(edits)

    # Apply to Salesforce
    try:
        salesforce = client.salesforce
        opp_id = parsed.get("matched_opportunity")
        if opp_id:
            validate_salesforce_id(opp_id, "matched_opportunity")

        if parsed["action"] == "stage_change" and opp_id and parsed.get("stage"):
            update_fields: Dict[str, Any] = {"StageName": parsed["stage"]}
            if parsed.get("amount"):
                update_fields["Amount"] = parsed["amount"]
            if parsed.get("close_date"):
                update_fields["CloseDate"] = parsed["close_date"]
            await salesforce.update_record("Opportunity", opp_id, update_fields)

        elif parsed["action"] == "task" and opp_id:
            # Check if opportunity is locked before creating task via Slack
            opp_lock = await db.fetchrow(
                "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1",
                opp_id,
            )
            if opp_lock:
                logger.warning(
                    f"Slack task creation blocked — opportunity {opp_id} is locked"
                )
            else:
                await salesforce.create_record(
                    "Task",
                    {
                        "Subject": parsed.get("detail", "Follow up")[:255],
                        "WhatId": opp_id,
                        "Status": "Not Started",
                        "Priority": "Normal",
                    },
                )

        elif parsed["action"] == "note" and opp_id:
            # Append to Description
            opp = await salesforce.query(
                f"SELECT Description FROM Opportunity WHERE Id = '{opp_id}' LIMIT 1"
            )
            existing = (
                opp.get("records", [{}])[0].get("Description", "") or ""
            )
            note = f"\n[{datetime.now().strftime('%Y-%m-%d')} via Slack] {parsed['detail']}"
            await salesforce.update_record(
                "Opportunity", opp_id, {"Description": existing + note}
            )

        item["status"] = "approved"
        item["approved_at"] = datetime.now().isoformat()
        item["approved_by"] = user.get("user_id", "unknown")
        return ApiResponse(success=True, data=item)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to apply CRM update {item_id}: {e}")
        raise sf_http_error(e, "CRM update")


# ---------------------------------------------------------------------------
# POST /api/automation-review/{item_id}/reject
# ---------------------------------------------------------------------------

@router.post("/api/automation-review/{item_id}/reject")
async def reject_review(
    item_id: str,
    reason: Optional[str] = None,
    user=Depends(require_auth),
):
    """Reject a pending CRM update."""
    item = _automation_queue.get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Review item not found")
    if item["status"] != "pending":
        raise HTTPException(
            status_code=400, detail=f"Item already {item['status']}"
        )

    item["status"] = "rejected"
    item["rejected_at"] = datetime.now().isoformat()
    item["rejected_by"] = user.get("user_id", "unknown")
    item["rejection_reason"] = reason
    return ApiResponse(success=True, data=item)


# ---------------------------------------------------------------------------
# POST /api/ai/account-activity-summary
# ---------------------------------------------------------------------------

class AccountActivitySummaryRequest:
    """Lightweight body schema — defined inline because pydantic isn't
    needed for the trivial shape and we want to keep this endpoint
    self-contained."""
    pass


@router.post("/api/ai/account-activity-summary")
async def account_activity_summary(
    body: Dict[str, Any] = Body(...),
    user=Depends(require_auth),
):
    """Generate a 2-3 sentence summary of an account's recent activity
    history. The frontend ships the activities client-side (already loaded
    for the page) plus a small account-context blob, so we don't need to
    re-query Salesforce here. Caching is also frontend-side via React
    Query staleTime.

    Body shape::

        {
          "account_name": "Robin Hood Foundation",
          "owner_name": "Amy Sun",
          "activities": [
              {"date": "2026-04-12", "type": "email",
               "subject": "Renewal — next steps",
               "snippet": "Caught up with Mary about the FY27 renewal..."},
              ...
          ]
        }
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI summary not configured (missing ANTHROPIC_API_KEY)",
        )

    account_name: str = (body.get("account_name") or "").strip() or "this account"
    owner_name: Optional[str] = body.get("owner_name") or None
    activities: List[Dict[str, Any]] = body.get("activities") or []

    if not activities:
        return {
            "summary": "No recent activity to summarize.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    # Cap at 60 most recent for the prompt — the model doesn't need the
    # full firehose, and longer prompts cost more without adding much.
    activities = activities[:60]

    lines: List[str] = []
    for a in activities:
        date = a.get("date") or ""
        atype = a.get("type") or ""
        subject = (a.get("subject") or "").strip()[:200]
        snippet = (a.get("snippet") or "").strip()[:400]
        owner = (a.get("owner") or "").strip()
        bits = [f"[{date}]"]
        if atype:
            bits.append(f"({atype})")
        if owner:
            bits.append(f"by {owner}")
        bits.append("—")
        bits.append(subject or "(no subject)")
        if snippet and snippet != subject:
            bits.append(f"// {snippet}")
        lines.append(" ".join(bits))

    activity_block = "\n".join(lines)
    owner_line = f"\nAccount owner: {owner_name}" if owner_name else ""
    prompt = f"""You're an enterprise CRM assistant. Summarize the recent activity log for {account_name} in 2-3 short sentences. Plain text, no bullets, no markdown.

Focus on:
- The handful of meaningful threads (renewal discussions, asks in flight, stewardship moments)
- Notable people who have been active (by name, when present)
- Anything that looks like an open loop (email awaiting reply, scheduled follow-up, action item)

Skip:
- Routine internal log entries that don't reflect outreach or decisions
- Generic statements like "good engagement"

{owner_line}

Activity log (most recent first):
{activity_block}"""

    try:
        import anthropic
        ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = ai_client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        summary = response.content[0].text.strip()
        return {
            "summary": summary,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "activity_count": len(activities),
        }
    except Exception as e:
        logger.error(f"Account activity summary failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate summary")


# ---------------------------------------------------------------------------
# POST /api/ai/account-intelligence
# ---------------------------------------------------------------------------

_VALID_FOCUS = {"overview", "prospecting", "narrative_fit", "health"}


@router.post("/api/ai/account-intelligence")
async def account_intelligence(
    body: Dict[str, Any] = Body(...),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    conn=Depends(get_db),
    user=Depends(require_auth),
):
    """Generate a multi-source relationship brief for a Salesforce account.

    The frontend ships pre-loaded account/contacts/opps/activities so we
    avoid redundant SF round-trips. The backend adds Fireflies transcripts
    and similar-account SOQL (when SF tokens are available) then calls
    Claude Sonnet to synthesize the 4-section brief.

    Body shape::

        {
          "account_id":   "0013600001XXXXX",
          "account_name": "Robin Hood Foundation",
          "account_type": "Foundation",
          "account_website": "robinhood.org",
          "owner_name":   "Amy Sun",
          "focus":        "overview" | "prospecting" | "narrative_fit" | "health",
          "contacts":     [{"Name": ..., "Title": ..., "Email": ..., "LinkedIn_URL__c": ...}, ...],
          "opps":         [{"Name": ..., "StageName": ..., "Amount": ..., "CloseDate": ...,
                            "RecordType": {"Name": ...}}, ...],
          "activities":   [{"date": ..., "type": ..., "subject": ..., "snippet": ...}, ...]
        }
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI intelligence not configured (missing ANTHROPIC_API_KEY)",
        )

    account_id: str = (body.get("account_id") or "").strip()
    if account_id:
        validate_salesforce_id(account_id, "account_id")
    account_name: str = (body.get("account_name") or "this account").strip()
    # Sanitize to prevent prompt injection via crafted account names
    account_name = re.sub(r"[\r\n]+", " ", account_name)[:200]
    account_type: str = (body.get("account_type") or "").strip()
    account_website: str = (body.get("account_website") or "").strip()
    owner_name: str = (body.get("owner_name") or "").strip()
    focus: str = (body.get("focus") or "overview").strip().lower()
    if focus not in _VALID_FOCUS:
        focus = "overview"

    contacts: List[Dict[str, Any]] = body.get("contacts") or []
    opps: List[Dict[str, Any]] = body.get("opps") or []
    activities: List[Dict[str, Any]] = (body.get("activities") or [])[:50]

    # Built up incrementally — only list sources that actually returned data
    sources_used: List[str] = []
    if contacts or opps:
        sources_used.append("salesforce_cache")

    # ── 1. Format contacts ──────────────────────────────────────────────────
    contact_lines: List[str] = []
    for c in contacts[:20]:
        name = (c.get("Name") or "").strip()
        title = (c.get("Title") or "").strip()
        email = (c.get("Email") or "").strip()
        linkedin = (c.get("LinkedIn_URL__c") or "").strip()
        parts = [name]
        if title:
            parts.append(f"| {title}")
        if email:
            parts.append(f"| {email}")
        if linkedin:
            parts.append(f"| {linkedin}")
        contact_lines.append(" ".join(parts))
    contacts_block = "\n".join(contact_lines) if contact_lines else "No contacts on file."

    # ── 2. Format opportunities ─────────────────────────────────────────────
    opp_lines: List[str] = []
    for o in opps[:30]:
        name = (o.get("Name") or "").strip()
        stage = (o.get("StageName") or "").strip()
        amount = o.get("Amount")
        close = (o.get("CloseDate") or "").strip()
        rt = (o.get("RecordType") or {}).get("Name") or ""
        amount_str = f"${int(amount):,}" if amount else ""
        parts = [name, stage]
        if amount_str:
            parts.append(amount_str)
        if close:
            parts.append(close)
        if rt:
            parts.append(f"[{rt}]")
        opp_lines.append(" — ".join(p for p in parts if p))
    opps_block = "\n".join(opp_lines) if opp_lines else "No opportunities on file."

    # ── 3. Format email activities ──────────────────────────────────────────
    activity_lines: List[str] = []
    for a in activities:
        date = (a.get("date") or "").strip()
        atype = (a.get("type") or "").strip()
        subject = (a.get("subject") or "").strip()[:150]
        snippet = (a.get("snippet") or "").strip()[:300]
        owner = (a.get("owner") or "").strip()
        bits = [f"[{date}]"]
        if atype:
            bits.append(f"({atype})")
        if owner:
            bits.append(f"by {owner}")
        bits.append("—")
        bits.append(subject or "(no subject)")
        if snippet and snippet != subject:
            bits.append(f"// {snippet}")
        activity_lines.append(" ".join(bits))
    # ── 3b. Augment with direct bedrock.activity query ─────────────────────
    # The frontend supplies a pre-loaded slice; the DB query fetches the full
    # recent history by account_id, which may include older records.
    if account_id and conn:
        try:
            db_rows = await conn.fetch(
                "SELECT type, subject, activity_date, email_snippet, owner_name "
                "FROM bedrock.activity "
                "WHERE account_id = $1 AND deleted_at IS NULL "
                "ORDER BY activity_date DESC LIMIT 50",
                account_id,
            )
            if db_rows:
                db_lines: List[str] = []
                for row in db_rows:
                    date = str(row["activity_date"] or "")
                    subj = (row["subject"] or "")[:150]
                    snip = (row["email_snippet"] or "")[:300]
                    owner = (row["owner_name"] or "")
                    atype = (row["type"] or "")
                    bits = [f"[{date}]"]
                    if atype:
                        bits.append(f"({atype})")
                    if owner:
                        bits.append(f"by {owner}")
                    bits.append("—")
                    bits.append(subj or "(no subject)")
                    if snip and snip != subj:
                        bits.append(f"// {snip}")
                    db_lines.append(" ".join(bits))
                # DB result is authoritative; merge with frontend lines (dedupe by subject+date)
                seen = {l for l in activity_lines}
                for dl in db_lines:
                    if dl not in seen:
                        activity_lines.append(dl)
                        seen.add(dl)
        except Exception as e:
            logger.warning(f"bedrock.activity query failed for account intelligence: {e}")

    activities_block = "\n".join(activity_lines[:60]) if activity_lines else "No email activity on file."
    if activity_lines:
        sources_used.append("email_activity")

    # ── 4. Fireflies transcripts ────────────────────────────────────────────
    fireflies_block = ""
    try:
        ff_service = client.services.get("fireflies") if client and client.services else None
        if ff_service:
            meetings = await ff_service.get_account_meetings(account_name, limit=10)
            if meetings:
                ff_lines = []
                for m in meetings[:10]:
                    title = m.get("title") or ""
                    date = m.get("date") or ""
                    summary = (m.get("summary") or m.get("transcript_summary") or "")[:400]
                    ff_lines.append(f"[{date}] {title}\n  {summary}")
                fireflies_block = "\n\n".join(ff_lines)
                sources_used.append("fireflies")
    except Exception as e:
        logger.warning(f"Fireflies fetch failed for account intelligence: {e}")
        fireflies_block = ""

    # ── 5. Slack search ────────────────────────────────────────────────────
    slack_block = ""
    try:
        slack_svc = client.services.get("slack") if client and client.services else None
        if slack_svc:
            slack_result = await slack_svc.search_messages(account_name, count=20)
            matches = (
                (slack_result or {}).get("messages", {}).get("matches")
                or (slack_result or {}).get("matches")
                or []
            )
            if matches:
                slack_lines: List[str] = []
                for msg in matches[:15]:
                    text = (msg.get("text") or "")[:300]
                    user = (msg.get("username") or msg.get("user") or "").strip()
                    channel = (msg.get("channel") or {}).get("name") or ""
                    ts = msg.get("ts") or ""
                    slack_lines.append(f"[{ts}] #{channel} {user}: {text}")
                slack_block = "\n".join(slack_lines)
                sources_used.append("slack")
    except Exception as e:
        logger.warning(f"Slack search failed for account intelligence: {e}")
        slack_block = ""

    # ── 6. Similar accounts via SF ─────────────────────────────────────────
    similar_block = ""
    try:
        sf = client.services.get("salesforce") if client and client.services else None
        if sf and account_type:
            safe_type = account_type.replace("'", "\\'")
            similar_q = (
                f"SELECT Id, Name, Type, "
                f"(SELECT Name, StageName, Amount, CloseDate FROM Opportunities "
                f" ORDER BY CloseDate DESC NULLS LAST LIMIT 1) "
                f"FROM Account "
                f"WHERE Type = '{safe_type}' "
                f"AND Id != '{account_id}' "
                f"AND (LastActivityDate = LAST_N_DAYS:730 OR "
                f"     Id IN (SELECT AccountId FROM Opportunity WHERE IsClosed = true)) "
                f"LIMIT 8"
            )
            sim_result = await sf.query(similar_q)
            sim_records = (sim_result or {}).get("records", [])[:5]
            if sim_records:
                sim_lines = []
                for r in sim_records:
                    rname = r.get("Name") or ""
                    rtype = r.get("Type") or ""
                    opps_r = (r.get("Opportunities") or {}).get("records") or []
                    opp_str = ""
                    if opps_r:
                        o0 = opps_r[0]
                        opp_str = f" | Last opp: {o0.get('StageName','')} {o0.get('CloseDate','')}"
                    sim_lines.append(f"- {rname} ({rtype}){opp_str}")
                similar_block = "\n".join(sim_lines)
                sources_used.append("salesforce_similar")
    except Exception as e:
        logger.warning(f"Similar accounts query failed: {e}")
        similar_block = ""

    # ── 7. Focus-specific instruction ──────────────────────────────────────
    focus_instruction = {
        "prospecting": (
            "In the Relationship Summary, emphasize the best re-engagement angle, "
            "who the warmest contacts are, and what the right first ask would be."
        ),
        "narrative_fit": (
            "In the Relationship Summary, emphasize how this account aligns with "
            "Pursuit's mission (workforce development, economic mobility) and what "
            "kind of partnership story could be told."
        ),
        "health": (
            "In the Relationship Summary, emphasize open loops, warning signs, "
            "and the trajectory of the relationship — is it warming, cooling, or stalled?"
        ),
    }.get(focus, "")

    # ── 8. Build synthesis prompt ───────────────────────────────────────────
    fireflies_section = (
        f"\n\nFireflies Meeting Transcripts:\n{fireflies_block}"
        if fireflies_block
        else "\n\nFireflies: No meeting transcripts found."
    )
    slack_section = (
        f"\n\nSlack (internal mentions):\n{slack_block}"
        if slack_block
        else "\n\nSlack: No relevant messages found."
    )
    similar_section = (
        f"\n\nSimilar Accounts ({account_type}):\n{similar_block}"
        if similar_block
        else "\n\nSimilar Accounts: Not available from Salesforce."
    )
    focus_line = f"\n\nFocus instruction: {focus_instruction}" if focus_instruction else ""

    system_prompt = (
        "You are an enterprise CRM analyst producing relationship briefs for "
        "Pursuit, a workforce development nonprofit. Your audience is a new "
        "Relationship Manager who has zero prior knowledge of the account — "
        "write as a cold-start orientation tool, not for someone with a hunch. "
        "Be direct and specific. Editorialize lightly when data clearly supports it. "
        "Sparse records are fine — say so plainly and still deliver what you can. "
        "Never invent facts. If a source returned nothing, say so inline."
    )

    user_prompt = f"""Produce an account history brief for {account_name}. Begin with a single header line: "Account History: {account_name}". Then use this structure:

**Summary** — 2-4 sentences on the nature of the relationship (funder-only, hiring-only, hybrid, dormant, active, prospect, etc.). This is a judgment call — don't just list facts.

**Timeline** — bullet list, `**Date/Range** — description`. Only entries that matter to understanding the trajectory. Favor specific sourced detail over vague summary.

**Key Contacts** — table: Name | Title | Email | LinkedIn | Last Touch

**Similar Accounts** — 5 comparable accounts. Use the SF similar accounts list if provided. When that list is empty or thin, draw on your knowledge of comparable organizations (same org type, sector, philanthropic model, or relationship kind) that are structurally or relationally similar to this account — note briefly that they are included as benchmarking context rather than as existing Pursuit CRM records. For each: name, one-sentence relationship brief, and why it's similar. Do not mention Salesforce field limitations or data constraints in this section — just write the accounts.
{focus_line}

---
Account: {account_name}
Type: {account_type or 'Unknown'}
Website: {account_website or 'Not on file'}
Owner: {owner_name or 'Not assigned'}

Contacts ({len(contacts)} total):
{contacts_block}

Opportunity History ({len(opps)} total):
{opps_block}

Email Activity (last {len(activity_lines)} records, most recent first):
{activities_block}{fireflies_section}{slack_section}{similar_section}
"""

    try:
        import anthropic
        ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = ai_client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        brief = response.content[0].text.strip()
        return {
            "brief": brief,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "sources_used": sources_used,
            "focus": focus,
        }
    except Exception as e:
        logger.error(f"Account intelligence failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate account brief")
