"""Polls Sputnik's builder intro requests and fans them out through the
Bedrock notification path — so one bot carries both kinds of ask.

Why a poller: `public.intro_requests` is written by Sputnik, a separate app
whose code we don't control and which is owned by `postgres` (the app role
can't add a trigger to it). Bedrock already reads the table for the Jobs
page, so watching it on an interval is the least-coupled way to notice new
rows. Modelled on services/sf_notification_poller.py — same watermark table,
same "insert + bump in one transaction" discipline.

Watermark strategy:
- `bedrock.notification_watermark` holds one row per source. Each poll picks
  up rows with created_at > watermark, then advances the watermark to the
  newest created_at in the batch.
- On the very first run the row is seeded to *now*, so the pre-existing
  backlog (oldest 2026-03) is skipped by construction rather than DMing the
  whole team about months of old asks.
- The whole cycle (read → notify → bump) is one transaction holding
  `FOR UPDATE` on the watermark row. Bedrock runs several Cloud Run instances
  and each carries this loop, so without the lock two of them can read the
  same watermark and DM the connector twice. The watermark only advances on
  success, so events missed during an outage replay on the next good poll.

Recipient:
- The connector staff member (`intro_requests.staff_user_id`), resolved to an
  email via `bedrock.staff_user_id_map`. That's the person who has to act.
- The *builder* is deliberately not notified here: builders are not members
  of the Slack workspace the Bedrock app is installed in, so a DM to them
  resolves to no slack_user_id and is marked skipped. Sputnik owns
  builder-facing comms for now.

Builder identity comes from `bedrock.builder_by_id` (SECURITY DEFINER) —
`public.users` is RLS-scoped away from the app role, and joining it directly
is what made builder names vanish from the Jobs page in the first place.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Dict, Optional

from dependencies import _services
from services.notifications import TYPE_INTRO_REQUEST, enqueue_notification

logger = logging.getLogger(__name__)

POLL_INTERVAL_SEC = int(os.environ.get("INTRO_NOTIF_POLL_SEC", "300"))
SOURCE_BUILDER_INTRO = "sputnik_intro_request"

# Keep in sync with routes/jobs_intro.ASK_LABELS.
ASK_LABELS = {
    "hiring_intro": "Hiring intro",
    "industry_advice": "Industry advice",
    "job_referral": "Job referral",
    "mock_interview": "Mock interview",
    "informational_interview": "Informational interview",
    "introductory_call": "Intro call",
    "demo_feedback": "Demo feedback",
    "other": "Other",
}


async def run_forever() -> None:
    """Sleep-loop calling poll_once. Started from main.py's startup hook."""
    import random
    # Stagger so concurrent backend startups don't poll in lockstep.
    await asyncio.sleep(random.uniform(5, 30))
    while True:
        try:
            await asyncio.wait_for(poll_once(), timeout=120.0)
        except asyncio.TimeoutError:
            logger.error("intro_notification_poller: poll_once timed out after 120s — skipping cycle")
        except Exception as e:  # noqa: BLE001 — loop must survive any single cycle
            logger.exception("intro_notification_poller crashed mid-cycle: %s", e)
        await asyncio.sleep(POLL_INTERVAL_SEC)


async def poll_once() -> Dict[str, int]:
    """Run one poll. Returns a small summary for logging/tests."""
    pool = _services.get("db_pool")
    if not pool:
        logger.debug("intro poll_once: no db_pool")
        return {SOURCE_BUILDER_INTRO: 0}

    inserted = await _poll_builder_intros(pool)
    if inserted:
        logger.info("intro_notification_poller: builder_intro=%d", inserted)
    return {SOURCE_BUILDER_INTRO: inserted}


