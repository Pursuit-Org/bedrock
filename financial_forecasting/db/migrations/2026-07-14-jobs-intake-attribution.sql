-- Slack → jobs intake attribution (OPTIONAL fast-follow — NOT a launch dependency).
--
-- The intake feature ships with attribution stamped into the existing free-text
-- `source`/`notes` fields (a human-readable "claude-intake · 👍 <approver> ·
-- #jobs-team · <url>" string) and idempotency overloaded onto
-- jobs_opportunity.airtable_id. That works with ZERO schema change.
--
-- This migration turns that human-readable string into queryable, structured
-- columns once the feature is live. Apply it whenever convenient — the app does
-- NOT require these columns and does not read them yet. Fully idempotent.

BEGIN;

-- Structured intake provenance on the jobs write tables.
ALTER TABLE bedrock.jobs_opportunity
  ADD COLUMN IF NOT EXISTS intake_source              text,   -- e.g. 'slack:#jobs-team'
  ADD COLUMN IF NOT EXISTS intake_bot_id              text,
  ADD COLUMN IF NOT EXISTS intake_approved_by_slack_id text,
  ADD COLUMN IF NOT EXISTS intake_approved_by_name    text,
  ADD COLUMN IF NOT EXISTS intake_message_url         text,
  -- Clean idempotency key so we no longer overload airtable_id.
  ADD COLUMN IF NOT EXISTS intake_source_ts           text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_opportunity_intake_source_ts
  ON bedrock.jobs_opportunity (intake_source_ts)
  WHERE intake_source_ts IS NOT NULL;

ALTER TABLE bedrock.jobs_role
  ADD COLUMN IF NOT EXISTS intake_source              text,
  ADD COLUMN IF NOT EXISTS intake_bot_id              text,
  ADD COLUMN IF NOT EXISTS intake_approved_by_slack_id text,
  ADD COLUMN IF NOT EXISTS intake_approved_by_name    text,
  ADD COLUMN IF NOT EXISTS intake_message_url         text;

ALTER TABLE bedrock.jobs_account
  ADD COLUMN IF NOT EXISTS intake_source              text,
  ADD COLUMN IF NOT EXISTS intake_bot_id              text,
  ADD COLUMN IF NOT EXISTS intake_approved_by_slack_id text,
  ADD COLUMN IF NOT EXISTS intake_approved_by_name    text,
  ADD COLUMN IF NOT EXISTS intake_message_url         text;

-- Add 'slack_intake' to the contact-membership activation_reason vocabulary so a
-- flagged contact can record that it entered via the Slack intake flow. Swap the
-- CHECK constraint in place; idempotent (only acts if the current one lacks it).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_contact_membership_reason_vals'
  ) THEN
    ALTER TABLE bedrock.jobs_contact_membership
      DROP CONSTRAINT jobs_contact_membership_reason_vals;
  END IF;
  ALTER TABLE bedrock.jobs_contact_membership
    ADD CONSTRAINT jobs_contact_membership_reason_vals
    CHECK (activation_reason IS NULL OR activation_reason IN (
      'manual', 'scraper_job', 'strategic', 'algorithm', 'slack_intake'
    ));
END $$;

COMMIT;
