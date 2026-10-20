# PRO-106: rebuild the Monday Outreach view

Linear: https://linear.app/pursuit-org/issue/PRO-106 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16) · Due Wed 10/14 (screenshots Thu 10/15)

Goal: the Monday meeting sees who's behind and what to do next (Dave).

## Decided with Nina (10/20)

- **Why a contact is stuck:** inferred from recorded data only. The reasons, in order: a pending intro request (naming the connector), Revisit (with its date), Not a fit (with its reason). Anything else reads "No reason recorded", with a note. No schema change while D6 is open.
- **Follow-up:** a send counts as a follow-up when it reached a contact linked to an opportunity that was open at the time of the send. When an opportunity has no linked contacts, anyone at its account counts. This is the PRO-101 rollup rule (`activity_scope_ctes` → `opp_contacts`).

## What exists today (checked 10/20)

- The default period is already the last Mon–Sun week (D8). There is no "This week so far" preset. Targets scale only by preset `granularity`, so a custom range shows the weekly number.
- D17 accounts activated, PRO-102 calls counted once and D11 milestone conversion are built.
- The owner table's "Moved to outreach / assigned" has three problems: it uses the org-wide contact owner (not the Jobs owner), browser-local time, and a denominator that drops contacts.
- There is no stuck view and no new-vs-follow-up split. The backend's `split_new` is never rendered.
- Account pages' Contacts tab shows no outreach status.
- Campaigns (current first, past selectable) live only on the Campaigns tab.
- Live (prod): 117 Operation 35 contacts, 36 at Assigned. There are 19 intro requests, 0 pending.

## Plan

### Backend
- [x] A. `outreach_targets.target_for_window`: weekly × weekdays/5. Summary, scorecard and by-owner use it for date ranges.
- [x] B. `outreach_counting.split_follow_ups` + `jobs_metrics.open_opportunity_contacts_sql`. The split goes in the summary and by-owner, and is registered as a measure.
- [x] C. By-owner: accounts activated per owner, and conversions against personal targets.
- [x] D. `GET /api/jobs/outreach/stuck`: assigned → reached out → call booked per Jobs owner, by campaign, with reasons. Plus a list entry.
- [x] E. `GET /api/jobs/account-prospects` gains stage, Jobs owner, last activity and opportunities.
- [x] F. Converted drill rows carry their opportunities.

### Frontend
- [x] PeriodBar "This week so far". The Outreach page always sends dates.
- [x] Summary cards: team target red/green, the new/follow-up line, Converted → opportunity links.
- [x] Each person vs target: four measures, red/green, Targets link. Remove the broken assigned column.
- [x] `OutreachStuck` section with a clickable per-reason list.
- [x] Campaign progress (`TagCampaigns`) on the page, saying it covers all time.
- [x] The account Contacts tab shows stage, owner, last activity and opportunities.
- [x] Every widget that ignores a filter says so. `JOBS_TEAM_PINNED` follows D7.

### Verify
- [x] pytest, typecheck, lint, node tests.
- [x] Cross-check Operation 35 stuck numbers and new + follow-up = outreach against prod SQL.
- [x] Browser walk-through and screenshots.

## Review (10/20)

**Built**: everything in the plan, on the working tree (not committed yet).

**One change from the plan.** The stuck view's owner is the pipeline owner, **else the contact's owner**. On prod only 7 of 117 Operation 35 memberships name an owner, while 115 contacts do. By membership alone, nearly everyone read "Unowned".

**Checked on real data (prod, read-only):**
- Operation 35, team scope: 107 contacts (Devika 66, Avni 29, Damon 12). That matches the per-owner contact counts; the other 10 belong to Kwame, David, Stefano, Nick or nobody. 58 reached, 29 at Call Booked or past it, 43 not reached: 35 have no reason recorded, 6 are Not a fit, 2 are Revisit. There are no pending intro requests.
- Follow-ups, week of 10/12: 41 opportunities were open. 34 of them have no linked contacts, so the account fallback decides most follow-ups. On the page, 23 sends = 18 new + 5 follow-ups.
- Converted → opportunity links: 0 of the 20 conversions since 8/1 link to an opportunity on prod (27 of 149 overall). The 10/13 link backfill is waiting for Jac, so the drill says "No opportunity linked". The link itself renders: Lily Styles → "Spring 2026 discussion".
- Targets scale: Mon–Tue reads 8 / 60 / 6 / 1 against weekly goals of 20 / 150 / 15 / 2.

**Tests:**
- pytest: the full suite passes (about 1,570 tests), including 20 new ones in `tests/test_jobs_outreach_pro106.py`.
- Node: 69 tests pass, including `tests/outreachText.test.ts`.
- `tsc` is clean.
- ESLint can't run: the repo has no `eslint.config.*`. That predates this change.
- Run `node --test tests/*.test.ts` directly: on Windows, `npm test`'s quoted glob finds 0 files.

**Browser (WSL dev servers, files copied in per lesson 10/14):**
- Default Last week; This week so far; red/green cards with goals and the follow-up line.
- Each person vs target; the stuck view by campaign, with a reason list.
- Account page contacts with stage, owner, activity and opportunity.
- Pipeline and Campaigns still render with the shared PeriodBar.

**Known, not changed here:**
- Locally the Targets store isn't loaded, so the hardcoded fallback (with Kwame, 150 a week) shows. Prod reads the store; the D7 migration (10/19) removes Kwame there. The fallback is pinned by `test_fallback_until_migration` (PRO-98).
- The reference queries assume `activity.booked_at` (PRO-102 migration, still pending on prod), like the other outreach drafts.
- The 10/15 screenshot walkthrough has passed; feedback is logged when Kwame shows it.
