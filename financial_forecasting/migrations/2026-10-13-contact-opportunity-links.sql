-- PRO-101 part 2 (D15): converted contacts point to their opportunity, and
-- each opportunity lists the contacts that converted to it.
--
-- On 2026-10-13, 23 of 139 converted contacts had an opportunity_id, and 6 of
-- 57 open opportunities had a contact list. From now on the app writes both
-- sides on every conversion (PATCH /contacts/{id}/jobs-membership requires the
-- opportunity). This fills in what it can for the past, and only where there is
-- exactly one answer. Nothing is guessed:
--
--   1. A converted contact with no opportunity that is on exactly ONE
--      opportunity's contact list (by pub:, airtable: or Salesforce id)
--      converted to that one, even if it was lost since (9 on 10/13).
--   2. Otherwise, one with exactly ONE live opportunity at its account (same
--      name, not closed lost) converted to that one (25 on 10/13).
--   3. Every contact an opportunity was converted from is on its contact list
--      (pub:<contact_id>), unless it is already there under another ref.
--
-- Left for a person (82 on 10/13): converted contacts with two or more
-- candidate opportunities, or none at an account of the same name (often a
-- duplicate account spelling, PRO-101 part 5). List them with:
--   SELECT m.contact_id, c.full_name, c.current_company, m.converted_at
--     FROM bedrock.jobs_contact_membership m JOIN public.contacts c USING (contact_id)
--    WHERE m.stage = 'converted_to_opportunity' AND m.opportunity_id IS NULL;
-- (run after this file). Converting one again in the app opens the picker.
--
-- Every change is recorded in bedrock.data_fix_audit (ticket 'PRO-101', note
-- 'contact-opportunity-links'), which this file creates if it isn't there.
-- updated_at is left alone (its trigger is off for that one UPDATE, inside the
-- transaction), so the lists sorted by it don't reshuffle. To undo:
--   UPDATE bedrock.jobs_contact_membership m SET opportunity_id = NULL
--     FROM bedrock.data_fix_audit d
--    WHERE d.ticket = 'PRO-101' AND d.note = 'contact-opportunity-links'
--      AND d.field = 'opportunity_id' AND m.contact_id = d.row_key::int;
--   UPDATE bedrock.jobs_opportunity o SET sf_contact_ids = array_remove(o.sf_contact_ids, d.new_value)
--     FROM bedrock.data_fix_audit d
--    WHERE d.ticket = 'PRO-101' AND d.note = 'contact-opportunity-links'
--      AND d.field = 'sf_contact_ids' AND o.id = d.row_key::uuid;
--
--     python -m scripts.apply_sql migrations/2026-10-13-contact-opportunity-links.sql

BEGIN;

