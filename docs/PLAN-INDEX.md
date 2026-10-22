# Sprint & Milestone Index

Master index of all planned and completed milestones. Unique numbering — no duplicates, no ambiguity.

**Last completed:** Progress Page series + Pipeline Flow rework + frontend test hygiene (PRs #104–#131, 2026-04-14 to 2026-04-15)
**Last shipped:** M19 (Project Ownership, 2026-03-31). **27 commits accumulated on `dev` since**, not yet promoted to `main` — PR #126 (dev→main) intentionally closed to batch. All PRs through #131 merged.
**Next up:** F1 bucket sets + Intacct kill switch (`tasks/f1-stage-buckets-plan.md`, branch `plan/f1-stage-buckets` pushed) → fundraising glossary conversation → F2/F3 stage-schema-drift bundle → M20 (Task Requests) + Sprint B

---

## Execution Order & Dependencies

```
M9  ✅  Schema Qualification
M10 ✅  Activities Foundation (backend)
M11 ✅  Pebble PostgreSQL Migration
M12 ✅  Pebble Access Control
M18 ✅  Project Soft-Delete
 │
 ├──► M13 (Activities Timeline)  ──┐
 │    Session 1: Timeline component │
 │    Session 2: Detail modals      ├──► M16 (Integration + QA)
 ├──► M15 (Chrome Extension) ──────┘    (wiring + regression)
 │    Session 1: Manifest + scripts
 │    Session 2: Popup + flows
 ├──► M17 (SF Audit + Prospect CRM) ✅ ← 3 sessions, absorbs M14
 │    Session 1: Schema + validation + storage ✅
 │    Session 2: T1-T3 pipeline + persistence ✅
 │    Session 3: Drift detection + integration test ✅
 ├──► M19 (Project Ownership)         ← 1 session, deferred from M8
 └──► M20 (Task Request System)      ← 2 sessions, post-launch
      Session 1: Backend (table + API + permissions)
      Session 2: Frontend (notifications + modal + status)
```

**M13 and M15 are unblocked** and can run in parallel (both depend only on M10 ✅). M16 depends on both M13 + M15. **M14 has been absorbed into M17** — the SF describe() audit resolved the field definition blocker. **M20 depends on permission profile setup** (Sprint A, pre-launch) — PM profile must exist before task request endpoints can be gated.

---

## Open (actionable)

| Milestone | Plan File | Depends On | Size | Status | Summary |
|-----------|-----------|------------|------|--------|---------|
| **M13: Activities Timeline + Modals** | `tasks/sprint9-activities-extension-plan.md` (9B section) | M10 ✅ | L (2 sessions) | Ready | **Session 1**: Activity TS types + API methods + ActivityTimeline component. **Session 2**: OpportunityDetailModal + ContactDetailModal + page wiring. |
| ~~M14: Pebble Persistence + CRM Bridge~~ | `tasks/sprint11-pebble-persistence-crm.md` | M11 ✅ | — | **Absorbed into M17** | Conflict log, scratchpad, CRM bridge updates moved to M17 Sessions 2-3. |
| **M15: Activities Chrome Extension** | `tasks/sprint9-activities-extension-plan.md` (9C section) | M10 ✅ | L (2 sessions) | Ready | **Session 1**: Manifest V3 + service worker + content scripts + API client. **Session 2**: Popup UI + OppPicker + CascadeFlow + testing. Parallel with M13 (no frontend dependency). |
| **M16: Activities Integration + QA** | `tasks/sprint9-activities-extension-plan.md` (9D section) | M13 + M15 | S (1 session) | Planned | Wire modals into pages, global search, full regression. Worktree for safety. |
| **M17: SF Audit + Prospect CRM Mapping** | `tasks/sprint13-sf-audit-ux-polish.md` | M12 ✅ | L (3 sessions, absorbs M14) | **Complete** | SF describe() audit, prospect_sf_* typed tables, sf_field_requirements, schema drift detection + admin endpoints, T1-T3 population pipeline, CRM bridge updates, integration tests. Plan: `.claude/plans/effervescent-coalescing-marble.md`. |
| **M19: Project Ownership Model** | `.claude/plans/replicated-seeking-neumann.md` | M18 ✅ | S-M | **Done** (2026-03-31) | owner_email + created_by + project_contributor table, owner-only delete/restore, contributor management UI, transfer ownership. |
| **M20: Task Request System** | `product/ONBOARDING-ADDENDUM.md` §F + `.claude/plans/quizzical-riding-brooks.md` §3 | Sprint A (profiles) | M (2 sessions) | Planned | **Session 1**: `bedrock.task_request` table + 5 API endpoints + permission gating. **Session 2**: NotificationType extensions + Accept/Reject UI in NotificationDropdown + "Request Task" modal + PM status view. Enables PM-RM coordination without violating Opp ownership. |
| **Data Cleanup Pass** | `tasks/data-cleanup-pass.md` | Nothing | M (6 read-only audits → batched writes) | Planned (next) | Pre-flight hygiene before the Candidate Funnel: backfill `bedrock.account_email_domain` from SF Contact emails + Account.Website, fix `sf_contact_link` / `sf_account_company_map` coverage, reattribute NULL activity rows, and produce duplicate + enrichment reports. Audit-only first; apply non-conflicting changes in batch. |
| **Candidate Funnel** (multi-source unification) | `tasks/candidate-funnel-plan.md` | Data Cleanup Pass | L (2–3 sessions) | **Step 2+3 done** (2026-06-07) | `bedrock.account_candidate` + `bedrock.contact_candidate` tables shipped with 2,252 + 7,231 rows seeded from the scan. `routes/candidates.py` exposes list + 4 promotion endpoints. `frontend-v2/src/pages/CandidateFunnel.tsx` renders `/candidates` with the 4-outcome cards. Nightly refresh via `scripts/refresh_candidate_funnel.py`. Remaining: Step 4 (factory team `public.*` writeback contract), Step 5 (dedup sweep job), Step 6 (bulk actions). |
| **SF Opp Record-Type Split** | `~/.claude/plans/okay-so-opportunities-in-wiggly-donut.md` | Nothing | M | **In review** (2026-10-22) | Philanthropy → Grant + Donation across buckets, pills, awards, Won-by-type columns; Grant-only grant period (no checkbox), required before Collecting. Follow-up: "grants ending soon" view + renewal reminders. |
| Bedrock UI Improvements | `tasks/bedrock-ui-improvements.md` | Nothing | Ongoing | Mixed | 5 small, 7 medium, 3 large. Parallel with all tracks. |
| Google OAuth Setup | (in .cursor/plans/) | Nothing | S | Partially done | FRONTEND_URL env, OAUTH_SPRINT_CHECKLIST, redirect fix. |

### Blocked Items (external dependency)

| Item | Plan File | Blocked On |
|------|-----------|------------|
| Serper Integration | `tasks/serper-integration-sprint.md` | Serper.dev API key not configured |
| OpenCorporates Data | (tracked in `tasks/todo.md`) | OpenCorporates API key not obtained |
| ~~M14: Pebble Persistence~~ | `tasks/sprint11-pebble-persistence-crm.md` | **Resolved** — absorbed into M17; describe() audit provided field definitions |

---

## Completed

| Milestone | Date |
|-----------|------|
| M1: Production-Grade Security MVP | 2026-03-18 |
| M2: MVP Performance Pass | |
| M3: Bedrock Rollout and Pebble Alignment | |
| Bedrock PR Roadmap (PRs 1-10) | 2026-03-20 |
| Funnel Polish and AI | |
| Funnel Visual Redesign | |
| Calendar Layout Simplification | |
| Dashboard and Backend Plan | |
| Pipeline Scenario Cards | |
| Revenue vs Cashflow Layout | |
| Notification Bell Dropdown | |
| Stage B Sprint 1 — LDA/FINRA/affiliation | |
| M6: Agentic alignment + test coverage | |
| M7: Opportunity edit dialog + permissions | |
| M7.5: SF field audit + NPSP payment summary | |
| M8: Multi-object editing (Account, Contact, Payment) | 2026-03-26 |
| M8 Delete-Safety Planning | 2026-03-26 |
| M9: Schema Qualification — 23 tables deployed to segundo-db | 2026-03-27 |
| M10: Activities Foundation — backend-only, 11 endpoints, SF sync | 2026-03-29 |
| M12: Pebble Access Control — RBAC, cost limits, budget chip | 2026-03-29 |
| M11: Pebble PostgreSQL Migration — SQLite → asyncpg/psycopg2 | 2026-03-30 |
| M18: Project Soft-Delete — cascade soft-delete, trash UI, restore & purge | 2026-03-30 |
| Adversarial-review follow-up (16 findings, C2–H7, M1p/M2/M3/M5) | 2026-04-14 |
| Inline-edit foundation (sensitivity table, permission hook, primitive) + migrations (Reports, Projects, Priorities) | 2026-04-14 |
| Progress page rebrand (Dashboard → Progress) + visibility override + Individual Goals filter | 2026-04-15 |
| Pipeline Flow rework — Selected Users default + Lookback picker + exact-range Analyze (PR #129) | 2026-04-15 |
| Frontend test hygiene — 11 pre-existing failures resolved, 345/345 passing (PR #131) | 2026-04-15 |
| Docs refresh + Opportunity stage glossary skeleton (PR #130) | 2026-04-15 |

## Superseded

| Plan | Superseded By |
|------|---------------|
| Funnel Net Indicator Polish | Funnel Polish and AI |
| Sprint 7 — UX polish (original Pebble roadmap) | M7 became Opportunity edit dialog; UX items → M17 |
| Sprint 8 — Team enablement (original Pebble roadmap) | M8 became multi-object editing; team items → M12 |

## Old Sprint → New Milestone Mapping

For reference, the old sprint names map to:

| Old Name | New Milestone |
|----------|---------------|
| Sprint 9 — Schema qualification (Track A) | **M9** |
| Sprint 9A — Activities Foundation (Track D) | **M10** |
| Sprint 9B — Activities Timeline (Track D) | **M13** |
| Sprint 9C — Activities Extension (Track D) | **M15** |
| Sprint 9D — Activities Integration (Track D) | **M16** |
| Sprint 10 — Pebble PostgreSQL (Track A) | **M11** |
| Sprint 11 — Pebble Persistence (Track A) | **M14** |
| Sprint 12 — Pebble Access Control (Track B) | **M12** |
| Sprint 13 — SF Audit + UX (Track B) | **M17** |
| (new) Project Soft-Delete | **M18** |
| (new) Project Ownership Model | **M19** |

## Reference (strategic, no implementation)

| Plan |
|-----|
| Pebble Bedrock Integration Architecture |
| Pebble PRD Review and Team Prompt |
| CRM Duplicate Detection (`tasks/crm-duplicate-detection-plan.md`) — ready when needed |
