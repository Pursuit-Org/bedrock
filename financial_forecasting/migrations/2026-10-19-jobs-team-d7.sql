-- D7 (Jac, 10/3, confirmed 10/19): the Jobs team is Avni, Damon and Devika.
-- Kwame is not on the team and has no targets. On 10/5 Kwame added himself
-- on Settings › Targets › Jobs with a 10/2/2 weekly target. This undoes that.
-- Run as jacrev BEFORE 2026-10-07-jobs-team-history.sql, so the team history
-- never records him. Re-runnable.
BEGIN;

UPDATE bedrock.jobs_team_member
   SET active = false, updated_at = now()
 WHERE email = 'kwame@pursuit.org' AND active;

DELETE FROM bedrock.jobs_target
 WHERE section = 'outreach' AND owner_email = 'kwame@pursuit.org';

COMMIT;

-- Not done here, Jac decides: on 10/5 Kwame also set Avni's and Damon's weekly
-- outreach targets to 0 and Devika's to 25 (the 9/29 seed had 45 / 45 / 50).
-- To restore the seeded values:
--   UPDATE bedrock.jobs_target SET value = 45, updated_by = 'jac 2026-10-19', updated_at = now()
--    WHERE section = 'outreach' AND metric = 'total_outreach_activity'
--      AND owner_email IN ('avni@pursuit.org', 'damon.kornhauser@pursuit.org');
--   UPDATE bedrock.jobs_target SET value = 50, updated_by = 'jac 2026-10-19', updated_at = now()
--    WHERE section = 'outreach' AND metric = 'total_outreach_activity' AND owner_email = 'devika@pursuit.org';
--
-- Check:
--   SELECT email, active FROM bedrock.jobs_team_member ORDER BY sort_order;
--   SELECT owner_email, metric, value FROM bedrock.jobs_target WHERE section = 'outreach' ORDER BY 1, 2;
