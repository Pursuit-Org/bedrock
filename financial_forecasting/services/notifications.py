"""Notification dispatch — writes bedrock.notification rows and best-effort
DMs the recipient via Slack.

Design notes:

- Every notification trigger calls :func:`enqueue_notification` from inside
  the request handler. The DB insert runs inside the request so the in-app
  bell sees the new row immediately on the next ``GET /api/notifications``;
  the Slack DM is dispatched with ``asyncio.create_task`` so the route
  returns without waiting on Slack's response.

- Slack delivery is best-effort. Failures are recorded on the row
  (``slack_status`` = ``failed``/``skipped``) but never surface to the
  request — the user's in-app notification still appears. Slack outages
  shouldn't break task assignment.

- ``users.lookupByEmail`` is rate-limited by Slack (Tier 4: ~100/min).
  We cache the resolved id on ``public.org_users.slack_user_id`` so the
  second notification to the same person skips the lookup.

- Recipient email comparison is case-insensitive (Slack normalizes to
  lowercase; SF Owner.Email may not). Always lower() before lookup.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional
from uuid import UUID

from dependencies import _services


def _frontend_base_url() -> str:
    """Public base URL for the frontend, used to build absolute links in
    Slack messages (Slack action buttons require absolute URLs). Reads
    FRONTEND_URL from env; falls back to localhost for dev. Strips
    trailing slashes so caller can safely concatenate ``f"{base}{path}"``.
    """
    url = (os.environ.get("FRONTEND_URL") or "http://localhost:4200").rstrip("/")
    return url


def _absolutize(target_url: Optional[str]) -> Optional[str]:
    """Promote a relative app path (``/projects/abc``) to an absolute URL
    so Slack's actions block accepts it. Pass-through if already absolute
    or empty."""
    if not target_url:
        return None
    if target_url.startswith(("http://", "https://")):
        return target_url
    if not target_url.startswith("/"):
        target_url = "/" + target_url
    return f"{_frontend_base_url()}{target_url}"

logger = logging.getLogger(__name__)

# Notification types — keep in sync with the CHECK constraint on
# bedrock.notification.type and the frontend NotificationType union.
TYPE_PROJECT_TASK_ASSIGNED = "project_task_assigned"
TYPE_COMMENT_MENTION = "comment_mention"
TYPE_SF_TASK_ASSIGNED = "sf_task_assigned"
TYPE_SF_OPP_OWNER_CHANGED = "sf_opp_owner_changed"
TYPE_INTRO_REQUEST = "intro_request"
TYPE_INTRO_RESPONSE = "intro_response"

ALL_TYPES = {
    TYPE_PROJECT_TASK_ASSIGNED,
    TYPE_COMMENT_MENTION,
    TYPE_SF_TASK_ASSIGNED,
    TYPE_SF_OPP_OWNER_CHANGED,
    TYPE_INTRO_REQUEST,
    TYPE_INTRO_RESPONSE,
}


def _slack_service():
    """Pull the SlackMCPService instance (or None if Slack isn't connected)."""
    client = _services.get("mcp_client")
    if not client:
        return None
    return client.services.get("slack")


async def enqueue_notification(
    conn,
    *,
    recipient_email: str,
    type: str,
    payload: Dict[str, Any],
    actor_email: Optional[str] = None,
) -> Optional[str]:
    """Insert a notification row and fire-and-forget the Slack DM.

    Returns the inserted row's id (UUID as str), or None when the insert
    was skipped (recipient missing). Never raises on Slack failure — the
    Slack worker logs and updates ``slack_status`` on the row.
    """
    if not recipient_email:
        logger.debug("enqueue_notification: skip (no recipient_email)")
        return None
    if type not in ALL_TYPES:
        raise ValueError(f"Unknown notification type: {type}")

    recipient_norm = recipient_email.strip().lower()
    payload_json = json.dumps(payload, default=_json_default)

    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.notification
          (recipient_email, type, payload, actor_email)
        VALUES ($1, $2, $3::jsonb, $4)
        RETURNING id
        """,
        recipient_norm, type, payload_json, actor_email,
    )
    notif_id: str = str(row["id"])

    # Fire Slack dispatch without blocking the request.
    asyncio.create_task(
        _dispatch_slack(notif_id, recipient_norm, type, payload, actor_email)
    )

    return notif_id


async def _dispatch_slack(
    notif_id: str,
    recipient_email: str,
    type: str,
    payload: Dict[str, Any],
    actor_email: Optional[str],
) -> None:
    """Background task: resolve the recipient's Slack id and post a DM."""
    pool = _services.get("db_pool")
    if not pool:
        logger.warning("Slack dispatch: no db pool, skipping notif %s", notif_id)
        return

    try:
        async with pool.acquire() as conn:
            slack_id = await _resolve_slack_id(conn, recipient_email)
            if not slack_id:
                await _mark_slack(conn, notif_id, "skipped", note="no_slack_id")
                return

            message = _format_slack_message(type, payload, actor_email)
            slack = _slack_service()
            if not slack:
                await _mark_slack(conn, notif_id, "skipped", note="no_slack_service")
                return

            try:
                await slack.slack_client.chat_postMessage(
                    channel=slack_id,
                    text=message["text"],
                    blocks=message.get("blocks"),
                    unfurl_links=False,
                    unfurl_media=False,
                )
                await _mark_slack(conn, notif_id, "sent")
            except Exception as e:
                logger.warning("Slack DM failed for notif %s: %s", notif_id, e)
                await _mark_slack(conn, notif_id, "failed", note=str(e)[:200])
    except Exception as e:
        # Defensive: never propagate from the background task.
        logger.exception("Slack dispatch crashed for notif %s: %s", notif_id, e)


async def _resolve_slack_id(conn, email: str) -> Optional[str]:
    """Email → Slack user id with persistent cache in bedrock.slack_user_cache.

    Lazy population: on cache miss, hit Slack's ``users.lookupByEmail``
    (Tier 4 rate-limited) and persist the result on success. Entries are
    indefinite — Slack ids are stable for the workspace's lifetime, and
    if a user leaves Slack their id stays the same anyway (DMs to a
    departed user just bounce silently)."""
    if not email:
        return None
    email_norm = email.strip().lower()
    cached = await conn.fetchval(
        "SELECT slack_user_id FROM bedrock.slack_user_cache WHERE email = $1",
        email_norm,
    )
    if cached:
        return cached

    slack = _slack_service()
    if not slack:
        return None
    try:
        resp = await slack.slack_client.users_lookupByEmail(email=email_norm)
        user = resp.get("user") or {}
        slack_id = user.get("id")
        if not slack_id:
            return None
        await conn.execute(
            "INSERT INTO bedrock.slack_user_cache (email, slack_user_id) "
            "VALUES ($1, $2) "
            "ON CONFLICT (email) DO UPDATE SET slack_user_id = EXCLUDED.slack_user_id, "
            "looked_up_at = now()",
            email_norm, slack_id,
        )
        return slack_id
    except Exception as e:
        logger.info("users.lookupByEmail miss for %s: %s", email, e)
        return None


async def _mark_slack(conn, notif_id: str, status: str, *, note: str = "") -> None:
    sent_at = datetime.now(timezone.utc) if status == "sent" else None
    if note:
        await conn.execute(
            "UPDATE bedrock.notification SET slack_status = $2, slack_sent_at = $3, "
            "payload = payload || jsonb_build_object('slack_note', $4::text) "
            "WHERE id = $1",
            UUID(notif_id), status, sent_at, note,
        )
    else:
        await conn.execute(
            "UPDATE bedrock.notification SET slack_status = $2, slack_sent_at = $3 "
            "WHERE id = $1",
            UUID(notif_id), status, sent_at,
        )


def _format_slack_message(
    type: str, payload: Dict[str, Any], actor_email: Optional[str]
) -> Dict[str, Any]:
    """Render a Slack message from the notification payload. Returns
    {text, blocks}. `text` is used as the fallback for lock-screen /
    mobile previews; blocks are used in the in-Slack rendering.

    Layout per type:

      project_task_assigned:
          {actor} assigned you a task
          *Project*: {name}
          *Workstream*: {name}
          *Milestone*: {name}
          *Task*: *{name}*       ← bolded

      comment_mention:
          {actor} mentioned you in a comment:
          *Project*: {name}
          *Task*: {name}
          *Comment*: *{body}*    ← bolded
    """
    actor = (
        payload.get("actor_display_name")
        or actor_email
        or "Someone"
    )
    target_url = payload.get("target_url")
    abs_url = _absolutize(target_url)

    section_lines: List[str] = []

    if type == TYPE_PROJECT_TASK_ASSIGNED:
        headline = f":clipboard: *{actor}* assigned you a task"
        if payload.get("project_name"):
            section_lines.append(f"*Project:* {payload['project_name']}")
        if payload.get("workstream_name"):
            section_lines.append(f"*Workstream:* {payload['workstream_name']}")
        if payload.get("milestone_title"):
            section_lines.append(f"*Milestone:* {payload['milestone_title']}")
        if payload.get("task_title") or payload.get("subtitle"):
            task = payload.get("task_title") or payload.get("subtitle")
            section_lines.append(f"*Task:* *{task}*")
    elif type == TYPE_COMMENT_MENTION:
        headline = f":speech_balloon: *{actor}* mentioned you in a comment"
        if payload.get("project_name"):
            section_lines.append(f"*Project:* {payload['project_name']}")
        if payload.get("task_title"):
            section_lines.append(f"*Task:* {payload['task_title']}")
        # Prefer the full body (already capped at 280 chars at enqueue) so
        # the Slack reader sees the actual comment, not a truncated subtitle.
        body = payload.get("comment_body") or payload.get("subtitle") or ""
        if body:
            section_lines.append(f"*Comment:* *{body}*")
    elif type == TYPE_SF_TASK_ASSIGNED:
        headline = f":bell: *{actor}* assigned you a Salesforce task"
        if payload.get("what_name"):
            section_lines.append(f"*Related:* {payload['what_name']}")
        if payload.get("activity_date"):
            section_lines.append(f"*Due:* {payload['activity_date']}")
        task = payload.get("task_title") or payload.get("subtitle")
        if task:
            section_lines.append(f"*Task:* *{task}*")
    elif type == TYPE_SF_OPP_OWNER_CHANGED:
        role = payload.get("role")
        opp_name = payload.get("opp_name") or payload.get("subtitle") or ""
        if role == "gained":
            headline = f":handshake: *{actor}* made you the owner"
            if opp_name:
                section_lines.append(f"*Opportunity:* *{opp_name}*")
        elif role == "lost":
            headline = f":handshake: *{actor}* reassigned an opportunity"
            if opp_name:
                section_lines.append(f"*Opportunity:* {opp_name}")
            if payload.get("new_owner_name"):
                section_lines.append(f"*Now owned by:* {payload['new_owner_name']}")
        else:
            # Defensive fallback if role isn't set on a legacy row.
            headline = ":handshake: *Opportunity ownership changed*"
            if opp_name:
                section_lines.append(f"*{opp_name}*")
    elif type == TYPE_INTRO_REQUEST:
        # Builder asks originate in Sputnik and are surfaced by
        # intro_notification_poller; staff→staff asks are created in Bedrock.
        # Say which, so one bot can carry both without ambiguity.
        if payload.get("requester_kind") == "builder":
            headline = f":raising_hand: *{actor}* (builder) asked you for an intro"
            if payload.get("builder_cohort"):
                section_lines.append(f"*Cohort:* {payload['builder_cohort']}")
        else:
            headline = f":wave: *{actor}* asked you for an intro"
        if payload.get("contact_name"):
            who = payload["contact_name"]
            if payload.get("contact_company"):
                who += f" ({payload['contact_company']})"
            section_lines.append(f"*Contact:* *{who}*")
        if payload.get("ask"):
            section_lines.append(f"*Ask:* {payload['ask']}")
        if payload.get("context"):
            section_lines.append(f"*Context:* {payload['context']}")
        section_lines.append("Respond from the Jobs home page in Bedrock.")
    elif type == TYPE_INTRO_RESPONSE:
        verb = {"accepted": "accepted", "declined": "declined", "completed": "made"}.get(
            payload.get("status") or "", "updated")
        headline = f":handshake: *{actor}* {verb} your intro request" if verb != "made" \
            else f":handshake: *{actor}* made the intro"
        if payload.get("contact_name"):
            section_lines.append(f"*Contact:* *{payload['contact_name']}*")
        if payload.get("response_note"):
            section_lines.append(f"*Note:* {payload['response_note']}")
    else:
        headline = payload.get("title") or "Bedrock notification"
        sub = payload.get("subtitle") or ""
        if sub:
            section_lines.append(sub)

    section_text = headline + ("\n" + "\n".join(section_lines) if section_lines else "")

    blocks: List[Dict[str, Any]] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": section_text}},
    ]
    # Plain-text fallback — Slack's lock-screen / mobile preview only
    # reads the top-level `text` field, never blocks. Strip mrkdwn so
    # the preview reads cleanly.
    text = section_text.replace("*", "")
    if abs_url:
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Open in Bedrock"},
                        "url": abs_url,
                    }
                ],
            }
        )
        # Keep the URL in the text field too so it's tappable from mobile.
        text = f"{text}\n{abs_url}"

    return {"text": text, "blocks": blocks}


