-- 2026-09-23: notification retention index
--
-- bedrock.notification is now pruned by services/notification_cleanup.py
-- (rows older than 14 days are deleted on an hourly loop). The existing
-- indexes are keyed on recipient_email first, so a global age-based
-- DELETE would scan the whole table — add a created_at-leading index
-- to make that cheap.
--
-- Idempotent.

CREATE INDEX IF NOT EXISTS idx_notification_created_at
    ON bedrock.notification (created_at);
