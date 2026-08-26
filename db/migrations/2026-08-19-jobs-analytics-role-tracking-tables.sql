-- Roles board tracking tables (2026-08-19): role_sort_order (manual drag-order
-- on the Placement > Roles board) and role_origin (flags a role as
-- builder-sourced — created through the app's own UI to track a self-found
-- builder's progress, no real Pursuit-company relationship). Both were
-- hand-created directly in dev and never checked in — any environment rebuilt
-- from this migrations directory 500s the whole roles/board endpoint
-- ("relation does not exist") since routes/jobs.py joins against them
-- unconditionally. Idempotent; matches the tables' existing production shape
-- exactly, so this is a no-op there.

BEGIN;

CREATE SCHEMA IF NOT EXISTS jobs_analytics;

CREATE TABLE IF NOT EXISTS jobs_analytics.role_sort_order (
    jobs_role_id  uuid PRIMARY KEY,
    sort_position integer NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text
);

CREATE TABLE IF NOT EXISTS jobs_analytics.role_origin (
    jobs_role_id uuid PRIMARY KEY,
    origin       text NOT NULL DEFAULT 'builder_sourced'
                 CONSTRAINT role_origin_origin_check CHECK (origin = 'builder_sourced'),
    set_at       timestamptz NOT NULL DEFAULT now(),
    set_by       text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON jobs_analytics.role_sort_order TO jobs_team;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs_analytics.role_origin TO jobs_team;

COMMIT;