-- What a data fix changed, so it can be reviewed and undone (PRO-101 and the
-- account merges after it).
CREATE TABLE IF NOT EXISTS bedrock.data_fix_audit (
    id          bigserial PRIMARY KEY,
    ticket      text NOT NULL,
    note        text NOT NULL,
    entity      text NOT NULL,        -- table changed
    row_key     text NOT NULL,        -- that row's key, as text
    field       text NOT NULL,
    old_value   text,
    new_value   text,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE pro101_link ON COMMIT DROP AS
WITH conv AS (
    SELECT m.contact_id, c.airtable_id, lower(btrim(c.current_company)) AS k,
           ARRAY(SELECT scl.sf_contact_id FROM bedrock.sf_contact_link scl
                  WHERE scl.public_contact_id = m.contact_id) AS sf_ids
      FROM bedrock.jobs_contact_membership m
      JOIN public.contacts c USING (contact_id)
     WHERE m.stage = 'converted_to_opportunity' AND m.opportunity_id IS NULL
),
live AS (
    SELECT o.id, lower(btrim(o.account_name)) AS k
      FROM bedrock.jobs_opportunity o
     WHERE o.deleted_at IS NULL AND o.stage <> 'closed_lost' AND o.stage NOT LIKE 'on_hold%'
),
listed AS (
    SELECT cv.contact_id, (array_agg(o.id))[1] AS opp_id, count(*) AS n
      FROM conv cv JOIN bedrock.jobs_opportunity o
        ON o.deleted_at IS NULL
       AND (('pub:' || cv.contact_id) = ANY(o.sf_contact_ids)
            OR ('airtable:' || cv.airtable_id) = ANY(o.sf_contact_ids)
            OR o.sf_contact_ids && cv.sf_ids)
     GROUP BY cv.contact_id
),
at_account AS (
    SELECT cv.contact_id, (array_agg(l.id))[1] AS opp_id, count(*) AS n
      FROM conv cv JOIN live l ON l.k = cv.k
     WHERE cv.k <> ''
     GROUP BY cv.contact_id
)
SELECT cv.contact_id,
       CASE WHEN li.n = 1 THEN li.opp_id
            WHEN li.n IS NULL AND aa.n = 1 THEN aa.opp_id END AS opp_id
  FROM conv cv
  LEFT JOIN listed li USING (contact_id)
  LEFT JOIN at_account aa USING (contact_id);

DELETE FROM pro101_link WHERE opp_id IS NULL;

-- 1-2. The contact side.
INSERT INTO bedrock.data_fix_audit (ticket, note, entity, row_key, field, old_value, new_value)
SELECT 'PRO-101', 'contact-opportunity-links', 'jobs_contact_membership',
       contact_id::text, 'opportunity_id', NULL, opp_id::text
  FROM pro101_link;

UPDATE bedrock.jobs_contact_membership m
   SET opportunity_id = l.opp_id
  FROM pro101_link l
 WHERE m.contact_id = l.contact_id AND m.opportunity_id IS NULL;

-- 3. The opportunity side, for every link (old and new): a pub: ref for each
-- converted contact the list doesn't already name by any ref.
CREATE TEMP TABLE pro101_list ON COMMIT DROP AS
SELECT m.opportunity_id, 'pub:' || m.contact_id AS ref
  FROM bedrock.jobs_contact_membership m
  JOIN bedrock.jobs_opportunity o ON o.id = m.opportunity_id AND o.deleted_at IS NULL
  JOIN public.contacts c ON c.contact_id = m.contact_id
 WHERE NOT (('pub:' || m.contact_id) = ANY(coalesce(o.sf_contact_ids, '{}')))
   AND NOT (c.airtable_id IS NOT NULL AND ('airtable:' || c.airtable_id) = ANY(coalesce(o.sf_contact_ids, '{}')))
   AND NOT (coalesce(o.sf_contact_ids, '{}') && ARRAY(
        SELECT scl.sf_contact_id FROM bedrock.sf_contact_link scl WHERE scl.public_contact_id = m.contact_id));

INSERT INTO bedrock.data_fix_audit (ticket, note, entity, row_key, field, old_value, new_value)
SELECT 'PRO-101', 'contact-opportunity-links', 'jobs_opportunity',
       opportunity_id::text, 'sf_contact_ids', NULL, ref
  FROM pro101_list;

ALTER TABLE bedrock.jobs_opportunity DISABLE TRIGGER trg_jobs_opportunity_updated_at;
UPDATE bedrock.jobs_opportunity o
   SET sf_contact_ids = coalesce(o.sf_contact_ids, '{}') || add.refs
  FROM (SELECT opportunity_id, array_agg(ref ORDER BY ref) AS refs
          FROM pro101_list GROUP BY opportunity_id) add
 WHERE o.id = add.opportunity_id;
ALTER TABLE bedrock.jobs_opportunity ENABLE TRIGGER trg_jobs_opportunity_updated_at;

COMMIT;

-- Verify (after): what changed (34 contacts expected on 10/13 data) and that
-- every link now reads from both sides (0):
--   SELECT entity, field, count(*) FROM bedrock.data_fix_audit
--    WHERE ticket = 'PRO-101' AND note = 'contact-opportunity-links' GROUP BY 1, 2;
--   SELECT count(*) FROM bedrock.jobs_contact_membership m
--     JOIN bedrock.jobs_opportunity o ON o.id = m.opportunity_id
--     JOIN public.contacts c ON c.contact_id = m.contact_id
--    WHERE NOT (('pub:' || m.contact_id) = ANY(coalesce(o.sf_contact_ids, '{}'))
--               OR ('airtable:' || c.airtable_id) = ANY(coalesce(o.sf_contact_ids, '{}'))
--               OR coalesce(o.sf_contact_ids, '{}') && ARRAY(SELECT sf_contact_id FROM bedrock.sf_contact_link
--                                                            WHERE public_contact_id = m.contact_id));
