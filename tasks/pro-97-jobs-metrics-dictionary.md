# PRO-97: Jobs metrics in the data dictionary; Bedrock reads them from there

Linear: https://linear.app/pursuit-org/issue/PRO-97 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16) · Due Fri 10/9

## What exists today (checked 10/7, read-only)

**The dictionary.** `bedrock.dd_metrics` has 18 Jobs rows. The four this ticket updates are drafts:
- 171 Employment: 7 measures.
- 164 Post-program salary: 10 measures, including `avg_ft_salary_placed` and `avg_ft_salary_secured`, folded in from #175.
- 176 Job-ready pool: 1 measure.
- 123 Retention: 7 measures, mostly blocked.

173, 174 and 175 say RETIRED in their definition, but their status is still `draft`. There is no stable key column; rows are addressed by `metric_id`, which the app assigns. The `dictionary_app` login writes; `nina_dev` and this session are read-only. I don't have access to the `Pursuit-Org/data-dictionary` repo, so the measure shape below is read from the rows themselves.

**Bedrock.** Nothing reads `dd_metrics`, and no card refers to a dictionary id. `routes/jobs.py` duplicates most concepts:

| Concept | Copies |
|---|---|
| Committed FT roles | 5 copies of the SQL (jobs.py 578, 623, 676, 819, 836), plus 3 variants |
| Placed / paid work | 6 rules. The Builders funnel (`bedrock.l3plus_funnel()`) skips the deleted-opportunity filter the cards apply |
| Job-ready pool | `_L3PLUS_POOL`, copied verbatim into `l3plus_funnel()` |
| Stalled | 3 rules in one function: 42 days (card), 14 days (status), 21 days (needs attention) |
| Week | 8 definitions: NY Monday weeks (outreach), UTC midnights (funnel, pipeline overview), server-local `date.today()` (campaigns), rolling 7 days (this-week summary, metric drills), plus the browser's own on the frontend |
| Owner | 6 rules: senders, `m.owner_email`, `_CONVERSION_OWNER`, `_OWNER_SQL`, `o.owner_email`, `contacts.owner_email` |
| Stage map | about 10 lists, backend and frontend; campaigns never count `scheduling` |
| Contacted | 6 meanings |
| Converted | the same predicate written 3 times |

PRO-98 already put every outreach count through `services/outreach_counting.py`. That module, and its `reference_sql()`, are where this ticket starts.

**Dashboard vs dictionary (step 4), live today:**

| Number | Dashboard | Dictionary measure, run today | Why they differ |
|---|---|---|---|
| FT placed | 14 | 12 (`ever_employed_count.full_time`) | The dictionary SQL filters `u.role = 'builder'`, which drops user 25, a Pursuit hire now marked staff. That contradicts the entry's own 9/24 caveat ("Pursuit's own hires ARE counted"). User 100 has no start date, which is a data gap: enter the date. |
| Paid work | 42 (ticket said 41) | 36 | Dashboard counts 2 unpriced contract/freelance records (TKT-129), and the dictionary excludes them (decided 8/16). Dashboard also counts 1 test account (it never applies `exclude_from_metrics`), 1 Pursuit hire, and 2 with no start date or at the `pipeline` stage. |
| Avg FT salary | $76,821 | $75,318 (`first`) | Different measures. The dashboard averages each builder's highest FT salary (`avg_ft_salary_placed`), the 9/22 snapshot read the `first`-job measure, and `max` isn't in the snapshot. |
| "13 now, 10 ever" | snapshot 9/22 | 12 / 12 today | Today's SQL agrees with itself. The 9/22 snapshot ran an older query. No code fix; the next snapshot replaces it. |

## Decisions (Nina, 10/7)

1. **Scope.** PRO-97 applies the shared rules no other ticket owns: calendar weeks in New York time (D8) and
   stalled at 2 / 4 / 6 weeks (D3). Trials as placed (PRO-99), one "contacted" and conversion (PRO-100), and the
   owner rule (PRO-101) keep today's numbers. Their tickets change the single place in the module.
2. **Linking.** Nina enters the new concepts in the app as drafts and sends the ids; they're pinned in
   `jobs_metrics.CONCEPTS` and the JSON. Until then those numbers read `status: "not_in_dictionary"`.
3. **Placed (mixed).**
   - Pursuit's own hires count.
   - Test accounts and `pipeline` records are out.
   - Unpriced work is out (dictionary, 8/16).
   - A missing start date counts; it is a data gap to fill, not a rule.
