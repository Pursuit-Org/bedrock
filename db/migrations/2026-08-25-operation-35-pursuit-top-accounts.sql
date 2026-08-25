-- Operation 35 — Pursuit: tag the most senior contact at the 30 highest-volume
-- historical hiring accounts (2026-08-25, requested by Kwame).
--
-- Input was a hire-count list: 30 companies that have hired 5+ Pursuit Builders,
-- Citi (51) down to a tail of five-hire accounts. For each, this file does three
-- things to ONE contact — the most senior person the CRM holds at that company:
--   1. adds the 'operation_35_pursuit' curated tag,
--   2. puts them in the jobs pipeline at stage 'assigned' (a prospect, in
--      pipeline, not yet contacted) and sets is_jobs_contact,
--   3. leaves a jobs comment recording WHY they were pulled in.
--
-- WHY A MIGRATION: the tag picker and PATCH /api/jobs/contacts/{id} can do this
-- one contact at a time in the UI, but this is a 29-row bulk edit across three
-- tables that has to land atomically and be re-runnable. Same reasoning as
-- 2026-07-23-tagged-into-pipeline.sql, which seeded the pipeline the same way.
--
-- HOW "MOST SENIOR" WAS PICKED. The seniority ladder in routes/jobs.py
-- (_seniority_case, itself ported from the "Prioritizing our employer prospect
-- list" doc) ranked every contact at each account, then each account's top of
-- the list was reviewed by hand. The ladder is tuned for banding a whole
-- network, not for picking a single winner, and it misfires in three ways that
-- mattered here — all corrected in the list below:
--   * 'owner' matches "Product Owner" / "Global Process Owner" / "P&L Owner"
--     and rated Blackstone analysts and Google ops staff 'Highest'. This is the
--     same false positive the _PRIORITY_SENIORITY_HEADCOUNT_WINDOW comment
--     already documents at 5,000+ headcount.
--   * 'ceo' matches "Head of External and CEO Communications" (Citizens Bank),
--     and 'founder' matches "Co-Founder, Microsoft Leap Apprenticeship Program"
--     — founding a programme, not the company.
--   * "Vice President" contains "President", so a divisional VP tied with an
--     actual company President.
-- Contacts were matched to an account by company_id AND by current_company text:
-- Thumbtack's CEO, Citi's Chief Diversity Officer and Moody's CDO all carry a
-- NULL company_id and would have been missed by an id-only join.
--
-- NOT COVERED — read this before assuming the campaign is 30/30:
--   * Intrepid Pursuits (6 hires) has NO contact in the CRM at all, under any
--     name spelling. Nothing to tag; it needs sourcing first.
--   * DeepMile (5 hires) has no record either; the row below is its parent
--     Comcast, which is a different account and may be the wrong target.
--   * AWS has no company row — its people hang off Amazon (company_id 754) and
--     are identified by current_company text. Amazon-at-large is deliberately
--     NOT treated as the AWS account.
--   * Twitter, Quil Health, Betterment and Hinge have no senior contact at all.
--     The "most senior" there is an Office Manager, an alum with no title on
--     file, an HR ops manager and an engineering director respectively. They are
--     tagged as asked, but they are not decision-makers and the account needs
--     real sourcing.
--   * Several titles are stale (Barry McCarthy left Peloton in 2024; Ben
--     Chestnut left Mailchimp; Reshma Saujani handed Girls Who Code to Tarika
--     Barrett). The CRM's record is what is tagged.
--
-- Idempotent, and deliberately NON-DESTRUCTIVE on every existing value:
--   * the tag is appended, never replacing the tag array;
--   * ON CONFLICT DO NOTHING on membership, so a contact already at
--     'initial_outreach' or 'not_a_fit' is NOT dragged back to 'assigned'
--     (Jukay Hsu is 'not_a_fit' — Pursuit does not prospect itself — and Chris
--     Wiggins and Jose Rodriguez are mid-outreach);
--   * the comment is skipped if an identical one is already on the contact.
-- Six of the 29 already carry the tag (Uber, Citi, Spotify x1, Blackstone);
-- for them this file only adds the pipeline row and the comment.

BEGIN;

CREATE TEMP TABLE op35_targets (contact_id int PRIMARY KEY, account text, hires int) ON COMMIT DROP;
INSERT INTO op35_targets (contact_id, account, hires) VALUES
  (45254, 'Citi',                  51),  -- Mark Mason, Chief Financial Officer
  (36527, 'Pursuit',               38),  -- Jukay Hsu, Chief Executive Officer
  (34615, 'Uber',                  35),  -- Dara Khosrowshahi, CEO
  ( 5193, 'Spotify',               18),  -- Máuhan M Zonoozy, Head of Innovation
  (45230, 'Peloton',               15),  -- Barry McCarthy, President and CEO
  (45219, 'JPMorgan Chase (JPMC)', 12),  -- Henry Shiembob, Global Chief Security Officer
  (45454, 'Moody''s',              12),  -- DK Bartley, Chief Diversity Officer
  (27983, 'LinkedIn',              11),  -- Jacqueline Jones, Head of Strategic Partnerships
  (45558, 'Microsoft',             10),  -- Scott Guthrie, EVP, Cloud + AI Group
  (33100, 'New York Times',        10),  -- Chris Wiggins, Chief Data Scientist
  (25263, 'Audible',                9),  -- Sandy Fershee, Head of Design / UX
  (10770, 'Accenture',              8),  -- Ryan Oakes, Senior Managing Director
  (31502, 'Capital One',            7),  -- Victor Pinto, Divisional COO
  (38202, 'Girls Who Code',         7),  -- Reshma Saujani, Co-founder & CEO
  (10678, 'Google',                 7),  -- Angela Pinsky, Head of Govt Affairs & Public Policy, NY
  (37824, 'Pinterest',              7),  -- Bre Foster, Head of Programs
  ( 4779, 'AWS',                    6),  -- David Ham, Head of Creative Solutions, AWS Global Services
  (37617, 'Betterment',             6),  -- Caitlin Rystrom, HR Operations Manager & HRBP
  (44987, 'Citizens Bank',          6),  -- Bruce Van Saun, Chairman and CEO
  (26749, 'DoorDash',               6),  -- Tony Xu, CEO and Co-founder
  (35776, 'Twitter',                6),  -- Jose Rodriguez, Office Manager
  (34624, 'Blackstone',             5),  -- John Stecher, CTO
  (17282, 'DeepMile (Comcast)',     5),  -- Dalila Wilson-Scott, EVP & Chief Impact Officer (Comcast)
  (30738, 'Dow Jones',              5),  -- Tom Gebauer, SVP Design & Research
  (35477, 'Hinge',                  5),  -- Baylee Feore, Director of Backend Engineering
  (45172, 'Mailchimp',              5),  -- Ben Chestnut, CEO & Co-founder
  (33953, 'Poll Everywhere',        5),  -- Matt Diebolt, CTO
  (33565, 'Quil Health',            5),  -- Marcel Chaucer, (no title on file)
  (45595, 'Thumbtack',              5);  -- Marco Zappacosta, Co-founder & CEO
  -- Intrepid Pursuits (6 hires): no contact in the CRM. See header.

-- Guard: the slug must be a live catalog row, or PATCH /api/jobs/contacts/{id}
-- would reject it later as "Unknown tags (not in catalog)".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bedrock.contact_tag_catalog WHERE slug='operation_35_pursuit' AND active) THEN
    RAISE EXCEPTION 'operation_35_pursuit is not an active tag; run 2026-08-07-operation-35-tags.sql first';
  END IF;
