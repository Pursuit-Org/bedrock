# Pursuit CRM (Bedrock) — Canonical Definitions

> Version: 1.0 | Date: 2026-03-15
>
> **This is the single source of truth for naming, enums, and conventions.**
> If any other document conflicts with this file, this file wins.
> Every developer, spec, and PRD references this file — not local redefinitions.

---

## 1. Opportunity Stages (Canonical)

Bedrock uses **one stage enum** for all Opportunities. The `revenue_stream` field (`nonprofit` | `pbc`) determines how the stage is interpreted — not separate stage lists.

| Stage (enum value) | Probability | Nonprofit Interpretation | PBC Interpretation |
|--------------------|------------|--------------------------|-------------------|
| `identified` | 10% | Funder identified, no outreach | Potential partner identified |
| `qualified` | 25% | Intro meeting held, alignment confirmed | Discovery call, needs confirmed |
| `proposal-sent` | 50% | LOI or full proposal submitted | Proposal / SOW delivered |
| `in-negotiation` | 75% | Funder reviewing, Q&A active | Terms being negotiated |
| `verbal-commit` | 90% | Verbal or written intent to fund | Verbal agreement, pending contract |
| `closed-won` | 100% | Award letter received | Contract signed |
| `closed-lost` | 0% | Declined or no response | Deal lost |

### Legacy Stage Mapping (PRD.md → Canonical)

PRD.md (Nov 2025) used ~11 stages that collapsed into 7: Lead Gen/New Lead → `identified`, Qualifying → `qualified`, Design/Proposal Creation → `proposal-sent`, Proposal Negotiation/Contract Creation/Negotiating Contract → `in-negotiation`, Collecting/In Effect/Closed Completed → `closed-won`, Closed Lost/Did not Fulfill → `closed-lost`. Key change: payment state (formerly encoded in Opp stage) now lives in Payment status.

**2026-04-16 update — live SF drift beyond the 11-stage mapping:**
SOQL verified Pursuit's live SF org carries 22 distinct StageName values, not 11. The extra 11 stages and their Bedrock-canonical mapping:

| Live SF stage | Count | Bedrock canonical mapping |
|---|---:|---|
| `In Collection` | 650 | **Not philanthropy** — ISA RecordType (Pursuit Bond / Income Share Agreement), 2019-2020 legacy. Out of scope; handled elsewhere. |
| `Closed Won` | 575 | → `closed-won` (Donorbox-auto-populated donations, money already received via Stripe). `revenue_stream=nonprofit`. |
| `Close/Unknown` | 68 | Dirty data; TBD (cleanup in future Bulk Edit sprint) |
| `Closed / Full-Time or Successful Conversion` | 14 | → `closed-won` with `revenue_stream=pbc` (TBD — fundraising glossary session) |
| `Closed / Temporary Hire` | 5 | → `closed-won` with `revenue_stream=pbc` (TBD) |
| `Closed / Fulfilled` | 5 | TBD (which program?) |
| `Closed / Contract or Agreement But No Fellows Hired` | 4 | Likely → `closed-lost` with `revenue_stream=pbc` (contract signed, zero fellow placements) (TBD) |
| `Contract Signing` | 3 | → `in-negotiation` (late-funnel, pre-close) (TBD) |
| `Closed / Sourcing` | 2 | TBD — misleading name |
| `Verbal Commitment` | 1 | → `verbal-commit` (TBD — pre-contract) |

**Operational fix direction:** Per JP directive 2026-04-16 ("SF stages are sacred"), Bedrock's implementation uses `ReadonlySet<string>` buckets in `frontend/src/types/salesforce.ts` that admit values outside the 7-stage enum. No `LEGACY_STAGES` flag; no stage hiding in edit UIs. When the enum is widened to include PBC stages (deferred post-MVP), all stages appear in dropdowns. See `tasks/f1-stage-buckets-plan.md` (2026-04-16) for the F1 bucket implementation.

---

## 2. Field Names (Canonical)

Use these exact names in all code, specs, and docs. No aliases.

