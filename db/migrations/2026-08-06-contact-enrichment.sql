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
    -- Headshot. avatar_url is LinkedIn's CDN URL and is SIGNED AND EXPIRING —
    -- every profile in the 2026-08-06 sample carried the same fixed-window
    -- signature, good for 21 days. Storing it alone repeats the mistake already
    -- sitting in public.companies.logo_url, whose Clearbit pointers are described
    -- in routes/account_enrichment.py as "often-dead". The durable copy is
    -- avatar_gcs_uri, written by scripts/rehost_contact_avatars.py; avatar_url is
    -- kept only so that pass knows where to fetch from, and to detect a changed photo.
    avatar_url              text,
    avatar_expires_at       timestamptz,
    avatar_gcs_uri          text,
    avatar_rehosted_at      timestamptz,
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
    -- 'ok' | 'not_found' | 'error' | 'payment_failed'. Non-ok rows are stored ON
    -- PURPOSE: 'not_found' is terminal and stops the next run paying again for a
    -- dead profile, while 'error' and 'payment_failed' stay eligible for retry.
    -- Only 'not_found' and 'ok' cost money — a payment_failed row never settled.
    status          text NOT NULL DEFAULT 'ok',
    error_detail    text,
    -- Cost of the MOST RECENT attempt on this contact, not a running total: a
    -- re-scrape overwrites the row. sum(cost_usd) is therefore "what the current
    -- state cost to obtain", NOT lifetime spend — `zero runs` is the real ledger.
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

    CONSTRAINT contact_enrichment_status_ck
        CHECK (status IN ('ok', 'not_found', 'error', 'payment_failed'))
);

-- The avatar columns were added after this table was first created on
-- 2026-08-06. Re-stated as ALTERs so the file still brings an existing database
-- up to the current shape — CREATE TABLE IF NOT EXISTS is a no-op there, which
-- would otherwise leave the index below referencing a column that doesn't exist.
-- Must stay ABOVE the indexes for that reason. No-ops on a fresh create.
ALTER TABLE bedrock.contact_enrichment
    ADD COLUMN IF NOT EXISTS avatar_url         text,
    ADD COLUMN IF NOT EXISTS avatar_expires_at  timestamptz,
    ADD COLUMN IF NOT EXISTS avatar_gcs_uri     text,
    ADD COLUMN IF NOT EXISTS avatar_rehosted_at timestamptz;

-- 'payment_failed' was added after the original CHECK shipped. Dropping and
-- recreating is the only way to widen a CHECK; both halves are idempotent.
ALTER TABLE bedrock.contact_enrichment
    DROP CONSTRAINT IF EXISTS contact_enrichment_status_ck;
ALTER TABLE bedrock.contact_enrichment
    ADD CONSTRAINT contact_enrichment_status_ck
        CHECK (status IN ('ok', 'not_found', 'error', 'payment_failed'));

-- The review queue: "what changed and hasn't been looked at". Partial, because
-- unchanged and already-reviewed rows are the majority and never queried here.
CREATE INDEX IF NOT EXISTS contact_enrichment_review_idx
    ON bedrock.contact_enrichment (review_state, enriched_at DESC)
    WHERE review_state = 'pending' AND (title_changed OR company_changed);

-- Drives the loader's "skip anything enriched in the last N days" gate.
CREATE INDEX IF NOT EXISTS contact_enrichment_enriched_at_idx
    ON bedrock.contact_enrichment (enriched_at DESC);

-- The re-host work queue: a headshot we have a live URL for but no durable copy.
-- Partial and ordered by expiry, so the pass always drains the ones about to die.
CREATE INDEX IF NOT EXISTS contact_enrichment_avatar_pending_idx
    ON bedrock.contact_enrichment (avatar_expires_at)
    WHERE avatar_url IS NOT NULL AND avatar_gcs_uri IS NULL;

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
