"""FastAPI backend for financial forecasting system."""

import os
import asyncio
import calendar
from dotenv import load_dotenv
# override=True so .env is the single source of truth for the backend.
# Without this, exported shell env vars (e.g. SLACK_BOT_TOKEN in
# ~/.zshrc) silently shadow .env, which previously caused a Slack-bot
# swap to be a no-op for hours of debugging — see 2026-05-20 commit
# notes. Operators who need to override .env from the shell can
# still do so per-process via `KEY=value ./main.py`.
load_dotenv(override=True)
from typing import Any, Dict, List, Optional
from datetime import datetime, date, timedelta
from decimal import Decimal
from difflib import SequenceMatcher
import logging

from fastapi import FastAPI, File, Form, HTTPException, Depends, BackgroundTasks, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel, validator
import uvicorn

# Import our MCP client and models
import sys
# Prefer financial_forecasting/mcp_client (has Calendar, Gmail, Fireflies services)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp_client import UnifiedMCPClient
from models import (
    SalesforceOpportunity, SalesforceAccount, IntacctInvoice, IntacctPayment,
    PaymentForecast, CashFlowProjection, ForecastingMetrics, ForecastingReport,
    OpportunityUpdateRequest, InvoiceCreationRequest, ForecastingDashboardData,
    OpportunityStage, PaymentTerms, InvoiceStatus,
    OPEN_STAGES, CLOSED_STAGES, COLLECTING_STAGES,
    WON_STAGES_SET, LOST_STAGES_SET,
    ApiResponse,
)
from forecasting_engine import ForecastingEngine
from data_sync import DataSyncService
from db import init_db, close_db, get_db, get_db_status
from routes.projects import router as projects_router
from routes.comments import router as comments_router
from routes.notifications import router as notifications_router
from routes.auth import router as auth_router, get_google_credentials, PBD_CALENDAR_ID
from routes.sf_dependencies import router as sf_deps_router
from routes.permissions import router as permissions_router, opp_router as opp_lock_router, check_permission, check_permission_or_internal, resolve_task_lock
from routes.opportunities_extra import router as opp_extra_router
from routes.owner_goals import router as owner_goals_router
from routes.payment_schedules import router as payment_schedules_router
from routes.finance import router as finance_router
from routes.sage import router as sage_router
from routes.prospects import router as prospects_router
from routes.activity_intelligence import router as activity_intel_router
from routes.slack_routes import router as slack_router
from routes.ai import router as ai_router
from routes.salesforce_search import router as sf_search_router
from routes.salesforce_schema import router as sf_schema_router
from routes.admin_sf_drift import router as admin_sf_drift_router
from routes.account_enrichment import router as account_enrichment_router
from routes.admin_company_match import router as admin_company_match_router
from routes.activities import router as activities_router
from routes.platform_intake import router as platform_intake_router
from routes.awards import router as awards_router
from routes.commitments import router as commitments_router
from routes.deliverables import router as deliverables_router
from routes.saved_views import router as saved_views_router
from routes.affiliations import router as affiliations_router
from routes.airtable_jobs import router as airtable_jobs_router
from routes.sputnik import router as sputnik_router
from routes.admin_interaction_sync import router as admin_interaction_sync_router
from routes.jobs import router as jobs_router
from routes.jobs_tasks import router as jobs_tasks_router
from routes.jobs_comments import router as jobs_comments_router
from routes.jobs_intro import router as jobs_intro_router
from routes.jobs_sf import router as jobs_sf_router
from routes.entity_comments import router as entity_comments_router
from auth import get_current_user_dep, require_auth, IS_PRODUCTION, JWT_SECRET_KEY
from security import validate_salesforce_id, escape_soql_string, validate_http_url
from sf_errors import sf_http_error
from services import pipeline_review
from services.crm_parser import refresh_opp_cache as _refresh_opp_cache
from services.cache import cache, CACHE_TTL_OPPORTUNITIES, CACHE_TTL_ACCOUNTS, CACHE_TTL_USERS, CACHE_TTL_CASHFLOW

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Rate limiting
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# Production detection (duplicated here for app init; also in auth.py)
_IS_PROD = os.getenv('FRONTEND_URL', '').startswith('https')

# Initialize FastAPI app
app = FastAPI(
    title="Financial Forecasting API",
    description="API for sales pipeline and financial forecasting integration",
    version="1.0.0",
    docs_url=None if _IS_PROD else "/docs",
    redoc_url=None if _IS_PROD else "/redoc",
)

limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Session middleware (required for Authlib OAuth state)
app.add_middleware(
    SessionMiddleware,
    secret_key=JWT_SECRET_KEY,
    session_cookie="session",
    max_age=3600 * 24,
    same_site="none" if IS_PRODUCTION else "lax",
    https_only=IS_PRODUCTION,
)

# CORS middleware
CORS_ORIGINS = ["http://localhost:3000", "http://localhost:3001", "http://localhost:4000"]
FRONTEND_URL = os.getenv('FRONTEND_URL')
if FRONTEND_URL:
    CORS_ORIGINS.append(FRONTEND_URL)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Api-Key", "X-Internal-Key", "Cookie"],
)

# Compress large JSON responses (the jobs account/contacts lists are hundreds of
# KB of repetitive keys — gzip cuts them ~10x over the wire). SSE streams stay
# uncompressed (they're chunked and below the min size per event).
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Routers
app.include_router(projects_router)
app.include_router(comments_router)
app.include_router(notifications_router)
app.include_router(auth_router)
app.include_router(sf_deps_router)
app.include_router(permissions_router)
app.include_router(opp_lock_router)
# Phase 2 route files
app.include_router(opp_extra_router)
app.include_router(owner_goals_router)
app.include_router(payment_schedules_router)
app.include_router(finance_router)
app.include_router(sage_router)
app.include_router(prospects_router)
app.include_router(activity_intel_router)
app.include_router(slack_router)
app.include_router(ai_router)
app.include_router(sf_search_router)
app.include_router(sf_schema_router)
app.include_router(admin_sf_drift_router)
app.include_router(admin_company_match_router)
app.include_router(account_enrichment_router)
app.include_router(activities_router)
app.include_router(platform_intake_router)
app.include_router(awards_router)
app.include_router(commitments_router)
app.include_router(deliverables_router)
app.include_router(saved_views_router)
app.include_router(affiliations_router)
app.include_router(airtable_jobs_router)
app.include_router(sputnik_router)
app.include_router(admin_interaction_sync_router)
app.include_router(jobs_router)
app.include_router(jobs_tasks_router)
app.include_router(jobs_comments_router)
app.include_router(jobs_intro_router)
app.include_router(jobs_sf_router)
app.include_router(entity_comments_router)

# Service singletons — shared with dependencies.py so route files can use
# Depends(require_sf_mcp_client) without circular imports.
import dependencies as _deps
_services = _deps._services
from dependencies import _sync_lock, get_data_sync_service

# Startup and shutdown events

@app.on_event("startup")
async def startup_event():
    """Initialize services on startup."""
    logger.info("=" * 60)
    logger.info("  BEDROCK API — main.py (production server)")
    logger.info("  simple_server.py is DEPRECATED — do not use")
    logger.info("=" * 60)

    # Validate required environment variables FIRST.
    # In production this raises and aborts startup.
    # In development it logs warnings and continues.
    from env_validator import validate_required_env, current_environment
    validate_required_env(current_environment())

    # Initialize PostgreSQL (non-blocking — app works without it)
    await init_db()

    client = UnifiedMCPClient()
    _services["mcp_client"] = client

    # Connect all services gracefully — each is independent
    for svc_name, connect_fn in [
        ("Salesforce", lambda: client.connect_salesforce(None)),
        ("Sage Intacct", lambda: client.connect_sage_intacct(None)),
        ("Slack", lambda: client.connect_slack(None)),
        ("Google Calendar", lambda: client.connect_google_calendar()),
        ("Gmail", lambda: client.connect_gmail()),
        ("Fireflies", lambda: client.connect_fireflies()),
    ]:
        try:
            await connect_fn()
            logger.info(f"{svc_name} connected successfully")
        except Exception as e:
            logger.warning(f"{svc_name} not available: {e}")

    # Set up dependent services if Salesforce connected
    if "salesforce" in client.connected_services:
        _services["forecasting_engine"] = ForecastingEngine(client)
        # Pass db_pool for activity sync; fall back to no-DB if pool unavailable
        try:
            from db import get_pool
            _services["data_sync_service"] = DataSyncService(client, db_pool=get_pool())
        except Exception:
            _services["data_sync_service"] = DataSyncService(client)
        asyncio.create_task(background_sync_task())
        asyncio.create_task(background_award_reconciler_task())
        # NOTE: the nightly interaction sync is triggered solely by Cloud
        # Scheduler (`bedrock-interaction-sync`, 04:00 UTC) hitting
        # /api/admin/interaction-sync. We intentionally do NOT also run it
        # in-process: this task fires once *per Cloud Run instance*, so on any
        # overnight scale-up it collided with the scheduler run (and itself) —
        # two+ concurrent syncs exhausted the Gmail API / DB pool and produced
        # broken-pipe + empty-error failures and 2h timeouts. One trigger only.
        # asyncio.create_task(background_interaction_sync_task())

    # Cache the db pool on _services so background tasks (notification
    # Slack dispatcher) can acquire connections without going through
    # FastAPI's request-scoped get_db dependency.
    try:
        from db import get_pool
        _services["db_pool"] = get_pool()
    except Exception as e:
        logger.warning(f"db_pool not registered on _services: {e}")

    # SF-side notification poller — watches for new SF Tasks and
    # OpportunityFieldHistory rows and fans out notifications. Only
    # meaningful when SF is connected; the loop self-checks and no-ops
    # otherwise.
    if "salesforce" in client.connected_services:
        try:
            from services.sf_notification_poller import run_forever as _sf_notif_loop
            asyncio.create_task(_sf_notif_loop())
            logger.info("sf_notification_poller started")
        except Exception as e:
            logger.warning(f"sf_notification_poller failed to start: {e}")

    # Builder intro requests written by Sputnik into public.intro_requests.
    # Postgres-only — no SF dependency, so this starts unconditionally.
    try:
        from services.intro_notification_poller import run_forever as _intro_notif_loop
        asyncio.create_task(_intro_notif_loop())
        logger.info("intro_notification_poller started")
    except Exception as e:
        logger.warning(f"intro_notification_poller failed to start: {e}")

    logger.info(f"API started — connected services: {client.connected_services or ['none']}")


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown."""
    logger.info("Shutting down Financial Forecasting API...")
    await close_db()
    client = _services.get("mcp_client")
    if client:
        await client.disconnect_all()
    logger.info("Shutdown complete.")


# Background tasks

async def background_sync_task():
    """Background task to sync data periodically.

    Hard-capped at 10 minutes per cycle. If sync_all_data hangs (e.g.,
    simple_salesforce stuck on a network read), the wait_for raises
    TimeoutError, we release the lock, and the next cycle gets a fresh
    shot. Without this cap, a hung SF call could hold the lock + the
    event loop indefinitely — which was making the whole API stop
    responding ("listens but doesn't respond" pattern observed in dev).
    """
    while True:
        try:
            data_sync_service = _services.get("data_sync_service")
            if data_sync_service:
                if _sync_lock.locked():
                    logger.warning("Sync already in progress, skipping cycle.")
                else:
                    async with _sync_lock:
                        logger.info("Running background data sync...")
                        await asyncio.wait_for(
                            data_sync_service.sync_all_data(),
                            timeout=600.0,  # 10 minutes
                        )
                        logger.info("Background data sync completed.")
        except asyncio.TimeoutError:
            logger.error(
                "Background sync timed out after 600s — lock released; "
                "next cycle will retry. If this fires repeatedly, a SF "
                "or DB call is stuck and needs investigation."
            )
        except Exception as e:
            logger.error(f"Background sync error: {e}")

        # Wait 15 minutes before next sync
        await asyncio.sleep(900)


async def background_award_reconciler_task():
    """Hourly background task: catch awards missed when an opp's stage
    was changed directly in Salesforce (bypassing Bedrock's update-stage
    endpoint, where the auto-create side-effect lives).

    Idempotent — opps that already have an award row are skipped via the
    bedrock.award partial unique index. First run is delayed 60s after
    startup to let the SF connection stabilize.
    """
    await asyncio.sleep(60)
    while True:
        try:
            client = _services.get("mcp_client")
            if client and "salesforce" in (client.connected_services or set()):
                from db import get_pool
                from services.awards_reconciler import reconcile_all
                pool = get_pool()
                if pool is not None:
                    async with pool.acquire() as conn:
                        # Hard-cap at 5 min — same rationale as the
                        # background sync wait_for: a stuck SF call
                        # would otherwise hold the event loop.
                        summary = await asyncio.wait_for(
                            reconcile_all(conn, client.salesforce),
                            timeout=300.0,
                        )
                        logger.info("awards.reconcile summary: %s", summary)
        except asyncio.TimeoutError:
            logger.error("Award reconciler timed out after 300s — skipping cycle")
        except Exception as e:
            logger.error(f"Award reconciler error: {e}")

        # Wait 1h before next pass
        await asyncio.sleep(3_600)


async def background_interaction_sync_task():
    """Nightly background task: sync Gmail + Calendar for all staff in
    bedrock.sync_staff.  Runs once per day at 23:00 ET (04:00 UTC next day).
    First run is delayed 180s after startup so the DB pool is ready.
    """
    import asyncio as _asyncio
    from datetime import timezone as _tz, datetime as _dt, timedelta as _td
    await _asyncio.sleep(180)
    while True:
        # Sleep until next 04:00 UTC (= 23:00 ET / 00:00 ET summer)
        now_utc = _dt.now(_tz.utc)
        target = now_utc.replace(hour=4, minute=0, second=0, microsecond=0)
        if target <= now_utc:
            target += _td(days=1)
        await _asyncio.sleep((target - now_utc).total_seconds())

        try:
            from db import get_pool
            from services.interaction_sync import run_interaction_sync
            pool = get_pool()
            if pool is not None:
                logger.info("interaction_sync: starting nightly run")
                summary = await _asyncio.wait_for(
                    run_interaction_sync(pool),
                    timeout=7_200.0,  # 2h hard cap
                )
                logger.info("interaction_sync: done %s", summary)
        except _asyncio.TimeoutError:
            logger.error("interaction_sync timed out after 2h — skipping cycle")
        except Exception as e:
            logger.error("interaction_sync error: %s", e)


# Dependency functions — get_current_user is now cookie-based (see auth.py)
get_current_user = get_current_user_dep


def get_mcp_client(request: Request = None) -> UnifiedMCPClient:
    """Get MCP client dependency — delegates to dependencies.py."""
    from dependencies import get_mcp_client as _get
    return _get(request)


def require_sf_mcp_client(request: Request) -> UnifiedMCPClient:
    """Like get_mcp_client but requires a valid sf_tokens cookie.
    Use on all user-facing Salesforce data routes.
    """
    from dependencies import require_sf_mcp_client as _req
    return _req(request)


def get_forecasting_engine() -> ForecastingEngine:
    """Get forecasting engine dependency."""
    engine = _services.get("forecasting_engine")
    if not engine:
        raise HTTPException(status_code=503, detail="Forecasting engine not initialized")
    return engine


# get_data_sync_service() moved to dependencies.py

# Cashflow summary moved to routes/finance.py

# Health check endpoints

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    db_status = get_db_status()
    db_healthy = db_status == "connected"
    return ApiResponse(
        success=db_healthy,
        data={"status": "healthy" if db_healthy else "degraded"},
        meta={
            "timestamp": datetime.utcnow().isoformat(),
            "services": {
                "database": db_status,
                "mcp_client": "mcp_client" in _services,
                "forecasting_engine": "forecasting_engine" in _services,
                "data_sync_service": "data_sync_service" in _services,
            },
        },
    )


@app.get("/health/services")
async def services_health_check(
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Check health of connected services."""
    health_status = {}

    for service_name in client._connected_services:
        try:
            service = client.services[service_name]
            info = await service.get_service_info()
            health_status[service_name] = {
                "status": "healthy" if info["authenticated"] else "unhealthy",
                "authenticated": info["authenticated"],
                "config": info.get("config", {})
            }
        except Exception as e:
            health_status[service_name] = {
                "status": "error",
                "error": str(e)
            }

    return ApiResponse(success=True, data=health_status)


# Salesforce endpoints

# Valid stages admit the 13-stage OpportunityStage enum values PLUS the F1 bucket-set
# members that live outside the enum (notably "Closed Won", the Donorbox-auto-populated
# philanthropy stage). Callers passing stages=['Closed Won'] were silently dropped before
# this widened — see tasks/stage-schema-drift.md § "Known pre-existing defects" item 3.
VALID_STAGES = {s.value for s in OpportunityStage} | WON_STAGES_SET | LOST_STAGES_SET

# ISA (Income Share Agreement) opportunities are a separate revenue
# stream owned by another team and are explicitly out-of-scope for
# bedrock — they should never surface in the pipeline / search /
# cashflow views. Filter at the SOQL layer so the API never returns
# them. SOQL `!=` includes NULLs, so opps with no RecordType still
# pass through.
ISA_EXCLUDE_WHERE = "RecordType.Name != 'ISA'"
ISA_EXCLUDE_VIA_OPP = "npe01__Opportunity__r.RecordType.Name != 'ISA'"


