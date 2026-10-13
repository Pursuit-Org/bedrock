-- PRO-101 part 4: a close date on every closed opportunity, and a history row
-- for the stage each opportunity and contact is in, wherever the data can date it.
--
-- From now on the app writes a row on every move (the Log activity form's
-- Assigned -> Initial Outreach move was the one live path that wrote none, and
-- the nightly auto-advance now dates its row by the outreach, not the run).
-- This fills in the past from evidence only. A date is never guessed:
--
--   1. closed_at: a won or lost opportunity with none takes its latest move
--      into that stage from jobs_stage_history (20 won on 10/13). The rest
--      (6 won, 4 lost) have no record of when they closed; they're listed by
--      the first verify query below for their owners.
--   2. Opportunities: a closed one with no history row for its stage gets one
--      dated by closed_at (7 lost on 10/13; more after step 1). Open ones
--      with no row (9) have nothing to date them by and are left.
--   3. Contacts: one with no history row for its stage gets one dated by that
--      stage's own stamp (converted_at, call_booked_at, first_outreach_at,
--      assigned_at), or for Initial Outreach by its first jobs activity on or
--      after it was assigned, the rule the nightly auto-advance uses (24 on
--      10/13). 329 are left. 73 of them had outreach BEFORE their assigned_at,
--      which for most is 7/8, the day memberships were created from the old
--      contact stages, not a real assignment. Dating those by their first
--      outreach would put Initial Outreach before Assigned, so it's Jac's call.
--
-- Every row this writes says so: history rows have changed_by =
-- 'backfill:PRO-101' and a note naming the date's source; closed_at changes are
-- recorded in bedrock.data_fix_audit (created by
-- 2026-10-13-contact-opportunity-links.sql, which runs first). updated_at is
-- left alone. To undo:
--   DELETE FROM bedrock.jobs_stage_history WHERE changed_by = 'backfill:PRO-101';
--   DELETE FROM bedrock.jobs_membership_stage_history WHERE changed_by = 'backfill:PRO-101';
--   UPDATE bedrock.jobs_opportunity o SET closed_at = NULL FROM bedrock.data_fix_audit d
--    WHERE d.ticket = 'PRO-101' AND d.note = 'stage-history-backfill' AND o.id = d.row_key::uuid;
--
--     python -m scripts.apply_sql migrations/2026-10-13-stage-history-backfill.sql

BEGIN;

-- 1. Close dates.
CREATE TEMP TABLE pro101_closed ON COMMIT DROP AS
SELECT o.id, h.at
  FROM bedrock.jobs_opportunity o
  JOIN (SELECT opportunity_id, to_stage, max(changed_at) AS at
          FROM bedrock.jobs_stage_history GROUP BY 1, 2) h
    ON h.opportunity_id = o.id AND h.to_stage = o.stage
 WHERE o.deleted_at IS NULL AND o.closed_at IS NULL
   AND o.stage IN ('closed_won', 'closed_lost');

INSERT INTO bedrock.data_fix_audit (ticket, note, entity, row_key, field, old_value, new_value)
SELECT 'PRO-101', 'stage-history-backfill', 'jobs_opportunity', id::text, 'closed_at', NULL, at::text
  FROM pro101_closed;

ALTER TABLE bedrock.jobs_opportunity DISABLE TRIGGER trg_jobs_opportunity_updated_at;
UPDATE bedrock.jobs_opportunity o SET closed_at = c.at FROM pro101_closed c WHERE o.id = c.id;
ALTER TABLE bedrock.jobs_opportunity ENABLE TRIGGER trg_jobs_opportunity_updated_at;

-- 2. Opportunity history for a closed stage, dated by its close.
INSERT INTO bedrock.jobs_stage_history (opportunity_id, from_stage, to_stage, changed_by, note, changed_at)
SELECT o.id, NULL, o.stage, 'backfill:PRO-101', 'dated by closed_at', o.closed_at
  FROM bedrock.jobs_opportunity o
 WHERE o.deleted_at IS NULL AND o.stage IN ('closed_won', 'closed_lost') AND o.closed_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_stage_history h
                    WHERE h.opportunity_id = o.id AND h.to_stage = o.stage);

-- 3. Contact history, dated by the stage's stamp or the first outreach after
-- assignment.
INSERT INTO bedrock.jobs_membership_stage_history (contact_id, from_stage, to_stage, changed_by, note, changed_at)
SELECT contact_id, NULL, stage, 'backfill:PRO-101', 'dated by ' || source, at
  FROM (
    SELECT m.contact_id, m.stage,
           CASE m.stage
             WHEN 'converted_to_opportunity' THEN m.converted_at
             WHEN 'call_booked' THEN m.call_booked_at
             WHEN 'assigned' THEN m.assigned_at
             WHEN 'initial_outreach' THEN coalesce(m.first_outreach_at, fa.at)
           END AS at,
           CASE m.stage
             WHEN 'converted_to_opportunity' THEN 'converted_at'
             WHEN 'call_booked' THEN 'call_booked_at'
             WHEN 'assigned' THEN 'assigned_at'
             WHEN 'initial_outreach' THEN
               CASE WHEN m.first_outreach_at IS NOT NULL THEN 'first_outreach_at'
                    ELSE 'first jobs activity after assignment' END
           END AS source
      FROM bedrock.jobs_contact_membership m
      LEFT JOIN LATERAL (
        -- The first jobs-related external activity with the contact since it
        -- was assigned (services/jobs_metrics.external_activity_sql; the bound
        -- is auto_advance_outreached's).
        SELECT min(a.activity_date) AS at FROM bedrock.activity a
         WHERE a.participant_public_contact_id = m.contact_id
           AND a.activity_date >= m.assigned_at
           AND a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text')
           AND coalesce(a.jobs_relevance_override,
                        CASE WHEN a.type IN ('email', 'meeting') THEN a.jobs_relevance ELSE 'jobs' END) = 'jobs'
      ) fa ON m.stage = 'initial_outreach'
     WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_membership_stage_history h
                        WHERE h.contact_id = m.contact_id AND h.to_stage = m.stage)
  ) x
 WHERE at IS NOT NULL;

COMMIT;

-- Verify (after; 10/13 data in brackets):
--   closed with no close date [10]:
--     SELECT o.id, o.account_name, o.stage, o.owner_email FROM bedrock.jobs_opportunity o
--      WHERE o.deleted_at IS NULL AND o.stage IN ('closed_won', 'closed_lost') AND o.closed_at IS NULL;
--   opportunities with no row for their stage [9 open]:
--     SELECT count(*) FROM bedrock.jobs_opportunity o WHERE o.deleted_at IS NULL
--        AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_stage_history h WHERE h.opportunity_id = o.id AND h.to_stage = o.stage);
--   contacts with no row for their stage [329 of 1,241]:
--     SELECT m.stage, count(*) FROM bedrock.jobs_contact_membership m
--      WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_membership_stage_history h
--                         WHERE h.contact_id = m.contact_id AND h.to_stage = m.stage) GROUP BY 1;
