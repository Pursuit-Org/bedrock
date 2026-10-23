-- Target set: the jobs prospects the team has chosen to work (Kwame 2026-10-23).
--
-- A yes/no on a contact. Present in this table = in the target set. Stage Flow's
-- Outreach Pool band reads it: Total contact pool (every jobs prospect), then
-- Target set beneath it, split into processed (has any outreach stage) and
-- outstanding (no stage yet). Each week the team assigns a slice of the target
-- set for outreach, so outstanding is the backlog still to start.
--
-- Its own table rather than a column on public.contacts: contacts is shared with
-- the learning platform, and a Bedrock-only flag belongs in the bedrock schema.
-- Rows are deleted, not soft-deleted, on removal: the flag has no history to
-- report on yet. Add an audit table later if "when did this enter the set"
-- becomes a question.
--
-- Additive only: no existing table or row changes. The app probes for this
-- table on each request; until it exists the Target set row reads "pending
-- migration" and the Add / Remove buttons on Contacts return a 409 naming this
-- file. Applying it needs no redeploy and no restart.

BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.jobs_target_set (
    contact_id  integer     PRIMARY KEY REFERENCES public.contacts(contact_id) ON DELETE CASCADE,
    added_by    text,
    added_at    timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- ── grants (run as an admin if bedrock_user is not the owner) ────────────────
-- GRANT SELECT, INSERT, DELETE ON bedrock.jobs_target_set TO bedrock_user;
-- GRANT SELECT ON bedrock.jobs_target_set TO jobs_dev;   -- local read-only dev

-- ── verify ───────────────────────────────────────────────────────────────────
--   SELECT count(*) FROM bedrock.jobs_target_set;
--   \d bedrock.jobs_target_set
