-- Investor → portfolio-company hierarchy for the jobs accounts hub.
--
-- WHY THIS SHAPE
--   "Portco" is not a tag. A portfolio company is one that HAS an investor, so
--   the flag is derived from this table and can never drift from the firm data.
--   The relationship is many-to-many (Devoted Health is a16z AND Oak HC/FT) and
--   time-bounded (companies get sold), which is also why Salesforce's
--   Account.ParentId is the wrong home: it is single-valued and already means
--   corporate structure there (Amazon → AWS/Audible, CUNY → its colleges).
--
--   The firm is itself a public.companies row, so a VC/PE firm gets the same
--   identity, industry and roll-up as any other company — no parallel "firm"
--   entity to keep in sync.
--
-- WHY company_id AND NOT account_key
--   bedrock.jobs_account is keyed by lower(trim(name)) — a display string. That
--   key collides (our data has a `Flex` that is Flextronics AND a `Flex` that is
--   a 66-person fintech; likewise Coherent, GARAGE). Hanging the investor link
--   off a name would mislink those on day one, so the link is keyed on
--   public.companies.company_id and jobs_account gains a soft company_id ref.
--   That also survives the account-identity switch planned in
--   tasks/account-dedupe-and-mirror-plan.md.
--
-- No FOREIGN KEYs to public.companies: bedrock_user has no REFERENCES privilege
-- on the public schema (verified 2026-07-30), so these are soft refs + indexes,
-- matching bedrock.sf_account_company_map.public_company_id.
--
-- Idempotent.

BEGIN;

-- ── 1. jobs_account → the company entity ────────────────────────────────────
-- Nullable on purpose: account_key stays the display/group key and the hub keeps
-- working for accounts we cannot confidently resolve (see the 3 collisions
-- above, deliberately left NULL by scripts/load_portco_investors.py).
ALTER TABLE bedrock.jobs_account
  ADD COLUMN IF NOT EXISTS company_id integer;   -- → public.companies.company_id (soft ref)

CREATE INDEX IF NOT EXISTS idx_jobs_account_company_id
  ON bedrock.jobs_account(company_id) WHERE company_id IS NOT NULL;

-- ── 2. the investor relationship ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bedrock.company_investor (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      integer NOT NULL,   -- → public.companies.company_id (the portco)
  firm_company_id integer NOT NULL,   -- → public.companies.company_id (the VC/PE firm)
  -- 'investor' is the safe default: the sheet's Majority Stake column is mostly
  -- blank, and asserting control we have not verified would be worse than vague.
  role            text NOT NULL DEFAULT 'investor',
  -- 'reported' = third-party list (a portfolio page, a sheet). 'confirmed' =
  -- someone at Pursuit verified it. Keeps unverified market intel from reading
  -- as fact once this feeds anything that matters.
  confidence      text NOT NULL DEFAULT 'reported',
  source          text,               -- provenance, e.g. 'portfolio_sheet:Portfolio_Pursuit_MultiFirm'
  as_of           date,               -- when the relationship was observed
  until           date,               -- NULL = current holding; set on exit
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE bedrock.company_investor
    ADD CONSTRAINT company_investor_role_vals
    CHECK (role IN ('investor','majority','minority'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bedrock.company_investor
    ADD CONSTRAINT company_investor_confidence_vals
    CHECK (confidence IN ('reported','confirmed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A firm holds a given company once. Makes the loader re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_investor_pair
  ON bedrock.company_investor(company_id, firm_company_id);

CREATE INDEX IF NOT EXISTS idx_company_investor_company ON bedrock.company_investor(company_id);
CREATE INDEX IF NOT EXISTS idx_company_investor_firm    ON bedrock.company_investor(firm_company_id);
-- The hub only ever asks for current holdings.
CREATE INDEX IF NOT EXISTS idx_company_investor_current
  ON bedrock.company_investor(company_id) WHERE until IS NULL;

COMMIT;