async def _poll_builder_intros(pool) -> int:
    """One cycle: read → notify → bump, all under a lock on the watermark row.

    The whole cycle is a single transaction that takes `FOR UPDATE` on this
    source's watermark row. Bedrock runs multiple Cloud Run instances, each
    with its own copy of this loop; without the lock two instances can read the
    same watermark, fetch the same rows and DM the connector twice. With it the
    second instance blocks, then reads the already-advanced watermark and finds
    nothing to do.
    """
    inserted = 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            watermark, seeded = await _lock_watermark(conn, SOURCE_BUILDER_INTRO)
            if seeded:
                # First ever run — the watermark was just set to now, so there
                # is nothing newer. Skips the historical backlog on purpose.
                logger.info(
                    "intro_notification_poller: seeded watermark at %s, skipping backlog",
                    watermark.isoformat(),
                )
                return 0

            rows = await conn.fetch(
                """
                SELECT ir.intro_request_id, ir.created_at, ir.specific_ask,
                       ir.request_context, ir.contact_name, ir.contact_company,
                       ir.builder_id, ir.staff_user_id,
                       b.full_name AS builder_name, b.email AS builder_email,
                       b.cohort   AS builder_cohort,
                       m.email    AS staff_email
                FROM public.intro_requests ir
                LEFT JOIN LATERAL bedrock.builder_by_id(ir.builder_id) b ON true
                LEFT JOIN bedrock.staff_user_id_map m ON m.staff_user_id = ir.staff_user_id
                WHERE ir.created_at > $1
                  AND ir.status = 'pending'
                ORDER BY ir.created_at ASC
                LIMIT 200
                """,
                watermark,
            )
            if not rows:
                return 0

            newest = watermark
            for r in rows:
                # Advance across every row we considered, including skipped
                # ones — otherwise an unmappable staff id pins the watermark
                # and we re-scan it forever.
                if r["created_at"] and r["created_at"] > newest:
                    newest = r["created_at"]

                if not r["staff_email"]:
                    logger.info(
                        "intro %s: staff_user_id %s not in staff_user_id_map, skipping",
                        r["intro_request_id"], r["staff_user_id"],
                    )
                    continue

                notif_id = await enqueue_notification(
                    conn,
                    recipient_email=r["staff_email"],
                    type=TYPE_INTRO_REQUEST,
                    actor_email=r["builder_email"],
                    payload=_payload(r),
                )
                if notif_id:
                    inserted += 1

            await _write_watermark(conn, SOURCE_BUILDER_INTRO, newest)

    return inserted


def _builder_display(r) -> str:
    """name → email → id. Never empty; a blank name is what produced the
    "from —" cards this flow used to show."""
    name = (r["builder_name"] or "").strip()
    if name:
        return name
    email = (r["builder_email"] or "").strip()
    if email:
        return email
    return f"Builder #{r['builder_id']}"


def _payload(r) -> dict:
    who = _builder_display(r)
    return {
        "title": "Intro request",
        "requester_kind": "builder",
        "actor_display_name": who,
        "builder_id": r["builder_id"],
        "builder_cohort": r["builder_cohort"],
        "subtitle": r["contact_name"] or "a contact",
        "contact_name": r["contact_name"],
        "contact_company": r["contact_company"],
        "ask": ASK_LABELS.get(r["specific_ask"] or "", r["specific_ask"]),
        "context": (r["request_context"] or "")[:280] or None,
        "target_url": "/jobs",
        "sputnik_intro_request_id": r["intro_request_id"],
    }


async def _lock_watermark(conn, source: str) -> "tuple[datetime, bool]":
    """Take FOR UPDATE on this source's watermark row. Returns
    (watermark, was_just_seeded). Must be called inside a transaction.

    Seeds to *now* rather than an hour back: unlike the SF pollers there is a
    months-old backlog sitting in this table, and replaying it would DM the
    team about every historical ask.
    """
    row = await conn.fetchrow(
        "SELECT last_seen FROM bedrock.notification_watermark WHERE source = $1 FOR UPDATE",
        source,
    )
    if row:
        return row["last_seen"], False

    now = datetime.now(timezone.utc).replace(microsecond=0)
    await conn.execute(
        "INSERT INTO bedrock.notification_watermark (source, last_seen) "
        "VALUES ($1, $2) ON CONFLICT (source) DO NOTHING",
        source, now,
    )
    # Re-read under the lock: a concurrent instance may have won the insert.
    existing = await conn.fetchval(
        "SELECT last_seen FROM bedrock.notification_watermark WHERE source = $1 FOR UPDATE",
        source,
    )
    return (existing or now), True


async def _write_watermark(conn, source: str, ts: datetime) -> None:
    await conn.execute(
        "UPDATE bedrock.notification_watermark SET last_seen = $2, updated_at = now() "
        "WHERE source = $1",
        source, ts,
    )
