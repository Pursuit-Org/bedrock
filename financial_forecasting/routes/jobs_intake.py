"""Slack → jobs intake.

One endpoint — ``POST /api/jobs/intake/slack-opportunity`` — that owns the whole
resolve → dedupe → create flow for an employer lead in a single DB transaction,
so a caller (the Slack intake bot) can never half-create or duplicate records.

Dedupe is enforced here, never trusted to the caller. For every object
(account, contact, opportunity, role):

    confident match  → LINK the existing record (never blind-create)
    ambiguous match  → return ``needs_choice`` with candidates, WRITE NOTHING
    miss             → CREATE, stamped with who approved it and where it came from

The handler orchestrates the existing jobs create/lookup logic rather than
reinventing it — it imports and calls ``resolve_account``, ``search_all_contacts``,
``create_jobs_account``, ``create_contact``, ``create_opportunity`` and
``create_opp_role`` from ``routes.jobs`` so both the REST endpoints and this
orchestrator run the same code inside one shared transaction.

Attribution ships now via the existing free-text ``source`` field (no DDL): every
created row is stamped so it reads as bot/Claude-created plus the approving Slack
user, channel and message link. Idempotency is keyed on the source Slack message
ts, stored in the existing ``jobs_opportunity.airtable_id TEXT UNIQUE`` column as
``slack:<channel_id>:<ts>`` — a repeat call (Slack retry, double-👍) finds the
existing opportunity and returns it with ``idempotent_replay = true``.

Salesforce is never written here: ``sf_account_id`` links only.
"""

import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_auth_or_internal
from db import get_db
from dependencies import get_mcp_client
from routes.jobs import (
    resolve_account,
    search_all_contacts,
    create_jobs_account,
    create_contact,
    create_opportunity,
    create_opp_role,
    JobsAccountCreate,
    ContactCreate,
    OpportunityCreate,
    RoleCreate,
    _acct_nkey,
    VALID_STAGES,
    VALID_DEAL_TYPES,
    VALID_LIKELIHOODS,
)

logger = logging.getLogger(__name__)

