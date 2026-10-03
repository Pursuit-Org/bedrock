"""Polls Salesforce for events that should fan out as bedrock
notifications: new Task assignments + Opportunity owner changes.

Runs on a fixed interval (default 5 min) inside the backend's
asyncio loop. Uses the service-account SF client (the one wired at
startup), so polls work org-wide regardless of which user's session
is active.

Watermark strategy:
- bedrock.notification_watermark holds one row per source. Each
  poll fetches events with CreatedDate > watermark, then advances
  the watermark to the latest CreatedDate seen in the batch.
- Insert + watermark-bump happen in the same async transaction so
  a crash mid-batch doesn't double-notify or skip events.

Recipient filter:
- SF OwnerId → SF User.Email → public.org_users.email. Only fires
  when the user has an org_users row (this naturally excludes the
  system / integration accounts already filtered out of the owner
  dropdowns by the QA branch).

Failure mode:
- Any error inside a poll is logged and swallowed so the loop
  keeps running. The watermark only advances on success, so events
  missed during an outage are replayed on the next successful poll.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from dependencies import _services
from services.entity_owner import find_org_user
from services.notifications import (
    TYPE_ACCOUNT_TASK_ASSIGNED,
    TYPE_CONTACT_TASK_ASSIGNED,
    TYPE_SF_OPP_OWNER_CHANGED,
    TYPE_SF_TASK_ASSIGNED,
    enqueue_notification,
)

logger = logging.getLogger(__name__)

POLL_INTERVAL_SEC = int(os.environ.get("SF_NOTIF_POLL_SEC", "300"))
# SOQL needs ISO-8601 with timezone. Postgres returns timestamptz; format
# as "...Z" so SF doesn't interpret it as a local-time literal.
_SF_TS_FMT = "%Y-%m-%dT%H:%M:%S.000+0000"

SOURCE_TASK = "sf_task"
SOURCE_OPP_OWNER = "sf_opp_owner_history"


async def run_forever() -> None:
    """Top-level entry — sleep-loop calling poll_once. Used by main.py's
    startup hook so the poller lives inside the backend process.

    Each poll is hard-capped at 120 s so a stuck SF call can't block
    the event loop forever (the underlying simple_salesforce client is
    sync; a network stall would otherwise hang this coroutine
    indefinitely). On timeout we log, advance to sleep, and retry next
    cycle.
    """
    # Stagger the first run so concurrent backend startups don't all
    # hit SF at the same instant. Trivially-randomized below 30s.
    import random
    await asyncio.sleep(random.uniform(5, 30))
    while True:
        try:
            await asyncio.wait_for(poll_once(), timeout=120.0)
        except asyncio.TimeoutError:
            logger.error("sf_notification_poller: poll_once timed out after 120s — skipping cycle")
        except Exception as e:
            logger.exception(f"sf_notification_poller crashed mid-cycle: {e}")
        await asyncio.sleep(POLL_INTERVAL_SEC)


async def poll_once() -> Dict[str, int]:
    """Run one full poll. Returns a small summary for logging/tests.

    Skips cleanly when SF or db_pool aren't available — the loop
    re-polls on the next cycle.
    """
    pool = _services.get("db_pool")
    client = _services.get("mcp_client")
    if not pool:
        logger.debug("poll_once: no db_pool")
        return {"sf_task": 0, "sf_opp_owner_history": 0}
    if not client or "salesforce" not in (client.connected_services or []):
        logger.debug("poll_once: SF not connected")
        return {"sf_task": 0, "sf_opp_owner_history": 0}

    sf = client.salesforce

    tasks_inserted = await _poll_sf_tasks(pool, sf)
    owner_inserted = await _poll_opp_owner_changes(pool, sf)

    if tasks_inserted or owner_inserted:
        logger.info(
            "sf_notification_poller: sf_task=%d sf_opp_owner=%d",
            tasks_inserted, owner_inserted,
        )
    return {"sf_task": tasks_inserted, "sf_opp_owner_history": owner_inserted}


# ── SF Tasks ────────────────────────────────────────────────────────────────


async def _poll_sf_tasks(pool, sf) -> int:
    """Find SF Tasks created since the watermark and fan-out a
    notification to each owner that exists in public.org_users."""
    async with pool.acquire() as conn:
        watermark = await _read_watermark(conn, SOURCE_TASK)
    soql_ts = watermark.strftime(_SF_TS_FMT)

    soql = f"""
        SELECT Id, Subject, ActivityDate, Status, IsClosed, TaskSubtype,
               OwnerId, Owner.Name, Owner.Email,
               CreatedById, CreatedBy.Name, CreatedBy.Email, CreatedDate,
               WhatId, What.Name, WhoId, Who.Name
        FROM Task
        WHERE CreatedDate > {soql_ts}
          AND IsClosed = false
          AND (TaskSubtype = 'Task' OR TaskSubtype = null)
        ORDER BY CreatedDate ASC
        LIMIT 200
    """
    try:
        result = await sf.query(soql)
    except Exception as e:
        logger.warning("sf_task poll SOQL failed: %s", e)
        return 0
    records = result.get("records", []) or []
    if not records:
        return 0

    # Batch-resolve the Account/Contact owner for every distinct WhatId
    # we see, so a Task created under a record owned by someone else can
    # also ping that owner (in addition to the existing assignee
    # notification below) — one extra SOQL per sobject per poll cycle,
    # not per row.
    what_ids = {r.get("WhatId") for r in records if r.get("WhatId")}
    entity_owner_lookup = await _batch_resolve_entity_owners(sf, what_ids)

    inserted = 0
    new_watermark = watermark
    async with pool.acquire() as conn:
        async with conn.transaction():
            for r in records:
                created = _parse_sf_datetime(r.get("CreatedDate"))
                if created and created > new_watermark:
                    new_watermark = created

                owner = r.get("Owner") or {}
                owner_email = (owner.get("Email") or "").strip()
                if not owner_email:
                    continue

                # Only notify if the owner is in our org_users registry —
                # this skips integration accounts and other system users.
                org_row = await find_org_user(conn, owner_email)
                if not org_row:
                    continue

                creator = r.get("CreatedBy") or {}
                creator_email = (creator.get("Email") or "").strip() or None
                creator_name = creator.get("Name") or creator_email or "Salesforce"

                # Suppress self-action pings — if you created a Task and
                # set yourself as the owner in SF, you already know.
                if creator_email and creator_email.lower() == owner_email.lower():
                    continue

                what_id = r.get("WhatId")
                what_name = (r.get("What") or {}).get("Name")
                target_url = _build_what_target_url(what_id)

                subject = r.get("Subject") or "(no subject)"
                # SF can deliver bogus 'true' subjects from auto-captured
                # email integrations — skip those (matches Pipeline filter).
                if subject.strip().lower() == "true":
                    continue

                await enqueue_notification(
                    conn,
                    recipient_email=org_row["email"],
                    type=TYPE_SF_TASK_ASSIGNED,
                    payload={
                        "title": f"New Salesforce task: {subject}",
                        "subtitle": subject,
                        "task_title": subject,
                        "sf_task_id": r.get("Id"),
                        "activity_date": r.get("ActivityDate"),
                        "what_id": what_id,
                        "what_name": what_name,
                        "actor_display_name": creator_name,
                        "target_url": target_url,
                    },
                    actor_email=creator_email,
                )
                inserted += 1

                # Also notify the Account/Contact owner that a task was
                # assigned under a record they own — skip when that owner
                # IS the assignee (already notified above) or the actor.
                entity = entity_owner_lookup.get(what_id)
                if entity:
                    entity_owner_email = entity["owner_email"].strip().lower()
                    if (
                        entity_owner_email != owner_email.lower()
                        and (not creator_email or entity_owner_email != creator_email.lower())
                    ):
                        entity_org_row = await find_org_user(conn, entity["owner_email"])
                        if entity_org_row:
                            await enqueue_notification(
                                conn,
                                recipient_email=entity_org_row["email"],
                                type=entity["notif_type"],
                                payload={
                                    "title": f"New task on an {entity['entity_type']} you own",
                                    "subtitle": subject,
                                    entity["name_field"]: entity["record_name"],
                                    "entity_id": what_id,
                                    "task_title": subject,
                                    "assignee_name": owner.get("Name") or owner_email,
                                    "actor_display_name": creator_name,
                                    "target_url": target_url,
                                },
                                actor_email=creator_email,
                            )
                            inserted += 1

            await _write_watermark(conn, SOURCE_TASK, new_watermark)
    return inserted


async def _batch_resolve_entity_owners(sf, what_ids: set) -> Dict[str, Dict[str, Any]]:
    """Resolve Account/Contact WhatIds to their current owner, in at most
    two SOQL calls (split by the 001/003 id-prefix convention). Returns
    a lookup keyed by WhatId; entries with no resolvable Owner.Email are
    omitted."""
    account_ids = [w for w in what_ids if isinstance(w, str) and w.startswith("001")]
    contact_ids = [w for w in what_ids if isinstance(w, str) and w.startswith("003")]
    lookup: Dict[str, Dict[str, Any]] = {}

    async def _fetch(ids: List[str], sobject: str, entity_type: str, notif_type: str, name_field: str):
        if not ids:
            return
        ids_str = ", ".join(f"'{i}'" for i in ids)
        try:
            res = await sf.query(
                f"SELECT Id, Name, OwnerId, Owner.Email, Owner.Name FROM {sobject} "
                f"WHERE Id IN ({ids_str}) LIMIT {len(ids)}"
            )
        except Exception as e:
            logger.warning("_batch_resolve_entity_owners: %s query failed: %s", sobject, e)
            return
        for rec in res.get("records") or []:
            owner = rec.get("Owner") or {}
            owner_email = (owner.get("Email") or "").strip()
            if not owner_email:
                continue
            lookup[rec["Id"]] = {
                "entity_type": entity_type,
                "notif_type": notif_type,
                "name_field": name_field,
                "record_name": rec.get("Name") or rec.get("Id"),
                "owner_email": owner_email,
            }

    await _fetch(account_ids, "Account", "account", TYPE_ACCOUNT_TASK_ASSIGNED, "account_name")
    await _fetch(contact_ids, "Contact", "contact", TYPE_CONTACT_TASK_ASSIGNED, "contact_name")
    return lookup


# ── SF Opportunity owner changes ────────────────────────────────────────────


async def _poll_opp_owner_changes(pool, sf) -> int:
    """Find OpportunityFieldHistory rows where Owner changed and notify
    the new owner (gained) and prior owner (lost)."""
    async with pool.acquire() as conn:
        watermark = await _read_watermark(conn, SOURCE_OPP_OWNER)
    soql_ts = watermark.strftime(_SF_TS_FMT)

    soql = f"""
        SELECT Id, OpportunityId, Field, OldValue, NewValue,
               CreatedDate, CreatedById, CreatedBy.Email, CreatedBy.Name
        FROM OpportunityFieldHistory
        WHERE Field = 'Owner'
          AND CreatedDate > {soql_ts}
        ORDER BY CreatedDate ASC
        LIMIT 200
    """
    try:
        result = await sf.query(soql)
    except Exception as e:
        logger.warning("sf_opp_owner_history poll SOQL failed: %s", e)
        return 0
    records = result.get("records", []) or []
    if not records:
        return 0

    # Batch-resolve every distinct OwnerId we see in OldValue/NewValue
    # (and the OpportunityId → Name) in one SOQL each — keeps the
    # per-row work to a constant number of API calls.
    opp_ids = list({r.get("OpportunityId") for r in records if r.get("OpportunityId")})
    user_ids: set = set()
    for r in records:
        for v in (r.get("OldValue"), r.get("NewValue")):
            if isinstance(v, str) and v.startswith("005"):
                user_ids.add(v)

    user_lookup: Dict[str, Dict[str, Any]] = {}
    if user_ids:
        ids_str = ", ".join(f"'{i}'" for i in user_ids)
        ures = await sf.query(
            f"SELECT Id, Name, Email FROM User WHERE Id IN ({ids_str}) LIMIT {len(user_ids)}"
        )
        for u in ures.get("records") or []:
            user_lookup[u["Id"]] = u

    opp_lookup: Dict[str, Dict[str, Any]] = {}
    if opp_ids:
        ids_str = ", ".join(f"'{i}'" for i in opp_ids)
        ores = await sf.query(
            f"SELECT Id, Name FROM Opportunity WHERE Id IN ({ids_str}) LIMIT {len(opp_ids)}"
        )
        for o in ores.get("records") or []:
            opp_lookup[o["Id"]] = o

    inserted = 0
    new_watermark = watermark
    async with pool.acquire() as conn:
        async with conn.transaction():
            for r in records:
                created = _parse_sf_datetime(r.get("CreatedDate"))
                if created and created > new_watermark:
                    new_watermark = created

                opp_id = r.get("OpportunityId")
                opp_name = (opp_lookup.get(opp_id) or {}).get("Name") or opp_id
                old_id = r.get("OldValue") if isinstance(r.get("OldValue"), str) else None
                new_id = r.get("NewValue") if isinstance(r.get("NewValue"), str) else None
                actor = r.get("CreatedBy") or {}
                actor_email = (actor.get("Email") or "").strip() or None
                actor_name = actor.get("Name") or actor_email or "Salesforce"
                actor_lower = (actor_email or "").lower()

                target_url = f"/opportunities/{opp_id}" if opp_id else None

                # Notify the gainer — unless they're the one who made the
                # change. Self-actions don't fire (product rule per
                # 2026-05-20).
                if new_id and new_id in user_lookup:
                    em = (user_lookup[new_id].get("Email") or "").strip()
                    if actor_lower and em.lower() == actor_lower:
                        em = ""  # short-circuit the dispatch below
                    org = await _find_org_user(conn, em) if em else None
                    if org:
                        await enqueue_notification(
                            conn,
                            recipient_email=org["email"],
                            type=TYPE_SF_OPP_OWNER_CHANGED,
                            payload={
                                "title": f"You're now the owner of {opp_name}",
                                "subtitle": opp_name,
                                "role": "gained",
                                "opp_id": opp_id,
                                "opp_name": opp_name,
                                "actor_display_name": actor_name,
                                "target_url": target_url,
                            },
                            actor_email=actor_email,
                        )
                        inserted += 1

                # Notify the prior owner. Skip if the prior owner is the
                # same person as the new owner (no-op transitions exist
                # in some workflows). Also skip if the prior owner is
                # the actor — they did the reassign themselves.
                if old_id and old_id != new_id and old_id in user_lookup:
                    em = (user_lookup[old_id].get("Email") or "").strip()
                    if actor_lower and em.lower() == actor_lower:
                        em = ""
                    org = await _find_org_user(conn, em) if em else None
                    if org:
                        new_name = (user_lookup.get(new_id) or {}).get("Name") or "another owner"
                        await enqueue_notification(
                            conn,
                            recipient_email=org["email"],
                            type=TYPE_SF_OPP_OWNER_CHANGED,
                            payload={
                                "title": f"{opp_name} reassigned",
                                "subtitle": f"{opp_name} → {new_name}",
                                "role": "lost",
                                "opp_id": opp_id,
                                "opp_name": opp_name,
                                "new_owner_name": new_name,
                                "actor_display_name": actor_name,
                                "target_url": target_url,
                            },
                            actor_email=actor_email,
                        )
                        inserted += 1

            await _write_watermark(conn, SOURCE_OPP_OWNER, new_watermark)
    return inserted


# ── helpers ─────────────────────────────────────────────────────────────────


async def _read_watermark(conn, source: str) -> datetime:
    row = await conn.fetchrow(
        "SELECT last_seen FROM bedrock.notification_watermark WHERE source = $1",
        source,
    )
    if not row:
        # Insert a default (1 hour back) so the first poll has scope.
        default = datetime.now(timezone.utc).replace(microsecond=0)
        await conn.execute(
            "INSERT INTO bedrock.notification_watermark (source, last_seen) "
            "VALUES ($1, $2) ON CONFLICT (source) DO NOTHING",
            source, default,
        )
        return default
    return row["last_seen"]


async def _write_watermark(conn, source: str, ts: datetime) -> None:
    await conn.execute(
        "UPDATE bedrock.notification_watermark SET last_seen = $2, updated_at = now() "
        "WHERE source = $1",
        source, ts,
    )


async def _find_org_user(conn, email: Optional[str]):
    if not email:
        return None
    return await find_org_user(conn, email)


def _parse_sf_datetime(s) -> Optional[datetime]:
    """SF returns CreatedDate as 'YYYY-MM-DDTHH:MM:SS.000+0000'. Parse
    to a timezone-aware datetime. Returns None on miss."""
    if not s or not isinstance(s, str):
        return None
    try:
        # Replace the SF "+0000" with "+00:00" for fromisoformat.
        normalized = s.replace("+0000", "+00:00").replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except Exception:
        return None


def _build_what_target_url(what_id: Optional[str]) -> Optional[str]:
    """Map an SF WhatId prefix to the in-app detail page so the
    notification's "Open in Bedrock" lands on the related record.
    Returns None for unknown prefixes — the SF Task itself doesn't
    have a dedicated bedrock detail page yet."""
    if not what_id or len(what_id) < 3:
        return None
    prefix = what_id[:3]
    if prefix == "006":
        return f"/opportunities/{what_id}"
    if prefix == "001":
        return f"/accounts/{what_id}"
    return None
