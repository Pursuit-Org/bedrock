-- Roles board (PR #281) backing objects — recorded after the fact.
--
-- The jobs_analytics schema, its two tables, and the jobs_team role were
-- created by hand in segundo-db while the Roles tab was being built, and the
-- PR shipped without DDL. Any environment rebuilt from migrations 500s the
-- entire /api/jobs/roles/board endpoint ("relation does not exist"), and on
-- 2026-08-19 the shared DB itself broke differently: bedrock_user was never
-- made a member of jobs_team, so both the SET LOCAL ROLE jobs_team writes and
-- the board's LEFT JOINs failed with "permission denied for schema
-- jobs_analytics". This file is the checked-in record of both fixes.
--
-- DDL below was extracted from the live segundo-db catalogs (pg_attribute /
-- pg_constraint), not re-derived from the app code. Idempotent; run as a role
-- that can create roles/schemas (postgres or jacrev).

BEGIN;

-- The role exists in segundo-db already; the guard is for fresh environments.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobs_team') THEN
        CREATE ROLE jobs_team NOLOGIN;
    END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS jobs_analytics AUTHORIZATION jobs_team;

-- Persisted drag order for the Pursuit-Supported column.
CREATE TABLE IF NOT EXISTS jobs_analytics.role_sort_order (
    jobs_role_id   UUID PRIMARY KEY,
    sort_position  INTEGER NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by     TEXT
);

-- Marks a role as builder-sourced (moved out of the staff-sourced column).
CREATE TABLE IF NOT EXISTS jobs_analytics.role_origin (
    jobs_role_id  UUID PRIMARY KEY,
    origin        TEXT NOT NULL DEFAULT 'builder_sourced'
                  CHECK (origin = 'builder_sourced'),
    set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    set_by        TEXT
);

ALTER TABLE jobs_analytics.role_sort_order OWNER TO jobs_team;
ALTER TABLE jobs_analytics.role_origin     OWNER TO jobs_team;

-- The app connects as bedrock_user and does SET LOCAL ROLE jobs_team inside
-- write transactions; membership covers that, and (with INHERIT) also covers
-- the board's plain reads. The explicit grants are belt-and-braces for any
-- environment where bedrock_user is created NOINHERIT.
GRANT jobs_team TO bedrock_user;
GRANT USAGE ON SCHEMA jobs_analytics TO bedrock_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA jobs_analytics TO bedrock_user;
ALTER DEFAULT PRIVILEGES FOR ROLE jobs_team IN SCHEMA jobs_analytics
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedrock_user;

COMMIT;
