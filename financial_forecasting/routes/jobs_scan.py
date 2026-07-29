"""Jobs Scan API — triage queue, watchlist, and promotion.

  GET   /api/jobs/scan/results                      — triage queue (filterable)
  GET   /api/jobs/scan/summary                      — counts by triage state
  PATCH /api/jobs/scan/results/{id}                 — approve / reject / snooze
  POST  /api/jobs/scan/results/{id}/promote          — push to Pathfinder
  POST  /api/jobs/scan/results/{id}/opportunity      — create opp + role (pipeline)
  GET   /api/jobs/scan/watchlist                     — watched companies + boards
  POST  /api/jobs/scan/watchlist                     — add a company
  PATCH /api/jobs/scan/watchlist/{account_key}       — edit / deactivate
  GET   /api/jobs/scan/watchlist/proposals           — auto-seed from contact tags
  GET   /api/jobs/scan/criteria                      — fit criteria profiles
  PUT   /api/jobs/scan/criteria/{name}               — edit criteria (no deploy)

Separate router from routes/jobs.py (same /api/jobs prefix) to keep that 6k-line
module from growing and to avoid collisions with in-flight work there.

Design: docs/jobs-scan-design.md
"""

import json
import logging
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs/scan", tags=["jobs-scan"])

VALID_TRIAGE = {"new", "approved", "rejected", "promoted", "snoozed"}
VALID_TIERS = {"priority", "secondary", "archive"}
VALID_RELATIONSHIPS = {"warm_partner", "monitored", "prospect"}
VALID_PLATFORMS = {"greenhouse", "ashby", "lever", "gem", "workday"}
# Mirrors bedrock.jobs_opportunity_deal_type_check.
VALID_DEAL_TYPES = {"ft", "pt_contract", "capstone", "volunteer", "workshop", "pilot"}

# Contact tags that mark a company as one we have a real relationship with.
# Mirrors bedrock.contact_tag_catalog; drives the watchlist proposals endpoint.
WARM_TAGS = [
    "other_hiring_partner", "prior_commit_partner", "board", "opboard",
    "ciso_council", "volunteer_current", "alumni_ai_native", "tristate_smb_leaders",
]

# Free-mail and our own domains never identify an employer.
NON_CORPORATE_DOMAINS = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "aol.com", "me.com", "msn.com", "comcast.net", "verizon.net",
    "protonmail.com", "live.com", "pursuit.org", "c4q.nyc",
]

# jobs_opportunity.account_id is NOT NULL and holds a Salesforce Account id.
# 'UNKNOWN' is the established sentinel for "no SF account yet" (161 of 178 rows).
NO_SF_ACCOUNT = "UNKNOWN"


def _actor(user) -> Optional[str]:
    return user.get("email") if isinstance(user, dict) else getattr(user, "email", None)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class TriageUpdate(BaseModel):
    triage_state: str
    note: Optional[str] = None


class PromoteRequest(BaseModel):
    share: bool = True


class OpportunityRequest(BaseModel):
    owner_email: Optional[str] = None
    deal_type: Optional[str] = "ft"
    # Publish the created role to Pathfinder in the same action.
    pathfinder_visible: bool = False
    notes: Optional[str] = None


class BoardIn(BaseModel):
    platform: str
    slug: str
    extra: Optional[dict[str, Any]] = None


class WatchCompanyIn(BaseModel):
    display_name: str
    account_key: Optional[str] = None
    domain: Optional[str] = None
    tier: str = "secondary"
    relationship: str = "monitored"
    why_watched: Optional[str] = None
    source_tags: Optional[list[str]] = None
    owner_email: Optional[str] = None
    criteria_profile: str = "builder_wide"
    notes: Optional[str] = None
    boards: Optional[list[BoardIn]] = None


