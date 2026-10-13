# PRO-100: funnel and campaign math — one "contacted", conversion as a real rate

Linear: https://linear.app/pursuit-org/issue/PRO-100 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16)

## What production says (read-only, 10/13)

**Three meanings of "contacted" on one campaign screen (Operation 35).**

| Where | Rule today | Op 35 |
|---|---|---|
| Campaigns row ("x/y in pipe") | current stage = Initial Outreach | 32 |
| Sankey "Contacted" | any membership stage except Assigned | 81 |
| Activation card "Activated" | any Pursuit activity, ever | ~74 |
| Drill "Reached" pill | stage Initial Outreach or Converted | 51 |

Stage and activity disagree both ways: 29 contacts moved past Assigned with no recorded activity (Avni's
bulk Not a fit on 9/10, e.g. four Peloton contacts at 04:10:32, three Red Canary 26s later), and 22 have
activity but are still at Assigned.

**"In pipeline" is the jobs-prospect flag, not pipeline membership.** Op 35: 449 flagged, 117 with a
membership row. Every campaign denominator (Activation, Sankey, row) used the 449.

**Conversion is a ratio of counts.** `get_funnel` divides stage counts: snapshot opportunities give
2 ÷ 55 = 4% (OVR-09); period mode divides entries by entries, unclamped, so 400% when a backlog clears.

**Records Nina flagged.**
- *Peloton "Not a fit" under Hiring Partner*: Barry McCarthy (tags other_hiring_partner, prior_commit_partner,
  operation_35_pursuit) and three other Peloton contacts were moved Assigned → Not a fit by Avni in one action
  on 9/10. Looks deliberate (account-level), not a bug. **Avni to confirm.**
- *The Future Forum, 34 touches, "Not yet" reached*: Aaron Kinnari's 34 rows are 23 emails FROM Aaron,
  7 emails classified not-jobs, 4 meetings classified unclear. Under the activity rule the contact has 0 activity, so
  "Not yet" was right and "34" was wrong: the drill counted raw `bedrock.activity` rows.
- *David Yang "Not a fit"*: contact 12633 is Pursuit's David (david@pursuit.org); the record has no email,
  company "Pursuit", tags board/bash/influence. Jukay Hsu is in Op 35 the same way.
- *Tristate SMB Leaders*: slug `tristate_smb_leaders`, active, its own campaign.

**Other bugs found on the way.** Scheduling contacts fell into "not yet" on the campaign row and into no
Sankey terminal. Reorder / owner for Operation 35 updated 0 rows (key `operation_35` matches no slug).
Accounts in the drill grouped on the raw company string; "(no company)" was a row like an account.

