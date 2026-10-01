-- ============================================================================
-- Builders tab — split target function from target industry
-- ============================================================================
-- target_industries held a mix of job functions ("Frontend", "Data") and
-- industries ("Media", "Gaming"). The Builders table now edits them as two
-- multi-select columns: target_functions (new) and target_industries (existing,
-- industries only going forward). Option lists live in the frontend
-- (services/jobs.ts BUILDER_FUNCTION_OPTIONS / BUILDER_INDUSTRY_OPTIONS);
-- no CHECK, matching the rest of this table. Existing values are left as-is —
-- the team re-fills them by hand.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

ALTER TABLE bedrock.builder_job_profile
    ADD COLUMN IF NOT EXISTS target_functions text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN bedrock.builder_job_profile.target_functions IS
    'Job functions the builder is targeting (multi-select, Builders tab). Industries live in target_industries.';
