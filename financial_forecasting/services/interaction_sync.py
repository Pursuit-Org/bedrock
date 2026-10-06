"""Orchestrator: run Gmail + Calendar sync for all enabled sync_staff members."""

import contextlib
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# The sync's steps are batch jobs: a full relink, the message index, the
# classifier. The web app's pool kills any statement at 30 seconds (db.py), which
# is right for a page and wrong for these, and is what silently stopped the
# email message index on 2026-09-24 (PRO-98). The sync gets its own pool.
SYNC_COMMAND_TIMEOUT_SEC = 600


@contextlib.asynccontextmanager
async def sync_pool(fallback=None):
    """A small pool of its own for one sync run, with a batch-sized statement
    timeout, closed when the run ends. Falls back to `fallback` (the app's
    pool) when DATABASE_URL isn't set, as in tests."""
    import asyncpg
    url = (os.getenv("DATABASE_URL") or "").strip()
    if not url:
        yield fallback
        return
    pool = await asyncpg.create_pool(url, min_size=1, max_size=4,
                                     command_timeout=SYNC_COMMAND_TIMEOUT_SEC)
    try:
        yield pool
    finally:
        await pool.close()


async def run_interaction_sync(
    conn_or_pool,
    days_back: int = 90,
    staff_emails: list[str] | None = None,
    since_days: int | None = None,
) -> dict[str, Any]:
    """Sync Gmail and Calendar for all enabled staff. Returns per-staff summary.

    Accepts either a single asyncpg connection or a connection pool.
    A pool is strongly preferred for long syncs — each staff member acquires
    a fresh connection so a slow Gmail run cannot time out the shared connection.

    staff_emails — restrict the run to these addresses (else all enabled staff).
    since_days   — force a historical backfill from N days ago, bypassing each
                   staff member's incremental watermark (needed the first time
                   we capture Sent mail, which the watermark never covered).
    """
    from datetime import datetime, timedelta, timezone
    from services.gmail_sync import sync_gmail_for_staff
    from services.calendar_sync import sync_calendar_for_staff
    from services.google_dwd import is_dwd_configured
    import asyncpg

    if not is_dwd_configured():
        logger.warning("interaction sync skipped — GOOGLE_SERVICE_ACCOUNT_JSON not set")
        return {"skipped": True, "reason": "DWD not configured"}

    override_since = (
        datetime.now(timezone.utc) - timedelta(days=since_days) if since_days else None
    )

    is_pool = isinstance(conn_or_pool, asyncpg.pool.Pool)

    async def _get_conn():
        if is_pool:
            return await conn_or_pool.acquire()
        return conn_or_pool

    async def _release_conn(c):
        if is_pool:
            await conn_or_pool.release(c)

    # Fetch staff list on a short-lived connection
    list_conn = await _get_conn()
    try:
        staff_rows = await list_conn.fetch(
            "SELECT email FROM bedrock.sync_staff WHERE enabled = true "
            "AND ($1::text[] IS NULL OR email = ANY($1)) ORDER BY email",
            staff_emails,
        )
    finally:
        await _release_conn(list_conn)

    if not staff_rows:
        return {"skipped": True, "reason": "no enabled staff in sync_staff table"}

    results = []
    for row in staff_rows:
        email = row["email"]

        # Each staff member gets a fresh connection to avoid timeout on long syncs
        staff_conn = await _get_conn()
        try:
            try:
                gmail_result = await sync_gmail_for_staff(staff_conn, email, days_back=days_back, override_since=override_since)
            except Exception as e:
                # repr(), not str(): connection-reset / cancelled-task errors
                # have an empty str() and were logging as "failed for X: " (blank).
                logger.error("gmail sync failed for %s: %r", email, e)
                gmail_result = {"staff_email": email, "error": repr(e) or type(e).__name__}

            try:
                cal_result = await sync_calendar_for_staff(staff_conn, email, days_back=days_back, override_since=override_since)
            except Exception as e:
                logger.error("calendar sync failed for %s: %r", email, e)
                cal_result = {"staff_email": email, "error": repr(e) or type(e).__name__}
        finally:
            await _release_conn(staff_conn)

        results.append({"email": email, "gmail": gmail_result, "calendar": cal_result})

    total_gmail = sum(r["gmail"].get("upserted", 0) for r in results)
    total_cal = sum(r["calendar"].get("upserted", 0) for r in results)

    # Domain enrichment pass — auto-map new domains found in this run
    domains_mapped = 0
    try:
        from services.domain_enrichment import auto_enrich_domains
        enrich_conn = await _get_conn()
        try:
            enrich_result = await auto_enrich_domains(enrich_conn)
            domains_mapped = enrich_result.get("auto_mapped", 0)
        finally:
            await _release_conn(enrich_conn)
    except Exception as e:
        logger.error("domain enrichment failed: %r", e)

    # Jobs-prospect link pass — resolve newly-synced activity to jobs prospects
    # so the Performance dashboard's Engaged/Outreach/Calls reflect this run.
    # Full pass (days_back=None), not just the synced window: the matcher only
    # UPDATEs rows where participant_public_contact_id IS NULL, so an unbounded
    # run stays cheap (set-based hash join, skips already-linked rows) while
    # also back-linking the *older* history of contacts that were only recently
    # flagged as jobs prospects — which a window-bounded run permanently missed.
    prospects_linked = 0
    try:
        from services.jobs_activity_link import relink_jobs_prospect_activity
        link_conn = await _get_conn()
        try:
            link_result = await relink_jobs_prospect_activity(link_conn, days_back=None)
            prospects_linked = link_result.get("linked", 0)
        finally:
            await _release_conn(link_conn)
    except Exception as e:
        logger.error("jobs-prospect activity link failed: %r", e)

    # Message-level index — explode this run's synced threads into per-message
    # rows so outreach metrics date each send correctly (replies/follow-ups
    # otherwise inherit the thread's first-message date and vanish from weekly
    # counts). Window matches the sync's own incremental horizon, widened back
    # to when the index last grew, so a failed night is made up on the next.
    messages_indexed = 0
    try:
        from services.email_message_index import refresh_email_message_index
        idx_conn = await _get_conn()
        try:
            idx_result = await refresh_email_message_index(
                idx_conn, days_back=(since_days or 7), catch_up=True)
            messages_indexed = idx_result.get("inserted", 0)
        finally:
            await _release_conn(idx_conn)
        logger.info("email message index: %d new message rows", messages_indexed)
    except Exception as e:
        logger.error("email message index failed: %r", e)

    # Auto-add pass — flag EXISTING contacts the jobs team has engaged as jobs
    # prospects so the dashboard picks them up without manual tagging.
    prospects_flagged = 0
    try:
        from services.jobs_activity_link import auto_flag_jobs_prospects
        flag_conn = await _get_conn()
        try:
            flag_result = await auto_flag_jobs_prospects(flag_conn)
            prospects_flagged = flag_result.get("flagged", 0)
        finally:
            await _release_conn(flag_conn)
        logger.info("auto-flagged %d existing contacts as jobs prospects", prospects_flagged)
    except Exception as e:
        logger.error("jobs-prospect auto-flag failed: %r", e)

    # Funnel auto-advance — flagged contacts with real jobs outreach since the
    # flag move to initial_outreach on their own (the funnel moves itself).
    try:
        from services.jobs_activity_link import auto_advance_outreached
        adv_conn = await _get_conn()
        try:
            adv_result = await auto_advance_outreached(adv_conn)
        finally:
            await _release_conn(adv_conn)
        logger.info("auto-advanced %d flagged contacts to initial_outreach", adv_result.get("advanced", 0))
    except Exception as e:
        logger.error("membership auto-advance failed: %r", e)

    # Candidate pipeline — for external counterparties in this run's activity:
    # link to an existing/SF-mirrored contact (via the alias index), else create
    # a review candidate (owner-attributed, company from domain). This is what
    # makes new people surface automatically as "link or create" without manual
    # work. Bounded to the recent window (`since_days` or a 7-day default) so the
    # nightly stays cheap; the address/alias guards make it idempotent.
    candidates_created = 0
    candidate_links = 0
    try:
        from services.candidate_pipeline import resolve_and_queue_candidates
        cand_conn = await _get_conn()
        try:
            cand_result = await resolve_and_queue_candidates(
                cand_conn, days_back=(since_days or 7), staff_emails=staff_emails)
            candidates_created = cand_result.get("candidates_created", 0)
            candidate_links = cand_result.get("activity_linked", 0)
            # Absorb any newly-created candidates who are actually our builders
            # (save personal email to the builder record + drop from review).
            try:
                from services.builder_match import sweep_builder_candidates
                b = await sweep_builder_candidates(cand_conn)
                logger.info("builder sweep: %s", b)
            except Exception as be:
                logger.error("builder sweep failed: %r", be)
        finally:
            await _release_conn(cand_conn)
        logger.info("candidate pipeline: created %d candidates, linked %d activity rows",
                    candidates_created, candidate_links)
    except Exception as e:
        logger.error("candidate pipeline failed: %r", e)

    # Jobs-relevance classification — label newly-synced staff email/meeting rows
    # (jobs | not_jobs | unclear) so outreach metrics count only jobs-related
    # activity, for any staff member. Idempotent: only classifies rows with a NULL
    # verdict, so it picks up exactly this run's new activity. Runs last, after
    # counterpart linking, so calendar rows can borrow attendee history.
    activity_classified = 0
    try:
        from services.activity_classifier import classify_new_activity
        cls_conn = await _get_conn()
        try:
            cls_result = await classify_new_activity(cls_conn)
            activity_classified = cls_result.get("classified", 0)
            logger.info("jobs-relevance: classified %d new activity rows %s",
                        activity_classified, cls_result.get("counts", {}))
        finally:
            await _release_conn(cls_conn)
    except Exception as e:
        logger.error("jobs-relevance classification failed: %r", e)

    # Say loudly when the message index has fallen behind the sync. It failed
    # silently from 9/24 to 10/6 while every outreach number quietly drifted.
    email_index = None
    try:
        from services.email_message_index import index_health
        health_conn = await _get_conn()
        try:
            email_index = await index_health(health_conn)
        finally:
            await _release_conn(health_conn)
        if email_index["stale"]:
            logger.error("EMAIL MESSAGE INDEX STALE: last grew %s, mail synced through %s "
                         "(%s h behind) — outreach numbers undercount until it catches up",
                         email_index["last_indexed_at"], email_index["last_synced_at"],
                         email_index["lag_hours"])
    except Exception as e:
        logger.error("email message index health check failed: %r", e)

    logger.info(
        "interaction sync complete: %d staff, %d gmail, %d calendar, %d domains auto-mapped, %d jobs prospects linked, %d jobs prospects flagged, %d candidates created, %d activity classified",
        len(results), total_gmail, total_cal, domains_mapped, prospects_linked, prospects_flagged, candidates_created, activity_classified,
    )
    return {
        "staff_count": len(results),
        "gmail_upserted": total_gmail,
        "calendar_upserted": total_cal,
        "domains_auto_mapped": domains_mapped,
        "jobs_prospects_linked": prospects_linked,
        "jobs_prospects_flagged": prospects_flagged,
        "candidates_created": candidates_created,
        "candidate_activity_linked": candidate_links,
        "activity_classified": activity_classified,
        "email_index": email_index,
        "by_staff": results,
    }
