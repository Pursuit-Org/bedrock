-- jobs_team is missing write access on the two tables the contact-stage
-- PATCH endpoint (/api/jobs/contacts/{contact_id}/jobs-membership) writes to.
--
-- Verified 2026-09-08 as avni_dev:
--   bedrock.jobs_contact_membership       SELECT only — no INSERT/UPDATE/DELETE
--   bedrock.jobs_membership_stage_history no access at all — not even SELECT
--   bedrock.jobs_task                     full SELECT/INSERT/UPDATE/DELETE
--
-- avni_dev's only path to these tables is via jobs_team membership, so *every*
-- contact stage change made locally fails, not just some of them: the UPDATE
-- at the top of update_jobs_membership raises
--   ERROR: permission denied for table jobs_contact_membership
-- before anything else runs. Revisit is the most visible casualty because it
-- is the one stage with a dialog in front of it — the date prompt appears, you
-- pick a date, and only then does the save 500 — but assigned, initial_outreach
-- and the rest are equally dead locally. The revisit reminder itself would
-- have worked, since jobs_task already has the grants; the stage change behind
-- it is what fails.
--
-- The second table blocks the transaction a second way: update_jobs_membership
-- records every transition into jobs_membership_stage_history inside the same
-- transaction, so even with jobs_contact_membership writable, the INSERT there
-- would abort and roll the stage change back.
--
-- Production is unaffected — bedrock_user owns jobs_contact_membership
-- outright and already has arwdDxt there — this is purely a local-dev grant
-- gap. The 2026-08-05 stage migration itself HAS landed: the CHECK constraint
-- accepts 'call_booked' and 'revisit', and the revisit_date / call_booked_at
-- columns both exist. Permissions are the only thing missing.
--
-- Run as a role that owns these tables or is superuser (postgres or jacrev),
-- same as 2026-08-19-jobs-analytics-roles-board.sql — avni_dev cannot grant
-- this itself (verified: GRANT as avni_dev no-ops on jobs_contact_membership
-- and permission-denies on jobs_membership_stage_history).

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON bedrock.jobs_contact_membership, bedrock.jobs_membership_stage_history
    TO jobs_team;

COMMIT;