# Shares the /api/jobs prefix with routes.jobs so the public path is
# /api/jobs/intake/slack-opportunity. Kept in its own module (and router) to
# leave the 5k-line routes/jobs.py untouched while reusing its functions.
router = APIRouter(prefix="/api/jobs", tags=["jobs-intake"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class IntakeAccount(BaseModel):
    name: str                                     # feeds accounts/resolve + display
    sf_account_id: Optional[str] = None           # link an existing SF account; NEVER creates one


class IntakeContact(BaseModel):
    full_name: str
    email: Optional[str] = None                   # the preferred match key
    current_title: Optional[str] = None
    current_company: Optional[str] = None          # defaults to account.name
    linkedin_url: Optional[str] = None
    # Pins for re-calls after a needs_choice pick — force a specific contact.
    contact_id: Optional[int] = None
    contact_ref: Optional[str] = None


class IntakeOpportunity(BaseModel):
    title: Optional[str] = None
    deal_type: Optional[str] = None
    stage: str = "lead_submitted"
    salary_expected: Optional[int] = None
    num_roles: Optional[int] = None
    likelihood: Optional[str] = None
    owner_email: Optional[str] = None
    relationship_owner: Optional[str] = None
    note: Optional[str] = None


class IntakeRole(BaseModel):
    title: str
    employment_type: Optional[str] = None
    approx_salary: Optional[int] = None
    notes: Optional[str] = None
    commitment: Optional[str] = None
    # pathfinder_visible is intentionally NOT accepted — roles are always
    # created hidden; publishing to Pathfinder stays a manual human action.


class IntakeAttribution(BaseModel):
    bot_id: Optional[str] = None
    approved_by_slack_id: Optional[str] = None
    approved_by_name: Optional[str] = None
    approved_by_email: Optional[str] = None
    source_channel: Optional[str] = None
    source_channel_id: Optional[str] = None
    source_message_ts: str                        # the idempotency key
    source_message_url: Optional[str] = None


class SlackOpportunityIntake(BaseModel):
    account: IntakeAccount
    contact: IntakeContact
    opportunity: IntakeOpportunity = IntakeOpportunity()
    role: Optional[IntakeRole] = None
    attribution: IntakeAttribution


# ---------------------------------------------------------------------------
# Attribution helpers (interim `source` overload — zero DDL)
# ---------------------------------------------------------------------------

def _attribution_source(attr: IntakeAttribution) -> str:
    """Self-describing free-text stamp for the `source`/`notes` fields.

    Reads at a glance as bot/Claude-created plus the human who approved it and
    where it came from, e.g.
    ``claude-intake · 👍 Devika Nair (U0123ABCD) · #jobs-team · <msg-url>``.
    """
    who = attr.approved_by_name or attr.approved_by_slack_id or "unknown"
    sid = f" ({attr.approved_by_slack_id})" if attr.approved_by_slack_id else ""
    parts = [f"claude-intake · 👍 {who}{sid}"]
    chan = attr.source_channel or attr.source_channel_id
    if chan:
        parts.append(chan)
    if attr.source_message_url:
        parts.append(attr.source_message_url)
    return " · ".join(parts)


def _intake_key(attr: IntakeAttribution) -> str:
    """Idempotency key stored in jobs_opportunity.airtable_id (TEXT UNIQUE)."""
    chan = attr.source_channel_id or attr.source_channel or "slack"
    return f"slack:{chan}:{attr.source_message_ts}"


# ---------------------------------------------------------------------------
# Orchestrator — importable so the embedded Slack listener can call it in-process
# ---------------------------------------------------------------------------

async def run_slack_opportunity_intake(body: SlackOpportunityIntake, conn, client) -> dict:
    """Resolve → dedupe → create in one transaction. See module docstring."""
    opp = body.opportunity
    if opp.stage not in VALID_STAGES:
        raise HTTPException(400, f"Invalid stage: {opp.stage}")
    if opp.deal_type and opp.deal_type not in VALID_DEAL_TYPES:
        raise HTTPException(400, f"Invalid deal_type: {opp.deal_type}")
    if opp.likelihood and opp.likelihood not in VALID_LIKELIHOODS:
        raise HTTPException(400, f"Invalid likelihood: {opp.likelihood}")

    attr = body.attribution
    src = _attribution_source(attr)
    intake_key = _intake_key(attr)
    svc_user = {
        "user_id": "service:slack-intake",
        "email": attr.approved_by_email or "slack-intake@internal",
        "is_service": True,
    }

    # ── 0. Idempotency: this Slack message already processed? ────────────────
    existing = await conn.fetchrow(
        "SELECT id, stage, title FROM bedrock.jobs_opportunity "
        "WHERE airtable_id = $1 AND deleted_at IS NULL",
        intake_key,
    )
    if existing:
        return {
            "success": True,
            "status": "created",
            "idempotent_replay": True,
            "data": {
                "opportunity": {
                    "id": str(existing["id"]),
                    "stage": existing["stage"],
                    "created": False,
                },
                "attribution": {
                    "approved_by": attr.approved_by_name,
                    "source_message_ts": attr.source_message_ts,
                },
            },
        }

    choices: list = []

    # ── 1. Resolve ACCOUNT (read-only) ───────────────────────────────────────
    acct_res = await resolve_account(name=body.account.name, user=svc_user, conn=conn, client=client)
    acct_matches = acct_res["data"]["matches"]
    acct_exact = acct_res["data"]["exact"]
    nkey = _acct_nkey(body.account.name)

    account_created = False
    if body.account.sf_account_id:
        # Caller pinned a specific SF account (e.g. a needs_choice re-call) → link it.
        acct_display = body.account.name.strip()
        acct_key = acct_display.lower()
        acct_sf = body.account.sf_account_id
        acct_matched = True
    elif acct_exact:
        chosen = next(
            (m for m in acct_matches if _acct_nkey(m.get("label") or "") == nkey),
            acct_matches[0] if acct_matches else None,
        )
        acct_key = (chosen or {}).get("key") or body.account.name.strip().lower()
        acct_display = (chosen or {}).get("label") or body.account.name.strip()
        acct_sf = (chosen or {}).get("sf_account_id")
        acct_matched = True
    elif len(acct_matches) == 1:
        chosen = acct_matches[0]
        acct_key = chosen.get("key") or body.account.name.strip().lower()
        acct_display = chosen.get("label") or body.account.name.strip()
        acct_sf = chosen.get("sf_account_id")
        acct_matched = True
    elif len(acct_matches) >= 2:
        acct_matched = False
        choices.append({
            "object": "account",
            "reason": f'multiple close matches for "{body.account.name}"',
            "candidates": acct_matches,
        })
        acct_key = acct_display = acct_sf = None
    else:
        # Miss → create net-new.
        acct_key = body.account.name.strip().lower()
        acct_display = body.account.name.strip()
        acct_sf = None
        acct_matched = False
        account_created = True

    # ── 2. Resolve CONTACT (read-only) ────────────────────────────────────────
    contact_created = False
    contact_ref = None
    contact_id_out = None
    contact_match_key = None
    default_company = body.contact.current_company or body.account.name

    if body.contact.contact_id or body.contact.contact_ref:
        # Pinned by a needs_choice re-call.
        contact_ref = body.contact.contact_ref or f"pub:{body.contact.contact_id}"
        contact_id_out = body.contact.contact_id
        contact_match_key = "pinned"
    else:
        email = (body.contact.email or "").strip()
        if email:
            rows = await search_all_contacts(q=email, limit=50, user=svc_user, conn=conn)
            hits = [r for r in rows["data"] if (r.get("email") or "").lower() == email.lower()]
            contact_match_key = "email"
        else:
            rows = await search_all_contacts(q=body.contact.full_name, limit=50, user=svc_user, conn=conn)
            hits = [
                r for r in rows["data"]
                if (r.get("full_name") or "").strip().lower() == body.contact.full_name.strip().lower()
            ]
            contact_match_key = "name"

        if len(hits) == 1:
            contact_ref = hits[0]["contact_ref"]
            contact_id_out = hits[0]["contact_id"]
        elif len(hits) >= 2:
            choices.append({
                "object": "contact",
                "reason": (
                    f'{len(hits)} contacts match "{body.contact.full_name}" '
                    f'with no email to disambiguate'
                    if not email
                    else f'{len(hits)} contacts match email "{email}"'
                ),
                "candidates": [
                    {
                        "contact_id": h["contact_id"],
                        "full_name": h["full_name"],
                        "email": h.get("email"),
                        "current_title": h.get("current_title"),
                        "current_company": h.get("current_company"),
                        "in_sf": h.get("in_sf"),
                        "contact_ref": h["contact_ref"],
                    }
                    for h in hits
                ],
            })
        else:
            contact_created = True

    # ── Any ambiguity → return needs_choice, WRITE NOTHING ───────────────────
    if choices:
        return {
            "success": True,
            "status": "needs_choice",
            "data": {"created": False},
            "choices": choices,
        }

    # ── 3. Resolve OPPORTUNITY clear-match (read-only) ───────────────────────
    # Multiple opportunities per account are ALLOWED. Only block re-creating the
    # SAME opp: idempotency (handled above) + a clearly-matching open opp (same
    # title on the same account) → needs_choice so a human picks add-to vs new.
    if opp.title:
        opp_hits = await conn.fetch(
            """
            SELECT id, title, stage, deal_type
            FROM bedrock.jobs_opportunity
            WHERE deleted_at IS NULL
              AND stage NOT IN ('closed_won', 'closed_lost')
              AND lower(trim(title)) = lower(trim($1))
              AND (
                    lower(trim(account_name)) = lower(trim($2))
                    OR ($3::text IS NOT NULL AND account_id = $3)
                  )
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 5
            """,
            opp.title, acct_display, acct_sf,
        )
        if opp_hits:
            return {
                "success": True,
                "status": "needs_choice",
                "data": {"created": False},
                "choices": [{
                    "object": "opportunity",
                    "reason": (
                        f'a clearly-matching open opportunity "{opp.title}" '
                        f'already exists on {acct_display}'
                    ),
                    "candidates": [
                        {
                            "id": str(r["id"]),
                            "title": r["title"],
                            "stage": r["stage"],
                            "deal_type": r["deal_type"],
                        }
                        for r in opp_hits
                    ],
                }],
            }

    # ── 4. CREATE — ordered, one transaction (account → contact → opp → role) ─
    account_id = acct_sf or "UNKNOWN"
    role_out = None

    async with conn.transaction():
        # Account: ensure the local jobs_account row exists (idempotent upsert),
        # linking the SF id when known. Never creates an account in Salesforce.
        await create_jobs_account(
            body=JobsAccountCreate(name=acct_display, sf_account_id=acct_sf),
            user=svc_user, conn=conn,
        )
        if account_created:
            await conn.execute(
                "UPDATE bedrock.jobs_account "
                "SET notes = concat_ws(' | ', $2, notes), updated_at = now() "
                "WHERE account_key = $1",
                acct_key, src,
            )

        # Contact: create if missing (tagged to the resolved account via company),
        # stamping the attribution `source`. Otherwise reuse the matched ref.
        if contact_created:
            cres = await create_contact(
                body=ContactCreate(
                    full_name=body.contact.full_name,
                    email=body.contact.email,
                    current_title=body.contact.current_title,
                    current_company=default_company,
                    linkedin_url=body.contact.linkedin_url,
                ),
                user=svc_user, conn=conn,
            )
            crow = cres["data"]
            contact_id_out = crow["contact_id"]
            at_id = crow.get("airtable_id")
            contact_ref = f"airtable:{at_id}" if at_id else f"pub:{contact_id_out}"
            await conn.execute(
                "UPDATE public.contacts SET source = $2, updated_at = now() WHERE contact_id = $1",
                contact_id_out, src,
            )

        # Opportunity on the resolved account. `source` carries attribution and
        # `note` seeds the initial stage-history entry (with changed_by = approver).
        opp_note = " | ".join(p for p in (src, opp.note) if p)
        ores = await create_opportunity(
            body=OpportunityCreate(
                account_id=account_id,
                account_name=acct_display,
                stage=opp.stage,
                deal_type=opp.deal_type,
                title=opp.title,
                salary_expected=opp.salary_expected,
                num_roles=opp.num_roles,
                likelihood=opp.likelihood,
                source=src,
                owner_email=opp.owner_email,
                relationship_owner=opp.relationship_owner,
                sf_contact_ids=[contact_ref] if contact_ref else [],
                note=opp_note,
            ),
            user=svc_user, conn=conn,
        )
        opp_id = ores["data"]["id"]
        # Stamp the idempotency key (create_opportunity doesn't set airtable_id).
        await conn.execute(
            "UPDATE bedrock.jobs_opportunity SET airtable_id = $2 WHERE id = $1",
            opp_id, intake_key,
        )

        # Role — only when role info is present. Always hidden from Pathfinder.
        if body.role:
            role_notes = " | ".join(p for p in (src, body.role.notes) if p)
            try:
                rres = await create_opp_role(
                    opp_id=opp_id if isinstance(opp_id, UUID) else UUID(str(opp_id)),
                    body=RoleCreate(
                        title=body.role.title,
                        employment_type=body.role.employment_type,
                        approx_salary=body.role.approx_salary,
                        notes=role_notes,
                        commitment=body.role.commitment,
                        pathfinder_visible=False,
                    ),
                    user=svc_user, conn=conn,
                )
                role_out = {"id": str(rres["data"]["id"]), "title": body.role.title, "created": True}
            except HTTPException as e:
                # The 5-min same-title-open guard → treat as a link, not an error.
                if e.status_code == 409:
                    existing_role = await conn.fetchrow(
                        "SELECT id, title FROM bedrock.jobs_role "
                        "WHERE opportunity_id = $1 AND lower(trim(title)) = lower(trim($2)) "
                        "ORDER BY created_at LIMIT 1",
                        opp_id if isinstance(opp_id, UUID) else UUID(str(opp_id)),
                        body.role.title,
                    )
                    role_out = {
                        "id": str(existing_role["id"]) if existing_role else None,
                        "title": body.role.title,
                        "created": False,
                    }
                else:
                    raise

    return {
        "success": True,
        "status": "created",
        "idempotent_replay": False,
        "data": {
            "account": {
                "account_key": acct_key,
                "display": acct_display,
                "matched": acct_matched,
                "created": account_created,
                "sf_account_id": acct_sf,
                "link_only": bool(acct_sf) and acct_matched,
            },
            "contact": {
                "contact_id": contact_id_out,
                "contact_ref": contact_ref,
                "matched": not contact_created,
                "created": contact_created,
                "match_key": contact_match_key,
            },
            "opportunity": {
                "id": str(opp_id),
                "stage": opp.stage,
                "created": True,
            },
            "role": role_out,
            "attribution": {
                "approved_by": attr.approved_by_name,
                "source_message_ts": attr.source_message_ts,
                "source": src,
            },
        },
    }


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/intake/slack-opportunity")
async def slack_opportunity_intake(
    body: SlackOpportunityIntake,
    user=Depends(require_auth_or_internal),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """Resolve → dedupe → create an employer lead in one transaction.

    Auth: user JWT cookie OR ``X-Internal-Key == BEDROCK_INTERNAL_API_KEY``
    (the Slack intake bot uses the internal-key path). Returns
    ``{status: "created", ...}`` or ``{status: "needs_choice", choices: [...]}``.
    """
    return await run_slack_opportunity_intake(body, conn, client)
