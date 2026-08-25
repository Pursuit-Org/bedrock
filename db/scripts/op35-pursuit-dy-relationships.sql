-- ─────────────────────────────────────────────────────────────────────────────
-- Operation 35 — Pursuit: tag + pipeline the contacts David Yang marked on the
-- Pursuit Network tab (2026-08-24, 15:42-15:59 UTC).
--
-- WHAT THIS DOES, per contact:
--   1. appends the 'operation_35_pursuit' tag                  (additive only)
--   2. sets public.contacts.is_jobs_contact = true             (jobs prospect)
--   3. writes the jobs_membership_stage_history row            (new members only)
--   4. creates a bedrock.jobs_contact_membership row @ 'assigned'
--   5. adds the team comment on the contact
--
-- WHAT THIS DOES NOT DO — by construction, not by luck:
--   * never removes or reorders an existing tag (pure array append)
--   * never downgrades an existing pipeline stage. Step 4 deliberately omits
--     "stage = EXCLUDED.stage" from its ON CONFLICT, mirroring the app's plain
--     "flag" path (_flag_contacts with stage=None, routes/jobs.py:6318). So
--     My Chang stays 'converted_to_opportunity' and Greg Levin stays
--     'initial_outreach'; only contacts with NO membership row get 'assigned'.
--   * never edits or deletes an existing comment — only inserts, and only when
--     an identical comment is not already on the contact (re-runs are no-ops)
--   * no DDL. Nothing here creates, alters or drops anything.
--
-- SAFE BY DEFAULT: runs inside a transaction that ROLLS BACK unless you pass
-- -v apply=1. The dry run executes every statement for real and reports true
-- row counts, then discards the work.
--
--   dry run:  psql "$DATABASE_URL" -f db/scripts/op35-pursuit-dy-relationships.sql
--   apply:    psql "$DATABASE_URL" -f db/scripts/op35-pursuit-dy-relationships.sql -v apply=1
--
-- NOTE ON GUARDS: the pre/post-condition checks below cast a descriptive
-- message to int on failure, which aborts the transaction and prints the
-- message. That is deliberate rather than a DO block — psql does NOT substitute
-- :variables inside dollar-quoted strings, so a DO block cannot see :ids.
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on
\timing off

-- ── Edit here and nowhere else ───────────────────────────────────────────────
-- The 16 contacts David marked on the Pursuit Network tab. The last four got a
-- note from him but no thumbs/hiring-fit rating — delete them from this list if
-- you only want the 12 he actually rated.
\set ids '882,2210,7169,16563,16711,22827,34154,34424,34665,34776,35409,36976,42712,45526,37729,45230'
--   882 Kalila Hoggard   16711 My Chang       34424 Justin Le      35409 Josh Goldberg
--  2210 Greg Levin  (n)  22827 Andrew Cone    34665 orta therox    36976 Erica Jain
--  7169 Bernie Mehl (n)  34154 Daniel Chait   34776 Jeff Byrnes    42712 Neil Daftary
-- 16563 Emma Pfohman     45526 Howie Liu      37729 Zainab Ebrahimi (n)
--                                             45230 Barry McCarthy  (n)
--                                             (n) = note only, no rating

\set actor   'kwame@pursuit.org'
\set tag     'operation_35_pursuit'
\set comment 'Tagged for Operation 35 Outreach based on DY Pursuit Relationship'
\set actnote 'Operation 35 - Pursuit. Sourced from DY Pursuit Network review, 2026-08-24.'

BEGIN;

\echo ''
\echo '=== BEFORE ==================================================================='
SELECT c.contact_id, c.full_name, c.current_company,
       (:'tag' = ANY(coalesce(c.tags,'{}'))) AS has_tag,
       c.is_jobs_contact,
       coalesce(m.stage, '(none)') AS stage
  FROM public.contacts c
  LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = c.contact_id
 WHERE c.contact_id = ANY(ARRAY[:ids]::int[])
 ORDER BY c.full_name;

-- Pre-condition: every id resolves to a live, unmerged contact. A silently
-- dropped id would look like success while doing nothing.
\echo '--- guard: all target ids resolve ---'
SELECT CASE WHEN count(*) > 0
            THEN ('ABORT: ' || count(*) || ' target id(s) missing or merged')::int
       END AS guard_ids_resolve
  FROM unnest(ARRAY[:ids]::int[]) AS cid
 WHERE NOT EXISTS (SELECT 1 FROM public.contacts c
                    WHERE c.contact_id = cid
                      AND coalesce(c.contact_stage,'') <> 'merged');

-- 1 ── Tag. Pure append: existing tags keep their values AND their order.
\echo '--- 1. tag: operation_35_pursuit ---'
UPDATE public.contacts
   SET tags = coalesce(tags, '{}') || ARRAY[:'tag']
 WHERE contact_id = ANY(ARRAY[:ids]::int[])
   AND NOT (:'tag' = ANY(coalesce(tags, '{}')));

