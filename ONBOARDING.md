# Bedrock PBD — Youssef's Developer Onboarding

Welcome! This gets you productive on the **PBD (Portfolio / Business Development) section of Bedrock** — Pursuit's internal tool for the fundraising and partnerships side: portfolio, pipeline, awards, payments, and priorities.

## What this is

- **Repo**: `https://github.com/Pursuit-Assets/bedrock` — the app lives in `financial_forecasting/`
- **Backend**: FastAPI (Python 3.13) + asyncpg → `financial_forecasting/main.py`; PBD routes include `routes/awards.py`, `routes/projects.py`, `routes/finance.py`, `routes/payment_schedules.py`, `routes/prospects.py`, `routes/owner_goals.py`
- **Frontend**: `financial_forecasting/frontend-v2/` — Vite + React 19 + TypeScript. The PBD nav group is defined in `src/components/AppShell.tsx`: PBD Home (`/portfolio`), Dashboard, Cash Flow, Contacts, Accounts, Pipeline, Awards, Payments. (The legacy `frontend/` CRA app is dead — never deploy or edit it.)
- **Database**: `segundo-db` Postgres — schemas `public` (org-wide: contacts, companies) and `bedrock` (the app)
- **Salesforce**: the funder pipeline is *mirrored* into `bedrock.prospect_sf_*` tables by a sync. Those mirrors are **read-only for you by design** — the sync owns them, and the app never writes Salesforce directly from your code paths.
- **Prod**: Cloud Run (`pursuit-ops`) — deploys are manual via `./deploy-gcp.sh`; ask Jac before deploying.

## ⚠️ The three rules (read these twice)

1. **There is no separate dev database.** Your local backend talks to the same `segundo-db` the team uses in production. Reads are always safe. Writes are real: test write-paths with disposable records you clean up, and have Claude show you any proposed write and wait for your yes.
2. **Never create before you resolve.** Contacts and accounts are deduped across our DB **and** Salesforce. Before any create: search/resolve first, offer the match, create only on a confirmed miss. Duplicates are the team's #1 recurring data mess.
3. **No DDL — you don't change database structure.** Your role physically cannot run `CREATE`/`ALTER`/`DROP` (Postgres refuses — enforced, not honor-system). If a feature needs a schema change, write it as an idempotent SQL file in `db/migrations/` (dated filename, matching the existing style), include it in your PR, and Jac reviews and applies it.

Also: never physically merge or restructure `public.staff_contact_relationships` — the platform's Employment Engine depends on it.

## Your access, in plain terms

