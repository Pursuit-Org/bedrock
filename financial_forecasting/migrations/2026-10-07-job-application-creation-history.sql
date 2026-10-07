-- PRO-117: date the stage the Jobs team's applications were created at.
--
-- Interviews are counted from public.job_applications.stage_history: an
-- application's first entry into 'interview', dated by that entry. Until
-- PRO-117, Bedrock's two "log an application" forms (an opportunity's builder
-- activity, Placement > Roles) created an application at its stage with an
-- EMPTY history, and staff log most interviews that way, after the fact. Only a
-- later stage change was recorded. The forms now write a creation entry; this
-- adds the one the existing rows are missing, where it can be proved.
--
-- Proved means the application is still at the stage it was created at, so
-- that stage was reached on the day it was created:
--   * created on/after 2026-09-29 (New York): from then Bedrock records every
--     stage change it makes (the first entry it wrote is dated 9/29) and the
--     platform records its own, so an empty history means no change; or
--   * never updated since it was created.
-- Anything else with an empty history (moved before 9/29, Airtable imports)
-- is left alone: the dashboard shows it as interviewing with no recorded date.
--
-- Which rows: the Jobs team's applications (source_type Pursuit_referred or
-- staff_sourced) with an empty history. On 2026-10-07 that was 52 rows: 27
-- created since 9/29 and 25 never touched, 10 of them at interview and 5 at
-- accepted. Builders' self-reported applications are the platform's and aren't
-- touched.
--
-- The entry is the platform's shape plus Bedrock's changed_by (null: nobody is
-- recorded), with notes saying where it came from. created_at is UTC (the
-- database's zone); the date is the New York day.
--
-- Reversible: the backfilled entries are the only ones with this note.
--   UPDATE public.job_applications SET stage_history = '[]'::jsonb
--    WHERE stage_history @> '[{"notes": "Backfilled from created_at (PRO-117)"}]'
--      AND jsonb_array_length(stage_history) = 1;
--
--     python -m scripts.apply_sql migrations/2026-10-07-job-application-creation-history.sql
UPDATE public.job_applications
   SET stage_history = jsonb_build_array(jsonb_build_object(
         'date', to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'),
         'stage', stage,
         'notes', 'Backfilled from created_at (PRO-117)',
         'changed_by', NULL))
 WHERE source_type IN ('Pursuit_referred', 'staff_sourced')
   AND airtable_id IS NULL
   AND jsonb_array_length(coalesce(stage_history, '[]'::jsonb)) = 0
   AND ((created_at AT TIME ZONE 'UTC') >= TIMESTAMPTZ '2026-09-29 00:00 America/New_York'
        OR updated_at - created_at < interval '1 minute');

-- Verify (0 after; the rows left are the unprovable ones):
--   SELECT count(*) FROM public.job_applications
--    WHERE source_type IN ('Pursuit_referred', 'staff_sourced') AND airtable_id IS NULL
--      AND jsonb_array_length(coalesce(stage_history, '[]'::jsonb)) = 0
--      AND ((created_at AT TIME ZONE 'UTC') >= TIMESTAMPTZ '2026-09-29 00:00 America/New_York'
--           OR updated_at - created_at < interval '1 minute');
