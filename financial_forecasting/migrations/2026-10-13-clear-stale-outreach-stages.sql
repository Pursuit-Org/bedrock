-- Clear stale outreach stages (Kwame, 2026-10-13).
--
-- Contacts that have sat in Assigned or Initial outreach since before
-- 2026-07-28 (77 days before 2026-10-13) with nothing happening go back to no
-- stage, so the Overview Stage Flow pool shows the outreach the team is
-- actually working. Read-only sizing on 2026-10-13: 892 stale, 80 kept as
-- active, 812 cleared (129 Assigned, 683 Initial outreach). "Active" means any
-- activity linked to them, a meeting they attended (any email case), an email
-- that reached them as To/Cc, or an open task, since the cutoff.
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
),
-- Everyone touched since the cutoff, each way a touch can reach a contact.
-- MATERIALIZED builds each set once; inlined, Postgres re-ran them per contact.
touched AS MATERIALIZED (
    SELECT participant_public_contact_id AS contact_id FROM bedrock.activity
     WHERE deleted_at IS NULL AND activity_date >= '2026-07-28'
       AND participant_public_contact_id IS NOT NULL
),
-- Meeting attendees, matched case-insensitively like the rest of the app.
met AS MATERIALIZED (
    SELECT DISTINCT lower(att->>'email') AS email
      FROM bedrock.activity a, jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att
     WHERE a.deleted_at IS NULL AND a.activity_date >= '2026-07-28' AND a.source = 'calendar-sync'
       AND att->>'email' IS NOT NULL
),
-- Emails that reached them only as a To/Cc recipient (no participant link).
mailed AS MATERIALIZED (
    SELECT DISTINCT lower(e) AS email
      FROM bedrock.activity a, unnest(coalesce(a.email_to, '{}') || coalesce(a.email_cc, '{}')) e
     WHERE a.deleted_at IS NULL AND a.activity_date >= '2026-07-28' AND a.type = 'email'
       AND e IS NOT NULL
),
open_tasks AS MATERIALIZED (
    SELECT parent_id FROM bedrock.jobs_task
     WHERE parent_type = 'prospect' AND deleted_at IS NULL AND status <> 'Completed'
       AND parent_id IS NOT NULL
)
SELECT cand.contact_id, cand.stage
FROM cand
WHERE cand.entered < '2026-07-28'
  AND NOT EXISTS (SELECT 1 FROM touched t WHERE t.contact_id = cand.contact_id)
  AND (cand.email IS NULL OR NOT EXISTS (SELECT 1 FROM met x WHERE x.email = cand.email))
  AND (cand.email IS NULL OR NOT EXISTS (SELECT 1 FROM mailed x WHERE x.email = cand.email))
  AND NOT EXISTS (SELECT 1 FROM open_tasks t WHERE t.parent_id = cand.contact_id::text);

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
--   SELECT count(*) FROM bedrock.jobs_contact_membership_cleared_20261013;   -- about 812
--   SELECT stage, count(*) FROM bedrock.jobs_contact_membership
--    WHERE stage IN ('assigned', 'initial_outreach') GROUP BY 1;
--   Expect about 38 Assigned and 96 Initial outreach left (counts move a
--   little with any activity logged between 2026-10-13 and the run).
