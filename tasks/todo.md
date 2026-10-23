# Bedrock PR Roadmap

## Personal Salesforce client failure containment — October 23, 2026

Extract the identical strict-client guard and regression controls from the reviewed
lock, opportunity and automation candidates. Preserve explicitly permissive background
callers. Validate per-request-client tests with the isolated provider/network harness.
No production calls, migration, merge or deployment.

## bedrock-opportunity-authority — October 22, 2026

Share the existing owner guard through a dependency-safe module and enforce owner, lock and reassignment policy on direct, stage, bulk and human DELETE opportunity mutations. Preserve the internal service DELETE contract, bulk partial results, stage-payment validation and award/cache side effects; fail closed on missing identity/owner evidence.

## bedrock-automation-authority — October 22, 2026

Authorize the final edited automation action and target using the approver's current permissions, stored identity, personal Salesforce client and opportunity lock policy. Validate a copy and record approval only after a confirmed write; preserve shared review queues and explicit task lock protection.

- [x] Reconcile completed independent investigation with source and callers.
- [x] Reproduce missing authorization and establish legitimate controls.
- [x] Implement and validate real routes, alternate inputs and nearest checks.
- [ ] Complete one independent read-only candidate review.

Atomic uncommitted patch; no live providers, shared database, publication or deployment.

Validation: 260 tests passed with the network-disabled Python 3.11 harness;
syntax/import compilation and diff whitespace checks passed. The shared
authorization module matches the automation authority branch byte for byte;

Validation: 107 tests passed with the network-disabled Python 3.11 harness;
syntax/import compilation and diff whitespace checks passed. The shared
authorization module matches the opportunity authority branch byte for byte;
the strict personal-client adapter matches that branch and lock-claim.

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

## Node 22.23.4 security upgrade (2026-10-21)

- [x] Pin local Node, CI, and both frontend Docker builders to 22.23.4.
- [x] Validate clean frontend installs, tests, typecheck, and builds with Node 22.23.4.
- [x] Prepare a dedicated upgrade PR with validation results; do not deploy.

Review: Both frontend clean installs and production builds passed on Node 22.23.4.
The active frontend passed typecheck and all 31 tests; the legacy frontend passed
all 34 suites / 427 tests. CI now runs the active frontend tests in addition to
typecheck and build. Dependency lockfiles are unchanged.

The official `node:22.23.4-alpine` image is available for amd64 and arm64. Local
container builds were not run because the Docker daemon is unavailable. Before
production rollout, build the deployment image, smoke-test login/navigation/API
flows in staging, and retain the previous image revision for rollback.
