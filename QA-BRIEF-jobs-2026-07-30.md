# QA brief — Bedrock Jobs, `feat/jobs-nav-restructure`

**For:** a fresh agent with no prior context on this work.
**Goal:** find real defects in the deploy delta before it merges to main and ships.
**Written:** 2026-07-30. Author built the branch, so this brief is deliberately a
scope + context document, not a list of things already known to work.

---

## 1. What you are testing

The delta from production (`b2d5829`) to branch HEAD — **29 commits, 39 files,
+3,578 / −1,318**. It contains five distinct bodies of work:

1. **Nav restructure** — the single tabbed `/jobs` route became 7 real routes, and
   the sidebar regrouped into PBD / Jobs / xOrg sections.
2. **Jobs Home rebuild** — was a landing page, now a per-person command center
   (assigned contacts, opportunities, roles, tasks, intro requests) with full
   inline management parity with the Pipeline tab.
3. **Dashboard restructure** — the Performance tabs (Exec view / Outreach /
   Pipeline / Placement) were rebuilt around the Monday outreach meeting and the
   Thursday pipeline meeting.
4. **Ticket fixes** — TKT-161, 135, 140, 167 (partial), plus 134 (data-only,
   already applied to prod).
5. **Kwame's PR #255** (merged into main at `85a3fe1`, so it's inside this delta):
   as-of overview reconstruction, readable pickers, copy/board polish.

Backend changes are almost entirely in `routes/jobs.py` (+747 lines) plus
`services/jobs_activity_link.py`.

---

## 2. Prerequisite: the migrations must be applied first

Five migrations gate parts of this branch. If they have not been applied, Jobs
Home's stage-entry grouping and the placement-delete endpoint will fail in ways
that are **not** bugs in the code.

```
cd ~/bedrock/financial_forecasting
python -m scripts.apply_2026_07_30_jobs_migrations          # dry run, shows state
```

The dry run prints a before/after snapshot. All six lines should read applied
(`stage-history table: yes`, `pbd_owner_name column: yes`, `employment DELETE
grant: yes`, `orphan placements 76/91: 0`, `TKT-135 test contact: 0`). If they
don't, **stop and report that** rather than QA-ing around it.

Note: dev and prod share this database. Don't write test data you wouldn't want
Avni to see in a Thursday meeting.

---

## 3. Running it

```
# backend (port 8000)
cd ~/bedrock/financial_forecasting && python main.py

# frontend (port 4200)
cd ~/bedrock/financial_forecasting/frontend-v2 && npm run dev
```

Auth is a cookie (`access_token`). A browser session on localhost:4200 is
normally already signed in as jac@pursuit.org. For direct API calls, pull the
cookie from the browser rather than minting a token.

Static gates that should stay clean:

```
cd ~/bedrock/financial_forecasting/frontend-v2 && npx tsc --noEmit && npm run build
cd ~/bedrock/financial_forecasting && python3 -m py_compile routes/jobs.py services/jobs_activity_link.py
```

---

## 4. Routes and where things live

| Route | Page file | Notes |
|---|---|---|
| `/jobs` | `pages/Jobs.tsx` | **Redirect shim only.** Maps legacy `?view=` links to the new routes |
| `/jobs/performance?tab=exec\|outreach\|pipeline\|placement` | `JobsPerformance.tsx` | Tab switches use `replace:true` — they must not stack history entries |
| `/jobs/contacts`, `/jobs/contacts/:id` | `JobsContacts.tsx`, `JobsContactDetail.tsx` | |
| `/jobs/accounts`, `/jobs/accounts/:accountKey` | `JobsAccountHub.tsx`, `JobsAccountDetail.tsx` | |
| `/jobs/pipeline` | `JobsPipeline.tsx` → `JobsTeam.tsx` | The editable deal list |
| `/jobs/placement?tab=roles\|builders` | `JobsPlacement.tsx` | |
| `/jobs/candidates`, `/jobs/network` | | `network` = My Network, moved off Jobs Home |
| Jobs Home | `JobsHome.tsx` | Reached from the sidebar "Jobs Home" |

The Performance tabs render: `exec` → `JobsLeadership.tsx`, `outreach` →
`JobsOutreach.tsx`, `pipeline` → `JobsOpportunitiesOverview.tsx`, `placement` →
a `ComingSoon` placeholder (intentional — not built yet).

**Legacy redirect map** (in `pages/Jobs.tsx`) — every one of these should land on
a working page with its query params preserved:

