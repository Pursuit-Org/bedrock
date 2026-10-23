# Code reviews

Before reviewing code, read and follow [REVIEW.md](REVIEW.md) for finding selection and response format. These rules apply to reviews only; project guidance below still applies.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

**Available skills:** `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`

---

## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- This includes UI changes — plan and ask clarifying questions before building
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 2a. Agent Teams (Local Setup)
- 10 custom agents in `.claude/agents/` — local only, not committed to repo
- All agents use Opus; `model: opus` resolves to latest Opus at Claude Code runtime
- Invoke via `@agent-name` mention or natural language; `/agents` for management only
- Agents cannot spawn other agents — main thread orchestrates the workflow

> **Pebble disambiguation:** "Agent Teams" here = Claude Code development agents
> (scout, architect, backend, etc.). These are NOT Pebble's research agents
> (Worker/Drone/Forager/Queen bee hierarchy in `pebble/`). Completely separate systems.

#### Read-Only Agents (permissionMode: plan)
- `scout` — Code explorer & explainer. Trace data flow, explain behavior.
- `architect` — System designer. Feature design, migration planning, trade-offs.
- `reviewer` — Quality gate. Security, patterns, tests, canonical correctness.
- `integration-debugger` — Diagnose external API issues (Salesforce, Sage, Slack).

#### Implementation Agents
- `backend` — Python/FastAPI. Endpoints, models, business logic, MCP services.
- `frontend` — React/TypeScript/MUI. Pages, components, hooks, service calls.
- `tester` — pytest + Jest. Test writing, running, verification.
- `data-modeler` — Schema design, migrations, canonical validation, PostgreSQL planning.
- `pebble-dev` — Pebble AI pipeline. Data sources, prompt templates, orchestrator stages.
- `docs` — PRDs, architecture docs, setup guides, PLAN-INDEX, lessons.md.

#### Workflows

**Building**
1. Feature Build: `scout → architect → [data-modeler] → backend + frontend → tester → reviewer`
2. Pebble Extension: `architect → pebble-dev → tester → reviewer`
3. Schema Migration: `architect → data-modeler → backend → tester → reviewer`

**Fixing**
4. Bug Fix: `scout → backend/frontend → tester → reviewer`
5. Integration Fix: `integration-debugger → [scout] → backend → tester`
6. Incident Response: `integration-debugger → backend → tester` (review post-fix)

**Understanding**
7. Spike / Research: `scout → architect` (no implementation)

**Maintaining**
8. Docs Sprint: `scout → docs`
9. Pre-Commit Review: `reviewer` (standalone)

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **No Demo Versions**: Build production-ready from the start. When tempted to hardcode, gate behind flags, or build "for now" shortcuts, push back and clarify the production approach instead. Only build a demo version if explicitly confirmed twice.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Target Platform Compatibility

This project will integrate into the Pursuit AI-native learning platform. Keep these stack and pattern choices in mind:

- **Target stack**: React 19 + Vite + Tailwind + shadcn/ui | Node.js + Express | PostgreSQL + pgvector
- **Auth**: JWT (via `authenticateToken` middleware), tokens in localStorage, `Authorization: Bearer` header
- **API pattern**: REST `/api/{resource}`, JSON errors `{error, details?}`, standard HTTP status codes
- **Frontend conventions**: `fetchWithAuth` utility, pages in `src/pages/`, shared components in `src/components/`, context providers in `src/context/`
- **DB**: PostgreSQL with `db.one()`, `db.any()`, `db.none()` query helpers
- **Infra**: Google Cloud (Storage, BigQuery, Cloud Run), OpenRouter for LLM calls
- **User roles to anticipate**: `builder`, `staff`, `admin`, `applicant`, `volunteer`, `enterprise_admin`
- When making architectural choices, prefer patterns that port cleanly to this stack

## Documentation Map

- **Product docs (start here):** `product/README.md` — full hierarchy and reading order
- **Developer setup:** `financial_forecasting/DEV_SETUP_GUIDE.md` — run locally, env vars, production checklist
- **Doc hygiene:** `docs/DOCUMENTATION-HYGIENE.md` — where things go, when to update, avoid orphans
- **Plan index:** `docs/PLAN-INDEX.md` — status of all Cursor plans (completed, open, superseded)
- **Scope & boundaries:** `product/crm-scope-constitution.md`
- **Canonical names/enums:** `product/crm-architecture/canonical-definitions.md` (this file governs)
- **Data model:** `product/crm-architecture/entity-map.md`
- **Feature inventory:** `product/crm-architecture/feature-register.md`
- **PRD index:** `product/crm-prds/README.md` (14 PRDs, one per component)
- **Onboarding PRD:** `product/ONBOARDINGPRD.md` — getting started guide: 3 roles (RM, Executive, PM), permissions, day-by-day onboarding
- **Onboarding Addendum:** `product/ONBOARDING-ADDENDUM.md` — exhaustive companion: progressive workflows, permission matrix, Pebble roadmap, Task Request spec, feature roadmap
- **Ask Pebble spec:** `product/crm-prds/ask-pebble-spec.md` — tiered query router, chat interface, CRM bridge
- **Phase specs:** `product/fundraising-team/phases/`
- **Technical reference:** `product/reference/` (Sage, Salesforce, Slack setup)
- **Database schema (PostgreSQL):** `docs/database-schema.md` — 33-table reference with exec overview, SF/Bedrock/segundo architecture, domain-by-domain columns, cross-domain ER diagram, data flow, security hardening checklist
- **Architecture decisions:** `docs/architecture-decisions.md`
- **Historical PRD:** `PRD.md` (Nov 2025, partially superseded by crm-architecture/)
- **Archived product specs:** `product/archive/ARCHIVE-INDEX.md`
- **Archived session artifacts:** `docs/archive/` (index in docs/archive/README.md)
