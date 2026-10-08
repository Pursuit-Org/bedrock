-- Opportunity pipeline: add Engaging (Kwame, 2026-10-08).
--
-- Engaging sits between In Discussions (now labelled "Initial Opportunity") and
-- Ask Submitted: a follow-up is set and the team is working the relationship
-- toward a specific ask. It gives the pipeline meeting a place for deals that
-- are live but not yet at an ask, which today all read as In Discussions.
--
--   Initial Opportunity  confirmed hiring appetite and a named decision maker
--                        (stored key unchanged: active_in_discussions)
--   Engaging             follow-up set; working toward a specific ask   [NEW]
--   Ask Submitted        ... unchanged from here down
--
-- No rows move. The rename is a label change in code, and Engaging starts
-- empty: owners move deals into it as they work them.
--
-- Until this runs, the app keeps working: the stage pickers read this CHECK
-- constraint and show Engaging as not yet selectable, the API refuses to write
-- it, and the Overview Stage Flow row reads "pending migration". The API
-- re-probes the constraint per request until 'engaging' appears, so the stage
-- lights up with no restart or deploy.

BEGIN;

ALTER TABLE bedrock.jobs_opportunity
  DROP CONSTRAINT IF EXISTS jobs_opportunity_stage_check;

ALTER TABLE bedrock.jobs_opportunity
  ADD CONSTRAINT jobs_opportunity_stage_check CHECK (stage IN (
    'active_in_discussions',
    'engaging',
    'ask_submitted',
    'active_opportunity_confirmed',
    'builder_submitted',
    'builder_interviewing',
    'offer_contracting',
    'closed_won',
    'closed_lost'
  ));

COMMIT;

-- Verify:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'jobs_opportunity_stage_check';
--   Expect 'engaging'::text in the list. Row counts by stage are unchanged.