@app.get("/api/salesforce/opportunities")
async def get_opportunities(
    stage: Optional[OpportunityStage] = None,
    stages: Optional[List[str]] = Query(None),
    limit: Optional[int] = Query(None, le=2000),
    record_type: Optional[str] = Query(None, description="Filter by RecordType.Name (e.g. 'Philanthropy')"),
    active_only: bool = Query(False, description="Only return Active_Opportunity__c = true"),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce opportunities with optional server-side filtering."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        # Server-side cache — key encodes all filter params
        stage_val = stage.value if stage else None
        stages_key = ",".join(sorted(stages)) if stages else None
        cache_key = f"opps:no-isa:{stage_val}:{stages_key}:{record_type}:{active_only}:{limit}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        # Build SOQL query — field list matches proven simple_server.py query.
        # npsp__Primary_Contact__c is the NPSP writable lookup to Contact
        # (verified via Tooling API describe — DataType Lookup(Contact),
        # label "Primary Contact"). Relationship fields pull the contact's
        # Name + Email for display without a second query.
        # Field list trimmed 2026-05-25: dropped Description (long-text,
        # unused in any list or detail view), Reporting_Method__c (unused),
        # and npsp__Next_Grant_Deadline_Due_Date__c (unused). The previous
        # list pulled ~625 ms; trimmed is ~50 % smaller payload and ~25 %
        # faster SOQL on a 1242-row org. Add fields back here only if a
        # consumer in frontend-v2 actually reads them.
        query = """
        SELECT Id, AccountId, Account.Name, Name, StageName, IsClosed, IsWon,
               Amount, Probability,
               CloseDate, ForecastCategory, LeadSource, NextStep,
               OwnerId, Owner.Name, CreatedDate, LastModifiedDate,
               npe01__Payments_Made__c, Outstanding_Payments__c,
               Number_of_Payments_Received__c, Most_Recent_Payment_Date__c,
               Last_Actual_Payment__c, npe01__Number_of_Payments__c,
               PaymentDate__c, Earliest_Scheduled_Payment__c,
               RenewalRepeat__c,
               npsp__Primary_Contact__c,
               npsp__Primary_Contact__r.Name, npsp__Primary_Contact__r.Email,
               RecordTypeId, RecordType.Name, Active_Opportunity__c,
               Ask_Amount_if_different_from_actual__c,
               Philanthropy_Type__c,
               Manager_Probability_Override__c,
               Priority__c,
               Grant_Start_Date__c, Grant_End_Date__c
        FROM Opportunity
        """

        # ISA opps are always excluded — baseline WHERE clause.
        where_clauses = [ISA_EXCLUDE_WHERE]
        if stage:
            where_clauses.append(f"StageName = '{stage.value}'")
        if stages:
            validated = [s for s in stages if s in VALID_STAGES]
            if validated:
                stage_list = ", ".join(f"'{s}'" for s in validated)
                where_clauses.append(f"StageName IN ({stage_list})")
        if record_type:
            where_clauses.append(f"RecordType.Name = '{escape_soql_string(record_type)}'")
        if active_only:
            where_clauses.append("Active_Opportunity__c = true")
        query += " WHERE " + " AND ".join(where_clauses)

        query += " ORDER BY CloseDate DESC"
        if limit is not None:
            query += f" LIMIT {limit}"

        # Use query_all for automatic pagination
        result = await salesforce.query_all(query)
        records = result.get("records", [])

        # Cache the result and refresh entity cache for Slack parser
        cache.set(cache_key, records, CACHE_TTL_OPPORTUNITIES)
        _refresh_opp_cache(records)

        return records

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching opportunities: {e}")
        raise sf_http_error(e, "records")



@app.get("/api/salesforce/opportunities/record-types")
async def get_opportunity_record_types(
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Return active Opportunity RecordTypes as [{id, name}].

    ISA is excluded — see ISA_EXCLUDE_WHERE comment. We don't want users
    to be able to create or move opps onto the ISA record type from this
    app.
    """
    cached = cache.get("opp_record_types:no-isa")
    if cached is not None:
        return cached
    salesforce = client.salesforce
    result = await salesforce.query(
        "SELECT Id, Name FROM RecordType "
        "WHERE SObjectType = 'Opportunity' AND IsActive = true "
        "AND Name != 'ISA' "
        "ORDER BY Name"
    )
    records = result.get("records", [])
    out = [{"id": r["Id"], "name": r["Name"]} for r in records]
    cache.set("opp_record_types:no-isa", out, 3600)
    return out


@app.post("/api/salesforce/opportunities")
async def create_opportunity(
    opp_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission("create_opportunities")),
):
    """Create a new Salesforce opportunity."""
    try:
        salesforce = client.salesforce
        result = await salesforce.create_record("Opportunity", opp_data)
        if result and (result.get("id") or result.get("Id")):
            new_id = result.get("id") or result.get("Id")
            cache.invalidate_prefix("opps:")
            # Account playbook status (Prospect/Pursuing/...) is
            # derived inside the /api/salesforce/accounts response and
            # the response is cached for CACHE_TTL_ACCOUNTS (10 min).
            # Without busting it here, an account stays Prospect on
            # the UI until the cache expires even though a new open
            # opp now exists. Same reasoning for the stage update +
            # delete paths below.
            cache.invalidate_prefix("accounts:")
            logger.info(f"Opportunity created: {new_id} by {user.get('email', 'unknown')}")
            return ApiResponse(success=True, data={"id": new_id, "message": "Opportunity created"})
        raise HTTPException(400, "Failed to create opportunity — no ID returned")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating opportunity: {e}")
        raise sf_http_error(e, "opportunity")


@app.put("/api/salesforce/opportunities/{opportunity_id}")
async def update_opportunity(
    opportunity_id: str,
    update_request: OpportunityUpdateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission("edit_own_opportunities")),
    db = Depends(get_db),
):
    """Update a Salesforce opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        # Extract permission context (shared by lock, ownership, and reassignment checks)
        perms = user.get("_permissions", {})
        sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
        is_admin = perms.get("manage_users_roles", False)
        has_edit_all = perms.get("edit_all_opportunities", False)
        salesforce = client.salesforce

        # Enforce opportunity lock — only owner or admin can edit locked opportunities
        lock = await db.fetchrow(
            "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
        )
        if lock:
            is_lock_owner = (lock["locked_by"] == sf_user_id)
            if not is_lock_owner and not is_admin:
                raise HTTPException(status_code=403, detail="This opportunity is locked by its owner")

        # Ownership enforcement — edit_own vs edit_all
        if not is_admin and not has_edit_all:
            # User only has edit_own — verify they own this opportunity
            if sf_user_id:
                current_opp = await salesforce.query(
                    f"SELECT OwnerId FROM Opportunity WHERE Id = '{opportunity_id}' LIMIT 1"
                )
                records = current_opp.get("records", [])
                if records:
                    current_owner = records[0].get("OwnerId")
                    if current_owner != sf_user_id:
                        raise HTTPException(status_code=403, detail="You can only edit opportunities you own")

        # OwnerId reassignment requires reassign_opportunities permission
        if "OwnerId" in update_request.updates:
            if not is_admin:
                if not perms.get("reassign_opportunities", False):
                    raise HTTPException(status_code=403, detail="You don't have permission to reassign opportunities")

        success = await salesforce.update_record(
            "Opportunity",
            opportunity_id,
            update_request.updates
        )

        if success:
            cache.invalidate_prefix("opps:")
            cache.invalidate("stage_history:30")
            # Stage / Amount / Active_Opportunity__c flips can move
            # the account between Prospect/Pursuing/Stewarding —
            # bust the accounts cache so the derived status refreshes.
            cache.invalidate_prefix("accounts:")

            # Grant period lives on the Opportunity (source of truth) but the
            # Awards views read bedrock.award.award_date / period_end_date.
            # Mirror one-way, opp → award, whenever the grant fields change so
            # the two never disagree. Best-effort: the SF write already
            # succeeded, so a mirror failure must not fail the request.
            updates = update_request.updates
            if "Grant_Start_Date__c" in updates or "Grant_End_Date__c" in updates:
                try:
                    sets, args, n = [], [], 1
                    for sf_field, col in (("Grant_Start_Date__c", "award_date"),
                                          ("Grant_End_Date__c", "period_end_date")):
                        if sf_field in updates:
                            v = updates[sf_field]
                            sets.append(f"{col} = ${n}")
                            args.append(date.fromisoformat(v) if isinstance(v, str) and v else None)
                            n += 1
                    await db.execute(
                        f"UPDATE bedrock.award SET {', '.join(sets)}, updated_at = now() "
                        f"WHERE opportunity_id = ${n} AND deleted_at IS NULL",
                        *args, opportunity_id,
                    )
                except Exception:
                    logger.exception(
                        "Grant date mirror to bedrock.award failed for opp=%s; "
                        "SF write succeeded, award dates may be stale.", opportunity_id)

            logger.info(f"Opportunity {opportunity_id} updated by {user['user_id']}")
            return ApiResponse(success=True, data={"id": opportunity_id, "message": "Opportunity updated successfully"})
        else:
            raise HTTPException(status_code=400, detail="Failed to update opportunity")

    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error updating opportunity {opportunity_id}: {error_msg}")
        raise HTTPException(status_code=400, detail=error_msg)


@app.delete("/api/salesforce/opportunities/{opportunity_id}")
@limiter.limit("30/minute")
async def delete_opportunity(
    request: Request,
    opportunity_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_own_opportunities")),
):
    """Delete a Salesforce Opportunity.

    Destructive and irreversible at the SF level — the frontend caller
    (OpportunityEditDialog) surfaces a confirm-before-delete popover.

    Auth (PR #169): `check_permission_or_internal("edit_own_opportunities")`
    is the outer gate — matches update_opportunity's permission key so the
    permission profile already grants the right users. `_enforce_record_ownership`
    then restricts deletes to the opp's owner, admins, or users with
    `edit_all_opportunities`. Service callers (is_service=True) short-circuit
    inside the helper for Pebble CRM-write.

    Cascade invalidation: child tasks/payments + stage rollups all become
    stale when an opp goes away.
    """
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        salesforce = client.salesforce
        await _enforce_record_ownership(
            salesforce, "Opportunity", opportunity_id, user, "edit_all_opportunities",
        )
        success = await salesforce.delete_record("Opportunity", opportunity_id)
        if not success:
            raise HTTPException(400, "Salesforce rejected the delete")
        # Opp list caches (get_opportunities at main.py:304 uses "opps:")
        cache.invalidate_prefix("opps:")
        # stage_history:30 — direct key invalidation (set at main.py:454 under
        # update_opportunity; stage rollups change when an opp is removed).
        cache.invalidate("stage_history:30")
        # opp-payments: / payments: — child payments now orphaned.
        cache.invalidate_prefix("opp-payments:")
        cache.invalidate_prefix("payments:")
        # Bust the derived account status (which reads opp lists).
        cache.invalidate_prefix("accounts:")
        # my-tasks: / contact-tasks: — child Tasks still have WhatId pointing
        # at the deleted opp; cached entries would render with a stale parent.
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        # opportunities: — Payment endpoints invalidate this prefix defensively.
        cache.invalidate_prefix("opportunities:")
        logger.info(f"Opportunity {opportunity_id} deleted by {user['user_id']}")
        return ApiResponse(
            success=True,
            data={"id": opportunity_id, "message": "Opportunity deleted"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting opportunity {opportunity_id}: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail="Failed to delete opportunity. Check server logs or contact support.",
        )


@app.get("/api/salesforce/accounts")
async def get_accounts(
    # `le=2000` matches GET /api/salesforce/opportunities — defensive upper
    # bound for callers that want a capped response. Default `None` means
    # "return all" via query_all() pagination; the frontend relies on this
    # to avoid silent truncation when Pursuit's Account count exceeds 2000.
    limit: Optional[int] = Query(None, le=2000),
    # `fields=light` returns only the ~17 fields the v2 frontend uses,
    # cutting SOQL payload ~70% vs the full 50-field default (kept for v1).
    fields: Optional[str] = Query(None),
    # `active_only=true` narrows the SOQL to accounts touched in the
    # last 6 months (LastActivityDate >= LAST_N_MONTHS:6) — ~370 rows
    # vs ~20k total, fetched in ~200 ms vs ~5.6 s. Frontend uses this
    # for the first-paint pass; the full set lands in a follow-up
    # request. Active__c was tried as a filter but turns out 19.9k of
    # 20.2k accounts have it set — not useful as a subset signal.
    active_only: bool = Query(False),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce accounts."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        use_light = fields == "light"
        cache_key = (
            f"accounts:{limit or 'all'}:"
            f"{'light' if use_light else 'full'}:"
            f"{'active' if active_only else 'any'}"
        )
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        if use_light:
            query = """
            SELECT Id, Name, Type, Industry, Website, Description,
                   BillingCity, BillingState, OwnerId, Owner.Name,
                   Account_Tier__c, Active__c, Qualification_Status__c,
                   npo02__TotalOppAmount__c, npo02__NumberOfClosedOpps__c,
                   Total_Revenue_Generated__c,
                   Last_Activity_Date__c, LastActivityDate,
                   CreatedDate, LastModifiedDate,
                   Drive_Strategy_Folder_URL__c
            FROM Account
            ORDER BY Name ASC
            """
        else:
            query = """
            SELECT Id, Name, Type, Industry, Phone, Fax, Website, Description,
                   BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry,
                   AnnualRevenue, NumberOfEmployees, AccountSource, OwnerId, Owner.Name,
                   ParentId, RecordTypeId, RecordType.Name,
                   CreatedDate, LastModifiedDate, LastActivityDate,
                   Account_Tier__c, Active__c, Company_Size__c,
                   npsp__Grantmaker__c, npsp__Funding_Focus__c,
                   Philanthropy__c, Fee_For_Service__c, Hiring__c, Investment__c,
                   Volunteering__c, Fellow_Recruitment__c, Media_Marketing__c,
                   Influence__c, Startup__c, Organization_Focus_Area_s__c,
                   npo02__TotalOppAmount__c, npo02__NumberOfClosedOpps__c,
                   npo02__AverageAmount__c, npo02__LargestAmount__c, npo02__SmallestAmount__c,
                   npo02__FirstCloseDate__c, npo02__LastCloseDate__c,
                   npo02__OppAmountThisYear__c, npo02__OppAmountLastYear__c,
                   npo02__Best_Gift_Year__c, npo02__Best_Gift_Year_Total__c,
                   npsp__Matching_Gift_Company__c, npsp__Matching_Gift_Percent__c,
                   npsp__Matching_Gift_Amount_Max__c, npsp__Matching_Gift_Amount_Min__c,
                   npsp__Matching_Gift_Annual_Employee_Max__c,
                   npsp__Matching_Gift_Administrator_Name__c, npsp__Matching_Gift_Email__c,
                   npsp__Matching_Gift_Phone__c, npsp__Matching_Gift_Comments__c,
                   npsp__Matching_Gift_Info_Updated__c, npsp__Matching_Gift_Request_Deadline__c,
                   Total_Revenue_Generated__c,
                   Last_Activity_Date__c, Date_of_First_Pursuit_Hire__c,
                   Qualification_Status__c, Qualification_Date_Updated__c,
                   Qualification_Explanation__c,
                   Drive_Strategy_Folder_URL__c
            FROM Account
            ORDER BY Name ASC
            """
        if limit is not None:
            query += f" LIMIT {limit}"

        # Inject the active_only WHERE clause between FROM and ORDER BY.
        # Both branches above are "SELECT ... FROM Account ORDER BY ..."
        # — splice rather than re-quote the string to keep the field
        # list untouched.
        if active_only:
            query = query.replace(
                "FROM Account\n",
                "FROM Account\n            WHERE LastActivityDate = LAST_N_MONTHS:6\n",
            )

        result = await salesforce.query_all(query)
        records = result.get("records", [])

        # Derive playbook Account Status (Prospect / Pursuing /
        # Stewarding / Re-activating / Dormant) per account. Pure
        # derivation — see services/account_status.py. Skip on the
        # active_only pre-paint because status derivation needs the
        # FULL opportunity history of each account to classify
        # Re-activating vs Dormant correctly; the follow-up full-set
        # request attaches status to the same accounts.
        if not active_only:
            try:
                await _attach_account_status(records, salesforce)
            except Exception as ex:  # noqa: BLE001
                logger.warning(f"Failed to derive account_status; serving without it: {ex}")

        cache.set(cache_key, records, CACHE_TTL_ACCOUNTS)
        return records

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching accounts: {e}")
        raise sf_http_error(e, "records")


async def _attach_account_status(accounts: list, salesforce) -> None:
    """Compute and attach `account_status` to every account row.

    Pulls the minimum data needed for the derivation:
      - SF opportunities (Id, AccountId, StageName, IsClosed,
        Active_Opportunity__c) via one SOQL.
      - bedrock.award rows joined to opportunity_id via one SQL.
      - bedrock.activity latest_date per account_id via one SQL.

    All three queries fire in parallel. The compute is ~50 ms for
    2 k accounts on the laptop; well within the existing endpoint
    latency budget.
    """
    from datetime import datetime, timedelta, timezone as _tz

    from db import get_pool
    from services.account_status import (
        build_lookups,
        compute_account_status,
    )

    account_ids = [a.get("Id") for a in accounts if a.get("Id")]
    if not account_ids:
        return

    # 1. SF opportunities — slim projection, no record-type filter so the
    # status sees the full picture.
    opp_query = (
        "SELECT Id, AccountId, StageName, IsClosed, IsWon, "
        "Active_Opportunity__c FROM Opportunity"
    )
    opp_result = await salesforce.query_all(opp_query)
    opps = opp_result.get("records", [])

    # 2 + 3. Awards + latest activity per account from bedrock.
    # Scope activity to the 3-month window we actually care about
    # (anything older means Dormant either way), with a small buffer
    # for cron lag.
    cutoff = datetime.now(_tz.utc) - timedelta(days=120)
    pool = get_pool()
    async with pool.acquire() as conn:
        award_rows = await conn.fetch(
            "SELECT opportunity_id, award_status FROM bedrock.award"
        )
        act_rows = await conn.fetch(
            "SELECT account_id, MAX(activity_date) AS activity_date "
            "FROM bedrock.activity "
            "WHERE account_id IS NOT NULL AND activity_date >= $1 "
            "GROUP BY account_id",
            cutoff,
        )
    awards = [dict(r) for r in award_rows]
    activities = [dict(r) for r in act_rows]

    opps_by_account, awards_by_opp, latest_activity_by_account = build_lookups(
        opps, awards, activities,
    )

    for a in accounts:
        aid = a.get("Id")
        if not aid:
            continue
        a["account_status"] = compute_account_status(
            aid,
            opps_by_account,
            awards_by_opp,
            latest_activity_by_account,
            is_active=bool(a.get("Active__c", True)),
            qualification_status=a.get("Qualification_Status__c"),
        )


@app.post("/api/salesforce/accounts")
async def create_account(
    account_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("create_accounts"))
):
    """Create a new Salesforce account."""
    try:
        salesforce = client.salesforce
        result = await salesforce.create_record("Account", account_data)
        if result and result.get("id"):
            cache.invalidate_prefix("accounts:")
            logger.info(f"Account created with ID: {result['id']} by {user['user_id']}")
            return ApiResponse(success=True, data={"id": result["id"], "message": "Account created successfully"})
        raise HTTPException(status_code=400, detail="Failed to create account")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating account: {e}")
        raise sf_http_error(e, "account")


@app.get("/api/salesforce/contacts")
async def get_contacts(
    account_id: Optional[str] = None,
    # `le=5000` retained from prior behavior (contacts cap was deliberately
    # looser than accounts). Default `None` means "return all" via query_all
    # pagination; the frontend relies on this to avoid silent truncation.
    limit: Optional[int] = Query(None, le=5000),
    # `fields=light` mirrors the accounts pattern — returns only the
    # ~12 fields the v2 list / cleanup / contact-detail header use.
    # Cuts SOQL payload by ~70% across 5K-10K contact rows, which is
    # the dominant cause of the contacts list feeling slow on cold
    # cache. Per-contact detail page still uses fields=full.
    fields: Optional[str] = Query(None),
    # `active_only=true` narrows the SOQL to contacts touched in the
    # last 6 months — same pattern as /accounts. Pursuit has ~15k
    # total contacts; only ~311 have LastActivityDate in the window.
    # First-paint fetch drops from ~1.4 s → ~100 ms backend. Full set
    # arrives in a follow-up call.
    active_only: bool = Query(False),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce contacts, optionally filtered by account."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        use_light = fields == "light"
        cache_key = (
            f"contacts:{account_id}:{limit or 'all'}:"
            f"{'light' if use_light else 'full'}:"
            f"{'active' if active_only else 'any'}"
        )
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        if use_light:
            query = """
            SELECT Id, AccountId, Account.Name, FirstName, LastName, Name,
                   Title, Department, Email, Phone, MobilePhone,
                   OwnerId, Owner.Name, LeadSource, RecordTypeId, RecordType.Name,
                   CreatedDate, LastModifiedDate, LastActivityDate,
                   Last_Activity_Date__c, Days_Since_Last_Activity__c,
                   Philanthropic_Contact__c, Philanthropy__c, Board_Status__c,
                   LinkedIn_URL__c, Pronouns__c, Preferred_Name__c,
                   MailingCity, MailingState
            FROM Contact
            """
        else:
            query = """
            SELECT Id, AccountId, Account.Name, FirstName, LastName, Name,
                   Salutation, Title, Department, Email, Phone, MobilePhone,
                   MailingStreet, MailingCity, MailingState, MailingPostalCode, MailingCountry,
                   OwnerId, Owner.Name, LeadSource, Birthdate, Description,
                   DoNotCall, HasOptedOutOfEmail, RecordTypeId, RecordType.Name,
                   CreatedDate, LastModifiedDate, LastActivityDate,
                   npsp__Primary_Affiliation__c, npsp__Primary_Affiliation__r.Name,
                   npsp__Deceased__c, npsp__Do_Not_Contact__c,
                   npe01__WorkEmail__c, npe01__HomeEmail__c, npe01__AlternateEmail__c,
                   npe01__WorkPhone__c, npe01__PreferredPhone__c, npe01__Preferred_Email__c,
                   npe01__Primary_Address_Type__c,
                   Preferred_Name__c, Pronouns__c, Gender__c, LinkedIn_URL__c,
                   Philanthropic_Contact__c, Philanthropy__c, Board_Status__c,
                   Volunteer__c, Added_to_Slack__c, Last_Touchpoint__c,
                   Last_Activity_Date__c, Days_Since_Last_Activity__c,
                   Primary_Affiliation_Entity__c, Primary_Affiliation_Name__c,
                   GW_Volunteers__Volunteer_Hours__c, GW_Volunteers__Last_Volunteer_Date__c
            FROM Contact
            """

        # Build WHERE clauses. account_id and active_only stack with AND;
        # an account-scoped fetch from the detail page doesn't apply
        # active_only since the user wants every contact on the account.
        wheres = []
        if account_id:
            validate_salesforce_id(account_id, "account_id")
            # NPSP: for ORGANIZATION accounts, contacts are linked via
            # npe5__Affiliation__c (npe5__Organization__c), NOT Contact.AccountId
            # (which points to the person's Household). SOQL forbids a semi-join
            # sub-select with OR, so resolve the affiliated contact ids first and
            # match AccountId OR an explicit Id IN (...) list.
            aff_ids = []
            try:
                aff = await salesforce.query_all(
                    f"SELECT npe5__Contact__c FROM npe5__Affiliation__c "
                    f"WHERE npe5__Organization__c = '{account_id}' AND npe5__Contact__c != null")
                aff_ids = [r["npe5__Contact__c"] for r in aff.get("records", []) if r.get("npe5__Contact__c")]
            except Exception as ae:
                logger.warning(f"affiliation lookup for {account_id} failed: {ae}")
            if aff_ids:
                id_list = ", ".join(f"'{i}'" for i in aff_ids[:2000])
                wheres.append(f"(AccountId = '{account_id}' OR Id IN ({id_list}))")
            else:
                wheres.append(f"AccountId = '{account_id}'")
        elif active_only:
            # SF date-literal — anchors the window relative to today
            # without needing a server-side timestamp.
            wheres.append("LastActivityDate = LAST_N_MONTHS:6")

        if wheres:
            query += " WHERE " + " AND ".join(wheres)

        query += " ORDER BY LastName ASC"
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        contacts = result.get("records", [])
        cache.set(cache_key, contacts, CACHE_TTL_ACCOUNTS)
        return contacts

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching contacts: {e}")
        raise sf_http_error(e, "contacts")


@app.post("/api/salesforce/contacts")
async def create_contact(
    contact_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("create_contacts"))
):
    """Create a new Salesforce contact.

    Salesforce duplicate rules reject a same-name/email contact with a
    DUPLICATES_DETECTED error. Rather than surface an opaque 500, we detect that
    and return a 409 with the existing match so the UI can offer "open existing"
    or "create anyway" (force=true bypasses the rule via allowSave)."""
    try:
        salesforce = client.salesforce
        contact_data.pop("force", None); contact_data.pop("allow_duplicate", None)  # not persisted to SF

        result = await salesforce.create_record("Contact", contact_data)

        if result and result.get("id"):
            cache.invalidate_prefix("contacts:")
            logger.info(f"Contact created with ID: {result['id']} by {user['user_id']}")
            return ApiResponse(success=True, data={"id": result["id"], "message": "Contact created successfully"})
        raise HTTPException(status_code=400, detail="Failed to create contact")

    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        logger.error(f"Error creating contact: {msg}")
        # Duplicate-rule rejection → 409 with the existing match(es), not a 500.
        if "DUPLICATES_DETECTED" in msg or "duplicate" in msg.lower():
            existing = []
            try:
                em = contact_data.get("Email"); fn = contact_data.get("FirstName"); ln = contact_data.get("LastName")
                clauses = []
                if em: clauses.append(f"Email = '{escape_soql_string(em)}'")
                if fn and ln: clauses.append(f"(FirstName = '{escape_soql_string(fn)}' AND LastName = '{escape_soql_string(ln)}')")
                if clauses:
                    q = "SELECT Id, Name, Email, Title, Account.Name FROM Contact WHERE " + " OR ".join(clauses) + " LIMIT 5"
                    res = await client.salesforce.query(q)
                    existing = [{"id": r["Id"], "name": r.get("Name"), "email": r.get("Email"),
                                 "title": r.get("Title"), "account": (r.get("Account") or {}).get("Name")}
                                for r in res.get("records", [])]
            except Exception as qe:
                logger.warning(f"duplicate lookup failed: {qe}")
            raise HTTPException(status_code=409, detail={
                "error": "duplicate_contact",
                "message": "A contact with this name or email already exists in Salesforce.",
                "existing": existing,
            })
        raise sf_http_error(e, "contact")


# ── Payment SOQL (shared by both payment GET endpoints) ──────────────────

PAYMENT_SOQL_FIELDS = """
    Id, Name, npe01__Opportunity__c, npe01__Opportunity__r.Name,
    npe01__Opportunity__r.Account.Name,
    npe01__Opportunity__r.AccountId,
    npe01__Opportunity__r.OwnerId,
    npe01__Opportunity__r.Owner.Name,
    npe01__Opportunity__r.StageName,
    npe01__Opportunity__r.Amount,
    npe01__Opportunity__r.Probability,
    npe01__Opportunity__r.Manager_Probability_Override__c,
    npe01__Opportunity__r.CloseDate,
    npe01__Opportunity__r.RecordType.Name,
    npe01__Opportunity__r.Active_Opportunity__c,
    npe01__Opportunity__r.Philanthropy_Type__c,
    npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
    npe01__Payment_Date__c, npe01__Paid__c,
    npe01__Payment_Method__c, npe01__Check_Reference_Number__c,
    npe01__Written_Off__c, Write_off_reason__c,
    Amount_Received__c, Department__c, GL_Account__c,
    GL_Payment_Received__c, Reconciled_with_Finance__c,
    Batch_Name__c, Payment_Estimate__c,
    Affiliation__c, CreatedDate, LastModifiedDate,
    Payment_Status__c, Delinquent__c, Paid_Status__c,
    Amount_Formula__c, Amount_Minus_Received__c
"""


@app.get("/api/salesforce/payments")
async def get_payments(
    opportunity_id: Optional[str] = None,
    limit: int = Query(500, le=2000),
    include_open_opps: bool = Query(
        False,
        description="Also return every payment on a still-open opportunity, "
                    "regardless of the limit window.",
    ),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth),
):
    """Get Salesforce payments, optionally filtered by opportunity.

    `include_open_opps` exists because the default window is the `limit` most
    recently SCHEDULED payments, and the org holds 18,697 of them. The payments
    a reviewer needs to act on are overdue by definition — old scheduled dates
    on opportunities that are still open — so they sort to the bottom and fall
    outside the window. Measured 2026-08-12: of 103 payments the hygiene rules
    flag, only 36 were inside the default 2,000. Opt-in so the other callers of
    this endpoint keep their existing payload.
    """
    try:
        cache_key = f"payments:{opportunity_id}:{limit}:{include_open_opps}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce
        query = f"SELECT {PAYMENT_SOQL_FIELDS} FROM npe01__OppPayment__c"

        if opportunity_id:
            validate_salesforce_id(opportunity_id, "opportunity_id")
            query += f" WHERE npe01__Opportunity__c = '{opportunity_id}'"

        query += f" ORDER BY npe01__Scheduled_Date__c DESC NULLS LAST LIMIT {limit}"

        result = await salesforce.query(query)
        records = result.get("records", [])

        if include_open_opps and not opportunity_id:
            # Second pass, merged on Id. Kept as its own query rather than an OR
            # in the first: the LIMIT applies to the whole statement, so an OR
            # would just re-slice the same 2,000 rows and change nothing.
            open_result = await salesforce.query_all(f"""
                SELECT {PAYMENT_SOQL_FIELDS}
                FROM npe01__OppPayment__c
                WHERE {ISA_EXCLUDE_VIA_OPP}
                  AND npe01__Opportunity__r.IsClosed = false
                  AND npe01__Opportunity__r.StageName != 'In Collection'
                ORDER BY npe01__Scheduled_Date__c DESC NULLS LAST
            """)
            seen = {r.get("Id") for r in records}
            added = [r for r in open_result.get("records", []) if r.get("Id") not in seen]
            records = records + added
            logger.info(
                "payments: %d in the limit window + %d more on open opportunities",
                len(seen), len(added),
            )

        cache.set(cache_key, records, CACHE_TTL_OPPORTUNITIES)
        return records

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching payments: {e}")
        raise sf_http_error(e, "records")


@app.get("/api/salesforce/pipeline-review-flags")
async def get_pipeline_review_flags(
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth),
):
    """Advisory data-hygiene flags for the pipeline review (Zhong, 2026-08-12).

    Read-only. Returns only the opportunities that tripped a rule, each with
    the grid columns to tint and the payments behind any payment-level hit.
    See services/pipeline_review.py for the rules and for the one rule that is
    deliberately not implemented yet.

    Two bulk queries rather than per-opportunity payment fetches: the grid
    shows ~2,100 open fundraising opportunities, so the obvious shape would be
    2,100 round-trips to Salesforce.
    """
    try:
        if "salesforce" not in (client.connected_services or []):
            return {"generated_at": None, "severity": "advisory",
                    "rules": pipeline_review.RULES, "flagged": {}}

        cached = cache.get("pipeline-review-flags")
        if cached is not None:
            return cached

        salesforce = client.salesforce

        # Open opportunities only. A closed opportunity's dates are history, and
        # flagging them would put a permanent wall of colour on the review.
        opp_query = f"""
            SELECT Id, StageName, CloseDate, Probability,
                   Manager_Probability_Override__c
            FROM Opportunity
            WHERE {ISA_EXCLUDE_WHERE}
              AND IsClosed = false
              AND StageName != 'In Collection'
        """
        opp_result = await salesforce.query_all(opp_query)
        opportunities = opp_result.get("records", [])

        # Payments for those same opportunities, filtered through the parent so
        # this stays one query. The predicates mirror the opportunity query.
        pay_query = f"""
            SELECT Id, Name, npe01__Opportunity__c, npe01__Scheduled_Date__c,
                   npe01__Payment_Date__c, npe01__Payment_Amount__c,
                   npe01__Paid__c, npe01__Written_Off__c
            FROM npe01__OppPayment__c
            WHERE {ISA_EXCLUDE_VIA_OPP}
              AND npe01__Opportunity__r.IsClosed = false
              AND npe01__Opportunity__r.StageName != 'In Collection'
        """
        pay_result = await salesforce.query_all(pay_query)
        payments = pay_result.get("records", [])

        flags = pipeline_review.build_flags(opportunities, payments)
        logger.info(
            "pipeline-review-flags: scanned %d opportunities / %d payments; "
            "flagged %d opportunities, %d payment rows",
            len(opportunities), len(payments),
            len(flags["opportunities"]), len(flags["payments"]),
        )
        cache.set("pipeline-review-flags", flags, CACHE_TTL_OPPORTUNITIES)
        return flags

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error building pipeline review flags: {e}")
        raise sf_http_error(e, "records")


# ---------------------------------------------------------------------------
# Salesforce Files (ContentDocument / ContentDocumentLink) on Opportunity
# ---------------------------------------------------------------------------
# SF Files attach to records via ContentDocumentLink (LinkedEntityId).
# We expose two endpoints scoped to a parent Opportunity:
#   GET  list — fetches every file currently linked to the opp via SOQL on
#         ContentDocumentLink, joined to ContentDocument for filename + size
#   POST upload — multipart/form-data; creates a ContentVersion with
#         FirstPublishLocationId set to the opp id, which auto-creates the
#         ContentDocumentLink in one server-side step (no extra round-trip
#         needed). Returns the new ContentDocument id + metadata.


@app.get("/api/salesforce/opportunities/{opportunity_id}/files")
async def list_opportunity_files(
    opportunity_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """List SF Files attached to an Opportunity via ContentDocumentLink."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        salesforce = client.salesforce
        soql = (
            "SELECT ContentDocumentId, ContentDocument.Title, "
            "ContentDocument.FileExtension, ContentDocument.ContentSize, "
            "ContentDocument.LatestPublishedVersionId, "
            "ContentDocument.CreatedDate, ContentDocument.CreatedBy.Name "
            "FROM ContentDocumentLink "
            f"WHERE LinkedEntityId = '{escape_soql_string(opportunity_id)}' "
            "ORDER BY ContentDocument.CreatedDate DESC"
        )
        result = await salesforce.query(soql)
        records = result.get("records", []) or []
        return [
            {
                "content_document_id": r.get("ContentDocumentId"),
                "title": (r.get("ContentDocument") or {}).get("Title"),
                "extension": (r.get("ContentDocument") or {}).get("FileExtension"),
                "size_bytes": (r.get("ContentDocument") or {}).get("ContentSize"),
                "latest_version_id": (r.get("ContentDocument") or {}).get("LatestPublishedVersionId"),
                "created_date": (r.get("ContentDocument") or {}).get("CreatedDate"),
                "created_by": ((r.get("ContentDocument") or {}).get("CreatedBy") or {}).get("Name"),
            }
            for r in records
        ]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing files for opp {opportunity_id}: {e}")
        raise sf_http_error(e, "files")


# Max upload size — SF REST API ContentVersion handles up to ~37 MB
# synchronously. Cap below that to leave headroom for base64 overhead.
_MAX_FILE_BYTES = 25 * 1024 * 1024  # 25 MB


@app.post("/api/salesforce/opportunities/{opportunity_id}/files")
async def upload_opportunity_file(
    opportunity_id: str,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Upload a file and attach it to an Opportunity.

    Creates a ContentVersion with FirstPublishLocationId = opportunity_id.
    SF handles the ContentDocument + ContentDocumentLink creation
    server-side, so this is a single API call.
    """
    import base64
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        body = await file.read()
        if len(body) > _MAX_FILE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large ({len(body)} bytes; max {_MAX_FILE_BYTES})",
            )
        if len(body) == 0:
            raise HTTPException(status_code=400, detail="Empty file")

        # PathOnClient is what SF uses to infer extension + MIME. Pass the
        # original filename verbatim so e.g. "proposal.pdf" -> .pdf.
        path_on_client = file.filename or "file"
        # Title shown in SF Files UI. Strip the extension for display
        # cleanliness — SF re-derives the extension from PathOnClient.
        display_title = title or (path_on_client.rsplit(".", 1)[0] if "." in path_on_client else path_on_client)

        salesforce = client.salesforce
        result = await salesforce.create_record(
            "ContentVersion",
            {
                "Title": display_title,
                "PathOnClient": path_on_client,
                "VersionData": base64.b64encode(body).decode("ascii"),
                "FirstPublishLocationId": opportunity_id,
            },
        )
        content_version_id = result.get("id") or result.get("Id")

        # Look up the resulting ContentDocumentId so callers can show /
        # link to the file immediately without a second list-call.
        version_q = await salesforce.query(
            f"SELECT ContentDocumentId FROM ContentVersion WHERE Id = '{escape_soql_string(content_version_id)}'"
        )
        records = version_q.get("records", []) or []
        content_document_id = records[0].get("ContentDocumentId") if records else None

        return ApiResponse(
            success=True,
            data={
                "content_version_id": content_version_id,
                "content_document_id": content_document_id,
                "title": display_title,
                "size_bytes": len(body),
                "filename": path_on_client,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file to opp {opportunity_id}: {e}", exc_info=True)
        raise sf_http_error(e, "file")


@app.delete("/api/salesforce/opportunities/{opportunity_id}/files/{content_document_id}")
async def delete_opportunity_file(
    opportunity_id: str,
    content_document_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Unlink a file from this opportunity.

    Deletes the ContentDocumentLink only — never the ContentDocument. The same
    document can be linked to other records (an Account, a Contact, another
    Opportunity); removing it here must not make it vanish everywhere. The
    document itself lives on in Salesforce Files, owned by its uploader.
    """
    validate_salesforce_id(opportunity_id, "opportunity_id")
    validate_salesforce_id(content_document_id, "content_document_id")
    try:
        salesforce = client.salesforce
        # Resolve the link row for THIS record — doubles as the guard that the
        # file actually belongs here (no unlinking arbitrary documents by id).
        link_check = await salesforce.query(
            f"SELECT Id FROM ContentDocumentLink "
            f"WHERE ContentDocumentId = '{escape_soql_string(content_document_id)}' "
            f"AND LinkedEntityId = '{escape_soql_string(opportunity_id)}'"
        )
        links = link_check.get("records") or []
        if not links:
            raise HTTPException(status_code=404, detail="File not found on this opportunity")
        success = await salesforce.delete_record("ContentDocumentLink", links[0]["Id"])
        if not success:
            raise HTTPException(status_code=400, detail="Salesforce rejected the unlink request")
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error unlinking file {content_document_id} from opportunity {opportunity_id}: {e}")
        raise sf_http_error(e, "file")




# ---------------------------------------------------------------------------
# Salesforce Files (ContentDocument / ContentDocumentLink) on Account
# ---------------------------------------------------------------------------


@app.get("/api/salesforce/accounts/{account_id}/files")
async def list_account_files(
    account_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """List SF Files attached to an Account via ContentDocumentLink."""
    validate_salesforce_id(account_id, "account_id")
    try:
        salesforce = client.salesforce
        soql = (
            "SELECT ContentDocumentId, ContentDocument.Title, "
            "ContentDocument.FileExtension, ContentDocument.ContentSize, "
            "ContentDocument.LatestPublishedVersionId, "
            "ContentDocument.CreatedDate, ContentDocument.CreatedBy.Name "
            "FROM ContentDocumentLink "
            f"WHERE LinkedEntityId = '{escape_soql_string(account_id)}' "
            "ORDER BY ContentDocument.CreatedDate DESC"
        )
        result = await salesforce.query(soql)
        records = result.get("records", []) or []
        return [
            {
                "content_document_id": r.get("ContentDocumentId"),
                "title": (r.get("ContentDocument") or {}).get("Title"),
                "extension": (r.get("ContentDocument") or {}).get("FileExtension"),
                "size_bytes": (r.get("ContentDocument") or {}).get("ContentSize"),
                "latest_version_id": (r.get("ContentDocument") or {}).get("LatestPublishedVersionId"),
                "created_date": (r.get("ContentDocument") or {}).get("CreatedDate"),
                "created_by": ((r.get("ContentDocument") or {}).get("CreatedBy") or {}).get("Name"),
            }
            for r in records
        ]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing files for account {account_id}: {e}")
        raise sf_http_error(e, "files")


@app.post("/api/salesforce/accounts/{account_id}/files")
async def upload_account_file(
    account_id: str,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Upload a file and attach it to an Account.

    Creates a ContentVersion with FirstPublishLocationId = account_id.
    SF handles the ContentDocument + ContentDocumentLink creation
    server-side, so this is a single API call.
    """
    import base64
    validate_salesforce_id(account_id, "account_id")
    try:
        body = await file.read()
        if len(body) > _MAX_FILE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large ({len(body)} bytes; max {_MAX_FILE_BYTES})",
            )
        if len(body) == 0:
            raise HTTPException(status_code=400, detail="Empty file")

        path_on_client = file.filename or "file"
        display_title = title or (path_on_client.rsplit(".", 1)[0] if "." in path_on_client else path_on_client)

        salesforce = client.salesforce
        result = await salesforce.create_record(
            "ContentVersion",
            {
                "Title": display_title,
                "PathOnClient": path_on_client,
                "VersionData": base64.b64encode(body).decode("ascii"),
                "FirstPublishLocationId": account_id,
            },
        )
        content_version_id = result.get("id") or result.get("Id")

        version_q = await salesforce.query(
            f"SELECT ContentDocumentId FROM ContentVersion WHERE Id = '{escape_soql_string(content_version_id)}'"
        )
        records = version_q.get("records", []) or []
        content_document_id = records[0].get("ContentDocumentId") if records else None

        return ApiResponse(
            success=True,
            data={
                "content_version_id": content_version_id,
                "content_document_id": content_document_id,
                "title": display_title,
                "size_bytes": len(body),
                "filename": path_on_client,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file to account {account_id}: {e}", exc_info=True)
        raise sf_http_error(e, "file")


@app.delete("/api/salesforce/accounts/{account_id}/files/{content_document_id}")
async def delete_account_file(
    account_id: str,
    content_document_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Unlink a file from this account.

    Deletes the ContentDocumentLink only — never the ContentDocument. The same
    document can be linked to other records; removing it here must not make it
    vanish everywhere. The document lives on in Salesforce Files.
    """
    validate_salesforce_id(account_id, "account_id")
    validate_salesforce_id(content_document_id, "content_document_id")
    try:
        salesforce = client.salesforce
        # Resolve the link row for THIS record — doubles as the guard that the
        # file actually belongs here (no unlinking arbitrary documents by id).
        link_check = await salesforce.query(
            f"SELECT Id FROM ContentDocumentLink "
            f"WHERE ContentDocumentId = '{escape_soql_string(content_document_id)}' "
            f"AND LinkedEntityId = '{escape_soql_string(account_id)}'"
        )
        links = link_check.get("records") or []
        if not links:
            raise HTTPException(status_code=404, detail="File not found on this account")
        success = await salesforce.delete_record("ContentDocumentLink", links[0]["Id"])
        if not success:
            raise HTTPException(status_code=400, detail="Salesforce rejected the unlink request")
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error unlinking file {content_document_id} from account {account_id}: {e}")
        raise sf_http_error(e, "file")




@app.get("/api/salesforce/opportunities/{opportunity_id}/payments")
async def get_opportunity_payments(
    opportunity_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth),
):
    """Get all payments for a specific opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        cache_key = f"opp-payments:{opportunity_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce
        query = f"""
        SELECT {PAYMENT_SOQL_FIELDS}
        FROM npe01__OppPayment__c
        WHERE npe01__Opportunity__c = '{opportunity_id}'
        ORDER BY npe01__Scheduled_Date__c ASC NULLS LAST
        """

        result = await salesforce.query(query)
        records = result.get("records", [])
        cache.set(cache_key, records, CACHE_TTL_OPPORTUNITIES)
        return records

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching payments for opportunity {opportunity_id}: {e}")
        raise sf_http_error(e, "records")


# ── ACV Summary: payments scheduled in FY from FY wins ──────────────────

@app.get("/api/salesforce/payments/acv-summary")
async def get_acv_summary(
    year: int = Query(..., ge=2000, le=2100),
    bucket: str = Query("all", regex="^(all|philanthropy|pbc|capital_grants|other)$"),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Sum of npe01__OppPayment__c amounts where:
      - Scheduled_Date falls in `year`
      - Related opp is Won
      - Related opp's CloseDate also falls in `year`

    Returns quarterly + annual totals for the Wins (ACV) row in the
    FY Overview matrix on the Dashboard.
    """
    cache_key = f"acv-summary:{year}:{bucket}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        bucket_clause = _cashflow_bucket_soql(bucket)
        won_stages = (
            "('Collecting / In Effect', 'Collecting', 'In Effect', "
            "'Closed Won', 'Closed / Completed', 'Closed / Fulfilled')"
        )
        soql = f"""
            SELECT npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
                   npe01__Opportunity__r.CloseDate
            FROM npe01__OppPayment__c
            WHERE npe01__Scheduled_Date__c >= {year}-01-01
            AND npe01__Scheduled_Date__c <= {year}-12-31
            AND npe01__Written_Off__c = false
            AND npe01__Opportunity__r.StageName IN {won_stages}
            AND npe01__Opportunity__r.CloseDate >= {year}-01-01
            AND npe01__Opportunity__r.CloseDate <= {year}-12-31
            {bucket_clause}
            LIMIT 2000
        """
        result = await salesforce.query(soql)
        records = result.get("records", [])

        q_totals = {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0}
        for r in records:
            amt = r.get("npe01__Payment_Amount__c") or 0
            opp = r.get("npe01__Opportunity__r") or {}
            close_date = opp.get("CloseDate")
            if not close_date or not amt:
                continue
            try:
                month = int(close_date[5:7])
                q = (month - 1) // 3 + 1
                q_totals[q] += amt
            except (ValueError, IndexError):
                continue

        summary = {
            "fy": sum(q_totals.values()),
            "q1": q_totals[1],
            "q2": q_totals[2],
            "q3": q_totals[3],
            "q4": q_totals[4],
        }
        cache.set(cache_key, summary, CACHE_TTL_OPPORTUNITIES)
        return summary

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching ACV summary for year {year}: {e}")
        raise sf_http_error(e, "records")


_VALID_CASHFLOW_BUCKETS = {"all", "philanthropy", "pbc", "capital_grants", "other"}


def _cashflow_bucket_soql(bucket: str) -> str:
    """Return a SOQL fragment to AND into a payment query so it only
    matches the requested record-type bucket.

    Every bucket carries the ISA exclusion — ISA opps are not in scope
    for bedrock's cashflow views.

    Buckets:
        all             — only ISA excluded
        philanthropy    — RecordType.Name = 'Philanthropy' AND not a Capital Grant
        capital_grants  — Philanthropy_Type__c = 'Capital Grant' (any RT, but in
                          practice all sit under Philanthropy)
        pbc             — RecordType.Name = 'PBC'
        other           — neither Philanthropy nor PBC nor ISA (includes NULL RT;
                          Capital Grants are excluded since they're RT=Philanthropy)
    """
    opp = "npe01__Opportunity__r"
    isa = f" AND {opp}.RecordType.Name != 'ISA'"
    if bucket == "all":
        return isa
    if bucket == "philanthropy":
        return (
            f" AND {opp}.RecordType.Name = 'Philanthropy' "
            f"AND ({opp}.Philanthropy_Type__c != 'Capital Grant' "
            f"OR {opp}.Philanthropy_Type__c = null)"
        )
    if bucket == "capital_grants":
        return (
            f" AND {opp}.Philanthropy_Type__c = 'Capital Grant'"
            + isa
        )
    if bucket == "pbc":
        return f" AND {opp}.RecordType.Name = 'PBC'"
    if bucket == "other":
        return (
            f" AND ({opp}.RecordType.Name = null OR "
            f"{opp}.RecordType.Name NOT IN ('Philanthropy', 'PBC', 'ISA')) "
            f"AND ({opp}.Philanthropy_Type__c != 'Capital Grant' "
            f"OR {opp}.Philanthropy_Type__c = null)"
        )
    return isa


@app.get("/api/salesforce/cashflow")
async def get_cashflow(
    year: int = Query(..., ge=2000, le=2100),
    bucket: str = Query("all", regex="^(all|philanthropy|pbc|capital_grants|other)$"),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Monthly cash flow for a given year.

    Returns 12 months with:
      - actuals: paid payments (npe01__Payment_Date__c) from won opps
      - scheduled: unpaid future payments (npe01__Scheduled_Date__c) from won opps
      - projected: open-pipeline payments weighted by opp probability

    Optional `bucket` filter restricts to a record-type bucket.
    """
    cache_key = f"cashflow:{year}:{bucket}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        # Stage filter is used for "scheduled" only (so we don't count
        # scheduled payments from open-pipeline opps as committed cash).
        # "Actuals" — Paid=true is sufficient: money in the bank doesn't
        # care about the opp's current stage.
        won_stages = (
            "('Collecting / In Effect', 'Collecting', 'In Effect', "
            "'Closed Won', 'Closed / Completed', 'Closed / Fulfilled')"
        )
        bucket_clause = _cashflow_bucket_soql(bucket)

        # Won-opp scheduled payments + ALL paid payments (any stage).
        soql_won = f"""
            SELECT npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
                   npe01__Paid__c, npe01__Payment_Date__c
            FROM npe01__OppPayment__c
            WHERE npe01__Written_Off__c = false
            AND (
                (npe01__Opportunity__r.StageName IN {won_stages}
                 AND npe01__Scheduled_Date__c >= {year}-01-01
                 AND npe01__Scheduled_Date__c <= {year}-12-31)
                OR
                (npe01__Paid__c = true
                 AND npe01__Payment_Date__c >= {year}-01-01
                 AND npe01__Payment_Date__c <= {year}-12-31)
            )
            {bucket_clause}
            LIMIT 2000
        """

        # Open-pipeline payments weighted by probability
        soql_open = f"""
            SELECT npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
                   npe01__Opportunity__r.Probability
            FROM npe01__OppPayment__c
            WHERE npe01__Written_Off__c = false
            AND npe01__Opportunity__r.IsClosed = false
            AND npe01__Opportunity__r.StageName NOT IN {won_stages}
            AND npe01__Scheduled_Date__c >= {year}-01-01
            AND npe01__Scheduled_Date__c <= {year}-12-31
            {bucket_clause}
            LIMIT 2000
        """

        won_result, open_result = await asyncio.gather(
            salesforce.query(soql_won),
            salesforce.query(soql_open),
        )

        months = {m: {"actuals": 0.0, "scheduled": 0.0, "projected": 0.0}
                  for m in range(1, 13)}

        # Today as YYYY-MM-DD; used to keep "actuals" strictly historical.
        # Without this, paid payments with future-dated Payment_Date (a
        # data-hygiene issue in SF where someone clicks Paid=true on a
        # row whose Payment_Date still equals the original scheduled date)
        # would show as future-month actuals on the dashboard.
        from datetime import date as _date
        today_iso = _date.today().isoformat()

        for r in won_result.get("records", []):
            amt = r.get("npe01__Payment_Amount__c") or 0
            if not amt:
                continue
            payment_date = r.get("npe01__Payment_Date__c")
            scheduled_date = r.get("npe01__Scheduled_Date__c")

            # "Actuals" means: money already in the bank, in the FY we're
            # asking about. Three conditions must hold:
            #   1. Paid=true
            #   2. Payment_Date is in the queried year (otherwise the
            #      record is here because of disjunct (1) — Won-stage
            #      payment scheduled this year — but the actual payment
            #      happened in a different year and belongs to that
            #      year's actuals, not ours)
            #   3. Payment_Date is on or before today (a future
            #      Payment_Date isn't an actual — treat as scheduled)
            year_prefix = f"{year}-"
            # Money already in the bank — any year, on/before today.
            already_received = (
                bool(r.get("npe01__Paid__c"))
                and payment_date
                and payment_date <= today_iso
            )
            is_actual_this_year = (
                already_received
                and payment_date.startswith(year_prefix)
            )

            if is_actual_this_year:
                date_str = payment_date
                key = "actuals"
            elif already_received:
                # Paid in a different year. Belongs to that year's
                # actuals, not this view's outstanding/scheduled.
                continue
            else:
                # Not yet received → scheduled. Only count if the
                # scheduled date is in this year.
                if not scheduled_date or not scheduled_date.startswith(year_prefix):
                    continue
                date_str = scheduled_date
                key = "scheduled"
            try:
                months[int(date_str[5:7])][key] += amt
            except (ValueError, KeyError):
                continue

        for r in open_result.get("records", []):
            amt = r.get("npe01__Payment_Amount__c") or 0
            date_str = r.get("npe01__Scheduled_Date__c")
            prob = (r.get("npe01__Opportunity__r") or {}).get("Probability") or 0
            if not amt or not date_str:
                continue
            try:
                months[int(date_str[5:7])]["projected"] += amt * (prob / 100)
            except (ValueError, KeyError):
                continue

        result = [
            {"month": m, **months[m]}
            for m in range(1, 13)
        ]
        cache.set(cache_key, result, CACHE_TTL_OPPORTUNITIES)
        return result

    except Exception as e:
        logger.error(f"Error fetching cashflow for year {year}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/salesforce/cashflow/detail")
async def get_cashflow_detail(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    type: str = Query(..., regex="^(actuals|scheduled|outstanding|projected)$"),
    bucket: str = Query("all", regex="^(all|philanthropy|pbc|capital_grants|other)$"),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Individual payment records for a specific cash flow cell."""
    cache_key = f"cashflow-detail:{year}:{month}:{type}:{bucket}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        # Same expanded won-stages list as the aggregate cashflow query.
        # Includes the correct "Closed / Completed" spelling and the
        # Collecting / In Effect / Fulfilled stages that produce paid
        # payments in practice.
        won_stages = (
            "('Collecting / In Effect', 'Collecting', 'In Effect', "
            "'Closed Won', 'Closed / Completed', 'Closed / Fulfilled')"
        )
        bucket_clause = _cashflow_bucket_soql(bucket)
        last_day = calendar.monthrange(year, month)[1]
        m_start = f"{year}-{month:02d}-01"
        m_end   = f"{year}-{month:02d}-{last_day:02d}"

        if type == "actuals":
            # Matches the aggregate's actuals rule: must be paid, with a
            # Payment_Date in the queried month AND on/before today. The
            # extra "<= today" clamp prevents the dashboard from listing
            # paid-but-future-dated payments under "actuals" (those will
            # show as scheduled instead).
            from datetime import date as _date
            today_iso = _date.today().isoformat()
            actuals_upper = min(m_end, today_iso)
            soql = f"""
                SELECT Id, npe01__Payment_Amount__c, npe01__Payment_Date__c,
                       npe01__Scheduled_Date__c,
                       npe01__Opportunity__c,
                       npe01__Opportunity__r.Name, npe01__Opportunity__r.StageName,
                       npe01__Opportunity__r.Account.Name
                FROM npe01__OppPayment__c
                WHERE npe01__Paid__c = true
                AND npe01__Written_Off__c = false
                AND npe01__Payment_Date__c >= {m_start}
                AND npe01__Payment_Date__c <= {actuals_upper}
                {bucket_clause}
                ORDER BY npe01__Payment_Date__c ASC
                LIMIT 500
            """
        elif type in ("scheduled", "outstanding"):
            # Outstanding/scheduled = won-stage payment scheduled in
            # the queried month whose money isn't already in the bank.
            # Excludes anything paid with a past Payment_Date (regardless
            # of year — if it's received, it's not outstanding). Future
            # Payment_Date counts as outstanding still (money not in yet).
            from datetime import date as _date
            today_iso = _date.today().isoformat()
            soql = f"""
                SELECT Id, npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
                       npe01__Paid__c, npe01__Payment_Date__c,
                       npe01__Opportunity__c,
                       npe01__Opportunity__r.Name, npe01__Opportunity__r.StageName,
                       npe01__Opportunity__r.Account.Name
                FROM npe01__OppPayment__c
                WHERE npe01__Written_Off__c = false
                AND npe01__Opportunity__r.StageName IN {won_stages}
                AND npe01__Scheduled_Date__c >= {m_start}
                AND npe01__Scheduled_Date__c <= {m_end}
                AND (
                    npe01__Paid__c = false
                    OR npe01__Payment_Date__c = null
                    OR npe01__Payment_Date__c > {today_iso}
                )
                {bucket_clause}
                ORDER BY npe01__Scheduled_Date__c ASC
                LIMIT 500
            """
        else:  # projected
            soql = f"""
                SELECT Id, npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
                       npe01__Opportunity__c,
                       npe01__Opportunity__r.Name, npe01__Opportunity__r.StageName,
                       npe01__Opportunity__r.Probability,
                       npe01__Opportunity__r.Account.Name
                FROM npe01__OppPayment__c
                WHERE npe01__Written_Off__c = false
                AND npe01__Opportunity__r.IsClosed = false
                AND npe01__Opportunity__r.StageName NOT IN {won_stages}
                AND npe01__Scheduled_Date__c >= {m_start}
                AND npe01__Scheduled_Date__c <= {m_end}
                {bucket_clause}
                ORDER BY npe01__Scheduled_Date__c ASC
                LIMIT 500
            """

        result = await salesforce.query(soql)
        records = []
        for r in result.get("records", []):
            opp = r.get("npe01__Opportunity__r") or {}
            prob = opp.get("Probability") or 0
            amt = r.get("npe01__Payment_Amount__c") or 0
            records.append({
                "payment_id": r.get("Id"),
                "opp_id": r.get("npe01__Opportunity__c"),
                "amount": amt,
                "weighted_amount": round(amt * prob / 100, 2) if type == "projected" else None,
                "probability": prob if type == "projected" else None,
                # Date column should reflect why this row is in the
                # selected cashflow cell. Actuals → the day it was paid.
                # Scheduled/outstanding/projected → the day it's scheduled
                # for (the date that put it in the column the user clicked).
                # The previous fallback `Payment_Date or Scheduled_Date`
                # caused scheduled rows with a stray non-null Payment_Date
                # to display the wrong month.
                "date": (
                    r.get("npe01__Payment_Date__c")
                    if type == "actuals"
                    else r.get("npe01__Scheduled_Date__c")
                ),
                "opp_name": opp.get("Name"),
                "account_name": (opp.get("Account") or {}).get("Name"),
                "stage": opp.get("StageName"),
            })

        cache.set(cache_key, records, 300)  # 5-min cache
        return records

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching cashflow detail: {e}")
        raise sf_http_error(e, "records")


# ── Update endpoints for Account, Contact, Payment ──────────────────────

class AccountUpdateRequest(BaseModel):
    updates: Dict[str, Any]
    reason: Optional[str] = None


class ContactUpdateRequest(BaseModel):
    updates: Dict[str, Any]
    reason: Optional[str] = None


class PaymentUpdateRequest(BaseModel):
    updates: Dict[str, Any]
    reason: Optional[str] = None


class PaymentCreateRequest(BaseModel):
    """Request body for single-record Payment create.

    Distinct from routes/payment_schedules.py's bulk CreatePaymentScheduleRequest,
    which wipes and re-creates every payment for an opportunity. This endpoint
    appends a single new npe01__OppPayment__c record to whatever already exists.

    Hardened 2026-04-21 post-adversarial review (PR #161): amount bounded and
    positive-only (blocks negative-amount exploit + NaN/Infinity); scheduled_date
    strict YYYY-MM-DD (blocks 10MB-string DoS + SOQL-payload fuzzing); extra
    fields forbidden (blocks field-injection probing).
    """
    opportunity_id: str
    amount: float
    scheduled_date: str  # YYYY-MM-DD
    payment_method: Optional[str] = None
    paid: bool = False

    class Config:
        extra = "forbid"

    @validator("amount")
    def _amount_positive_and_bounded(cls, v):
        import math
        if math.isnan(v) or math.isinf(v):
            raise ValueError("amount must be a finite number")
        if v <= 0:
            raise ValueError("amount must be greater than 0")
        # Sanity bound — no single payment should be larger than $1 trillion.
        # Catches accidental 1e308 / precision-loss attacks.
        if v > 1_000_000_000_000:
            raise ValueError("amount is unreasonably large")
        return v

    @validator("scheduled_date")
    def _scheduled_date_strict_iso(cls, v):
        from datetime import datetime as _dt
        if not isinstance(v, str) or len(v) != 10:
            raise ValueError("scheduled_date must be exactly YYYY-MM-DD")
        try:
            _dt.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("scheduled_date must be a valid YYYY-MM-DD date")
        return v

    @validator("payment_method")
    def _payment_method_bounded(cls, v):
        if v is None:
            return v
        if not isinstance(v, str):
            raise ValueError("payment_method must be a string")
        # SF picklist values max at 255 chars; anything larger is an attack
        # payload or a mistake.
        if len(v) > 255:
            raise ValueError("payment_method exceeds 255 chars")
        return v


async def _enforce_record_ownership(
    salesforce,
    sobject: str,
    record_id: str,
    user: Dict[str, Any],
    edit_all_perm: Optional[str] = None,
) -> None:
    """Raise HTTPException(403/404) unless `user` may mutate `record_id` on `sobject`.

    Generalized 2026-04-21 (PR #169) from the Opp-only helper shipped in PR #163
    so Account/Contact/Opportunity write endpoints share one ownership path.
    Payment write endpoints pass `sobject="Opportunity"` + the parent Opp's Id
    (resolved upstream) + `edit_all_perm="edit_all_opportunities"` — identical
    behavior to the prior helper.

    Bypass order (first match wins — no SF query):
      1. Service callers (`is_service=True`). check_permission_or_internal
         sets this without populating _permissions / _app_user, so the
         service-account branch MUST come first. Load-bearing for Pebble
         CRM-write against Account/Contact/Payment endpoints that use
         check_permission_or_internal; unreachable no-op for any future
         caller still gated on check_permission.
      2. Admin (`manage_users_roles`).
      3. Per-resource "edit-all" permission when the caller opts in
         (e.g. `edit_all_opportunities` for Opportunity and Payment).
         Account + Contact have no edit-all key in PERMISSION_KEYS
         (routes/permissions.py:19-34), so their callers pass `None` and
         get admin-only bypass.

    Otherwise: SOQL `SELECT OwnerId FROM {sobject} WHERE Id = '{safe_id}'`
    and compare against the caller's `sf_user_id`. 404 if the record is
    absent; 403 on OwnerId mismatch or when the user isn't linked to a
    Salesforce user (can't evaluate ownership — deny, safer than permit).
    """
    # 1. Service-account bypass — check_permission_or_internal sets is_service
    #    without populating _permissions / _app_user, so guard first.
    if user.get("is_service"):
        return
    perms = user.get("_permissions", {})
    # 2. Admin bypass (manage_users_roles).
    if perms.get("manage_users_roles", False):
        return
    # 3. Per-resource edit-all bypass (caller opt-in).
    if edit_all_perm and perms.get(edit_all_perm, False):
        return
    sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
    if not sf_user_id:
        raise HTTPException(
            status_code=403,
            detail=f"Cannot verify {sobject.lower()} ownership — user is not linked to a Salesforce user",
        )
    safe_id = escape_soql_string(record_id)
    result = await salesforce.query(
        f"SELECT OwnerId FROM {sobject} WHERE Id = '{safe_id}' LIMIT 1"
    )
    records = result.get("records", [])
    if not records:
        raise HTTPException(status_code=404, detail=f"{sobject} not found")
    if records[0].get("OwnerId") != sf_user_id:
        raise HTTPException(
            status_code=403,
            detail=f"You can only modify {sobject.lower()}s you own",
        )


@app.put("/api/salesforce/accounts/{account_id}")
@limiter.limit("30/minute")
async def update_account(
    request: Request,
    account_id: str,
    update_request: AccountUpdateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_accounts")),
):
    """Update a Salesforce account.

    Auth (PR #169 hardening): `check_permission_or_internal("edit_accounts")`
    is the outer gate — admits service callers (is_service=True) for Pebble
    CRM-write. Human path then runs `_enforce_record_ownership` on the
    Account — non-owner edits rejected unless the caller is admin
    (manage_users_roles). No edit-all-accounts bypass (no such key in
    PERMISSION_KEYS). Service callers short-circuit inside the helper.

    Rate-limited at 30/minute per IP to blunt compromised-account abuse.
    Errors sanitized — raw SF error text stays server-side.
    """
    validate_salesforce_id(account_id, "account_id")
    try:
        salesforce = client.salesforce
        # edit_all_accounts mirrors edit_all_opportunities: RMs steward the whole
        # portfolio, so non-owner edits are a permission, not an admin exception.
        await _enforce_record_ownership(
            salesforce, "Account", account_id, user, edit_all_perm="edit_all_accounts")
        # OwnerId reassignment gets its own key, mirroring reassign_opportunities.
        if "OwnerId" in update_request.updates:
            perms = user.get("_permissions", {})
            if not perms.get("manage_users_roles", False) and not perms.get("reassign_accounts", False):
                raise HTTPException(status_code=403, detail="You don't have permission to reassign accounts")
        # Drive_Strategy_Folder_URL__c renders back as an <a href> on the
        # account detail page — reject non-http(s) schemes (stored XSS vector).
        # Empty/None clears the field and is allowed.
        if update_request.updates.get("Drive_Strategy_Folder_URL__c"):
            validate_http_url(
                update_request.updates["Drive_Strategy_Folder_URL__c"],
                "Drive_Strategy_Folder_URL__c",
            )
        success = await salesforce.update_record("Account", account_id, update_request.updates)
        if not success:
            raise HTTPException(400, "Salesforce rejected the update")
        # For Active__c writes, read the field back immediately so the frontend
        # receives the server-authoritative value rather than assuming the write
        # persisted (Salesforce field-level security can silently ignore writes).
        confirmed: dict = {"id": account_id, "message": "Account updated"}
        if "Active__c" in update_request.updates:
            try:
                # get_record fetches by id only (no field list) — a SOQL select
                # is the cheap way to read one field back. The previous
                # three-arg get_record call raised TypeError on every request
                # and the bare except made the read-back silently dead.
                rec = await salesforce.query(
                    f"SELECT Active__c FROM Account WHERE Id = '{escape_soql_string(account_id)}' LIMIT 1"
                )
                records = rec.get("records") or []
                if records:
                    confirmed["Active__c"] = records[0].get("Active__c")
            except Exception:
                logger.warning("Active__c read-back failed for %s", account_id)
        # Auto-create a reminder task when the account is deprioritized or put on hold
        _deprioritizing = update_request.updates.get("Active__c") is False
        _on_hold = update_request.updates.get("Qualification_Status__c") == "Not Qualified"
        if _deprioritizing or _on_hold:
            try:
                owner_result = await salesforce.query(
                    f"SELECT OwnerId FROM Account WHERE Id = '{escape_soql_string(account_id)}' LIMIT 1"
                )
                owner_records = owner_result.get("records") or []
                if owner_records:
                    owner_id = owner_records[0]["OwnerId"]
                    today = date.today()
                    future_month = today.month + 6
                    due_year = today.year + (future_month - 1) // 12
                    due_month = (future_month - 1) % 12 + 1
                    due_day = min(today.day, calendar.monthrange(due_year, due_month)[1])
                    due_date = date(due_year, due_month, due_day)
                    date_str = f"{today.month}/{today.day}/{str(today.year)[2:]}"
                    task_fields = {
                        "Subject": (
                            f"Account was deprioritized or put on hold on {date_str}. "
                            "Please reevaluate if account status is still accurate."
                        ),
                        "ActivityDate": due_date.isoformat(),
                        "OwnerId": owner_id,
                        "WhatId": account_id,
                        "Status": "Not Started",
                        "Priority": "Normal",
                    }
                    task_result = await salesforce.create_record("Task", task_fields)
                    task_id = task_result.get("id") or task_result.get("Id")
                    if task_id:
                        await _verify_and_recover_task_fields(salesforce, task_id, task_fields)
                    cache.invalidate_prefix("account-tasks:")
            except Exception as e:
                logger.warning("Auto-task creation failed for account %s: %s", account_id, e)
        cache.invalidate_prefix("accounts:")
        logger.info(f"Account {account_id} updated by {user['user_id']}")
        return ApiResponse(success=True, data=confirmed)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating account {account_id}: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail="Failed to update account. Check server logs or contact support.",
        )


@app.delete("/api/salesforce/accounts/{account_id}")
@limiter.limit("30/minute")
async def delete_account(
    request: Request,
    account_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_accounts")),
):
    """Delete a Salesforce Account.

    Destructive and irreversible at the SF level — frontend caller
    (AccountEditDialog) surfaces a confirm-before-delete popover.

    Auth (PR #169): `check_permission_or_internal("edit_accounts")` outer
    gate + `_enforce_record_ownership` admin-or-owner check. No edit-all
    bypass (no such key in PERMISSION_KEYS — admin only). Service callers
    (is_service=True) short-circuit inside the helper.

    Cascade invalidation: child contacts + opps reference AccountId.
    """
    validate_salesforce_id(account_id, "account_id")
    try:
        salesforce = client.salesforce
        await _enforce_record_ownership(salesforce, "Account", account_id, user)
        success = await salesforce.delete_record("Account", account_id)
        if not success:
            raise HTTPException(400, "Salesforce rejected the delete")
        cache.invalidate_prefix("accounts:")
        # Child Contacts reference AccountId via the get_contacts SOQL join.
        cache.invalidate_prefix("contacts:")
        # Opps reference AccountId; opp list + Account-joined views stale.
        cache.invalidate_prefix("opps:")
        cache.invalidate_prefix("opportunities:")
        logger.info(f"Account {account_id} deleted by {user['user_id']}")
        return ApiResponse(
            success=True,
            data={"id": account_id, "message": "Account deleted"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting account {account_id}: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail="Failed to delete account. Check server logs or contact support.",
        )


@app.put("/api/salesforce/contacts/{contact_id}")
@limiter.limit("30/minute")
async def update_contact(
    request: Request,
    contact_id: str,
    update_request: ContactUpdateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_contacts")),
):
    """Update a Salesforce contact.

    Auth (PR #169 hardening): `check_permission_or_internal("edit_contacts")`
    is the outer gate — admits service callers (is_service=True) for Pebble
    CRM-write. Human path then runs `_enforce_record_ownership` on the
    Contact — non-owner edits rejected unless the caller is admin. No
    edit-all-contacts bypass (no such key in PERMISSION_KEYS).

    Rate-limited at 30/minute per IP. Errors sanitized.
    """
    validate_salesforce_id(contact_id, "contact_id")
    try:
        salesforce = client.salesforce
        await _enforce_record_ownership(salesforce, "Contact", contact_id, user)
        success = await salesforce.update_record("Contact", contact_id, update_request.updates)
        if not success:
            raise HTTPException(400, "Salesforce rejected the update")
        cache.invalidate_prefix("contacts:")
        logger.info(f"Contact {contact_id} updated by {user['user_id']}")
        return ApiResponse(success=True, data={"id": contact_id, "message": "Contact updated"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating contact {contact_id}: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail="Failed to update contact. Check server logs or contact support.",
        )


@app.delete("/api/salesforce/contacts/{contact_id}")
@limiter.limit("30/minute")
async def delete_contact(
    request: Request,
    contact_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_contacts")),
):
    """Delete a Salesforce Contact.

    Destructive and irreversible at the SF level — frontend caller
    (ContactEditDialog) surfaces a confirm-before-delete popover.

    Auth (PR #169): `check_permission_or_internal("edit_contacts")` outer
    gate + `_enforce_record_ownership` admin-or-owner check. No edit-all
    bypass (no such key in PERMISSION_KEYS). Service callers short-circuit.
    """
    validate_salesforce_id(contact_id, "contact_id")
    try:
        salesforce = client.salesforce
        await _enforce_record_ownership(salesforce, "Contact", contact_id, user)
        success = await salesforce.delete_record("Contact", contact_id)
        if not success:
            raise HTTPException(400, "Salesforce rejected the delete")
        # Task SOQL joins Who.Name when rendering Who-linked tasks; stale
        # cached entries would keep showing the deleted contact's name until
        # TTL. Cheap to evict these too.
        cache.invalidate_prefix("contacts:")
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("opportunity-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        logger.info(f"Contact {contact_id} deleted by {user['user_id']}")
        return ApiResponse(
            success=True,
            data={"id": contact_id, "message": "Contact deleted"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting contact {contact_id}: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail="Failed to delete contact. Check server logs or contact support.",
        )


@app.put("/api/salesforce/payments/{payment_id}")
@limiter.limit("30/minute")
async def update_payment(
    request: Request,
    payment_id: str,
    update_request: PaymentUpdateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_payments")),
):
    """Update a Salesforce payment (npe01__OppPayment__c).

    Auth: `check_permission_or_internal("edit_payments")` is the outer gate.
    Switched from `check_permission` in PR #169 so Pebble's future
    `pebble_crm_write` flow can reach Payment writes via the internal API key.
    User-path still runs `_enforce_record_ownership` on the payment's parent
    Opp — non-owner updates rejected unless admin or `edit_all_opportunities`.
    Service callers (is_service=True) short-circuit inside the helper.

    Rate-limited at 30/minute per IP so a compromised account with
    edit_payments can't bulk-update SF records."""
    validate_salesforce_id(payment_id, "payment_id")
    try:
        salesforce = client.salesforce
        # Ownership gate — same parent-lookup pattern as delete_payment.
        safe_id = escape_soql_string(payment_id)
        parent_result = await salesforce.query(
            f"SELECT npe01__Opportunity__c FROM npe01__OppPayment__c WHERE Id = '{safe_id}' LIMIT 1"
        )
        parent_records = parent_result.get("records", [])
        if not parent_records:
            raise HTTPException(status_code=404, detail="Payment not found")
        parent_opp_id = parent_records[0].get("npe01__Opportunity__c")
        if parent_opp_id:
            await _enforce_record_ownership(
                salesforce, "Opportunity", parent_opp_id, user, "edit_all_opportunities",
            )
        # Ownership OK — proceed with the update.
        success = await salesforce.update_record("npe01__OppPayment__c", payment_id, update_request.updates)
        if not success:
            raise HTTPException(400, "Salesforce rejected the update")
        # Rollup fields on the parent Opp may change when payment fields
        # (Amount, Paid, etc.) change — invalidate that cache too.
        cache.invalidate_prefix("payments:")
        cache.invalidate_prefix("opp-payments:")
        cache.invalidate_prefix("opportunities:")
        logger.info(f"Payment {payment_id} updated by {user['user_id']}")
        return ApiResponse(success=True, data={"id": payment_id, "message": "Payment updated"})
    except HTTPException:
        raise
    except Exception as e:
        # Sanitized client error; full detail server-side (matches POST/DELETE).
        logger.error(
            f"Error updating payment {payment_id}: {str(e)}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=400,
            detail="Failed to update payment. Check server logs or contact support.",
        )


@app.delete("/api/salesforce/payments/{payment_id}")
@limiter.limit("30/minute")
async def delete_payment(
    request: Request,
    payment_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_payments")),
):
    """Delete a Salesforce Payment (npe01__OppPayment__c).

    Destructive and irreversible at the SF level — the frontend caller
    (PaymentEditDialog) is expected to surface a confirm-before-delete
    dialog.

    Auth: `check_permission_or_internal("edit_payments")` is the outer gate.
    Switched from `check_permission` in PR #169 for Pebble CRM-write parity.
    This endpoint takes only `payment_id`, so we first resolve the parent Opp
    via a cheap SOQL query (also gives us a 404 if the payment doesn't exist),
    then defer to `_enforce_record_ownership` — non-owner deletes rejected
    unless admin or `edit_all_opportunities` (PR #163 hardening). Service
    callers (is_service=True) short-circuit inside the helper."""
    validate_salesforce_id(payment_id, "payment_id")
    try:
        salesforce = client.salesforce
        # Resolve parent Opp Id so we can run the ownership check. If the
        # payment doesn't exist at all, 404 out before attempting delete.
        safe_id = escape_soql_string(payment_id)
        parent_result = await salesforce.query(
            f"SELECT npe01__Opportunity__c FROM npe01__OppPayment__c WHERE Id = '{safe_id}' LIMIT 1"
        )
        parent_records = parent_result.get("records", [])
        if not parent_records:
            raise HTTPException(status_code=404, detail="Payment not found")
        parent_opp_id = parent_records[0].get("npe01__Opportunity__c")
        if parent_opp_id:
            await _enforce_record_ownership(
                salesforce, "Opportunity", parent_opp_id, user, "edit_all_opportunities",
            )
        # Ownership OK — proceed with the destructive action.
        success = await salesforce.delete_record("npe01__OppPayment__c", payment_id)
        if not success:
            raise HTTPException(400, "Salesforce rejected the delete")
        # Same cache-invalidation surface as create: rollup fields on the
        # parent Opportunity update when a payment goes away.
        cache.invalidate_prefix("payments:")
        cache.invalidate_prefix("opp-payments:")
        cache.invalidate_prefix("opportunities:")
        logger.info(f"Payment {payment_id} deleted by {user['user_id']}")
        return ApiResponse(
            success=True,
            data={"id": payment_id, "message": "Payment deleted"},
        )
    except HTTPException:
        raise
    except Exception as e:
        # Full detail server-side for debugging; generic message to the client
        # so we don't leak SF internal error text (field names, instance URLs,
        # rate-limit hints). See adversarial review notes on PR #161.
        logger.error(
            f"Error deleting payment {payment_id}: {str(e)}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=400,
            detail="Failed to delete payment. Check server logs or contact support.",
        )


@app.post("/api/salesforce/payments")
@limiter.limit("30/minute")
async def create_payment(
    request: Request,
    create_request: PaymentCreateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission_or_internal("edit_payments")),
):
    """Create a single Salesforce Payment (npe01__OppPayment__c) on an existing
    opportunity.

    Use this (not the bulk routes/payment_schedules.py POST) when appending
    one additional payment to whatever schedule already exists — no delete,
    no validation that the sum matches the Opportunity Amount. The Opp
    dialog's inline Payment Schedule accordion calls this on "+ Add Payment".

    Auth: `check_permission_or_internal("edit_payments")` is the outer gate.
    Switched from `check_permission` in PR #169 so Pebble's future
    `pebble_crm_write` flow can create payments via the internal API key.
    User-path then runs `_enforce_record_ownership` — non-owner writes
    rejected unless admin or `edit_all_opportunities` (PR #163 hardening).
    Service callers (is_service=True) short-circuit inside the helper.
    """
    validate_salesforce_id(create_request.opportunity_id, "opportunity_id")
    try:
        salesforce = client.salesforce
        # Ownership gate before any SF mutation.
        await _enforce_record_ownership(
            salesforce, "Opportunity", create_request.opportunity_id, user,
            "edit_all_opportunities",
        )
        fields: Dict[str, Any] = {
            "npe01__Opportunity__c": create_request.opportunity_id,
            "npe01__Payment_Amount__c": create_request.amount,
            "npe01__Scheduled_Date__c": create_request.scheduled_date,
            "npe01__Paid__c": create_request.paid,
        }
        if create_request.payment_method:
            fields["npe01__Payment_Method__c"] = create_request.payment_method
        result = await salesforce.create_record("npe01__OppPayment__c", fields)
        # Rollup fields on the parent Opp change when a new payment lands, so
        # invalidate both the payment caches and the opportunities cache.
        cache.invalidate_prefix("payments:")
        cache.invalidate_prefix("opp-payments:")
        cache.invalidate_prefix("opportunities:")
        logger.info(
            f"Payment created by {user['user_id']} on opp {create_request.opportunity_id}"
        )
        return ApiResponse(
            success=True,
            data={"id": result.get("id"), "message": "Payment created"},
        )
    except HTTPException:
        raise
    except Exception as e:
        # Full detail server-side for debugging; generic message to the client
        # so we don't leak SF internal error text (field names, instance URLs,
        # rate-limit hints). See adversarial review notes on PR #161.
        logger.error(
            f"Error creating payment on opp {create_request.opportunity_id}: {str(e)}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=400,
            detail="Failed to create payment. Check server logs or contact support.",
        )


@app.get("/api/salesforce/users")
async def get_users(
    limit: int = Query(1000, le=5000),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce users (active + inactive, grouped by IsActive).

    Filters to humans by excluding the well-known system / integration
    users by Name pattern: Security User, Chatter Expert, Insights /
    Integration / Analytics Cloud accounts, Automated Process, and
    Slackbot. A previous attempt to filter on UserLicense.Name = 'Salesforce'
    returned zero rows in Pursuit's org (their humans aren't on a
    license literally named "Salesforce"), so we go back to Name-based
    exclusion which is what the user actually called out.
    """
    try:
        cache_key = f"users:{limit}:name-exclude-v3"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        query = f"""
        SELECT Id, Name, Email, IsActive
        FROM User
        WHERE UserType = 'Standard'
        AND (NOT Name LIKE '%Integration%')
        AND (NOT Name LIKE '%Security User%')
        AND (NOT Name LIKE '%Chatter Expert%')
        AND (NOT Name LIKE 'Insights%')
        AND (NOT Name LIKE 'Slackbot%')
        AND (NOT Name LIKE 'Automated Process%')
        AND (NOT Name LIKE 'Platform Integration%')
        ORDER BY IsActive DESC, Name ASC
        LIMIT {limit}
        """

        result = await salesforce.query(query)
        users = result.get("records", [])
        cache.set(cache_key, users, CACHE_TTL_USERS)
        return users

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching users: {e}")
        raise sf_http_error(e, "records")


# ---------------------------------------------------------------------------
# My Tasks / Calendar endpoints (for My Priorities page)
# ---------------------------------------------------------------------------

@app.get("/api/salesforce/my-tasks")
async def get_my_tasks(
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    # Stays on salesforce.query() (not query_all): the WHERE clause
    # (IsClosed = false + optional date range) scope-bounds per-user open
    # Task counts well under 2000 at Pursuit's team-of-4 scale. Revisit if
    # any single user's open-Task count ever approaches the cap.
    limit: int = Query(2000, le=2000),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Get current user's Salesforce Tasks in a date range."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        cache_key = f"my-tasks:{start}:{end}:{limit}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        # Filter to real Tasks — exclude Email / Call / ListEmail / etc.
        # subtypes which clutter the view with auto-captured email
        # activity that has Subject = "true" or other garbage.
        where_clauses = [
            "IsClosed = false",
            "(TaskSubtype = 'Task' OR TaskSubtype = null)",
        ]
        if start:
            where_clauses.append(f"ActivityDate >= {start}")
        if end:
            where_clauses.append(f"ActivityDate <= {end}")

        where_sql = " AND ".join(where_clauses)
        query = f"""
        SELECT Id, Subject, ActivityDate, Status, Priority, WhatId, WhoId, Who.Name,
               OwnerId, Owner.Name, CreatedById, CreatedBy.Name, Description, CreatedDate, LastModifiedDate
        FROM Task
        WHERE {where_sql}
        ORDER BY ActivityDate ASC
        LIMIT {limit}
        """

        result = await salesforce.query(query)
        tasks = result.get("records", [])
        response = ApiResponse(success=True, data=tasks, meta={"count": len(tasks)})
        cache.set(cache_key, response, 120)  # 2 min TTL — tasks change frequently
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching tasks: {e}")
        raise sf_http_error(e, "records")


# ---------------------------------------------------------------------------
# Salesforce Task CRUD (linked to Opportunities)
# ---------------------------------------------------------------------------

class TaskCreateRequest(BaseModel):
    Subject: str
    Status: str = "Not Started"
    Priority: str = "Normal"
    ActivityDate: Optional[str] = None
    Description: Optional[str] = None
    OwnerId: Optional[str] = None
    # WhoId (Contact link) added PR #169 so RMs can assign tasks to specific
    # contacts from the TaskPanel Contact autocomplete. SF Task has both
    # WhoId (Contact/Lead) and WhatId (parent entity — Opp/Account/etc.);
    # WhatId is set from the URL path in create_opportunity_task, WhoId
    # from the body. The generic POST /api/salesforce/tasks endpoint
    # accepts both from the body so the Tasks page (no parent context)
    # and ContactExpandPanel (Contact-WhoId, optional opp/account WhatId)
    # can use one endpoint.
    WhoId: Optional[str] = None
    WhatId: Optional[str] = None


class TaskUpdateRequest(BaseModel):
    Subject: Optional[str] = None
    Status: Optional[str] = None
    Priority: Optional[str] = None
    ActivityDate: Optional[str] = None
    Description: Optional[str] = None
    OwnerId: Optional[str] = None
    WhatId: Optional[str] = None
    WhoId: Optional[str] = None


class TaskDuplicateRequest(BaseModel):
    WhatId: Optional[str] = None  # Opportunity to link the duplicate to


@app.get("/api/salesforce/opportunities/{opportunity_id}/tasks")
async def get_opportunity_tasks(
    opportunity_id: str,
    # Default `None` returns all Tasks for the opportunity via query_all
    # pagination. `le=2000` caps callers that request an explicit limit.
    limit: Optional[int] = Query(None, le=2000),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Get all tasks linked to a specific opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        salesforce = client.salesforce
        # TaskSubtype filter — drop Email / Call / ListEmail subtypes
        # that get auto-captured by integrations with Subject = "true".
        query = f"""
        SELECT Id, Subject, Status, Priority, ActivityDate, Description,
               IsClosed, OwnerId, Owner.Name, WhoId, Who.Name, WhatId,
               Type, TaskSubtype,
               CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
        FROM Task
        WHERE WhatId = '{opportunity_id}'
          AND (TaskSubtype = 'Task' OR TaskSubtype = null)
        ORDER BY ActivityDate DESC NULLS LAST
        """
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        tasks = result.get("records", [])

        formatted = []
        for t in tasks:
            formatted.append({
                "Id": t.get("Id"),
                "Subject": t.get("Subject"),
                "Status": t.get("Status"),
                "Priority": t.get("Priority"),
                "ActivityDate": t.get("ActivityDate"),
                "Description": t.get("Description"),
                "IsClosed": t.get("IsClosed"),
                "OwnerId": t.get("OwnerId"),
                "OwnerName": (t.get("Owner") or {}).get("Name"),
                "WhoId": t.get("WhoId"),
                "WhoName": (t.get("Who") or {}).get("Name"),
                "Type": t.get("Type"),
                "TaskSubtype": t.get("TaskSubtype"),
                "CreatedById": t.get("CreatedById"),
                "CreatedByName": (t.get("CreatedBy") or {}).get("Name"),
                "CreatedDate": t.get("CreatedDate"),
                "LastModifiedDate": t.get("LastModifiedDate"),
                "WhatId": t.get("WhatId"),
            })

        return ApiResponse(success=True, data=formatted, meta={"count": len(formatted)})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching opportunity tasks: {e}")
        raise sf_http_error(e, "records")


@app.post("/api/salesforce/opportunities/{opportunity_id}/tasks")
async def create_opportunity_task(
    opportunity_id: str,
    task_data: TaskCreateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("create_tasks")),
    db=Depends(get_db),
):
    """Create a new task linked to an opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        # Check if the target opportunity is locked
        lock = await db.fetchrow(
            "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
        )
        if lock:
            perms = user.get("_permissions", {})
            sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
            if lock["locked_by"] != sf_user_id and not perms.get("manage_users_roles", False):
                raise HTTPException(403, "Cannot create tasks on a locked opportunity")
        salesforce = client.salesforce
        # B10 defensive fix (PR #169): reverse the dict-spread order so the
        # URL path param wins over any WhatId a client might send in the body.
        # TaskCreateRequest doesn't currently declare WhatId, and Pydantic's
        # default extra="ignore" filters unknowns — but an override here would
        # bind the task to the wrong opp silently. Belt-and-suspenders.
        fields = {**task_data.model_dump(exclude_none=True), "WhatId": opportunity_id}
        result = await salesforce.create_record("Task", fields)
        task_id = result.get("id") or result.get("Id")
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("account-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        cache.invalidate_prefix("user-tasks:")

        verify = await _verify_and_recover_task_fields(salesforce, task_id, fields)
        return ApiResponse(
            success=True,
            data={
                "id": task_id,
                "message": "Task created",
                "saved_subject": verify["saved"].get("Subject"),
                "subject_clobbered": "Subject" in verify["clobbered"],
                "clobbered_fields": list(verify["clobbered"].keys()),
                "saved_values": verify["saved"],
            },
        )
    except Exception as e:
        logger.error(f"Error creating task: {e}")
        raise sf_http_error(e, "task")


@app.get("/api/salesforce/accounts/{account_id}/tasks")
async def get_account_tasks(
    account_id: str,
    limit: Optional[int] = Query(None, le=2000),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Tasks where WhatId is the account directly OR any of the account's
    opportunities. SF Task.WhatId is a polymorphic lookup, so a single
    SOQL with `WhatId IN (...)` covers both kinds in one round-trip.

    Cached server-side (60s) — the account-detail page hits this on every
    navigation, and SF tasks change far less than once a minute. Any
    task mutation invalidates the prefix.
    """
    validate_salesforce_id(account_id, "account_id")
    try:
        salesforce = client.salesforce

        cache_key = f"account-tasks:{account_id}:{limit or 'all'}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        # Resolve the account's opportunity ids first; we need them for the
        # WhatId IN (...) clause so opp-scoped tasks surface alongside
        # account-scoped ones.
        opp_query = f"""
        SELECT Id FROM Opportunity WHERE AccountId = '{account_id}'
        """
        opp_result = await salesforce.query_all(opp_query)
        opp_ids = [r["Id"] for r in opp_result.get("records", [])]

        # SOQL accepts up to 1000 ids in IN; cap defensively.
        whatids = [account_id] + opp_ids[:999]
        whatid_list = ",".join(f"'{wid}'" for wid in whatids)
        query = f"""
        SELECT Id, Subject, Status, Priority, ActivityDate, Description,
               IsClosed, OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
               Type, TaskSubtype,
               CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
        FROM Task
        WHERE WhatId IN ({whatid_list})
          AND (TaskSubtype = 'Task' OR TaskSubtype = null)
        ORDER BY ActivityDate DESC NULLS LAST
        """
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        tasks = result.get("records", [])

        formatted = []
        for t in tasks:
            formatted.append({
                "Id": t.get("Id"),
                "Subject": t.get("Subject"),
                "Status": t.get("Status"),
                "Priority": t.get("Priority"),
                "ActivityDate": t.get("ActivityDate"),
                "Description": t.get("Description"),
                "IsClosed": t.get("IsClosed"),
                "OwnerId": t.get("OwnerId"),
                "OwnerName": (t.get("Owner") or {}).get("Name"),
                "WhoId": t.get("WhoId"),
                "WhoName": (t.get("Who") or {}).get("Name"),
                "WhatId": t.get("WhatId"),
                "WhatName": (t.get("What") or {}).get("Name"),
                "Type": t.get("Type"),
                "TaskSubtype": t.get("TaskSubtype"),
                "CreatedById": t.get("CreatedById"),
                "CreatedByName": (t.get("CreatedBy") or {}).get("Name"),
                "CreatedDate": t.get("CreatedDate"),
                "LastModifiedDate": t.get("LastModifiedDate"),
            })

        response = ApiResponse(success=True, data=formatted, meta={"count": len(formatted)})
        cache.set(cache_key, response, ttl_seconds=60)
        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching account tasks: {e}")
        raise sf_http_error(e, "records")


@app.get("/api/salesforce/users/{owner_id}/tasks")
async def get_user_tasks(
    owner_id: str,
    limit: Optional[int] = Query(None, le=2000),
    include_closed: bool = Query(False),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Tasks owned by this Salesforce user (Task.OwnerId = owner_id).

    Open-only by default; `include_closed=true` returns completed/cancelled
    tasks too (used by the homebase "Show done" toggle). Cached server-side
    (60s) keyed on the include_closed flag so the two variants don't
    collide.
    """
    validate_salesforce_id(owner_id, "owner_id")
    try:
        salesforce = client.salesforce

        cache_key = f"user-tasks:{owner_id}:{limit or 'all'}:closed={include_closed}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        closed_clause = "" if include_closed else "AND IsClosed = false"
        query = f"""
        SELECT Id, Subject, Status, Priority, ActivityDate, Description,
               IsClosed, OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
               Type, TaskSubtype,
               CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
        FROM Task
        WHERE OwnerId = '{owner_id}' {closed_clause}
          AND (TaskSubtype = 'Task' OR TaskSubtype = null)
        ORDER BY ActivityDate ASC NULLS LAST
        """
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        tasks = result.get("records", [])

        formatted = []
        for t in tasks:
            formatted.append({
                "Id": t.get("Id"),
                "Subject": t.get("Subject"),
                "Status": t.get("Status"),
                "Priority": t.get("Priority"),
                "ActivityDate": t.get("ActivityDate"),
                "Description": t.get("Description"),
                "IsClosed": t.get("IsClosed"),
                "OwnerId": t.get("OwnerId"),
                "OwnerName": (t.get("Owner") or {}).get("Name"),
                "WhoId": t.get("WhoId"),
                "WhoName": (t.get("Who") or {}).get("Name"),
                "WhatId": t.get("WhatId"),
                "WhatName": (t.get("What") or {}).get("Name"),
                "Type": t.get("Type"),
                "TaskSubtype": t.get("TaskSubtype"),
                "CreatedById": t.get("CreatedById"),
                "CreatedByName": (t.get("CreatedBy") or {}).get("Name"),
                "CreatedDate": t.get("CreatedDate"),
                "LastModifiedDate": t.get("LastModifiedDate"),
            })

        response = ApiResponse(success=True, data=formatted, meta={"count": len(formatted)})
        cache.set(cache_key, response, ttl_seconds=60)
        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching user tasks: {e}")
        raise sf_http_error(e, "records")


@app.get("/api/salesforce/contacts/{contact_id}/tasks")
async def get_contact_tasks(
    contact_id: str,
    limit: Optional[int] = Query(None, le=2000),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Tasks where the SF Task.WhoId points at this contact.

    Mirrors the get_account_tasks endpoint shape so the frontend's
    TaskListTab can render the result without any per-call adapter.
    Cached server-side (60s); any task mutation invalidates the
    `contact-tasks:` prefix the same way other task caches do.
    """
    validate_salesforce_id(contact_id, "contact_id")
    try:
        salesforce = client.salesforce

        cache_key = f"contact-tasks:{contact_id}:{limit or 'all'}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        query = f"""
        SELECT Id, Subject, Status, Priority, ActivityDate, Description,
               IsClosed, OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
               Type, TaskSubtype,
               CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
        FROM Task
        WHERE WhoId = '{contact_id}'
          AND (TaskSubtype = 'Task' OR TaskSubtype = null)
        ORDER BY ActivityDate DESC NULLS LAST
        """
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        tasks = result.get("records", [])

        formatted = []
        for t in tasks:
            formatted.append({
                "Id": t.get("Id"),
                "Subject": t.get("Subject"),
                "Status": t.get("Status"),
                "Priority": t.get("Priority"),
                "ActivityDate": t.get("ActivityDate"),
                "Description": t.get("Description"),
                "IsClosed": t.get("IsClosed"),
                "OwnerId": t.get("OwnerId"),
                "OwnerName": (t.get("Owner") or {}).get("Name"),
                "WhoId": t.get("WhoId"),
                "WhoName": (t.get("Who") or {}).get("Name"),
                "WhatId": t.get("WhatId"),
                "WhatName": (t.get("What") or {}).get("Name"),
                "Type": t.get("Type"),
                "TaskSubtype": t.get("TaskSubtype"),
                "CreatedById": t.get("CreatedById"),
                "CreatedByName": (t.get("CreatedBy") or {}).get("Name"),
                "CreatedDate": t.get("CreatedDate"),
                "LastModifiedDate": t.get("LastModifiedDate"),
            })

        response = ApiResponse(success=True, data=formatted, meta={"count": len(formatted)})
        cache.set(cache_key, response, ttl_seconds=60)
        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching contact tasks: {e}")
        raise sf_http_error(e, "records")


# Fields we read back when verifying a Task write. Anything we let the
# user edit needs to be in this list — when SF's saved value differs
# from the user's intent, we retry once and then surface a clobber flag.
_TASK_VERIFY_FIELDS: List[str] = [
    "Subject", "Description", "Status", "Priority",
    "ActivityDate", "OwnerId", "WhoId", "WhatId",
]


def _date_to_iso(value: Any) -> Any:
    """SF returns ActivityDate as `2026-05-30`, our request body sends
    the same string — so == works. Numeric fields would need normalization
    but for now we only have string and bool fields among _TASK_VERIFY_FIELDS."""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def _values_equivalent(intended: Any, saved: Any) -> bool:
    """Tolerant equality for SF round-trip comparison.

    Salesforce silently trims trailing whitespace on string field saves
    (and sometimes leading too). It also normalizes empty values: "" or
    "   " round-trip back as None on read. Treat those as no-ops, not
    clobbers — otherwise we'd pester users about cosmetic differences
    every time they hit return at the end of a description."""
    saved = _date_to_iso(saved)
    if isinstance(intended, str) or isinstance(saved, str):
        a = (intended or "").strip() if intended is not None else ""
        b = (saved or "").strip() if saved is not None else ""
        return a == b
    return intended == saved


async def _verify_and_recover_task_fields(
    salesforce,
    task_id: str,
    intended: Dict[str, Any],
) -> Dict[str, Any]:
    """Read back the Task and compare each intended field with what SF
    saved. If anything differs, send one UPDATE to restore the user's
    intent and re-read. Returns a dict::

        {
          "saved": {<field>: <saved_value>, ...},   # what SF stores now
          "clobbered": {<field>: <saved>, ...},     # fields still wrong
        }

    The frontend uses ``clobbered`` to surface a visible warning so a
    Salesforce admin can find the offending Apex Trigger / Flow.
    """
    if not task_id or not intended:
        return {"saved": {}, "clobbered": {}}

    fields_to_check = [f for f in _TASK_VERIFY_FIELDS if f in intended]
    if not fields_to_check:
        return {"saved": {}, "clobbered": {}}

    safe_id = escape_soql_string(task_id)
    select_clause = ", ".join(fields_to_check)

    async def _read() -> Dict[str, Any]:
        try:
            res = await salesforce.query(
                f"SELECT Id, {select_clause} FROM Task WHERE Id = '{safe_id}' LIMIT 1"
            )
            rows = res.get("records") or []
            return rows[0] if rows else {}
        except Exception as e:
            logger.warning("Task %s read-back failed: %s", task_id, e)
            return {}

    saved = await _read()
    diff: Dict[str, Any] = {}
    for f in fields_to_check:
        if not _values_equivalent(intended[f], saved.get(f)):
            diff[f] = saved.get(f)

    if diff:
        logger.warning(
            "Task %s — SF clobbered %s; intended=%r saved=%r — retrying once.",
            task_id, list(diff.keys()),
            {k: intended[k] for k in diff},
            diff,
        )
        try:
            await salesforce.update_record(
                "Task", task_id, {k: intended[k] for k in diff},
            )
            saved = await _read()
            diff = {
                f: saved.get(f)
                for f in fields_to_check
                if not _values_equivalent(intended[f], saved.get(f))
            }
        except Exception as retry_err:
            logger.warning("Task %s clobber-retry failed: %s", task_id, retry_err)

    if diff:
        logger.error(
            "Task %s still clobbered after retry: %r — likely an Apex Trigger "
            "or Flow that needs an admin fix.",
            task_id, diff,
        )

    return {
        "saved": {f: saved.get(f) for f in fields_to_check},
        "clobbered": diff,
    }


@app.post("/api/salesforce/accounts/{account_id}/tasks")
async def create_account_task(
    account_id: str,
    task_data: TaskCreateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("create_tasks")),
):
    """Create a task tied directly to an Account (WhatId = account_id).
    Account-level tasks aren't lock-gated the way opp-level ones are —
    locking lives on Opportunity in this org.

    Subject preservation:
        Some SF orgs run a Process Builder / Flow / Apex Trigger that
        rewrites Task.Subject on insert (e.g. "[Account Name]"). After
        creating, we read back the Subject and — if it's different from
        what the user asked for — send an UPDATE to restore the user's
        intent. If the rewrite still wins after the retry, log loudly
        and surface a partial-success response so the frontend can show
        a "saved but renamed" hint.
    """
    validate_salesforce_id(account_id, "account_id")
    try:
        salesforce = client.salesforce
        # Path param wins (same defensive ordering as create_opportunity_task)
        fields = {**task_data.model_dump(exclude_none=True), "WhatId": account_id}
        result = await salesforce.create_record("Task", fields)
        task_id = result.get("id") or result.get("Id")
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("account-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        cache.invalidate_prefix("user-tasks:")

        verify = await _verify_and_recover_task_fields(salesforce, task_id, fields)
        return ApiResponse(
            success=True,
            data={
                "id": task_id,
                "message": "Task created",
                "saved_subject": verify["saved"].get("Subject"),
                "subject_clobbered": "Subject" in verify["clobbered"],
                "clobbered_fields": list(verify["clobbered"].keys()),
                "saved_values": verify["saved"],
            },
        )
    except Exception as e:
        logger.error(f"Error creating account task: {e}")
        raise sf_http_error(e, "task")


@app.post("/api/salesforce/tasks")
async def create_task(
    task_data: TaskCreateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("create_tasks")),
):
    """Generic Task creation. Accepts WhoId (Contact/Lead) and/or WhatId
    (Opportunity/Account/etc.) from the body — both optional, so this
    can mint a parent-less "My Tasks" entry too. The opp- and account-
    scoped POSTs above remain for path-driven creation; this endpoint
    backs ContactExpandPanel's add-task row and the Home / My Tasks page
    where the user picks the parent via UI rather than route.

    Salesforce ID validation: only the fields actually present in the
    body are validated. An empty / missing WhoId or WhatId is fine.
    """
    try:
        salesforce = client.salesforce
        fields = task_data.model_dump(exclude_none=True)
        if fields.get("WhoId"):
            validate_salesforce_id(fields["WhoId"], "WhoId")
        if fields.get("WhatId"):
            validate_salesforce_id(fields["WhatId"], "WhatId")
        result = await salesforce.create_record("Task", fields)
        task_id = result.get("id") or result.get("Id")
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("opportunity-tasks:")
        cache.invalidate_prefix("account-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        cache.invalidate_prefix("user-tasks:")

        verify = await _verify_and_recover_task_fields(salesforce, task_id, fields)
        return ApiResponse(
            success=True,
            data={
                "id": task_id,
                "message": "Task created",
                "saved_subject": verify["saved"].get("Subject"),
                "subject_clobbered": "Subject" in verify["clobbered"],
                "clobbered_fields": list(verify["clobbered"].keys()),
                "saved_values": verify["saved"],
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating task: {e}")
        raise sf_http_error(e, "task")


@app.put("/api/salesforce/tasks/{task_id}")
async def update_task(
    task_id: str,
    updates: TaskUpdateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("edit_own_tasks")),
    db=Depends(get_db),
):
    """Update an existing Salesforce task. Respects opportunity locks."""
    validate_salesforce_id(task_id, "task_id")
    try:
        salesforce = client.salesforce
        # Server-side lock resolution — fetches task's actual WhatId + OwnerId from SF
        lock_info = await resolve_task_lock(task_id, user, db, salesforce)

        fields = updates.model_dump(exclude_none=True)
        if not fields:
            raise HTTPException(status_code=400, detail="No fields to update")

        if lock_info["is_locked"]:
            if lock_info["is_lock_owner"] or lock_info["is_admin"]:
                pass  # Full access
            elif lock_info["is_task_owner"]:
                # Task owner: allow field updates but BLOCK WhatId changes
                if updates.WhatId and updates.WhatId != lock_info["what_id"]:
                    raise HTTPException(403, "Cannot move task from a locked opportunity")
                fields.pop("WhatId", None)  # Strip WhatId to prevent relocation
            else:
                raise HTTPException(403, "This task's opportunity is locked")

        await salesforce.update_record("Task", task_id, fields)
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("account-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        cache.invalidate_prefix("user-tasks:")

        verify = await _verify_and_recover_task_fields(salesforce, task_id, fields)
        return ApiResponse(
            success=True,
            data={
                "message": "Task updated",
                "clobbered_fields": list(verify["clobbered"].keys()),
                "saved_values": verify["saved"],
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating task: {e}")
        raise sf_http_error(e, "task")


@app.delete("/api/salesforce/tasks/{task_id}")
async def delete_task(
    task_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("edit_own_tasks")),
    db=Depends(get_db),
):
    """Delete a Salesforce task. Blocked on locked opportunities."""
    validate_salesforce_id(task_id, "task_id")
    try:
        salesforce = client.salesforce
        # Check if task's opportunity is locked — only lock owner + admin can delete
        lock_info = await resolve_task_lock(task_id, user, db, salesforce)
        if lock_info["is_locked"] and not lock_info["is_lock_owner"] and not lock_info["is_admin"]:
            raise HTTPException(403, "Cannot delete tasks from a locked opportunity")
        await salesforce.delete_record("Task", task_id)
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("account-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        cache.invalidate_prefix("user-tasks:")
        return ApiResponse(success=True, data={"message": "Task deleted"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting task: {e}")
        raise sf_http_error(e, "task")


@app.post("/api/salesforce/tasks/{task_id}/duplicate")
async def duplicate_task(
    task_id: str,
    body: TaskDuplicateRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("create_tasks")),
    db=Depends(get_db),
):
    """Duplicate a Salesforce task, optionally linking to a different opportunity."""
    validate_salesforce_id(task_id, "task_id")
    if body.WhatId is not None:
        validate_salesforce_id(body.WhatId, "WhatId")
    try:
        salesforce = client.salesforce
        # Check if source task's opportunity is locked
        lock_info = await resolve_task_lock(task_id, user, db, salesforce)
        if lock_info["is_locked"] and not lock_info["is_lock_owner"] and not lock_info["is_admin"]:
            raise HTTPException(403, "Cannot duplicate tasks from a locked opportunity")
        # Check if destination opportunity is locked
        dest_opp = body.WhatId
        if dest_opp:
            dest_lock = await db.fetchrow(
                "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", dest_opp
            )
            if dest_lock:
                perms = user.get("_permissions", {})
                sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
                if dest_lock["locked_by"] != sf_user_id and not perms.get("manage_users_roles", False):
                    raise HTTPException(403, "Cannot duplicate tasks to a locked opportunity")
        # Fetch the original task
        safe_id = escape_soql_string(task_id)
        result = await salesforce.query(
            f"SELECT Subject, Status, Priority, ActivityDate, Description, OwnerId, WhatId "
            f"FROM Task WHERE Id = '{safe_id}'"
        )
        records = result.get("records", [])
        if not records:
            raise HTTPException(status_code=404, detail="Task not found")
        original = records[0]
        # Build the new task fields, copying from original
        fields = {
            "Subject": original.get("Subject", ""),
            "Status": original.get("Status", "Not Started"),
            "Priority": original.get("Priority", "Normal"),
        }
        if original.get("ActivityDate"):
            fields["ActivityDate"] = original["ActivityDate"]
        if original.get("Description"):
            fields["Description"] = original["Description"]
        if original.get("OwnerId"):
            fields["OwnerId"] = original["OwnerId"]
        # Use provided WhatId or keep original
        if body.WhatId is not None:
            fields["WhatId"] = body.WhatId
        elif original.get("WhatId"):
            fields["WhatId"] = original["WhatId"]
        new_task = await salesforce.create_record("Task", fields)
        new_id = new_task.get("id") or new_task.get("Id")
        cache.invalidate_prefix("my-tasks:")
        cache.invalidate_prefix("account-tasks:")
        cache.invalidate_prefix("contact-tasks:")
        cache.invalidate_prefix("user-tasks:")
        return ApiResponse(success=True, data={"id": new_id, "message": "Task duplicated"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error duplicating task: {e}")
        raise sf_http_error(e, "task")


@app.get("/api/calendar/my-events")
async def get_my_calendar_events(
    request: Request,
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    limit: int = Query(100, le=200),
    calendar_id: Optional[str] = Query(None, description="Calendar ID"),
    user=Depends(require_auth),
):
    """Get Google Calendar events from the PBD shared calendar using per-user OAuth credentials."""
    # Restrict to PBD calendar only
    if not calendar_id or calendar_id == "primary" or calendar_id != PBD_CALENDAR_ID:
        return {
            "data": [],
            "total": 0,
            "error": "Calendar ID mismatch — only the PBD shared calendar is supported.",
        }

    try:
        email = user.get("email")
        if not email:
            return {"data": [], "total": 0, "error": "No email in user profile.", "needs_reauth": True}

        creds = get_google_credentials(email, request)
        if not creds:
            return {
                "data": [],
                "total": 0,
                "error": "Google tokens not available. Please re-login to grant Calendar access.",
                "needs_reauth": True,
            }

        from googleapiclient.discovery import build

        loop = asyncio.get_event_loop()

        def _fetch_events():
            service = build("calendar", "v3", credentials=creds)
            params = {
                "calendarId": calendar_id,
                "maxResults": limit,
                "singleEvents": True,
                "orderBy": "startTime",
            }
            if start:
                params["timeMin"] = start if "T" in start else f"{start}T00:00:00Z"
            if end:
                params["timeMax"] = end if "T" in end else f"{end}T23:59:59Z"
            result = service.events().list(**params).execute()
            return result.get("items", [])

        raw_events = await loop.run_in_executor(None, _fetch_events)

        events = []
        for ev in raw_events:
            s = ev.get("start", {})
            e = ev.get("end", {})
            events.append({
                "id": ev.get("id"),
                "summary": ev.get("summary", "(No title)"),
                "start": s.get("dateTime") or s.get("date"),
                "end": e.get("dateTime") or e.get("date"),
                "attendees": [
                    {"email": a.get("email"), "name": a.get("displayName"), "status": a.get("responseStatus")}
                    for a in ev.get("attendees", [])
                ],
                "location": ev.get("location"),
                "description": (ev.get("description") or "")[:300],
                "status": ev.get("status"),
                "htmlLink": ev.get("htmlLink"),
            })

        return {"data": events, "total": len(events)}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Calendar my-events error: {e}")
        err_str = str(e).lower()
        if "invalid_grant" in err_str or "token" in err_str or "credentials" in err_str:
            return {
                "data": [],
                "total": 0,
                "error": "Calendar token expired. Please re-login.",
                "needs_reauth": True,
            }
        # Return structured error instead of 500 so frontend can display it
        return {
            "data": [],
            "total": 0,
            "error": f"Calendar error: {e}",
        }


# Sage Intacct endpoints

@app.get("/api/intacct/invoices", response_model=List[IntacctInvoice])
async def get_invoices(
    customer_id: Optional[str] = None,
    limit: int = Query(100, le=1000),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth)
):
    """Get Sage Intacct invoices."""
    try:
        intacct = client.sage_intacct
        
        result = await intacct.get_invoices(customer_id=customer_id, limit=limit)
        
        invoices = []
        if result.get("success") and result.get("data"):
            invoice_data = result["data"] if isinstance(result["data"], list) else [result["data"]]
            for record in invoice_data:
                invoices.append(IntacctInvoice(**record))
        
        return invoices
        
    except Exception as e:
        logger.error(f"Error fetching invoices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/intacct/invoices")
async def create_invoice(
    invoice_request: InvoiceCreationRequest,
    background_tasks: BackgroundTasks,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(check_permission("create_sage_invoices"))
):
    """Create a new invoice in Sage Intacct."""
    try:
        intacct = client.sage_intacct
        
        # Prepare invoice data
        invoice_data = {
            "customer_id": invoice_request.customer_id,
            "date_created": datetime.now().strftime("%m/%d/%Y"),
            "line_items": invoice_request.line_items
        }
        
        result = await intacct.create_invoice(invoice_data)
        
        if result.get("success"):
            # Schedule background task to update opportunity mapping
            background_tasks.add_task(
                update_opportunity_invoice_mapping,
                invoice_request.opportunity_id,
                result.get("data", {}).get("RECORDNO"),
                user["user_id"]
            )
            
            return ApiResponse(
                success=True,
                data={"invoice_id": result.get("data", {}).get("RECORDNO"), "message": "Invoice created successfully"},
            )
        else:
            raise HTTPException(
                status_code=400, 
                detail=f"Failed to create invoice: {result.get('errors', ['Unknown error'])}"
            )
            
    except Exception as e:
        logger.error(f"Error creating invoice: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/intacct/payments", response_model=List[IntacctPayment])
async def get_payments(
    customer_id: Optional[str] = None,
    limit: int = Query(100, le=1000),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user = Depends(require_auth)
):
    """Get Sage Intacct payments."""
    try:
        intacct = client.sage_intacct
        
        result = await intacct.get_payments(customer_id=customer_id, limit=limit)
        
        payments = []
        if result.get("success") and result.get("data"):
            payment_data = result["data"] if isinstance(result["data"], list) else [result["data"]]
            for record in payment_data:
                payments.append(IntacctPayment(**record))
        
        return payments
        
    except Exception as e:
        logger.error(f"Error fetching payments: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Forecasting endpoints

@app.get("/api/forecasting/dashboard", response_model=ForecastingDashboardData)
async def get_forecasting_dashboard(
    date_range_days: int = Query(90, ge=30, le=365),
    scenario: str = Query("realistic"),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get forecasting dashboard data."""
    try:
        end_date = date.today() + timedelta(days=date_range_days)
        start_date = date.today()
        
        dashboard_data = await engine.generate_dashboard_data(
            start_date=start_date,
            end_date=end_date,
            scenario=scenario
        )
        
        return dashboard_data
        
    except Exception as e:
        logger.error(f"Error generating dashboard data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/forecasting/payment-forecast", response_model=List[PaymentForecast])
async def get_payment_forecast(
    days_ahead: int = Query(90, ge=30, le=365),
    min_probability: int = Query(0, ge=0, le=100),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get payment forecast for opportunities."""
    try:
        forecasts = await engine.generate_payment_forecasts(
            days_ahead=days_ahead,
            min_probability=min_probability
        )
        
        return forecasts
        
    except Exception as e:
        logger.error(f"Error generating payment forecast: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/forecasting/cash-flow", response_model=List[CashFlowProjection])
async def get_cash_flow_projection(
    months_ahead: int = Query(6, ge=1, le=24),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get cash flow projections."""
    try:
        projections = await engine.generate_cash_flow_projections(
            months_ahead=months_ahead
        )
        
        return projections
        
    except Exception as e:
        logger.error(f"Error generating cash flow projections: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/forecasting/metrics", response_model=ForecastingMetrics)
async def get_forecasting_metrics(
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get key forecasting metrics."""
    try:
        metrics = await engine.calculate_forecasting_metrics()
        return metrics
        
    except Exception as e:
        logger.error(f"Error calculating metrics: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/forecasting/generate-report", response_model=ForecastingReport)
async def generate_forecasting_report(
    background_tasks: BackgroundTasks,
    period_days: int = Query(90, ge=30, le=365),
    user = Depends(check_permission("generate_financial_reports")),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
):
    """Generate comprehensive forecasting report."""
    try:
        start_date = date.today()
        end_date = start_date + timedelta(days=period_days)
        
        report = await engine.generate_comprehensive_report(
            start_date=start_date,
            end_date=end_date,
            user_id=user["user_id"]
        )
        
        # Schedule background task to save/email report
        background_tasks.add_task(
            save_and_notify_report,
            report,
            user["user_id"]
        )
        
        return report
        
    except Exception as e:
        logger.error(f"Error generating report: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Data sync endpoints

@app.post("/api/sync/trigger")
async def trigger_data_sync(
    background_tasks: BackgroundTasks,
    sync_type: str = Query("all", regex="^(all|salesforce|intacct|activities)$"),
    force_full: bool = Query(False, description="Ignore the watermark — re-fetch + re-classify all rows. Only meaningful for sync_type=activities."),
    user = Depends(check_permission("trigger_data_sync")),
    sync_service: DataSyncService = Depends(get_data_sync_service),
):
    """Trigger manual data synchronization."""
    try:

        if _sync_lock.locked():
            raise HTTPException(status_code=409, detail="Sync already in progress")

        async def _locked_sync(sync_fn):
            async with _sync_lock:
                await sync_fn()

        async def _locked_activities():
            async with _sync_lock:
                await sync_service.sync_activities(force_full=force_full)

        if sync_type == "all":
            background_tasks.add_task(_locked_sync, sync_service.sync_all_data)
        elif sync_type == "salesforce":
            background_tasks.add_task(_locked_sync, sync_service.sync_salesforce_data)
        elif sync_type == "intacct":
            background_tasks.add_task(_locked_sync, sync_service.sync_intacct_data)
        elif sync_type == "activities":
            background_tasks.add_task(_locked_activities)

        return ApiResponse(
            success=True,
            data={"message": f"Data sync ({sync_type}) triggered successfully"},
            meta={"triggered_by": user["user_id"]},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Cache management

@app.post("/api/cache/clear")
async def clear_cache(user=Depends(require_auth)):
    """Clear all server-side caches."""
    cache.clear()
    return {"message": "All caches cleared"}


# Invoice Matching endpoints

class InvoiceMatchRequest(BaseModel):
    """Request model for matching an invoice to an opportunity."""
    invoice_id: str
    opportunity_id: str
    confidence: str = "Confirmed"
    notes: Optional[str] = None
    customer_name: Optional[str] = None
    invoice_amount: Optional[float] = None
    invoice_date: Optional[str] = None


def calculate_match_score(opp, customer_name, invoice_amount, invoice_date):
    """Calculate match score between an invoice and an opportunity.

    Weights: name 40%, amount 30%, date proximity 20%, stage bonus ±flat.
    """
    score = 0
    explanation = {}

    # Name matching (40% weight)
    if customer_name and opp.get("AccountName"):
        name_ratio = SequenceMatcher(
            None, customer_name.lower(), opp["AccountName"].lower()
        ).ratio() * 100
        score += name_ratio * 0.4
        explanation["name_match"] = name_ratio

    # Amount matching (30% weight)
    if invoice_amount and opp.get("Amount"):
        opp_amount = float(opp["Amount"])
        amount_diff = abs(opp_amount - invoice_amount)
        amount_ratio = max(0, 100 - (amount_diff / max(opp_amount, invoice_amount) * 100))
        score += amount_ratio * 0.3
        explanation["amount_match"] = amount_ratio

    # Date proximity (20% weight)
    if invoice_date and opp.get("CloseDate"):
        try:
            inv_date = datetime.strptime(invoice_date, "%Y-%m-%d")
            close_date = datetime.strptime(opp["CloseDate"], "%Y-%m-%d")
            days_diff = abs((inv_date - close_date).days)

            if days_diff <= 30:
                date_score = 100
            elif days_diff <= 90:
                date_score = 100 - ((days_diff - 30) * 1.5)
            elif days_diff <= 180:
                date_score = max(0, 10 - ((days_diff - 90) / 30))
            else:
                date_score = 0

            score += date_score * 0.2
            explanation["date_proximity_days"] = days_diff
        except (ValueError, TypeError):
            pass

    # Stage weighting (flat bonus/penalty)
    stage = opp.get("StageName", "")
    _collecting_values = {s.value for s in COLLECTING_STAGES}
    _open_values = {s.value for s in OPEN_STAGES}
    if stage in _collecting_values:
        score += 30
        explanation["stage_bonus"] = "Active collection"
    elif stage == OpportunityStage.CLOSED_COMPLETED.value:
        score += 25
        explanation["stage_bonus"] = "Completed"
    elif stage in (
        OpportunityStage.CLOSED_LOST.value,
        OpportunityStage.CLOSED_DID_NOT_FULFILL.value,
        OpportunityStage.WITHDRAWN.value,
    ):
        score -= 20
        explanation["stage_bonus"] = "Closed/Lost"
    elif stage in _open_values:
        score -= 10
        explanation["stage_bonus"] = "Open pipeline (not yet won)"
    else:
        score -= 10
        explanation["stage_bonus"] = "Unknown stage"

    return score, explanation


@app.get("/api/matching/search-opportunities")
async def search_opportunities(
    q: str = "",
    limit: int = Query(50, le=200),
    customer_name: Optional[str] = Query(None),
    invoice_amount: Optional[float] = Query(None),
    invoice_date: Optional[str] = Query(None),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Search Salesforce opportunities by name or account with smart matching."""
    try:
        salesforce = client.salesforce

        fields = (
            "Id, Name, AccountId, Account.Name, Amount, StageName, "
            "CloseDate, Description"
        )

        if q:
            safe_q = escape_soql_string(q)
            query = (
                f"SELECT {fields} FROM Opportunity "
                f"WHERE (Name LIKE '%{safe_q}%' OR Account.Name LIKE '%{safe_q}%') "
                f"AND {ISA_EXCLUDE_WHERE} "
                f"ORDER BY CloseDate DESC LIMIT {limit}"
            )
        else:
            query = (
                f"SELECT {fields} FROM Opportunity "
                f"WHERE {ISA_EXCLUDE_WHERE} "
                f"ORDER BY CloseDate DESC LIMIT {limit}"
            )

        result = await salesforce.query(query)

        opportunities = []
        for record in result.get("records", []):
            opp_data = {
                "Id": record.get("Id"),
                "Name": record.get("Name"),
                "AccountName": (record.get("Account") or {}).get("Name", ""),
                "Amount": record.get("Amount"),
                "StageName": record.get("StageName"),
                "CloseDate": record.get("CloseDate"),
                "Description": record.get("Description"),
            }

            if customer_name or invoice_amount or invoice_date:
                ms, expl = calculate_match_score(
                    opp_data, customer_name, invoice_amount, invoice_date
                )
                opp_data["matchScore"] = ms
                opp_data["matchExplanation"] = expl

            opportunities.append(opp_data)

        if customer_name or invoice_amount or invoice_date:
            opportunities.sort(key=lambda x: x.get("matchScore", 0), reverse=True)

        return {
            "success": True,
            "count": len(opportunities),
            "opportunities": opportunities,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error searching opportunities: {e}")
        raise sf_http_error(e, "records")


@app.get("/api/matching/grant-invoices")
async def get_grant_invoices(
    user = Depends(require_auth)
):
    """Get nonprofit grant invoices for matching."""
    try:
        import pandas as pd
        import os
        
        csv_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'nonprofit_grant_invoices.csv')
        
        if not os.path.exists(csv_path):
            raise HTTPException(status_code=404, detail="Grant invoices CSV not found")
        
        df = pd.read_csv(csv_path)
        
        # Convert to list of dicts
        invoices = df.to_dict('records')
        
        return ApiResponse(success=True, data=invoices, meta={"count": len(invoices)})
        
    except Exception as e:
        logger.error(f"Error loading grant invoices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/matching/matches")
async def get_invoice_matches(
    user = Depends(require_auth)
):
    """Get saved invoice-opportunity matches."""
    try:
        import json
        import os
        
        matches_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'invoice_opportunity_matches.json')
        
        if os.path.exists(matches_path):
            with open(matches_path, 'r') as f:
                matches = json.load(f)
        else:
            matches = {}
        
        return ApiResponse(success=True, data=matches, meta={"count": len(matches)})
        
    except Exception as e:
        logger.error(f"Error loading matches: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/matching/save-match")
async def save_invoice_match(
    match_request: InvoiceMatchRequest,
    user = Depends(check_permission("match_invoices"))
):
    """Save an invoice-opportunity match."""
    try:
        import json
        import os
        from datetime import datetime
        
        matches_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'invoice_opportunity_matches.json')
        
        # Load existing matches
        if os.path.exists(matches_path):
            with open(matches_path, 'r') as f:
                matches = json.load(f)
        else:
            matches = {}
        
        # Add/update match
        matches[match_request.invoice_id] = {
            'opportunity_id': match_request.opportunity_id,
            'confidence': match_request.confidence,
            'notes': match_request.notes or '',
            'matched_at': datetime.now().isoformat(),
            'matched_by': user['user_id'],
            'invoice_data': {
                'customer_name': match_request.customer_name or '',
                'invoice_amount': match_request.invoice_amount or 0,
                'invoice_date': match_request.invoice_date or ''
            }
        }
        
        # Save matches
        with open(matches_path, 'w') as f:
            json.dump(matches, f, indent=2)
        
        logger.info(f"Saved match: Invoice {match_request.invoice_id} -> Opportunity {match_request.opportunity_id}")
        
        return ApiResponse(
            success=True,
            data={"message": "Match saved successfully", "invoice_id": match_request.invoice_id, "opportunity_id": match_request.opportunity_id},
        )
        
    except Exception as e:
        logger.error(f"Error saving match: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/matching/delete-match/{invoice_id}")
async def delete_invoice_match(
    invoice_id: str,
    user = Depends(check_permission("match_invoices"))
):
    """Delete an invoice-opportunity match."""
    try:
        import json
        import os
        
        matches_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'invoice_opportunity_matches.json')
        
        if not os.path.exists(matches_path):
            raise HTTPException(status_code=404, detail="No matches found")
        
        # Load matches
        with open(matches_path, 'r') as f:
            matches = json.load(f)
        
        # Delete match
        if invoice_id in matches:
            del matches[invoice_id]
            
            # Save matches
            with open(matches_path, 'w') as f:
                json.dump(matches, f, indent=2)
            
            logger.info(f"Deleted match for invoice {invoice_id}")
            
            return ApiResponse(success=True, data={"message": "Match deleted successfully"})
        else:
            raise HTTPException(status_code=404, detail="Match not found")
        
    except Exception as e:
        logger.error(f"Error deleting match: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Background task functions

async def update_opportunity_invoice_mapping(opportunity_id: str, invoice_id: str, user_id: str):
    """Background task to update opportunity-invoice mapping."""
    try:
        # In a real implementation, this would update a database
        logger.info(f"Updated mapping: Opportunity {opportunity_id} -> Invoice {invoice_id} by {user_id}")
    except Exception as e:
        logger.error(f"Error updating opportunity-invoice mapping: {e}")


async def save_and_notify_report(report: ForecastingReport, user_id: str):
    """Background task to save report and send notifications."""
    try:
        # In a real implementation, this would save to database and send notifications
        logger.info(f"Saved forecasting report {report.report_id} for user {user_id}")
    except Exception as e:
        logger.error(f"Error saving/notifying report: {e}")


# Automation Review, CRM parsing, Slack webhook, and integration endpoints
# have been moved to routes/ai.py, routes/slack_routes.py,
# routes/activity_intelligence.py, and services/crm_parser.py in Phase 2.



# Main entry point
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )

