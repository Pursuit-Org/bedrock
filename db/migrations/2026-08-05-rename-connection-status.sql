-- Rename the My Network vote values to match the column label
-- Drafted 2026-08-05.
--
--   will_reach_out -> expect_response
--   declined       -> dont_expect_response
--   new            -> unchanged (means "no vote")
--
-- The column header went from "Your call" to "Willing to reach out" to
-- "Expect a response". The stored values still said will_reach_out/declined, so
-- the data and the UI no longer described the same thing. This aligns them.
--
-- DO NOT CONFUSE WITH bedrock.intro_request.status, which also has a 'declined'
-- value. That is a different table meaning a connector turned down an intro
-- request, and it is deliberately untouched here.
--
-- ORDER MATTERS, but only loosely: routes/jobs.py normalises legacy spellings on
-- both read and write (LEGACY_CONNECTION_STATUSES), so running this before or
-- after the code deploy is safe either way — there is no window where a recorded
-- vote reads as "no vote". Run it after the deploy if you want the tidier order.
--
-- Idempotent. Safe to run more than once. Reversible — the inverse UPDATE is at
-- the bottom, commented out.

BEGIN;

-- Expected before: 47 will_reach_out, 76 declined (123 rows, 2026-08-05).
-- 35 of the declined rows came from the old outreach tracker import and carry
-- reason='not interested — imported from old outreach tracker'; that reason is
-- preserved, only the status word changes.
UPDATE bedrock.connection_status
   SET status = 'expect_response'
 WHERE status = 'will_reach_out';

UPDATE bedrock.connection_status
   SET status = 'dont_expect_response'
 WHERE status = 'declined';

-- Guard: nothing should be left on the old vocabulary.
DO $$
DECLARE stale integer;
BEGIN
    SELECT count(*) INTO stale FROM bedrock.connection_status
     WHERE status IN ('will_reach_out', 'declined');
    IF stale > 0 THEN
        RAISE EXCEPTION 'still % rows on the old status vocabulary', stale;
    END IF;
END $$;

-- Guard: and nothing should have landed on an unknown value.
DO $$
DECLARE bad integer;
BEGIN
    SELECT count(*) INTO bad FROM bedrock.connection_status
     WHERE status NOT IN ('new', 'expect_response', 'dont_expect_response');
    IF bad > 0 THEN
        RAISE EXCEPTION '% rows have an unrecognised status', bad;
    END IF;
END $$;

COMMIT;

-- Once this has been applied and every client is redeployed, the
-- LEGACY_CONNECTION_STATUSES map in routes/jobs.py and the LEGACY_UP/LEGACY_DOWN
-- constants in JobsMyNetwork.tsx can be deleted.

-- ── rollback ────────────────────────────────────────────────────────────────
-- UPDATE bedrock.connection_status SET status='will_reach_out' WHERE status='expect_response';
-- UPDATE bedrock.connection_status SET status='declined'       WHERE status='dont_expect_response';
