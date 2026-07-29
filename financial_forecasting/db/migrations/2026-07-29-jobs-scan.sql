-- Jobs Scan: monitor watched companies' ATS boards for builder-fit roles.
--
-- Design: docs/jobs-scan-design.md
--
-- Four tables in bedrock.* (owned by bedrock_user) plus one SECURITY DEFINER
-- function, because bedrock_user cannot write public.job_postings directly.
--
--   jobs_watch_company    the curated watchlist
--   jobs_watch_board      n ATS boards per company (platform + slug)
--   jobs_scan_criteria    versioned, DB-backed fit criteria (editable without a deploy)
--   scraped_job_posting   scan firehose: diff surface, scores, triage state
--
-- Raw scan output deliberately stays in bedrock.*; only human-approved rows are
-- promoted into public.job_postings, so the curated Pathfinder board stays clean.
--
-- Promotion has two independent paths, both driven from the triage UI:
--   1. Pathfinder  -> bedrock.promote_scan_to_pathfinder() (added here)
--   2. Opportunity -> ordinary INSERT into jobs_opportunity + jobs_role by the
--      API. When that role is pathfinder_visible, the API pre-links
--      jobs_role.job_posting_id to any posting path 1 already created, so the
--      EXISTING bedrock.sync_role_to_pathfinder() takes its UPDATE branch
--      rather than inserting a second posting for the same job.
--
-- Idempotent. Safe to re-run against production.
-- Requires superuser only for the SECURITY DEFINER function at the end.

BEGIN;

