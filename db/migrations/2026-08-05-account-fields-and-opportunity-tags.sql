-- Investor relationship + opportunity campaign tags.
--
-- Two independent additions, grouped because they're both additive columns with
-- no backfill and no constraint rebuilds. The riskier stage work (contact/
-- opportunity stage renames, on-hold folding) is deliberately NOT in this file —
-- it needs a coordinated deploy and ships separately.
--
-- All additive and idempotent. No data is rewritten. Existing rows get NULL (or
-- '{}' for tags), which every read path already treats as "not set".
--
-- Verified against production 2026-08-05 before writing:
--   public.companies already has industry, size_bucket, hq_location, stage
--     -> nothing needed there; those four just weren't surfaced in the UI, which
--        is a code change and already shipped. A raw employee_count column was
--        proposed and withdrawn (Kwame, 2026-08-05) — the band is enough.
--   bedrock.jobs_account has no account/company-type or investor column.
--   bedrock.jobs_opportunity has no tags column (only the legacy `source` enum).
--   bedrock.contact_tag_catalog is the existing curated campaign vocabulary
--     (slug, label, sort_order, active, owner_email) -> reused as-is, NOT renamed,
--     because renaming it would touch every existing contact-tag reference.

-- ---------------------------------------------------------------------------
-- 1. Investor relationship on jobs accounts.
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
-- 2. Campaign tags on opportunities, sharing the CONTACT vocabulary.
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

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='bedrock' AND table_name='jobs_account' AND column_name='investor_account_key';
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='bedrock' AND table_name='jobs_opportunity' AND column_name='tags';
