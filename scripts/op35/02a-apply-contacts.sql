-- Operation 35 — Pursuit · P1 + P2 · APPLY, contacts half only
-- Usage:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/op35/02a-apply-contacts.sql
--     or: python3 scripts/op35/run.py apply-contacts
--
-- Does steps 1 and 2 of 02-apply.sql — the parts that touch public.contacts,
-- where jobs_dev / avni_dev / damon_dev hold UPDATE:
--   1. add operation_35_pursuit to the 30 target contacts
--   2. set is_jobs_contact = true on them
--
-- It deliberately does NOT touch bedrock.jobs_account or
-- bedrock.jobs_contact_membership. Those are SELECT-only for every human role —
-- only bedrock_user (the app) and postgres can insert, because creating
-- employers and pipeline entries is supposed to go through the resolve-first
-- API. See README "Why the jobs half needs Jac".
--
-- Purely additive and idempotent: never removes or reorders an existing tag,
-- re-running is a no-op.

\set ON_ERROR_STOP on

BEGIN;

\i scripts/op35/_targets.sql

-- ── Guard ────────────────────────────────────────────────────────────────────
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM op35_targets t LEFT JOIN public.contacts c ON c.contact_id = t.contact_id
  WHERE c.contact_id IS NULL OR c.full_name IS DISTINCT FROM t.expect_name;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'Aborting: % target contact(s) no longer match the resolved name. Re-run 01-preview.sql.', bad;
  END IF;
END $$;

-- ── 1 · Add the tag (append-only; existing tags and their order preserved) ───
UPDATE public.contacts c
   SET tags = array_append(coalesce(c.tags,'{}'::text[]), 'operation_35_pursuit'::text),
       updated_at = now()
  FROM op35_targets t
 WHERE c.contact_id = t.contact_id
   AND NOT ('operation_35_pursuit' = ANY(coalesce(c.tags,'{}'::text[])));

-- ── 2 · Mark as jobs contacts ────────────────────────────────────────────────
UPDATE public.contacts c
   SET is_jobs_contact = true,
       updated_at = now()
  FROM op35_targets t
 WHERE c.contact_id = t.contact_id
   AND coalesce(c.is_jobs_contact,false) = false;

-- ── Verification ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== RESULT · every target should read tagged=t and jobs=t ================='
SELECT t.tier, t.account, c.full_name,
       ('operation_35_pursuit' = ANY(c.tags)) AS tagged,
       c.is_jobs_contact AS jobs
FROM op35_targets t
JOIN public.contacts c ON c.contact_id = t.contact_id
ORDER BY t.tier, t.account;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM op35_targets t
  JOIN public.contacts c ON c.contact_id = t.contact_id
  WHERE NOT ('operation_35_pursuit' = ANY(coalesce(c.tags,'{}'::text[])))
     OR coalesce(c.is_jobs_contact,false) = false;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Aborting: % target(s) did not end in the expected state.', bad;
  END IF;
  RAISE NOTICE 'All 30 targets tagged and flagged as jobs contacts.';
END $$;

\echo ''
\echo '=== total operation_35_pursuit contacts after this run (was 89) ==========='
SELECT count(*) AS operation_35_pursuit_total
FROM public.contacts WHERE 'operation_35_pursuit' = ANY(tags);

\echo ''
\echo '=== STILL OUTSTANDING · needs the grant from Jac, or the app API =========='
SELECT
  (SELECT count(DISTINCT t.account_key) FROM op35_targets t
     WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_account ja WHERE ja.account_key=t.account_key))
    AS jobs_accounts_to_create,
  (SELECT count(*) FROM op35_targets t
     WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id=t.contact_id))
    AS pipeline_rows_to_create;

COMMIT;
\echo ''
\echo 'Committed — contacts half only. Jobs pipeline still pending.'
