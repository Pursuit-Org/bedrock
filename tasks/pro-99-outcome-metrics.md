# PRO-99: outcome metrics — placed, paid work, avg salary, and the drawers

Linear: https://linear.app/pursuit-org/issue/PRO-99 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16)

## What production says (read-only, 10/13)

**Trials.** 6 `jobs_role` rows have `is_trial`; 5 are filled (JPMC ×3 and Fowler committed, Charter
open-market), 1 cancelled (US Chamber). Every filled trial links an employment record, typed `contract`,
priced (JPMC $97,760, Charter $118,300, Fowler $6,973), so all 5 builders are already in paid work.
4 of them (users 18, 31, 41, 45) have no full-time record; Fowler's builder (19) converted to full-time.

| Number | Today | After PRO-99 |
|---|---|---|
| Placed (D2: full-time + paid trial) | 14 FT (headline read 22 = 14 + 8 committed) | **18 of 59 job-ready (30.5%)**: 14 full-time, 4 in a paid trial |
| Still in the role | | 18 (0 have left) |
| Committed roles | added into the headline | 8, beside it, never added |
| Builders with paid work | 39 (PRO-97 rule) | 39, L3+ pool only (all 39 are in it) |
| Avg FT salary | headline read $80,399 (placed + committed blend) | **$76,821**, placed only. Committed roles' expected: $86,660 avg, 8 roles, own line |
| Current L3 | none | L3 – March 2026 (ended 6/24): 25 job-ready, 0 placed, 14 with paid work |

The ticket's 41 for paid work predates PRO-97, which settled the rule on 10/7 (unpriced work out): 39.

**Cohorts.** `public.cohort` L3 rows: March 2025 (no end date), March 2026 (3/28–6/24, `is_active`),
August 2026 (8/15–11/4, `is_active`, nobody in L3+ yet). Current L3 = the L3 cohort with the latest end date on
or before today (New York). It moves to August 2026 on 11/5 by itself.

