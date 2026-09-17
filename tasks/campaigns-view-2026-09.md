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

### Phase 12 — Not started
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