-- 2 ── Jobs prospect flag (mirrors routes/jobs.py:6380).
\echo '--- 2. is_jobs_contact ---'
UPDATE public.contacts
   SET is_jobs_contact = true
 WHERE contact_id = ANY(ARRAY[:ids]::int[])
   AND NOT is_jobs_contact;

-- 3 ── Stage history FIRST, while "which memberships are new" is still knowable.
\echo '--- 3. stage history (new memberships only) ---'
INSERT INTO bedrock.jobs_membership_stage_history (contact_id, from_stage, to_stage, changed_by, note)
SELECT cid, NULL, 'assigned', :'actor', :'actnote'
  FROM unnest(ARRAY[:ids]::int[]) AS cid
 WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = cid);

-- 4 ── Membership. No "stage = EXCLUDED.stage" on conflict, so existing stages
--      are preserved exactly. New rows enter the pipeline at 'assigned'.
\echo '--- 4. pipeline membership ---'
INSERT INTO bedrock.jobs_contact_membership
    (contact_id, stage, owner_email, activation_reason, activation_note, assigned_by)
SELECT cid, 'assigned', :'actor', 'manual', :'actnote', :'actor'
  FROM unnest(ARRAY[:ids]::int[]) AS cid
ON CONFLICT (contact_id) DO UPDATE SET
    owner_email       = COALESCE(jobs_contact_membership.owner_email, EXCLUDED.owner_email),
    activation_reason = COALESCE(jobs_contact_membership.activation_reason, EXCLUDED.activation_reason),
    updated_at        = now();

-- 5 ── Comment. Insert-only, skipped where the identical comment already sits
--      on the contact, so re-running never duplicates.
\echo '--- 5. comment ---'
INSERT INTO bedrock.jobs_comment (parent_type, parent_id, author_email, content)
SELECT 'prospect', cid::text, :'actor', :'comment'
  FROM unnest(ARRAY[:ids]::int[]) AS cid
 WHERE NOT EXISTS (
        SELECT 1 FROM bedrock.jobs_comment jc
         WHERE jc.parent_type = 'prospect'
           AND jc.parent_id   = cid::text
           AND jc.content     = :'comment');

\echo ''
\echo '=== AFTER ===================================================================='
SELECT c.contact_id, c.full_name,
       (:'tag' = ANY(coalesce(c.tags,'{}'))) AS has_tag,
       c.is_jobs_contact,
       m.stage,
       array_to_string(c.tags, ', ') AS all_tags,
       (SELECT count(*) FROM bedrock.jobs_comment jc
         WHERE jc.parent_type='prospect' AND jc.parent_id = c.contact_id::text
           AND jc.content = :'comment') AS op35_comments
  FROM public.contacts c
  LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id = c.contact_id
 WHERE c.contact_id = ANY(ARRAY[:ids]::int[])
 ORDER BY c.full_name;

-- Post-conditions. Any failure aborts the whole transaction.
\echo '--- guard: every contact tagged ---'
SELECT CASE WHEN count(*) > 0
            THEN ('ABORT: ' || count(*) || ' contact(s) did not get the tag')::int
       END AS guard_tagged
  FROM public.contacts
 WHERE contact_id = ANY(ARRAY[:ids]::int[])
   AND NOT (:'tag' = ANY(coalesce(tags,'{}')));

\echo '--- guard: every contact is a jobs prospect ---'
SELECT CASE WHEN count(*) > 0
            THEN ('ABORT: ' || count(*) || ' contact(s) are not jobs prospects')::int
       END AS guard_prospect
  FROM public.contacts
 WHERE contact_id = ANY(ARRAY[:ids]::int[])
   AND NOT is_jobs_contact;

\echo '--- guard: every contact is in the pipeline ---'
SELECT CASE WHEN count(*) > 0
            THEN ('ABORT: ' || count(*) || ' contact(s) have no pipeline membership')::int
       END AS guard_membership
  FROM unnest(ARRAY[:ids]::int[]) AS cid
 WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = cid);

\echo '--- guard: exactly one Op35 comment each ---'
SELECT CASE WHEN count(*) > 0
            THEN ('ABORT: ' || count(*) || ' contact(s) have a wrong comment count')::int
       END AS guard_comment
  FROM unnest(ARRAY[:ids]::int[]) AS cid
 WHERE (SELECT count(*) FROM bedrock.jobs_comment jc
         WHERE jc.parent_type='prospect' AND jc.parent_id = cid::text
           AND jc.content = :'comment') <> 1;

\echo ''
\if :{?apply}
\echo '>>> APPLYING - committing.'
COMMIT;
\else
\echo '>>> DRY RUN - everything above ran for real, now rolling back.'
\echo '>>> Re-run with  -v apply=1  to commit.'
ROLLBACK;
\endif
