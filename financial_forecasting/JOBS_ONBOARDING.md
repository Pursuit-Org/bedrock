# Jobs Pipeline — Onboarding for Avni & Damon

Welcome — you're taking over the **Jobs Pipeline** tool. This guide gets you
running locally on the right branch and walks you through the data model so you
can build confidently. Budget ~1–2 hours for Day 1.

## The three docs (read in this order)

1. **This file** — get set up, understand the lay of the land, first tasks.
2. **`JOBS_HANDOFF.md`** — the reference: full data model, the 42-endpoint API
   contract you build against, and the Do/Don't rules. Keep it open while you work.
3. **`DEV_SETUP_GUIDE.md`** — general app setup (env vars, auth, ports). You only
   need the env section for Day 1.

**The one rule that matters most:** you own the **frontend and the API
consumption**. You build against the `/api/jobs/*` endpoints — you do **not**
query or write to the database tables directly, and you don't change the schema.
The dashboard numbers depend on reconciliation logic that lives *behind* the API
(distinct-builder counting, paid-only filters, the activity link). Bypass it and
you'll silently get wrong counts. Need data the API doesn't expose? Ask for a new
endpoint (see "Who to ask").

---

## 1. What this tool is

A CRM-style pipeline for the jobs/employer team, at `/jobs` in the app. Three tabs
(`frontend-v2/src/pages/Jobs.tsx`):

- **Performance** (default) — leadership metrics, funnels, placements. The "North
  Star" numbers live here.
- **Opportunities** — day-to-day deal management (the kanban/list + expand panels).
- **Prospects** — employer-contact management.

Backend is FastAPI in `financial_forecasting/routes/jobs.py`. Frontend is React +
TypeScript + Tailwind in `financial_forecasting/frontend-v2/`.

---

## 2. Get set up (Day 1)

### a. Get on the right branch

All jobs work lives on **`feat/jobs-pipeline`** — it is **not merged to `main`** yet.
Always branch *from* it.

```bash
git clone <repo-url> bedrock         # if you don't have it
cd bedrock
git fetch origin
git checkout feat/jobs-pipeline
git pull
# create your own working branch off it for any change:
git checkout -b jobs/<your-feature>  # e.g. jobs/opps-filter-tweak
```

### b. Environment

Follow `DEV_SETUP_GUIDE.md` for the full `.env`. The three that matter for the
jobs page locally:

- **`DATABASE_URL`** — points at the shared Postgres (`segundo-db`). Required; the
  app has no local-DB fallback. **Ask Jac for the value** — use the shared DB, do
  not stand up your own.
- **`JWT_SECRET_KEY`** — `openssl rand -hex 32` (any value works locally, but it
  must match between restarts to keep your login session).
- **`VITE_API_URL`** — leave unset for local; Vite proxies `/api/*` → `:8000`.

**Cloud SQL allowlist:** to reach `segundo-db` from your laptop, your public IP
must be on the instance's *authorized networks*. **Send Jac your IP** (`curl
ifconfig.me`) and she'll add it. Until then the backend starts but every DB route
returns 503.

### c. Install + run

First complete [Clone and install in the developer guide](DEV_SETUP_GUIDE.md#1-clone-and-install)
using Python 3.11+ and `.venv`, including the hash-pinned pip bootstrap.

```bash
# activate the backend environment prepared above
cd financial_forecasting && source .venv/bin/activate
# frontend deps
cd frontend-v2 && npm install && cd ..

