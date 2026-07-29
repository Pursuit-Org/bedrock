# Jobs Scan — monitoring warm companies for builder-fit roles

**Status:** design, pending review (Jac)
**Author:** Kwame (with Claude Code)
**Date:** 2026-07-29

Automated monitoring of companies where Pursuit has a warm relationship, to
catch every open role a builder could plausibly land — plus recurring checks so
we see new postings shortly after they go live.

---

## 1. Why the existing scraper is not the starting point

`program-analytics/job-scraper` (Jac, Apr 2026) ran **once** — 30 rows into
`public.job_postings` with `source='job_scraper'` on 2026-04-20 — and stopped.
Reviewing that output explains why, and the failure modes are structural rather
than bugs to patch:

| Symptom | Actual row |
|---|---|
| Company extraction failed outright | `company_name = "Entry Level"` |
| Domain truncated into a name | `"Employer Com"`, `"Impact Com"` (impact.com) |
| Location bled into the title | `"Business Analyst in New York, United States"` |
| Snippet artifact | `"Data Analys (Entry / Junior Level)"` |
| Single salary read as a range | `salary_min = salary_max = 90000` |
| Score compression | **12 of 14 rows scored exactly 80.0** |
| Wrong geography | `"Billerica, MA"` from an NYC-targeted search |
| Staffing-agency noise | `"Gigalabs (Pvt) Ltd."`, `"I3-4-SEAWEED"`, `"ATC"` |

And the decisive measurement:

> **27 distinct scraped companies. 814 warm companies. Overlap: 0.**

The scraper surfaced zero roles at a company we have a relationship with.

**The reason is architectural.** That scraper is *query-first*: it asks job
aggregators "entry-level AI roles in NYC", then reverse-engineers the employer
from result snippets via heuristics (`_extract_company_from_description`,
`_is_plausible_company_name`, `_strip_location_suffix`). Company identity is a
lossy **output**, so it can never answer "did Acme post anything new?" — there is
no per-company coverage guarantee, no diff between runs, and the names are too
mangled to join to `public.companies`.

What we need is *company-first*: company identity is the **input**.

It also depends on the Zero CLI binary, x402/USDC micropayment rails, and a
Railway-hosted LLM gateway — three external dependencies, metered per query,
capped at `$2.50/day`.

**What we keep.** The scoring layer is the real IP and it ports cleanly:
- `llm_scorer.py` → `BUILDER_PROFILE` (the can-do / cannot-do curriculum
  inventory). Genuinely good, reusable nearly verbatim.
- `config.py` → `ROLE_SIGNALS`, `BUILDER_SKILLS`, `JUNIOR_SIGNALS`,
  `SENIOR_SIGNALS`, `DISQUALIFYING_SKILLS`, `MANAGER_EXCEPTIONS`.
- `scorer.py` → cheap keyword pre-filter, to gate LLM spend.
- `db_writer.py` → salary parsing and the three-key dedup approach.

We drop the aggregator fetch layer, the company-name heuristics, and the Zero
dependency. The LLM call moves to OpenRouter (the project standard).

---

## 2. Approach

**Forward lookup by ATS slug.** Every major ATS exposes an unauthenticated JSON
endpoint keyed on a company "slug". One GET returns that company's whole board:

