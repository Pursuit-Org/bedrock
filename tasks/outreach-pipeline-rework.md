# Outreach + Opportunities pipeline rework (2026-08-03)

Kwame's review round on **Performance → Outreach** and **Performance → Pipeline**
(`JobsOutreach.tsx`, `JobsOpportunitiesOverview.tsx`, shared `JobsFunnels.tsx`
and `ActivityTrends.tsx`).

## Decisions taken before building

| Question | Decision |
|---|---|
| What the conversion % measures | **Period flow** — count of records that *entered* each stage during the period; `% = this stage's entries ÷ previous stage's entries`. Not a cohort of the same people. |
| Which funnels get a period | **Outreach + Pipeline only.** Exec view (`JobsLeadership`) keeps the all-time snapshot — it has no period control, and silently shrinking its numbers would misread. |
| "Replied — needs a decision" | **Folded into Requiring Attention** as a card that expands to today's detail table. Removed as a standalone section (it's on Jobs Home). |
| Activity-over-time chart | **Single line** (accounts reached), with a dropdown to switch to New vs Existing. "Accounts reached" stat card dropped. |

Consequence of period flow worth knowing: a stage can exceed 100% conversion
when more records entered it than entered the stage before it during the same
window (i.e. the team cleared a backlog). That's real signal, not a bug — the
tooltip says so rather than the number being suppressed.

## Checklist

### Backend — `routes/jobs.py`
- [ ] `GET /funnel/{ftype}` takes optional `period_from` / `period_to`
- [ ] Prospects period entries off the membership stamps (`assigned_at`,
      `first_outreach_at`, `converted_at`); `on_hold` off
      `jobs_membership_stage_history`
- [ ] Opportunities period entries off `jobs_stage_history`, plus opps
      *created into* a stage in the window (no history row)
- [ ] Period records carry `entered_at`, `assigned_by`, `owner`
- [ ] Snapshot path unchanged when no period is passed (Exec view)

### Shared components
- [ ] `JobsFunnels.tsx` — tapered funnel visual; accepts a period; period-aware
      counts, labels and conversion; stage drill shows who/when/owner
- [ ] `ActivityTrends.tsx` — `LineChart`, New/Existing behind a dropdown,
      "Accounts reached" stat removed

### Outreach page
- [ ] Remove standalone `RespondedPanel`, Stuck section, Hygiene section
- [ ] New `RequiringAttention` — three cards (replies needing a decision +
      7d trend · stuck in initial outreach + avg touches / avg last touch ·
      accounts awaiting activation), each expanding to the existing detail
- [ ] `ActivityTrends` moved below the "Sender segments and accounts" divider
- [ ] Page period wired into the funnel

### Pipeline (Opportunities Overview) page
- [ ] "Won, open tasks" card moved left of the stacked Closed won / lost boxes
- [ ] Order: summary → funnel → Time in Pipeline + Active-set distribution →
      **Priority × Time** → **Stage × Time** → Recent activity → Pipeline details
- [ ] Rebuild both heatmaps per spec (backend + TS types already exist —
      `routes/jobs.py:1857-2172`, `services/jobs.ts:2131`; only the UI was deleted)
- [ ] Deal-type segmentation kept, styled consistently with Outreach
- [ ] Page period wired into the funnel

### Verify
- [ ] `npm run typecheck` clean
- [ ] Both pages render against the local replica; screenshot each

## Review

All items shipped. `npx tsc -p tsconfig.json --noEmit` clean; both pages verified
in a browser against a local replica of segundo-db.

**Backend** — `GET /funnel/{ftype}` gained `period_from` / `period_to`. Period
entries come from two sources unioned per `(record, stage)`, because neither is
complete on its own: the membership row stamps `assigned_at` /
`first_outreach_at` / `converted_at`, and `jobs_membership_stage_history` covers
every transition but only since we started writing it. The stamp wins on
conflict. Caught during testing: stamps alone reported 8 Initial Outreach entries
where the stage actually held 23 — the history fallback closes that gap. For
opportunities, entries come from `jobs_stage_history` plus opps *created into* a
stage inside the window, which have no history row and would otherwise vanish.

**Two things worth knowing about the numbers**

1. Conversion can read over 100% — a real period-flow result, seen live at 350%
   on Builder Interview (7 entries into Closed Won against 2 into Builder
   Interview). It means more moved forward than arrived, because they entered the
   prior stage earlier. The connector tooltip explains it rather than the value
   being clamped, which is what made the old snapshot ratio untrustworthy.
2. `_NO_CONVERSION_FROM` suppresses the rate on Converted, On Hold and Closed Won
   — the next row in `stage_order` isn't a forward step from any of them.

**Unrequested change, flagged.** The Pipeline page ended up with two deal-type
controls — the page dropdown plus the funnel's own pill row — which contradicted
"consistent with outreach". `JobsFunnels` now takes an optional `dealType`; when
the host passes it the internal pills hide. Exec view still owns its own lens.

**Not done:** `npm run lint` — the repo has no `eslint.config.js`, so ESLint 9
refuses to run. Pre-existing, unrelated to this change.

**Regression checks.** Exec view keeps snapshot mode (no period leakage, own
deal-type pills, funnel switcher intact, no page errors). The `builders` funnel
ignores a period on both sides, since it has no stage-entry stamps and would
silently return zeros.

**Sandbox caveat on the screenshots.** The replica holds a July sample, so the
default current-week window reads 0 across the funnel; the taper and conversions
were verified against 20–31 Jul. Membership `owner_email` is null in the sample,
so the drill's Owner column shows "—" there but will populate in production.