END $$;

-- 1. Tag. Appends to the existing array; a contact that already carries the tag
--    is left byte-identical (no updated_at churn).
UPDATE public.contacts c
   SET tags = (SELECT array_agg(DISTINCT s ORDER BY s)
                 FROM unnest(coalesce(c.tags,'{}'::text[]) || ARRAY['operation_35_pursuit']) AS s),
       updated_at = now()
  FROM op35_targets t
 WHERE c.contact_id = t.contact_id
   AND NOT (coalesce(c.tags,'{}'::text[]) @> ARRAY['operation_35_pursuit']);

-- 2. Jobs pipeline. 'assigned' = in pipeline, not yet contacted.
--    activation_reason 'strategic' (not 'manual'/'algorithm'): these came from a
--    named campaign over a hire-count list, which is what that value is for.
--    DO NOTHING protects anyone already further along, or marked not_a_fit.
INSERT INTO bedrock.jobs_contact_membership
       (contact_id, stage, activation_reason, activation_note, assigned_by, assigned_at, updated_at)
SELECT t.contact_id, 'assigned', 'strategic',
       'Operation 35 — Pursuit: ' || t.hires || ' Builders hired at ' || t.account,
       'kwame@pursuit.org', now(), now()
  FROM op35_targets t
ON CONFLICT (contact_id) DO NOTHING;

