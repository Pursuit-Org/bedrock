-- One-time cleanup companion to feat/jobs-prospect-flag-relevance-gate
-- (2026-07-28, Jac's call). The nightly auto_flag_jobs_prospects job used to
-- flip is_jobs_contact=true for any contact the jobs team merely appeared
-- alongside on an email (not just jobs-relevant activity), steadily re-flooding
-- the pipeline and undoing the 2026-07-22 re-curation. The code is now gated on
-- jobs-relevance, but the job only ever SETS the flag true — it never clears it,
-- so ~819 already-over-flagged, no-signal contacts persist. This re-applies the
-- exact re-curation definition to un-flag them.
--
-- A jobs prospect must have a REAL jobs signal:
--   1. a jobs pipeline stage (jobs_contact_membership), OR
--   2. any curated CRM tag (bedrock.contact_tag_catalog), OR
--   3. jobs-classified activity (jobs_relevance/override = 'jobs'), OR
--   4. a link to a jobs opportunity.
-- Contacts in the email-candidate review queue keep their queue membership
-- (source='email_candidate' / 'email_review' tag are independent of this flag),
-- so un-flagging only removes them from the main prospect list, not from triage.
-- Fully reversible: the signal is recomputable, and affected ids are backed up
-- to ~/Desktop/is_jobs_contact_recurate_cleanup_2026-07-28.csv before running.
-- Idempotent.

UPDATE public.contacts c
SET is_jobs_contact = false, updated_at = now()
WHERE c.is_jobs_contact
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = c.contact_id)
  AND NOT (coalesce(c.tags, '{}'::text[]) && ARRAY(SELECT slug FROM bedrock.contact_tag_catalog))
  AND NOT EXISTS (SELECT 1 FROM bedrock.activity a
                  WHERE a.participant_public_contact_id = c.contact_id AND a.deleted_at IS NULL
                    AND coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs')
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_opportunity o
                  WHERE o.deleted_at IS NULL
                    AND ('pub:' || c.contact_id::text = ANY(o.sf_contact_ids)
                         OR (c.airtable_id IS NOT NULL AND 'airtable:' || c.airtable_id = ANY(o.sf_contact_ids))));
