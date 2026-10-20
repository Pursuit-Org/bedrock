# PRO-110: rebuild the Thursday Pipeline view

Linear: https://linear.app/pursuit-org/issue/PRO-110 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16) · Mockup: Thursday Pipeline tab

Goal: what's stuck, why, and what leadership can unblock (Dave).

## Decided with Nina (10/20)

- **Follow the mockup.** Funnels, Interviews, Time in Pipeline, the heatmap, Jobs Projection and the editable Opportunities Set leave the tab. Projection goes to Leadership (PRO-107), Interviews to Placement (PRO-111), editing stays on `/jobs/pipeline`. `JobsProjectionChart` and `InterviewsPanel` are kept but not shown anywhere until then.
- **When the check-again date passes, the opportunity is Stalled again** if it is still quiet, and the old reason is shown.
- **Slow but active is set on the opportunity page and in the `/jobs/pipeline` expanded row.** The Thursday view stays read-only.

Settled from the ticket and the code:
- **Stalled** keeps the dictionary's rule: no activity on the opportunity or its contacts, and no stage move, for 4+ weeks. The page says so.
- **Priority** is the existing 1–5 field (5 is P1).
- **Asks sent** are moves into Ask Submitted.
- **Relationship owner** is shown as recorded (D13 deferred).

## Plan

### Backend
- [x] Migration `migrations/2026-10-20-opportunity-slow-but-active.sql`: `slow_reason`, `slow_check_again`, `slow_marked_by`, `slow_marked_at`.
- [x] Closed Lost needs a reason. Moving to Closed Lost (PATCH or create) without one, or clearing it, is refused (400). Older lost opportunities without one can still be edited.
- [x] Slow but active needs a reason and a date that isn't in the past. Before the migration runs, saving it returns 409, naming the file.
- [x] `jobs_metrics.opportunity_state` (active / stalled / slow, plus lapsed) and its SQL twin. The overview's stalled count also leaves slow out.
- [x] `_open_opportunity_rows` and `_closed_in_window_rows` are shared by the overview and the new endpoint.
- [x] `GET /api/jobs/opportunities/thursday` returns summary, priority, week, stalled, slow, accounts, stalled accounts, lost reasons, milestones and definitions.
- [x] Dictionary drafts: `opportunities_active`, `opportunities_slow`, `opportunity_stage_moves` (with asks), `stalled_opportunity_accounts`, `lost_reasons`. `stalled_opportunities` now leaves out slow-but-active. Metric checks were added.
- [x] "Why these?" notes `thursday_*` replace `opportunities_set` and `recent_activity`.

### Frontend
- [x] `JobsThursdayPipeline.tsx` on Dashboard › Pipeline. `JobsOpportunitiesOverview.tsx` is removed and `Panel` moves to `components/jobs/Panel.tsx`.
- [x] `pipelineText.ts`, with tests.
- [x] `SlowButActive` on the opportunity page and in the grid's expanded row.
- [x] `ClosedLostModal` moves to `components/jobs` and saves stage, reason and note in one PATCH. Cancel leaves the stage. It is used by the grid, Jobs Home and the inline opportunity rows.
- [x] One `PRIORITY_OPTIONS` (in `oppLabels.ts`). The opportunity page stored 1 for "P1".
- [x] Update errors show the server's reason instead of "Update failed".

### Verify
- [x] pytest: the full suite passes, with 26 new tests in `tests/test_jobs_thursday_pro110.py`.
- [x] Node: 77 tests pass. `tsc` is clean.
- [x] Checked against prod (read-only) and through the endpoint on real data.
- [x] Browser walk-through on the WSL dev servers.

## Review (10/20)

**Built:** everything in the plan, on the working tree. Not committed yet.

**Checked on real data (prod, read-only), this week so far:**

| | Full-time | All |
|---|---|---|
| Open | 39 | 46 |
| Active | 34 | 40 |
| Stalled | 5 | 6 |
| Slow but active | 0 | 0 |
| With a priority | 23 | 24 |
| Stalled accounts | 4 of 35 | 5 of 39 |

- The four stalled full-time accounts are Marsh McLennan, Tomorrow Health, Carter(?) and Touchlab.
- Lost in the last 180 days (full-time): 68. 8 have no reason.
- **"Other" is the top lost reason at 28 of 68.** It says little; worth raising with the team.
- This week has no moves or new opportunities yet (Mon–Tue).

**Browser (WSL clone, files copied in):**
- The page opens on Full-time; All works; the Stalled drawer and the "how is this calculated" popover work.
- The opportunity page shows the slow-but-active field, waiting on its migration.
- On `/jobs/pipeline`, picking Closed Lost opens the modal and sends no request. Cancel leaves the stage as it was.

**Known, not changed here:**
- **Locally, conversion between milestones fails.** The dev database login has no permission on `builder_by_id`, so `_funnel_milestones` (the existing funnel code) raises. For the screenshots only, the WSL copy skipped milestones; that was restored afterwards. The dev login is also read-only, so nothing could be saved from the browser.
- **The slow-but-active migration needs Jac.** Until it runs:
  - the field says it is waiting;
  - the Slow but active list explains why it is empty;
  - the dictionary queries that read the new columns note it.
- **Screenshots for Kwame:** the 10/15 meeting has passed. Feedback still needs logging on the ticket.
