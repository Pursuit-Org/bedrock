# Campaigns view + Outreach updates (2026-09-15)

Branch: `claude/tender-hopper-px28jl`. Two workstreams, tracked together.

## 1. Campaigns as a first-class Jobs view

**Decision (Kwame, 2026-09-15):** promote the existing `TagCampaigns` component
out of the Outreach tab into its own route and expand it. NOT a new outbound
sequencing object — no new tables, no cadence engine. Tags stay the campaign
primitive.

**Why this reading wins.** `bedrock.contact_tag_catalog` already carries
`sort_order` (priority) and `owner_email` (accountable staffer), and
`/api/jobs/tag-campaigns` already returns the funnel. A parallel "campaign"
object would put two competing definitions of the same thing in front of the
same RMs. Promoting costs a route; inventing costs a data model.

### Existing backend — no new endpoints needed for Phase 1 or 2
| Endpoint | Gives us |
|---|---|
| `GET /api/jobs/tag-campaigns` | key, label, slugs, sort_order, owner_email, contacts, accounts, in_pipeline, disjoint funnel |
| `GET /api/jobs/tag-campaigns/{key}/records` | contacts (stage, stage_entered_at, owner, touches, last_touch) + accounts (company, contacts, contacted) |
| `PUT /api/jobs/tag-campaigns/order` | drag-to-reorder priority |
| `PUT /api/jobs/tag-campaigns/owner` | assign staff owner |

### Phase 1 — Promote ✅ DONE
- [x] `src/pages/jobs/JobsCampaigns.tsx` — new page
- [x] Portfolio summary strip: campaigns, in pipeline, reached, converted
- [x] Reuse `TagCampaigns` list unchanged (drag priority, owner, funnel bar)

### Phase 2 — Campaign detail ✅ DONE (2026-09-15)
Kwame's round: campaigns move under Dashboard as a tab; a picker at the top;
summary card; outreach stats; trend line.
- [x] Campaigns is a **Dashboard tab** (`/jobs/performance?tab=campaigns`), second
      after Overview. Standalone `/jobs/campaigns` redirects; sidebar entry removed
      so there is one home, per the `JOBS_UX_LOG.md` no-duplicate-UI lesson.
- [x] `_campaign_key` groups `operation_35_*` (5 slugs) into one **Operation 35**,
      the same way `alumni_*` already collapsed. Prefix match is `== p` or
      `startswith(p + "_")` so a future `board_advisors` can't fold into `board`.
- [x] **Funnel bug fixed** — `call_booked` and `not_a_fit` were absent from
      `/tag-campaigns`, and `not_yet` is derived as the remainder, so 27 worked
      Operation 35 contacts were being reported as never contacted. `on_hold` now
      folds into `revisit`, matching `canon_membership_stage()`.
- [x] New `GET /tag-campaigns/{key}/stats` — one round trip: all-time totals +
      stage funnel + activation, period outbound volume by channel, zero-filled
      trend. Params `granularity` (day|week|month), `date_from`, `date_to`.
- [x] Campaign picker dropdown, activation card, stage bar, channel stats, trend chart

**Verified against production (read-only) for Operation 35:** 449 contacts / 389
accounts / 113 with an email; 93 contacts and 82 accounts activated; stages
336 none, 35 assigned, 35 initial_outreach, 10 call_booked, 16 converted,
13 not_a_fit, 4 revisit. Trailing 12 weeks: 56 emails, 4 meetings, 5 calls,
10 texts, 1 LinkedIn; 48 contacts and 46 accounts reached.

### Phase 3 — Nesting, period, activity feed ✅ DONE (2026-09-15)
Kwame's second round.
- [x] Campaigns nests **under Overview** as a sub-tab (`?tab=exec&sub=campaigns`),
      not beside it. Overview and Campaigns answer the same question at different
      altitudes; Outreach and Pipeline are different books.
- [x] `Campaigns · coverage` removed from the Outreach tab. One home.
- [x] Shared `PeriodBar` on the campaign detail, same control as Outreach and
      Pipeline. Drives outreach volume, the trend and the activity feed.
      Activation and the stage funnel stay ALL-TIME and say so — activation is a
      state, and period-scoping it would read as contacts un-activating.
- [x] New `GET /tag-campaigns/{key}/activity` — touches, stage changes and
      additions for the campaign's contacts, newest first, with `owner` filter.
- [x] Activity feed with **Owner** and **Changed by** as separate columns, plus
      an owner filter. Bulk work collapses on (day, kind, stage, actor, owner),
      so eight contacts marked Not a fit in one sitting read as one line.

**Verified against production for Operation 35:** stage history 202 rows (170
with an actor), memberships 113 (92 with assigned_by). Effective owners —
Avni 42, Kwame 38, Damon 10, Devika 7, Nick 1, Victoria 1.

### Phase 4 — Activation layout, daily trend, activity drill ✅ DONE (2026-09-15)
Kwame's third round.
- [x] **Activation card rebuilt** into three groups. Activated (contacts over
      accounts, stacked) · Not yet activated · Converted to oppty. "Reachable by
      email" removed. Idle is the complement of activated over the same
      populations, so the two groups always sum to the whole.
- [x] **Stage bar 50% taller** (h-4 → h-6), counts rendered inside each band,
      labels moved to a legend below. Bands under ~4% width omit the inline
      number (it would clip); the legend still carries it.
- [x] **Trend defaults to daily points** over a trailing month — ~30 points.
      The Daily preset alone draws one dot and Weekly over a month draws four.
