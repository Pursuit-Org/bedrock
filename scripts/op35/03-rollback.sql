-- Operation 35 — Pursuit · P1 + P2 tagging  ·  ROLLBACK
-- Usage:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/op35/03-rollback.sql
--
-- Undoes ONLY what 02-apply.sql created, and only where it is still safe to do so:
--   · removes operation_35_pursuit from the 30 targets, leaving all other tags intact
--   · deletes the membership rows this pass created (stage still 'assigned' with
--     our activation_note) — a row someone has since moved on is left alone
--   · deletes the jobs_account rows this pass created, but only if nothing
--     references them and the notes field still carries our marker
-- is_jobs_contact is intentionally NOT reverted: it is a general flag and may
-- now be true for other reasons.

\set ON_ERROR_STOP on
BEGIN;

\i scripts/op35/_targets.sql

UPDATE public.contacts c
   SET tags = array_remove(c.tags,'operation_35_pursuit'), updated_at = now()
  FROM op35_targets t
 WHERE c.contact_id = t.contact_id
   AND 'operation_35_pursuit' = ANY(coalesce(c.tags,'{}'::text[]));

DELETE FROM bedrock.jobs_contact_membership m
 USING op35_targets t
 WHERE m.contact_id = t.contact_id
   AND m.stage = 'assigned'
   AND m.activation_note LIKE 'Operation 35 — Pursuit%coverage audit 2026-08-26';

DELETE FROM bedrock.jobs_account ja
 WHERE ja.account_key IN (SELECT account_key FROM op35_targets)
   AND ja.notes = 'Added by Operation 35 — Pursuit coverage audit, 2026-08-26'
   AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_opportunity o WHERE o.account_id = ja.account_key)
   AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_account_comment ac
                    WHERE ac.parent_type = 'account' AND ac.parent_id = ja.account_key)
   AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_account_task at
                    WHERE at.parent_type = 'account' AND at.parent_id = ja.account_key);

\echo 'Rolled back. Review the counts, then COMMIT; or ROLLBACK; yourself.'
-- Deliberately NOT auto-committed. Inspect, then type COMMIT; or ROLLBACK;
