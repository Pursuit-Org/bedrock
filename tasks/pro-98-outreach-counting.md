# PRO-98: count only team-sent activity, restore the email index, rename "touches"

Linear: https://linear.app/pursuit-org/issue/PRO-98 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16)

## Step 0: reference query (done 10/6, read-only against production)

The audit's numbers reproduce exactly, but only with **UTC day boundaries**. The ticket
says New York time; the 9/30 audit evidently used UTC, like the app's backend does today
(OUT-01 caveat in the audit sheet).

Team = Avni, Damon, Devika (D7, as at the audit). Window Wed 9/23 – Tue 9/29.

| Number | Audit | Reference query, UTC days | Old logic (`logged_by`), UTC |
|---|---|---|---|
| Outreach | 48 | **48** | 62 (audit: 62) |
| Direct email | 39 | **39** | 53 (audit: 53) |
| Accounts activated | 10 | **11** (see below) | 22 (audit: 22) |

Outreach = direct email + LinkedIn (1) + text (1) + facilitated intros (7).

What the reference query counts for email: one row per message in `activity_email_message`
whose `from_email` is on the team, plus, for threads with no index rows yet, the thread row
when its sender (`email_from`) is on the team; jobs-related only. `logged_by` is never used for
email. LinkedIn, text and hand-logged rows use `logged_by`, which is correct for those: it is
the person who typed the entry.

### Things the audit's 48 / 39 still contains

1. **Cross-mailbox duplicates: 3.** The same send stored in two mailboxes (e.g. Devika's 9/23
   Renaissance email sits in both Devika's and Kanika's mailboxes). The ticket says to
   deduplicate; the audit didn't. Key: (sender, exact timestamp, contact), not
   (sender, timestamp): Damon sent two different "Appointment booked" mails in the same second.
2. **Automatic calendar notices: 9.** "Appointment booked: …", "Updated invitation with
   note: …" mails sent from team addresses by Google Calendar. They aren't outreach; the
   meeting itself is counted as a meeting.

| Window | Raw (audit method) | + dedup | + no calendar notices |
|---|---|---|---|
| Rolling Wed 9/23 – Tue 9/29, UTC | 48 / 39 | 45 / 36 | 36 / 27 |
| Rolling Wed 9/23 – Tue 9/29, NY | 44 / 35 | 42 / 33 | 33 / 24 |
| Calendar Mon 9/21 – Sun 9/27, NY (D8) | 66 / 56 | 63 / 53 | 56 / 46 |

### Accounts activated: 11, not 10

Every reading of "first activity" gives a different number. The audit's rule isn't recoverable:

| Rule | Rolling UTC | Rolling NY | Calendar 9/21–27 NY |
|---|---|---|---|
| First **team-sent** activity ever on the account (literal D17) | 11 | 9 | 10 |
| First jobs activity by **anyone at Pursuit** ever; team active in window | 9 | | |

The extra account under the literal rule is **Red Barn**. Nick emailed them on 8/25, and Avni
met them on 9/23. Under the second rule, **Fovea Central** also drops, because Alexis emailed
them in 2019.

"Account" is still `lower(trim(contacts.current_company))`. That is the only account key Bedrock
has. `jobs_account.account_key` is the same string, and `contacts.company_id` is unreliable
(Counsel Health maps to "Bond Global"). An example of the problem: the contact "mlt" and the
account "MLT (Management Leadership for Tomorrow)" are two different accounts today. Matching
on a real account id waits for the account merges and the pick-from-a-list work in PRO-101.

### Data issues found (not code)

- **Jobs team table changed on 10/5.** It is now Avni, Devika and **Kwame**. Damon was
  deactivated, and Kwame added himself. This contradicts D7 (decided 10/3). Membership has no
  history, so every past week is recounted with the current team.
- **Email index.** The last insert was 9/24 09:16 UTC. `bedrock.activity` is 2.1 GB with no index on
  `synced_at`, so the refresh's SELECT is a full scan under the web pool's 30s `command_timeout`.
  That fits the empty error message in the Cloud Run log. 298 of the 412 threads synced in the
  last 7 days have no index rows.

## Decisions (Nina, 10/6)

