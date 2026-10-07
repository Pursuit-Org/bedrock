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

## Decisions needed (see chat)

1. Where PRO-97 stops and PRO-99, PRO-100 and PRO-101 start.
2. How Bedrock finds a new concept's row before it has an id.
3. Which side is right on placed and paid work. This is PRO-94's call; the analysis above is the input.

## Plan (each step is a commit)

- [ ] **1. Dictionary drafts.** `financial_forecasting/db/dictionary/jobs_metrics.json`: one object per concept, in the `dd_metrics` row shape, with measures in `cuts` (`key, label, status, definition, numerator, denominator, is_rate, sql_query, mappings, time_anchors`).
  - Updates: 171, 164, 176, 123. The retired 173, 174 and 175 get `hidden: true`.
  - New concepts: Employer outreach, Employer pipeline, Employer conversion, Targets, and a hidden Jobs conventions entry (week, activity, owner, stage map).
  - Every measure has a standalone reference `sql_query` with `$1`/`$2` window parameters where it has a date.
  - A `bedrock_key` on each measure ties it to the module's registry.
  - A readable copy (`jobs_metrics.md`, generated from the JSON) for Nina to paste into the app.
- [ ] **2. Import script.** `scripts/import_jobs_dictionary.py`.
  - Dry run by default: a field-level diff against the live rows.
  - `--apply` writes as `dictionary_app`, in one transaction.
  - Matches rows by `metric_id`, then by (stage, name). It never deletes. It never overwrites a `status` someone confirmed in the app.
  - Jac runs it after 10/16.
- [ ] **3. `services/jobs_metrics.py`.**
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
- [ ] **4. Route Overview, Outreach, Pipeline and Campaigns through it.**
  - Each endpoint's response gains a `definitions` map next to its numbers. The existing keys stay, so the frontend doesn't break.
  - Duplicated SQL is replaced by calls to the module.
  - The three cards that match retired entries point at 171 and 164.
- [ ] **5. Checks.**
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
- [ ] **6. Review section** here, and update `docs/PLAN-INDEX.md` if needed.

## Review

(after the build)
