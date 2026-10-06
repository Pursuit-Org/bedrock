-- PRO-98: the nightly email message index (services/email_message_index.py)
-- picks the threads synced since its last run by activity.synced_at, which had
-- no index, so every run read the whole 2 GB table. That scan outgrew the
-- 30-second limit the run was under, and the index stopped on 2026-09-24.
-- The code no longer runs under that limit; this makes the scan cheap anyway.
--
-- One statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction, and several statements sent together run as one. Concurrently
-- so the sync and the app keep writing while it builds.
--
--     python -m scripts.apply_sql migrations/2026-10-06-activity-synced-at-index.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_gmail_synced_at
    ON bedrock.activity (synced_at)
    WHERE source = 'gmail-sync' AND deleted_at IS NULL;