class WatchCompanyPatch(BaseModel):
    display_name: Optional[str] = None
    domain: Optional[str] = None
    tier: Optional[str] = None
    relationship: Optional[str] = None
    why_watched: Optional[str] = None
    owner_email: Optional[str] = None
    criteria_profile: Optional[str] = None
    active: Optional[bool] = None
    do_not_present: Optional[bool] = None
    notes: Optional[str] = None


class CriteriaIn(BaseModel):
    body: dict[str, Any]
    active: bool = True


# ---------------------------------------------------------------------------
# Triage queue
# ---------------------------------------------------------------------------
@router.get("/results")
async def list_results(
    state: Optional[str] = Query(None, description="triage state filter"),
    account_key: Optional[str] = None,
    platform: Optional[str] = None,
    min_score: Optional[float] = None,
    has_warm_contact: Optional[bool] = None,
    include_closed: bool = False,
    q: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Triage queue: scanned roles with their company and warm-contact context.

    Warm contacts are surfaced read-only — "we know 3 people at Acme" — and
    nothing is written to the funnel until someone acts on it.
    """
    if state and state not in VALID_TRIAGE:
        raise HTTPException(400, f"Invalid state: {state}")

    where = ["NOT COALESCE(w.do_not_present, false)"]
    # $1 is the warm-tag array used by the LEFT JOIN, so it seeds args here and
    # every filter placeholder numbers itself from the real list length.
    args: list[Any] = [WARM_TAGS]

    def add(clause: str, value: Any) -> None:
        args.append(value)
        where.append(clause.format(n=len(args)))

    if not include_closed:
        where.append("sp.closed_at IS NULL")
    if state:
        add("sp.triage_state = ${n}", state)
    if account_key:
        add("sp.account_key = ${n}", account_key)
    if platform:
        add("sp.platform = ${n}", platform)
    if min_score is not None:
        add("COALESCE(sp.score, 0) >= ${n}", min_score)
    if q:
        add("(sp.title ILIKE '%' || ${n} || '%' OR w.display_name ILIKE '%' || ${n} || '%')", q)

    args.extend([limit, offset])
    limit_n, offset_n = len(args) - 1, len(args)

    having = ""
    if has_warm_contact is True:
        having = "HAVING count(c.contact_id) > 0"
    elif has_warm_contact is False:
        having = "HAVING count(c.contact_id) = 0"

    sql = f"""
        SELECT sp.id::text, sp.account_key, w.display_name AS company,
               sp.platform, sp.slug, sp.external_job_id,
               sp.title, sp.location, sp.is_remote, sp.url,
               sp.salary_min, sp.salary_max, sp.comp_source,
               sp.score, sp.classification, sp.matched_family, sp.reasoning,
               sp.criteria_version, sp.liveness,
               sp.first_seen_at, sp.last_seen_at, sp.closed_at, sp.posted_at,
               sp.triage_state, sp.triaged_by, sp.triaged_at,
               sp.promoted_posting_id, sp.opportunity_id::text,
               w.relationship, w.tier,
               count(c.contact_id) AS warm_contact_count,
               COALESCE(array_agg(DISTINCT c.full_name)
                        FILTER (WHERE c.contact_id IS NOT NULL), '{{}}') AS warm_contacts
        FROM bedrock.scraped_job_posting sp
        JOIN bedrock.jobs_watch_company w ON w.account_key = sp.account_key
        LEFT JOIN public.contacts c
               ON lower(trim(c.current_company)) = sp.account_key
              AND c.tags && $1::text[]
        WHERE {' AND '.join(where)}
        GROUP BY sp.id, w.display_name, w.relationship, w.tier
        {having}
        ORDER BY sp.first_seen_at DESC, sp.id
        LIMIT ${limit_n} OFFSET ${offset_n}
    """
    rows = await conn.fetch(sql, *args)
    return {"results": [dict(r) for r in rows], "limit": limit, "offset": offset}


@router.get("/summary")
async def scan_summary(user=Depends(require_auth), conn=Depends(get_db)):
    """Counts for the tab header: open queue depth, promoted, board health."""
    states = await conn.fetch(
        """
        SELECT sp.triage_state, count(*) AS n
        FROM bedrock.scraped_job_posting sp
        JOIN bedrock.jobs_watch_company w ON w.account_key = sp.account_key
        WHERE sp.closed_at IS NULL AND NOT w.do_not_present
        GROUP BY 1
        """
    )
    boards = await conn.fetchrow(
        """
        SELECT count(*) AS total,
               count(*) FILTER (WHERE status = 'verified') AS verified,
               count(*) FILTER (WHERE status = 'stale') AS stale,
               count(*) FILTER (WHERE last_scan_status IS NOT NULL
                                  AND last_scan_status <> 'ok') AS failing,
               max(last_scan_at) AS last_scan_at
        FROM bedrock.jobs_watch_board b
        JOIN bedrock.jobs_watch_company c ON c.account_key = b.account_key
        WHERE c.active
        """
    )
    new_week = await conn.fetchval(
        """
        SELECT count(*) FROM bedrock.scraped_job_posting sp
        JOIN bedrock.jobs_watch_company w ON w.account_key = sp.account_key
        WHERE sp.first_seen_at > now() - interval '7 days'
          AND sp.closed_at IS NULL AND NOT w.do_not_present
        """
    )
    return {
        "by_state": {r["triage_state"]: r["n"] for r in states},
        "boards": dict(boards) if boards else {},
        "new_this_week": new_week or 0,
    }


@router.patch("/results/{scan_id}")
async def triage_result(
    scan_id: UUID,
    body: TriageUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Set triage state. Does not publish anything — promotion is explicit."""
    if body.triage_state not in VALID_TRIAGE:
        raise HTTPException(400, f"Invalid triage_state: {body.triage_state}")
    if body.triage_state == "promoted":
        raise HTTPException(400, "Use POST /results/{id}/promote to publish")

    row = await conn.fetchrow(
        """
        UPDATE bedrock.scraped_job_posting
           SET triage_state = $2, triaged_by = $3, triaged_at = now(),
               reasoning = COALESCE($4, reasoning), updated_at = now()
         WHERE id = $1
        RETURNING id::text, triage_state, triaged_by, triaged_at
        """,
        scan_id, body.triage_state, _actor(user), body.note,
    )
    if not row:
        raise HTTPException(404, "Scan result not found")
    return dict(row)


# ---------------------------------------------------------------------------
# Promotion path 1: Pathfinder
# ---------------------------------------------------------------------------
@router.post("/results/{scan_id}/promote")
async def promote_to_pathfinder(
    scan_id: UUID,
    body: PromoteRequest,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Publish (or unpublish) a scanned role on the builder-facing board.

    Delegates to bedrock.promote_scan_to_pathfinder, which is SECURITY DEFINER
    because bedrock_user cannot write public.job_postings directly. Idempotent:
    re-promoting updates the same posting rather than creating another.
    """
    row = await conn.fetchrow(
        "SELECT action, posting_id FROM bedrock.promote_scan_to_pathfinder($1, $2, $3)",
        scan_id, _actor(user), body.share,
    )
    if not row or row["action"] == "not_found":
        raise HTTPException(404, "Scan result not found")
    if row["action"] == "blocked_do_not_present":
        raise HTTPException(
            409,
            {"error": "do_not_present",
             "message": "This company is marked do-not-present and cannot be published."},
        )
    return {"action": row["action"], "posting_id": row["posting_id"]}


# ---------------------------------------------------------------------------
# Promotion path 2: opportunity in the pipeline
# ---------------------------------------------------------------------------
@router.post("/results/{scan_id}/opportunity")
async def create_opportunity_from_scan(
    scan_id: UUID,
    body: OpportunityRequest,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Create a tracked opportunity + role from a scanned posting.

    Resolve before create: an existing non-closed opportunity for the same
    account and title is reused rather than duplicated.

    If the scan row was already pushed to Pathfinder, the new role is pre-linked
    to that posting so bedrock.sync_role_to_pathfinder takes its UPDATE branch —
    otherwise the same job would appear on the builder board twice.
    """
    if body.deal_type and body.deal_type not in VALID_DEAL_TYPES:
        raise HTTPException(400, f"Invalid deal_type: {body.deal_type}")

    scan = await conn.fetchrow(
        """
        SELECT sp.id, sp.account_key, sp.title, sp.url, sp.description,
               sp.salary_min, sp.salary_max, sp.location,
               sp.opportunity_id, sp.promoted_posting_id,
               w.display_name, w.owner_email AS watch_owner, w.do_not_present
        FROM bedrock.scraped_job_posting sp
        JOIN bedrock.jobs_watch_company w ON w.account_key = sp.account_key
        WHERE sp.id = $1
        """,
        scan_id,
    )
    if not scan:
        raise HTTPException(404, "Scan result not found")
    if scan["opportunity_id"]:
        raise HTTPException(
            409,
            {"error": "already_linked",
             "message": "This posting already has an opportunity.",
             "opportunity_id": str(scan["opportunity_id"])},
        )

    owner = body.owner_email or scan["watch_owner"] or _actor(user)
    company = scan["display_name"] or scan["account_key"]
    title = scan["title"] or "Role"
    # Midpoint is the honest single number when the posting gave a range.
    approx = None
    if scan["salary_min"] and scan["salary_max"]:
        approx = int((scan["salary_min"] + scan["salary_max"]) / 2)
    else:
        approx = scan["salary_min"] or scan["salary_max"]

    async with conn.transaction():
        existing = await conn.fetchrow(
            """
            SELECT id FROM bedrock.jobs_opportunity
             WHERE account_name = $1
               AND lower(trim(COALESCE(title, ''))) = lower(trim($2))
               AND deleted_at IS NULL
               AND stage NOT IN ('closed_won', 'closed_lost')
             LIMIT 1
            """,
            company, title,
        )
        if existing:
            opp_id = existing["id"]
            reused = True
        else:
            opp = await conn.fetchrow(
                """
                INSERT INTO bedrock.jobs_opportunity
                    (account_id, account_name, stage, deal_type, title,
                     description, salary_expected, source, owner_email, num_roles)
                VALUES ($1, $2, 'lead_submitted', $3, $4, $5, $6,
                        'reactive_posting', $7, 1)
                RETURNING id
                """,
                NO_SF_ACCOUNT, company, body.deal_type, title,
                body.notes or scan["description"], approx, owner,
            )
            opp_id = opp["id"]
            reused = False

        # commitment='open_market': nobody has committed this req to us, we found
        # it on their board.
        role = await conn.fetchrow(
            """
            INSERT INTO bedrock.jobs_role
                (opportunity_id, title, approx_salary, employment_type, status,
                 commitment, jd_url, notes, pathfinder_visible, job_posting_id)
            VALUES ($1, $2, $3, 'full_time', 'open', 'open_market', $4, $5, $6, $7)
            RETURNING id
            """,
            opp_id, title, approx, scan["url"],
            body.notes or scan["description"],
            bool(body.pathfinder_visible), scan["promoted_posting_id"],
        )

        await conn.execute(
            """
            UPDATE bedrock.scraped_job_posting
               SET opportunity_id = $2, triage_state = 'approved',
                   triaged_by = $3, triaged_at = now(), updated_at = now()
             WHERE id = $1
            """,
            scan_id, opp_id, _actor(user),
        )

        posting_id = scan["promoted_posting_id"]
        if body.pathfinder_visible:
            if scan["do_not_present"]:
                raise HTTPException(
                    409,
                    {"error": "do_not_present",
                     "message": "This company is marked do-not-present and cannot be published."},
                )
            synced = await conn.fetchrow(
                "SELECT action, posting_id FROM bedrock.sync_role_to_pathfinder($1)",
                role["id"],
            )
            if synced and synced["posting_id"]:
                posting_id = synced["posting_id"]
                await conn.execute(
                    """UPDATE bedrock.scraped_job_posting
                          SET promoted_posting_id = $2, triage_state = 'promoted',
                              updated_at = now()
                        WHERE id = $1""",
                    scan_id, posting_id,
                )

    return {
        "opportunity_id": str(opp_id),
        "role_id": str(role["id"]),
        "opportunity_reused": reused,
        "posting_id": posting_id,
    }


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------
@router.get("/watchlist")
async def list_watchlist(
    active_only: bool = True,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    rows = await conn.fetch(
        f"""
        SELECT c.account_key, c.display_name, c.domain, c.tier, c.relationship,
               c.why_watched, c.source_tags, c.owner_email, c.criteria_profile,
               c.active, c.do_not_present, c.notes, c.created_at,
               COALESCE(json_agg(json_build_object(
                   'id', b.id::text, 'platform', b.platform, 'slug', b.slug,
                   'status', b.status, 'last_scan_at', b.last_scan_at,
                   'last_scan_status', b.last_scan_status,
                   'last_role_count', b.last_role_count,
                   'consecutive_empty_scans', b.consecutive_empty_scans
               ) ORDER BY b.platform) FILTER (WHERE b.id IS NOT NULL), '[]') AS boards,
               (SELECT count(*) FROM bedrock.scraped_job_posting sp
                 WHERE sp.account_key = c.account_key AND sp.closed_at IS NULL)
                 AS open_roles
        FROM bedrock.jobs_watch_company c
        LEFT JOIN bedrock.jobs_watch_board b ON b.account_key = c.account_key
        {'WHERE c.active' if active_only else ''}
        GROUP BY c.account_key
        ORDER BY c.tier, c.display_name
        """
    )
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("boards"), str):
            d["boards"] = json.loads(d["boards"])
        out.append(d)
    return {"companies": out}


@router.post("/watchlist")
async def add_watch_company(
    body: WatchCompanyIn,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Add a company to the watchlist, with optional ATS boards."""
    if body.tier not in VALID_TIERS:
        raise HTTPException(400, f"Invalid tier: {body.tier}")
    if body.relationship not in VALID_RELATIONSHIPS:
        raise HTTPException(400, f"Invalid relationship: {body.relationship}")
    for board in body.boards or []:
        if board.platform not in VALID_PLATFORMS:
            raise HTTPException(400, f"Invalid platform: {board.platform}")

    account_key = (body.account_key or body.display_name or "").strip().lower()
    if not account_key:
        raise HTTPException(400, "display_name or account_key required")

    async with conn.transaction():
        await conn.execute(
            """
            INSERT INTO bedrock.jobs_watch_company
                (account_key, display_name, domain, tier, relationship,
                 why_watched, source_tags, owner_email, criteria_profile, notes)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (account_key) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                domain = COALESCE(EXCLUDED.domain, bedrock.jobs_watch_company.domain),
                tier = EXCLUDED.tier,
                relationship = EXCLUDED.relationship,
                why_watched = COALESCE(EXCLUDED.why_watched,
                                       bedrock.jobs_watch_company.why_watched),
                active = true,
                updated_at = now()
            """,
            account_key, body.display_name, body.domain, body.tier,
            body.relationship, body.why_watched, body.source_tags or [],
            body.owner_email or _actor(user), body.criteria_profile, body.notes,
        )
        for board in body.boards or []:
            await conn.execute(
                """
                INSERT INTO bedrock.jobs_watch_board (account_key, platform, slug, extra)
                VALUES ($1,$2,$3,$4::jsonb)
                ON CONFLICT (platform, slug) DO UPDATE SET
                    account_key = EXCLUDED.account_key, updated_at = now()
                """,
                account_key, board.platform, board.slug,
                json.dumps(board.extra or {}),
            )
    return {"account_key": account_key, "boards": len(body.boards or [])}


@router.patch("/watchlist/{account_key}")
async def patch_watch_company(
    account_key: str,
    body: WatchCompanyPatch,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "No fields to update")
    if "tier" in updates and updates["tier"] not in VALID_TIERS:
        raise HTTPException(400, f"Invalid tier: {updates['tier']}")
    if "relationship" in updates and updates["relationship"] not in VALID_RELATIONSHIPS:
        raise HTTPException(400, f"Invalid relationship: {updates['relationship']}")

    cols = list(updates.keys())
    sets = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(cols))
    row = await conn.fetchrow(
        f"""UPDATE bedrock.jobs_watch_company SET {sets}, updated_at = now()
             WHERE account_key = $1 RETURNING account_key, display_name, active,
                   do_not_present, tier, relationship""",
        account_key, *[updates[c] for c in cols],
    )
    if not row:
        raise HTTPException(404, "Company not on the watchlist")
    return dict(row)


@router.get("/watchlist/proposals")
async def watchlist_proposals(
    limit: int = Query(200, le=500),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Companies to propose for the watchlist, derived from warm contact tags.

    The employer domain comes from each warm contact's work-email domain, which
    resolves ~5x more companies than joining current_company to companies.name
    (that join lands a domain for only ~10% of them).

    Proposals only — a human confirms each one, because this data carries stale
    employers (a contact who moved keeps their old address), typo'd domains, and
    the occasional non-company free-text value.
    """
    rows = await conn.fetch(
        """
        WITH warm AS (
            SELECT lower(trim(c.current_company)) AS account_key,
                   min(trim(c.current_company)) AS display_name,
                   lower(split_part(c.email, '@', 2)) AS domain,
                   count(*) AS contacts,
                   array_agg(DISTINCT t) AS tags
            FROM public.contacts c, unnest(c.tags) AS t
            WHERE t = ANY($1::text[])
              AND c.current_company IS NOT NULL AND trim(c.current_company) <> ''
              AND c.email LIKE '%@%'
            GROUP BY 1, 3
        ), ranked AS (
            SELECT *, row_number() OVER (
                       PARTITION BY account_key ORDER BY contacts DESC) AS rn
            FROM warm
            WHERE domain <> ALL($2::text[]) AND domain <> ''
        )
        SELECT r.account_key, r.display_name, r.domain, r.contacts, r.tags
        FROM ranked r
        LEFT JOIN bedrock.jobs_watch_company w ON w.account_key = r.account_key
        WHERE r.rn = 1 AND w.account_key IS NULL
        ORDER BY r.contacts DESC, r.display_name
        LIMIT $3
        """,
        WARM_TAGS, NON_CORPORATE_DOMAINS, limit,
    )
    return {"proposals": [dict(r) for r in rows]}


# ---------------------------------------------------------------------------
# Criteria
# ---------------------------------------------------------------------------
@router.get("/criteria")
async def list_criteria(user=Depends(require_auth), conn=Depends(get_db)):
    rows = await conn.fetch(
        """SELECT name, version, body, active, updated_by, updated_at
             FROM bedrock.jobs_scan_criteria ORDER BY name"""
    )
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("body"), str):
            d["body"] = json.loads(d["body"])
        out.append(d)
    return {"criteria": out}


@router.put("/criteria/{name}")
async def upsert_criteria(
    name: str,
    body: CriteriaIn,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Edit fit criteria without a deploy.

    Bumps `version` on every write so a score stays attributable to the rules
    that produced it.
    """
    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.jobs_scan_criteria (name, version, body, active, updated_by)
        VALUES ($1, 1, $2::jsonb, $3, $4)
        ON CONFLICT (name) DO UPDATE SET
            body = EXCLUDED.body,
            active = EXCLUDED.active,
            version = bedrock.jobs_scan_criteria.version + 1,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
        RETURNING name, version, active, updated_at
        """,
        name, json.dumps(body.body), body.active, _actor(user),
    )
    return dict(row)