- Outreach: dedup cross-mailbox copies AND drop automatic calendar notices (Sep 23–29: 36 / 27;
  tests also pin the audit method's 48 / 39 to show the reconciliation).
- Accounts activated: first **team** activity ever on the account (Red Barn activates 9/23).
- Hermetic test fixture: anonymized production export of the audit window's events.

## Plan (each step is a commit)

- [x] **1. One counting module.** `services/outreach_counting.py`:
  - SQL that fetches candidate events for a window: email per message, thread fallback,
    LinkedIn, text, intros, calls and meetings, each with sender, timestamp, contact and
    subject.
  - Pure Python that does the team-sent filter, the cross-mailbox dedup, the calendar-notice
    exclusion and the counts.
  - Accounts activated: SQL returns each account's first-activity timestamp; Python counts the
    ones that fall in the window.
  - This is the module PRO-97 grows into `jobs_metrics.py`.
- [x] **2. Route every outreach number through it.** No `logged_by` for email anywhere:
  - scorecard and by-owner
  - summary cards and their drills
  - activity trends (volume, new vs. existing, detail)
  - the activity log (OUT-11): one row per message sent, not per thread
  - campaign stats (CMP-06): team-sent only
  - touch depth
  - the `_first_touch_*` CTEs
  - drill lists use the same events as their counts
- [x] **3. Accounts activated per D17.** The first activity ever, under the rule chosen below.
  The 90-day dormancy rule is removed. A meeting Nick sets up that enters at Call Booked counts.
  New vs. ongoing activity is split the same way on every outreach number (Kwame).
- [x] **4. Weeks.** New York time on the backend (D8), replacing the UTC parse of `date_from` / `date_to`.
- [x] **5. Email index job.**
  - Give the refresh its own timeout (asyncpg `timeout=`).
  - Select only threads with unindexed messages.
  - Log with `%r`, so errors stop being blank.
  - A migration adds an index on `activity(synced_at)`. Jac runs it.
  - A backfill script, for Jac to run after deploy.
  - A staleness alert: when the newest index row is more than 1 day old, the nightly run logs
    an error and the Outreach tab shows a banner.
  - Fix the connection-after-release bug.
- [x] **6. Classifier review.** Measure jobs / not_jobs / unclear / never-classified rates for
  team-sent mail, starting with the week of 8/3 and Avni's ~550. Fix:
  - rows left NULL by failed runs
  - the "unclear" rows
  - prompt misses
  
  Report what changed and what still needs PRO-101's manual tag.
- [x] **7. "Touches" → "activity".** On-screen strings only. The API keys stay, to avoid churning
  the frontend types; Jac can rename them later. "In touch" in My Network is plain English and
  stays.
- [x] **8. Jobs Home "Contacted this week".** Re-check it for Avni after steps 2 and 5. It runs
  off stage moves, which need the index.
- [x] **9. Outreach tab load time (~35s, target under 5s).**
  - Stop fetching `/activity-trends` when the volume view is showing.
  - Compute the account-touch scan once per request.
  - Bound the trend history.
  - Replace the per-row `ILIKE '%email%'` scans with exact matches on the parsed sender.
  - Run the by-owner queries in parallel.
- [x] **10. Tests and pins.**
  - An anonymized production export of the audit window's events, saved as a fixture
    (team addresses kept, external ones hashed, no subjects except for calendar-notice cases).
  - The hermetic test (FakeConn) runs the Python counting over the fixture and pins the
    audit window and the calendar week.
  - SQL-shape tests check that no email path filters on `logged_by`.
  - The reference query is saved for PRO-97's `sql_query`.

## Review (10/6)

Five commits on `integration/jobs-dashboards`, `a5d713ce`..`a2bf733a`. Full backend suite: 1,189 passed.
Frontend: `tsc -b` clean, 44 tests pass.

**Pinned numbers.** Team = Avni, Damon, Devika.

| Window | Audit method | Rules decided 10/6 (outreach / email / activated) |
|---|---|---|
| Wed 9/23 – Tue 9/29, UTC days (the audit) | 48 / 39, exact | 36 / 27 / 16 |
| Same days, New York | 44 / 35 | 33 / 24 / 14 |
| Mon 9/21 – Sun 9/27, New York (D8) | 66 / 56 | 56 / 46 / 15 |

The 10/6 rules are copies counted once and calendar notices dropped. Two implementations agree on these
numbers: the Python rules (tests) and `outreach_counting.reference_sql()` run on production.

**Accounts activated is not 10.** Under the chosen rule (first team activity), the audit week reads 16.
- Seven of the 16 come from facilitated intros. They count as outreach since 9/21, so I count them as
  activity on the account. Without intros it reads 9.
- Dropping calendar notices moves four activations (Fovea, Welcome to Chinatown, NMCIR, NY Sun Works) to
  the meeting date, which falls outside the window.
- The audit's own rule can't be recovered.

**What changed besides counting**
- The nightly sync gets its own pool and timeouts.
- The index catches up on its own after a missed night.
- A STALE log line and an Outreach banner flag a lagging index.
- The classifier now reads threads others started that staff replied in (141 Jobs-team threads since July).
- "Slow to Respond" is treated as an auto-reply.
- "Touches" → "activity" on screen.
- One fewer full-history fetch on Outreach load.

**For Jac (after 10/16)**
1. Deploy.
2. Run `migrations/2026-10-06-activity-synced-at-index.sql`.
3. Run `python -m scripts.backfill_email_message_index`. The catch-up alone finds 572 threads and 3,811
   messages.
4. Re-export the fixture (`python -m scripts.export_outreach_fixture`) and check how the pins move.
5. Consider running the 4am sync as the Cloud Run Job (`nightly_sync.py`) rather than a background task in
   the web service.
6. The integration branch's `db.py` predates main's 10/3 connect-timeout hotfix. Merge main before deploy.

**Open, not code**
- `jobs_team_member` changed on 10/5: Kwame active, Damon inactive. That contradicts D7. Membership has no
  history, so every past week recounts with today's team.
- Jobs Home "Contacted this week" counts contacts the person owns that MOVED to Initial Outreach (Avni: 2
  last week). It does not count outreach: Avni sent 81 messages, 50 tagged jobs-related, to 27 jobs contacts.
  Redefining it is a PRO-106 / PRO-97 call.
- The 10/2 "connection has been released back to the pool" error couldn't be traced in code. The dedicated
  pool removes the likeliest path, and repr logging will name it if it recurs.
- Load time: each Outreach endpoint's SQL now runs in tens to hundreds of ms on production. The 35s → <5s
  target is not yet measured end to end: there's no local DB login, and Jac's deploy is needed.
