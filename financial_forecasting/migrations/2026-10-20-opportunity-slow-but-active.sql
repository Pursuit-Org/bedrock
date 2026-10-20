-- PRO-110: an owner can mark an opportunity "slow but active" (Avni, 10/2).
--
-- Some opportunities go 4+ weeks without jobs-related activity and are still
-- alive: enterprise hiring cycles, Pharma Logistics. Under the stalled rule
-- (D3: 4 weeks on an opportunity) they would read as Stalled on the Thursday
-- Pipeline view. The owner marks them instead, and must say why and when to
-- look again. When the check-again date passes and there is still no activity,
-- the opportunity reads as Stalled again, with the old reason shown.
--
--   slow_reason       why it is slow but alive (required with the date)
--   slow_check_again  when to look again; after it, the mark lapses
--   slow_marked_by    who set it (the app writes the signed-in email)
--   slow_marked_at    when it was set
--
-- Nullable, no backfill: nobody has marked anything yet. The reason and the
-- date are set and cleared together (the check below); the API also refuses a
-- blank reason or a date in the past.
--
-- The app probes for these columns per request (_has_column), so the field on
-- the opportunity page and the Slow but active list light up as soon as this
-- runs. No restart needed. Before it runs, saving the mark returns 409 naming
-- this file.
--
-- Run: python -m scripts.apply_sql migrations/2026-10-20-opportunity-slow-but-active.sql
--
-- To undo:
--   ALTER TABLE bedrock.jobs_opportunity
--     DROP CONSTRAINT IF EXISTS jobs_opportunity_slow_together,
--     DROP COLUMN IF EXISTS slow_reason, DROP COLUMN IF EXISTS slow_check_again,
--     DROP COLUMN IF EXISTS slow_marked_by, DROP COLUMN IF EXISTS slow_marked_at;

BEGIN;

ALTER TABLE bedrock.jobs_opportunity
  ADD COLUMN IF NOT EXISTS slow_reason text,
  ADD COLUMN IF NOT EXISTS slow_check_again date,
  ADD COLUMN IF NOT EXISTS slow_marked_by text,
  ADD COLUMN IF NOT EXISTS slow_marked_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_opportunity_slow_together') THEN
    ALTER TABLE bedrock.jobs_opportunity
      ADD CONSTRAINT jobs_opportunity_slow_together
      CHECK ((slow_reason IS NULL) = (slow_check_again IS NULL)
             AND (slow_reason IS NULL OR btrim(slow_reason) <> ''));
  END IF;
END $$;

COMMIT;

-- Verify (0 marked right after it runs):
--   SELECT count(*) FILTER (WHERE slow_reason IS NOT NULL) AS marked,
--          count(*) FILTER (WHERE slow_check_again < current_date) AS lapsed
--   FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL;