- [x] **Meetings + logged calls merged into one "Calls booked"** channel, in the
      stat grid, the trend line and the activity badges.
- [x] **Activity**: 25 rows then "Show all N"; All / Outreach / Funnel segment
      buttons (All default); Account as its own column; rows expand to list the
      contacts explicitly with email subject and preview; stage moves read
      "Assigned → Initial outreach" rather than just the destination.
- [x] **Owner is now the real assignment** — contact owner, else account owner,
      else blank. The inferred fallback is gone. Renamed the actor column to
      **Editor**. Owner dropdown shows display names, not emails.

**Verified against production for Operation 35:** owner coverage 96 of 449
(contact 7, account 90) — `bedrock.jobs_account.owner_email` is populated on 269
of 282 accounts, which is what makes the column usable. Trailing 30 days in
daily buckets: 31 points, 43 emails, 8 calls booked, 8 other. All six owner
emails resolve to display names via `/api/jobs/staff`.

### Phase 5 — Trim + Outreach sub-tabs ✅ DONE (2026-09-16)
Kwame's fourth round.

**Campaigns**
- [x] Portfolio rollup cards removed; the prioritised list is the whole view now
- [x] Picker slimmed to one line and `h-full` inside an `items-stretch` row, so
      it matches the period bar's height; in-pipeline badge dropped from the
      closed control (the list rows keep their counts)
- [x] Activation: note text gone, "Not yet activated" gone, and the two figures
      restyled — accounts over contacts, each with its own share bar and a rule
      between them, rather than two numbers sitting flush
- [x] Outreach card: Notes channel, note text and the reached/last-touch footer
      all removed
- [x] "Outreach over time" → **"Outreach trends"**, subtitle removed
- [x] Activity feed paginates at 10, not 25

**Outreach tab** — now mirrors Overview's two-level nav
- [x] Sub-tabs **Overview** and **Outbound Detail**, under the shared period bar
      (period, scope and sender govern both)
- [x] Activity Pipeline table lifted out of `ThisWeekBlock` into its own
      `ActivityPipelineBlock` and moved to Outbound Detail
- [x] New `OutreachSummaryCards` — accounts activated · calls booked · converted
      — on BOTH sub-tabs; on Overview it occupies the space the Activity
      Pipeline table vacated
- [x] New `GET /outreach/summary`, honouring the page's window and sender scope

**Verified against production (jobs team, trailing 30 days):** 44 accounts
activated, 79 reached, 31 calls booked, 12 converted.

**Definition worth confirming:** "accounts activated" counts accounts whose
FIRST-EVER team touch lands in the window, since activation is a transition —
counting any touch would re-activate the same account every period it gets a
follow-up. The wider "reached" number rides in the card's sub-line.

### Phase 6 — Outbound Detail build-out ✅ DONE (2026-09-16)
Kwame's fifth round.

**Outreach tab**
- [x] Sub-tabs get icons + the underline chrome Overview → Campaigns uses, and
      move ABOVE the period bar: pick the view, then the window
- [x] Fourth card **Outreach activity** between Accounts activated and Calls
      booked — send volume (email + LinkedIn + text). Meetings and calls stay
      out: they are the Calls booked card, and counting them here would inflate
      an effort number with outcomes
- [x] **Accounts activated redefined** to Kwame's spec: touched in the window
      after going quiet for 90+ days. Replaces "first-ever touch", which
      undercounted because most of this book has been contacted at some point
- [x] Outreach Trends chart moved from Overview to Outbound Detail, below the
      Activity Pipeline table
- [x] New send feed on Outbound Detail via `GET /outreach/activity`, scoped by
      the page's sender control rather than a filter of its own
- [x] Divider renamed "Segments & activity over time" → **"Segments"**;
      Targeting now runs full width there

**Campaigns**
- [x] Activation rows relaid out: bar shortened to 84px, then the percentage,
      then `n / total` to its right
- [x] "Worked past assigned" removed from the Converted card

**Shared**
- [x] Activity feed extracted to `components/jobs/ActivityFeed.tsx` and used by
      both Campaigns and Outbound Detail. Segments and the owner control are
      both optional, so the sends-only feed shows neither.

**Verified against production (jobs team, trailing 30 days):** 48 accounts
activated (90-day dormancy; the old first-ever rule gave 44), 79 reached,
104 outreach activity, 31 calls booked.

### Phase 7 — Funnel flowchart + drill-downs ✅ DONE (2026-09-17)
Kwame's sixth round.

**Campaigns**
- [x] Activation bar flexes to fill the card instead of a fixed 84px
- [x] Stacked stage bar replaced by a **left-to-right funnel**: all contacts →
      assigned / not assigned → contacted / not yet contacted → outcome
      (converted · call booked · contacted-no-outcome · revisit · not a fit).
      Column widths are fixed, not proportional: at 449-to-4 the small branches
      would round to nothing, so share rides on each node's own bar and percent
- [x] Channel tiles (emails, calls booked, LinkedIn, texts) open the sends
      behind them — 5 rows then Show all
- [x] Trend points are clickable; a point opens what went out in that bucket
- [x] "Outreach trends" → **"Outreach Trends"**

**Outreach tab**
- [x] All four summary cards clickable, each opening its own drill list
- [x] Accounts activated recoloured to black; only Converted stays green
- [x] Card subtitles removed
- [x] Backend `/outreach/summary` now returns a `drills` object, capped at 60
      rows per card

**Shared**
- [x] `components/jobs/DrillList.tsx` — Name · Account · Detail · Owner ·
      Editor · When, 5 rows then Show all. Used by the campaign channel tiles,
      the trend points and all four Outreach cards, so one number never gets
      two different explanations.

