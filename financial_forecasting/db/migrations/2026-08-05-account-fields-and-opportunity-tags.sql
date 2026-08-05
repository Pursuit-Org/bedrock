-- Account firmographics + investor relationship + opportunity campaign tags.
--
-- Three independent additions, grouped because they're all additive columns with
-- no backfill and no constraint rebuilds. The riskier stage work (contact/
-- opportunity stage renames, on-hold folding) is deliberately NOT in this file —
-- it needs a coordinated deploy and ships separately.
--
-- All additive and idempotent. No data is rewritten. Existing rows get NULL (or
-- '{}' for tags), which every read path already treats as "not set".
--
-- Verified against production 2026-08-05 before writing:
--   public.companies already has industry, size_bucket, hq_location, stage
--     -> only employee_count is new; the other three just weren't surfaced.
--   bedrock.jobs_account has no account/company-type or investor column.
--   bedrock.jobs_opportunity has no tags column (only the legacy `source` enum).
--   bedrock.contact_tag_catalog is the existing curated campaign vocabulary
--     (slug, label, sort_order, active, owner_email) -> reused as-is, NOT renamed,
--     because renaming it would touch every existing contact-tag reference.

-- ---------------------------------------------------------------------------
-- 1. Raw headcount on the shared company table.
--
-- FLAG FOR JAC: public.companies is org-wide, not jobs-only. It's the right home
-- because size_bucket / hq_location / industry already live there and the jobs
-- Targeting Mix already reads them — putting headcount anywhere else guarantees
-- two tools eventually show two different numbers. But it is a shared-table
-- change, so it needs your sign-off rather than mine.
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS employee_count integer;

COMMENT ON COLUMN public.companies.employee_count IS
  'Raw headcount. Complements size_bucket (the band); null when unknown.';

-- ---------------------------------------------------------------------------
-- 2. Investor relationship on jobs accounts.
--
-- A portfolio company points at its investor, and that investor is itself a
-- jobs_account row — so Blackstone is a real account you can open, own and
-- work, and its portfolio companies are discoverable from it.
--
-- Deliberately a nullable self-reference rather than a boolean account_type:
-- "is this an investor" is derivable (it has portfolio companies), whereas
-- "who owns this company" is the fact the team actually needs. One investor per
-- account for now; if co-investors are ever needed this column promotes to a
-- link table with no change to the UI contract.
--
-- No FK constraint: account_key is a normalized company name, and accounts are
-- created implicitly by having an opportunity or prospect, so a hard FK would
-- reject an investor that hasn't materialised a jobs_account row yet. Reads
-- LEFT JOIN and tolerate a dangling key, same as the rest of the account graph.
-- ---------------------------------------------------------------------------
ALTER TABLE bedrock.jobs_account
  ADD COLUMN IF NOT EXISTS investor_account_key text;

COMMENT ON COLUMN bedrock.jobs_account.investor_account_key IS
  'account_key of the investor/owner of this company (soft reference to '
  'jobs_account.account_key). Null = no known investor. Reverse direction gives '
  'an investor its portfolio list.';

CREATE INDEX IF NOT EXISTS idx_jobs_account_investor
  ON bedrock.jobs_account (investor_account_key)
  WHERE investor_account_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Campaign tags on opportunities, sharing the CONTACT vocabulary.
--
-- Same shape as public.contacts.tags (text[]), reading the same
-- bedrock.contact_tag_catalog. An opportunity tagged 'board' and a contact
-- tagged 'board' are the same campaign by construction — no reconciliation
-- layer, because they point at the same catalog row.
--
-- jobs_opportunity.source is left alone: the column and its data stay, it just
-- stops being offered in the UI once tags cover the same ground. Same treatment
-- contacts got.
-- ---------------------------------------------------------------------------
ALTER TABLE bedrock.jobs_opportunity
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

COMMENT ON COLUMN bedrock.jobs_opportunity.tags IS
  'Campaign tags, same vocabulary as public.contacts.tags '
  '(bedrock.contact_tag_catalog). Supersedes the legacy `source` enum in the UI.';

CREATE INDEX IF NOT EXISTS idx_jobs_opportunity_tags
  ON bedrock.jobs_opportunity USING gin (tags);

-- ---------------------------------------------------------------------------
-- Grants: the app role needs to read/write the new columns. Column privileges
-- follow the table, so nothing extra is required for jobs_dev / bedrock_user on
-- 2 and 3. public.companies is the exception worth checking explicitly.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
    GRANT SELECT, UPDATE ON public.companies TO bedrock_user;
  END IF;
END $$;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='companies' AND column_name='employee_count';
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='bedrock' AND table_name='jobs_account' AND column_name='investor_account_key';
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='bedrock' AND table_name='jobs_opportunity' AND column_name='tags';
--
-- The API probes for employee_count at request time (routes/jobs.py _has_column),
-- so the Accounts list picks the column up on apply with no redeploy.
