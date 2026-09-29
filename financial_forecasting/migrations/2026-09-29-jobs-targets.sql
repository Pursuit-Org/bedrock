-- Jobs targets and the Jobs team list, editable in Settings > Targets > Jobs
-- (Kwame, 2026-09-29).
--
-- Replaces two hardcoded lists:
--   * services/outreach_targets.py: weekly outreach targets per person, with
--     team totals that are either summed from people or typed directly;
--   * JOBS_TEAM_EMAILS in routes/jobs.py (and its copy in
--     services/jobs_activity_link.py): who counts as "the Jobs team" in every
--     team-scoped Jobs metric, and who appears on the Owner cut.
--
-- The app probes for these tables and falls back to the hardcoded values until
-- this runs, so nothing changes on deploy. After it runs, the seeded rows below
-- reproduce today's numbers, with one deliberate exception noted at the seed.

BEGIN;

-- ── Jobs team ────────────────────────────────────────────────────────────────
-- One row per person. `active = false` keeps the row for history but takes the
-- person out of the team scope, the Owner cut and the target grid.
CREATE TABLE IF NOT EXISTS bedrock.jobs_team_member (
    email       text PRIMARY KEY
                CHECK (email = lower(email) AND email ~ '^[a-z0-9._%+-]+@pursuit\.org$'),
    active      boolean     NOT NULL DEFAULT true,
    sort_order  integer     NOT NULL DEFAULT 0,
    added_by    text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- The CHECK is also a safety property: the app builds team predicates by
-- interpolating these addresses into SQL, which is only safe because the
-- column can never hold a quote or a space.

-- ── Targets ──────────────────────────────────────────────────────────────────
-- section = 'outreach': a standing WEEKLY target. period_start is NULL.
--   owner_email set  → that person's weekly target for `metric`.
--   owner_email NULL → the team row. team_mode 'sum' means the team target is
--                      the sum of the people (value ignored); 'set' means
--                      `value` is the team target, whatever the people carry.
-- section = 'pipeline': the jobs target for one quarter. metric = 'jobs',
--   owner_email NULL, period_start = the quarter's first day.
CREATE TABLE IF NOT EXISTS bedrock.jobs_target (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    section      text NOT NULL CHECK (section IN ('outreach', 'pipeline')),
    metric       text NOT NULL CHECK (metric IN (
                     'accounts_activated', 'total_outreach_activity', 'total_calls',
                     'call_discovery', 'converted_opportunities', 'jobs')),
    owner_email  text,
    period_start date,
    value        integer CHECK (value IS NULL OR value BETWEEN 0 AND 100000),
    team_mode    text CHECK (team_mode IN ('sum', 'set')),
    updated_by   text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (section = 'outreach' AND metric <> 'jobs' AND period_start IS NULL
             AND (owner_email IS NOT NULL OR team_mode IS NOT NULL))
     OR (section = 'pipeline' AND metric = 'jobs' AND owner_email IS NULL
             AND period_start IS NOT NULL
             AND period_start = date_trunc('quarter', period_start)::date)
    )
);
-- One row per (section, metric, owner, quarter). NULLs folded so the team row
-- and the outreach rows (no quarter) are unique too.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_target_key
    ON bedrock.jobs_target (section, metric, coalesce(owner_email, ''),
                            coalesce(period_start, '1900-01-01'::date));

-- ── Seed: today's hardcoded values ──────────────────────────────────────────
-- Skipped entirely once either table has rows, so a re-run never overwrites
-- edits made in the app.
INSERT INTO bedrock.jobs_team_member (email, sort_order, added_by)
SELECT v.email, v.ord, 'migration 2026-09-29'
FROM (VALUES ('avni@pursuit.org', 1),
             ('damon.kornhauser@pursuit.org', 2),
             ('devika@pursuit.org', 3)) AS v(email, ord)
WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_team_member);

-- Personal weekly targets for the three team members, and team rows.
-- Exception: kwame@pursuit.org's 10 outreach a week is NOT seeded. He is not
-- in the team scope, so the old team target of 150 counted his 10 while the
-- team actuals never counted his sends (outreach_targets.py documented the
-- mismatch). The team target now reads 140 and matches what it measures.
-- Adding him to the team on the Targets page restores both.
INSERT INTO bedrock.jobs_target (section, metric, owner_email, value, team_mode, updated_by)
SELECT 'outreach', v.metric, v.owner, v.value, v.mode, 'migration 2026-09-29'
FROM (VALUES
    ('total_outreach_activity', 'avni@pursuit.org',             45, NULL),
    ('total_calls',             'avni@pursuit.org',              5, NULL),
    ('call_discovery',          'avni@pursuit.org',              5, NULL),
    ('total_outreach_activity', 'damon.kornhauser@pursuit.org', 45, NULL),
    ('total_calls',             'damon.kornhauser@pursuit.org',  5, NULL),
    ('call_discovery',          'damon.kornhauser@pursuit.org',  5, NULL),
    ('total_outreach_activity', 'devika@pursuit.org',           50, NULL),
    ('total_calls',             'devika@pursuit.org',            5, NULL),
    ('call_discovery',          'devika@pursuit.org',            5, NULL),
    -- team rows: three summed from people, two typed directly
    ('total_outreach_activity', NULL, NULL, 'sum'),
    ('total_calls',             NULL, NULL, 'sum'),
    ('call_discovery',          NULL, NULL, 'sum'),
    ('accounts_activated',      NULL,   20, 'set'),
    ('converted_opportunities', NULL,    2, 'set')
) AS v(metric, owner, value, mode)
WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_target WHERE section = 'outreach');

-- ── Permission ───────────────────────────────────────────────────────────────
-- Who can edit Jobs targets and the team list. Same holders as Revenue targets
-- (manage_owner_goals): Admin and Executive. Everyone can view.
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"manage_jobs_targets": true}'::jsonb
WHERE name IN ('Admin', 'Executive');

COMMIT;

-- ── grants (run as an admin if bedrock_user is not the owner) ────────────────
-- GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.jobs_team_member, bedrock.jobs_target TO bedrock_user;

-- ── verify ───────────────────────────────────────────────────────────────────
--   SELECT * FROM bedrock.jobs_team_member ORDER BY sort_order;
--   SELECT section, metric, owner_email, period_start, value, team_mode
--   FROM bedrock.jobs_target ORDER BY section, metric, owner_email NULLS FIRST;
--   SELECT name, permissions->>'manage_jobs_targets' FROM bedrock.permission_profile;

-- ── rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS bedrock.jobs_target;
-- DROP TABLE IF EXISTS bedrock.jobs_team_member;
-- UPDATE bedrock.permission_profile SET permissions = permissions - 'manage_jobs_targets';