| Platform | Endpoint |
|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` |
| Lever | `api.lever.co/v0/postings/{slug}?mode=json` |
| Workday | `{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` (POST) |

Why this fits the ask, point for point:

- Company identity is exact — we asked for that slug, so joins are reliable.
- Coverage per company is complete, not whatever a query surfaced.
- Free and unauthenticated. No per-query budget.
- `(platform, slug, external_job_id)` is a stable key, so "new since last run"
  and "closed" fall out of a set diff instead of needing fuzzy matching.

### Considered and rejected

| Option | Why not |
|---|---|
| Revive the aggregator scraper | Wrong shape (§1) |
| Buy a jobs API (Coresignal / Adzuna / JSearch) | Costs money and still matches on company *names*, reintroducing the identity problem. Reasonable fallback for the non-ATS tail |
| Reverse discovery (titles/descriptions → new companies) | Solves a *different* problem — finding companies we don't know yet. Genuinely valuable, but phase 3; it does not serve "monitor our warm list" |

---

## 3. The seed list already exists

`public.contacts.tags` (`text[]`) against `bedrock.contact_tag_catalog`, joined
to the contact's employer:

| Tag | Distinct companies |
|---|---|
| `other_hiring_partner` | 234 |
| `volunteer_historical` | 622 |
| `tristate_smb_leaders` | 176 |
| `volunteer_current` | 69 |
| `prior_commit_partner` | 23 |
| `board` / `opboard` | 20 |
| `ciso_council` | 4 |

**814 distinct warm companies**; ~500 in the tight tier (excluding
`volunteer_historical`).

**Derive the employer domain from the contact's work-email domain, not by
name-matching.** Joining `contacts.current_company` to `companies.name` resolves
a domain for only **10%** (50/496) — `current_company` is free text. Email domain
resolves **242**, ~5× better. This matters because the domain root is the single
best slug predictor (`redcanary.com` → `redcanary`).

### Data-quality issues the seed must survive

Observed in the live data; the resolver has to handle all of these:

- **One company, several domains** — Ballistic Ventures ×3
  (`ballisticventures.com`, `ballisticvc.com`, `teneightcyber.com`); Goldman
  Sachs (`gs.com`, `goldmansachs.com`); Southwest (`wnco.com`, `southwest.com`).
- **Stale employer on the contact** — a contact who has since moved carries the
  old address: Uber → `c4q.nyc` (our own former domain), Morgan Stanley →
  `gs.com`, Walmart → `servicenow.com`, Rally Health → `uhc.com`.
- **Typos** — `icaptital.com`, `nationagrid.com`.
- **Name variants** — "Thumbtack" / "Thumbstack" (both → `thumbtack.com`).
- **Not a company** — "Mobile/ Android App creation opportunity".

This is why the watchlist is **curated, not derived**: auto-propose from tags,
require a human confirm. Per `CLAUDE.md`, resolve before create.

### Honest coverage expectation

The warm list skews hard to **enterprise finance** (Citi, Blackstone, Goldman,
JPMC, BlackRock, Morgan Stanley, UBS, Vanguard, Prudential, AIG, MetLife),
**large enterprises** (3M, AbbVie, Delta, UPS, ServiceNow, Visa, Mastercard,
Capital One) and **foundations/nonprofits** (`.org`). Those run Workday, Taleo
and iCIMS — not Greenhouse/Ashby/Lever. VC firms (a16z, USV, KKR, Vista) post
few roles of their own.

The tech/AI-native slice that resolves well to the three easy platforms —
Airtable, Braze, Attentive, Algolia, SeatGeek, Yext, DoorDash, Etsy, Cloudflare,
MongoDB, Squarespace, Spotify, Pinterest, Thumbtack, GlossGenius, Spring Health,
Cedar, Flatiron Health, Nova Credit, Teachable, Skillshare, Foursquare, Transfix,
DailyPay, Relativity, AuditBoard, Outreach, Promptfoo, Forethought.ai — is
roughly **60–90 companies**.

So: expect **25–35%** coverage from Greenhouse+Ashby+Lever, and treat **Workday
as required, not optional**, given the enterprise skew. Plan for a manual tail
rather than pretending it is covered. The spike (§7) replaces these estimates
with measurements.

---

## 4. Architecture

Two-tier, because `public.job_postings` is a curated human surface (179 rows,
`is_shared`, `builder_interest_count`, feeding Pathfinder). Writing hundreds of
raw scraped rows into it directly would wreck it — Jac's single run already put
30 polluted rows there.

```
bedrock.jobs_watch_company     the watchlist (curated)
  └─ jobs_watch_board          n boards per company (platform, slug)
        │  weekly/daily scan (Cloud Run Job)
        ▼
bedrock.scraped_job_posting    firehose + diff + score + triage
        │  human approves in the Jobs Scan tab
        ▼
public.job_postings            curated board (source='ats_scan') → Pathfinder
```

`bedrock.*` is writable by `bedrock_user`; `public.job_postings` is written only
through a `SECURITY DEFINER` function. Promotion mirrors the existing
`bedrock.sync_role_to_pathfinder(uuid)` pattern rather than inventing a new path.

**`jobs_watch_board` is a separate table on purpose.** ATS migrations are real,
and the failure is silent: a company moving Greenhouse→Ashby leaves the old
board returning `200` with an **empty list, not a 404**. Keeping boards as rows
lets us retain the old one, mark it stale, and detect the migration instead of
reading it as "no open roles".

### Runner

A `jobs_scan.py` entrypoint modeled on the existing `nightly_sync.py`, deployed
as a **Cloud Run Job on Cloud Scheduler** — the established pattern here. (There
is no `.github/workflows/` in this repo; scheduling lives in GCP.)

Per-run stages: `resolve slugs → fetch boards → normalize → diff vs last run →
keyword pre-filter → LLM score → upsert → flag warm contacts`.

### Warm-contact surfacing (read-only)

When a scan finds a fitting role at a watched company, the triage row shows the
contacts we already know there — "we know 3 people at Acme, incl. 1 Hiring
Partner" — and **writes nothing to the funnel**. A human decides.

Worth noting: `bedrock.jobs_contact_membership.activation_reason` **already
reserves the value `'scraper_job'`**. Someone anticipated exactly this wiring, so
when we do want to auto-activate a contact from a scraper hit, the schema is
ready. We are deliberately not switching it on in v1 — this is a shared
production funnel and a bad first run is hard to undo.

---

## 5. Fit criteria — configurable, and deliberately wide

Criteria must be **editable without a deploy**, so they live in the DB
(`bedrock.jobs_scan_criteria`, one row per named profile, `JSONB` body,
versioned) rather than as constants in `config.py`. Every score records the
`criteria_version` that produced it, so results stay attributable when the
profile changes.

Bias to **recall**, per the playbook's hardest-won lesson: hard-kill title
regexes silently ate good postings twice. So — **surface-with-a-flag rather than
drop when ambiguous, and count every kill by reason.** A drop counter that nobody
reads is how "we covered everything" becomes false.

### v1 profile: `builder_wide`

**Compensation** — $50,000–$120,000 band. A missing salary is **not** a
rejection (most postings omit it); flag as `comp_unknown` and let it through.

**Geography** — any of:
- NYC metro (the existing `NYC_METRO_KEYWORDS` list)
- Remote / hybrid / distributed
- **Anywhere on the East Coast**: ME, NH, VT, MA, RI, CT, NY, NJ, PA, DE, MD,
  DC, VA, NC, SC, GA, FL

**Role families** (union — cast wide):
1. **Jac's 12 builder families** — AI adoption/ops, product associate, customer
   success, AI-native developer, GTM engineer, SDR/BDR, data & analytics,
   marketing, QA, HR/people ops, design, finance ops.
2. **Forward-deployed / implementation** — Forward Deployed Engineer, AI
   Implementation Engineer, Solutions Engineer, AI Solutions, Implementation
   Consultant, Deployment Engineer, Technical Consultant.
3. **Entry-level marketing, operations, project management.**
4. **"Automatable via AI"** — deliberately *not* a title list. Expressed as an
   LLM judgment: *"could someone trained to work fluently with AI tools do the
   core of this job, even if the posting doesn't mention AI?"* This is the
   criterion most likely to surface roles a title regex would never match, and
   it only works as a semantic test.

**Seniority** — keep bare IC and junior titles; kill
`senior|staff|principal|lead|director|VP|head of|chief` and `5+ years`, with
`MANAGER_EXCEPTIONS` preserved (Product/Project/Account/Program Manager are IC
titles, not people-management).

### Fixing the score compression

12 of 14 rows scoring exactly 80.0 means the previous rubric did not
discriminate, so the `>=70` threshold filtered nothing. Two changes:
- Require **per-dimension evidence** (a quoted span from the posting) for each
  sub-score, not just a number.
- Calibrate against a **labeled fixture set** — hand-label ~40 postings
  (good/borderline/bad) and treat rubric changes as a regression test, mirroring
  the playbook's comp-extraction test suite.

---

## 6. Schema sketch

Idempotent, dated file in `financial_forecasting/db/migrations/`, following the
`2026-07-08-jobs-contact-membership.sql` conventions (guarded `DO $$` blocks for
CHECKs, `IF NOT EXISTS` throughout, explicit `GRANT`s to `bedrock_user` and
`jobs_dev`). **For Jac to review and apply — no DDL from me.**

```
bedrock.jobs_watch_company
  account_key      text PK        -- lower(trim(name)), matches jobs_account
  display_name     text
  domain           text
  tier             text           -- warm_partner | monitored | prospect
  why_watched      text
  source_tags      text[]         -- tags that proposed it
  owner_email      text
  criteria_profile text           -- FK-ish → jobs_scan_criteria.name
  active           bool
  created_at / updated_at

bedrock.jobs_watch_board
  id               uuid PK
  account_key      text → jobs_watch_company
  platform         text           -- greenhouse | ashby | lever | workday
  slug             text
  status           text           -- verified | unverified | stale | migrated
  verified_at / last_scan_at / last_scan_status
  consecutive_empty_scans int     -- climbing => suspect a migration
  UNIQUE (platform, slug)

bedrock.scraped_job_posting
  id               uuid PK
  account_key      text
  platform / slug / external_job_id     -- UNIQUE together
  title / location / url / description
  salary_min / salary_max / comp_confidence
  posted_at
  first_seen_at / last_seen_at / closed_at   -- diff surface
  score / classification / matched_family / reasoning / criteria_version
  drop_reason      text           -- why it was filtered, for the counters
  triage_state     text           -- new | approved | rejected | promoted
  promoted_posting_id int          -- → public.job_postings.id
```

Closed detection: rows for a board that are absent from a successful scan get
`closed_at` set. A **failed** scan must never close anything — otherwise one
403 marks a whole company's roles dead.

---

## 7. Phasing

**Phase 0 — reachability spike (blocking).**
`financial_forecasting/scripts/ats_reachability_spike.py`. Read-only; pulls the
warm list from the DB, generates slug guesses, probes the three easy platforms
concurrently, reports resolution rate and writes a per-probe CSV.

> **Not yet run.** Greenhouse, Ashby and Lever all return `403` from the Claude
> Code sandbox, via both `curl` and WebFetch. Three unrelated vendors returning
> an identical 403 means *our egress* is blocked, not that the endpoints are
> dead — but it is unproven, and datacenter IPs do get bot-walled, which is a
> genuine risk for Cloud Run. The script distinguishes "never reached" from "no
> board found" precisely so a partially-blocked run cannot masquerade as a
> coverage result.
>
> Run it from a normal network:
> ```bash
> cd financial_forecasting
> python3 scripts/ats_reachability_spike.py --smoke          # 6 known companies
> export DATABASE_URL=$(gcloud secrets versions access latest \
>     --secret=jobs-dev-database-url --project=pursuit-ops)
> python3 scripts/ats_reachability_spike.py --limit 40       # real warm list
> ```
> If Cloud Run egress turns out to be blocked, the fetch layer goes through a
> proxy (Bright Data Web Unlocker or similar). That is a fetch-layer swap, not a
> redesign — every other part of this holds.

**Phase 1 — watchlist + scan, backend.** Migration; slug resolver; the three
fetchers; `jobs_scan.py`; Cloud Run Job. Success: a scheduled scan populates
`scraped_job_posting` for the resolved companies with a correct new/closed diff.

**Phase 2 — scoring + triage UI.** Port the builder profile to OpenRouter,
DB-backed criteria, calibration fixtures, `/api/jobs/scan/*` endpoints, and a
"Jobs Scan" tab in `Jobs.tsx` following the Outreach patterns (Toolbar, Filters,
ColumnChooser, SavedViewsPicker). Approve → promote into `public.job_postings`.

**Phase 3 — Workday + the tail.** Workday fetcher with explicit per-company
tenant/site config (mandatory for the enterprise slice), then reverse discovery
for net-new companies, and optionally builder-level matching via
`bedrock.builder_job_profile` (37 rows) closing the loop with
`builder_interest_count`.

---

## 8. Open risks

1. **Egress / bot-walling (highest).** Unresolved; gates phase 1. See phase 0.
2. **Coverage below expectation.** If the spike returns <20% on the three easy
   platforms, Workday moves into phase 1 and the value case rests on it.
3. **Slug rot.** Companies change ATS and the old board returns `200 []`.
   Mitigated by `consecutive_empty_scans` and periodic re-verification.
4. **Enterprise boards are huge.** A single large board can carry 400+ roles;
   the keyword pre-filter must gate LLM spend, not the reverse.
5. **Shared production DB.** All writes land in `bedrock.*` behind a human
   triage gate; the funnel is untouched in v1.

## 9. Open questions for Jac

1. `bedrock_user` write grants for the three new tables — and are you happy
   extending the `sync_role_to_pathfinder` pattern with a second `SECURITY
   DEFINER` promote function for `source='ats_scan'`?
2. New Cloud Run Job + Scheduler entry, or fold the scan into `nightly_sync.py`?
   (Separate is cleaner — different cadence and failure domain.)
3. Do the 30 existing `source='job_scraper'` rows in `public.job_postings` get
   cleaned up, given the quality issues in §1?
4. OpenRouter key availability for the scoring pass, and a rough budget ceiling.
