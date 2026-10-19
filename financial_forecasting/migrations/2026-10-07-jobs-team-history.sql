-- PRO-98: the Jobs team keeps its history (Nina, 2026-10-07; seed settled by Jac, 2026-10-19).
--
-- bedrock.jobs_team_member is a single on/off list, so taking someone off the
-- team took their past outreach out of every past week too. Decision: history
-- is kept. A change to the team applies from the moment it is made; activity
-- counts for the team if its sender was on the team when they did it.
--
-- D7 (Jac, 10/3, confirmed 10/19): the Jobs team is Avni, Damon and Devika.
-- Kwame is not on the team and has no targets, so he is never seeded here;
-- the 10/5 Settings edit that added him is undone in production before this
-- runs (see migrations/2026-10-19-jobs-team-d7.sql). From here on, Settings
-- writes a row for every change.
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

-- Seed: the D7 team, on since the start. Skipped once the table has rows, so
-- a re-run never duplicates history. Nobody is seeded as added or removed
-- later: Kwame's 10/5 add is undone before this runs, and Damon's 10/5
-- removal was reverted on 10/8, so neither is part of the team's history.
INSERT INTO bedrock.jobs_team_change (email, on_team, effective_at, changed_by)
SELECT v.email, true, NULL, 'migration 2026-10-07 (D7)'
FROM (VALUES ('avni@pursuit.org'),
             ('damon.kornhauser@pursuit.org'),
             ('devika@pursuit.org')) AS v(email)
WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_team_change);

-- The app writes change rows from Settings as bedrock_user, which needs the
-- table and its sequence.
GRANT SELECT, INSERT ON bedrock.jobs_team_change TO bedrock_user;
GRANT USAGE ON SEQUENCE bedrock.jobs_team_change_id_seq TO bedrock_user;

COMMIT;

-- Check:
--   SELECT * FROM bedrock.jobs_team_change ORDER BY email, effective_at NULLS FIRST;
-- Rollback:
--   DROP TABLE IF EXISTS bedrock.jobs_team_change;
