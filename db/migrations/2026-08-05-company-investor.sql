-- Portfolio-company → investor mapping
-- Drafted 2026-08-05. Needed by the My Network "prioritized" ranking (a portfolio
-- company is auto-P2, and P1 if it also hits 2 of headcount/tri-state/seniority)
-- and by the Investor filter deferred from the 2026-08-04 round.
--
-- Source of truth today is the Google Sheet "Portfolio_Pursuit_MultiFirm", parsed
-- to ~/employer-prospect-ranking/data/portfolio_all.csv (348 rows, 17 firms).
-- Loaded by scripts/load_company_investor.py, which is idempotent.
--
-- Why a table and not a join to the sheet: the ranking runs per request inside a
-- SQL ORDER BY. It cannot call out to Sheets, and the employer-prospect CSVs are
-- a snapshot on one laptop.
--
-- Idempotent. Safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.company_investor (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- account_key is lower(btrim(name)) — the same normalised company name the
    -- jobs app already groups on, so this joins to jobs_account, the accounts
    -- rollup, and public.contacts.current_company without a new identity scheme.
    account_key     text NOT NULL,
    company_name    text NOT NULL,          -- as spelled in the sheet
    firm            text NOT NULL,          -- AlleyCorp, a16z, Blackstone, …
    firm_type       text,                   -- VC | PE | …
    -- Sheet-sourced context, carried so the UI can explain WHY something is a
    -- portco without a second lookup. Blank in the sheet stays NULL here.
    majority_stake  text,                   -- Yes | No | N/A
    tier            text,                   -- Tier 1 | Tier 2 | Tier 3
    headcount       text,
    stage           text,
    tristate        text,
    what_they_do    text,
    currently_hiring text,
    source          text NOT NULL DEFAULT 'portfolio_sheet',
    loaded_at       timestamptz NOT NULL DEFAULT now(),
    -- One company can be backed by several firms; the pair is the identity.
    CONSTRAINT company_investor_key UNIQUE (account_key, firm)
);

CREATE INDEX IF NOT EXISTS company_investor_account_key_idx
    ON bedrock.company_investor (account_key);
CREATE INDEX IF NOT EXISTS company_investor_firm_idx
    ON bedrock.company_investor (firm);

COMMENT ON TABLE bedrock.company_investor IS
    'Which investor(s) back a company, keyed by the jobs account_key. Sourced from '
    'the Portfolio_Pursuit_MultiFirm sheet; one row per (company, firm). Read by the '
    'My Network priority banding and the Investor filter.';

COMMENT ON COLUMN bedrock.company_investor.account_key IS
    'lower(btrim(company_name)). Matches public.contacts.current_company the same '
    'way the rest of the jobs app does — by normalised name, since only ~90 of these '
    'companies have a domain on file.';

COMMIT;

-- ── grants (run as an admin; bedrock_user is the app role) ──────────────────
-- GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.company_investor TO bedrock_user;
