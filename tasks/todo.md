# Bedrock PR Roadmap

> Master tracker for all planned PRs. Each PR has a detailed plan in `tasks/prs/`.
> Update checkboxes as work progresses.

## Production-Grade Security MVP (2026-03-18)

- [x] Phase 1: Security hardening (JWT/Fernet, prod secret, dev bypass, debug, calendar, SOQL)
- [x] Phase 2: Calendar re-auth UX, Settings Google reconnect
- [x] Phase 3: Archived feature planning docs (5 docs)
- [x] Phase 4: Documentation (lessons, env template, DEV_SETUP_GUIDE, hygiene)
- [x] Phase 5: tasks/todo.md updated
- [x] Phase 6: Manual verification (Priorities, Dashboard, Pipeline, Settings)

## Ship Order

> **Note (2026-04-16):** Detailed PR plan files (pr-01 through pr-10) archived to `docs/archive/2026-04-16-cleanup/`. Deferred items migrated to `tasks/bedrock-ui-improvements.md` (M8 calendar overlap detection, M9 task backend persistence, S6 favicon PNGs).

| # | PR | Status | Size | Depends On | Remaining |
|---|-----|--------|------|------------|-----------|
| 1 | Ranking Stability Bug Fix | `done` | S | — | Tiebreaker is deterministic (`Id.localeCompare`); no code changes needed |
| 2 | Stage Colors & Ordering | `done` | M | — | Colored dots added to PriorityTable stage filter + PipelineFilterBar stage Autocomplete |
| 3 | Column Sorting | `done` | M | PR 1 | — |
| 4 | Revenue Snapshot Filter | `done` | S | — | — |
| 5 | Calendar Expansion + Toggles | `done` | L | — | Time-axis grid + current-time indicator shipped; **overlap detection deferred** (see bedrock-ui-improvements M8) |
| 6 | Task Inbox | `done` | L | — | UI + urgent toggle (localStorage) + SOQL fields shipped; **backend persistence deferred** (see bedrock-ui-improvements M9) |
| 7 | Home Page Layout | `skip` | M | PR 5, PR 6 | Current resizable-panel layout is functional; not in MVP scope |
| 8 | Pipeline Funnel Accountability | `done` | L | — | — |
| 9 | Projects Page | `done` | XL | — | M7 shipped: multi-project, sidebar, CSV import, Opp linking, CRUD. Next: delete-safety (shipped in M18/M19) |
| 10 | Logo Redesign | `done` | S | — | SVG + sidebar + manifest done; **favicon PNGs missing** (see bedrock-ui-improvements S6) |

## Status Legend

- `todo` — not started
- `in-progress` — actively being worked
- `in-review` — PR open, awaiting review
- `done` — merged

## Dependency Graph

```
PR 1 (ranking bug) ──► PR 3 (column sorting) ✓ done

PR 5 (calendar) ──┐
                   ├──► PR 7 (home layout)
PR 6 (task inbox) ─┘

PRs 2, 4✓, 8✓, 9, 10✓ ship independently.
```

## Notes

- **Audit date**: 2026-03-18 — reconciled against PRs #15–18 and `feature/nick-view-page-roles` branch.
- **8 PRs done** (1, 2, 3, 4, 5, 6, 8, 10). PR 7 skipped (functional as-is). PR 9 needs own planning session.
- PR 9 (Projects) needs its own planning session — informed by AIJI Project Tracker_v6.xlsx.
- All frontend work in `financial_forecasting/frontend/` (React + MUI stack).
- **Deferred**: PR 6 backend persistence (toggle API, Salesforce sync); PR 5 meeting overlap detection.

## Pebble: Task Guardrails (2026-03-19)

- [x] `TaskSpec` dataclass + `PROMPT_TEMPLATES` registry in `harness.py`
- [x] `register_template()` decorator + templates for `api_response_extractor` and `batch_summarizer`
- [x] `execute_task()` method — required path for sub-Queen tiers
- [x] Block raw `execute()` for WORKER/DRONE/FORAGER (returns SKIPPED)
- [x] Tier-aware system prompt prefix ("ONE task, JSON only")
- [x] `max_input_tokens` enforcement (safety net)
- [x] `TIER_HARNESS_DEFAULTS` + `harness_config_for_agent()` — tier-appropriate limits
- [x] `origin` field: `"template"` on all claim_templates, `"llm_extracted"` on orchestrator LLM claims
- [x] `verify_urls()` — HTTP HEAD pre-filter for dead URLs before Opus fact-check
- [x] Wire URL pre-filter into `main.py` before stage 3
- [x] Orchestrator updated: `execute_task()` + `TaskSpec` for sub-Queen, `harness_config_for_agent()` for all
- [ ] Manual verification: startup + curl tests

## Pebble: Blocking — Must Resolve Before Production

> These items prevent features from working correctly. Code is built but cannot be fully tested or used until these are resolved.