# ── Mention parsing ─────────────────────────────────────────────────────────

_MENTION_RE = None


def _mention_re():
    """Lazy-compiled regex for @-mentions in comment bodies.

    Matches `@displayname`, `@email@domain.tld`, or `@first-last`. We
    intentionally accept dots, hyphens, underscores, and spaces (limited
    to one) so "@Jacqueline Reverand" matches a display_name. The match
    is greedy across word characters; ambiguities are resolved by the
    org_users lookup downstream (first case-insensitive match wins).
    """
    global _MENTION_RE
    if _MENTION_RE is None:
        import re
        _MENTION_RE = re.compile(
            r"@([A-Za-z0-9._\-]+(?:[ ][A-Za-z0-9._\-]+){0,2})"
        )
    return _MENTION_RE


async def resolve_mentions(conn, body: str) -> List[Dict[str, Any]]:
    """Parse @-mentions out of a comment body and resolve each to an
    org_users row. Returns a list of {email, display_name, sf_user_id}
    deduplicated by email.

    The mention regex captures up to 3 word-segments after ``@`` so
    multi-part display names like "John Paul Smith" work. Because the
    capture is greedy, an input like ``@Jacqueline Reverand again`` will
    match ``"Jacqueline Reverand again"``. To recover, we try the full
    captured token, then progressively drop the trailing word until we
    either find an org_users match or run out of words.

    Matching strategy (per candidate prefix, first hit wins):
      1. Exact email match on org_users.email (only if token looks
         like an email).
      2. Case-insensitive display_name == candidate.
      3. Case-insensitive display_name starts-with candidate (only
         when the candidate is the single-word leftmost token — using
         starts-with on a partial multi-word string would let
         "John " match "John Paul Smith" in unintuitive ways).
    """
    if not body:
        return []
    tokens = list(dict.fromkeys(_mention_re().findall(body)))
    if not tokens:
        return []

    out: Dict[str, Dict[str, Any]] = {}
    for tok in tokens:
        norm = tok.strip()
        if not norm:
            continue
        row = await _resolve_one_mention(conn, norm)
        if row and row["email"]:
            email = row["email"]
            if email not in out:
                out[email] = {
                    "email": email,
                    "display_name": row["display_name"],
                    "sf_user_id": row["sf_user_id"],
                }
    return list(out.values())


