-- PRO-102: when a call was booked, separate from when it was held.
--
-- Nick's KPI is 10-12 discovery calls a week, counted by when each call was
-- BOOKED (Nina 2026-10-07). activity_date stays the day the call was held, as
-- for every other activity; booked_at is the day it was booked.
--
-- Nullable with no default and no backfill: a call logged before this, and
-- every calendar meeting, has no booking date anyone recorded. Counting falls
-- back to the held date for those (services/outreach_counting.events_sql), so
-- NULL reads as "booked the day it was held" rather than inventing a date.
--
-- No index. Calls are read by who logged them and their type, a few hundred
-- rows, and an index build would scan the whole 2 GB table for nothing.
--
--     python -m scripts.apply_sql migrations/2026-10-07-activity-booked-at.sql
ALTER TABLE bedrock.activity ADD COLUMN IF NOT EXISTS booked_at timestamptz;

-- Verify:
--   SELECT count(*) FILTER (WHERE booked_at IS NOT NULL) FROM bedrock.activity WHERE type = 'call';
