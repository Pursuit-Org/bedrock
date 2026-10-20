# PRO-105: "How is this calculated?" on every number and list

Linear: https://linear.app/pursuit-org/issue/PRO-105 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16) · Due Wed 10/14 (screenshots Thu 10/15)

## What exists today (checked 10/13)

**The dictionary can't be written to.** Nothing in `bedrock.dd_metrics` has been saved since 9/17, by any team. Nina's edits in the dictionary app don't save. The app is in `Pursuit-Org/data-dictionary`, which we can't see, and its login is Jac's to check.

- Live, only 2 of the 43 numbers Bedrock registers have their dictionary measure: `builders_with_paid_work` and `avg_ft_salary_placed`.
- #176 has no `pool` measure. #171 has no `placed*` measures, because the 10/7 drafts were never entered.
- The 5 new concepts (outreach, pipeline, conversion, targets, conventions) don't exist, and their ids in `jobs_metrics.CONCEPTS` are still `None`.
- Every one of the 45 measures has a draft in `db/dictionary/jobs_metrics.json`.

**Backend (PRO-97 left this).**

- `jobs_metrics.define()` returns `{label, definition, numerator, denominator, status, window, filters, records}` for most numbers on Overview, Outreach, Pipeline and Campaigns.
- It doesn't pass through `time_anchors` or caveats, and nothing reports **ignored** filters. `define()` drops empty filters, and no endpoint lists the params it ignores.

**Frontend.**

- Nothing reads `definitions`, and no TS type declares it.
- There is no shared KPI card: there are about 7 card implementations, and several are `<button>`s, so an icon inside them needs restructuring.
- Radix Popover is installed but unused.
- The stack is Tailwind + Radix + lucide, not MUI.

**Records that don't match their number** (the ticket requires that they do):

| Number | Problem |
|---|---|
| Placed FT / trial / in role | All three open the "placed" drill |
| Outreach scorecard rows | Detail `count` is distinct contacts. The number is sends (`touches_total`) |
| Accounts activated | No field in the detail equals the number. It returns (event, account) pairs |
| By-owner cells | Records link is team-wide, with no owner |
| Campaign contacts / contacted / reached | No records link. `/records` returns in-pipeline only |
| Committed expected salary | Drill also lists roles with no salary |
| Won, open tasks | The card counts on the client from `/opportunities`, not the server's measure |
| Outreach summary drills | Capped at 60 (`drill_totals` has the full count) |
| Activity depth | Buckets capped at 40 |

**Filters reported wrongly or not at all:**

- Prospects funnel: reports `owner` but ignores it.
- Conversions: report `scope` but ignore it.
- Builders funnel: ignores deal type, owner and period, silently.
- Committed roles: ignore cohort and job type (only `committed_is_global` says so).
- Paid work and avg salary: ignore job type.
- Campaign totals: ignore the date range.

**Windows wrong or missing:**

- Activity depth: trailing 4 weeks, no window reported, UTC dates.
- Stalled: reported with the week's window, but measured as of now.
- Campaign default range: server date, not New York.
- `/this-week-summary`: rolling 7 days.

## Decisions (Nina, 10/20: all three as recommended)

1. Definition text: the repo draft, labelled "Draft, not yet in the data dictionary".
2. Ignored filters: reported, no number changes.
3. Scope: Phase 1 first (four Dashboard tabs plus Jobs Home lists).

## Decisions needed (Nina) — answered above

1. **Definition text while the dictionary can't save.**
   - (a) Show the repo draft, labelled "Draft, not yet in the data dictionary". **Recommended.** These are the same words being entered, and they're read from the JSON, not written in code.
   - (b) Strict: "Not in the data dictionary yet".

   In both cases a dictionary entry wins as soon as it exists and its id is pinned.
