-- ─────────────────────────────────────────────────────────────────────────────
-- Operation 35 — Pursuit: tag + comment the contacts David Yang marked on the
-- Pursuit Network tab (2026-08-24, 15:42-15:59 UTC).
--
-- PART A of 2. This part covers everything the jobs_dev / jobs_team role is
-- actually granted to write:
--   1. appends the 'operation_35_pursuit' tag                  (additive only)
--   2. sets public.contacts.is_jobs_contact = true             (jobs prospect)
--   3. adds the team comment on the contact
--
-- PART B — the pipeline membership row and its stage-history entry — is NOT
-- here, because jobs_team holds SELECT only on
-- bedrock.jobs_contact_membership and bedrock.jobs_membership_stage_history.
-- Attempting it in this script would fail and roll back the whole transaction.
-- Run part B through the app instead (the backend connects as bedrock_user):
--
--   POST /api/jobs/contacts/flag-jobs   {"contact_ids": [...]}
--
-- See db/scripts/op35-pursuit-dy-relationships-partB.sh. That endpoint writes
-- the membership, the stage history AND is_jobs_contact via the app's own
-- _flag_contacts path, so it is the canonical way to do this half.
--
-- WHAT THIS DOES NOT DO — by construction, not by luck:
--   * never removes or reorders an existing tag (pure array append). Note this
--     is deliberately NOT the PATCH /contacts/{id} behaviour, which REPLACES
--     the curated tag set — that would drop tags if a payload were incomplete.
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
-- NOTE ON GUARDS: the pre/post-condition checks cast a descriptive message to
-- int on failure, which aborts the transaction and prints the message. That is
-- deliberate rather than a DO block — psql does NOT substitute :variables
-- inside dollar-quoted strings, so a DO block cannot see :ids.
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on
\timing off

-- ── Edit here and nowhere else ───────────────────────────────────────────────
-- The 16 contacts David marked on the Pursuit Network tab. The four marked (n)
-- got a note from him but no thumbs/hiring-fit rating — delete them from this
-- list if you only want the 12 he actually rated. Keep this list identical to
-- the CONTACT_IDS in the part B script.
\set ids '882,2210,7169,16563,16711,22827,34154,34424,34665,34776,35409,36976,42712,45526,37729,45230'
--   882 Kalila Hoggard   16711 My Chang       34424 Justin Le      35409 Josh Goldberg
--  2210 Greg Levin  (n)  22827 Andrew Cone    34665 orta therox    36976 Erica Jain
--  7169 Bernie Mehl (n)  34154 Daniel Chait   34776 Jeff Byrnes    42712 Neil Daftary
-- 16563 Emma Pfohman     45526 Howie Liu      37729 Zainab Ebrahimi (n)
--                                             45230 Barry McCarthy  (n)

\set actor   'kwame@pursuit.org'
\set tag     'operation_35_pursuit'
\set comment 'Tagged for Operation 35 Outreach based on DY Pursuit Relationship'

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
   SET tags = coalesce(tags, '{}') || ARRAY[:'tag'], updated_at = now()
 WHERE contact_id = ANY(ARRAY[:ids]::int[])
   AND NOT (:'tag' = ANY(coalesce(tags, '{}')));

-- 2 ── Jobs prospect flag. Part B sets this too (harmless either way); doing it
--      here means the tag and the flag land together even if B is delayed.
\echo '--- 2. is_jobs_contact ---'
UPDATE public.contacts
   SET is_jobs_contact = true, updated_at = now()
 WHERE contact_id = ANY(ARRAY[:ids]::int[])
   AND NOT is_jobs_contact;

-- 3 ── Comment. Insert-only, skipped where the identical comment already sits
--      on the contact, so re-running never duplicates.
\echo '--- 3. comment ---'
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
       coalesce(m.stage,'(part B)') AS stage,
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
\echo '>>> APPLYING - committing part A.'
\echo '>>> Next: run db/scripts/op35-pursuit-dy-relationships-partB.sh for the pipeline rows.'
COMMIT;
\else
\echo '>>> DRY RUN - everything above ran for real, now rolling back.'
\echo '>>> Re-run with  -v apply=1  to commit.'
ROLLBACK;
\endif