4. **Campaigns** wait for PRO-100. The campaign code couldn't be read in this session, so the four campaign measures
   are drafted with a caveat and no reference query.

## Plan (each step is a commit)

- [x] **1. Dictionary drafts.** `financial_forecasting/db/dictionary/jobs_metrics.json`: one object per concept, in the `dd_metrics` row shape, with measures in `cuts` (`key, label, status, definition, numerator, denominator, is_rate, sql_query, mappings, time_anchors`).
  - Updates: 171, 164, 176, 123. The retired 173, 174 and 175 get `hidden: true`.
  - New concepts: Employer outreach, Employer pipeline, Employer conversion, Targets, and a hidden Jobs conventions entry (week, activity, owner, stage map).
  - Every measure has a standalone reference `sql_query` with `$1`/`$2` window parameters where it has a date.
  - A `bedrock_key` on each measure ties it to the module's registry.
  - A readable copy (`jobs_metrics.md`, generated from the JSON) for Nina to paste into the app.
- [x] **2. Import script.** `scripts/import_jobs_dictionary.py`.
  - Dry run by default: a field-level diff against the live rows.
  - `--apply` writes as `dictionary_app`, in one transaction.
  - Matches rows by `metric_id`, then by (stage, name). It never deletes. It never overwrites a `status` someone confirmed in the app.
  - Jac runs it after 10/16.
- [x] **3. `services/jobs_metrics.py`.**
  - Reads the Jobs rows (cached 60s, like `jobs_targets_store`).
  - A registry maps each number Bedrock shows to its (metric_id, measure key).
  - `envelope(key, value, window, filters, records)` returns `{value, metric_id, measure, name, definition, status, window: {from, to, tz}, filters, records: <drill endpoint + params>}`. That is PRO-105's input.
  - A missing row reads `status: "not_in_dictionary"`. No fallback text in code.
  - The shared rules live here:
    - the week (D8);
    - activity (re-exported from `outreach_counting`);
    - the owner rules, consolidated, with PRO-101 to settle D6;
    - one stage map;
    - stalled (D3);
    - committed roles;
    - the job-ready pool;
    - placed and paid work.
- [x] **4. Route Overview, Outreach and Pipeline through it.** (Campaigns: PRO-100.)
  - Each endpoint's response gains a `definitions` map next to its numbers. The existing keys stay, so the frontend doesn't break.
  - Duplicated SQL is replaced by calls to the module.
  - The three cards that match retired entries point at 171 and 164.
- [x] **5. Checks.**
  - Hermetic tests:
    - every number on the four tabs has a registry entry;
    - every registry entry is in the JSON with a `sql_query`;
    - every endpoint returns its definitions;
    - the stalled and week rules are pinned.
  - `scripts/check_jobs_metrics.py` runs each measure's dictionary query and Bedrock's calculation over the same dates and prints a match table. `--snapshot` writes `dd_metric_snapshots`, and only after Jac's review.
  - I run the SQL side now through the read-only connection.
  - Pins:
    - outreach re-pinned on calendar weeks (PRO-98 already has Mon 9/21 – Sun 9/27: 56 / 46 / 15);
    - placed, paid work and salary as settled in decision 3;
    - committed roles 8.
- [x] **6. Review section** here.

## Review (10/7)

Three commits on `integration/jobs-dashboards`:

| Commit | What |
|---|---|
| `befa4043` | Drafts, import script, module, migration |
| `df90c3f1` | Endpoints and frontend |
| 3rd | Campaign queries withheld, this review |

