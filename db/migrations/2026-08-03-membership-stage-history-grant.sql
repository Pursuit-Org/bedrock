-- Grant read on bedrock.jobs_membership_stage_history to the dev/app roles.
--
-- Why: every other table the jobs funnel touches is already readable by
-- jobs_dev, but this one is not — so the Outreach contacts funnel in
-- period mode ("how many entered each stage in this window") returned a 500
-- while the Exec view's snapshot mode, which never reads this table, worked
-- fine. Confirmed with has_table_privilege on 2026-08-03:
--
--   jobs_contact_membership          SELECT -> true
--   jobs_stage_history               SELECT -> true   (opportunities funnel: OK)
--   jobs_membership_stage_history    SELECT -> FALSE  (contacts funnel: 500)
--
-- The API now degrades to the membership stamps when this read is refused, so
-- the funnel works without this grant — but it loses On Hold entries and any
-- transition older than the stamps, so the counts are incomplete until applied.
--
-- Read-only. No DDL, no data change.
-- Idempotent: GRANT is a no-op when the privilege is already held.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobs_dev') THEN
    GRANT SELECT ON bedrock.jobs_membership_stage_history TO jobs_dev;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
    GRANT SELECT, INSERT ON bedrock.jobs_membership_stage_history TO bedrock_user;
  END IF;
END $$;

-- Verify:
--   SELECT has_table_privilege('jobs_dev',
--            'bedrock.jobs_membership_stage_history', 'SELECT');  -- expect true