async def _resolve_one_mention(conn, token: str):
    """Try resolving the captured @-token, progressively dropping the
    last whitespace-separated word until either a match is found or
    only the first word remains. Returns the org_users row or None."""
    candidate = token.strip()
    while candidate:
        # 1. Email-shaped → exact email match.
        if "@" in candidate and "." in candidate:
            row = await conn.fetchrow(
                "SELECT id, email, display_name, sf_user_id FROM public.org_users "
                "WHERE LOWER(email) = LOWER($1) LIMIT 1",
                candidate,
            )
            if row:
                return row
        # 2. Exact display_name match.
        row = await conn.fetchrow(
            "SELECT id, email, display_name, sf_user_id FROM public.org_users "
            "WHERE LOWER(display_name) = LOWER($1) LIMIT 1",
            candidate,
        )
        if row:
            return row
        # 3. Single-word candidate → fall back to display_name starts-with.
        #    Only do this when we've narrowed to one token so we don't
        #    overmatch on partial multi-word strings.
        if " " not in candidate:
            row = await conn.fetchrow(
                "SELECT id, email, display_name, sf_user_id FROM public.org_users "
                "WHERE LOWER(display_name) LIKE LOWER($1 || ' %') "
                "   OR LOWER(display_name) = LOWER($1) "
                "ORDER BY display_name LIMIT 1",
                candidate,
            )
            if row:
                return row
            return None  # nothing left to try
        # Drop the trailing word and try again.
        candidate = candidate.rsplit(" ", 1)[0].strip()
    return None


def _json_default(o):
    if isinstance(o, (datetime,)):
        return o.isoformat()
    if isinstance(o, UUID):
        return str(o)
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")
