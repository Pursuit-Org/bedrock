# Activity Sync Expansion — two-way bedrock.activity ↔ SF Task/Event

**Status:** design phase — blocks the Activities page (#9 in mega-B). JP approved "full field reflection + SF-first PATCH" on 2026-04-23; Jac schema review pending.

## Why

The Activities page (replaces the Leads tab on `/details`) needs inline edit that users can trust. Today `/api/activities` edits the local `bedrock.activity` table only — the SF sync is one-way (SF → bedrock, via `data_sync.py:sync_activities`). Edits through the current PUT endpoint change the local copy and silently diverge from Salesforce. Per JP's 2026-04-23 decision, every inline edit on the Activities page must reflect back to the underlying SF Task or Event, with SF as the authoritative store.

## Non-goals

- **Two-way sync of Activities from sources other than SF** (Gmail-sync, Slack, calendar-sync). `source` column on each row already discriminates. Only rows with `source = 'salesforce'` + `sf_id IS NOT NULL` participate in write-back.
- **Partial-write success.** Per JP: SF-first. If SF PATCH fails, we return the error to the client and do NOT touch bedrock.activity. No partial commit.
- **Creating new Tasks/Events from the Activities page.** Create goes through existing TaskPanel / Event dialog paths. This PR expands update only.

## Current state (verified at source, 2026-04-23)

- `bedrock.activity` columns today (20): id, sf_id, sf_type, type, subject, description, description_html, activity_date, opportunity_id, account_id, contact_ids, project_task_id, sf_task_id, source, source_ref, source_thread_id, email_from, email_to, email_cc, email_snippet, meeting_duration_minutes, meeting_attendees, meeting_location, logged_by, owner_id, sf_last_modified, synced_at, sf_sync_status, created_at, updated_at, deleted_at.
- SF Task SOQL pulled today (`data_sync.py:84-92`): Id, Subject, Status, Priority, ActivityDate, Description, OwnerId, WhoId, WhatId, Type, TaskSubtype, CreatedById, CreatedDate, LastModifiedDate, IsClosed, CallType, CallDurationInSeconds — 17 fields. **Status + Priority + TaskSubtype + CallType + IsClosed are pulled but dropped** in `_map_sf_task` (they're not in the INSERT column list at `data_sync.py:286-310`).
- SF Event SOQL pulled today (`data_sync.py:95-103`): Id, Subject, Description, StartDateTime, EndDateTime, OwnerId, WhoId, WhatId, Type, Location, DurationInMinutes, IsAllDayEvent, CreatedById, CreatedDate, LastModifiedDate — 15 fields. **EndDateTime + Type + IsAllDayEvent are pulled but dropped** in `_map_sf_event`.
- PUT `/api/activities/{uuid}` (`routes/activities.py:624-659`) accepts `ActivityUpdate` (`models.py:144-166`) with snake_case fields only; writes `bedrock.activity` directly via `UPDATE ... SET sets = ...`; never calls Salesforce.
- `_enforce_record_ownership` (`main.py:862`) is the backend SF-owner gate used by all SF write endpoints. Activity PUT does NOT use it today (activity is local-only).

## Design

### Phase 0 — Catalog (must land before any code)

**Deliverable:** `tasks/activity-sync-field-catalog.md` — a table per SObject (Task, Event) listing every field that meets all three criteria:
- `updateable === true` in SF describe
- `calculated === false` in SF describe
- Not already inside the system-fields skip set (Id, CreatedById, CreatedDate, SystemModstamp, IsDeleted, etc.)

For each field, capture: SF field name, SF type, new bedrock column name (snake_case), Postgres type, nullable, defaults, indexes, any lossy conversion (e.g. SF picklist → Postgres text + CHECK constraint), Event-only / Task-only / Both source. JP + Jac review this table before Phase 1.

**Unknowns for Jac:** does Pursuit use Task.IsRecurrence / Event.IsRecurrence / RecurrenceType / RecurrenceActivityId? If so, do we store recurrence metadata or flatten exceptions? (Recurrence complicates the sync round-trip.) Does Pursuit customize Task/Event with `__c` custom fields? Catalog needs those too.

### Phase 1 — Backend migration + sync engine expansion

1. **Migration** (`db/migrations/2026-04-24-activity-sync-expansion.sql`):
   - `ALTER TABLE bedrock.activity ADD COLUMN ...` for every new column in the catalog.
   - Types match SF: picklist → TEXT with CHECK constraint, lookup → TEXT (SF IDs are 15/18 chars), datetime → TIMESTAMPTZ, duration → INTEGER, boolean → BOOLEAN.
   - Backfill: `UPDATE bedrock.activity SET <new columns> = NULL` — then re-run full `sync_activities` with a `--force-full` flag to re-fetch every row from SF and populate. Safe because `ON CONFLICT (sf_id) DO UPDATE` already handles re-sync.

2. **Sync engine updates** (`data_sync.py`):
   - SOQL SELECT lists expanded to every catalog field.
   - `_map_sf_task` + `_map_sf_event` populate all new columns.
   - `_upsert_activity` INSERT column list + `ON CONFLICT` update list expanded. Single source of truth for the column list — suggest extracting to a constant so tests and migrations stay aligned.
   - `test_activity_sync.py` gains per-field round-trip tests.

3. **Pydantic models** (`models.py`):
   - `Activity`, `ActivityUpdate`, `ActivityCreate` gain all new fields. `ActivityUpdate` continues to accept snake_case (Python convention). We add a **SF-field-alias layer** so the frontend can post SF-field-named payloads — see Phase 2.

### Phase 2 — PUT handler: SF-first semantics

Replace the body of `PUT /api/activities/{uuid}` (`routes/activities.py:624-659`) with:

1. **Parse the request body.** Accept `{ [sf_field_name]: value }` — SF-field-named payload from the Activities page. Translate to snake_case using a `SF_FIELD_TO_BEDROCK_COLUMN` mapping defined next to the catalog. Unknown / non-whitelisted fields → 400.
2. **Load the activity row.** `SELECT sf_id, sf_type, source, deleted_at FROM bedrock.activity WHERE id = $1`. If source ≠ 'salesforce' or sf_id is null → reject with 400 (write-back only applies to SF-synced rows).
3. **Enforce SF ownership.** Call `_enforce_record_ownership(salesforce, sf_type, sf_id, user)` — reuses the existing helper that's already battle-tested.
4. **PATCH Salesforce first.** `await salesforce.update_record(sf_type, sf_id, sf_fields)`. On failure: 400 with sanitized error (existing pattern at main.py:960-965).
5. **Mirror to bedrock.** On SF success: `UPDATE bedrock.activity SET <cols>, sf_last_modified = now(), synced_at = now(), sf_sync_status = 'synced' WHERE id = $1`. Any exception at this stage → log + return success with a warning header (SF is authoritative; local will be corrected on next sync cycle).
6. **Invalidate caches.** `cache.invalidate_prefix("activities:")`.
7. **Return** `ApiResponse(success=True, data={"id": activity_id, "message": "Activity updated"})`.

**Transactional contract (documented in the handler docstring):** SF is authoritative. If step 4 fails, no local write. If step 4 succeeds and step 5 fails, local row is transiently stale but the next `sync_activities` run will reconcile — no lost data, no double-write.

**Auth & rate-limit:** keep `require_auth` + add `@limiter.limit("30/minute")` matching `update_account` / `update_contact`.

### Phase 3 — Frontend Activities page (mega-B #9)

1. `pages/Activities.tsx` fetches `apiService.getActivities({ limit: 500 })` for rows AND `apiService.getSchemaDescribe('Task')` + `apiService.getSchemaDescribe('Event')` for columns.
2. `synthesizeActivitySchema(taskFields, eventFields)` merges the two describe responses (deduping by name, tagging `_source: 'Task' | 'Event' | 'Both'`). Filter to the catalog's allow-list.
3. `buildSchemaColumns(merged, { entityType: 'Activity', onSaveField, canEditObject, sfUserId, accounts, users, ... })` — same pattern as Accounts/Contacts/Tasks.
4. `onSaveField(uuid, sfFieldName, newValue)` → `apiService.updateActivity(uuid, { [sfFieldName]: newValue })` — SF-field-named payload, backend translates.
5. Row.OwnerId comes from `bedrock.activity.owner_id` which stores the SF OwnerId — ownerGate works as-is.

### Phase 4 — Wire into Details.tsx

Per the existing mega-B plan: TAB_MAP swap, Tab label + HistoryIcon, `?tab=leads` → `?tab=activities` redirect, panel renders `<Activities />`. Leads.tsx stays on disk; cleanup PR one release cycle later.

## Open questions for JP + Jac

1. **Custom fields (`__c`).** Does Pursuit have Task or Event custom fields that should be editable? Jac can list them from SF describe. If yes, catalog includes them; if no, we exclude.
2. **Recurrence.** Does the team use recurring Tasks or Events? If yes, editing a single occurrence vs the series has different SF semantics. For MVP, suggest: inline edit of a recurring Event's Subject writes the change to the series; editing the start/end datetime is blocked (force the series edit via the SF native UI).
3. **Status / Priority picklist values per Record Type.** SF allows Record-Type-specific restrictions on Status values. If Pursuit uses them, the catalog needs the RT → allowed-values map. Same issue as `feedback_sf_stages_sacred` in the Opportunity plan.
4. **Contact_ids[] write-back.** SF Task.WhoId is scalar; bedrock.activity.contact_ids is a list. For MVP, only contact_ids[0] round-trips. Secondary contacts on the local side are write-only (stay local).
5. **Event vs Task discrimination at save time.** When the row's sf_type is Event but the field the user edited is Task-only (e.g., Priority), what happens? Two options: (a) reject with a clear error message, (b) silently drop the field. Prefer (a) — honest failure.
6. **Backfill window.** Full re-sync of every activity row is ~N API calls for N activities. If the corpus is large (>100k rows), consider a chunked async backfill with progress tracking. Jac may have Bulk API quotas to consider.

## Jac review checklist

- [ ] Catalog table covers every field Pursuit actually uses (custom fields included).
- [ ] Picklist → Postgres mapping has correct CHECK constraints (no values drift silently).
- [ ] Recurrence handling is well-defined (or explicitly out-of-scope for MVP).
- [ ] Bulk API quota impact of the backfill re-sync is acceptable during business hours OR scheduled for off-hours.
- [ ] Page-layout readonly field overrides are understood — if SF page layout hides a field, should we still allow API PATCHes? (Yes per SF semantics; note in flagged-for-Jac doc.)
- [ ] Transfer Record permission on OwnerId for all RM/Executive SF profiles.

## Risks

- **Backfill re-sync can be slow.** Consider a feature-flagged flip: new columns populated only for rows synced after the migration; a separate background job chews through historical rows.
- **Field-catalog drift.** If Pursuit adds a new SF field after this PR merges, the Activities page won't know about it until the catalog is updated. Mitigation: catalog is code-generated from getSchemaDescribe at build time OR the frontend dynamically filters to `updateable && !calculated` at runtime (current schemaColumns pattern).
- **PR size.** Backend migration + sync update + PUT handler + frontend + tests + docs = ~1.5-2k LOC. Reviewers should walk commit-by-commit pre-squash.
- **SF API quotas.** Every inline edit is now an SF PATCH. If users bulk-edit, we consume API calls. Consider rate-limiting on the PUT endpoint (already at 30/minute per main.py patterns).

## Phased execution order

1. **Phase 0 (catalog)** — JP + Jac approve. Blocks Phase 1.
2. **Phase 1a (migration + models)** — land as its own commit.
3. **Phase 1b (sync engine expansion)** — land as its own commit; tests verify round-trip.
4. **Phase 1c (backfill)** — separate commit; may run as a manual step after deploy.
5. **Phase 2 (PUT handler)** — SF-first semantics; tests verify ownership + error paths.
6. **Phase 3 (frontend Activities page)** — depends on Phase 2.
7. **Phase 4 (Details.tsx wiring)** — depends on Phase 3.
8. **Phase 5 (mega-B #10 + #11 + #12)** — RowCountCaption + AccountEditDialog Activities tab.
9. **Final** — smoke test the full flow, typecheck, cut the PR against `dev`.

## Today's state (2026-04-23)

Branch `feat/megaB-lane-a-tail` has 10 commits:
- 6 from the prior mega-B arc (A5, A8, A9, A10 affordance, A10 Opp audit, A10 #6 variant palette)
- **7124853** `fix(inline-edit): stop DataGrid cellMouseDown from stealing focus` (#7a)
- **afb608c** `feat(inline-edit): per-row ownerGate for schema-driven cells` (#7b)
- **1426fad** `feat(schemaColumns): emit InlineEditable renderCells with ownerGate` (#7)
- **37ac68d** `chore(sensitivity): classify Account.NumberOfEmployees, Contact.npsp__Primary_Affiliation__c, Activity block` (#8)

Parked until the above sprint completes. After Phase 3 lands, the branch continues with #10 + #11 + #12, then PR opens against `dev`.
