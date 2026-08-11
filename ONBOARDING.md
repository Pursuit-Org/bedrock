# Onboarding: Bedrock

Welcome. This doc gets you from a fresh clone to a running app, and orients
you to how this repo is actually organized (which, in a few places, is not
what the root-level files suggest — see the gotchas at the end).

## What is Bedrock?

Bedrock is Pursuit's internal revenue/relationships platform. It grew out of
two efforts that have since merged into one app:

- **Grants & fundraising CRM** — bridges **Salesforce** (the pipeline system
  of record: Opportunities, Accounts, Contacts) and **Sage Intacct** (the
  accounting system: invoices, payments), so Relationship Managers, the
  fundraising team, and finance all work off one picture of pipeline and
  cash flow.
- **"Jobs" placement product** — a separate pipeline, living in the same
  app, for placing Pursuit "builders"/fellows into employer partnerships
  (accounts, candidates, applications, intros).
- **Pebble** — an AI research-agent service that researches prospects/donors
  from public filings, SEC/FEC data, and the web, and surfaces sourced
  profiles inside Bedrock via "Ask Pebble."

In one sentence: **Salesforce tracks what revenue is coming (pipeline);
Sage tracks what revenue actually landed (invoices/payments); Bedrock keeps
the two in sync and forecasts cash flow from both** — plus runs the Jobs
placement pipeline alongside it.

Three user roles to know (full detail in `product/ONBOARDINGPRD.md`):
- **Relationship Managers (RMs)** — own and edit Opportunities/pipeline.
- **Executive** — read-only visibility across everything except Pebble.
- **Project Managers (PMs)** — manage Projects, read-only elsewhere.

## Where the real app lives

