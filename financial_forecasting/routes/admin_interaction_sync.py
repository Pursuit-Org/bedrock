"""Admin endpoints for Gmail + Calendar interaction sync.

  POST   /api/admin/interaction-sync/run     — manual full sync trigger
  GET    /api/admin/interaction-sync/status  — last sync times + counts per staff
  GET    /api/admin/interaction-sync/staff   — list sync_staff roster
  POST   /api/admin/interaction-sync/staff   — add a staff member
  DELETE /api/admin/interaction-sync/staff/{email} — remove a staff member
"""

import asyncio
import logging
import os

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from pydantic import BaseModel

from db import get_db, get_pool
from routes.permissions import require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/interaction-sync", tags=["admin-interaction-sync"])

_sync_lock = asyncio.Lock()
_sync_status: dict = {"running": False, "last_summary": None}


class StaffRequest(BaseModel):
    email: str
    display_name: str | None = None


async def _run_sync_background(staff_emails=None, since_days=None):
    async with _sync_lock:
        _sync_status["running"] = True
        try:
            from services.interaction_sync import run_interaction_sync, sync_pool
            # A pool of the sync's own (not a single conn) so long backfills get a
            # fresh connection per staff member, and so its batch steps run under
            # a batch-sized statement timeout instead of the web pool's 30 s,
            # which silently stopped the email message index (PRO-98).
            async with sync_pool(fallback=get_pool()) as pool:
                summary = await run_interaction_sync(
                    pool, staff_emails=staff_emails, since_days=since_days,
                )
            _sync_status["last_summary"] = summary
            logger.info("interaction sync complete: %s", summary)
        except Exception as e:
            logger.error("interaction sync failed: %r", e)
            _sync_status["last_summary"] = {"error": repr(e)}
        finally:
            _sync_status["running"] = False


class SyncRequest(BaseModel):
    # Restrict to specific staff (else all enabled). since_days forces a
    # historical backfill bypassing the incremental watermark.
    staff_emails: list[str] | None = None
    since_days: int | None = None


@router.post("/run")
async def trigger_sync(
    background_tasks: BackgroundTasks,
    body: SyncRequest | None = None,
    user=Depends(require_admin),
):
    """Manually trigger an interaction sync in the background.

    Optional body: {"staff_emails": [...], "since_days": 90} to target a subset
    of staff and/or force a historical backfill (e.g. the first Sent-mail pull).
    """
    if _sync_status["running"]:
        return {"success": False, "data": {"message": "Sync already running"}}
    staff_emails = body.staff_emails if body else None
    since_days = body.since_days if body else None
    background_tasks.add_task(_run_sync_background, staff_emails, since_days)
    return {"success": True, "data": {
        "message": "Sync started in background",
        "staff_emails": staff_emails, "since_days": since_days,
    }}


@router.post("/cron")
async def cron_sync(
    background_tasks: BackgroundTasks,
    body: SyncRequest | None = None,
    x_cron_key: str | None = Header(default=None),
):
    """Scheduler-friendly trigger (no user login). Authenticated by a shared
    secret in the X-Cron-Key header, matched against env CRON_SECRET, so
    Cloud Scheduler can run the nightly sync without a JWT. Same body as /run.
    """
    secret = os.environ.get("CRON_SECRET")
    if not secret or x_cron_key != secret:
        raise HTTPException(status_code=403, detail="bad cron key")
    if _sync_status["running"]:
        return {"success": False, "data": {"message": "Sync already running"}}
    staff_emails = body.staff_emails if body else None
    since_days = body.since_days if body else None
    background_tasks.add_task(_run_sync_background, staff_emails, since_days)
    return {"success": True, "data": {"message": "Cron sync started", "since_days": since_days}}


@router.get("/status")
async def get_sync_status(user=Depends(require_admin)):
    """Current sync state + last summary."""
    return {"success": True, "data": _sync_status}


@router.get("/staff")
async def list_staff(user=Depends(require_admin), conn=Depends(get_db)):
    """List all sync_staff members with their last watermark timestamps."""
    rows = await conn.fetch(
        """
        SELECT
            ss.email,
            ss.display_name,
            ss.enabled,
            ss.added_at,
            wg.last_synced_at  AS gmail_last_synced,
            wg.last_run_count  AS gmail_last_count,
            wc.last_synced_at  AS calendar_last_synced,
            wc.last_run_count  AS calendar_last_count
        FROM bedrock.sync_staff ss
        LEFT JOIN bedrock.sync_watermark wg
            ON wg.staff_email = ss.email AND wg.source = 'gmail'
        LEFT JOIN bedrock.sync_watermark wc
            ON wc.staff_email = ss.email AND wc.source = 'calendar'
        ORDER BY ss.email
        """
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.post("/staff")
async def add_staff(
    body: StaffRequest,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Add (or re-enable) a staff member for interaction sync."""
    await conn.execute(
        """
        INSERT INTO bedrock.sync_staff (email, display_name, enabled)
        VALUES ($1, $2, true)
        ON CONFLICT (email) DO UPDATE SET enabled = true, display_name = COALESCE($2, bedrock.sync_staff.display_name)
        """,
        body.email,
        body.display_name,
    )
    return {"success": True, "data": {"email": body.email, "enabled": True}}


@router.post("/run-internal")
async def trigger_sync_internal(
    background_tasks: BackgroundTasks,
    x_sync_secret: str | None = Header(default=None, alias="X-Sync-Secret"),
):
    """Cloud Scheduler endpoint — authenticated via X-Sync-Secret header."""
    expected = os.environ.get("INTERNAL_SYNC_SECRET", "")
    if not expected or x_sync_secret != expected:
        raise HTTPException(401, "Invalid or missing X-Sync-Secret")
    if _sync_status["running"]:
        return {"success": False, "data": {"message": "Sync already running"}}
    background_tasks.add_task(_run_sync_background)
    return {"success": True, "data": {"message": "Nightly sync started"}}


@router.delete("/staff/{email:path}")
async def remove_staff(
    email: str,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Disable a staff member (soft delete — keeps watermark history)."""
    result = await conn.execute(
        "UPDATE bedrock.sync_staff SET enabled = false WHERE email = $1",
        email,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, f"No staff found with email {email}")
    return {"success": True, "data": {"email": email, "enabled": False}}
