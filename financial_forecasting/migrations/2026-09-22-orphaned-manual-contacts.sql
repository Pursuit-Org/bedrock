-- Repair contacts created from a jobs screen that never entered the pipeline
-- (Kwame, 2026-09-22).
--
-- POST /api/jobs/contacts wrote a public.contacts row and stopped there. It set
-- neither is_jobs_contact nor a jobs_contact_membership row, so the contact was
-- invisible in both places that matter:
--
--   /api/jobs/account-prospects  filters on c.is_jobs_contact = true
--   /api/jobs/contacts           filters on EXISTS (jobs_contact_membership)
--
-- while the UNIQUE index on email made a second attempt fail with "a contact
-- with that email already exists" — added, undeletable, unfindable. The code
-- fix routes creation through _flag_contacts; this repairs the rows already
-- stranded.
--
-- SAFE AGAINST DELIBERATE REMOVALS. Removing a contact from the pipeline only
-- sets is_jobs_contact = false and LEAVES the membership row, so "no membership
-- row at all" is a signature only the create bug produces. Keying the repair on
-- the missing membership therefore cannot resurrect anyone who was taken out of
-- the pipeline on purpose — those rows are skipped by the NOT EXISTS below, and
-- their is_jobs_contact stays false.
--
-- Scope: airtable_id LIKE 'manual-%', which is exactly what create_contact
-- stamps. Contacts from Airtable, LinkedIn or Salesforce are untouched.

BEGIN;

-- Everything the repair will touch, resolved once so both statements act on the
-- same set even if one of them changes what the other would have matched.
CREATE TEMP TABLE orphaned_manual_contacts ON COMMIT DROP AS
SELECT c.contact_id
FROM public.contacts c
WHERE c.airtable_id LIKE 'manual-%'
  AND NOT EXISTS (
    SELECT 1 FROM bedrock.jobs_contact_membership m
     WHERE m.contact_id = c.contact_id
  );

-- 1. The funnel row. 'assigned' is where _flag_contacts puts a newly activated
--    contact, and 'manual' is the activation_reason the CHECK allows for a
--    hand-created one. assigned_at defaults to now(); the contact's own
--    created_at stays the record of when they were first entered.
INSERT INTO bedrock.jobs_contact_membership
    (contact_id, stage, activation_reason, activation_note, assigned_by)
SELECT o.contact_id, 'assigned', 'manual',
       'Backfilled 2026-09-22: created from a jobs screen before creation activated the contact',
       'migration'
FROM orphaned_manual_contacts o;

-- 2. The legacy flag the account panel reads.
UPDATE public.contacts c
   SET is_jobs_contact = true, updated_at = now()
  FROM orphaned_manual_contacts o
 WHERE c.contact_id = o.contact_id
   AND coalesce(c.is_jobs_contact, false) = false;

COMMIT;

-- Verify — expect 0 rows:
--   SELECT c.contact_id, c.full_name
--     FROM public.contacts c
--     LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = c.contact_id
--    WHERE c.airtable_id LIKE 'manual-%' AND m.contact_id IS NULL;
--
-- As of writing this repairs 31 contacts, 15 of which carried neither the flag
-- nor a membership. The rest had the flag from an older code path but no
-- membership, so they showed on the account and not in the Contacts list.