Backend: 1,301 passed, 25 skipped, 1 xfail (PRO-99's). Frontend: `tsc -b` clean, 44 tests pass.

**What's in the dictionary drafts** (`financial_forecasting/db/dictionary/jobs_metrics.json`; readable copy `jobs_metrics.md`):

- 9 concepts and 48 measures.
- 4 concepts are updates: Employment #171, Post-program salary #164, Job-ready pool #176, Retention #123.
- 5 are new: Employer outreach, Employer pipeline, Employer conversion, Jobs targets, and Jobs conventions (hidden).
- Every measure has a definition, what it counts, what it divides by, and its date.
- 41 measures have a reference query, each run on production on 10/7. Two ran in a combined or trimmed form:
  - the 9 outreach measures share one query body, run once returning every column;
  - Activity depth ran with a shortened auto-reply list (780 contacts at Initial Outreach, 748 with no activity in
    4 weeks).

  The other 7 say why they don't have a query yet:
  - 4 campaign measures (PRO-100);
  - 2 milestone conversions, D11 (blocked on PRO-117);
  - stage flow (derived from two other measures).
- Queries read their window from `dd.window_from` / `dd.window_to`; the default is the last completed calendar week.
- The outreach queries are generated from `outreach_counting`, and a test keeps them identical.

**Pinned values, production, 10/7** (dictionary query; Bedrock runs the same rule):

| Number | Value | Ticket's pin | Why it moved |
|---|---|---|---|
| Placed full-time | 14 of 59 job-ready (23.7%) | 14 of 59 | |
| Paid work | **39** | 41 | Mixed rule drops 2 unpriced, 1 test account, 2 no-start/`pipeline` (the dashboard read 42 today) |
| Avg FT salary, placed | $76,821 | $76,821 | |
| Avg FT salary, secured | $80,399 | | |
| Committed roles | 8 | 8 | |
| FT roles secured | 22 | | |
| Trials running | 3 | | |
| Outreach Mon 9/21 – Sun 9/27, D7 team | 56 / 46 direct / 15 activated | 48 / 39 / 10, rolling UTC | Re-pinned to a calendar week; rules from 10/6 (PRO-98) |
| Outreach Mon 9/28 – Sun 10/4, live team | 27 / 27 / 5 | | Email index stale since 9/24 and the team changed 10/5: re-pin after Jac's backfill |
| Stalled opportunities (4 weeks), w/e 10/4 | 46 of 81 | | Was 40 at 6 weeks |

**The 9/22 dictionary snapshot vs the dashboard (step 4):**

| Number | Snapshot | Dashboard | Resolution |
|---|---|---|---|
| Placed full-time | 13 | 14 | 14 under the settled rule. The dictionary's query dropped Pursuit hires by `u.role` (user 25), against its own 9/24 caveat |
| Paid work | 37 | 41 | 39 under the settled rule |
| Avg FT salary | $75,318 | $76,821 | Two different measures: first-job salary vs highest FT salary per builder. The card's measure is avg_ft_salary_placed |
| "13 now, 10 ever" | | | Today the queries agree (14 / 14). The snapshot ran an older query. The next snapshot replaces it |

The retired #173, #174 and #175 are already hidden. Nothing in Bedrock refers to them now.

**Numbers that change on screen:**

- Paid work: 42 → 39.
- Pipeline Stalled: 6 weeks → 4 weeks, comments no longer count, and the Stalled status uses the same rule.
- The Builders funnel now matches the cards.
- Week boundaries are New York days.
- Outreach opens on last Mon–Sun; Pipeline opens on this week so far.

**For Nina now**

1. Enter the 5 new concepts and the changed measures from `jobs_metrics.md` in the dictionary app, as draft.
2. Send the new metric ids. They go into `jobs_metrics.CONCEPTS` and the JSON.

**For Jac (after 10/16)**

1. Run `migrations/2026-10-07-jobs-employment-records-fn.sql`. Until it runs, Bedrock falls back to `secured_jobs()` and counts test accounts (it logs a warning).
2. `python -m scripts.import_jobs_dictionary` (dry run), then `--apply`, with the `dictionary_app` login. It updates Nina's hand-entered rows rather than duplicating them, and leaves anything confirmed alone.
3. `python -m scripts.check_jobs_metrics` with a login that can read `public.users` (`CHECK_DATABASE_URL`). Then `--snapshot` to write `dd_metric_snapshots`.
4. `l3plus_funnel()` still returns its own `is_paid` / `is_ft` flags, which Bedrock now ignores. Drop them when convenient.

**Not verified here**

- Bedrock's side of each check against production. There's no local DB login, so `check_jobs_metrics.py` hasn't run. The SQL side ran on production through the read-only connection, and the Python rules are pinned by hermetic tests.
- Campaigns (PRO-100).

**Data issues found, not code**

- **Targets.** The team weekly outreach goal in Settings › Targets › Jobs sums to 35 (Avni 0, Devika 25, Kwame 10). D7 says 140 (45 + 45 + 50).
- **Team list.** `jobs_team_member` is Avni, Devika, Kwame (Kwame added and Damon deactivated on 10/5), against D7.
- **Missing start date.** Builder 100 has a full-time placement with no start date.
