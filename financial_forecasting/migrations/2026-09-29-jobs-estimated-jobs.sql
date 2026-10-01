-- Estimated jobs on an opportunity (Kwame, 2026-09-29).
--
-- How many jobs a deal is expected to yield, entered before any role exists.
-- The jobs projection on Jobs > Performance > Pipeline plots it by the deal's
-- target close date, next to confirmed roles (bedrock.jobs_role rows) and the
-- quarterly jobs target.
--
-- Why a new column rather than num_roles: moving a deal to Opportunity
-- Confirmed makes the Committed Roles modal overwrite num_roles with the
-- number of roles typed, so num_roles already means "roles entered", and it
-- disagrees with the role count on 26 deals. An estimate needs its own field.
--
-- Nullable with no default: "not estimated" is different from "zero jobs".
-- No backfill: nobody estimated these deals, and inventing a number would put
-- a guess on the chart that looks like a forecast.
--
-- target_close_date stays nullable here. The API requires it on every NEW
-- opportunity and refuses to clear it; 79 of 80 open deals predate that rule
-- and have no date, so NOT NULL would fail until someone fills them in.
--
-- The app probes for this column per request (_has_column), so the field and
-- the chart light up as soon as this runs. No restart needed.

ALTER TABLE bedrock.jobs_opportunity
  ADD COLUMN IF NOT EXISTS estimated_jobs integer
      CHECK (estimated_jobs IS NULL OR estimated_jobs BETWEEN 0 AND 999);

-- Verify:
--   SELECT count(*) FILTER (WHERE estimated_jobs IS NOT NULL) AS estimated,
--          count(*) FILTER (WHERE target_close_date IS NOT NULL) AS dated
--   FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL;