- [ ] **Web search APIs need setup (team admin)** — Pebble supports two web search backends (Google CSE + Serper.dev). Neither is configured. Without at least one, all web search returns empty — no biographical info, no board positions, no news results. Setup: `pebble/README.md` → "Web search setup." *JP + team admin.*
- [ ] **OpenCorporates needs API key** — Code ready, cache in place. `search_officers()` returns empty without credentials. No officer/director data until configured.
## Pebble: Resolved

- [x] **SEC CIK caching** — API response cache layer added (Stage 1C). SQLite TTL cache in `pebble/storage/cache.py`.
- [x] **Google OAuth configured** — Set up 2026-03-20. See `tasks/google-oauth-setup.md`.
- [x] **Frontend UX gaps** — Resolved in Stage 1: research history sidebar, text feedback, download export, stop button, previous feedback display on reopen. Remaining: cost display, failed_agents visibility.
- [x] **Sync LLM calls block event loop** — Resolved in Sprint 6. All harness calls wrapped in `asyncio.to_thread()` (orchestrator.py:503, 556). Data source fetches also wrapped. Thread pool handles concurrency.
- [x] **No unit/integration tests** — 236 tests now passing across data sources, clusters, router, CRM agent, and web search.

## Pebble Stage 1 Complete (2026-03-20)

- [x] Pebble + Upload pages merged into single tabbed page
- [x] Stop button with backend cancel checkpoints (cooperative cancellation)
- [x] Wikipedia full article + infobox parsing (board memberships, career history)
- [x] Temporal accuracy in LLM prompts (current vs former roles)
- [x] API response cache layer (SQLite TTL)
- [x] Markdown export with download button
- [x] Session history (last 100, right sidebar drawer)
- [x] Text feedback + display on reopen + trends endpoint
- See `tasks/pebble-evolution-roadmap.md` for Stages 2-4 (future work)
- See `tasks/pebble-stage1-issues.md` for known issues and deferred items

## Project Delete-Safety — M18 + M19 Complete (2026-03-31)

> Core soft-delete shipped in M18 (PR #85). Ownership model shipped in M19.

### Scope
1. ~~**Project Ownership Model**~~ — ✅ Shipped in M19: `owner_email`/`created_by` on project, `project_contributor` table, owner-only delete/restore, contributor management UI
2. ~~**Soft-Delete with Trash Bin**~~ — ✅ Shipped in M18
3. ~~**Permission Checks**~~ — ✅ Shipped in M19: owner+admin gate on delete/restore, inline ownership checks, defense-in-depth UI gating
4. ~~**Trash Recovery**~~ — ✅ Shipped in M18

## Future Considerations

- **Pipeline Cleanup Tool**: Build a dedicated cleanup/hygiene feature for stale opportunities (past close date or no updates in 30+ days). Removed from Overview dashboard — belongs as its own tool, not on the main dashboard.

## No Horizontal Scrolling Inside Expanded Rows (2026-08-20)

> Rule: content inside an expanded table row must fit the visible width — no
> horizontal scrolling required to read an expand panel, even when the outer
> table itself scrolls horizontally.

- [x] Audit panel internals for fixed widths / wide grids / overflow-x
- [x] Audit every expansion embedding site + scroll container (16 sites)
- [x] Shared `components/ui/ExpandRow.tsx` — sticky-left cell capped to the
      scroll container's measured clientWidth (generalizes the pattern Awards
      had locally); `w-0 min-w-full` fallback stops wide panels from
      stretching auto-layout tables in SectionCard hosts
- [x] Converted all 15 table expansion sites (Accounts, Contacts, Pipeline,
      Payments, Awards, Dashboard, JobsTeam, JobsAccountHub, JobsContacts,
      JobsAccounts, JobsHome ×2, Portfolio ×3) to ExpandRow
- [x] TaskListTab + OpportunityExpandPanel inner tables: 978px/970px fixed
      colgroups → `w-full table-fixed` with a flexible lead column
- [x] `break-words` on raw email/comment/description text (ActivityTab,
      JobsTeam DealExpandPanel, accountTabs CommentRollupRow,
      ProspectAccountExpandPanel)
- [x] ProspectAccountExpandPanel ContactDetail: fixed side-by-side `w-64`
      layout now stacks below `lg`
- [x] AwardExpandPanel: tab bar wraps; project-link select gets `min-w-0`
- [x] Verified: tsc + vite build green; sticky/width mechanics confirmed in
      browser harness at 1280 and 1100 widths, scrolled and unscrolled

### Review

Deliberately left alone: accountTabs "adding" row `overflow-hidden` gap (no
live overflow — selects clip internally), jobsEntity absolute action cluster
(vertical overlap concern, not width), `ProspectAccountExpandPanel` outer
component + `NestedContactRow` (dead code, no callers), `grid-cols-3` forms in
OppRolesSection/OppBuilderActivity (compress instead of overflow). ExpandRow's
ResizeObserver only matters when the window resizes while a row is open —
same reliance the shipped Awards implementation already had.
