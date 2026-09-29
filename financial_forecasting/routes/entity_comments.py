"""Generic comments for portfolio Salesforce entities.

Comments hang off an (entity_type, entity_id) pair (account | opportunity |
contact), stored in bedrock.entity_comment. entity_id is a Salesforce 18-char
string Id (so this can't reuse public.org_comments, whose entity_id is UUID).
Authors can edit/delete their own comments.

  GET    /api/entity-comments?entity_type=&entity_id=   — list (oldest first)
  POST   /api/entity-comments                            — create
  PATCH  /api/entity-comments/{comment_id}               — author-only edit
  DELETE /api/entity-comments/{comment_id}               — author-only delete

Modeled on routes/jobs_comments.py.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db
from dependencies import get_mcp_client
from mcp_client import UnifiedMCPClient
from services.entity_owner import find_org_user, resolve_entity_owner
from services.notifications import (
    TYPE_ACCOUNT_COMMENT_ADDED,
    TYPE_CONTACT_COMMENT_ADDED,
    enqueue_notification,
)

logger = logging.getLogger(__name__)

_OWNER_NOTIF_TYPE_BY_ENTITY = {
    "account": TYPE_ACCOUNT_COMMENT_ADDED,
    "contact": TYPE_CONTACT_COMMENT_ADDED,
}
router = APIRouter(prefix="/api", tags=["comments"])

VALID_ENTITY_TYPES = {"account", "opportunity", "contact"}


class EntityCommentCreate(BaseModel):
    entity_type: str
    entity_id: str
    content: str


class EntityCommentUpdate(BaseModel):
    content: str


def _serialize(r) -> dict:
    return {
        "id": str(r["id"]),
        "entity_type": r["entity_type"],
        "entity_id": r["entity_id"],
        "author_id": str(r["author_id"]) if r["author_id"] else None,
        "author_email": r["author_email"],
        "content": r["content"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


_SELECT_SQL = """
    SELECT id, entity_type, entity_id, author_id, author_email, content,
           created_at, updated_at
    FROM bedrock.entity_comment
"""


def _check_entity_type(entity_type: str) -> None:
    if entity_type not in VALID_ENTITY_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid entity_type: {entity_type}")


def _user_email(user) -> str:
    if isinstance(user, dict):
        return (user.get("email") or "").strip()
    return (getattr(user, "email", "") or "").strip()


@router.get("/entity-comments")
async def list_entity_comments(
    entity_type: str = Query(...),
    entity_id: str = Query(...),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    _check_entity_type(entity_type)
    rows = await conn.fetch(
        _SELECT_SQL
        + " WHERE entity_type = $1 AND entity_id = $2 "
        "ORDER BY created_at ASC",
        entity_type, entity_id,
    )
    return {"success": True, "data": [_serialize(r) for r in rows]}


@router.post("/entity-comments")
async def create_entity_comment(
    body: EntityCommentCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    _check_entity_type(body.entity_type)
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    author_email = _user_email(user)
    author_id = await conn.fetchval(
        "SELECT id FROM public.org_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
        author_email,
    ) if author_email else None

    row = await conn.fetchrow(
        """INSERT INTO bedrock.entity_comment
               (entity_type, entity_id, author_id, author_email, content)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, entity_type, entity_id, author_id, author_email,
                     content, created_at, updated_at""",
        body.entity_type, body.entity_id, author_id, author_email, content,
    )

    await _notify_owner_of_comment(
        conn, client, entity_type=body.entity_type, entity_id=body.entity_id,
        author_email=author_email, content=content,
    )

    return {"success": True, "data": _serialize(row)}


async def _notify_owner_of_comment(
    conn, client, *, entity_type: str, entity_id: str, author_email: str, content: str,
) -> None:
    """Best-effort: notify the account/contact owner that someone else
    commented on a record they own. Opportunity comments don't get this
    (product decision — only account/contact are in scope). Never raises
    — a Salesforce hiccup shouldn't fail the comment POST."""
    notif_type = _OWNER_NOTIF_TYPE_BY_ENTITY.get(entity_type)
    if not notif_type:
        return
    try:
        sf = client.salesforce if client else None
        if not sf:
            return
        owner = await resolve_entity_owner(sf, entity_type, entity_id)
        if not owner:
            return
        if owner["owner_email"].strip().lower() == (author_email or "").strip().lower():
            return  # commenting on your own record — no self-ping
        org_row = await find_org_user(conn, owner["owner_email"])
        if not org_row:
            return
        name_field = "account_name" if entity_type == "account" else "contact_name"
        preview = content if len(content) <= 280 else content[:277] + "..."
        await enqueue_notification(
            conn,
            recipient_email=org_row["email"],
            type=notif_type,
            payload={
                "title": f"New comment on an {entity_type} you own",
                "subtitle": owner["record_name"],
                name_field: owner["record_name"],
                "entity_id": entity_id,
                "comment_body": preview,
                "actor_display_name": author_email,
                "target_url": f"/{entity_type}s/{entity_id}",
            },
            actor_email=author_email,
        )
    except Exception as e:
        logger.warning(
            "_notify_owner_of_comment: failed for %s %s: %s", entity_type, entity_id, e,
        )


@router.patch("/entity-comments/{comment_id}")
async def update_entity_comment(
    comment_id: str,
    body: EntityCommentUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    cid = uuid.UUID(comment_id)
    existing = await conn.fetchrow(
        "SELECT author_email FROM bedrock.entity_comment WHERE id = $1", cid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Comment not found")

    if (existing["author_email"] or "").strip().lower() != _user_email(user).lower():
        raise HTTPException(status_code=403, detail="Only the author can edit this comment")

    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    row = await conn.fetchrow(
        "UPDATE bedrock.entity_comment SET content = $1, updated_at = now() "
        "WHERE id = $2 "
        "RETURNING id, entity_type, entity_id, author_id, author_email, "
        "content, created_at, updated_at",
        content, cid,
    )
    return {"success": True, "data": _serialize(row)}


@router.delete("/entity-comments/{comment_id}")
async def delete_entity_comment(
    comment_id: str,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    cid = uuid.UUID(comment_id)
    existing = await conn.fetchrow(
        "SELECT author_email FROM bedrock.entity_comment WHERE id = $1", cid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Comment not found")

    if (existing["author_email"] or "").strip().lower() != _user_email(user).lower():
        raise HTTPException(status_code=403, detail="Only the author can delete this comment")

    await conn.execute("DELETE FROM bedrock.entity_comment WHERE id = $1", cid)
    return {"success": True}
