-- 2026-09-23: notification type coverage + per-user preferences
--
-- 1. Fixes a stale CHECK constraint on bedrock.notification.type that
--    never grew to include intro_request/intro_response (already used
--    in services/notifications.py) and adds the new Account/Contact
--    owner + activity notification types.
-- 2. Adds bedrock.notification_preference — one row per user, bucketed
--    by entity type (account/contact/opportunity) plus a global Slack
--    on/off switch. Missing row = every bucket defaults to enabled.
--
-- Idempotent; safe to re-run.

-- 1. Widen the type CHECK constraint ----------------------------------------

ALTER TABLE bedrock.notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE bedrock.notification ADD CONSTRAINT notification_type_check CHECK (
    type IN (
        'project_task_assigned',
        'comment_mention',
        'sf_task_assigned',
        'sf_opp_owner_changed',
        'intro_request',
        'intro_response',
        'account_owner_changed',
        'contact_owner_changed',
        'account_comment_added',
        'contact_comment_added',
        'account_file_uploaded',
        'account_task_assigned',
        'contact_task_assigned'
    )
);

-- 2. Per-user notification preferences ---------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.notification_preference (
    user_email                   TEXT PRIMARY KEY,

    -- Global Slack DM on/off. In-app (bell) delivery is always on and
    -- isn't represented here — there's nothing to disable.
    slack_enabled                BOOLEAN NOT NULL DEFAULT true,

    -- Per-entity-type mute for "owner" notifications (ownership changes,
    -- plus — for account/contact — comments/files/task assignments on
    -- records the user owns). A false value suppresses the notification
    -- entirely (no bell row, no Slack), not just the Slack leg.
    account_activity_enabled     BOOLEAN NOT NULL DEFAULT true,
    contact_activity_enabled     BOOLEAN NOT NULL DEFAULT true,
    opportunity_activity_enabled BOOLEAN NOT NULL DEFAULT true,

    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_notification_preference'
    ) THEN
        CREATE TRIGGER set_updated_at_notification_preference
            BEFORE UPDATE ON bedrock.notification_preference
            FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
    END IF;
EXCEPTION
    WHEN undefined_function THEN NULL;
END $$;
