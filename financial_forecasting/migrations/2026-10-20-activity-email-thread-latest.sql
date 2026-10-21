-- Email chains surface by their LATEST message, not their first (2026-10-20).
--
-- bedrock.activity stays one row per Gmail thread, dated to the thread's first
-- message (activity_date) — that date is part of the cross-mailbox dedup key
-- and feeds the jobs metrics, so its meaning doesn't change. These columns add
-- the thread's recency alongside it: feeds sort by
-- COALESCE(last_message_at, activity_date), so a reply moves the thread up.
-- Written by services/gmail_sync.py on every sync of the thread; existing rows
-- are filled by scripts/backfill_email_thread_latest.py.
--
-- Automated senders (Mailsuite reminders, no-reply bots) are excluded from
-- last_message_* and message_count, so a reminder can't make a quiet thread
-- look active.
--
-- Additive only: nullable columns / defaulted boolean (metadata-only in PG 11+)
-- and indexes. Safe to apply before the code that writes them is deployed.

ALTER TABLE bedrock.activity
    ADD COLUMN IF NOT EXISTS last_message_at   timestamptz,
    ADD COLUMN IF NOT EXISTS last_message_from text,
    ADD COLUMN IF NOT EXISTS message_count     integer;

-- Per-message recipients (To + Cc, lowercased) and an automated-sender flag, so
-- "last activity" for a contact counts only messages they were actually on,
-- and never a machine nudge. recipient_emails is NULL for messages synced
-- before recipients were stored — readers fall back to thread-level matching.
ALTER TABLE bedrock.activity_email_message
    ADD COLUMN IF NOT EXISTS recipient_emails text[],
    ADD COLUMN IF NOT EXISTS is_automated     boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS activity_email_message_recipients
    ON bedrock.activity_email_message USING gin (recipient_emails);

CREATE INDEX IF NOT EXISTS idx_activity_account_recency
    ON bedrock.activity (account_id, (COALESCE(last_message_at, activity_date)) DESC)
    WHERE deleted_at IS NULL;
