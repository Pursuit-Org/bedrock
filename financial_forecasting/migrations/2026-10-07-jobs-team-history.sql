-- PRO-98: the Jobs team keeps its history (Nina, 2026-10-07).
--
-- bedrock.jobs_team_member is a single on/off list, so taking someone off the
-- team took their past outreach out of every past week too: on 10/5 Damon was
-- turned off and Kwame on, and Sep 23-29 was silently recounted with Kwame in
-- and Damon out. Decision: history is kept. A change to the team applies from
-- the moment it is made; activity counts for the team if its sender was on the
-- team when they did it.
--
-- jobs_team_member stays as the CURRENT list (Settings, targets, the Owner
-- cut). This table records every change to it. effective_at NULL means "since
-- the start": the people on the list before it became editable.
BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.jobs_team_change (
    id            bigserial PRIMARY KEY,
    email         text NOT NULL
                  CHECK (email = lower(email) AND email ~ '^[a-z0-9.+-]+@pursuit\.org$'),
    on_team       boolean NOT NULL,
    effective_at  timestamptz,                -- NULL = since the start
    changed_by    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_team_change_email_at
    ON bedrock.jobs_team_change (email, effective_at);

-- Seed from what jobs_team_member already records. Skipped once the table has
-- rows, so a re-run never duplicates history.
-- 1. The team as seeded from the hardcoded list (D7: Avni, Damon, Devika):
--    on the team since the start.
INSERT INTO bedrock.jobs_team_change (email, on_team, effective_at, changed_by)
SELECT m.email, true, NULL, m.added_by
FROM bedrock.jobs_team_member m
WHERE m.added_by LIKE 'migration%'
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_team_change);
-- 2. People added in Settings since: on the team from when they were added
--    (Kwame, 2026-10-05).
INSERT INTO bedrock.jobs_team_change (email, on_team, effective_at, changed_by)
SELECT m.email, true, m.created_at, m.added_by
FROM bedrock.jobs_team_member m
WHERE m.added_by NOT LIKE 'migration%'
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_team_change WHERE effective_at IS NOT NULL);
-- 3. People taken off: off from when the row last changed (Damon, 2026-10-05).
INSERT INTO bedrock.jobs_team_change (email, on_team, effective_at, changed_by)
SELECT m.email, false, m.updated_at, 'migration 2026-10-07 (recorded removal)'
FROM bedrock.jobs_team_member m
WHERE NOT m.active
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_team_change WHERE NOT on_team);

COMMIT;

-- GRANT SELECT, INSERT ON bedrock.jobs_team_change TO bedrock_user;
-- GRANT USAGE ON SEQUENCE bedrock.jobs_team_change_id_seq TO bedrock_user;
--
-- Check:
--   SELECT * FROM bedrock.jobs_team_change ORDER BY email, effective_at NULLS FIRST;
-- Rollback:
--   DROP TABLE IF EXISTS bedrock.jobs_team_change;