**Duplicates.** Two builders have two records with the same company, role and pay (RXR #80/#82, Golden Rose
#95/#96: a completed and an active copy). Records: 33 come from a role on an opportunity (hire), 14 were
entered by hand in Bedrock, 41 were imported (Airtable).

**Five rules for "placed" today.** Cards (`jobs_metrics.placements`), Builders funnel (same, but labels each
builder with the function's highest-paid record, which can be pro bono or a test account), Placement ›
Builders board (`_is_placed`: any pay > 0, test accounts and pro bono in), `/roles` (unused by the frontend),
`l3plus_funnel()`'s own flags (ignored).

## Decisions

- D2 (10/2) + default (stood 10/7): a builder in a filled `is_trial` role counts as placed, shown as its own line.
- Default (stood 10/7): a builder who left the role still counts; the card says how many are still in it.
- Default (stood 10/7): Current L3 = the most recent L3 cohort that has finished, by dates, not `is_active`.
- D4: full-time is the core number; all paid work can be viewed.
- PRO-97 (Nina 10/7): the placement rule (pay recorded, not pro bono / pipeline / test / unstarted / deleted).
- **Nina, 10/13: the board gets a "Paid work" status** between Interviewing and Placed, for builders with
  counted paid work who aren't placed. The board applies the rule to everyone it lists (L3 too); under its
  L3+ cohort filter, Placed (18) + Paid work (21) = the paid-work card (39). Today no L3-only builder has
  counted paid work.
- **Nina, 10/13: salary editing moves to the builder drawer** (Placement › Builders): pay, title and
  stage/end of each placement. Deal-linked ones also stay editable through the role on the opportunity.

## Rules (one place: `services/jobs_metrics.py`)

- **Trial record**: an employment record a filled, not-cancelled `is_trial` role links to
  (`jobs_role.employment_record_id`). `employment_sql()` returns it as `is_trial`.
- **Placed**: in the job-ready pool, with a counted full-time record or a counted trial record.
  `Placements.placed_uids`, `.trial_only_uids` (placed through a trial, no full-time), `.placed_in_role_uids`.
- **Outcome numbers are over the job-ready pool** (L3+), so the cards, the funnel and the board count the same
  people. A cohort narrows the pool.
- **Job type** (D4): `full_time` (default) = placed as above; any other type = builders with counted work of
  that type; `all` = paid work. The options come from the counted records.
- **Current L3**: `current_l3_cohort(conn)`, and `segment=current_l3` resolves to its name everywhere a segment
  is accepted.

## Plan (each step a commit)

- [x] **1. Rules + dictionary.** `jobs_metrics`: trial tag, placed, in-role, job type, pool scoping,
  Current L3; committed expected salary. Dictionary (#171, #164): new measures `placed`, `placed_rate`,
  `placed_in_role`, `placed_trial`, `avg_expected_salary_committed`; `builders_with_paid_work` and
  `avg_ft_salary_placed` scoped to the pool; `ft_roles_secured`, `avg_ft_salary_secured`, `trials_running`
  marked retired from the Overview. Regenerate `jobs_metrics.md`; extend `check_jobs_metrics.py`.
- [x] **2. Overview API.** `/placements`: headline = placed; trial line, in-role line, committed beside;
  avg FT salary placed-only plus the committed line; `job_type` and `segment=current_l3`. `/builder-segments`
  adds Current L3 and the job types.
- [x] **3. Drawers.** `/metrics/placements`, `any_paid`, `ft_salaries`: one row per builder (count = card),
  expandable to their roles; same company/role/pay records folded into one; each role says where it came from
  (from a deal / entered by hand / imported). `committed_roles` opens from the card's committed line.
  Read-only.
- [x] **4. Builders funnel + Placement › Builders (PLC-04).** Funnel: job-ready → paid work → placed, with the
  job type, records from the counted placement. Board: `_is_placed` replaced by the shared rule.
- [x] **5. Frontend.** Overview filter bar (cohort incl. Current L3, job type); the three cards; drawer
  read-only with expandable builders; salary / title / stage editing moves to the builder drawer on
  Placement › Builders (deal-linked roles keep editing on the opportunity). Types match the API.
- [x] **6. Tests + re-pin.** Hermetic: rule, drills, funnel, board, job type, Current L3; the xfail drill test
  rewritten. Frontend: card copy helper. Re-pin 18 / 39 / $76,821 / 8 (PRO-97's pins).

## Review (10/13)

**Re-pinned, production 10/13** (the generated reference queries, run read-only; Bedrock runs the same rule,
pinned by hermetic tests). These replace PRO-97's 14 / 41 / $76,821 / 8:

| Number | Value |
|---|---|
| Placed | 18 of 59 job-ready (30.5%): 14 full-time, 4 in a paid trial |
| Placed, still in the role | 18 |
| Builders with paid work | 39 |
| Avg FT salary (placed) | $76,821 (14 builders) |
| Committed roles | 8, expected $86,660 avg |
| Current L3 | L3 – March 2026: 25 job-ready, 0 placed, 14 with paid work |

**Numbers that change on screen**

- The first card reads **Placed 18** (was "FT Roles Secured 22" = 14 placed + 8 committed). Its lines:
  14 full-time · 4 in a paid trial; 18 still in the role; 8 committed roles, not counted (opens their list).
  The ring is 30.5% (was 22 ÷ 59).
- Avg FT salary reads **$76,821** (was $80,399, a blend with committed roles' expected pay). Committed
  roles' $86,660 is its own line.
- Paid work stays 39. The ticket's 41 predates PRO-97's rule (unpriced work out, 10/7).
- Builders funnel: Job-ready 59 → Paid work 39 → Placed 18 (was "Hired — Full-Time" 14).
- Placement › Builders: Placed 18, a new **Paid work** status for the other 21 (was every builder with any
  pay: test accounts and pro bono in).
- The drawers list one row per builder (the card's number), expandable to their roles, each role marked
  Deal role / Entered by hand / Imported; RXR and Golden Rose's duplicate copies show once. Read-only.
- Pay, title and stage are edited on the builder (Placement › Builders › a builder). Records not counted
  (pro bono, unpriced, pipeline) are listed there and say so.

**Nothing to run.** No migration: the trial tag reads `bedrock.jobs_role`, which exists. After 10/16 Jac's
PRO-97 steps cover it: the import script loads the new measures (placed, placed_in_role, placed_rate,
committed_expected_salary) and marks the four retired ones; `check_jobs_metrics.py` compares them.

**Not verified here.** The app wasn't run against data (no local database login); the screens are
checked by typecheck, build and tests. Kwame or Avni should open the Overview once it deploys.

**Left alone.** `GET /api/jobs/roles` (another placed/salary rule; nothing calls it since the Overview
moved to `/placements`) and `l3plus_funnel()`'s own `is_paid` / `is_ft` flags, which Bedrock ignores.
