-- PRO-102: hand-logged activity dated the day before it happened.
--
-- The jobs log forms send a bare date ("2026-09-18"). Until PRO-102 the API
-- stored it as midnight UTC, which in New York is 8pm the day BEFORE. A call
-- logged for Monday counted in the previous week, and Devika's 9/18 Mastercard
-- call read as 9/17, so it never matched the 9/18 calendar meeting it was.
-- The API now stores a bare date as midnight New York (routes/jobs.py
-- ActivityCreate). This moves the rows already written the old way.
--
-- Which rows: hand-logged jobs activity (on a jobs opportunity or a contact,
-- not Salesforce-linked) at exactly 00:00:00 UTC. On 2026-10-07 that was 170
-- rows: 41 calls, 59 emails, 44 LinkedIn, 26 texts. Nothing else is written at
-- exactly midnight UTC; a log with no date gets the time it was saved.
--
-- What moves: each row's weekday in New York, so some activity changes week on
-- the Outreach tab (a Monday log moves from the week before into its own week).
-- That is the correction, but reported past weeks can shift by a few rows.
--
-- Not cleanly reversible: afterwards these rows look like ones logged at
-- midnight New York to begin with. Keep the ids if you may need to undo:
--   SELECT id, activity_date FROM bedrock.activity WHERE <the WHERE below>;
--
--     python -m scripts.apply_sql migrations/2026-10-07-activity-manual-dates-ny.sql
UPDATE bedrock.activity
   SET activity_date = (activity_date AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'America/New_York'
 WHERE source = 'manual'
   AND type IN ('call', 'email', 'linkedin', 'text')
   AND (jobs_opportunity_id IS NOT NULL OR participant_public_contact_id IS NOT NULL)
   AND opportunity_id IS NULL AND account_id IS NULL
   AND activity_date = (activity_date AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC';

-- Verify (0 after):
--   SELECT count(*) FROM bedrock.activity
--    WHERE source = 'manual' AND type IN ('call', 'email', 'linkedin', 'text')
--      AND activity_date = (activity_date AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC';