**Note on the trend drill:** a point covers its own bucket start up to the next
point's, not an exact date match — otherwise weekly and monthly buckets would
open empty.

### Phase 8 — Pipeline Sankey ✅ DONE (2026-09-17)
- [x] `components/jobs/PipelineSankey.tsx` — the campaign pipeline as a Sankey,
      built on recharts 3.8's `Sankey` with custom node and link renderers to
      match Kwame's reference: neutral slate nodes, grey ribbons, colour kept
      only for Converted (green), Call booked (teal) and Not a fit (rose).
- [x] It replaces BOTH the Converted stat that sat top-right and the column
      flowchart below it — the Sankey carries both. Activated keeps the left
      third; the Sankey takes two thirds, since a four-column flow needs the
      width more than a two-row stat does.

**Zero-value branches are dropped, then nodes are reindexed.** A campaign with
nobody at Revisit should not show a Revisit label on an invisible ribbon, and
recharts lays degenerate links out badly. Builder verified across four shapes:
Operation 35 (10 nodes / 9 links, no invalid), an all-zero campaign (renders an
empty state rather than a broken chart), an untouched-only campaign (2 nodes),
and one with no outcomes yet (4 nodes).

### Phase 9 — Sankey rebuilt, hand-laid ✅ DONE (2026-09-17)
Kwame asked why "Assigned" floated to the middle of its column.

**Answer: recharts was choosing, not the data.** Its Sankey runs a
crossing-minimisation pass that nudges nodes vertically and exposes no way to
pin their order, so the node with children got centred while the dead-end
branch drifted. In a funnel the ordering IS the message, so the layout is now
written by hand and deterministic.

- [x] Custom SVG layout replaces recharts' `Sankey`. Single pass: each node's
      height is its value, children stack in declared order anchored to the
      parent's top edge. Working branch on top, dead ends below.
- [x] Per-node colours. Grey now means only "no progress claimed" — All
      contacts, Not assigned, Awaiting contact. Assigned (sky), Contacted
      (indigo), Converted (green), Call booked (teal), In outreach (violet),
      Revisit (amber), Not a fit (rose).
- [x] Every label is clickable and opens a panel to the right of the chart,
      inside the same card, 8 rows then Show all. Derived from `/records`,
      which already carries every in-pipeline contact with its stage — no new
      endpoint.
- [x] `inBucket()` mirrors `pipelineCounts()` exactly, so a label's number and
      the list it opens can never disagree.
- [x] `MIN_H` floor of 3px: Revisit at 4 of 449 was a sub-pixel hairline, and
      an invisible branch reads as a missing one.

**Layout verified for Operation 35 at 760×300:** col1 Assigned y=16 above Not
assigned y=81; col2 Contacted above Awaiting; every child inside its parent's
band; tallest extent 259px inside the 300px box.

### Phase 10 — Sankey reverted to recharts, digest moved ✅ DONE (2026-09-17)
- [x] **Reverted to the recharts Sankey.** The hand-laid version from Phase 9
      pinned the node order correctly but read worse, and Kwame preferred the
      original. Recharts' crossing-minimisation is back, so "Assigned" sits
      mid-column again — that position is the library balancing the picture,
      not the data. Noted in the file header so nobody re-litigates it.
- [x] Kept everything Phase 9 added that was independent of the layout: the
      per-node palette (grey only for All contacts / Not assigned / Awaiting
      contact) and the clickable labels with their bucket panel.
- [x] Clicking a node dims the rest of the flow; clicking it again clears.
      `bucket` rides on each node object so recharts hands it to the renderer.
- [x] Daily digest moved from Outreach → Overview to Outreach → Outbound
      Detail, first card under the period bar.

### Phase 11 — Fix: /records applied the wrong stage vocabulary ✅ (2026-09-17)
**Bug:** clicking "In outreach 35" on the Sankey opened "No contacts in this
bucket."

**Cause:** `tag_campaign_records` canonicalised a MEMBERSHIP stage through
`canon_stage()`, the OPPORTUNITY map, which rewrites `initial_outreach` into
`active_in_discussions`. That is not a membership stage at all, so every
consumer matching on membership vocabulary silently found nothing for those
contacts.

**Fix:** use `canon_membership_stage()`. One line.

**Blast radius beyond the new panel:** `TagCampaigns.tsx:259` renders the
drill's stage via `MEMBERSHIP_STAGE_LABELS[stage]`, so those same contacts had
been showing a blank stage in the campaign list drill since before this branch.
Fixed by the same change.

**Checked the other four `canon_stage()` call sites** — `/opportunities/overview`
(x2), `/roles` and the job-applications join all read `jobs_opportunity.stage`,
where the opportunity map is correct. `/records` was the only mis-application.

**Verified against production for Operation 35:** 336 no stage · 35 assigned ·
35 initial_outreach · 19 converted · 13 not_a_fit · 7 call_booked · 4 revisit
= 449, matching every Sankey label and every `inBucket()` case.

### Phase 12 — Pinned campaigns ✅ (2026-09-17)
- [x] `src/lib/pinnedCampaigns.ts` — localStorage-backed pin set, following the
      `collapsible.ts` house pattern, every read and write wrapped so a private
      window or cleared site data costs a click rather than a crash.
- [x] Pin icon on every picker row; pinned campaigns list first under a
      "Pinned" heading, the rest under "All campaigns".
- [x] Pinned keep the CATALOG's order among themselves, not pin-click order —
      the list is still the team's queue, just filtered to the top.

