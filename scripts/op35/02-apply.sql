-- Operation 35 — Pursuit · P1 + P2 tagging  ·  APPLY
-- Usage:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v owner=you@pursuit.org \
--              -f scripts/op35/02-apply.sql
--
-- Run 01-preview.sql first and read its output.
--
-- Purely additive. This script never removes or rewrites an existing tag, never
-- changes an existing jobs_account row, and never overwrites an existing
-- pipeline stage. Re-running it is a no-op.
-- No DDL outside the ON COMMIT DROP temp table.

\set ON_ERROR_STOP on
\if :{?owner}
\else
  \set owner 'kwame@pursuit.org'
\endif

BEGIN;

\i scripts/op35/_targets.sql

-- ── Guard ────────────────────────────────────────────────────────────────────
-- Abort if any contact_id no longer resolves to the person it was resolved to.
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
   SET tags = coalesce(c.tags,'{}'::text[]) || 'operation_35_pursuit',
       updated_at = now()
  FROM op35_targets t
 WHERE c.contact_id = t.contact_id
   AND NOT ('operation_35_pursuit' = ANY(coalesce(c.tags,'{}'::text[])));

-- ── 2 · Mark as jobs contacts (1,241 of 1,242 existing members have this) ────
UPDATE public.contacts c
   SET is_jobs_contact = true,
       updated_at = now()
  FROM op35_targets t
 WHERE c.contact_id = t.contact_id
   AND coalesce(c.is_jobs_contact,false) = false;

-- ── 3 · Employer accounts in the jobs pipeline ───────────────────────────────
-- Every key below was checked against all 277 existing jobs_account rows
-- (exact + substring on key and display_name) — no near-duplicates exist.
INSERT INTO bedrock.jobs_account (account_key, display_name, owner_email, notes)
SELECT DISTINCT t.account_key, t.display_name, :'owner',
       'Added by Operation 35 — Pursuit coverage audit, 2026-08-26'
  FROM op35_targets t
ON CONFLICT (account_key) DO NOTHING;   -- existing accounts untouched

-- ── 4 · Contact pipeline membership ──────────────────────────────────────────
INSERT INTO bedrock.jobs_contact_membership
       (contact_id, stage, owner_email, activation_reason, activation_note,
        assigned_by, assigned_at, updated_at)
SELECT t.contact_id, 'assigned', :'owner', 'strategic',
       'Operation 35 — Pursuit ' || t.tier || ' (' || t.account || '), coverage audit 2026-08-26',
       :'owner', now(), now()
  FROM op35_targets t
ON CONFLICT (contact_id) DO NOTHING;    -- existing stages never overwritten

-- ── Verification ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== RESULT · every target should read tagged=t, jobs=t, and have a stage ==='
SELECT t.tier, t.account, c.full_name,
       ('operation_35_pursuit' = ANY(c.tags)) AS tagged,
       c.is_jobs_contact AS jobs,
       m.stage AS pipeline_stage,
       (ja.account_key IS NOT NULL) AS acct
FROM op35_targets t
JOIN public.contacts c ON c.contact_id = t.contact_id
LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = t.contact_id
LEFT JOIN bedrock.jobs_account ja ON ja.account_key = t.account_key
ORDER BY t.tier, t.account;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM op35_targets t
  JOIN public.contacts c ON c.contact_id = t.contact_id
  LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = t.contact_id
  LEFT JOIN bedrock.jobs_account ja ON ja.account_key = t.account_key
  WHERE NOT ('operation_35_pursuit' = ANY(coalesce(c.tags,'{}')))
     OR coalesce(c.is_jobs_contact,false) = false
     OR m.contact_id IS NULL
     OR ja.account_key IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Aborting: % target(s) did not end in the expected state.', bad;
  END IF;
  RAISE NOTICE 'All 30 targets tagged, flagged, accounted and in the pipeline.';
END $$;

\echo ''
\echo '=== total operation_35_pursuit contacts after this run (was 89) ==========='
SELECT count(*) AS operation_35_pursuit_total
FROM public.contacts WHERE 'operation_35_pursuit' = ANY(tags);

COMMIT;
\echo ''
\echo 'Committed.'