| Canonical Name | Type | Do NOT Use | Notes |
|---------------|------|-----------|-------|
| `expected_close_date` | date | `close_date`, `closeDate`, `Close date` | When we expect the deal to close |
| `amount_estimated` | number | `amount`, `Amount`, `estimated_amount` | Pipeline value before confirmation |
| `amount_confirmed` | number | `confirmed_amount`, `actual_amount` | Set when closed-won |
| `revenue_stream` | enum | `stream`, `type`, `revenue_type` | `nonprofit` or `pbc` |
| `assigned_to` | string | `owner`, `opportunity_owner`, `Owner` | User ID or name of the responsible IC |
| `salesforce_id` | string | `sf_id`, `sfId`, `SalesforceId` | 18-character Salesforce record ID |
| `sage_id` | string | `intacct_id`, `sageId` | Sage Intacct reference |
| `expected_date` | date | `due_date` (on Payment), `payment_date` | When a Payment is expected (Task uses `due_date`) |
| `received_date` | date | `payment_received_date`, `actual_date` | When a Payment was actually received |
| `primary_contact_id` | string | `contact_id` (on Opportunity), `main_contact` | The main contact on an Opportunity |
| `contact_id` | string | `person_id`, `contact` | Reference to a Contact (on Activity, Prospect, etc.) |
| `opportunity_id` | string | `opp_id`, `deal_id` | Reference to an Opportunity |
| `prospect_id` | string | `lead_id`, `leadId` | Reference to a Prospect (renamed from Lead) |
| `amount` | number | `payment_amount`, `pay_amount` | Amount of a single Payment (distinct from Opportunity's `amount_estimated`/`amount_confirmed`) |
| `due_date` | date | `deadline`, `dueDate` | When a Task is due |
| `grant_start_date` | date | `start_date` (on GrantRequirements), `grant_start` | When the grant period begins |
| `grant_end_date` | date | `end_date` (on GrantRequirements), `grant_end` | When the grant period ends |
| `intelligence_updated_at` | datetime | `score_date`, `last_scored` | When prospect intelligence was last refreshed |
| `intelligence_confidence` | enum | `confidence`, `score_quality` | `verified`, `high`, or `low` |
| `rationale` | text | `reason`, `notes` (on Decision) | Why a decision was made — the core of the audit trail |
| `intelligence_snapshot` | text | `snapshot`, `context` | Frozen data points at time of decision |
| `created_at` | datetime | `created`, `createdAt`, `create_date` | |
| `updated_at` | datetime | `updated`, `updatedAt`, `update_date` | |

---

## 3. ID Patterns (Canonical)

| Entity | Pattern | Example | Generated By |
|--------|---------|---------|-------------|
| Account | `acct-{slug}` | `acct-goldman-sachs-foundation` | Bedrock (manual/CSV); Salesforce ID stored separately in `salesforce_id` |
| Contact | `contact-{slug}` | `contact-sarah-chen` | Bedrock; slug from `first_name-last_name` |
| Opportunity | `opp-{year}-{nnn}` | `opp-2026-003` | Bedrock; sequential per year |
| Payment | `pay-{year}-{nnn}` | `pay-2026-012` | Bedrock; sequential per year |
| Prospect | `prospect-{year}-{nnn}` | `prospect-2026-042` | Bedrock; sequential per year |
| Task | `task-{year}-{nnn}` | `task-2026-007` | Bedrock |
| Activity | `act-{year}-{nnn}` | `act-2026-015` | Bedrock |
| User | `user-{slug}` | `user-jac-reynolds` | Bedrock / Learning platform |
| GrantRequirements | `grant-req-{opp-id}` | `grant-req-opp-2026-003` | Bedrock; mirrors parent Opportunity ID |
| Decision | `dec-{year}-{nnn}` | `dec-2026-001` | Bedrock |
| NetworkMatch | `match-{contact-slug}-{source}` | `match-sarah-chen-hnwi-2026` | Bedrock |

**Week-1 prototype exception:** The week-1 CSV import uses `prospect-{Date.now()}-{index}` for simplicity (no backend counter). Before production, migrate to sequential `prospect-{year}-{nnn}` IDs with a server-side counter. Do not mix both formats in the same dataset.

### ID Authority Rules

1. **Bedrock generates the canonical ID** for all entities. This is the primary key in all Bedrock storage.
2. **Salesforce IDs are stored as `salesforce_id`** — a secondary reference, not the primary key. This ensures Bedrock can exist independently and migrate to the knowledge graph.
3. **Sage IDs are stored as `sage_id`** on Payment records — a secondary reference for reconciliation.
4. **Slug generation:** lowercase, hyphenated, ASCII-only. `Sarah Chen` → `sarah-chen`. Collision resolution: append sequential number (`sarah-chen-2`).

---

## 4. Date Definitions

| Term | Definition | Used In |
|------|-----------|---------|
| **"This week"** | Next 7 calendar days from today, inclusive: `[today, today + 6]` — 7 days total. If today is Monday, "this week" = Mon–Sun. | Weekly priorities view, task notifications |
| **"Stale"** (opportunity) | No Activity logged AND no stage change in the last 30 calendar days. Computed on-demand (not a stored field). | Stale detection (F06) |
| **"Stale"** (task) | `due_date < today` AND `status` ∉ {`completed`, `cancelled`}. Computed on-demand. | Task notifications (F13) |
| **"Overdue"** (payment) | `expected_date < today` AND `status` ∉ {`received`, `cancelled`}. Auto-set to `overdue` by nightly job or on sync trigger. | Payment tracking (F28), overdue alerts (F31) |
| **"Concentration risk"** | Any single Account represents >30% of total weighted pipeline. Computed on-demand for dashboard. | Executive dashboard alert (F24) |

---

## 5. Revenue Stream Enum

| Value | Meaning | Opportunity Types |
|-------|---------|-------------------|
| `nonprofit` | Tax-exempt charitable activity | Grants, donations, in-kind gifts |
| `pbc` | Public Benefit Corporation activity | Consulting, apprenticeship contracts, FDE, sponsorships |

Rules:
- **Required** on every Opportunity. Set at creation, rarely changed.
- **Inherited** by Payments from their parent Opportunity.
- **Not stored** on Accounts — inferred at query time from child Opportunities.
- **Not set** on Contacts, Prospects, Tasks, Activities — these are stream-agnostic.

### Opportunity Record Types (Salesforce)

`RecordType.Name` on Opportunity is the authoritative "what kind of money is this" field. On **2026-10-21/22** Salesforce split the former **Philanthropy** record type: it was **renamed to Grant** (same Id) and donation-style opps were moved to **Donation**. No opportunity carries `Philanthropy` anymore — never hardcode that name.

| Record type | SF Id | Stream | Bedrock bucket | Award-eligible |
|---|---|---|---|---|
| Grant | `0121U0000002h3SQAQ` | nonprofit | `grant` (+ `philanthropy`) | Yes |
| Donation | `0121U000000p3ZQQAY` | nonprofit | `donation` (+ `philanthropy`) | Yes |
| Other In-Kind | `0121U0000002h3RQAQ` | nonprofit | `other` | No |
| PBC | `0121U0000002h3LQAQ` | pbc | `pbc` | Yes |
| Debt / Equity | `0121U0000002h3PQAQ` | — | `other` | Yes (`Closed / Completed`) |
| Other Fee For Service | `0121U0000002h3NQAQ` | pbc | `other` | Yes (`Closed / Completed`) |
| ISA | `0121U0000003c1EQAQ` | — | excluded everywhere | No |

Rules:
- **Buckets** (dashboard / cash flow / revenue snapshot `bucket` param): `all · philanthropy (Grant + Donation) · grant · donation · pbc · capital_grants · other`. Defined once in `services/record_type_bucket.py` (backend) and `frontend-v2/src/lib/recordTypes.ts` + `lib/bucketFilter.ts` (frontend).
- **Capital Grants** are Grant opps with `Philanthropy_Type__c = 'Capital Grant'`; they're carved out of `grant` / `philanthropy` / `other` into `capital_grants`.
- **$20M fundraising goal** counts `philanthropy` (Grant + Donation).
- **ISA** opps are excluded from every Bedrock view at the SOQL layer.
- **Grant period** (`Grant_Start_Date__c`, `Grant_End_Date__c`) applies to **Grant only**. Optional in pipeline; **required** before a Grant moves to `Collecting / In Effect` (enforced by the stage gate and `_validate_stage_change_logic`). The end date drives reporting deadlines and renewal follow-up.
- Award eligibility per record type: `services/awards_service.py` `ELIGIBLE_STAGES_BY_RECORD_TYPE`.

---

## 6. Entity Status Enums

### Opportunity Stage
See Section 1 above.

### Payment Status

| Value | Meaning | Transition From |
|-------|---------|----------------|
| `scheduled` | Payment expected; not yet invoiced | (initial) |
| `invoiced` | Invoice sent to funder | `scheduled` |
| `received` | Payment received and confirmed | `invoiced` or `scheduled` |
| `overdue` | Past expected_date, not received | `scheduled` or `invoiced` (auto-set by nightly job or sync trigger) |
| `cancelled` | Payment will not be received | any |

### Prospect Status

| Value | Meaning |
|-------|---------|
| `new` | Just created; no outreach yet |
| `contacted` | Initial outreach made |
| `qualifying` | Active research or conversation to determine fit |
| `converted` | Qualified and converted to Opportunity |
| `archived` | Not pursuing; preserved for history |

### Task Status

| Value | Meaning |
|-------|---------|
| `pending` | Not started |
| `in-progress` | Being worked on |
| `completed` | Done |
| `cancelled` | No longer relevant |

### Decision Outcome

| Value | Meaning |
|-------|---------|
| `pending` | Decision was made; outcome not yet known |
| `validated` | Outcome confirmed the decision was correct |
| `invalidated` | Outcome showed the decision was wrong (learning opportunity) |

### Award Status

| Value | Meaning |
|-------|---------|
| `Active` | Award is in flight — money flowing, programmatic work underway |
| `Closing` | Wind-down phase — final reports / deliverables outstanding |
| `Closed` | All obligations met; record kept for history |

Defaulted by `services.awards_service.initial_award_status`:
- `Closed / Fulfilled` → `Closing`
- everything else in `WON_PHILANTHROPY_STAGES` → `Active`

### Reporting Requirement Status

| Value | Meaning |
|-------|---------|
| `pending` | Report not yet due or not started |
| `submitted` | Report submitted to funder |
| `accepted` | Funder accepted the report |

### Program Metric Status

| Value | Meaning |
|-------|---------|
| `not-started` | Measurement period hasn't begun |
| `in-progress` | Actively being tracked |
| `met` | Target achieved |
| `not-met` | Target missed |
| `pending-verification` | Data collected, awaiting verification |

### Intelligence Confidence

| Value | Meaning |
|-------|---------|
| `verified` | Human-reviewed and confirmed |
| `high` | Multiple corroborating signals |
| `low` | Single source, or stale (>90 days since last refresh) |

---

## 7. Source Enums

### Contact Source

| Value | Meaning |
|-------|---------|
| `salesforce-import` | Synced from Salesforce |
| `linkedin-import` | Imported from LinkedIn Connections CSV |
| `csv-import` | Imported from other CSV file |
| `manual` | Manually entered in Bedrock |
| `prospect-list` | Imported from external prospect/HNWI list |
| `slack-ingest` | Created from Slack activity (via MCP) |

### Prospect Source

Tracks *how the fundraising opportunity was discovered* — orthogonal to Contact source (which tracks *where the person record came from*). A Contact with source `prospect-list` may become a Prospect with source `network-search-hit` — these are independent facts.

| Value | Meaning |
|-------|---------|
| `inbound-referral` | Referred by someone in network |
| `event` | Met at an event |
| `cold-outreach` | Proactive outreach with no prior connection |
| `network-search-hit` | Surfaced by network search / fuzzy match |
| `other` | Doesn't fit above categories |

### Activity Source Type

| Value | Meaning |
|-------|---------|
| `manual` | Logged by hand in Bedrock |
| `fireflies-transcript` | Imported from Fireflies meeting recording |
| `slack-ingest` | Proposed from Slack via MCP Client |
| `brain-dump` | Unstructured notes from team member |
