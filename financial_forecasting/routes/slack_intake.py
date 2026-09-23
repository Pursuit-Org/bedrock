"""Slack Events API listener for jobs intake — embedded in the Bedrock backend.

Runs on the same Cloud Run service as the rest of the API (no separate process,
no Socket Mode). Slack POSTs events to ``/api/jobs/intake/slack-events``; this
route:

  1. verifies the Slack signing secret on every request;
  2. answers Slack's one-time URL-verification challenge;
  3. on a new top-level post in an allowlisted channel → parses the opportunity
     and posts a proposal back in-thread;
  4. on a 👍 reaction from a human → calls the intake orchestrator in-process
     and posts the result, rendering ``needs_choice`` candidates as a pick-list.

Channel scoping is CONFIG-DRIVEN via the ``JOBS_INTAKE_CHANNELS`` env var
(comma-separated channel ids). Dropping the sandbox later is a config edit, not
a code change.

Dedicated Slack app credentials (distinct from the org-wide ``SLACK_BOT_TOKEN``):
  - ``JOBS_SLACK_BOT_TOKEN``     — bot token for chat.postMessage / lookups
  - ``JOBS_SLACK_SIGNING_SECRET`` — verifies inbound Events API requests
"""

import hashlib
import hmac
import json
import logging
import os
import re
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request

