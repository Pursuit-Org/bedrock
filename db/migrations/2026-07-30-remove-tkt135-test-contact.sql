-- Remove the TKT-135 verification artifact (2026-07-30). Reproducing the
-- add-contact 500 required actually creating a contact; the row was neutralized
-- and renamed "[test]" at the time but the app has no contact delete, so it
-- still sits in the contacts list. Guarded so it can only ever remove that exact
-- row: id + the "[test]" name + no email + no activity, membership, or
-- opportunity link. If any of those stopped being true the DELETE is a no-op
-- rather than a surprise. Idempotent.

BEGIN;

DELETE FROM public.contacts c
WHERE c.contact_id = 54841
  AND c.first_name = '[test]'
  AND c.email IS NULL
  AND NOT EXISTS (SELECT 1 FROM bedrock.activity a
                  WHERE a.participant_public_contact_id = c.contact_id)
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m
                  WHERE m.contact_id = c.contact_id)
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_opportunity o
                  WHERE o.deleted_at IS NULL
                    AND 'pub:' || c.contact_id::text = ANY(o.sf_contact_ids));

COMMIT;