- **Read: everything** in `public` and `bedrock`.
- **Write: the PBD working tables** — the set the PBD pages actually edit: `project` and its link tables (`project_account`, `project_award`, `project_contact`, `project_contributor`, `project_opportunity`, `project_task`), `award` + `award_report`, `milestone` (payments/cash flow), `workstream` + `owner_goal` (priorities), `activity`, `entity_comment`, `saved_view`, `notification`, `sf_task_project`, `org_comments`.
- **Read-only by design** (not an oversight — don't request writes to these): the `prospect_sf_*` Salesforce mirrors, the jobs tables, and everything else.
- **Your one credential**, which Claude fetches at runtime and never writes to disk or commits:
  ```bash
  gcloud secrets versions access latest --secret=youssef-dev-database-url --project=pursuit-ops
  ```

## Setup

Prerequisites: `gcloud` CLI installed and authed as you (`gcloud auth login` with youssef@pursuit.org, then `gcloud config set project pursuit-ops`), and GitHub access to the repo (Jac invites `Y-E-M-AGOUR`; ask if the clone 403s).

```bash
git clone https://github.com/Pursuit-Assets/bedrock.git
cd bedrock/financial_forecasting

# assemble your .env yourself — nobody sends you secrets
cat > .env <<EOF
DATABASE_URL=$(gcloud secrets versions access latest --secret=youssef-dev-database-url --project=pursuit-ops)
JWT_SECRET_KEY=$(openssl rand -hex 32)
FRONTEND_URL=http://localhost:4200
EOF

pip install -r requirements.txt
python3 main.py                      # backend on :8000 (auto-reload)

cd frontend-v2 && npm install
npm run dev                          # frontend on :4200 (proxies /api → :8000)
npm run typecheck                    # tsc — run before every commit
```

Login locally: Google OAuth via the app, or mint a JWT with `auth.create_access_token({'email': you, 'role': 'admin'})` and set it as the `access_token` cookie.

Note: the Priorities page calendar reads the shared **PBD calendar** — the backend default `PBD_CALENDAR_ID` works out of the box; only override it in `.env` if you're deliberately testing against a different shared calendar (see `DEV_SETUP_GUIDE.md`).

**Two prompts that are normal, not errors:**
- When Claude asks permission to run the `gcloud secrets versions access …` command, that's Claude Code's built-in guard on credential retrieval — it fires by design. Approve it in the moment; don't add an always-allow rule.
- If the database connection **times out**, your network isn't on the allowlist yet: run `curl -s ifconfig.me` and send Jac the result.

## The PBD data model, in one screen

- **`project`** is the hub — a piece of portfolio work — linked to everything else through its link tables: `project_account` (funders), `project_contact`, `project_award`, `project_opportunity`, `project_contributor` (who's on it), `project_task`.
- **Money**: `award` (a grant/commitment) → `award_report` (reporting obligations) and `milestone` (payment schedule — this is what Cash Flow reads).
- **Pipeline**: `prospect_sf_account` / `prospect_sf_contact` / `prospect_sf_opportunity` — Salesforce-mirrored funder pipeline. Read freely; the sync owns writes.
- **Priorities**: `workstream` and `owner_goal` drive the Priorities page; the PBD shared calendar overlays it.
- **Shared plumbing**: `activity` + `activity_email_message` (every email/meeting, AI-classified), `entity_comment` (comments on any record), `world_model` (~3k research briefs), `pebble_*` (the fundraising research agent's tables — read-only for you).
- **Definitions**: `dd_metrics` + `dd_segments` — the team's canonical metric definitions. If your feature displays a number, its definition should live there.

## Conventions

- Branch from `main`: `feat/<your-thing>` (e.g. `feat/pbd-awards-filter`). Commit + push freely; **PRs need review before merge** — don't merge to `main`/`dev` yourself.
- `npm run typecheck` clean before pushing frontend changes; `python3 -c "import ast; ast.parse(open('routes/awards.py').read())"`-style parse check is the minimum for backend sanity.
- Keep UI consistent with the existing PBD pages (and the Filters/Toolbar/SavedViews patterns in `frontend-v2/src/pages/`).

## Starting prompt — paste this into Claude Code

> I'm Youssef, building on the PBD (portfolio/fundraising) section of Bedrock, set up per ONBOARDING.md (read it first, plus `CLAUDE.md` at the repo root and `frontend-v2/src/components/AppShell.tsx` for the PBD page map). My database secret is `youssef-dev-database-url` — assemble my `.env` per the guide, fetching the credential at runtime and never committing or displaying it.
>
> Ground rules: this is the live production database. Reads are always fine. Any INSERT/UPDATE/DELETE: show me the exact change and wait for my explicit yes, and clean up any test records we create. Never create contacts or accounts without resolving for existing matches first. Never write to the `prospect_sf_*` mirror tables or to Salesforce. Never run DDL — if a schema change seems needed, draft a migration file in `db/migrations/` for Jac instead of executing anything.
>
> Step 1: read the PBD routes (`routes/awards.py`, `routes/projects.py`, `routes/finance.py`, `routes/owner_goals.py`) and the data model section of the guide, then interview me about what I'm building — one question at a time — and propose a plan with a branch name before writing code.

## Who to ask

**Jac (jac@pursuit.org)** — access issues, migration review, PR review, deploy approval, anything Salesforce, and the PBD calendar if events don't load.