**Why localStorage and not `catalog.sort_order`:** that field is the team's
shared outreach priority, edited by dragging the campaign list. One person
opening Operation 35 twenty times a day is not a reason to reorder everyone
else's queue.

### Auth note (not a code change)
Kwame lost his session again. Ruled out both mechanisms that would make it
recur: there is no 401 interceptor in `lib/api.ts` (nothing logs you out
programmatically), and `main.py:13` runs `load_dotenv(override=True)` well
before the route imports, so `JWT_SECRET_KEY` comes from `.env` and survives
every backend restart. The cookie was simply cleared browser-side. Permanent
fix remains `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from Jac.

### Phase 13 — Stage expansion + call breakdown ✅ (2026-09-21)

Kwame's two asks: more opportunity stages, and an Activity Pipeline that shows
what kind of call was made.

**Opportunity pipeline: 6 stages → 8.**
`active_in_discussions → ask_submitted → active_opportunity_confirmed →
builder_submitted → builder_interviewing → offer_contracting → closed_won →
closed_lost`, each carrying the team's own definition, shown on the picker.

Two stages retired:
- `reviewing_builders` meant "profiles sent" OR "in interviews" — the exact
  ambiguity the two new stages remove. 5 rows remap to `builder_submitted`
  (the earlier of the two, so the remap never claims an interview that may not
  have happened).
- `lead_submitted` described a contact, not a deal; that work lives in the
  membership pipeline. 2 rows remap to `active_in_discussions`.

Both stay in `STAGE_LABELS` and `LEGACY_STAGES`: rendered, never offered.

**Bug found and fixed while expanding.** Every "is this deal active" filter
leaned on `stage LIKE 'active_%'`. The four new stages dropped that prefix, so
they would have fallen out of the weekly overview, the stage heatmap, Active
Orgs and Active Companies entirely. Replaced with a derived
`OPPORTUNITY_STAGES_ACTIVE_ANY` list, and the opportunities funnel now derives
its rows from `OPPORTUNITY_STAGES_NEW` so it can never again miss a stage.

**Activity Pipeline hierarchy.**
```
Total Outreach Activity          depth 0, bold
  Direct Email Sent              depth 1
  LinkedIn Messages Sent         depth 1
  Facilitated Intro              depth 1
  Total Calls                    depth 1
    Discovery Calls              depth 2   pending migration
    Solution Calls               depth 2   pending migration
    General Calls                depth 2   pending migration
    Unclassified                 depth 2   (hidden once it hits zero)
Engagements                      depth 0
Direct Email Responses           depth 0
```
Indentation is read off a `depth` field on each row, not off a list of metric
names the table has to keep in sync with the API.

**Counting rule changed for the tier-1 rows: events, not distinct contacts.**
Three reasons, and the numbers will move:
1. The labels already promise volume ("Messages Sent").
2. A parent only equals the sum of its children under event counting.
3. `count(DISTINCT contact_id)` silently dropped every email to an address
   Bedrock has no contact row for.
Engagements and Direct Email Responses stay distinct-contact — they are
outcomes, and "how many contacts engaged" is the right question there.

**Call type at log time.** `CallKindPicker` (discovery / solution / general)
appears on both log-a-call forms — the opportunity row in the Jobs pipeline and
the account Activity tab. Options and availability come from
`/stage-vocabulary`, the same probe the stage pickers use.

**Two migrations for Jac, both probed per request so they light up with no deploy:**
- `2026-09-21-opportunity-stage-expansion.sql` — remaps 7 rows, then narrows the
  CHECK constraint to the 8 stages. Probe settles on `offer_contracting`.
- `2026-09-21-activity-call-kind.sql` — adds `bedrock.activity.call_kind` plus a
  partial index. Probe is `_has_column`.

Verified against production (read-only): `call_kind` does not exist yet, so the
three breakdown rows render disabled with "pending migration" and the picker's
buttons are greyed. Team-scope calls last full week: 4 logged calls + 11
meetings = 15, which is what Total Calls will read.

**Open question for Kwame.** Engagements (calls/meetings + email replies) now
overlaps Total Calls. They sit at different depths and answer different
questions, so I left both — say the word if Engagements should drop the
call/meeting half and become replies only.

**Not built, deliberately.** The activity feed does not yet badge a call with its
type. The Activity Pipeline breakdown is the evidence that a tag saved, and the
column does not exist yet, so there is nothing to display until Jac applies it.

### Phase 14 — Activity Pipeline trimmed to two totals ✅ (2026-09-21)

Kwame's review of Phase 13. The table is now two peer sections, not one tree.

```
Total Outreach Activity     depth 0   target 100/wk
  Direct Email Sent
  LinkedIn Messages Sent
  Facilitated Intro
Total Calls                 depth 0   target 10/wk
  Discovery Calls                     pending migration
  Solution Calls                      pending migration
  General Calls                       carries every untagged call
