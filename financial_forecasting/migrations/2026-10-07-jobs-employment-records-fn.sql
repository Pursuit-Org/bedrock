-- ============================================================================
-- PRO-97: one placement rule, which needs to know who is a test account
-- ============================================================================
-- The Jobs placement numbers (placed full-time, paid work, average FT salary)
-- follow one rule, kept in services/jobs_metrics.py and in the data dictionary
-- (Employment #171, Post-program salary #164). Part of the rule is "test
-- accounts don't count" (users.exclude_from_metrics, dictionary #79).
--
-- public.users has row-level security and no policy for the app role, so
-- Bedrock reads nothing from it directly. bedrock.secured_jobs() already
-- reads it as its owner (SECURITY DEFINER) for builder names, but doesn't
-- return the flag, and changing its row type would need a DROP that other
-- callers depend on. So this is a second function: every employment record,
-- the builder's name, and whether the person is excluded from metrics.
--
-- No rule is applied here. Which records count is decided in one place, the
-- Python module, and written a second time in the dictionary's reference SQL.
--
-- Until this runs, Bedrock falls back to secured_jobs() and can't drop test
-- accounts (it logs a warning). Idempotent. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION bedrock.jobs_employment_records()
RETURNS TABLE(
    id integer, user_id integer, builder text, role_title text, company_name text,
    employment_type text, engagement_stage text, payment_amount numeric,
    influenced boolean, opportunity_id uuid, start_date date, end_date date,
    source text, excluded boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, bedrock
AS $$
    SELECT er.id, er.user_id,
           COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), 'Builder #' || er.user_id),
           er.role_title, er.company_name, er.employment_type::text, er.engagement_stage,
           er.payment_amount, er.influenced, er.opportunity_id, er.start_date, er.end_date,
           er.source, COALESCE(u.exclude_from_metrics, false)
    FROM public.employment_records er
    LEFT JOIN public.users u ON u.user_id = er.user_id
$$;

GRANT EXECUTE ON FUNCTION bedrock.jobs_employment_records() TO bedrock_user;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION bedrock.jobs_employment_records() TO jobs_dev;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
