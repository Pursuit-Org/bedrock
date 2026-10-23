-- Target List: the jobs prospects the team has chosen to work (Kwame 2026-10-23).
--
-- A yes/no on a contact. Present in this table = on the Target List. Shown as a
-- checkbox column on Contacts (with bulk Add / Remove) and as a Yes/No field on
-- the contact panel. Stage Flow's Outreach Pool band reads it: the Target List
-- count, and Summarize outreach splits it into Contact Outcome, In pipeline and
-- Not in pipeline, against the total contact pool it is drawn from. Each week
-- the team assigns a slice of the list for outreach.
--
-- Adding a contact also sets public.contacts.is_jobs_contact = true (the
-- Target List is a subset of jobs prospects). Removing does not unset it.
--
-- Its own table rather than a column: public.contacts is shared with the
-- learning platform, and bedrock.jobs_contact_membership only exists while a
-- contact holds a stage (most of the list has none yet, and clearing a stage
-- deletes that row). Rows are deleted, not soft-deleted, on removal; added_by
-- and added_at record who put each contact on the list and when.
--
-- Additive only: no existing table or row changes. The app probes for this
-- table on each request; until it exists the Target List row reads "pending
-- migration" and Add / Remove on Contacts return a 409 naming this file.
-- Applying it needs no redeploy and no restart.

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
