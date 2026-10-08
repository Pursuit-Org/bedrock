# Stage Flow chart: outreach + pipeline in one view

Status: PR 1 built, awaiting Kwame's local check (2026-10-08)
Branch: `claude/sleepy-carson-qq6xy8` (off `main` @ 643b96c)

## Goal

One chart on **Jobs › Performance › Overview**, directly under the Contacts /
Opportunities / Builders funnel, that runs the weekly pipeline meeting
"level by level, with just the numbers" (Oct 8 meeting):

- every stage from first outreach to Closed Won, top to bottom;
- what sits in each stage **now**, split by how long it has sat there
  (same buckets as Stage × Time in Pipeline);
- what **moved into** each stage in the filtered period, against a weekly
  **target** per stage;
- every number clicks through to the records behind it.

## Decisions (Kwame, 2026-10-08)

- **Placement:** Overview tab, directly under the Contacts / Opportunities / Builders funnel.
- **Units:** two labelled bands. Outreach counts **contacts** (membership stage);
  Pipeline counts **deals** (opportunity stage). Kwame first chose accounts for
  outreach, then switched to contacts.
- **Columns:** In now (total + time-in-stage buckets, same as Stage × Time in
  Pipeline) | Moved in this period | Target. "Activity" = movement: e.g. 5
  contacts moved into Call booked this week, beside everyone still sitting there.
- **Targets:** weekly team target per stage, prorated to the period. Two PRs:
  PR 1 ships the chart with "pending migration"; PR 2 ships the migration and
  the Settings editor.
- **Deal type:** Full time by default, with the multi-select filter. Deal band only.

## Rows

| Band | Row | In now | Moved in |
|---|---|---|---|
| Outreach · contacts | Assigned, Initial outreach, Scheduling, Call booked | yes, by time in stage | yes |
| | Converted to deal, Revisit, Not a fit | movement only | yes |
| Pipeline · deals | In Discussions … Offer Contracting | yes, by time in stage | yes |
| | Closed Won, Closed Lost | movement only | sticky closes only |

Rules:
- Contact time in stage = latest membership-history entry into the current
  stage, else the stage stamp (`assigned_at` / `first_outreach_at` /
  `call_booked_at`), else `updated_at`.
- Deal time in stage = latest `jobs_stage_history` entry into the current stage,
  else `created_at` (same as the heatmap).
- Contacts moved in = the Contacts funnel's period-flow rules (stamps + history,
  one per contact per stage), so both agree for the same window.
- Deals moved in = every entry in the window, one per deal per stage (retired
  stages folded by `canon_stage`), plus deals created straight into a stage.
- Closed Won / Lost moved in = the Closed won / lost card rule (latest change
  before period end is the close, inside the period).
- Period boundaries are UTC midnights, as in the funnels.
- Owner filters both bands; deal type filters the deal band only.

## Endpoint

`GET /api/jobs/stage-flow?period_from&period_to&owner&deal_type` returns
`bands[].rows[] {key,label,in_now{total,cells}|null,moved_in,targetable,
target_weekly,target}`, plus flat `members` and `moved` lists the drills filter.

## Targets store

`services/jobs_targets_store.py` reads `section = 'stage'` rows into their own
map (so they never leak into outreach team targets) and probes
`jobs_target_section_check` for `'stage'`. A failed probe means "pending", never
a lost team or outreach snapshot.

## Proposed delivery

- **PR 1 (this branch):** the chart, endpoint, store read path, tests. Target column shows "pending migration".
- **PR 2:** migration `2026-10-08-jobs-stage-targets.sql` (widen the section and
  metric CHECKs, add the `stage` row shape) + Settings › Targets › Jobs › Stages editor.

## Production sizing (2026-10-08)

- Contacts → accounts, by furthest stage: assigned 22, initial outreach 484,
  call booked 15, converted 102 (82 accounts hold only revisit / not-a-fit).
- Open deals: In Discussions 82, Ask Submitted 2, Opp Confirmed 19,
  Builder Submitted 4, Builder Interviewing 8, Offer Contracting 0. Won 48 all-time.
- Last 8 weeks entries: deals into In Discussions 31, Confirmed 13, Interviewing 9,
  Won 16, Lost 62; contacts into call booked 27, initial outreach 41.
- Only 27 of 139 converted contacts carry an `opportunity_id`, so the
  account↔deal link has to be by account name, not by that column.

## Checklist

- [x] Kwame signs off on open questions
- [x] Endpoint + tests (`tests/test_jobs_stage_flow.py`, 7 tests)
- [x] Chart + drill drawer
- [x] typecheck, build, pytest (CI command: 1044 passed)
- [x] Headless render with mocked /api (pending and targets states, both drills)
- [x] Independent review pass over the diff
- [ ] Kwame checks real data locally
- [ ] PR 2: migration + Settings editor