# run both (backend :8000, frontend :4200) — persists across terminal close
./dev.sh
# stop with:
./dev.sh stop
```

Open **http://localhost:4200** → log in with your `@pursuit.org` Google account →
go to **/jobs**.

### d. Gotcha that will bite you (it bit us)

If you restart the backend and the page shows **stale data / old behavior**, you
probably have a **leftover process still holding port 8000** — the new one fails
to bind and the old one keeps serving old code. Symptom: code changes don't show
up no matter how many times you restart. Fix:

```bash
./dev.sh stop
lsof -ti :8000 | xargs kill -9    # nuke any straggler
./dev.sh
```

Verify you're on fresh code by hitting an endpoint and checking the data shape
matches what you just changed.

---

## 3. The page ↔ code map

| You see (UI) | Frontend | Calls API | Backend |
|---|---|---|---|
| Performance tab | `pages/jobs/JobsLeadership.tsx` | `useContactsSummary`, `useJobRoles`, `usePlacements`, `useMetricDrill` | `/contacts/summary`, `/roles`, `/placements`, `/metrics/{key}` |
| Funnels (3-switcher) | `components/jobs/JobsFunnels.tsx` | `useJobsFunnel` | `/funnel/{opportunities\|prospects\|builders}` |
| Metric drill-downs (side panel) | `components/jobs/MetricDrawer.tsx` | `useMetricDrill` | `/metrics/{key}` |
| Opportunities tab | `pages/jobs/JobsTeam.tsx` | `useJobsOpportunities`, `useUpdateOpportunity`, … | `/opportunities*` |
| Prospects tab | `pages/jobs/JobsContacts.tsx` | `useJobsContacts`, … | `/contacts*` |

- **All hooks + types** live in `frontend-v2/src/services/jobs.ts`. Start there to
  see every endpoint and its TypeScript shape.
- **Reusable building blocks** already built: `MetricDrawer` (generic drill with
  inline-edit + expandable rows), `JobsFunnels`, `StaffPicker`/builder pickers,
  inline-edit patterns. Reuse these before building new ones.

---

## 4. Data model walkthrough

Read `JOBS_HANDOFF.md` §2 for the authoritative table. Here's the guided tour —
the mental model and the parts that trip people up.

### The 5 concepts

1. **Opportunity** (`bedrock.jobs_opportunity`) — an employer deal moving through
   stages. Jobs-team-owned table. Key fields: `stage`, `deal_type`,
   **`owner_email`** (the one staff owner), **`builder_ids[]`** (integer builder
   user_ids linked to the deal — *not* staff).
2. **Prospect** (`public.contacts` where `is_jobs_contact=true`) — employer
   contacts. This is a **shared** table; only the flagged rows are ours.
   `contact_stage` = lead / initial_outreach / active / on_hold.
3. **Builder application** (`public.job_applications` where
   `source_type='Pursuit_referred'`) — the *submission* funnel: applied →
   interview → accepted. Shared table; ~70 rows are ours, 600+ are builder
   self-logs we ignore.
4. **Placement / secured job** (`public.employment_records`) — **the single source
   of truth for who actually got hired.** Shared. `influenced` = jobs-team vs
   self-sourced. `opportunity_id` links a placement back to its won deal.
5. **Activity** (`bedrock.activity`) — emails / calls / meetings. Written by manual
   logging *and* the nightly Gmail/Calendar sync.

### The thing to internalize: there are TWO pipelines, and they're different lenses

- **`job_applications`** = *did we put a builder forward?* (submission)
- **`employment_records`** = *did a builder actually get a paid job?* (outcome)

A jobs-team FT hire shows up in **both** (an accepted application **and** an
influenced FT employment_record). That's the intersection, **not** a duplicate.
The Performance "Hired" cards come from **placements** (employment_records); the
"Interviewing / Applied" rows come from **applications**.

### The 5 counting rules baked into the API (don't re-derive these in the frontend)

1. **Placements are counted by DISTINCT BUILDER, not by job.** A builder with 2
   part-time gigs = **1** placement. (This is why you'll see *more* placement
   *rows* than the headline *count* — see rule 5.)
2. Two headline numbers: **Builders Placed FT** (distinct builders with any paid
   full-time record) and **In any paid work** (distinct builders with any paid
   record). FT is a subset of "any paid."
3. **FT vs Other Paid:** `employment_type='full_time'` → FT; `contract` /
   `freelance` → "Other Paid" (anything paid that isn't full-time). `pro_bono` is
   *not paid* and doesn't count.
4. **Influence:** a placement is "jobs-team influenced" if it's linked to a
   Pursuit-referred application or a won deal; otherwise self-sourced (or, for
   historical rows, unclassified).
5. **Count vs show:** the headline **counts** only include placements with a
   recorded dollar amount (`payment_amount > 0`), but the **tables show every
   placement**, including paid work where the amount hasn't been entered yet. So
   "11 builders" (card) next to "36 placement rows" (table) is intentional, not a
   bug. The caption under the cards explains it.

### Owner vs builders on a deal (a real gotcha)

`owner_email` = the single staff owner. `builder_ids[]` = the builder user_ids on
the deal. They are **different things** — never put staff in `builder_ids`. (The
original Airtable import wrongly loaded staff emails there; that was cleaned up,
backup in `db/migrations/_builder_ids_dealteam_backup_2026-06-08.json`.)

### Activity → prospects link (powers Engaged / Outreach / Calls)

The nightly Gmail/Calendar sync writes activity, then resolves each row to a jobs
prospect by email match (`participant_public_contact_id`). That's what makes the
**Engaged** / **Outreach** / **Calls** metrics reflect real scraped activity. The
linker is `services/jobs_activity_link.py`, run after every sync. You won't touch
this — just know the metrics are activity-driven, not hand-entered.

---

## 5. Making changes safely

**Do**
- Build against the endpoints in `JOBS_HANDOFF.md` §3. Trust the counts they return.
- Reuse `MetricDrawer`, `JobsFunnels`, the pickers, the inline-edit patterns.
- Run `npx tsc --noEmit` in `frontend-v2/` before you commit — it catches most issues.
- Branch off `feat/jobs-pipeline`; open PRs back into it.

**Don't**
- ❌ Write SQL or hit `employment_records` / `job_applications` / `contacts` directly.
- ❌ Re-implement placement / hired / FT-vs-Other counting in the frontend — use
  `/placements` and `/roles`.
- ❌ Add/alter DB columns or the `bedrock.secured_jobs()` / `search_builders()`
  functions (they bypass row-level security and are load-bearing). Request schema
  changes; don't make them.
- ❌ Re-run the Airtable import scripts in `scripts/` — they're not idempotent and
  caused the duplicates we cleaned up.

---

## 6. Good first tasks (safe, useful, get you oriented)

- **Classify influence** on the ~17 placements with `influenced = null` — use the
  existing inline editor in the placements drill. Pure data entry; teaches you the
  drill UI.
- **Fill ownerless deals** — ~8 opportunities have no `owner_email` and ~3 no
  `deal_type`. Set them via the Opportunities tab inline editors.
- **Decide the pro_bono display** — pro_bono placements are currently hidden from
  the "Other Paid" table (they're unpaid). If the team wants them visible (marked
  $0), that's a small `/roles` + table tweak. Good first end-to-end change.

---

## 7. Who to ask

- **Data questions, "what does this number mean", new endpoints** → **Jac**.
- **Schema / migrations / the data model** → the data owner (Jac for now). These
  are not yours to change — request them.
- **App setup / auth / env** → `DEV_SETUP_GUIDE.md` first, then the team.

You've got this. Start by getting it running (§2), click around `/jobs`, then read
`JOBS_HANDOFF.md` end to end.