- `/jobs?view=performance` → `/jobs/performance`
- `/jobs?view=outreach` → `/jobs/performance?tab=outreach`
- `/jobs?view=opportunities` (also `team`, `overview`) → `/jobs/performance?tab=pipeline`
- `/jobs?view=opportunities&opps=set` → `/jobs/pipeline`
- `/jobs?view=builders` → `/jobs/placement?tab=builders`
- `/jobs?view=contacts&q=…&contact=…` → `/jobs/contacts?q=…&contact=…`
- `/jobs?view=accounts&q=…` → `/jobs/accounts?q=…`
- `/jobs` with no `?view=` or an unknown one → Jobs Home

---

## 5. Priority areas — where the risk actually is

Ordered by likelihood × consequence. Spend your time top-down.

### 5a. `JobsTeam.tsx` must be behaviorally unchanged
Home and the Pipeline dashboard now import `DealExpandPanel`, `PlacementsModal`,
`ClosedLostModal`, and `stageOptionsFor` **from** `JobsTeam.tsx` rather than
duplicating them. The intent was that the only change to that file was adding
four `export` keywords. **Verify that claim against the diff** — if anything else
in `JobsTeam.tsx` changed, that's the highest-risk finding in the branch, because
`/jobs/pipeline` is the page the team uses daily.

Then click-test on `/jobs/pipeline`: row expand, inline stage edit, and the three
gating modals still fire — `closed_won` on an `ft`/`pt_contract` deal opens
PlacementsModal; `closed_lost` opens ClosedLostModal; `active_opportunity_confirmed`
with zero roles opens CommittedRolesModal.

### 5b. Duplicated stage-save logic
`JobsHome.tsx` and `JobsOpportunitiesOverview.tsx` each have a local `saveStage`
that mirrors `DealRow.saveStage` in `JobsTeam.tsx`. This duplication was a
conscious call, with cross-reference comments both ways. **Check the three
implementations still agree** on the modal-gating conditions. A divergence means
a stage change from Home skips a modal the Pipeline page shows — silent data loss
(unrecorded placements).

### 5c. React hooks discipline
One hooks-order bug was already caught and fixed pre-merge (an early `return`
before a `useMemo` in what is now `PipelineDetails`). The same pattern may exist
elsewhere in the new zone components. Look for early returns / conditionals
above hook calls in `JobsHome.tsx`, `JobsOutreach.tsx`,
`JobsOpportunitiesOverview.tsx`.

### 5d. Soft-delete filtering in `routes/jobs.py`
The recurring bug class in this codebase: a query joins to a parent that has been
soft-deleted (`deleted_at IS NOT NULL`) without filtering it out. TKT-161 was
exactly this — deleted opportunities' placements still counted. There's a
`_live_placement(alias)` helper applied at 7 `secured_jobs()` call sites.
**Audit the new/changed queries for missing `deleted_at IS NULL` predicates**,
especially anything touching `jobs_opportunity`, `activity`, or
`employment_records`.

### 5e. Thread-level vs message-level email data
Three separate bugs in this work came from reading `bedrock.activity`
(thread-level, where `email_from` is always us) when the question needed
`bedrock.activity_email_message` (per-message, which knows who replied). Reply
detection, touch counts, and the triage queue all depend on getting this right.
**Any new query that asks "did they reply?" must use the message-level table.**

### 5f. Parameter binding in `routes/jobs.py`
Postgres rejects a parameter that is passed but never referenced in the SQL
(`could not determine data type of parameter $N`). This 500'd
`/api/jobs/opportunities/overview` during development. There's a check you can
adapt: for each `conn.fetch/fetchval/fetchrow` call, assert that the number of
args equals `max($N)` in the SQL and that every `$1..$N` is referenced. Worth
running across the whole file, not just changed lines.

### 5g. Count/drill agreement
Summary cards open side-panel drills. The cards and their drill rows come from
the **same** server query (`drills` in the overview response) precisely because
they once disagreed (a card said 10, the drill showed 1). **For every clickable
metric on Exec view / Outreach / Pipeline: click it and confirm the row count in
the panel equals the number on the card.** This is the single highest-value
mechanical check in the brief.

---

## 6. Click-through checklist

**Jobs Home** (the biggest rebuild)
- Person picker: Me / individual staff / Everyone re-scopes every zone, and the
  header chip counts match the rows actually rendered in each zone.
- Assigned contacts: the ✓ moves a contact to initial outreach, toasts, and the
  row re-groups under the green "contacted" strip rather than vanishing.
- Assigned contacts: inline membership-stage edit to On hold / Not a fit removes
  the row; inline owner reassign re-scopes it.
