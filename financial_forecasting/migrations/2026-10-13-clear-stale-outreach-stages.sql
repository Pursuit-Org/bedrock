-- Clear stale outreach stages (Kwame, 2026-10-13).
--
-- Contacts that have sat in Assigned or Initial outreach since before
-- 2026-07-28 (77 days before 2026-10-13) with nothing happening go back to no
-- stage, so the Overview Stage Flow pool shows the outreach the team is
-- actually working. Read-only sizing on 2026-10-13: 892 stale, 77 kept as
-- active, 815 cleared (129 Assigned, 686 Initial outreach).
--
-- "Blank" means exactly what Unflag does in the app (DELETE
-- /api/jobs/contacts/{id}/jobs-membership): the membership row is removed and a
-- history row records it as 'unflagged'. The contact itself is untouched.
--
-- KEPT (active), even if stale by date:
--   * any logged activity linked to the contact since 2026-07-28
--   * any calendar meeting with the contact's email as an attendee since then
--   * any open task on the contact
--
-- The dates are fixed, not now()-relative, so the set doesn't grow if this
-- runs a few days later than written.
--
-- Side effect to know about: the removed rows carry the contacts' assigned /
-- first-outreach stamps, so period counts that read those stamps (the Contacts
-- funnel's period mode, Contacted / assigned on Outreach) will read lower for
-- weeks before 2026-07-28. Activity counts (sends, calls) come from the activity
-- table and do not change.
--
-- UNDO: every removed row is copied to
-- bedrock.jobs_contact_membership_cleared_20261013 first. To restore:
--   INSERT INTO bedrock.jobs_contact_membership
--   SELECT * FROM bedrock.jobs_contact_membership_cleared_20261013
--   ON CONFLICT (contact_id) DO NOTHING;

BEGIN;

CREATE TEMP TABLE stale_outreach ON COMMIT DROP AS
WITH cand AS (
    SELECT m.contact_id, m.stage, lower(c.email) AS email,
           COALESCE(
               (SELECT max(h.changed_at) FROM bedrock.jobs_membership_stage_history h
                 WHERE h.contact_id = m.contact_id AND h.to_stage = m.stage),
               CASE m.stage WHEN 'assigned' THEN m.assigned_at
                            WHEN 'initial_outreach' THEN m.first_outreach_at END,
               m.updated_at) AS entered
    FROM bedrock.jobs_contact_membership m
    JOIN public.contacts c ON c.contact_id = m.contact_id
    WHERE m.stage IN ('assigned', 'initial_outreach')
)
SELECT cand.contact_id, cand.stage
FROM cand
WHERE cand.entered < '2026-07-28'
  AND NOT EXISTS (
      SELECT 1 FROM bedrock.activity a
       WHERE a.deleted_at IS NULL AND a.activity_date >= '2026-07-28'
         AND a.participant_public_contact_id = cand.contact_id)
  AND NOT EXISTS (
      SELECT 1 FROM bedrock.activity a
       WHERE a.deleted_at IS NULL AND a.activity_date >= '2026-07-28'
         AND a.source = 'calendar-sync' AND cand.email IS NOT NULL
         AND a.meeting_attendees @> jsonb_build_array(jsonb_build_object('email', cand.email)))
  AND NOT EXISTS (
      SELECT 1 FROM bedrock.jobs_task t
       WHERE t.parent_type = 'prospect' AND t.parent_id = cand.contact_id::text
         AND t.deleted_at IS NULL AND t.status <> 'Completed');

-- Backup first, so the delete can be undone.
CREATE TABLE bedrock.jobs_contact_membership_cleared_20261013 AS
SELECT m.* FROM bedrock.jobs_contact_membership m
JOIN stale_outreach s ON s.contact_id = m.contact_id;

INSERT INTO bedrock.jobs_membership_stage_history (contact_id, from_stage, to_stage, changed_by, note)
SELECT contact_id, stage, 'unflagged', 'migration 2026-10-13',
       'Stale outreach cleanup: in stage since before 2026-07-28 with no activity or open task'
FROM stale_outreach;

DELETE FROM bedrock.jobs_contact_membership m
USING stale_outreach s
WHERE m.contact_id = s.contact_id;

COMMIT;

-- Verify:
--   SELECT count(*) FROM bedrock.jobs_contact_membership_cleared_20261013;   -- about 815
--   SELECT stage, count(*) FROM bedrock.jobs_contact_membership
--    WHERE stage IN ('assigned', 'initial_outreach') GROUP BY 1;
--   Expect about 38 Assigned and 93 Initial outreach left (counts move a
--   little with any activity logged between 2026-10-13 and the run).
