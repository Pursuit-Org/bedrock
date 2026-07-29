-- Membership stage history (2026-07-28): real stage-entry tracking for the jobs
-- contact funnel, mirroring bedrock.jobs_stage_history (opportunities). Written
-- by the three stage-write paths (PATCH jobs-membership, _flag_contacts bulk
-- upsert, nightly auto_advance_outreached) plus unflag (to_stage='unflagged');
-- read by GET /api/jobs/contacts to expose membership_stage_entered_at
-- (Jobs Home "This week / Earlier" grouping). Idempotent.
--
-- No FK on contact_id: jobs_contact_membership itself has none (contact-sync
-- churn), and a CASCADE would silently wipe history.

CREATE TABLE IF NOT EXISTS bedrock.jobs_membership_stage_history (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id  int  NOT NULL,
    from_stage  text,                    -- NULL = first entry / backfill-unknown
    to_stage    text NOT NULL,           -- membership stages + 'unflagged'
    changed_by  text,
    note        text,
    changed_at  timestamptz NOT NULL DEFAULT now()
);

-- One composite index serves both the per-contact timeline and the
-- stage_entered_at subquery (contact_id + to_stage + max(changed_at)).
CREATE INDEX IF NOT EXISTS jobs_membership_stage_history_contact_stage_idx
    ON bedrock.jobs_membership_stage_history (contact_id, to_stage, changed_at DESC);

-- Backfill from the existing sparse stage stamps — single shot (skips entirely
-- if the table already has rows). from_stage values here are conventions, not
-- recorded facts; only to_stage/changed_at feed stage_entered_at.
WITH seed AS (
    SELECT contact_id, NULL::text AS from_stage, 'assigned' AS to_stage,
           assigned_by AS changed_by, assigned_at AS changed_at
    FROM bedrock.jobs_contact_membership WHERE assigned_at IS NOT NULL
  UNION ALL
    SELECT contact_id, 'assigned', 'initial_outreach', first_outreach_by, first_outreach_at
    FROM bedrock.jobs_contact_membership WHERE first_outreach_at IS NOT NULL
  UNION ALL
    SELECT contact_id, 'initial_outreach', 'converted_to_opportunity', NULL, converted_at
    FROM bedrock.jobs_contact_membership WHERE converted_at IS NOT NULL
)
INSERT INTO bedrock.jobs_membership_stage_history
    (contact_id, from_stage, to_stage, changed_by, note, changed_at)
SELECT contact_id, from_stage, to_stage, changed_by, 'backfill 2026-07-28', changed_at
FROM seed
WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_membership_stage_history);
