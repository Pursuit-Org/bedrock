-- Call subtype on logged activity (Kwame, 2026-09-21).
--
-- "Total calls" on the Activity Pipeline is one number covering three very
-- different conversations. Splitting them lets the table break calls down by
-- what the call was FOR, which is the thing worth a target.
--
--   discovery  learning the employer's need
--   solution   presenting builders, scope or an option set against that need
--   general    everything else: intros, check-ins, relationship calls
--
-- Nullable with no default on purpose. Backfilling would rewrite history that
-- nobody classified; NULL stays honest about "logged before we tracked this".
-- The scorecard reads a NULL as `general`, which is the catch-all the team
-- already describes as "everything else" (Kwame 2026-09-21), so the three rows
-- always sum to Total Calls and no permanent Unclassified bucket accumulates.
-- Only the log-a-call form writes the column. Calls and meetings both count
-- toward Total Calls (they are one thing to this team), but a meeting synced
-- from a calendar has nobody to ask, so it stays NULL and reads as general.

ALTER TABLE bedrock.activity
  ADD COLUMN IF NOT EXISTS call_kind text
      CHECK (call_kind IS NULL OR call_kind IN ('discovery', 'solution', 'general'));

-- Partial index: the breakdown only ever filters classified calls, and the
-- column is null on the overwhelming majority of rows.
CREATE INDEX IF NOT EXISTS activity_call_kind_idx
    ON bedrock.activity (call_kind, activity_date)
 WHERE call_kind IS NOT NULL;

-- Verify:
--   SELECT call_kind, count(*) FROM bedrock.activity WHERE type='call' GROUP BY 1;