- Row expand → the 5-tab contact panel (activity + log form, linked opps, job
  listings, tasks, comments). One expand at a time per zone.
- Opportunities zone: sort each column asc/desc/clear (clearing returns to
  attention-first order); search + stage + attention filters compose; filter
  state persists across a page reload (session state).
- Opportunities zone: clicking the stage cell must **not** toggle the row expand.
- Roles zone: role add/edit/delete/hire inside the expand updates the flat list
  without a manual refresh. Role owner displays as the owning opportunity's owner.
- Tasks + intro requests render and are actionable.

**Performance › Pipeline** (Thursday agenda)
- Date range: the two date inputs take arbitrary dates with no snapping; both
  clamp at today; setting start after end drags end along instead of inverting.
- Arrows step by the window's own length (a 7-day Thursday window stays
  Thursday-aligned); forward is disabled when the window already ends today.
- Presets: Thu week / Week / 30d. The active one highlights.
- Every window-dependent label names the actual range — no stray "this week".
- Cards, deltas, recent activity, and drill panels all move together when the
  window changes.
- Recent activity sorts won → moved → added → lost.
- Pipeline details: defaults to group-by-priority, owner filter and
  needs-attention toggle work, scrolls inside its own container.

**Performance › Outreach** (Monday agenda)
- Page Period filter drives the whole page.
- Daily digest block renders and "Copy for Slack" produces sane text.
- "This week" ratio (contacted / assigned) and the Activity Pipeline inside it.
- "Replied — needs a decision" and "Stuck in initial outreach" — inline stage
  edit works from both.
- Target accounts awaiting activation; tag campaigns; activity over time;
  targeting mix at the bottom.

**Performance › Exec view**
- Opportunities / Contacts / Builders funnel toggle; deal-type lens is hidden on
  the contacts funnel (it's meaningless there) and present on opportunities.

**Regression sweep**
- `/jobs/pipeline`, `/jobs/contacts`, `/jobs/accounts`, `/jobs/placement`,
  `/jobs/candidates`, `/jobs/network` all load with no console errors.
- Sidebar active-state highlighting is correct on every jobs route (PBD / Jobs /
  xOrg sections).
- Browser back returns to the previous *page*, not to the main jobs tab (this is
  TKT-162; tab switches use `replace` so they shouldn't create history entries).
- Global search / top-bar search still resolve to the new routes.

---

## 7. Known and intentional — do NOT report these

- **Salesforce 401s in the console** on jobs pages. SF isn't connected in this
  environment; pre-existing, unrelated to the delta.
- **Contacts query is slow (~15s for ~836 rows)**, so "Contacted this week"
  briefly renders 0 before settling. Known, unfixed, acknowledged.
- **ActivityTrends has its own filter bar** that duplicates the page-level Period
  filter on Outreach. Known, a cleanup was offered and not yet taken.
- **"104d old, no stage change logged"** on some opportunities. Those have zero
  `jobs_stage_history` rows, so the age is time-since-creation, not time-in-stage.
  The label deliberately says so. Not a bug.
- **Conversion rates over 100% are suppressed** rather than shown. Deliberate —
  the earlier stage-population math produced a nonsense 313%.
- **"In the set" doesn't change** when the date window changes. Correct: it's the
  as-of active set at the *end* of the window, not a windowed count.
- **`Performance › Placement` tab is a ComingSoon placeholder.** Not built yet.
- **`pbd_owner_name` column exists but no PBD owner is displayed.** That's the
  unfinished half of TKT-167, waiting on the Salesforce owner sync.
- **Deal-type lens hidden on the contacts funnel** — intentional; deal type only
  applies to opportunities and placements.

---

## 8. What is out of scope for you

Whether the *numbers are right* is not your call — that's judgment only Jac and
Avni have (they run the meetings these views serve). Report internal
inconsistencies (card ≠ drill, two views of the same metric disagreeing, a total
that doesn't equal its parts), but don't try to adjudicate whether "82 in the set"
is the true figure.

Also out of scope: the seven open tickets not addressed by this branch
(TKT-130, 165, 164, 133, 125, 166, 163) and the deploy itself.

---

## 9. How to report

Rank findings most-severe first. For each: file:line, what breaks, and the
concrete input/state → wrong output. **Adversarially verify each finding before
reporting it** — try to refute your own claim first, and drop anything you can't
reproduce. A confident list of three real bugs is worth far more than twelve
plausible ones.

Flag separately anything that looks like a deliberate decision you'd have made
differently — that's a conversation for Jac, not a defect.