2. **Filters a number ignores.** Report them as "ignored" (no number changes), or make the number honour them (numbers change). **Recommended: report them.** Changing what a number means belongs in PRO-94/97. One exception: prospects-by-owner currently claims an owner filter it doesn't apply. Reporting it as ignored fixes that claim.
3. **Scope for Wed/Thu.** Phase 1 covers the four Dashboard tabs plus Jobs Home lists, ready for Thursday's screenshots. Phase 2 covers the remaining lists: Contacts, Accounts, Pipeline table, Placement, My Network, Candidates. **Recommended.** Detail-page stats (account, contact, opportunity) are not metrics in the catalog: out of scope.

## Plan (each step is a commit)

- [x] **1. Backend: the info payload.** `services/jobs_metrics.py`
  - `define(..., ignored={param: reason})` reports the filters a number does not apply.
  - Pass through the measure's `time_anchors` label and its caveat.
  - Decision 1 fallback: read `jobs_metrics.json` once at import. A missing entry takes its draft text with `source: "repo_draft"`. A dictionary row always wins.
  - Records: `{endpoint, params, count_field}`, so the UI can show the count it will open.
- [x] **2. Backend: make records match.**
  - Placed FT, trial and in-role drills: `metrics/placements?job_type=…&status=…`, one per number.
  - Scorecard detail: a `count` equal to the row's number (sends, calls, accounts activated as distinct accounts, conversions).
  - By-owner records carry the owner.
  - Campaign `/records?measure=` for contacts, contacted and reached.
  - Expected salary: drill lists only priced roles.
  - Won, open tasks: the server's own count and rows.
  - Every capped list: the drawer says "showing N of M".
  - One test per number: hermetic fixture, records count equals value.
- [x] **3. Backend: honest windows and filters.**
  - Touch-depth window in New York dates.
  - Stalled is "as of {date}".
  - Campaign date ranges on New York days.
  - Each endpoint passes `ignored` for every accepted param a number skips.
  - Test: every `definitions` entry's filters ∪ ignored = the endpoint's accepted params.
- [x] **4. Backend: lists say how they're picked.** `services/jobs_lists.py` (one entry per list), placed next to the SQL it describes:
  - who's in it, the order, any cap, and what each date on a row means;
  - each list endpoint returns `why`;
  - test: every list endpoint returns one.

  Lists, Phase 1:
  - Assigned contacts
  - Replied, needs a decision
  - Opportunities / Needs attention
  - Roles
  - Tasks
  - Intro requests
  - Activity feed
  - Activity depth buckets
  - Opportunities Set bands
  - Recent Activity
  - Campaign lists

  Lists, Phase 2:
  - Contacts
  - Accounts
  - Pipeline table
  - Placement columns
  - My Network (including where "expect a response" / "hiring fit" ratings go)
  - Candidates

  Text the lists' rules make surprising, said plainly rather than changed:
  - "Replied" and "Assigned" use the contact's owner.
  - The walkthrough's "Stalled" band is needs-attention minus P1/P2, not the 4-week rule.
  - Candidates' "last email" is the last activity of any type.
