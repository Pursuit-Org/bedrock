-- Operation 35 — Pursuit · P1 + P2 tagging  ·  PREVIEW (read-only)
-- Usage:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/op35/01-preview.sql
--
-- Runs inside a transaction that is ROLLED BACK. Nothing is written.
-- Shows exactly what 02-apply.sql will change.

\set ON_ERROR_STOP on
BEGIN;

\i scripts/op35/_targets.sql

\echo ''
\echo '=== GUARD · contact_id must still resolve to the expected person ==========='
SELECT t.tier, t.account, t.contact_id, t.expect_name,
       c.full_name AS actual_name,
       CASE WHEN c.contact_id IS NULL THEN 'MISSING'
            WHEN c.full_name IS DISTINCT FROM t.expect_name THEN 'NAME MOVED'
            ELSE 'ok' END AS check
FROM op35_targets t LEFT JOIN public.contacts c ON c.contact_id = t.contact_id
WHERE c.contact_id IS NULL OR c.full_name IS DISTINCT FROM t.expect_name;
\echo '(zero rows above = all 30 contacts resolve cleanly)'

\echo ''
\echo '=== 1 · TAG · contacts that will gain operation_35_pursuit ================='
SELECT t.tier, t.account, c.contact_id, c.full_name, c.current_title,
       coalesce(c.tags,'{}') AS tags_before,
       coalesce(c.tags,'{}') || 'operation_35_pursuit' AS tags_after
FROM op35_targets t JOIN public.contacts c ON c.contact_id = t.contact_id
WHERE NOT ('operation_35_pursuit' = ANY(coalesce(c.tags,'{}')))
ORDER BY t.tier, t.account;

\echo ''
\echo '=== 1b · already tagged · will be left untouched ==========================='
SELECT t.account, c.full_name, c.tags
FROM op35_targets t JOIN public.contacts c ON c.contact_id = t.contact_id
WHERE 'operation_35_pursuit' = ANY(coalesce(c.tags,'{}'))
ORDER BY t.account;

\echo ''
\echo '=== 2 · FLAG · contacts that will get is_jobs_contact = true ==============='
SELECT t.account, c.contact_id, c.full_name
FROM op35_targets t JOIN public.contacts c ON c.contact_id = t.contact_id
WHERE coalesce(c.is_jobs_contact,false) = false
ORDER BY t.account;

\echo ''
\echo '=== 3 · JOBS ACCOUNTS · new bedrock.jobs_account rows to be created ========'
SELECT DISTINCT t.account_key, t.display_name
FROM op35_targets t
WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_account ja WHERE ja.account_key = t.account_key)
ORDER BY 1;

\echo ''
\echo '=== 3b · jobs accounts that already exist · untouched ======================'
SELECT ja.account_key, ja.display_name, ja.owner_email
FROM op35_targets t JOIN bedrock.jobs_account ja ON ja.account_key = t.account_key
ORDER BY 1;

\echo ''
\echo '=== 4 · PIPELINE · new jobs_contact_membership rows (stage = assigned) ====='
SELECT t.tier, t.account, t.contact_id, c.full_name
FROM op35_targets t JOIN public.contacts c ON c.contact_id = t.contact_id
WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = t.contact_id)
ORDER BY t.tier, t.account;

\echo ''
\echo '=== 4b · already in the pipeline · stage will NOT be overwritten ==========='
SELECT t.account, c.full_name, m.stage AS existing_stage, m.owner_email
FROM op35_targets t
JOIN public.contacts c ON c.contact_id = t.contact_id
JOIN bedrock.jobs_contact_membership m ON m.contact_id = t.contact_id
ORDER BY t.account;

\echo ''
\echo '=== SUMMARY ==============================================================='
SELECT
  (SELECT count(*) FROM op35_targets) AS targets,
  (SELECT count(*) FROM op35_targets t JOIN public.contacts c ON c.contact_id=t.contact_id
     WHERE NOT ('operation_35_pursuit' = ANY(coalesce(c.tags,'{}')))) AS tags_to_add,
  (SELECT count(*) FROM op35_targets t JOIN public.contacts c ON c.contact_id=t.contact_id
     WHERE coalesce(c.is_jobs_contact,false)=false) AS jobs_flags_to_set,
  (SELECT count(DISTINCT t.account_key) FROM op35_targets t
     WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_account ja WHERE ja.account_key=t.account_key)) AS accounts_to_create,
  (SELECT count(*) FROM op35_targets t
     WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id=t.contact_id)) AS memberships_to_create;

ROLLBACK;
\echo ''
\echo 'PREVIEW ONLY — transaction rolled back, nothing written.'
