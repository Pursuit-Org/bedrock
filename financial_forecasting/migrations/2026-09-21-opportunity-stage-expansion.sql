-- Opportunity pipeline: 6 stages -> 9 (Kwame, 2026-09-21).
--
-- The middle of the funnel was one step where the team runs four. Splitting it
-- makes "where is this deal stuck" answerable:
--
--   In Discussion        confirmed hiring appetite and a named decision maker
--   Ask Submitted        a specific ask is with the employer - role, scope or
--                        option set. Awaiting yes or no.            [NEW]
--   Opportunity Confirmed  they said yes. A real role or engagement exists
--   Builder Submitted    named builder profiles sent to the employer  [NEW]
--   Builder Interviewing at least one builder in the employer's interview
--                        process                                     [NEW]
--   Offer Contracting    offer extended, or contract in redline       [NEW]
--   Closed Won           builder accepted
--   Closed Lost          dead, with a reason code
--
-- `reviewing_builders` is RETIRED. It sat between "profiles sent" and "in
-- interviews" and meant either, which is exactly the ambiguity the two new
-- stages remove. The 5 rows holding it are remapped to builder_submitted: it is
-- the earlier of the two, so the remap never claims an interview that may not
-- have happened. A row that IS in interviews gets moved forward by hand, which
-- is a smaller correction than discovering the reverse after the fact.
--
-- `lead_submitted` is untouched — it precedes In Discussion and was not part of
-- this change.
--
-- Order matters: remap the rows BEFORE narrowing the constraint, or the ALTER
-- fails validation against the rows it is about to outlaw.

BEGIN;

UPDATE bedrock.jobs_opportunity
   SET stage = 'builder_submitted'
 WHERE stage = 'reviewing_builders';

-- Stage history carries the retired value too; leave it, since history should
-- record what was actually chosen at the time. The UI renders it via
-- STAGE_LABELS, which keeps the label.

ALTER TABLE bedrock.jobs_opportunity
  DROP CONSTRAINT IF EXISTS jobs_opportunity_stage_check;

ALTER TABLE bedrock.jobs_opportunity
  ADD CONSTRAINT jobs_opportunity_stage_check CHECK (stage IN (
    'lead_submitted',
    'active_in_discussions',
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
--   SELECT stage, count(*) FROM bedrock.jobs_opportunity GROUP BY stage ORDER BY 2 DESC;
--   Expect no reviewing_builders, and builder_submitted up by 5.
-- The API re-probes the constraint per request until `offer_contracting`
-- appears, so the new stages become selectable with no restart or deploy.
