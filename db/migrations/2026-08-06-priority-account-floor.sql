-- Account-level priority floor for My Network
-- Drafted 2026-08-06.
--
-- Jac: anyone at an account in the "Work now — exec-sponsored outreach" quadrant is
-- P2 at minimum. That quadrant comes from the employer-prospect ranking
-- (~/employer-prospect-ranking, out/accounts_final.csv), published as the
-- "Jobs priority list - July 2026" sheet.
--
-- STATIC BY DECISION (Jac, 2026-08-06): this is a snapshot, not a live read of the
-- sheet. Re-run scripts/load_priority_account_floor.py after re-quadranting to
-- refresh it. `loaded_at` and `run_label` are here so a stale floor is visible
-- rather than mysterious.
--
-- Why its own table and not bedrock.employer_prospect_score: that table would be
-- the better home, but its migration (2026-07-31-employer-prospect-scoring.sql) is
-- still unapplied and carries four other tables plus a loader. This is the narrow
-- slice the banding actually needs. If that migration ever lands, this becomes a
-- view over it.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.priority_account_floor (
    -- lower(btrim(company)) — the same normalised key the jobs app groups on, and
    -- the same one bedrock.company_investor uses.
    account_key   text PRIMARY KEY,
    company_name  text NOT NULL,
    -- The band this account guarantees. Only 'P2' is used today; the column exists
    -- so a future "work now becomes P1" needs data, not a schema change.
    floor_band    text NOT NULL DEFAULT 'P2',
    quadrant      text,
    final_rank    integer,
    combined_score numeric(7,2),
    source        text NOT NULL DEFAULT 'employer_prospect_ranking',
    run_label     text,
    loaded_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT priority_account_floor_band_ck CHECK (floor_band IN ('P1', 'P2'))
);

CREATE INDEX IF NOT EXISTS priority_account_floor_band_idx
    ON bedrock.priority_account_floor (floor_band);

COMMENT ON TABLE bedrock.priority_account_floor IS
    'Accounts that guarantee a minimum priority band on My Network, keyed by '
    'account_key. A SNAPSHOT of the employer-prospect ranking quadrants, not a live '
    'view — refresh with scripts/load_priority_account_floor.py. Read by '
    '_net_priority_case in routes/jobs.py, which tolerates the table being absent.';

COMMENT ON COLUMN bedrock.priority_account_floor.account_key IS
    'lower(btrim(company_name)). Joins to public.contacts.current_company by name, '
    'which is how the rest of the jobs app matches accounts — and carries the same '
    'same-name risk documented in the ranking repo (Harvey, Slice, Apollo).';

COMMIT;

-- ── grants (run as an admin if bedrock_user is not the owner) ────────────────
-- GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.priority_account_floor TO bedrock_user;

-- ── rollback ────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS bedrock.priority_account_floor;
