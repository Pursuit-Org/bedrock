# Jobs: estimated jobs, jobs projection chart, Jobs targets page

Requested by Kwame, 2026-09-29. Branch `claude/charming-maxwell-z9lsbr` (no PR yet).
Status: **built on the branch (2026-09-29); migrations pending Jac.** See Review at the bottom.

## Findings that shape the design

- **Target close dates are nearly empty.** 1 of 80 open opportunities has one
  (`bedrock.jobs_opportunity.target_close_date`, nullable). Requiring it applies to new
  opportunities only. The chart needs a "No close date" bucket until the backlog is filled.
- **`num_roles` can't hold the estimate.** Moving a deal to Opportunity Confirmed makes
  `CommittedRolesModal` overwrite it with the number of roles typed, and it disagrees with
  the committed-role count on 26 deals. A new `estimated_jobs` column is needed.
- **Confirmed jobs already exist as rows.** `bedrock.jobs_role`, one row per seat:
  `commitment` is `committed | open_market` and `status` is `open | filled | cancelled`.
  86 roles are spread across 19 open deals.
- **Jobs targets are hardcoded.** `services/outreach_targets.py` holds weekly per-owner
  targets (outreach, calls, discovery). Team targets are either summed from owners or set
  directly (accounts activated 20/wk, converted 2/wk). The file's own docstring says to move
  it to a table.
- **The Jobs team is hardcoded.** `JOBS_TEAM_EMAILS` (Avni, Damon, Devika) sits in
  `routes/jobs.py:174`, is duplicated in `services/jobs_activity_link.py:21`, and gates
  about 15 metric queries. The Owner cut lists whoever has a key in `OWNER_ACTIVITY_TARGETS`
  (the same three plus Kwame).
- **The PBD Targets tab is simpler than Jobs needs.** Settings > Targets holds FY revenue
  goals per Salesforce user in `bedrock.owner_goal`, with no team roll-up and no period
  beyond fiscal year. We reuse its UI pattern (row edit, save, delete, permission gate)
  but need our own tables.
- **Migrations wait on Jac.** The new column and tables go in
  `financial_forecasting/migrations/` for Jac to run. The code follows the existing
  `_has_column` / pending-migration pattern: until the migration lands, the UI shows
  "pending migration" and the backend falls back to today's hardcoded values.

## Phase 1: Estimated jobs + required target close date

Migration `2026-09-29-jobs-estimated-jobs.sql`:
`ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS estimated_jobs integer CHECK (estimated_jobs BETWEEN 0 AND 999)`.

- [ ] Backend
  - `OpportunityCreate` requires `target_close_date` and takes optional `estimated_jobs`.
  - The INSERT adds both, guarded by `_has_column` for `estimated_jobs`.
  - PATCH lets you change `target_close_date` but refuses to clear it once set.
  - PATCH allow-list adds `estimated_jobs`, with the same guard as `tags`.
- [ ] No `NOT NULL` in the database: 79 existing rows would fail. Required is enforced at the API and in the UIs.
- [ ] Create UIs get a required Target close date and an optional Estimated jobs input:
  - `accountTabs.tsx` AccountOppsTab
  - `JobsTeam.tsx` NewDealModal
  - `RolesBoard.tsx` AddRoleModal (new-opportunity mode)
- [ ] Where Estimated jobs shows:
  - next to Target close in the deal header strip (`DealContextStrip`);
  - an "Est. jobs" column beside Target close in the opportunity table (on by default);
  - the account Opportunities tab;
  - the opportunity detail page, which also gains the missing Target close editor.
- [ ] Salesforce handoff (`jobs_sf.py` HandoffOpportunity): default its `close_date` from `target_close_date`.
- [ ] Tests: update `tests/test_jobs_opps.py` create payloads; add a required-date test.

## Phase 2: Jobs projection chart (Jobs > Performance > Pipeline)

- [ ] `GET /api/jobs/opportunities/projection?granularity=quarter|month&deal_type=&owner=`
  - buckets by `target_close_date`;
  - returns `estimated`, `confirmed` and `target` per bucket, plus "Overdue" and "No close date";
  - each bucket drills to its deals.
