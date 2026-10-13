-- Stage targets for the Overview Stage Flow (Kwame, 2026-10-13).
--
-- Adds a third kind of row to bedrock.jobs_target: section = 'stage', a weekly
-- Net New target for one Stage Flow stage. Same shape as the outreach rows:
--   owner_email set  -> that person's weekly target for the stage
--   owner_email NULL -> the team row: team_mode 'sum' (of the people) or 'set'
--                       (value is the team's own number)
-- period_start is always NULL (weekly, prorated to whatever period the chart shows).
--
-- Edited in Settings › Targets › Jobs › Stages (PUT /api/jobs/targets/stages,
-- manage_jobs_targets). Until this runs the app reads the stage-target column as
-- "pending migration" and the save returns 409; nothing else changes.
--
-- Three CHECKs widen; none of the existing rows change. Constraint names are the
-- ones the 2026-09-29 migration's inline CHECKs got by default.

BEGIN;

ALTER TABLE bedrock.jobs_target DROP CONSTRAINT IF EXISTS jobs_target_section_check;
ALTER TABLE bedrock.jobs_target ADD CONSTRAINT jobs_target_section_check
    CHECK (section IN ('outreach', 'pipeline', 'stage'));

ALTER TABLE bedrock.jobs_target DROP CONSTRAINT IF EXISTS jobs_target_metric_check;
ALTER TABLE bedrock.jobs_target ADD CONSTRAINT jobs_target_metric_check
    CHECK (metric IN (
        'accounts_activated', 'total_outreach_activity', 'total_calls',
        'call_discovery', 'converted_opportunities', 'jobs',
        -- stage keys (services/jobs_targets_store.py STAGE_METRICS)
        'assigned',
        'initial_outreach',
        'scheduling',
        'call_booked',
        'converted_to_opportunity',
        'revisit',
        'not_a_fit',
        'active_in_discussions',
        'engaging',
        'ask_submitted',
        'active_opportunity_confirmed',
        'builder_submitted',
        'builder_interviewing',
        'offer_contracting',
        'closed_won',
        'closed_lost'));

ALTER TABLE bedrock.jobs_target DROP CONSTRAINT IF EXISTS jobs_target_check;
ALTER TABLE bedrock.jobs_target ADD CONSTRAINT jobs_target_check CHECK (
        (section = 'outreach' AND metric <> 'jobs' AND period_start IS NULL
             AND (owner_email IS NOT NULL OR team_mode IS NOT NULL))
     OR (section = 'pipeline' AND metric = 'jobs' AND owner_email IS NULL
             AND period_start IS NOT NULL
             AND period_start = date_trunc('quarter', period_start::timestamp)::date)
     OR (section = 'stage' AND metric <> 'jobs' AND period_start IS NULL
             AND (owner_email IS NOT NULL OR team_mode IS NOT NULL))
);

COMMIT;

-- Verify:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'bedrock.jobs_target'::regclass AND contype = 'c';
--   Expect 'stage' in jobs_target_section_check. The API re-reads it within a
--   minute (targets cache TTL), so Settings › Stages becomes editable with no
--   restart.
