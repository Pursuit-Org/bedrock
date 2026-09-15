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

### Phase 3 — Not started
- [ ] Stage-entry history per campaign (period flow, like `outreach-pipeline-rework.md`)
- [ ] Drill from a trend point into the underlying activity list
- [ ] Contact table on the detail view (the `/records` endpoint already serves it)

### Known gaps, flagged not fixed
- **Direction is inferred, not stored.** `bedrock.activity` has no direction
  column, so outbound = Pursuit sender (email) or hand-logged (everything else).
  A campaign contact emailed from a personal address would be missed.
- **"Calls booked" is ambiguous.** `call_booked` is a membership stage (10 for
  Operation 35) while `type='call'` is a hand-logged phone call (5, and 171
  org-wide). Meetings (719 all-time) are the real booked-call volume. The UI
  shows all three separately rather than picking one.
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
