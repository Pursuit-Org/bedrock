-- LinkedIn re-enrichment landing table for My Network contacts.
-- Drafted 2026-08-06.
--
-- WHY: the network's title/employer come from a LinkedIn CSV import that is
-- never refreshed. Measured against live profiles on a random 30-contact sample
-- (28 resolved): 61% of titles and 50% of employers had changed — 64% stale in
-- at least one. Staff are working the network off values that are wrong about
-- two rows in three.
--
-- WHY A SIDE TABLE and not an UPDATE to public.contacts (Jac, 2026-08-06):
--   1. contacts.current_* carries the LinkedIn-import provenance. Overwriting it
--      loses the ability to say where a value came from, and cannot be undone.
--   2. current_title feeds _seniority_case, which feeds the P1/P2 banding. A
--      silent overwrite reshuffles every staff member's priority list mid-run
--      with no audit trail of what moved or why.
--   3. current_company is the join key to public.companies (via company_id) that
--      supplies headcount / industry / tri-state. Changing the employer WITHOUT
--      re-resolving company_id leaves the row pointing at the OLD company's
--      firmographics — worse than stale, actively wrong. Promotion into
--      contacts is therefore a separate, reviewed step that must also re-resolve
--      company_id; live_company_domain is stored here to make that resolution
--      by domain rather than by name.
--
-- Reads land in the My Network row as a "fresher value available" marker; the
-- authoritative contacts.current_* is untouched until review_state = 'accepted'
-- and the promotion pass runs.
--
-- Idempotent. Safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.contact_enrichment (
    contact_id      integer PRIMARY KEY,   -- public.contacts.contact_id
    -- The /in/<slug> we scraped. Kept so a later URL repair (see
    -- scripts/repair_rotated_linkedin_urls.py) can tell whether a row was
    -- enriched against a URL that has since been corrected.
    linkedin_slug   text NOT NULL,

    -- ── what the profile says now ────────────────────────────────────────────
    live_title              text,
    live_company            text,
    live_company_domain     text,   -- the good join key back to public.companies
    live_company_linkedin_url text,
    headline                text,
    live_location           text,
    connections_count       integer,
    followers_count         integer,
    open_to_work            boolean,

    -- ── what we held AT SCRAPE TIME ──────────────────────────────────────────
    -- Snapshotted so a reviewer sees the exact diff that was measured, even if
    -- contacts.current_* moves afterwards for an unrelated reason.
    prior_title     text,
    prior_company   text,

    -- Describes the SCRAPE EVENT, not the present. Generated rather than written
    -- by the loader so the flag can never disagree with the two columns it
    -- summarises. Normalisation is deliberately minimal (lower + trim): a
    -- reviewer should see "VP of People" vs "VP, People" as a change and decide,
    -- rather than have the loader quietly swallow it.
    title_changed   boolean GENERATED ALWAYS AS (
        live_title IS NOT NULL AND lower(btrim(live_title)) IS DISTINCT FROM lower(btrim(prior_title))
    ) STORED,
    company_changed boolean GENERATED ALWAYS AS (
        live_company IS NOT NULL AND lower(btrim(live_company)) IS DISTINCT FROM lower(btrim(prior_company))
    ) STORED,

    -- ── provenance ───────────────────────────────────────────────────────────
    source          text NOT NULL DEFAULT 'linkedpanda',
    -- 'ok' | 'not_found' | 'error'. Non-ok rows are stored ON PURPOSE: they cost
    -- money and they stop the next run from paying for the same dead profile.
    status          text NOT NULL DEFAULT 'ok',
    error_detail    text,
    cost_usd        numeric(10,5),
    raw             jsonb,
    enriched_at     timestamptz NOT NULL DEFAULT now(),

    -- ── review workflow ──────────────────────────────────────────────────────
    -- Nothing reaches public.contacts until a human moves this to 'accepted'.
    review_state    text NOT NULL DEFAULT 'pending'
                    CHECK (review_state IN ('pending', 'accepted', 'rejected', 'promoted')),
    reviewed_by     text,
    reviewed_at     timestamptz,
    promoted_at     timestamptz,

    CONSTRAINT contact_enrichment_status_ck CHECK (status IN ('ok', 'not_found', 'error'))
);

-- The review queue: "what changed and hasn't been looked at". Partial, because
-- unchanged and already-reviewed rows are the majority and never queried here.
CREATE INDEX IF NOT EXISTS contact_enrichment_review_idx
    ON bedrock.contact_enrichment (review_state, enriched_at DESC)
    WHERE review_state = 'pending' AND (title_changed OR company_changed);

-- Drives the loader's "skip anything enriched in the last N days" gate.
CREATE INDEX IF NOT EXISTS contact_enrichment_enriched_at_idx
    ON bedrock.contact_enrichment (enriched_at DESC);

COMMENT ON TABLE bedrock.contact_enrichment IS
    'Live LinkedIn title/employer for My Network contacts, one row per contact. '
    'A LANDING table, not the source of truth: public.contacts.current_* stays '
    'authoritative until a row is reviewed and promoted. Written by '
    'scripts/enrich_linkedin_profiles.py.';

COMMENT ON COLUMN bedrock.contact_enrichment.live_company_domain IS
    'Company domain from the provider. The intended join key when promoting an '
    'employer change into public.contacts — promoting by NAME alone would leave '
    'company_id pointing at the previous employer''s firmographics.';

COMMENT ON COLUMN bedrock.contact_enrichment.status IS
    'ok | not_found | error. Failures are recorded because they are billed, and '
    'because recording them stops the next run re-paying for a dead profile.';

-- bedrock_user owns bedrock and therefore this table, so the app needs no grant.
-- readonly_user does — it is what the dev tooling and the data dictionary read
-- through, and without this the table is invisible to them (information_schema
-- hides what you have no privilege on, so it looks absent rather than forbidden).
GRANT SELECT ON bedrock.contact_enrichment TO readonly_user;

COMMIT;