- [ ] recharts grouped bars: Estimated vs Confirmed per bucket, the target as a line.
  - Quarter/Month toggle in the panel header.
  - Follows the page's deal type and owner filters.
  - Sits under the funnel.

## Phase 3: Settings > Targets > Jobs

Migration `2026-09-29-jobs-targets.sql`:
- `bedrock.jobs_team_member` (email PK, active, sort_order, added_by, timestamps)
- `bedrock.jobs_target` (metric, owner_email NULL = team, period_start date, period_kind, value, team_mode `sum|set`, audit)
- a `manage_jobs_targets` permission for Admin and Executive

- [ ] Settings > Targets gets two sub-tabs: Revenue (today's page, unchanged) and Jobs.
- [ ] **Team members**: add or remove who is on the Jobs team. This replaces
  `JOBS_TEAM_EMAILS` and the `OWNER_ACTIVITY_TARGETS` keys as the single source.
  Falls back to the hardcoded list until the migration runs.
- [ ] **Outreach section**: a weekly target per owner for the four metrics.
  - Columns: Contacts activated, Outreach activity, Calls booked, Opportunities converted.
  - A team row per metric, with a toggle between "Sum of owners" and "Set total", so a
    team target can be set while individuals stay at 0.
  - Day and month scale off the weekly figure as they do today (week ÷ 5, week × 4).
- [ ] **Pipeline section**: a jobs target per quarter, which feeds the projection chart's target line.
- [ ] `services/outreach_targets.py` reads the tables, falling back to today's constants.
  The Outreach page, Owner cut and Activity Trends pick this up unchanged.
- [ ] Tests for roll-up logic, the fallback, and permission 403s.

## Decisions (Kwame, 2026-09-29)

1. **Confirmed job** = any role created on the deal (Add Role), committed or open-market;
   cancelled roles excluded.
2. **The projection shows everything** per bucket:
   - the jobs target;
   - Closed Won jobs, by close date;
   - confirmed roles on open deals, by target close;
   - estimated roles not yet confirmed (`estimated_jobs` minus confirmed, floored at 0),
     so the stack never double-counts.

   Won jobs = roles on the won deal, or `estimated_jobs` when no roles were logged.
3. **The editable team list drives every Jobs metric.** It replaces `JOBS_TEAM_EMAILS`.
4. **"Contacts activated" = Total Accounts Activated.**

## Risks / notes

- Kwame's local DB role is read-only, so saving estimates or targets locally will fail. The UI
  and the "pending migration" states can be checked; writes need Jac's migration and a
  writable role.
- Scope is large. Commit per phase; suggest a PR per phase when ready.

## Review (2026-09-29)

Shipped on `claude/charming-maxwell-z9lsbr`, one commit per piece:
- Phase 1: estimated jobs + required target close. Migration `2026-09-29-jobs-estimated-jobs.sql`.
- Phase 3 backend: `jobs_team_member`, `jobs_target`, the `manage_jobs_targets` permission, and
  `/api/jobs/targets`. Migration `2026-09-29-jobs-targets.sql`. The team list now drives every
  Jobs metric.
- Opportunity Set redesign (added mid-session): Owner, Account, Opportunity, Stage, Target close,
  Est. jobs, Open tasks, Recent comment, Activity.
- Phase 2: the Jobs Projection chart and `/api/jobs/opportunities/projection`.
- Phase 3 UI: Settings > Targets > Jobs (Team, Outreach, Pipeline).

Verified:
- pytest shows the same failure list as `main`; 30 new tests pass.
- `tsc` and `vite build` pass.
- Headless renders with fake data: Pipeline tab, Opportunity Set, projection (quarterly and
  monthly, tooltip), and the Targets page in both states. All three Targets saves were checked
  for payload.
- Production read-only checks for the projection and comment queries.

Known and deliberate:
- Kwame's 10/wk personal outreach target isn't seeded, so the team target reads 140 until he
  joins the team.
- 6 won deals have no close date anywhere; they're reported, not plotted.
- 79 of 80 open deals have no target close date; the "No close date" bucket shows them until
  they're filled in.
