-- Placement deletion (TKT-161): the app role could UPDATE but not DELETE
-- public.employment_records, so data-entry-error placements could never be
-- removed (Good Samaritan / Michelle Brooks). Grants the delete + removes the
-- known orphan. The new DELETE /api/jobs/placements/{id} endpoint requires
-- this grant; until applied it returns a clear error. Idempotent.

BEGIN;

GRANT DELETE ON public.employment_records TO bedrock_user;

-- One-off: the orphaned Good Samaritan record (its opportunity was deleted
-- 2026-07-22; the correct Samaritan Daytop Village record id 85 remains).
-- Tightly scoped: id + company + linked opp actually soft-deleted.
DELETE FROM public.employment_records er
WHERE er.id = 76
  AND er.company_name = 'Good Samaritan'
  AND EXISTS (SELECT 1 FROM bedrock.jobs_opportunity o
              WHERE o.id = er.opportunity_id AND o.deleted_at IS NOT NULL);

COMMIT;
