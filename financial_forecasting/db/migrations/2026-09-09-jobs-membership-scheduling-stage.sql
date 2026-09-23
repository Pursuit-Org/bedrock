-- Add a 'scheduling' stage to the contact pipeline, between 'initial_outreach'
-- and 'call_booked'.
--
-- The gap this fills: "they replied and we're working out a time" is not the
-- same as "a call is on the calendar", but today both collapse into
-- initial_outreach until the invite is actually accepted. That makes
-- initial_outreach a mix of untouched replies and live scheduling threads, and
-- it is the largest stage on the board (784 of 1,225 memberships as of
-- 2026-09-09), so the distinction is worth having.
--
-- Stage order after this lands:
--   assigned -> initial_outreach -> scheduling -> call_booked
--            -> converted_to_opportunity
--   (revisit and not_a_fit remain the two off-ramps)
--
-- This only widens the CHECK constraint. No rows are moved into the new stage:
-- which of the existing initial_outreach contacts are mid-scheduling isn't
-- derivable from the data, so it's left to the team to reclassify by hand.
--
-- Deliberately NOT adding a scheduling_at timestamp column. call_booked_at and
-- converted_at exist because the scorecard counts entries into those stages;
-- nothing reports on scheduling yet. Worth adding later if it does.
--
-- Run as a role that owns the table or is superuser (postgres or jacrev) —
-- avni_dev has no DDL on the bedrock schema. The application already ships the
-- stage: /api/jobs/stage-vocabulary probes this constraint on each request and
-- reports 'scheduling' as unavailable until this runs, so the pickers show it
-- greyed out with a hover reason and reject it with a 409 rather than a failed
-- save. Applying this makes it selectable with no redeploy and no restart.

BEGIN;

ALTER TABLE bedrock.jobs_contact_membership
    DROP CONSTRAINT jobs_contact_membership_stage_vals;

ALTER TABLE bedrock.jobs_contact_membership
    ADD CONSTRAINT jobs_contact_membership_stage_vals
    CHECK (stage = ANY (ARRAY[
        'assigned'::text,
        'initial_outreach'::text,
        'scheduling'::text,
        'call_booked'::text,
        'converted_to_opportunity'::text,
        'revisit'::text,
        'not_a_fit'::text
    ]));

COMMIT;
