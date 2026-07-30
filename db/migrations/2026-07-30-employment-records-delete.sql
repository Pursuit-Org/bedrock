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

-- One-off: Sam MacFarlane's duplicate RBM Maintenance placement. The 2026-07-27
-- modal-then-hire sequence created er 91 with no dedup guard, then the hire flow
-- created er 97 and linked it to jobs_role "AI Builder" (contract). Both now read
-- contract, so the FT count is right but he is double-counted in contract
-- placements. 97 is canonical (it holds the role link); 91 is the orphan.
-- The guard clauses re-prove that at run time — same user, same opportunity,
-- no role points at 91, and a sibling record does hold the role link.
DELETE FROM public.employment_records er
WHERE er.id = 91
  AND er.company_name = 'RBM Maintenance'
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_role r WHERE r.employment_record_id = er.id)
  AND EXISTS (SELECT 1 FROM public.employment_records k
              JOIN bedrock.jobs_role r ON r.employment_record_id = k.id
              WHERE k.id <> er.id
                AND k.user_id = er.user_id
                AND k.opportunity_id = er.opportunity_id);

COMMIT;
