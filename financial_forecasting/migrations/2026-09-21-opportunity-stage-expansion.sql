-- Opportunity pipeline: 6 stages -> 8 (Kwame, 2026-09-21).
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
-- Two stages are RETIRED:
--
--   `reviewing_builders` sat between "profiles sent" and "in interviews" and
--     meant either, which is exactly the ambiguity the two new stages remove.
--     Its 5 rows go to builder_submitted: the earlier of the two, so the remap
--     never claims an interview that may not have happened. A row that IS in
--     interviews gets moved forward by hand, which is a smaller correction than
--     discovering the reverse after the fact.
--
--   `lead_submitted` sat before In Discussion and described a contact, not a
--     deal - that work lives in the membership pipeline (assigned ->
--     initial_outreach -> call_booked -> converted_to_opportunity). The funnel
--     now starts where the team says it starts. Its 2 rows go to
--     active_in_discussions, since an opportunity record existing at all means
--     someone opened a conversation.
--
-- Order matters, and in one direction only: DROP the constraint, THEN remap,
-- THEN add the narrowed one.
--
-- Remapping first looks safer but cannot work: the UPDATE writes
-- `builder_submitted`, and the OLD constraint doesn't permit that value, so the
-- remap itself fails with
--   CheckViolationError: new row for relation "jobs_opportunity" violates
--   check constraint "jobs_opportunity_stage_check"
-- before the ALTER is ever reached. Dropping first leaves the table briefly
-- unconstrained, which is fine inside this transaction — nothing else can see
-- the intermediate state, and the new constraint is validated against the
-- remapped rows on the way out.

BEGIN;

ALTER TABLE bedrock.jobs_opportunity
  DROP CONSTRAINT IF EXISTS jobs_opportunity_stage_check;

UPDATE bedrock.jobs_opportunity
   SET stage = 'builder_submitted'
 WHERE stage = 'reviewing_builders';

UPDATE bedrock.jobs_opportunity
   SET stage = 'active_in_discussions'
 WHERE stage = 'lead_submitted';

-- Stage history carries the retired values too; leave it, since history should
-- record what was actually chosen at the time. The UI renders them via
-- STAGE_LABELS, which keeps the label.

ALTER TABLE bedrock.jobs_opportunity
  ADD CONSTRAINT jobs_opportunity_stage_check CHECK (stage IN (
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
--   Expect no reviewing_builders and no lead_submitted, builder_submitted up by
--   5, active_in_discussions up by 2.
-- The API re-probes the constraint per request until `offer_contracting`
-- appears, so the new stages become selectable with no restart or deploy.