from db import get_pool
from dependencies import _services
from routes.jobs_intake import (
    IntakeAccount,
    IntakeAttribution,
    IntakeContact,
    IntakeOpportunity,
    IntakeRole,
    SlackOpportunityIntake,
    run_slack_opportunity_intake,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/jobs/intake", tags=["jobs-intake"])

# Both launch channels by default: C0AFY30M7UN = #agent-sandbox (testing),
# C0B26TX0L4T = #jobs-team (production). Drop the sandbox later by editing the
# JOBS_INTAKE_CHANNELS env var only — no code change.
_DEFAULT_CHANNELS = "C0AFY30M7UN,C0B26TX0L4T"
APPROVAL_REACTIONS = {"+1", "thumbsup"}
_SLACK_API = "https://slack.com/api"

# Cached bot user id (from auth.test) so we can ignore the bot's own reactions.
_bot_user_id: Optional[str] = None


def _signing_secret() -> str:
    return os.getenv("JOBS_SLACK_SIGNING_SECRET", "")


def _bot_token() -> str:
    return os.getenv("JOBS_SLACK_BOT_TOKEN", "")


def _allowed_channels() -> set:
    raw = os.getenv("JOBS_INTAKE_CHANNELS", _DEFAULT_CHANNELS)
    return {c.strip() for c in raw.split(",") if c.strip()}


# ---------------------------------------------------------------------------
# Signature verification
# ---------------------------------------------------------------------------

def _verify_slack_signature(raw_body: bytes, timestamp: str, signature: str) -> bool:
    """Validate Slack's v0 request signature. Fails closed when unconfigured."""
    secret = _signing_secret()
    if not secret:
        logger.warning("JOBS_SLACK_SIGNING_SECRET not set — rejecting Slack event")
        return False
    try:
        if abs(time.time() - int(timestamp)) > 60 * 5:
            return False  # stale — replay protection
    except (TypeError, ValueError):
        return False
    basestring = b"v0:" + timestamp.encode() + b":" + raw_body
    digest = hmac.new(secret.encode(), basestring, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v0=" + digest, signature or "")


# ---------------------------------------------------------------------------
# Slack Web API helpers
# ---------------------------------------------------------------------------

async def _slack_get(method: str, params: dict) -> dict:
    token = _bot_token()
    if not token:
        return {}
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"{_SLACK_API}/{method}",
                params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
            return r.json()
    except Exception as e:
        logger.warning("Slack GET %s failed: %s", method, e)
        return {}


async def _slack_post(method: str, payload: dict) -> dict:
    token = _bot_token()
    if not token:
        return {}
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(
                f"{_SLACK_API}/{method}",
                json=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
            )
            return r.json()
    except Exception as e:
        logger.warning("Slack POST %s failed: %s", method, e)
        return {}


async def _post_thread(channel: str, thread_ts: str, text: str) -> None:
    await _slack_post("chat.postMessage", {"channel": channel, "thread_ts": thread_ts, "text": text})


async def _fetch_message(channel: str, ts: str) -> Optional[dict]:
    """Fetch a single message by ts (the reacted-to post)."""
    res = await _slack_get(
        "conversations.history",
        {"channel": channel, "latest": ts, "oldest": ts, "inclusive": "true", "limit": 1},
    )
    msgs = res.get("messages") or []
    return msgs[0] if msgs else None


async def _fetch_user(user_id: str) -> dict:
    res = await _slack_get("users.info", {"user": user_id})
    return res.get("user") or {}


async def _bot_id() -> Optional[str]:
    global _bot_user_id
    if _bot_user_id is None:
        res = await _slack_get("auth.test", {})
        _bot_user_id = res.get("user_id")
    return _bot_user_id


def _permalink(channel: str, ts: str) -> str:
    return f"https://slack.com/archives/{channel}/p{ts.replace('.', '')}"


# ---------------------------------------------------------------------------
# Best-effort opportunity parser
# ---------------------------------------------------------------------------
# Interim heuristic extraction from a free-text post. Deterministic and
# dependency-free so the flow is testable without an LLM; richer extraction can
# replace this without touching the endpoint contract.

_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_SALARY_RE = re.compile(r"\$\s?(\d{2,3})\s?[kK]\b|\$\s?(\d{2,3}(?:,\d{3})+)")
_COMPANY_RE = re.compile(r"\b(?:at|for|with)\s+([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?=[,.\n]| needs| is | are |$)")
_CONTACT_RE = re.compile(r"\b(?:contact|poc|reach out to|intro to)\s*(?:is|:)?\s*([A-Z][a-z]+ [A-Z][a-z]+)")
_ROLE_RE = re.compile(r"\b(?:needs?|hiring|looking for|wants?)\s+(?:\d+\s+)?([A-Za-z][A-Za-z /]{2,40}?)(?=[,.\n]|$)")


def parse_opportunity_text(text: str) -> Optional[dict]:
    """Extract a rough opportunity proposal from a Slack post. Returns None when
    nothing actionable (no company) can be found."""
    if not text:
        return None
    text = text.strip()

    email = None
    m = _EMAIL_RE.search(text)
    if m:
        email = m.group(0)

    salary = None
    m = _SALARY_RE.search(text)
    if m:
        if m.group(1):
            salary = int(m.group(1)) * 1000
        elif m.group(2):
            salary = int(m.group(2).replace(",", ""))

    company = None
    m = _COMPANY_RE.search(text)
    if m:
        company = m.group(1).strip()
    if not company and email:
        # Fall back to the email domain's second-level label as a company hint.
        domain = email.split("@", 1)[1].split(".")[0]
        if domain not in ("gmail", "yahoo", "outlook", "hotmail", "icloud"):
            company = domain.capitalize()
    if not company:
        return None

    contact_name = None
    m = _CONTACT_RE.search(text)
    if m:
        contact_name = m.group(1).strip()

    role_title = None
    m = _ROLE_RE.search(text)
    if m:
        role_title = m.group(1).strip().title()

    return {
        "account": {"name": company},
        "contact": {"full_name": contact_name, "email": email, "current_company": company},
        "opportunity": {"title": role_title, "salary_expected": salary},
        "role": {"title": role_title, "approx_salary": salary} if role_title else None,
    }


def _proposal_summary(parsed: dict) -> str:
    acct = parsed["account"]["name"]
    c = parsed["contact"]
    who = c.get("full_name") or c.get("email") or "unknown contact"
    role = parsed["opportunity"].get("title") or "role TBD"
    sal = parsed["opportunity"].get("salary_expected")
    sal_s = f" · ~${sal:,}" if sal else ""
    return f"*{acct}* · *{who}* · *{role}*{sal_s}"


# ---------------------------------------------------------------------------
# Intake payload builder + result rendering
# ---------------------------------------------------------------------------

def _build_intake(parsed: dict, attribution: IntakeAttribution) -> SlackOpportunityIntake:
    c = parsed["contact"]
    o = parsed["opportunity"]
    r = parsed.get("role")
    return SlackOpportunityIntake(
        account=IntakeAccount(name=parsed["account"]["name"]),
        contact=IntakeContact(
            full_name=c.get("full_name") or (c.get("email") or "Unknown Contact"),
            email=c.get("email"),
            current_company=c.get("current_company"),
        ),
        opportunity=IntakeOpportunity(
            title=o.get("title"),
            salary_expected=o.get("salary_expected"),
        ),
        role=IntakeRole(title=r["title"], approx_salary=r.get("approx_salary")) if r and r.get("title") else None,
        attribution=attribution,
    )


def _render_result(result: dict) -> str:
    status = result.get("status")
    if status == "needs_choice":
        lines = ["I need a human to disambiguate before creating anything:"]
        for choice in result.get("choices", []):
            lines.append(f"\n*{choice['object'].title()}* — {choice.get('reason', '')}")
            for i, cand in enumerate(choice.get("candidates", []), 1):
                label = (
                    cand.get("label")
                    or cand.get("full_name")
                    or cand.get("title")
                    or cand.get("key")
                    or "?"
                )
                extra = cand.get("email") or cand.get("stage") or cand.get("sf_account_id") or ""
                lines.append(f"  {i}. {label}" + (f" ({extra})" if extra else ""))
        lines.append("\nReply with the object and number to pick (e.g. `account 2`).")
        return "\n".join(lines)

    data = result.get("data", {})
    if result.get("idempotent_replay"):
        return "Already logged this post in Bedrock — no duplicate created."
    parts = ["Added to Bedrock:"]
    acct = data.get("account") or {}
    parts.append(f"• Account *{acct.get('display')}* ({'linked' if acct.get('matched') else 'created'})")
    contact = data.get("contact") or {}
    parts.append(f"• Contact ({'linked' if contact.get('matched') else 'created'})")
    opp = data.get("opportunity") or {}
    parts.append(f"• Opportunity `{opp.get('id')}` · stage {opp.get('stage')}")
    role = data.get("role")
    if role:
        parts.append(f"• Role *{role.get('title')}* ({'linked' if not role.get('created') else 'created'})")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Event handlers
# ---------------------------------------------------------------------------

async def _handle_message(event: dict) -> None:
    """New top-level post → parse and propose in-thread."""
    parsed = parse_opportunity_text(event.get("text") or "")
    if not parsed:
        return
    channel = event["channel"]
    ts = event["ts"]
    await _post_thread(
        channel, ts,
        f"I read: {_proposal_summary(parsed)}.\n"
        f"React 👍 on this post to add it to Bedrock.",
    )


async def _handle_reaction(event: dict) -> None:
    """👍 from a human → run the intake and post the result."""
    reactor = event.get("user")
    if reactor and reactor == await _bot_id():
        return  # ignore the bot's own reactions
    item = event.get("item") or {}
    channel = item.get("channel")
    ts = item.get("ts")
    if not (channel and ts):
        return

    msg = await _fetch_message(channel, ts)
    if not msg:
        return
    parsed = parse_opportunity_text(msg.get("text") or "")
    if not parsed:
        return

    user_info = await _fetch_user(reactor) if reactor else {}
    profile = user_info.get("profile") or {}
    attribution = IntakeAttribution(
        bot_id="jobs-intake-bot",
        approved_by_slack_id=reactor,
        approved_by_name=user_info.get("real_name") or user_info.get("name"),
        approved_by_email=profile.get("email"),
        source_channel_id=channel,
        source_message_ts=ts,
        source_message_url=_permalink(channel, ts),
    )
    body = _build_intake(parsed, attribution)

    client = _services.get("mcp_client")
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await run_slack_opportunity_intake(body, conn, client)
    await _post_thread(channel, ts, _render_result(result))


async def _handle_event(event: dict) -> None:
    etype = event.get("type")
    channel = event.get("channel") or (event.get("item") or {}).get("channel")
    if channel not in _allowed_channels():
        return  # allowlist: ignore everything outside JOBS_INTAKE_CHANNELS
    if etype == "message":
        # Only fresh top-level human posts trigger a proposal.
        if event.get("bot_id") or event.get("subtype") or event.get("thread_ts"):
            return
        await _handle_message(event)
    elif etype == "reaction_added":
        if event.get("reaction") in APPROVAL_REACTIONS:
            await _handle_reaction(event)


# ---------------------------------------------------------------------------
# Webhook endpoint
# ---------------------------------------------------------------------------

@router.post("/slack-events")
async def slack_events(request: Request):
    """Slack Events API webhook. Verifies the signing secret, answers the
    URL-verification challenge, and dispatches allowlisted events."""
    raw = await request.body()
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    signature = request.headers.get("X-Slack-Signature", "")
    if not _verify_slack_signature(raw, timestamp, signature):
        raise HTTPException(status_code=401, detail="invalid Slack signature")

    try:
        payload = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid JSON")

    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}

    if payload.get("type") == "event_callback":
        # Best-effort inline handling; Slack retries on non-200, and intake is
        # idempotent on the message ts, so a retry can't double-create.
        try:
            await _handle_event(payload.get("event") or {})
        except Exception as e:  # never 500 back to Slack for a handler bug
            logger.exception("slack intake event handling failed: %s", e)

    return {"ok": True}