-- 3. Consistency: anyone with a membership must be a jobs prospect. Mirrors
--    2026-07-23-flag-in-pipeline-as-prospect.sql.
UPDATE public.contacts c
   SET is_jobs_contact = true, updated_at = now()
  FROM op35_targets t
 WHERE c.contact_id = t.contact_id
   AND NOT coalesce(c.is_jobs_contact, false);

-- 4. The comment, on the contact (jobs_comment has no 'account' parent_type —
--    its CHECK allows only 'opportunity' and 'prospect' — so the contact-level
--    comment is the whole of it; there is nowhere to hang an account note).
INSERT INTO bedrock.jobs_comment (parent_type, parent_id, author_id, author_email, content)
SELECT 'prospect', t.contact_id::text,
       -- author_id is a uuid from public.org_users. NOT
       -- bedrock.resolve_staff_user_id(), which returns an integer staff id from
       -- a different id space and would not cast. Some staff have two active
       -- org_users rows (see list_staff in routes/jobs.py), so this is pinned to
       -- one row; kwame@pursuit.org currently has exactly one.
       (SELECT o.id FROM public.org_users o
         WHERE o.email = 'kwame@pursuit.org' AND o.is_active
         ORDER BY o.id LIMIT 1),
       'kwame@pursuit.org',
       'Added because >5 Builders Hired in the past'
  FROM op35_targets t
 WHERE NOT EXISTS (
         SELECT 1 FROM bedrock.jobs_comment jc
          WHERE jc.parent_type = 'prospect'
            AND jc.parent_id = t.contact_id::text
            AND jc.content = 'Added because >5 Builders Hired in the past');

COMMIT;

-- Verify (expect 29 rows, every one tagged / in pipeline / commented):
--   SELECT c.contact_id, c.full_name, c.current_company,
--          c.tags @> ARRAY['operation_35_pursuit'] AS tagged,
--          c.is_jobs_contact, m.stage,
--          EXISTS (SELECT 1 FROM bedrock.jobs_comment jc
--                   WHERE jc.parent_type='prospect' AND jc.parent_id=c.contact_id::text
--                     AND jc.content='Added because >5 Builders Hired in the past') AS commented
--     FROM public.contacts c
--     LEFT JOIN bedrock.jobs_contact_membership m ON m.contact_id=c.contact_id
--    WHERE c.contact_id IN (45254,36527,34615,5193,45230,45219,45454,27983,45558,33100,
--                           25263,10770,31502,38202,10678,37824,4779,37617,44987,26749,
--                           35776,34624,17282,30738,35477,45172,33953,33565,45595)
--    ORDER BY c.contact_id;
