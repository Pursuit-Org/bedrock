-- Hiring-fit call on a staff member's connection
-- Drafted 2026-08-05. Backs the new "Hiring fit" column on My Network, which sits
-- beside "Expect a response" as the second y/n a staffer fills in per row.
--
-- Same grain as the vote it sits next to: (staff_user_id, contact_id). Jac's call
-- 2026-08-05 — hiring fit is arguably a property of the company rather than of one
-- person's relationship, but keeping both answers on one row means one write path,
-- one endpoint, and a disagreement between two staff stays visible instead of one
-- overwriting the other.
--
-- No new table: bedrock.connection_status is already keyed exactly this way and is
-- read by exactly one page.
--
-- routes/jobs.py checks for this column per request, so My Network keeps working
-- before it is applied (hiring fit reads as unset and the endpoint refuses to
-- silently drop a write). Idempotent.

BEGIN;

ALTER TABLE bedrock.connection_status
    ADD COLUMN IF NOT EXISTS hiring_fit text;

-- Deliberately text, not boolean: three states matter and NULL is one of them —
-- "yes", "no", and "nobody has said". A boolean plus NULL would work, but the
-- surrounding vocabulary (status) is already text and a CHECK keeps it honest.
ALTER TABLE bedrock.connection_status
    DROP CONSTRAINT IF EXISTS connection_status_hiring_fit_check;
ALTER TABLE bedrock.connection_status
    ADD CONSTRAINT connection_status_hiring_fit_check
    CHECK (hiring_fit IS NULL OR hiring_fit IN ('yes', 'no'));

COMMENT ON COLUMN bedrock.connection_status.hiring_fit IS
    'Would this connection''s company plausibly hire a Pursuit builder? yes | no | '
    'NULL (unanswered). Set per staff member, same grain as status.';

COMMENT ON COLUMN bedrock.connection_status.note IS
    'Free-text working note for this staff member on this connection. Overwritten '
    'in place — the row''s inline note cell. Team discussion lives in '
    'bedrock.jobs_comment (parent_type=''prospect'') instead, which is append-only '
    'and shown in the row expand.';

COMMIT;

-- ── rollback ────────────────────────────────────────────────────────────────
-- ALTER TABLE bedrock.connection_status DROP CONSTRAINT IF EXISTS connection_status_hiring_fit_check;
-- ALTER TABLE bedrock.connection_status DROP COLUMN IF EXISTS hiring_fit;