**For D11.** PRO-101's link migration and PRO-117's backfill are not applied on production yet
(`bedrock.data_fix_audit` doesn't exist): 27 contacts link to an opportunity, 6 Jobs-team applications have an
interview entry. First stage → interview reads ~0 until they run; that is the data, not the rule.

## Decisions

- D10 / D14 (10/2): only the current campaign (Op 35) by default; past ones archived and selectable; retire
  Tristate SMB Leaders.
- D11 (10/2): conversion between core milestones, anchored on interviews; only records that started at the
  earlier stage, by stage-change dates.
- **Nina, 10/13: "contacted" = activity.** A contact is contacted once anyone at Pursuit has reached them with
  an activity (email, LinkedIn, text, intro, call, meeting; services/outreach_counting, the rule Activation
  already used). Call bookings are a stage move, not activity. All time.
- **Nina, 10/13: funnels show milestone rates only.** Stage-to-stage rates come off the funnels; each funnel
  carries first stage → interview and interview → hire.

## Rules (one place: `services/jobs_metrics.py`)

- **Internal staff contact**: the contact's email is a current staffer's (active `org_users`, enabled
  `sync_staff` and its aliases), or the company is exactly "Pursuit" and the contact has no alumni tag.
  (A former staffer's old address doesn't count: Erick Chang, erick@c4q.nyc, is a hiring partner at Uber.)
- **In pipeline**: has a `jobs_contact_membership` row, not internal.
- **Contacted / reached**: as above, over the in-pipeline contacts. An account is reached when one of its
  contacts is. The campaign row, the Activation card, the Sankey and the drill all read this one set.
- **Activity count** (drill, Activity depth): the same events, counted once each.
- **First stage → interview**: of contacts whose first recorded stage is Assigned (opportunities: In
  Discussions), started in the period (snapshot: ever), the share whose linked opportunity has a Jobs-team
  application that entered interview on or after that start. Linked = the contact's converted opportunity or
  the opportunity's contact list (PRO-101), no account fallback.
- **Interview → hire**: PRO-117's rule, unchanged.
- **Campaign conversion**: of contacted contacts, the share converted to an opportunity.

## Plan

- [x] **Rules** in `jobs_metrics`: `internal_contact_sql`, `is_activity`, milestone SQL + Python, their SQL
      twins for the dictionary.
- [x] **Campaign model** (migration, Jac runs it): `contact_tag_catalog.is_current`; Op 35's five slugs current;
      `tristate_smb_leaders` retired (`active = false`); changes recorded in `bedrock.data_fix_audit`.
      `PUT /tag-campaigns/current` sets one campaign current. Order / owner fixed for grouped campaigns.
- [x] **Campaign endpoints**: `/tag-campaigns` (current flag, membership pipeline, contacted, conversion,
      scheduling), `/stats` (contacted by stage for the Sankey), `/records` (contacted, activity, accounts by
      key, unassigned), staff excluded everywhere.
- [x] **Campaigns page**: opens on the current campaign; picker lists Current and Past campaigns; portfolio list
      shows current first, past behind a toggle, with "Make current"; Sankey In pipeline → Contacted / Not yet
      contacted → stage; drill columns Activity / Reached on the same rule; unassigned row.
- [x] **Activity depth (OUT-10)**: every contact in Initial Outreach (owner filter still narrows), staff
      contacts out, activity by the shared rule.
- [x] **Funnels**: per-row rates off for contacts and opportunities; `milestones` (rate, numerator,
      denominator, prior window) on Overview, Outreach and Pipeline.
- [x] **Dictionary**: contacted, campaign_* measures with reference queries; milestone_to_interview unblocked;
      stage_flow_conversion / opportunity_stage_ratio / contact_cohort_conversion retired; md regenerated.
- [x] **Tests**: pytest for the rules and endpoints (campaign row = Activation = Sankey on one fixture),
      node tests for the Sankey counts; `tsc`, `vite build`.
- [x] **Check against production** (read-only) for Op 35.

## Review

**Built.**
- `services/jobs_metrics.py`: Campaigns (`campaign_key`, `internal_contact_sql`, `CAMPAIGN_CONTACTS_SQL`,
  `campaign_numbers`, `campaign_reference_sql`) and Conversion between milestones (`CONTACT_STARTS_SQL`,
  `OPPORTUNITY_STARTS_SQL`, `interview_by_opportunity`, `first_stage_to_interview`, `interview_to_hire`,
  `milestone_reference_sql`). `opportunity_links_sql` is the one link rule, now shared with
  `activity_scope_ctes`. `services/outreach_counting.py`: `is_activity`, `conversation`, `activity_by_contact`;
  `depth_sql` counts each piece once and leaves staff out.
- `routes/jobs.py`: every `/tag-campaigns*` endpoint reads one catalog loader and one population; `current` on
  each campaign; `PUT /tag-campaigns/current`; order and owner reach every slug of a grouped campaign.
  `/funnel/{prospects|opportunities}` returns `milestones` and no per-row rates; builders keep theirs.
  `/outreach/touch-depth` takes no `scope`. The Outreach scorecard's stage column is the `moved_to_outreach`
  measure.
- `migrations/2026-10-13-campaign-current.sql` (Jac runs it): `is_current`, Op 35 current, Tristate retired,
  recorded in `bedrock.data_fix_audit`.
- Frontend: Campaigns opens on the current campaign; picker groups Current / Pinned / Past campaigns; list shows
  past campaigns behind a toggle with "Make current"; stage bar has every stage (Scheduling was missing);
  Activation, Sankey (In pipeline → Contacted / Not yet contacted → stage, `campaignBuckets.ts`) and drills
  read the backend's contacted; drill "Reached" / "Activity" on the same rule, accounts folded by name, an
  unassigned line; funnels show a Conversion strip (rate, n of d, trend, who). Activity depth shows every
  contact in outreach. Outreach column renamed "Moved to outreach / assigned". Query-cache buster v5.
- Dictionary: `contacted` redefined with a reference query; old meaning kept as `moved_to_outreach`;
  `campaign_*` and `milestone_to_interview` have reference queries; the three stage-to-stage rates are marked
  retired (the importer never deletes); `activity_depth` regenerated; md regenerated.
  `scripts/check_jobs_metrics.py` checks `milestone_to_interview` against the prospects funnel.

**Verified.** Backend `pytest` all green, including `tests/test_campaign_math.py` (26 tests: the row, stats,
Sankey split and drill agree on one fixture; staff rule; scheduling; spellings; current / past; order and
owner on Op 35; D11 start rule, interview-before-start, windows, retired opportunity stage names; owner
filter; activity depth). Frontend `tsc --noEmit` clean, `node --test tests/*.test.ts` 53/53 (new
`campaignBuckets.test.ts`), `vite build` OK. A throwaway harness rendered the Campaigns tab, list and both
funnel modes with Op 35-shaped data at 1440px: no overflow, no console errors, Sankey bucket lists match.
Not exercised: the pages signed in against a live backend.

**On production (read-only, 10/13).**
- Op 35 under the new rules: 448 tagged (Jukay Hsu out as staff), 116 in pipeline, 94 accounts, 62 contacted,
  55 accounts reached, 15 of the 62 converted (24%); 19 converted in all, 4 of them with no recorded activity.
  The campaign population query runs; the reference query's activity part was run in a reduced form (no
  `booked_at`, which PRO-102's migration adds).
- First stage → interview: contacts 0 of 1,230 all time (no contact links to any of the 6 interviewed
  applications' opportunities yet); opportunities 1 of 91. Both rise when PRO-101's link migration and
  PRO-117's backfill run.

**Review (fresh-eyes agent, 10/13), fixed.** An opportunity kept only its first interview, so a contact
linked to a deal after that interview couldn't reach a later one (Python and SQL alike); now every
application's interview counts. `CONTACT_STARTS_SQL` re-ran the link union per membership (0.8 s on every
contacts funnel); now one aggregate (35 ms). A contact's first stage reads the first row's from-stage, as
opportunities do. The Campaigns tab waits for the list instead of flashing it before opening the current
campaign. Staff exclusion on production removes 2 of Board's 12 pipeline contacts (company Pursuit: Jukay
Hsu, David Yang), 1 of Op 35's, and 47 tagged Volunteer (Past) contacts.

**Order to apply.** Deploy or migrate first, either works: before the migration every campaign reads current
and the tab opens on the list; "Make current" answers 409 until then.

**For people.**
- Avni: the four Peloton contacts (Barry McCarthy under Hiring Partner) and three Red Canary contacts were set
  Not a fit by Avni in one action on 9/10. Deliberate? They now read Not a fit and "Not yet" contacted.
- The Future Forum's "34 touches" were 23 emails from Aaron, 7 non-jobs emails and 4 unclear meetings: 0
  activity under the rule, so "Not yet" stands. A person can mark the meetings jobs-related if they were.
- David Yang (Pursuit) and Jukay Hsu are out of every campaign as staff. David's record never recorded its
  move to Not a fit.

**Open / follow-ups.**
- PRO-106 rebuilds the Outreach view: its "Moved to outreach / assigned" column is a stage count, not
  contacted; decide there whether it becomes contacted ÷ assigned.
- Campaign list now scans all-time activity for every pipeline contact on load (the detail view already did,
  per campaign). Fine at today's size; cache if it slows.
- Whether outreach → call is also a milestone is open (Avni, PRO-94).
