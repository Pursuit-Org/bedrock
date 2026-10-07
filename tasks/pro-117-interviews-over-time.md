# PRO-117: count interviews over time, and show interviews per week

Linear: https://linear.app/pursuit-org/issue/PRO-117 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16)

## What production says (read-only, 10/7)

**Does the history record every move into interview? No.**

- `public.job_applications.stage_history`: 923 applications, 676 with history, 1,329 entries,
  38 into `interview` across 31 applications. 43 applications sit at `interview` now.
- The Jobs team's own applications (`source_type` Pursuit_referred / staff_sourced): 257 in all, 30 at
  interview now, **6** with an interview entry.
- Gaps, by cause:
  1. **Bedrock's two "log an application" forms write no entry.** `POST /opportunities/{id}/builder-activity`
     and `POST /roles/{id}/applications` insert at the chosen stage (often `interview` or `accepted`) with an
     empty history. Staff log most interviews this way, after the fact. Only a later stage change appends.
  2. **Bedrock history starts 9/29**, not 11/2025: the first entry with `changed_by` is 2026-09-29 (Avni's
     change, af04367c, reached production then). The 2025-11-04 entries are the platform's, for builders'
     self-reported applications. Moves made in Bedrock before 9/29 (e.g. four rows updated 9/22) are lost.
  3. Other writers insert at `interview` with no entry: three `source = 'compass'` rows (9/8, 9/15) and two
     "Seeded for platform demo" rows (8/5, fake data).
  4. The entry's `date` is `to_char(now())` in the database's zone (UTC): after 8pm New York it is tomorrow.
  5. The PATCH appends even when the stage doesn't change, so an application can have two `interview` entries.
- Some applications skip interview: 1 platform hire and 2 offers go applied → offer.

## Decisions (Nina, 10/7)

- **Scope: the Jobs team's interviews only** (`source_type` Pursuit_referred / staff_sourced), as the
  Builders tab and "Builders interviewing" already count. Builders' self-reported interviews stay out.
- **Shown on the Pipeline tab** until PRO-111's Placement tab takes it (after 10/16).
- **Interview → hire counts applications**, not opportunities. The dictionary draft is rewritten; the group
  still signs it off (D1).
- **Backfill the provable creation entries** (a migration Jac runs after review).

## Plan

- [x] **Record every change.** One helper writes the entry `{date, stage, notes, changed_by}` (the platform's
      shape, unchanged) with the New York date. The two create paths write a creation entry; the PATCH
      appends only when the stage actually changes.
- [x] **Backfill what is provable** (migration, Jac runs it): an application with an empty history that was
      created on/after 9/29, or never updated since it was created, is still at the stage it was created at,
      so it gets one entry dated by `created_at` (New York), `notes` marking the backfill. No Airtable imports,
      no demo rows. Nothing else is guessed.
- [x] **One counting rule** in `services/jobs_metrics.py` (plus its SQL twin for the dictionary):
      an interview is an application's first move into `interview`, dated by that entry, in Mon–Sun New York
      weeks (D8). Interview → hire: of the interviews in the period, the share whose application is now
      `accepted` (D11: only those that reached interview count).
- [x] **Say what's missing on screen:** "Interview history starts 9/29" plus "N more interviewing with no
      recorded date", never a drop.
- [x] **Show it:** interviews per week, and interview → hire, with `definitions` from the dictionary.
- [x] Dictionary: new measure(s) and the `interview_to_hire` draft rewritten to match; regenerate the md.
- [x] Tests: the count matches the history for a sample of builders (fixture rows shaped like production's);
      create paths write the entry; no duplicate entry when the stage is unchanged; NY date after 8pm.

## Review

**Built.**
- `services/jobs_metrics.py`: `stage_entry_sql` (one entry shape, New York date), `INTERVIEW_APPLICATIONS_SQL`,
  `entered_interview`, `interviews()` (dated / undated, owner and deal-type filters through the opportunity),
  `interviews_reference_sql()` (the SQL twin). Measures `interviews` (Employer pipeline) and `interview_to_hire`
  (Employer conversion, now shown).
- `routes/jobs.py`: both create paths write a creation entry; the PATCH appends only on a real change, dated in
  New York. New `GET /api/jobs/interviews` (window count, hired, rate, undated, 12-week series, rows, definitions).
- `migrations/2026-10-07-job-application-creation-history.sql`: the provable backfill (52 rows on 10/7).
- Dictionary: `interviews` added, `interview_to_hire` rewritten for applications, conversion caveats updated, md
  regenerated. `scripts/check_jobs_metrics.py` checks both against the endpoint.
- Pipeline tab: `InterviewsPanel` under the opportunities funnel, same period, owner and deal type. Count, hired
  so far and the rate, a 12-week bar series (weeks before 9/29 on a hatched backdrop), the history note, and
  lists of the interviews and the undated ones.

**Verified.** Backend `pytest tests/` all green (new `tests/test_interviews.py`, 20 tests, including the
production sample: the count matches the history for every application in it, 6 over 9/28-10/11, which is what
the reference query returned on production). Frontend `tsc --noEmit` clean, `node --test` 49/49, `vite build`
OK. On production (read-only): the endpoint's query parses and returns 257 applications (30 at interview); the
reference query gives 6 interviews / 0 hired for 9/28-10/11 today, 11 after the backfill (3 + 8). The panel was
server-rendered with production-shaped data and checked at desktop and phone widths. Not exercised: the page
in a signed-in browser (no local database; Google sign-in).

**Order to apply.** Deploy first or migrate first, either works: the backfill only touches rows with an empty
history, and the new code writes entries for new rows. Until the backfill runs, this week reads 5, not 8.

**Behaviour changes worth knowing.**
- Logging an application on an opportunity or a role now writes its first stage_history entry.
- Saving an application's stage unchanged no longer appends a duplicate entry.
- Stage entries are dated in New York (they were UTC dates, so tomorrow after 8pm).

**Open / follow-ups.**
- 14 Jobs-team applications at interview stay undated (moved before 9/29, or Airtable imports). Only a person
  can date them.
- Other writers (`source = 'compass'`, the platform) can still insert at interview with no entry; their rows are
  outside the Jobs team's scope except one.
- The Builders tab's "Interviews" column and `/placements`' `interviewing` still count the current stage, and
  `/placements` reads Pursuit_referred only (not staff_sourced). Not changed here.
- The dictionary's interview_to_hire wording needs the group's sign-off (D1).
