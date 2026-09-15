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

### Phase 1 — Promote (existing endpoints)
- [ ] `src/pages/jobs/JobsCampaigns.tsx` — new page
- [ ] Route `/jobs/campaigns` in `App.tsx`
- [ ] Nav entry in the Jobs group, `AppShell.tsx`
- [ ] Portfolio summary strip: campaigns, contacts in pipeline, contacted, converted, overall conversion
- [ ] Reuse `TagCampaigns` list unchanged (drag priority, owner, funnel bar)
- [ ] OPEN: does the block leave the Outreach tab, or render in both? Recommend
      leave — `JOBS_UX_LOG.md` lesson is don't duplicate existing UI.

### Phase 2 — Expand (existing endpoints)
- [ ] Campaign detail `/jobs/campaigns/:key`
- [ ] Full contact table off `/records`: sortable stage / touches / last touch, owner filter, search
- [ ] Accounts table with contacted-vs-total coverage
- [ ] Per-campaign stat header + funnel

### Phase 3 — Needs backend (not started)
- [ ] Progress over time per campaign (stage-entry history, like the period-flow
      work in `outreach-pipeline-rework.md`). New query in `routes/jobs.py`.

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
