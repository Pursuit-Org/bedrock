"""Resolve the Salesforce owner of an Account or Contact to an org_users
row, for the "notify the record owner" notification triggers (comments,
file uploads, task assignments — see routes/entity_comments.py,
main.py::upload_account_file, sf_notification_poller.py).

Kept separate from services/notifications.py so it can be imported by
routes that don't otherwise need the rest of that module's Slack-dispatch
machinery.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from security import escape_soql_string
from services.notifications import (
    TYPE_ACCOUNT_OWNER_CHANGED,
    TYPE_CONTACT_OWNER_CHANGED,
    enqueue_notification,
)

logger = logging.getLogger(__name__)

_SOBJECT_BY_ENTITY_TYPE = {"account": "Account", "contact": "Contact"}


async def resolve_entity_owner(sf, entity_type: str, entity_id: str) -> Optional[Dict[str, Any]]:
    """Look up an Account/Contact's current OwnerId + Owner.Email/Name +
    the record's own Name via SOQL. Returns None on any miss (unknown
    entity_type, bad id, SF error, or an owner without an Owner.Email)."""
    sobject = _SOBJECT_BY_ENTITY_TYPE.get(entity_type)
    if not sobject or not entity_id:
        return None
    try:
        result = await sf.query(
            f"SELECT Id, Name, OwnerId, Owner.Email, Owner.Name FROM {sobject} "
            f"WHERE Id = '{escape_soql_string(entity_id)}' LIMIT 1"
        )
    except Exception as e:
        logger.warning("resolve_entity_owner: SOQL failed for %s %s: %s", entity_type, entity_id, e)
        return None
    records = result.get("records") or []
    if not records:
        return None
    rec = records[0]
    owner = rec.get("Owner") or {}
    owner_email = (owner.get("Email") or "").strip()
    if not owner_email:
        return None
    return {
        "record_id": rec.get("Id"),
        "record_name": rec.get("Name"),
        "owner_id": rec.get("OwnerId"),
        "owner_email": owner_email,
        "owner_name": owner.get("Name") or owner_email,
    }


async def find_org_user(conn, email: Optional[str]):
    """The one org_users lookup every notification trigger goes through —
    only notify people who have an org_users row (excludes integration and
    system SF accounts) and are still active. A departed staffer can own
    thousands of SF records for months; nothing under them should DM them,
    and COALESCE keeps the pre-flag rows (is_active NULL) eligible, as
    routes/permissions.py reads it."""
    if not email:
        return None
    return await conn.fetchrow(
        "SELECT email, display_name FROM public.org_users "
        "WHERE LOWER(email) = LOWER($1) AND COALESCE(is_active, true) LIMIT 1",
        email,
    )


async def notify_owner_changed(
    conn,
    *,
    entity_type: str,
    entity_id: str,
    old_owner: Optional[Dict[str, Any]],
    new_owner: Optional[Dict[str, Any]],
    actor_email: str,
) -> None:
    """Fan out gained/lost notifications for an Account/Contact ownership
    change — the same shape as sf_notification_poller's
    _poll_opp_owner_changes, but called synchronously from update_account/
    update_contact since there's no OpportunityFieldHistory-equivalent
    audit object to poll for these sobjects. Best-effort: swallows its
    own errors (call sites also wrap this, defense in depth) so a
    notification hiccup never fails the underlying record update.
    """
    if not new_owner:
        return
    if old_owner and old_owner.get("owner_id") == new_owner.get("owner_id"):
        return  # no-op transition (e.g. re-saving the same owner)

    notif_type = TYPE_ACCOUNT_OWNER_CHANGED if entity_type == "account" else TYPE_CONTACT_OWNER_CHANGED
    name_field = "account_name" if entity_type == "account" else "contact_name"
    record_name = new_owner.get("record_name") or entity_id
    actor_lower = (actor_email or "").strip().lower()
    target_url = f"/{entity_type}s/{entity_id}"

    try:
        new_owner_email = (new_owner.get("owner_email") or "").strip()
        if new_owner_email and new_owner_email.lower() != actor_lower:
            org = await find_org_user(conn, new_owner_email)
            if org:
                await enqueue_notification(
                    conn,
                    recipient_email=org["email"],
                    type=notif_type,
                    payload={
                        "title": f"You're now the owner of {record_name}",
                        "subtitle": record_name,
                        "role": "gained",
                        "entity_id": entity_id,
                        name_field: record_name,
                        "actor_display_name": actor_email,
                        "target_url": target_url,
                    },
                    actor_email=actor_email,
                )

        if old_owner:
            old_owner_email = (old_owner.get("owner_email") or "").strip()
            if old_owner_email and old_owner_email.lower() != actor_lower:
                org = await find_org_user(conn, old_owner_email)
                if org:
                    await enqueue_notification(
                        conn,
                        recipient_email=org["email"],
                        type=notif_type,
                        payload={
                            "title": f"{record_name} reassigned",
                            "subtitle": f"{record_name} → {new_owner.get('owner_name')}",
                            "role": "lost",
                            "entity_id": entity_id,
                            name_field: record_name,
                            "new_owner_name": new_owner.get("owner_name"),
                            "actor_display_name": actor_email,
                            "target_url": target_url,
                        },
                        actor_email=actor_email,
                    )
    except Exception as e:
        logger.warning(
            "notify_owner_changed: failed for %s %s: %s", entity_type, entity_id, e,
        )
