-- ============================================================================
-- Migration: Commitments — grant obligation tracking
-- Date: 2026-08-12
-- Feature: "Commitments" — new /commitments dashboard + a Commitments
--          section on the existing Award detail page.
-- ============================================================================
--
-- Context:
--     Replaces an untrusted manual Excel sheet used to track Pursuit's
--     grant commitments across a small, curated set of especially
--     high-stakes Philanthropy grants. A commitment is one discrete
--     obligation from a signed grant contract (e.g. "50 Builders enrolled
--     by 2027-06-30"). Commitments always anchor to an EXISTING
--     bedrock.award row — Award already is the "contract" grain (one
--     funder, one signed document, 1:1 with a closed-won Opportunity) —
--     so no new Contract entity is introduced. Philanthropy-only by
--     inheritance, since bedrock.award is Philanthropy-only by
--     construction (services/awards_service.py).
--
--     Status (on-track / ahead / under / complete) is NEVER stored — it
--     is computed at read time from deadline + the latest logged progress
--     entry (services/commitment_status.py). grant_commitment therefore
--     has no status column at all, by design — nobody can hand-set it
--     because the field doesn't exist.
--
--     Progress is an append-only log (commitment_progress_log), not a
--     directly-overwritten field — mirrors the existing award/award_report
--     precedent, where individual report rows are the source of truth and
--     award's displayed aggregates are computed via LATERAL JOIN at read
--     time, never stored redundantly.
--
--     award.contract_file_link is one new column on the existing award
--     table — a plain URL/text link to the signed source document (not a
--     file-upload mechanism).
--
-- Idempotent — safe to re-run.
--
-- Apply as bedrock owner:
--     psql "$DATABASE_URL" -f 2026-08-12-add-grant-commitments.sql
-- ============================================================================

BEGIN;

ALTER TABLE bedrock.award
    ADD COLUMN IF NOT EXISTS contract_file_link TEXT;

CREATE TABLE IF NOT EXISTS bedrock.grant_commitment (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    award_id            UUID NOT NULL REFERENCES bedrock.award(id) ON DELETE CASCADE,
    commitment_type     TEXT NOT NULL
                        CHECK (commitment_type IN ('quantitative', 'qualitative')),
    title               TEXT NOT NULL,
    contract_language   TEXT NOT NULL DEFAULT '',
    delivery_plan       TEXT NOT NULL DEFAULT '',
    tracking_tier       TEXT NOT NULL DEFAULT 'tracked'
                        CHECK (tracking_tier IN ('tracked', 'reference')),
    target_value        NUMERIC,
    target_unit         TEXT,
    start_date          DATE NOT NULL,
    deadline            DATE NOT NULL,
    owner               TEXT NOT NULL DEFAULT '',
    owner_ids           UUID[] NOT NULL DEFAULT '{}',
    notes               TEXT NOT NULL DEFAULT '',
    sort_order          INTEGER NOT NULL DEFAULT 0,
    source              JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          TEXT,
    deleted_at          TIMESTAMPTZ,
    deleted_by          TEXT,
    CONSTRAINT grant_commitment_quant_target_check
        CHECK (commitment_type <> 'quantitative' OR target_value IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_grant_commitment_award
    ON bedrock.grant_commitment(award_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_grant_commitment_deadline
    ON bedrock.grant_commitment(deadline) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_grant_commitment_tracking_tier
    ON bedrock.grant_commitment(tracking_tier) WHERE deleted_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_grant_commitment_updated_at'
    ) THEN
        CREATE TRIGGER trg_grant_commitment_updated_at
            BEFORE UPDATE ON bedrock.grant_commitment
            FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS bedrock.commitment_progress_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    commitment_id       UUID NOT NULL REFERENCES bedrock.grant_commitment(id) ON DELETE CASCADE,
    recorded_value      NUMERIC,
    recorded_status     TEXT
                        CHECK (recorded_status IS NULL OR recorded_status IN
                            ('not-started', 'in-progress', 'met', 'not-met', 'pending-verification')),
    note                TEXT NOT NULL DEFAULT '',
    recorded_by_email   TEXT NOT NULL,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT commitment_progress_log_value_or_status_check
        CHECK (recorded_value IS NOT NULL OR recorded_status IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_commitment_progress_log_commitment
    ON bedrock.commitment_progress_log(commitment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_commitment_progress_log_recorded_at
    ON bedrock.commitment_progress_log(recorded_at);

-- ── Permission backfill ──────────────────────────────────────────────────
-- view_commitments / manage_commitments are new PERMISSION_KEYS entries
-- (routes/permissions.py). List membership alone grants nothing —
-- check_permission() treats absence as denied, and only the Admin profile
-- gets a runtime auto-grant (permissions.py's setdefault loop, Admin only).
-- Without this backfill, Executive / Relationship Manager / Project
-- Manager get silently 403'd. Same precedent/gap as
-- 2026-04-19-add-manage-owner-goals-permission.sql.
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"view_commitments": true, "manage_commitments": true}'::jsonb
WHERE name IN ('Admin', 'Executive', 'Relationship Manager');

UPDATE bedrock.permission_profile
SET permissions = permissions || '{"view_commitments": true}'::jsonb
WHERE name = 'Project Manager';

COMMIT;

-- ============================================================================
-- Verification (read-only — safe anytime):
-- ============================================================================
--
--   SELECT name, permissions->>'view_commitments' AS view_commitments,
--          permissions->>'manage_commitments' AS manage_commitments
--   FROM bedrock.permission_profile
--   ORDER BY name;
--
-- Expected: Admin/Executive/Relationship Manager both true; Project
-- Manager view_commitments=true, manage_commitments=(null, i.e. false).
--
-- ============================================================================
-- Rollback:
-- ============================================================================
--   DROP TABLE IF EXISTS bedrock.commitment_progress_log;
--   DROP TABLE IF EXISTS bedrock.grant_commitment;
--   ALTER TABLE bedrock.award DROP COLUMN IF EXISTS contract_file_link;
--   UPDATE bedrock.permission_profile
--   SET permissions = permissions - 'view_commitments' - 'manage_commitments';
-- ============================================================================