- [x] **5. Frontend: the pieces.**
  - `ui/Popover.tsx` (Radix, portalled so cards don't clip it).
  - `components/jobs/MetricInfo.tsx` (icon + popover), showing:
    - label;
    - definition with a status badge (Signed off / Draft / Draft, not yet in the dictionary);
    - counts ÷ divides by;
    - window "Mon Oct 5 – Sun Oct 11, New York time" or "as of today";
    - filters applied;
    - filters ignored;
    - "View records (N)", which calls the page's existing drawer.
  - `components/jobs/ListWhy.tsx` ("Why these?").
  - `components/jobs/metricInfo.ts`: pure formatting, tested with `node --test`.
  - Types for `definitions` on every response.
- [x] **6. Frontend: wire Phase 1.**
  - Overview: `JobsStatBubble`, cohort/job type, funnel.
  - Outreach: summary cards, scorecard rows, owner table, trends, depth.
  - Pipeline: summary and outcome boxes, funnel, interviews, aging, projection.
  - Campaigns: activation, tiles, list row.
  - Fix the nested-button cards (icon as a sibling, not a child).
  - Label every row date ("assigned 3d ago", "replied 2d ago", "last activity …").
  - Fix "replied today ago".
- [x] **7. Frontend: wire Phase 2** (if decision 3 says so).
- [x] **8. Verify.**
  - pytest; `tsc -b`; `node --test "tests/**/*.test.ts"`. On Windows, `npm test`'s single-quoted glob finds 0 tests.
  - Run the app and screenshot each tab with a popover open.
  - Check three "View records" counts against their cards on real data.
- [x] **9. Review section here.** Ticket for Jac: dictionary app saves fail since 9/17; pin the new concept ids after import.

## Not in this ticket

- Making the dictionary app save (Jac).
- Changing what any number means (PRO-94).
- The Placement dashboard tab (still "coming soon").
- Clickable rows into a builder journey (PRO-103, design only).

## Review (10/20, Phase 1)

Built: steps 1–6 and 8. Phase 2 (step 7) not started.

Checked in the app against live data (WSL clone, read-only database user), each records link fetched and counted:

- Overview: all 10 numbers match their records under full-time, contract and all paid work (Placed 18, full-time 15, trial 3, in role 18, committed 3).
- Outreach: summary cards, all 10 scorecard rows, 12 by-owner cells and activity depth (778) match.
  - Found and fixed: an owner cell counts only what that person sent while on the Jobs team, and its link counted everything (Kwame: 0 vs 3). The link now passes `on_team`.
- Pipeline: all six cards match, for all owners and for one owner. "Won, open tasks" is the server's count now, and agrees with the old one (0).
- Campaigns: every number matches for Operation 35, Alumni and CISO Council. The totals report the date range as ignored.
- Jobs Home: "Why these?" on every list. Row dates read "assigned 2mo ago" and "replied 5mo ago". No "today ago".
- Also fixed on review:
  - The Placed full-time and trial popovers were both titled "Placed".
  - The feed note said "Sender" for the Editor column.
  - The feed's note sat inside its heading.
  - The empty intro list had no note.

Not checked locally: the contacts and opportunities funnels and the interviews panel. Locally they fail with "permission denied for function builder_by_id", because the read-only user can't run that function. The code is from PRO-117 and the production role should be able to run it.

For Jac: the dictionary app's saves fail (nothing saved since 9/17). After the import, pin the five new concept ids in `jobs_metrics.CONCEPTS`.

## Review (10/20, Phase 2)

"Why these?" on Contacts, Accounts, the Pipeline table, Placement (Pursuit-Supported, Staff-Sourced and Builder-Sourced roles; the Builders board), My Network and Candidates. The notes are in `services/jobs_lists.py`, and a test fails if a note isn't shown on any page.

- Avni's questions, answered in the notes:
  - My Network: the "Expect a response" and "Hiring fit" ratings are saved per person (`bedrock.connection_status`). Only that page reads them, for its columns, filters and sorts. They don't change the order, the P1/P2 bands or any other page.
  - Candidates: the nightly sync takes people who emailed or met any synced mailbox and aren't contacts yet. They become candidates when warm (in touch in the last 90 days, or 3+ messages). This covers all mail, not only Jobs mail.
- Fixed where the page contradicted its note:
  - Accounts' default sort was the status in alphabetical order. It now uses the server's rank: Pursuing, Stewarding, Re-activating, Activating, and so on.
  - Pipeline's "N this wk" chip now reads "N in 7 days", which is what it counts.
- Dates:
  - Placement application dates read "updated <date>", since they show the last edit and not the application date.
  - Accounts "Last activity" shows the exact date on hover.
- Fixed a Phase 1 bug: the notes were cached in the browser forever, so a note added later never appeared. They now refresh after 10 minutes.
- Checked in the app on live data: every note opens with its words on Contacts, Accounts, Pipeline, Placement › Roles, My Network and Candidates.
  - Accounts now sorts Pursuing first.
  - Pipeline shows "in 7 days" and no "this wk".
- Not seen locally: the Builders board. Its endpoint needs a database permission the read-only user doesn't have. The note sits beside the status counts, which show once the board loads.
- Not covered: the tabs inside expanded rows (Activity, Opportunities, Contacts and so on on Contacts and Accounts). They're details of one record, not lists of the page.
