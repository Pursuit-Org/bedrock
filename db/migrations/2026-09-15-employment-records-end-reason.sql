-- Why a placement ended. `employment_records` already has `end_date` (1 row
-- populated today), but nothing records WHY a builder left, and the two
-- existing terminal stages don't carry it: 'completed' and 'ended' are both in
-- the CHECK constraint with no written definition, so a contract finishing its
-- term and someone being laid off look identical in the data.
--
-- Paired with PATCH /api/jobs/placements/{id}, which now takes engagement_stage
-- + end_date + these two fields and requires an end date on any move to a
-- terminal stage. That requirement is what eventually makes retention
-- measurable — today 62 of 76 start dates are import placeholders and there is
-- exactly one end date, so median tenure and "% still in role at 6/12 months"
-- are uncomputable (bedrock.dd_metrics #123, still in draft for this reason).
--
-- The API writes these two columns only when they exist (_has_column), so the
-- app is safe to deploy before this is applied — same pattern as the
-- jobs_opportunity.tags column. Idempotent.

BEGIN;

ALTER TABLE public.employment_records
  ADD COLUMN IF NOT EXISTS end_reason text,
  ADD COLUMN IF NOT EXISTS end_note   text;

-- Vocabulary kept deliberately small and neutral. People leave for good
-- reasons; the column exists to explain a number, not to grade anyone.
--   contract_ended — engagement ran its agreed term (the success case for
--                    contract/freelance work, and the usual pair for 'completed')
--   new_role       — left for another job
--   laid_off       — role eliminated / reduction
--   terminated     — let go by the employer
--   personal       — left for personal reasons
--   unknown        — not known (keeps the end date capturable without forcing a guess)
ALTER TABLE public.employment_records
  DROP CONSTRAINT IF EXISTS employment_records_end_reason_check;

ALTER TABLE public.employment_records
  ADD CONSTRAINT employment_records_end_reason_check
  CHECK (end_reason IS NULL OR end_reason IN (
    'contract_ended', 'new_role', 'laid_off', 'terminated', 'personal', 'unknown'));

COMMENT ON COLUMN public.employment_records.end_reason IS
  'Why the engagement ended. Set alongside end_date when engagement_stage moves '
  'to ''completed'' or ''ended''. NULL for active placements.';
COMMENT ON COLUMN public.employment_records.end_note IS
  'Optional free text accompanying end_reason — context a controlled vocabulary '
  'cannot carry. Not used in any metric.';

GRANT SELECT, UPDATE ON public.employment_records TO bedrock_user;

COMMIT;
