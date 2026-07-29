-- PBD owner on jobs accounts (TKT-167): show the Salesforce account owner as
-- a read-only "PBD owner" beside the jobs-side owner ("Jobs owner"). Column is
-- filled by an owner-sync (initially the 2026-07-30 Devika pull; a recurring
-- SF-owner sync is the follow-up). Code that reads this is feature-detected,
-- so applying this is safe any time. Idempotent.

ALTER TABLE bedrock.jobs_account
    ADD COLUMN IF NOT EXISTS pbd_owner_name text,
    ADD COLUMN IF NOT EXISTS pbd_owner_synced_at timestamptz;
