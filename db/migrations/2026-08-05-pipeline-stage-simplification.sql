-- Pipeline stage simplification: contacts and opportunities.
--
-- THIS FILE REWRITES LIVE PIPELINE ROWS. Unlike the additive migration alongside
-- it, it changes 61 opportunity rows and 71 contact memberships, and narrows two
-- CHECK constraints so the old values can never come back. Please read the
-- backfill section before running.
--
-- The UPDATEs intentionally carry NO `deleted_at IS NULL` filter. A CHECK
-- constraint applies to every row in the table, soft-deleted ones included, so
-- skipping them would leave legacy values behind and the new constraint would
-- refuse to be created. This is why the row counts below are larger than what
-- the app shows: 38 opportunities sit in initial_outreach in total but only 16
-- are live; 19 in on_hold_* but only 18 live.
--
-- Row counts verified against production 2026-08-05 (read-only). Re-run the
-- VERIFY BEFORE block below immediately before applying — if the numbers have
-- moved, the data drifted and this should be re-reviewed rather than forced.
--
-- Ordering matters and is deliberate:
--   1. drop the old CHECK   (so the backfill can write values the old one rejects)
--   2. backfill              (so no row violates the new one)
--   3. add the new CHECK     (now guaranteed to pass)
-- Doing 3 before 2 fails the whole transaction on the first legacy row.
--
-- DEPLOY ORDER — this one is not "apply whenever". The app must ship the
-- matching code at the same time, same as the 2026-07-16 contact-stage rename:
-- old code writing 'on_hold' after this lands is rejected by the new CHECK.
-- The app is written to tolerate BOTH vocabularies (it probes the constraint and
-- only offers the new stages once they're allowed), so apply-then-deploy is safe
-- and there is no hard cutover window — but don't leave the gap open for days.

-- Dry-run 2026-08-05 (read-only, against production): applying the backfill
-- CASE expressions in a SELECT leaves ZERO rows outside either new stage list,
-- for both tables — so both CHECK constraints below will be accepted.

BEGIN;

-- ===========================================================================
-- VERIFY BEFORE  (informational; these SELECTs don't change anything)
-- ===========================================================================
--   SELECT stage, count(*) FROM bedrock.jobs_contact_membership GROUP BY 1;
--     expected 2026-08-05: initial_outreach 827 · assigned 147 ·
--                          converted_to_opportunity 127 · on_hold 71 · not_a_fit 8
--   SELECT stage, count(*) FROM bedrock.jobs_opportunity
--    WHERE deleted_at IS NULL GROUP BY 1;
--     expected 2026-08-05: active_in_discussions 54 · closed_won 28 ·
--                          initial_outreach 16 · on_hold_not_interested 14 ·
--                          active_opportunity_confirmed 12 · closed_lost 10 ·
--                          on_hold_not_responsive 4 · active_builder_interview 4

-- ===========================================================================
-- 1. CONTACTS — add call_booked, fold on_hold into revisit
--
-- New funnel: assigned -> initial_outreach -> call_booked ->
--             converted_to_opportunity, with revisit / not_a_fit as off-ramps.
--
-- call_booked sits AFTER initial_outreach (Kwame, 2026-08-05). The original
-- request placed it "between Qualified and Converted", but there is no
-- `qualified` stage in production — only an unused qualified_at stamp column.
--
-- revisit REPLACES on_hold rather than joining it: on_hold had no date
-- mechanism, so it was never doing the "check back later" job it was being used
-- for. revisit_date + a jobs_task row give it one.
-- ===========================================================================

ALTER TABLE bedrock.jobs_contact_membership
  ADD COLUMN IF NOT EXISTS call_booked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revisit_date   date;

COMMENT ON COLUMN bedrock.jobs_contact_membership.call_booked_at IS
  'When the contact entered call_booked. Stamped like assigned_at / '
  'first_outreach_at / converted_at so the period-flow funnel can count entries '
  'into this stage.';
COMMENT ON COLUMN bedrock.jobs_contact_membership.revisit_date IS
  'When to pick this contact back up. Setting it also creates a bedrock.jobs_task '
  'for the owner, which surfaces in the Jobs Home task widget on the day.';

ALTER TABLE bedrock.jobs_contact_membership
  DROP CONSTRAINT IF EXISTS jobs_contact_membership_stage_vals;

-- 71 rows on 2026-08-05.
UPDATE bedrock.jobs_contact_membership
   SET stage = 'revisit', updated_at = now()
 WHERE stage = 'on_hold';

ALTER TABLE bedrock.jobs_contact_membership
  ADD CONSTRAINT jobs_contact_membership_stage_vals
  CHECK (stage = ANY (ARRAY[
    'assigned', 'initial_outreach', 'call_booked',
    'converted_to_opportunity', 'revisit', 'not_a_fit'
  ]::text[]));

-- History has to move too, or the period-flow funnel loses every historical
-- on_hold entry the moment the label disappears from the stage list.
UPDATE bedrock.jobs_membership_stage_history
   SET to_stage = 'revisit' WHERE to_stage = 'on_hold';
UPDATE bedrock.jobs_membership_stage_history
   SET from_stage = 'revisit' WHERE from_stage = 'on_hold';

-- ===========================================================================
-- 2. OPPORTUNITIES — 10 stages down to 6
--
--   drop   initial_outreach            -> active_in_discussions   (38 rows / 16 live)
--   rename active_builder_interview    -> reviewing_builders      (4 rows)
--   fold   on_hold_not_interested      -> closed_lost + reason    (14 live)
--          on_hold_not_responsive      -> closed_lost + reason    (4 live)
--          on_hold_not_selected        -> closed_lost + reason    (0 live)
--          — 19 on_hold_* rows in total once soft-deleted are counted
--
-- initial_outreach goes because outreach-stage tracking belongs on the CONTACT
-- (jobs_contact_membership.stage) — carrying it on the opportunity too meant two
-- places to keep in sync and two different answers to "have we reached them".
--
-- The rename changes the STORED value, not just the display label. A label-only
-- rename leaves the database saying 'active_builder_interview' forever, which is
-- exactly the drift tasks/stage-schema-drift.md exists to track.
-- ===========================================================================

ALTER TABLE bedrock.jobs_opportunity
  DROP CONSTRAINT IF EXISTS jobs_opportunity_stage_check;

UPDATE bedrock.jobs_opportunity
   SET stage = 'active_in_discussions', updated_at = now()
 WHERE stage = 'initial_outreach';

UPDATE bedrock.jobs_opportunity
   SET stage = 'reviewing_builders', updated_at = now()
 WHERE stage = 'active_builder_interview';

-- On-hold becomes closed-lost carrying its reason. closed_lost_reason and
-- closed_lost_note already exist on this table — they are NOT added here.
-- coalesce protects a row that somehow already had a reason set.
UPDATE bedrock.jobs_opportunity
   SET stage = 'closed_lost',
       closed_lost_reason = coalesce(closed_lost_reason, 'not_interested'),
       closed_at = coalesce(closed_at, now()),
       updated_at = now()
 WHERE stage = 'on_hold_not_interested';

UPDATE bedrock.jobs_opportunity
   SET stage = 'closed_lost',
       closed_lost_reason = coalesce(closed_lost_reason, 'not_responsive'),
       closed_at = coalesce(closed_at, now()),
       updated_at = now()
 WHERE stage = 'on_hold_not_responsive';

UPDATE bedrock.jobs_opportunity
   SET stage = 'closed_lost',
       closed_lost_reason = coalesce(closed_lost_reason, 'not_selected'),
       closed_at = coalesce(closed_at, now()),
       updated_at = now()
 WHERE stage = 'on_hold_not_selected';

ALTER TABLE bedrock.jobs_opportunity
  ADD CONSTRAINT jobs_opportunity_stage_check
  CHECK (stage = ANY (ARRAY[
    'lead_submitted', 'active_in_discussions', 'active_opportunity_confirmed',
    'reviewing_builders', 'closed_won', 'closed_lost'
  ]::text[]));

UPDATE bedrock.jobs_stage_history
   SET to_stage = 'reviewing_builders' WHERE to_stage = 'active_builder_interview';
UPDATE bedrock.jobs_stage_history
   SET from_stage = 'reviewing_builders' WHERE from_stage = 'active_builder_interview';
-- Historical initial_outreach and on_hold_* transitions keep their original
-- values on purpose: they record what actually happened at the time, and the
-- opportunity funnel reads history by TO-stage against the current stage list,
-- so a stage that no longer exists simply stops being counted. Rewriting them
-- would invent transitions that never occurred.

-- ===========================================================================
-- 3. CLOSED-LOST REASONS — the combined vocabulary
--
-- Kwame 2026-08-05: keep the seven the live picker already uses AND add the four
-- from the request, rather than replacing one list with the other. The three
-- not_* values are what the on-hold backfill above writes, so this constraint
-- has to allow them.
--
-- No CHECK existed on this column before, so this is a tightening. It is added
-- LAST, after the backfill, for the same reason as the stage constraints.
-- ===========================================================================

-- Any legacy value outside the list would fail the constraint below. Park them
-- as 'other' rather than losing the row; the note keeps the original. Exactly
-- one row qualifies on 2026-08-05: closed_lost_reason = 'Not interested (per
-- pipeline sheet)' — free text someone typed before this column had a
-- vocabulary. It becomes 'other' with that sentence preserved in the note.
UPDATE bedrock.jobs_opportunity
   SET closed_lost_note = coalesce(nullif(closed_lost_note, ''), '') ||
         CASE WHEN coalesce(closed_lost_note, '') = '' THEN '' ELSE ' · ' END ||
         'original reason: ' || closed_lost_reason,
       closed_lost_reason = 'other'
 WHERE closed_lost_reason IS NOT NULL
   AND closed_lost_reason NOT IN (
     'budget', 'timing', 'hired_elsewhere', 'not_a_fit', 'no_response',
     'role_cancelled', 'not_interested', 'not_selected', 'not_responsive',
     'revisit', 'other');

ALTER TABLE bedrock.jobs_opportunity
  DROP CONSTRAINT IF EXISTS jobs_opportunity_closed_lost_reason_check;

ALTER TABLE bedrock.jobs_opportunity
  ADD CONSTRAINT jobs_opportunity_closed_lost_reason_check
  CHECK (closed_lost_reason IS NULL OR closed_lost_reason = ANY (ARRAY[
    'budget', 'timing', 'hired_elsewhere', 'not_a_fit', 'no_response',
    'role_cancelled', 'not_interested', 'not_selected', 'not_responsive',
    'revisit', 'other'
  ]::text[]));

COMMENT ON COLUMN bedrock.jobs_opportunity.closed_lost_reason IS
  'Why the deal closed lost. reason=revisit means "come back to this": the UI '
  'asks for a date, stores it on the existing follow_up_date column, and creates '
  'a bedrock.jobs_task for the owner. There is no Revisit STAGE on opportunities '
  '— it is a reason plus a follow-up date.';

COMMIT;

-- ===========================================================================
-- VERIFY AFTER
-- ===========================================================================
--   SELECT stage, count(*) FROM bedrock.jobs_contact_membership GROUP BY 1;
--     expect: assigned · initial_outreach · converted_to_opportunity ·
--             revisit (71, was on_hold) · not_a_fit    — and NO on_hold
--   SELECT stage, count(*) FROM bedrock.jobs_opportunity
--    WHERE deleted_at IS NULL GROUP BY 1;
--     expect 6 values max; active_in_discussions +16 (70), closed_lost +18 (28),
--     reviewing_builders 4, and NO initial_outreach / on_hold_*
--   SELECT closed_lost_reason, count(*) FROM bedrock.jobs_opportunity
--    WHERE stage = 'closed_lost' GROUP BY 1;
--     expect not_interested 14 · not_responsive 4 · plus whatever the 10
--     pre-existing closed_lost rows already carried
--
-- ROLLBACK NOTE: this is not cleanly reversible. The on_hold_* -> closed_lost
-- fold is information-preserving (the reason column carries which one it was) so
-- it CAN be undone by hand, but 'revisit' contacts cannot be told apart from
-- ones set to revisit after the fact. Take a snapshot of
-- bedrock.jobs_contact_membership(contact_id, stage) first if you want an exit.