```

**The two totals are now DISJOINT.** Total Outreach Activity no longer contains
calls. This follows from Kwame promoting Total Calls to depth 0 with a target of
its own, and it makes the table finally agree with the Outreach Overview card,
which has always defined outreach activity as sends only with calls excluded.
Verified on production for the week of Sep 6: outreach 14 = 14 + 0 + 0, calls
10 = 0 + 0 + 10. Each parent equals the sum of its children exactly.

**Unclassified is gone.** An untagged call reads as General rather than sitting
in a bucket nobody will ever clean up (`CALL_KIND_DEFAULT`). General therefore
stays enabled pre-migration and carries the real count; only Discovery and
Solution grey out.

**Engagements and Direct Email Responses removed.** Engagements overlapped Total
Calls and nobody could say what it meant. Their drill keys stay live on
`/outreach/scorecard/detail`, so restoring either row costs one line in
`_OUTREACH_ACTIVITY_META`. Dropping them also removed the `sent_out` /
`first_reply` / `engagement_events` CTEs, which were the expensive half of the
scorecard query — a self-join across every parsed email message.

**Targets.** First real numbers: 100 outreach touches and 10 calls a week for
the team. `_weekly()` spreads a weekly goal to day (÷5) and month (×4.33) so the
other granularities are arithmetic on Kwame's number rather than invented ones.
Only the two totals carry a goal; a target on each child would double-count the
same week's work.

**Header and alignment.** Each period column is now a stacked heading — label on
top, window in grey underneath — and every numeric column is centre-aligned, so
each number sits directly under the dates it covers. "Last" became "Last Period"
and gained its own window.

**Team tabs.** A segmented control sits at the right of the Activity Pipeline
title: All jobs team, Avni, Damon, Devika. It drives the PAGE's owner state
rather than keeping its own, so it can never disagree with the sender select in
the period bar.

### Phase 15 — Tab swap, per-person targets, sender pins ✅ (2026-09-21)

**The two Outreach sub-tabs swapped contents.** Overview is now the weekly
review itself: summary cards, Activity Pipeline, Outreach Detail, Outreach
Trends, the contacts funnel and the send feed. Outbound Detail holds the
supporting cuts: Targeting Mix, then the Current State zone (Touch Depth,
Requiring Attention). The old split put the review's own numbers a tab away
from the review. The contacts funnel stayed with Overview rather than moving —
it is top-of-funnel context for the review, not a supporting cut. "Outbound
Detail" is now a poor name for what the tab holds; flagged for Kwame.

**Per-person targets.** `activity_pipeline_target()` takes an optional `owner`.
Avni, Damon and Devika each carry 50 outreach a week against the team's 100 —
deliberately not a division of it (50 × 3 = 150). The team figure is the floor
the group owes, the personal figure is what each person is asked to carry. An
owner view therefore reads ONLY from `OWNER_ACTIVITY_TARGETS`; falling back to
the team's 100 would show every individual as missing by half every week.
Unset: Kwame's outreach number and everyone's call number.

**"Total Outreach Activity" renamed "Total Outreach"** (label only; the metric
key stays `total_outreach_activity` so targets and drill URLs are untouched).

**Bug fixed: hand-logged emails were invisible to Total Outreach.** Kwame asked
why the Outreach Activity card and Total Outreach disagreed. Root cause: only
`gmail-sync` writes `bedrock.activity_email_message`, and `sent_msgs` counted
nothing but parsed messages. In the week of 2026-09-06, 13 of 17 jobs email
rows had no parsed messages — 10 manual, 3 Salesforce — so every email the team
typed into Bedrock by hand counted for nothing. `sent_msgs` now unions a second
branch for rows with no parsed messages, dated and attributed at the row level,
with a `NOT EXISTS` guard keeping the branches disjoint. Direct Email Sent for
that week went 14 → 27. This also fixes the User Pipeline's Outreached row,
which reads the same CTE.

The two numbers still differ by design, and now for stateable reasons: the card
counts activity ROWS (a thread once, however many messages went out) and only
where the contact resolves to a company; Total Outreach counts each outbound
message.

**Sender pins moved into the period card.** The All jobs team / Avni / Damon /
Devika strip came off the right of the Activity Pipeline title, where it looked
like it filtered that one table. It now sits on a second row inside the period
card, under a hairline rule, beside a sender dropdown whose first optgroup is
Jobs Team (Avni, Damon, Devika, Kwame) and second is Everyone else. The pipeline
title now just echoes whose numbers are on screen.

`JOBS_TEAM_PINNED` is deliberately a superset of `JOBS_TEAM_EMAILS`. Adding
Kwame to the latter would change what the "Jobs Team" SCOPE counts, and so every
team number on every page. Pinning is only about which names you should not have
to scroll to. Two questions, two lists.

### Phase 16 — Real targets ✅ (2026-09-21)

Kwame's numbers, and this time the team figure is the sum of the people rather
than a separate stretch:

| | Outreach / wk | Calls / wk |
|---|---|---|
| Avni | 45 | 5 |
| Damon | 45 | 5 |
| Devika | 50 | 5 |
| Kwame | 10 | 0 |
| **Team** | **150** | **15** |

`OWNER_ACTIVITY_TARGETS` is now the source and `_team_total()` sums it, so moving
one person's number can never leave the team figure stale. Kwame's call target is
an explicit 0, which renders as "Target 0, Δ —" instead of the blank a missing
entry would give: the row says the target is none, not that nobody set one.

**Known gap, Kwame's decision.** Kwame carries 10 of the 150 but is not in
`JOBS_TEAM_EMAILS`, so the "Jobs Team" scope does not count his sends. The team
view is therefore ~10 a week short of its own target by construction. Calls are
unaffected (his target is 0). Closing it means adding him to `JOBS_TEAM_EMAILS`,
which is referenced in ~20 places across `routes/jobs.py` — including
`_jobs_activity_flag`, which decides what counts as jobs activity at all — so it
would move every team-scoped number on every Jobs page, not just this table.
Flagged rather than done.

### Phase 17 — Sender picker reverted, Overview relaid out, account drill ✅ (2026-09-21)

**Sender pins reverted.** The All jobs team / Avni / Damon / Devika button strip
is gone and the period card is one row again: Period, dates, presets, then
Jobs Team / Other Staff / Everyone and the sender dropdown. What survived is the
grouping Kwame liked — All senders, then a **Jobs Team** optgroup (Avni, Damon,
Devika, Kwame), then **Other Pursuit staff**. A button strip spent a whole row
of the card to save the same click the optgroup already saves.

**Whose data, as a chip.** Top right of Activity Pipeline: `⊙ VIEWING · Avni
Nahar`, filled accent when one person is selected, quiet grey outline for a
group. The strong treatment goes to the individual case on purpose — a filter
narrowed to one person is the state you can forget you are in and then misread a
target by. The control that sets it is several sections up the page, so the
table states it rather than making you scroll back to check.

**Overview relaid out.** Contact Pipeline returns to the top. Outreach Trends and
Touch Depth now share a 2-up grid (Touch Depth moved off Outbound Detail), which
puts "how much went out" next to "was any of it followed up" — the same question
from two sides. They stack below `lg`. One asymmetry left standing and stated in
Touch Depth's own subtitle: the trend follows the period bar, Touch Depth is
always "right now".

Overview: Contact Pipeline → summary cards → Activity Pipeline → Outreach Detail
→ [Outreach Trends | Touch Depth] → send feed.
Outbound Detail: Targeting Mix → Current State → Requiring Attention.

**Scorecard drill is account-first.** It listed one row per contact, each
repeating its company, so four people at Blackstone read as four rows you had to
reassemble. Now: account on the left, the contacts under it (first three, then
`+N`), who worked them, and the account's total touches. Expanding shows each
contact with their own touches, as before.

Grouped on the client. The endpoint already returns every contact behind the
number, so the second shape is a `reduce`, not a round trip. Accounts sort by
touch volume, since the drill is opened to see where the volume went, and
contacts with no company share one "No account on file" bucket rather than each
becoming a single-contact account at the top of the list.

### Phase 18 — One definition behind both numbers ✅ (2026-09-21)

Kwame: "I'm still seeing discrepancies between Outreach Activity and Total
Outreach, these should be the same no?" They should. They now come from the same
SQL, and two more bugs fell out of getting there.

**`_send_events_sql()` / `_call_events_sql()`** are the single definition, read
by `/outreach/summary` (the cards) and `/outreach/scorecard` (the table). They
had been built separately and disagreed for five compounding reasons:

| | Card, before | Table, before | Now |
|---|---|---|---|
| Email grain | thread row | parsed message | message, or the row when nothing is parsed |
| Hand-logged email | counted | dropped | counted |
| Texts | counted | no row | own row |
| Facilitated intros | dropped | counted | counted |
| Contact with no company | dropped | counted | counted |
| Window | **one day too wide** | correct | correct |

**Bug: every card on `/outreach/summary` counted one extra day.**
`_outreach_windows()` already returns `this_end` exclusive (`date_to + 1 day`),
and all eight windows in that endpoint then wrote `< ($2::date + 1)`, adding a
second. Accounts Activated, Outreach Activity, Calls Booked and Converted were
all a day wide of the table beside them. Fixed to `< $2` throughout.

Verified on production for Sep 14–20, team scope: card 71, table 71, calls 15.
Identical by construction, not by coincidence — same SQL.

**Texts Sent** is a new tier-1 row, so the children still sum to Total Outreach
now that texts count (27 rows in the book, 0 last week).

**Solution calls removed**, from the metadata, the drill, the targets and the
migration's CHECK. Two kinds: Discovery and General. The line between learning a
need and working it was a judgement call at log time, and a picker that makes
people hesitate gets skipped.

**Discovery Calls carries a target**, equal to Total Calls at every level: 5 for
Avni, Damon and Devika, 0 for Kwame, 15 for the team. It is a target about the
MIX, not extra volume — the same 15 calls, with an expectation about what kind
they are. A week hit entirely on check-ins shows Total Calls met and Discovery
short, which is the signal wanted.

**Also:** the "Sep 13 – Sep 20 · trends compare with …" line above Contact
Pipeline is gone (it was the third statement of the same two dates on one
screen), and the card reads "Outreach Activity".

### Phase 19 — Outreach collapses to one page; owner cut added ✅ (2026-09-21)

**Outbound Detail is gone.** Targeting Mix was cut (Campaigns already answers
"who are we choosing to work", with a picker and a period bar it never had), and
Requiring attention moved to Jobs Home. With one tab left, the strip was chrome
costing a row and answering nothing, so Outreach is one page again.
`/outreach/targeting-mix` is still served — restoring that panel is a component,
not an endpoint.

**Requiring attention moved to Jobs Home**, extracted to
`components/jobs/RequiringAttention.tsx` (~490 lines: the three cards plus
RespondedPanel, StuckContactsPanel, HygieneBlock, ListControls). It is owner-
scoped by the page's existing Me / person / Everyone selector, so picking Avni
shows Avni's three queues. These are queues belonging to a PERSON, not
measurements of a period — Jobs Home is where you look to see what is on your
plate. The "Current state" divider did not come with it: nothing on Jobs Home is
period-scoped, so it had nothing left to divide.

**Activity Pipeline gains an Owner cut.** A two-tab switch in the card header:

```
Activity Pipeline  [Activity | Owner]                  ⊙ VIEWING · All jobs team