Despite the folder name, **`financial_forecasting/` is the main
application** — not a forecasting sub-tool. Start there, not at the repo
root (see Gotcha #1 below for why).

- **Backend**: FastAPI (Python). Entry point `financial_forecasting/main.py`,
  which registers ~25 routers from `financial_forecasting/routes/`
  (`jobs.py`, `finance.py`, `sage.py`, `prospects.py`, `awards.py`,
  `projects.py`, `auth.py`, `permissions.py`, `salesforce_search.py`, `ai.py`,
  `sputnik.py`, etc.). Serves on **port 8000**; Swagger docs at `/docs`.
- **Frontend — two of them, both alive**:
  - `frontend/` — legacy Create React App + TypeScript + MUI, port **3000**.
  - `frontend-v2/` — the active React 19 + Vite + Tailwind + shadcn-style
    redesign, port **4200**, where current feature work (especially Jobs)
    happens. Its own README says "scaffold only" — **ignore that, it's
    stale**; `frontend-v2/src/pages/` is fully built out (Jobs suite,
    per-person home dashboards, portfolio, settings, etc.).
- **Database**: PostgreSQL, accessed via `asyncpg` in
  `financial_forecasting/db.py`. `DATABASE_URL` is **mandatory in every
  environment, with no localhost fallback** — see Gotcha #2.
- **Pebble**: standalone FastAPI service in `pebble/`, runs separately on
  **port 8001**. The frontend talks to it via `REACT_APP_PEBBLE_API_URL`.

## Running it locally

Full details (env vars, OAuth setup, production checklist) are in
`financial_forecasting/DEV_SETUP_GUIDE.md` — this is the canonical setup
doc. Short version:

1. **Install deps**
   ```bash
   cd financial_forecasting && pip install -r requirements.txt
   cd frontend-v2 && npm install   # or frontend/, if you need the legacy UI
   ```
2. **Configure env**: copy `financial_forecasting/env.production.template`
   to `financial_forecasting/.env` and fill in:
   - Google OAuth (`GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI`) — login
     is real Google OAuth in every environment; there is no dev bypass.
   - `JWT_SECRET_KEY` (`openssl rand -hex 32`)
   - Salesforce service-account creds
     (`SALESFORCE_USERNAME/PASSWORD/SECURITY_TOKEN/CLIENT_ID/CLIENT_SECRET/DOMAIN`)
   - Sage Intacct creds (`SAGE_COMPANY_ID`, `SAGE_USER_ID`,
     `SAGE_USER_PASSWORD`, `SAGE_SENDER_ID`, `SAGE_SENDER_PASSWORD`)
   - **`DATABASE_URL`** (required, no default — ask a teammate for the
     shared dev DB connection string rather than pointing this at a local
     Postgres; see Gotcha #2)
   - Optional: `ANTHROPIC_API_KEY`, `FIREFLIES_API_KEY`, `SLACK_BOT_TOKEN`,
     `PBD_CALENDAR_ID`, `REACT_APP_API_URL`/`VITE_API_URL`, `FRONTEND_URL`
   - `ENVIRONMENT=development` just warns on missing config;
     `ENVIRONMENT=production` refuses to start if required vars are
     missing/weak (canonical list in `env_validator.py`).
3. **Run it**:
   ```bash
   # from financial_forecasting/
   python main.py                 # backend, :8000
   cd frontend-v2 && npm run dev   # frontend, :4200 (or frontend/, npm start, :3000)
   ```
   Or from the repo root, `./dev.sh` starts the backend and **frontend-v2**
   together via `nohup` (PID files under `/tmp`).
4. **Pebble** (only if you're touching prospect research):
   `uvicorn pebble.main:app --reload --port 8001` from repo root.
5. Run `bash scripts/install-git-hooks.sh` once — installs a pre-commit
   guard that blocks accidentally committing `.env` files.

## Repo layout

| Path | What it is |
|---|---|
| `financial_forecasting/` | The running app — FastAPI backend + two React frontends. See above. |
| `pebble/` | AI prospect-research agent service (its own Worker/Drone/Forager/Queen pipeline — see below). |
| `product/` | Product docs hub — vision, PRDs, canonical definitions, onboarding, Sage/Salesforce/Slack reference. **Start here for product context**: `product/README.md`. |
| `docs/` | Engineering docs — DB schema, architecture decisions, doc-hygiene rules, plan index, `docs/archive/` for old session artifacts. |
| `db/migrations/` | Root-level, most-actively-used SQL migrations for the shared Postgres schema (see Gotcha #3 — there are two other migration folders too). |
| `mcp_client/` | Standalone Python MCP-connector library for Slack/Salesforce/Google Drive — this is what the *root* README/pyproject/requirements.txt describe (see Gotcha #1). `financial_forecasting/` has its own separate copy. |
| `salesforce_metadata/` | SF metadata package, notably the custom `Sage_Invoice__c` object that links Opportunities to Sage invoices. |
| `prospect_import/` | Small module for importing prospect lists (e.g. LinkedIn exports) into the DB. |
| `scripts/` | Repo hygiene — git-hook installers, pre-commit guard against committing `.env`. |
| `tasks/` | Git-tracked sprint plans, incident notes, `lessons.md`/`todo.md` — institutional history, not current specs. |
| `templates/` | One file: `matching.html`, used by the invoice/opportunity matching feature. |
| `tests/` | Root-level Playwright e2e tests, driven by `playwright.config.ts`. |
| `examples/` | Usage examples for the `mcp_client` library. |

## Pebble in more detail

Pebble is a separate FastAPI service (port 8001) that researches
prospects/donors from public filings (ProPublica/990s, FEC, OpenCorporates),
web search, and returns a sourced profile with claims and `source_url`s.

Its internal architecture is a model-tiered **Worker → Drone → Forager →
Queen** hierarchy (`pebble/harness.py`, `pebble/orchestrator.py`): Worker/
Drone run on Haiku for narrow sub-tasks, Forager on Sonnet for multi-source
domain analysis, Queen on Opus for final synthesis. `WorkerHarness` enforces
timeouts, retries, schema validation, and a **$0.50/prospect cost cap**.

**This is unrelated to the Claude Code dev-agent team** described in
`CLAUDE.md` (`scout`, `architect`, `backend`, `frontend`, `tester`, etc.) —
those are local, uncommitted `.claude/agents/` helpers for *building*
Bedrock. Pebble's bee hierarchy is a *shipped feature* of the product
itself. Don't conflate the two.

## Tests

- **Backend**: `pytest` from `financial_forecasting/` (config in
  `pytest.ini`, tests under `financial_forecasting/tests/`).
- **Pebble**: `pytest` from `pebble/` (tests under `pebble/tests/`, with
  fixtures like sample IRS 990 XML).
- **E2E**: `npx playwright test` from the repo root, against a running app
  (`tests/*.spec.ts`, config in `playwright.config.ts`).
- **CI**: there isn't one yet. `.github/BRANCH_PROTECTION.md` documents
  manually-configured branch protection (PR review + CODEOWNERS) on
  `main`/`dev`, and explicitly notes that automated status checks are for
  "later." Don't expect a CI gate to catch what your own test run doesn't.

## Salesforce & Sage, concretely

- **Salesforce** is the pipeline system of record (Opportunities, Accounts,
  Contacts). The backend connects with a service-account
  username/password/security-token via `simple-salesforce` — flagged in
  `DEV_SETUP_GUIDE.md` as the fragile piece, with a recommended migration to
  JWT Bearer/certificate auth. Live org stage values have drifted from the
  canonical enum (13 canonical vs. 22 observed) — tracked in
  `tasks/stage-schema-drift.md`.
- **Sage Intacct** is the accounting/invoicing system. The custom SF object
  `Sage_Invoice__c` (`salesforce_metadata/objects/Sage_Invoice__c.object`,
  documented in `product/reference/salesforce-sage-invoice-object.md`) is a
  master-detail junction linking one Opportunity to many Sage invoices.
- Full reference set: `product/reference/sage-intacct-setup.md`,
  `sage-intacct-credentials.md`, `sage-dimensions.md`, `sage-master-data.md`,
  `sage-salesforce-linking.md`, `automatic-payment-sync.md`,
  `payment-schedule-workflow.md`.

## Documentation map

See `CLAUDE.md`'s "Documentation Map" section for the full index — it's
accurate and every path in it exists. The two things worth flagging up
front:
- `PRD.md` (root) explicitly marks itself partially superseded — defer to
  `product/crm-architecture/canonical-definitions.md` for current stage
  enums and naming. **If any doc conflicts with `canonical-definitions.md`,
  that file wins** — check it before inventing new field/enum names.
- For the Jobs feature specifically, `financial_forecasting/` has a
  cluster of `JOBS_*.md` docs at different granularities — read in this
  order: `JOBS_QUICKSTART.md` (zero-to-running) →
  `JOBS_ONBOARDING.md` (setup + data model) → `JOBS_HANDOFF.md` (API/data
  contract). Don't duplicate content into a new doc; extend one of these
  (per `docs/DOCUMENTATION-HYGIENE.md`).

## Gotchas

1. **The repo root's own README/pyproject.toml/requirements.txt describe a
   different project.** They document the standalone `mcp_client` MCP
   connector library (`pyproject.toml` even names it
   `"pursuit-mcp-client"`), not Bedrock. Don't onboard from the root
   README expecting app setup instructions — go straight to
   `financial_forecasting/DEV_SETUP_GUIDE.md`.
2. **`DATABASE_URL` has zero fallback, on purpose.** A real incident
   (2026-04-17, see `tasks/notes-2026-04-17-jac-review.md`) happened when a
   dev without `DATABASE_URL` set silently wrote to a stray local Postgres
   while teammates worked against the shared DB. Now, if it's unset, every
   DB route just 503s instead of guessing. Get the real connection string
   from a teammate.
3. **Migrations are split across three directories**: root `db/migrations/`
   (most active, dozens of dated files), `financial_forecasting/migrations/`,
   and `financial_forecasting/db/migrations/`. Confirm which one a change
   belongs in before adding a migration — don't assume.
4. **Jobs feature: go through the API, never the tables.** Per
   `financial_forecasting/JOBS_HANDOFF.md`, dashboard numbers depend on
   reconciliation logic behind the `/jobs*` endpoints — don't query
   `employment_records`/`job_applications`/`contacts` directly.
5. **Two auth layers, easy to conflate**: Google OAuth is user login to the
   dashboard (JWT session). Salesforce OAuth (per-user "Connect Salesforce"
   in Settings) is separate from the Salesforce *service account* the
   backend uses for all SOQL/sync calls — the service account is the piece
   being migrated to JWT Bearer.
6. **One git submodule**: `.gitmodules` declares
   `.claude/skills/gstack` (an external Claude Code skill repo) — unrelated
   to product code, but run `git submodule update --init` on a fresh clone
   or it'll sit empty.
7. **Large/generated files are committed at repo root** (e.g.
   `export_log.txt`, `invoice_opportunity_matches.json`) — don't assume the
   root is clean of export/build artifacts when it's your turn to add one.

## Suggested first read order

1. `product/README.md` — product context and doc hierarchy.
2. `financial_forecasting/DEV_SETUP_GUIDE.md` — get it running.
3. `product/crm-architecture/canonical-definitions.md` — the naming/enum
   rules that govern everything else.
4. `CLAUDE.md` — how development on this repo is organized (plan mode,
   subagent workflows, task tracking conventions).
5. Whichever PRD in `product/crm-prds/` or `financial_forecasting/JOBS_*.md`
   matches the area you're about to work in.
