"""Notifications API — read + mark-read for the in-app bell.

Endpoints (all scoped to the authenticated user):

    GET    /api/notifications                — list (default: 50 most recent)
    GET    /api/notifications/unread-count   — small payload for the bell badge
    POST   /api/notifications/{id}/read      — mark a single row read
    POST   /api/notifications/read-all       — mark every unread row read
    GET    /api/notifications/preferences    — read delivery/activity preferences
    PUT    /api/notifications/preferences    — update delivery/activity preferences

Notifications are private to the recipient; the SELECT WHERE clause
keys on the authenticated user's email so a user can't read another
user's bell by guessing IDs.

Rows older than 14 days are purged by services/notification_cleanup.py;
the list query below also filters on that window as defense-in-depth
so a slow cleanup cycle can't surface stale notifications.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/notifications", tags=["notifications"])

RETENTION_DAYS = 14


class NotificationPreferenceUpdate(BaseModel):
    slack_enabled: bool
    account_activity_enabled: bool
    contact_activity_enabled: bool
    opportunity_activity_enabled: bool


def _serialize(row) -> Dict[str, Any]:
    return {
        "id": str(row["id"]),
        "type": row["type"],
        "payload": row["payload"] if isinstance(row["payload"], dict) else {},
        "actor_email": row["actor_email"],
        "read_at": row["read_at"].isoformat() if row["read_at"] else None,
        "slack_status": row["slack_status"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def _recipient_from_user(user) -> str:
    email = (user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="No email on session")
    return email


@router.get("")
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(50, le=200),
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """List the current user's notifications, newest first."""
    recipient = _recipient_from_user(user)
    if unread_only:
        rows = await conn.fetch(
            "SELECT id, type, payload, actor_email, read_at, slack_status, created_at "
            "FROM bedrock.notification "
            "WHERE recipient_email = $1 AND read_at IS NULL "
            "AND created_at > now() - make_interval(days => $3) "
            "ORDER BY created_at DESC LIMIT $2",
            recipient, limit, RETENTION_DAYS,
        )
    else:
        rows = await conn.fetch(
            "SELECT id, type, payload, actor_email, read_at, slack_status, created_at "
            "FROM bedrock.notification "
            "WHERE recipient_email = $1 "
            "AND created_at > now() - make_interval(days => $3) "
            "ORDER BY created_at DESC LIMIT $2",
            recipient, limit, RETENTION_DAYS,
        )
    return {"success": True, "data": [_serialize(r) for r in rows]}


@router.get("/unread-count")
async def unread_count(
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """Lightweight badge counter for the bell. Returns ``{count: N}``."""
    recipient = _recipient_from_user(user)
    n = await conn.fetchval(
        "SELECT COUNT(*) FROM bedrock.notification "
        "WHERE recipient_email = $1 AND read_at IS NULL",
        recipient,
    )
    return {"success": True, "data": {"count": int(n or 0)}}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """Mark one notification as read. Idempotent — re-marking a read row
    no-ops."""
    recipient = _recipient_from_user(user)
    try:
        nid = uuid.UUID(notification_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid notification id")
    result = await conn.execute(
        "UPDATE bedrock.notification SET read_at = COALESCE(read_at, now()) "
        "WHERE id = $1 AND recipient_email = $2",
        nid, recipient,
    )
    if result.endswith("0"):
        # Either the row doesn't exist or belongs to someone else — same
        # 404 either way (no info leak).
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"success": True}


@router.post("/read-all")
async def mark_all_read(
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """Mark every unread notification for the current user as read."""
    recipient = _recipient_from_user(user)
    result = await conn.execute(
        "UPDATE bedrock.notification SET read_at = now() "
        "WHERE recipient_email = $1 AND read_at IS NULL",
        recipient,
    )
    # asyncpg returns "UPDATE N" — extract N best-effort for the response.
    try:
        n = int(result.rsplit(" ", 1)[-1])
    except Exception:
        n = 0
    return {"success": True, "data": {"marked": n}}


_PREFERENCE_DEFAULTS: Dict[str, bool] = {
    "slack_enabled": True,
    "account_activity_enabled": True,
    "contact_activity_enabled": True,
    "opportunity_activity_enabled": True,
}


@router.get("/preferences")
async def get_preferences(
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """Current user's notification delivery + activity preferences.
    In-app (bell) delivery isn't represented here — it's always on."""
    recipient = _recipient_from_user(user)
    # Same read enqueue_notification uses: defaults when there is no row, and
    # defaults when the table itself has not been created yet. Querying the
    # table directly 500ed until the migration ran and left the Settings tab
    # on "Loading…" through react-query's retries.
    from services.notifications import _get_preference
    data = {**_PREFERENCE_DEFAULTS, **await _get_preference(conn, recipient)}
    return {"success": True, "data": data}


@router.put("/preferences")
async def update_preferences(
    body: NotificationPreferenceUpdate,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    recipient = _recipient_from_user(user)
    from services.notifications import _PREFS_MIGRATION, _prefs_table_ready
    if not await _prefs_table_ready(conn):
        # Nothing to write to yet. Say which migration, as the jobs routes do.
        raise HTTPException(
            status_code=409,
            detail=f"Notification preferences need migration {_PREFS_MIGRATION}",
        )
    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.notification_preference
            (user_email, slack_enabled, account_activity_enabled,
             contact_activity_enabled, opportunity_activity_enabled)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_email) DO UPDATE SET
            slack_enabled = EXCLUDED.slack_enabled,
            account_activity_enabled = EXCLUDED.account_activity_enabled,
            contact_activity_enabled = EXCLUDED.contact_activity_enabled,
            opportunity_activity_enabled = EXCLUDED.opportunity_activity_enabled,
            updated_at = now()
        RETURNING slack_enabled, account_activity_enabled,
                  contact_activity_enabled, opportunity_activity_enabled
        """,
        recipient, body.slack_enabled, body.account_activity_enabled,
        body.contact_activity_enabled, body.opportunity_activity_enabled,
    )
    return {"success": True, "data": dict(row)}
