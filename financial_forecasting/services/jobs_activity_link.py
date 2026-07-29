"""Resolve activity → jobs-prospect links by email match.

Synced (gmail-sync / calendar-sync) and manual activity rows leave
``participant_public_contact_id`` NULL. The jobs Performance dashboard counts
"engaged prospects" as the distinct jobs prospects (public.contacts WHERE
is_jobs_contact) we've actually had activity with — so we resolve that link by
matching a jobs-prospect email against the activity's from/to/cc fields.

Run once as a backfill (days_back=None) and again after every nightly
interaction sync (days_back=small) so the count stays fresh as scrapes land.
Only NULL links are filled — we never clobber an existing participant.
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def relink_jobs_prospect_activity(conn, days_back: Optional[int] = None) -> dict[str, Any]:
    """Populate activity.participant_public_contact_id for jobs prospects.

    Set-based (hash join on normalized email), so it's fast even over the full
    activity table. ``days_back`` bounds the work to recently-dated activity for
    incremental nightly runs; pass None to backfill everything.
    """
    bound = ""
    params: list = []
    if days_back is not None:
        bound = "AND a.activity_date >= now() - ($1 || ' days')::interval"
        params = [str(days_back)]

    # One row per (activity_id, participant-email), joined to jobs prospects by
    # email, then DISTINCT ON keeps a single deterministic prospect per activity
    # (the participant column is singular; multi-recipient emails link to one).
    sql = f"""
    WITH jp AS (
        -- ALL contacts, not just is_jobs_contact: the participant link is
        -- identity resolution, not jobs classification (metrics gate on
        -- jobs_relevance separately). Restricting to flagged contacts left
        -- follow-up emails unlinked whenever the contact was flagged later
        -- than the email was synced (TKT-124: 115 orphaned emails).
        SELECT contact_id, lower(email) AS em
        FROM public.contacts
        WHERE email IS NOT NULL AND email <> ''
    ),
    act_part AS (
        SELECT a.id, lower(a.email_from) AS em
        FROM bedrock.activity a
        WHERE a.participant_public_contact_id IS NULL AND a.deleted_at IS NULL
          AND a.source IN ('manual', 'gmail-sync', 'calendar-sync')
          AND a.email_from IS NOT NULL {bound}
        UNION ALL
        SELECT a.id, lower(e) AS em
        FROM bedrock.activity a, unnest(coalesce(a.email_to, '{{}}')) e
        WHERE a.participant_public_contact_id IS NULL AND a.deleted_at IS NULL
          AND a.source IN ('manual', 'gmail-sync', 'calendar-sync') {bound}
        UNION ALL
        SELECT a.id, lower(e) AS em
        FROM bedrock.activity a, unnest(coalesce(a.email_cc, '{{}}')) e
        WHERE a.participant_public_contact_id IS NULL AND a.deleted_at IS NULL
          AND a.source IN ('manual', 'gmail-sync', 'calendar-sync') {bound}
    ),
    matched AS (
        SELECT DISTINCT ON (ap.id) ap.id, jp.contact_id
        FROM act_part ap
        JOIN jp ON jp.em = ap.em
        ORDER BY ap.id, jp.contact_id
    )
    UPDATE bedrock.activity a
    SET participant_public_contact_id = m.contact_id
    FROM matched m
    WHERE m.id = a.id
    """
    result = await conn.execute(sql, *params)
    # asyncpg returns e.g. "UPDATE 884"
    linked = int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
    logger.info("relinked %d activity rows to jobs prospects (days_back=%s)", linked, days_back)
    return {"linked": linked}


async def auto_flag_jobs_prospects(conn, dry_run: bool = False) -> dict[str, Any]:
    """Flip is_jobs_contact=true on EXISTING contacts who appear on any
    staff-authored, jobs-classified activity.

    Widened 2026-07-29 (Jac's call, with the 15-year email backfill): ANY staff
    member's jobs conversation counts, not just the core jobs team. The
    jobs-relevance gate — coalesce(jobs_relevance_override, jobs_relevance) =
    'jobs' — is what keeps that safe: only activity actually classified as jobs
    work can flag, so incidental email can't flood the pipeline the way the old
    ungated team-only version did (the 819-prospect mess). "Staff" = active
    org_users UNION bedrock.sync_staff (+aliases), including former employees,
    matching the classifier's own author roster.

    A contact qualifies when such an activity has them as a participant: either
    directly linked via participant_public_contact_id, or their lower(email)
    appears in the activity's parsed sender / email_to / email_cc.

    Set-based (unnest CTE over recipients, hash-joined to contacts by normalized
    email), mirroring relink_jobs_prospect_activity. Only EXISTING contacts that
    are currently not flagged (is_jobs_contact false/null) and have a non-empty
    email are updated — this never INSERTs a contact, only ever sets the flag
    true, and never assigns a stage (no auto-assign; new prospects show as
    "No stage"). Returns {"flagged": n}.

    dry_run=True runs the same candidate selection but performs NO update —
    returns {"would_flag": n, "rows": [...]} with per-contact evidence
    (jobs-activity count, latest date) for preview/CSV export.
    """
    with_block = """
    WITH staff_email AS (
        SELECT lower(email) AS email FROM public.org_users WHERE is_active
        UNION
        SELECT lower(email) FROM bedrock.sync_staff
        UNION
        SELECT lower(a) FROM bedrock.sync_staff, LATERAL unnest(aliases) AS a
    ),
    staff_act AS (
        -- Live activity authored by any staff member AND classified as
        -- jobs-relevant. The relevance gate is deliberate: a contact only
        -- becomes a prospect off an activity that is actually about jobs work,
        -- aligning the auto-flag with the is_jobs_contact re-curation
        -- definition (a prospect needs a real jobs signal).
        SELECT a.id,
               a.activity_date,
               a.participant_public_contact_id AS linked_cid,
               lower(a.email_from) AS from_em,
               a.email_to,
               a.email_cc
        FROM bedrock.activity a
        WHERE a.deleted_at IS NULL
          AND coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs'
          AND EXISTS (SELECT 1 FROM staff_email s
                      WHERE a.email_from ILIKE '%'||s.email||'%'
                         OR a.logged_by ILIKE '%'||s.email||'%')
    ),
    -- Every participant email seen on a staff jobs activity, normalized,
    -- keeping the activity id so dry-run can report evidence per contact
    part_email AS (
        SELECT (regexp_match(from_em, '<([^>]+)>'))[1] AS em, id FROM staff_act
            WHERE from_em IS NOT NULL AND from_em ~ '<[^>]+>'
        UNION ALL
        SELECT from_em AS em, id FROM staff_act
            WHERE from_em IS NOT NULL AND from_em !~ '<[^>]+>'
        UNION ALL
        SELECT lower(e) AS em, id
            FROM staff_act, unnest(coalesce(email_to, '{}')) e
        UNION ALL
        SELECT lower(e) AS em, id
            FROM staff_act, unnest(coalesce(email_cc, '{}')) e
    ),
    -- Contacts already directly linked on a staff jobs activity
    linked_cid AS (
        SELECT DISTINCT linked_cid AS contact_id
        FROM staff_act
        WHERE linked_cid IS NOT NULL
    ),
    -- Existing, unflagged contacts that qualify
    cand AS (
        SELECT c.contact_id
        FROM public.contacts c
        WHERE coalesce(c.is_jobs_contact, false) = false
          AND c.email IS NOT NULL AND c.email <> ''
          -- Email-review candidates are staged for human review, not the main
          -- pipeline — never auto-promote them into is_jobs_contact via activity.
          AND coalesce(c.contact_stage, '') <> 'candidate'
          AND (
              lower(c.email) IN (SELECT em FROM part_email WHERE em IS NOT NULL)
              OR c.contact_id IN (SELECT contact_id FROM linked_cid)
          )
    )
    """

    if dry_run:
        rows = await conn.fetch(with_block + """
        SELECT c.contact_id, c.full_name, c.email, c.current_company,
               count(DISTINCT pe.id)           AS jobs_activities,
               max(sa.activity_date)::date     AS last_jobs_activity
        FROM cand
        JOIN public.contacts c USING (contact_id)
        LEFT JOIN part_email pe ON pe.em = lower(c.email)
        LEFT JOIN staff_act sa ON sa.id = pe.id
        GROUP BY c.contact_id, c.full_name, c.email, c.current_company
        ORDER BY jobs_activities DESC, last_jobs_activity DESC
        """)
        logger.info("auto-flag dry run: %d contacts would be flagged", len(rows))
        return {"would_flag": len(rows), "rows": [dict(r) for r in rows]}

    result = await conn.execute(with_block + """
    UPDATE public.contacts c
    SET is_jobs_contact = true,
        updated_at = now()
    FROM cand
    WHERE c.contact_id = cand.contact_id
    """)
    flagged = int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
    logger.info("auto-flagged %d existing contacts as jobs prospects", flagged)
    return {"flagged": flagged}


async def auto_advance_outreached(conn) -> dict[str, Any]:
    """Auto-advance FLAGGED memberships to initial_outreach once real jobs
    outreach exists (decision 2026-07-16: the funnel should move itself).

    Evidence = jobs-relevant activity linked to the contact AFTER they were
    flagged: a staff-sent email, a meeting, or a manually logged call/text/
    LinkedIn touch (manual types always count as jobs outreach). Pre-flag
    activity does NOT auto-advance — it would leapfrog the Flagged stage and
    put first_outreach_at before assigned_at, breaking the scorecard's flow
    counts; a human can still set the stage for those. Never downgrades:
    only stage='assigned' rows move. Idempotent — runs in the nightly sync
    after the activity relink, and inline after a manual activity log.
    """
    result = await conn.execute("""
        WITH touches AS (
            -- Manual touches + meetings evidence at the activity level; EMAIL
            -- evidence at the MESSAGE level (thread rows carry the first
            -- message's date, so a staff reply post-flag inside an older
            -- thread would otherwise never qualify).
            SELECT m.contact_id, a.activity_date AS ts,
                   coalesce(a.email_from, a.logged_by) AS author
            FROM bedrock.jobs_contact_membership m
            JOIN bedrock.activity a ON a.participant_public_contact_id = m.contact_id
            WHERE m.stage = 'assigned'
              AND a.deleted_at IS NULL
              AND a.activity_date >= m.assigned_at
              AND a.type NOT IN ('email')
              AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type <> 'meeting')
              AND (
                    a.type IN ('call', 'text', 'linkedin')
                 OR (a.type = 'meeting' AND EXISTS (
                        SELECT 1 FROM public.org_users o
                        WHERE o.is_active
                          AND (a.email_from ILIKE '%'||o.email||'%'
                               OR a.logged_by ILIKE '%'||o.email||'%'
                               OR a.meeting_attendees::text ILIKE '%'||o.email||'%')))
              )
            UNION ALL
            SELECT m.contact_id, aem.sent_at AS ts, aem.from_email AS author
            FROM bedrock.jobs_contact_membership m
            JOIN bedrock.activity a ON a.participant_public_contact_id = m.contact_id
            JOIN bedrock.activity_email_message aem ON aem.activity_id = a.id
            WHERE m.stage = 'assigned'
              AND a.deleted_at IS NULL
              AND a.type = 'email'
              AND coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs'
              AND aem.sent_at >= m.assigned_at
              AND EXISTS (SELECT 1 FROM public.org_users o
                          WHERE o.is_active AND aem.from_email ILIKE '%'||o.email||'%')
        ),
        outreach AS (
            SELECT contact_id, min(ts) AS first_out,
                   (array_agg(author ORDER BY ts))[1] AS author
            FROM touches
            GROUP BY contact_id
        )
        UPDATE bedrock.jobs_contact_membership m
        SET stage = 'initial_outreach',
            first_outreach_at = COALESCE(m.first_outreach_at, o.first_out),
            first_outreach_by = COALESCE(m.first_outreach_by, o.author),
            updated_at = now()
        FROM outreach o
        WHERE o.contact_id = m.contact_id AND m.stage = 'assigned'
    """)
    advanced = int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
    logger.info("auto-advanced %d flagged contacts to initial_outreach", advanced)
    return {"advanced": advanced}