Owner            │      Outreach          │        Calls
                 │ Target  This   Δ       │ Target  This   Δ
Avni Nahar       │   45     47   +2       │    5      8   +3
…
All jobs team    │  150    ...            │   15    ...
```

Rows come from `OWNER_ACTIVITY_TARGETS`, not from who happened to send
something: a person with a goal and a silent week is exactly who the table
exists to show, and an activity-driven list would omit them. Sorted by
shortfall, so the conversation you need to have is at the top. The team line is
summed from the rows, never re-counted. Counted by the same
`_send_events_sql` / `_call_events_sql` helpers as everything else, per owner.

A null target renders as a dash, never 0 — "nobody set a goal" and "exactly on
goal" are different states.

**Stage × Time shows every active stage.** The `if s in stage_heat` filter hid a
stage the moment nobody occupied it, so the four stages added on 2026-09-21 were
invisible until a deal moved into one. An empty row is the useful signal here.

**Two stage pickers were silently stale.** `jobsEntity.tsx` and `accountTabs.tsx`
each hard-coded a stage list written before the 2026-08-05 and 2026-09-21
changes, still offering Initial Outreach, Builder Interview and the three On
Hold values — three of which the database CHECK constraint rejects outright, so
choosing one failed the save. Both now derive from `STAGES_ORDERED`.

**Net new and Stalled read black** on the Pipeline summary cards. Colouring a
headline count implies a verdict, and neither is one: net new means nothing
without a target, and stalled already carries amber on the board below. Net
new's delta chip still colours, which is where the judgement belongs.

### Phase 20 — Dead-code sweep, owner-view polish, pipeline reorder ✅ (2026-09-21)

**828 lines removed, 226 added.** Everything below was verified unreferenced
before deleting, and the trimmed scorecard was re-run against production: 71
outreach and 15 calls for Sep 14–20, identical to before the refactor.

| Removed | Why |
|---|---|
| `user_pipeline` + its CTEs, targets and drill branch | Nothing rendered the User Pipeline table |
| `by_sender` + its second query | Nothing rendered it |
| `_OUTREACH_WARMTH_CTES` (6 CTEs over the whole contact universe) | Existed only to split cells warm/cold; the page reads `.total` |
| `ScorecardCell {warm, cold, total}` → plain numbers | Same |
| Targeting Mix endpoint, hook, types, `_TARGETING_DIMS` | Panel cut in Phase 19 |
| Daily digest endpoint + hook | Card cut in Phase 13 |
| `engagement` / `direct_email_response` drill branches | Rows cut in Phase 15; took a self-join over every parsed email message with them |
| `JobsFunnel.tsx` (266 lines) | Unused since before this work |
| Four tombstone comments of my own | Narration git already records |

The scorecard query went from 180 rendered lines to 55. It now reads the two
shared event helpers, groups by metric, and returns.

**One bug the verification caught.** Slicing out `_OUTREACH_WARMTH_CTES` by line
range also removed `_send_events_sql` and `_call_events_sql`, which sat between
it and the endpoint. Python still parsed — they are only referenced inside
function bodies — so `tsc` and `ast.parse` both passed. Rendering the SQL
outside the app is what surfaced it. Restored from git.

**Owner view.** The window moved from under Owner (where it read as a property
of the person) to under each "This period" column, the only thing it qualifies.
The team line moved to the top, greyed, small-caps and ruled off: you read the
group result first, then who made it up, and it should not look like a fourth
person.

**One delta chip, both cuts.** `DeltaChip` replaces the percentage Trend on the
Activity tab's Δ to target. A percentage asked you to do arithmetic to answer
"how many more do I owe", which is the only question that column is for. Three
distinct states: no target is a dash, exactly on target is a green `0` with no
sign, anything else is signed.

**Pipeline reorder.** Opportunities Set now sits between Stage × Time and Recent
Activity. The heatmap says where deals are piling up and the Set is the list you
work them from; the activity feed is the narrative you read afterwards.

### Phase 21 — Fix: blank Outreach page ✅ (2026-09-21)

Kwame: "When I click on outreach its just a white page."

**Root cause of the BLANK part: the app had no error boundary anywhere.** React's
answer to an uncaught render error is to unmount the whole tree, so one bad
field on one panel took the nav, the shell and every other page with it, and put
the only diagnosis in the browser console. `PageErrorBoundary` now wraps the
`<Outlet />` inside AppShell, keyed on the pathname: the nav survives, the error
message is on screen, and navigating away resets it.

**Trigger: an API shape change against a still-running old backend.** Phase 20
collapsed `ScorecardCell {warm, cold, total}` to a plain number. A backend that
had not been restarted still returned the object, and `{r.this_period}` rendered
an object as a React child. `useOutreachScorecard` now normalises both shapes in
its queryFn — one place, clearly dated, deletable once no running backend
predates 2026-09-21.

**Verified in a headless browser**, not by reading. Built the page against a mock
API on the current shapes: 0 page errors, Activity and Owner tabs both render,
delta chips read `-79`, `0`, `+2`, `+3` as specified. The boundary itself was
proved by an induced error — it caught it, kept the nav, and printed the message.
The normalisation is checked against five inputs including the old shape.

Two findings from the exercise worth keeping:
- A Python syntax check does not catch a deleted module-level function, because
  callers only reference it inside function bodies. Phase 20's warmth-CTE
  deletion took `_send_events_sql` and `_call_events_sql` with it and still
  parsed. Rendering the SQL outside the app is what caught it.
- `tsc` and `vite build` both pass on code that cannot render. Neither is a
  substitute for loading the page.

### Phase 22 — Fix, properly: guard where the value becomes DOM ✅ (2026-09-21)

Phase 21's boundary worked — Kwame's screenshot showed the exact error instead of
a blank page — but the page was still broken, and the normalisation meant to
prevent it had shipped in the same commit.

**Why the fetch-time fix did not fix it.** Normalising inside `queryFn` only
touches rows fetched AFTER that code loads. Kwame's browser held rows in the
React Query cache from before the pull (`staleTime` is 60s), Vite hot-swapped
the component modules around them, and the new render code read a cached object
straight into the DOM. The fix and the bug were live at the same time.

**The guard moved to the render site.** `scorecardCount` is exported and called
where the number becomes DOM. That one position covers all three ways the old
shape arrives — stale cache, un-restarted backend, hot reload — where fetch-time
normalisation covered only the last. The `queryFn` map is gone.

**Verified against both shapes in a headless browser**, not by reading:
old `{warm, cold, total}` renders 71 and 15 with 0 page errors; plain numbers
render identically, Owner tab included.

The lesson, stated so it is not relearned: normalise at the boundary a value
CROSSES, not the boundary it ENTERS. Data already inside the process never
passes the entry point again.

### Phase 23 — Owner-tab drills, ordering, defaults (2026-09-21)

**Owner rows sort by target, descending**: Devika 50, Avni 45, Damon 45, Kwame
10, name breaking the tie. They sorted by shortfall before, which put whoever had
the worst week on top and reshuffled the table every Monday. A table you read by
position should not move under you.

**Group caps ruled and centred**, matching Volume / Conversion on Contact
Pipeline, so the two tables read as one system.

**Calls became Discovery Calls** under Owner, in the data as well as the label:
the per-person conversation is about how many real first conversations someone
opened, and a check-in should not fill that quota. Consequence worth knowing:
until Jac applies the call_kind migration every call defaults to `general`, so
this column reads 0 for everyone.

**Both owner numbers drill.** Clicking an actual opens the same account-grouped
list the Activity tab uses, scoped to that person: account, its contacts, who
worked them, touch count; expanding an account gives each contact's touches with
type, subject, owner and date. Reuses `RowDrill` and
`/outreach/scorecard/detail` with `owner` set, so there is no new endpoint.

**A delta of exactly 0 is grey**, on both tabs. Green is for beating the number.

**Requiring attention removed from Jobs Home** as duplicative of the zones
already there. It now exists nowhere, so `RequiringAttention.tsx` is deleted,
`SectionHead` moved back to its one remaining caller, and `useStuckContacts`
plus `GET /outreach/stuck-contacts` went with it.

**Default window is yesterday plus the seven days before it.** On 21 Sep that is
13-20 Sep. That is eight days, not seven: Kwame gave the endpoints and this is
what they span, so the `8d` the bar prints is correct. Outreach and Pipeline
share `defaultPeriod()`, so both moved together.

**Contact and Opportunity funnels open collapsed.** They are context you open
when a number raises a question, and two expanded funnels pushed the Activity
Pipeline and the Opportunities Set below the fold. The header still carries the
totals, so nothing is hidden, only deferred.

Verified in a headless browser: Outreach, Pipeline and Jobs Home all render with
0 page errors and no expanded funnel; the owner order reads Devika / Avni /
Damon / Kwame; clicking Damon's 40 opens Blackstone (David Drew, Jane Roe, 3
touches) and Sequoia (Pat Chen, 1); expanding Blackstone lists EMAIL and
LINKEDIN rows with subject and date.

### Phase 24 - Not started
- [ ] Drill from a trend point into the underlying activity list
- [ ] Contact table on the detail view (the `/records` endpoint already serves it)
- [ ] Stage-entry period flow, like `outreach-pipeline-rework.md`

### Known gaps, flagged not fixed
- **Contact-level ownership is barely used.** 7 of Operation 35's 449 contacts
  have `jobs_contact_membership.owner_email` set. Account ownership carries the
  column instead (`bedrock.jobs_account.owner_email`, 269 of 282 rows), giving
  96 of 449. The inference fallback was REMOVED per Kwame — "who touched this"
  is the Editor column, and conflating the two made Owner unreadable. Blank now
  means genuinely unassigned, which is the honest answer and a prompt to fix it
  in the tool.
- **Tag additions have no history table.** "Added to the campaign" is read off
  `jobs_contact_membership.assigned_at`, which is when the contact entered the
  jobs pipeline, not when the tag was applied. They usually coincide; when a tag
  is added to an existing pipeline contact, the feed will not show it.
- **Direction is inferred, not stored.** `bedrock.activity` has no direction
  column, so outbound = Pursuit sender (email) or hand-logged (everything else).
  A campaign contact emailed from a personal address would be missed.
- **"Calls booked" resolved (2026-09-15).** Calendar meetings and hand-logged
  calls are now one channel: both are a live conversation that got booked, and
  splitting them made the smaller number look like a failure. Volume is
  overwhelmingly calendar (719 meetings vs 5 logged calls for Operation 35).
  The `call_booked` membership STAGE stays separate in the funnel — it is
  pipeline state, not outreach volume.
- **Only 113 of 449 Operation 35 contacts have an email address.** Surfaced as
  "Reachable by email", amber below 50%.

## 2. Outreach view updates

**BLOCKED — awaiting Kwame's spec.** He is describing the changes directly
rather than working from the repo notes.

Context carried forward, not assumed:
- `JOBS_ROADMAP.md` still lists **B4 PENDING** — ActivityTrends bar click-through
  to the activity list, plus a real email viewer (not snippets).
- Open question from that round, never answered: "filter by percent" = split bars,
  or a threshold filter?

## Verify before each push
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean
- [ ] Kwame confirms visually on his local run

## Review
_(filled in as work lands)_