-- ---------------------------------------------------------------------------
-- Watchlist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.jobs_watch_company (
  account_key       text PRIMARY KEY,          -- lower(trim(name)), matches jobs_account
  display_name      text NOT NULL,
  domain            text,
  -- Cadence, NOT membership: how often we re-scan this company.
  tier              text NOT NULL DEFAULT 'secondary',
  -- What the company is to us. Independent of scan cadence.
  relationship      text NOT NULL DEFAULT 'monitored',
  why_watched       text,
  source_tags       text[],                    -- contact tags that proposed it
  owner_email       text,
  criteria_profile  text NOT NULL DEFAULT 'builder_wide',
  active            boolean NOT NULL DEFAULT true,
  -- Hard exclusion. Never surface this company's roles, to anyone, ever.
  do_not_present    boolean NOT NULL DEFAULT false,
  notes             text,                      -- slug provenance, board quirks
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE bedrock.jobs_watch_company
    ADD CONSTRAINT jobs_watch_company_tier_check
    CHECK (tier = ANY (ARRAY['priority','secondary','archive']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bedrock.jobs_watch_company
    ADD CONSTRAINT jobs_watch_company_relationship_check
    CHECK (relationship = ANY (ARRAY['warm_partner','monitored','prospect']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS jobs_watch_company_active_idx
  ON bedrock.jobs_watch_company (active, tier) WHERE NOT do_not_present;

-- ---------------------------------------------------------------------------
-- Boards. One row per (platform, slug) so an ATS migration is detectable:
-- a company that moves Greenhouse->Ashby leaves the old board answering 200
-- with an EMPTY LIST, not a 404. Keeping the old row lets consecutive_empty_scans
-- climb and trigger a re-probe instead of reading as "no open roles".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.jobs_watch_board (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key             text NOT NULL
                            REFERENCES bedrock.jobs_watch_company(account_key)
                            ON DELETE CASCADE,
  platform                text NOT NULL,
  slug                    text NOT NULL,       -- stored pre-encoded (Lever allows spaces)
  status                  text NOT NULL DEFAULT 'unverified',
  -- Workday is not slug-guessable; it needs explicit tenant/site config.
  extra                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at             timestamptz,
  last_scan_at            timestamptz,
  last_scan_status        text,
  last_role_count         integer,
  consecutive_empty_scans integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, slug)
);

DO $$ BEGIN
  ALTER TABLE bedrock.jobs_watch_board
    ADD CONSTRAINT jobs_watch_board_platform_check
    CHECK (platform = ANY (ARRAY['greenhouse','ashby','lever','gem','workday']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bedrock.jobs_watch_board
    ADD CONSTRAINT jobs_watch_board_status_check
    CHECK (status = ANY (ARRAY['verified','unverified','stale','migrated']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS jobs_watch_board_account_idx
  ON bedrock.jobs_watch_board (account_key);

-- ---------------------------------------------------------------------------
-- Criteria. DB-backed and versioned so the fit rules can be widened or
-- narrowed without a deploy, and so a score stays attributable to the rules
-- that produced it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.jobs_scan_criteria (
  name        text PRIMARY KEY,
  version     integer NOT NULL DEFAULT 1,
  body        jsonb NOT NULL,      -- comp band, geography, role families, seniority
  active      boolean NOT NULL DEFAULT true,
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the wide v1 profile. ON CONFLICT DO NOTHING so re-running never clobbers
-- edits made through the UI.
INSERT INTO bedrock.jobs_scan_criteria (name, version, body, updated_by) VALUES (
  'builder_wide', 1,
  jsonb_build_object(
    'comp', jsonb_build_object(
      'min', 50000, 'max', 120000,
      'ceiling_headroom', 160000,
      -- Unknown comp always passes. Most postings publish none, and dropping
      -- them would gut recall.
      'unknown_passes', true,
      'accept_hourly', true, 'hourly_annualize_hours', 2080),
    'geography', jsonb_build_object(
      'remote_ok', true,
      'metros', jsonb_build_array('new york','nyc','manhattan','brooklyn','queens',
        'bronx','staten island','jersey city','newark','hoboken','long island city'),
      'states', jsonb_build_array('ME','NH','VT','MA','RI','CT','NY','NJ','PA',
        'DE','MD','DC','VA','NC','SC','GA','FL'),
      'absent_location_passes', true),
    'role_families', jsonb_build_array(
      'ai_adoption_specialist','ai_product_associate','ai_customer_success',
      'ai_native_developer','gtm_engineer','sales_sdr','data_analytics',
      'marketing','qa_testing','hr_people_ops','design','finance_ops',
      'forward_deployed','ai_implementation','entry_operations',
      'entry_project_management'),
    -- Not a title list: an LLM judgment, which is the only way to catch roles
    -- a title regex would never match.
    'semantic_test',
      'Could someone trained to work fluently with AI tools do the core of this job, even if the posting never mentions AI?',
    'seniority', jsonb_build_object(
      'kill', jsonb_build_array('senior','staff','principal','lead','director',
        'vp','vice president','head of','chief','5+ years','7+ years','10+ years'),
      'manager_exceptions', jsonb_build_array('product manager','project manager',
        'account manager','customer success manager','program manager')),
    -- Recall posture: a false drop is worse than a false include.
    'bias', 'recall'
  ),
  'migration:2026-07-29'
) ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Scan results. One row per (platform, slug, external_job_id) -- the stable key
-- that makes new/closed detection a set diff rather than fuzzy matching.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.scraped_job_posting (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key          text NOT NULL,
  platform             text NOT NULL,
  slug                 text NOT NULL,
  external_job_id      text NOT NULL,
  title                text,
  location             text,
  is_remote            boolean,
  url                  text,
  description          text,
  salary_min           integer,
  salary_max           integer,
  -- api > gh_page/ashby_jsonld > jd_regex > not_found. Tells a reviewer how
  -- much to trust the number.
  comp_source          text,
  -- FULL payload including JD text. Never stripped: the prior project lost 65
  -- of 259 surviving roles to exactly that, and had to re-fetch everything.
  raw                  jsonb,
  posted_at            timestamptz,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  -- Postings die behind HTTP 200, and a bot-blocked check is not a dead job.
  liveness             text NOT NULL DEFAULT 'live',
  score                numeric,
  classification       text,
  matched_family       text,
  reasoning            text,
  criteria_version     text,
  drop_reason          text,                  -- for the funnel counters
  triage_state         text NOT NULL DEFAULT 'new',
  triaged_by           text,
  triaged_at           timestamptz,
  promoted_posting_id  integer,               -- -> public.job_postings.id
  opportunity_id       uuid,                  -- -> bedrock.jobs_opportunity.id
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, slug, external_job_id)
);

DO $$ BEGIN
  ALTER TABLE bedrock.scraped_job_posting
    ADD CONSTRAINT scraped_job_posting_triage_check
    CHECK (triage_state = ANY (ARRAY['new','approved','rejected','promoted','snoozed']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bedrock.scraped_job_posting
    ADD CONSTRAINT scraped_job_posting_liveness_check
    CHECK (liveness = ANY (ARRAY['live','dead','indeterminate']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The triage queue's default read: open rows, newest first.
CREATE INDEX IF NOT EXISTS scraped_job_posting_triage_idx
  ON bedrock.scraped_job_posting (triage_state, first_seen_at DESC)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS scraped_job_posting_account_idx
  ON bedrock.scraped_job_posting (account_key);

CREATE INDEX IF NOT EXISTS scraped_job_posting_board_idx
  ON bedrock.scraped_job_posting (platform, slug);

-- ---------------------------------------------------------------------------
-- updated_at triggers, mirroring the rest of the schema.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bedrock.jobs_scan_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_watch_company_touch ON bedrock.jobs_watch_company;
CREATE TRIGGER trg_watch_company_touch BEFORE UPDATE ON bedrock.jobs_watch_company
  FOR EACH ROW EXECUTE FUNCTION bedrock.jobs_scan_touch_updated_at();

DROP TRIGGER IF EXISTS trg_watch_board_touch ON bedrock.jobs_watch_board;
CREATE TRIGGER trg_watch_board_touch BEFORE UPDATE ON bedrock.jobs_watch_board
  FOR EACH ROW EXECUTE FUNCTION bedrock.jobs_scan_touch_updated_at();

DROP TRIGGER IF EXISTS trg_scan_criteria_touch ON bedrock.jobs_scan_criteria;
CREATE TRIGGER trg_scan_criteria_touch BEFORE UPDATE ON bedrock.jobs_scan_criteria
  FOR EACH ROW EXECUTE FUNCTION bedrock.jobs_scan_touch_updated_at();

DROP TRIGGER IF EXISTS trg_scraped_posting_touch ON bedrock.scraped_job_posting;
CREATE TRIGGER trg_scraped_posting_touch BEFORE UPDATE ON bedrock.scraped_job_posting
  FOR EACH ROW EXECUTE FUNCTION bedrock.jobs_scan_touch_updated_at();

COMMIT;

-- ---------------------------------------------------------------------------
-- Promote a reviewed scan row onto the builder-facing Pathfinder board.
--
-- SECURITY DEFINER because bedrock_user has no write grant on
-- public.job_postings. Deliberately mirrors bedrock.sync_role_to_pathfinder:
-- same staff-id resolution, same create/update/unpublish return shape.
--
-- Idempotent per scan row: once promoted_posting_id is set, later calls UPDATE
-- that posting instead of creating another. p_share=false unpublishes without
-- deleting, so a promote can be reversed.
--
-- Refuses to publish a do_not_present company even if a reviewer approved the
-- row, so the hard exclusion cannot be bypassed through the UI.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bedrock.promote_scan_to_pathfinder(
  p_scan_id uuid,
  p_actor_email text DEFAULT NULL,
  p_share boolean DEFAULT true
)
RETURNS TABLE(action text, posting_id integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  s record; v_staff int; v_pid int; v_range text; v_excluded boolean;
BEGIN
  SELECT sp.id, sp.account_key, sp.title, sp.url, sp.description,
         sp.salary_min, sp.salary_max, sp.promoted_posting_id, sp.location
    INTO s
    FROM bedrock.scraped_job_posting sp
    WHERE sp.id = p_scan_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::int; RETURN;
  END IF;

  SELECT coalesce(w.do_not_present, false) INTO v_excluded
    FROM bedrock.jobs_watch_company w WHERE w.account_key = s.account_key;
  IF coalesce(v_excluded, false) AND p_share THEN
    RETURN QUERY SELECT 'blocked_do_not_present'::text, s.promoted_posting_id; RETURN;
  END IF;

  SELECT staff_user_id INTO v_staff FROM bedrock.staff_user_id_map
    WHERE lower(email) = lower(coalesce(p_actor_email, ''));
  IF v_staff IS NULL THEN
    SELECT staff_user_id INTO v_staff FROM bedrock.staff_user_id_map
      WHERE lower(email) = 'avni@pursuit.org';
  END IF;

  v_range := CASE
    WHEN s.salary_min IS NOT NULL AND s.salary_max IS NOT NULL
      THEN '$' || round(s.salary_min / 1000.0) || 'k - $' || round(s.salary_max / 1000.0) || 'k'
    WHEN s.salary_min IS NOT NULL THEN '$' || round(s.salary_min / 1000.0) || 'k+'
    WHEN s.salary_max IS NOT NULL THEN 'Up to $' || round(s.salary_max / 1000.0) || 'k'
  END;

  IF s.promoted_posting_id IS NOT NULL THEN
    UPDATE public.job_postings SET
      company_name = coalesce((SELECT display_name FROM bedrock.jobs_watch_company
                                WHERE account_key = s.account_key), s.account_key),
      job_title    = coalesce(s.title, 'Role'),
      job_url      = s.url,
      description  = s.description,
      salary_range = v_range,
      salary_min   = s.salary_min,
      salary_max   = s.salary_max,
      location     = left(s.location, 255),
      is_shared    = p_share,
      updated_at   = now()
    WHERE id = s.promoted_posting_id;

    UPDATE bedrock.scraped_job_posting
      SET triage_state = CASE WHEN p_share THEN 'promoted' ELSE 'approved' END,
          updated_at = now()
      WHERE id = p_scan_id;

    RETURN QUERY SELECT
      CASE WHEN p_share THEN 'updated' ELSE 'unpublished' END::text,
      s.promoted_posting_id;
    RETURN;
  END IF;

  IF NOT p_share THEN
    RETURN QUERY SELECT 'noop'::text, NULL::int; RETURN;
  END IF;

  INSERT INTO public.job_postings
    (staff_user_id, company_name, job_title, job_url, source, status,
     description, salary_range, salary_min, salary_max, location,
     experience_level, is_shared, shared_date, is_migrated)
  VALUES
    (v_staff,
     coalesce((SELECT display_name FROM bedrock.jobs_watch_company
                WHERE account_key = s.account_key), s.account_key),
     coalesce(s.title, 'Role'), s.url, 'ats_scan', 'new',
     s.description, v_range, s.salary_min, s.salary_max, left(s.location, 255),
     'entry', true, CURRENT_DATE, false)
  RETURNING id INTO v_pid;

  UPDATE bedrock.scraped_job_posting
    SET promoted_posting_id = v_pid, triage_state = 'promoted', updated_at = now()
    WHERE id = p_scan_id;

  RETURN QUERY SELECT 'created'::text, v_pid;
END $function$;

-- ---------------------------------------------------------------------------
-- Grants. bedrock_user is the app role; jobs_dev is the developer role.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    bedrock.jobs_watch_company, bedrock.jobs_watch_board,
    bedrock.jobs_scan_criteria, bedrock.scraped_job_posting
    TO bedrock_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    bedrock.jobs_watch_company, bedrock.jobs_watch_board,
    bedrock.jobs_scan_criteria, bedrock.scraped_job_posting
    TO jobs_dev;
  GRANT EXECUTE ON FUNCTION bedrock.promote_scan_to_pathfinder(uuid, text, boolean)
    TO bedrock_user, jobs_dev;
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'skipping grants: insufficient privilege';
  WHEN undefined_object THEN RAISE NOTICE 'skipping grants: role missing (local dev)';
END $$;
