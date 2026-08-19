# MVP launch — running hand-off notes (for Jac)

**Launch target:** (moved — see "Launch pacing" below)
**Last updated:** 2026-04-20 (page-rename cleanup PR #148 in review; plan PR #147 merged)
**Canonical bug spec:** `tasks/mvp-launch-sprint.md` (B1-B9)
**Master plan (2026-04-20 expansion):** `tasks/objects-production-readiness-plan.md` (PR sequence #147-#168)
**Session source:** `tasks/notes-2026-04-17-jac-review.md`

This is a live status page. Updated with every PR diff — no separate docs-update churn. Newest entries at the top of the progress log; status table updates in place.

## Scope expansion 2026-04-20

JP expanded scope on 2026-04-20 from "ship B3 and move on" to "get all 5 core SF objects (Opportunities, Accounts, Contacts, Tasks, Activities) production-ready using real SF schemas — no shortcuts." See `tasks/objects-production-readiness-plan.md` for the full verified inventory + 23-PR sequence (#147-#169, including a page-rename cleanup at #148). B3 and B6 absorbed into PRs #149-#151; B4 splits into PRs #161-#165; B5, B7-B9 become PRs #166-#169.

## Launch pacing

Original target Wed 2026-04-22 is deferred. JP: *"We have time to do this correctly, so ignore time constraints. … production-ready for MVP sprint."* New cadence: each PR in the plan sequence ships production-ready before the next starts. Per-PR status tracked in the plan doc's "PR sequence" table.

## Status at a glance

| Bug / Item | Priority | Status | Ref | Pending Jac action? |
|---|---|---|---|---|
| **Objects production-readiness plan** | P0 | ✅ Merged to dev ([PR #147](https://github.com/Pursuit-Org/bedrock/pull/147)) | [plan](objects-production-readiness-plan.md) | — |
| **B1** targets not saving to shared DB | P0 | ✅ Merged to dev | [#142](https://github.com/Pursuit-Org/bedrock/pull/142) | ⏳ Run migration + confirm deployed `DATABASE_URL` (see below) |
| **B2** opp `Type` field missing on view | P0 | ✅ Merged to dev | [#144](https://github.com/Pursuit-Org/bedrock/pull/144) | — |
| **B3** Reports + Contacts 500-row cap | P1 | 📘 Absorbed — PRs #149-#151 | [plan](objects-production-readiness-plan.md) | — |
| **B4** task create/edit/delete bugs | P1 | 📘 Absorbed — PRs #161-#165 | [plan](objects-production-readiness-plan.md) | — |
| **B5** inline-edit lock too strict on Amount + Probability | P1 | 📘 Absorbed — PR #166 | [plan](objects-production-readiness-plan.md) | — |
| **B6** Contacts inline-edit migration status | P1 | 📘 Absorbed — PRs #149-#150 | [plan](objects-production-readiness-plan.md) | — |
| **B7** dropdown picker positioned wrong | P2 | 📘 Absorbed — PR #167 | [plan](objects-production-readiness-plan.md) | — |
| **B8** Progress page full pipeline (include Lost/Withdrawn) | P2 | 📘 Absorbed — PR #168 | [plan](objects-production-readiness-plan.md) | — |
| **B9** inline-edit "actively editing" affordance | P2 | 📘 Absorbed — PR #169 | [plan](objects-production-readiness-plan.md) | — |

Status legend: ⏳ Queued · 🚧 in flight · 👀 in review · ✅ merged · 📘 absorbed into master plan.

For per-PR status of the 23 PRs in the plan, see the "PR sequence" table in `tasks/objects-production-readiness-plan.md`.

## Pending actions on your side (Jac)

1. **Run the B1 migration against the shared segundo-db.** Idempotent — safe to re-run.
   ```bash
   psql "$DATABASE_URL" -f financial_forecasting/db/migrations/2026-04-19-add-manage-owner-goals-permission.sql
   ```
   Verify:
   ```sql
   SELECT name, permissions->>'manage_owner_goals' FROM bedrock.permission_profile ORDER BY name;
   ```
   Expected: `Admin=true, Executive=true, Relationship Manager=null, Project Manager=null`. Without this migration, `Executive` users still 403 on target edits even though PR #142 is merged — the `init.sql` seeds use `ON CONFLICT DO NOTHING`, so existing rows aren't auto-updated.

2. **Confirm `DATABASE_URL` is set in the deployed backend's `.env`.** PR #142 removed the `postgresql://bedrock@localhost:5432/bedrock` fallback. If `DATABASE_URL` is unset or empty, the backend refuses to start — `init_db` logs a clear error, pool stays `None`, every DB route returns 503. Intentional, but means the production deploy must have the env var explicitly set.

## Progress log (newest first)

### 2026-04-21 — PR #169 mega-A: Lane B bundle (B3/B4/B5/B6/B7/B8/B9/B10) 👀 in review

- **Why.** Lane B's "tail" PRs #162-#172 were plotted as individual drops in the collision-gate table, but after #168 landed (ghost-field strip) the remaining B3-B10 items all converged on the same files (`AccountEditDialog.tsx`, `ContactEditDialog.tsx`, `TaskPanel.tsx`, `main.py` ownership + task handlers). Merging 8 sequential PRs against the same 4 files would force 8 rebases on a moving base — the serialization cost exceeded the isolation benefit. JP approved bundling into a single Lane-B mega-PR, with scope explicitly fenced to items already signed off in the plan doc (no drive-by cleanups).
- **Fix (backend, `main.py`).**
  - **Generalized ownership helper.** `_enforce_opp_ownership_for_payment` (introduced PR #163) renamed + generalized to `_enforce_record_ownership(salesforce, sobject, record_id, user, edit_all_perm=None)`. First guard: `user.get("is_service") → return` so service callers (Pebble's future `pebble_crm_write` flow) bypass cleanly without querying SF. Second: admin bypass via `manage_users_roles`. Third: optional `edit_all_perm` key (Opp takes `"edit_all_opportunities"`; Account + Contact pass `None` since no parallel `edit_all_*` permission exists). Fourth: owner match. Otherwise 403. All four callers (`update_payment`, `delete_payment`, `update_opportunity`, `delete_opportunity`, new `update_account`/`delete_account`/`update_contact`/`delete_contact`) route through the same helper — one audit point for ownership-bypass logic.
  - **3 new DELETE endpoints.** `DELETE /api/salesforce/opportunities/{id}`, `DELETE /api/salesforce/accounts/{id}`, `DELETE /api/salesforce/contacts/{id}`. Each gated on `check_permission_or_internal("edit_accounts"|"edit_contacts"|"edit_own_opportunities")`, runs `_enforce_record_ownership` with the appropriate sobject + `edit_all_perm`, calls `salesforce.delete_record()`, invalidates cascade caches (`opps:`, `stage_history:30`, `opp-payments:`, `payments:`, `my-tasks:`, `opportunities:` for Opp; `accounts:`, `contacts:`, `opps:` for Account; `contacts:` for Contact). Error paths sanitize per the #163 pattern — `str(e)` logged, generic message to client.
  - **Account + Contact PUT hardening.** `update_account` + `update_contact` gained rate limiting (`@limiter.limit("30/minute")` + `request: Request` first param), ownership enforcement via the helper, and sanitized error responses. Parity with the #164 Payment pattern.
  - **Payment endpoints switched to `check_permission_or_internal`.** JP asked mid-planning for the Pebble-CRM-write readiness hook: Pebble's future write flow authenticates as a service principal (`is_service=True`) and needs to reach Payment endpoints. `check_permission_or_internal("edit_payments")` returns early for `is_service` callers, falls through to the standard `check_permission` for human callers. The helper's `is_service` bypass is now load-bearing for this pathway.
  - **Task WhoId + B10 defensive fix.** `TaskCreateRequest` + `TaskUpdateRequest` gained `WhoId: Optional[str] = None`. `create_opportunity_task`'s dict-spread order reversed so the URL-path `opportunity_id` always wins over any `WhatId` in the request body (prior spread let body's WhatId silently shadow the URL param — B10 failure mode on the QA checklist).
- **Fix (frontend).**
  - **`services/api.ts`:** 3 new `deleteSf{Opportunity,Account,Contact}` methods; `createTask` + `updateTask` declare `WhoId?: string | null`.
  - **`components/AccountEditDialog.tsx`:** 7 `useSchemaPicklist` hooks replace all `FALLBACK_*` + ad-hoc `useEffect` describe fetches (`Type`, `Industry`, `AccountSource`, `Account_Tier__c`, `Company_Size__c`, `npsp__Funding_Focus__c`, `Organization_Focus_Area_s__c`). `npsp__Matching_Gift_Request_Deadline__c` switched from text → `type="date"` picker. New destructive Delete footer button (2-step popover) + `onDeleted` prop + `handleDelete` with cascade invalidation.
  - **`components/ContactEditDialog.tsx`:** 5 `useSchemaPicklist` hooks (`Salutation`, `Gender__c`, `npe01__PreferredPhone__c`, `npe01__Preferred_Email__c`, `LeadSource`). New editable `npe01__AlternateEmail__c` field. Destructive Delete footer gated on `dialogTab === 0`.
  - **`components/OpportunityEditDialog.tsx`:** Destructive Delete footer on Details tab + `onDeleted` wiring. Reuses the existing `canEdit` gate (admin OR `edit_all_opportunities` OR (isOwner && `edit_own_opportunities`)).
  - **`components/TaskPanel.tsx`:** Status + Priority Selects switched to `useSchemaPicklist('Task', ...)` in both create form AND TaskItem edit form (4 spots total). Preserves picklist-value-not-in-active-list via a `(inactive)` MenuItem (`feedback_sf_stages_sacred` pattern). New Contact Autocomplete bound to `editTask.WhoId` and `newTask.WhoId` — wired through a `contactOptions` prop from the parent (fetched once via `/api/salesforce/contacts`). `saveEdit` rewritten to be diff-based (B8 fix): previously sent the full `editTask` verbatim (empty-string `ActivityDate`/`OwnerId`/`WhoId` → SF 400); now computes diff against `originalTask` and sends only changed fields. `createTaskMutation` builds its payload explicitly (drops DriveLink UI stub, coerces empty strings to undefined). Minor a11y fix: explicit `id` + `labelId` on InputLabel/Select pairs so `aria-labelledby` actually wires through (MUI doesn't auto-generate it).
- **B7 and B9 status.** Not reproducible on dev HEAD `1661ad8` after 10 verification passes. B7 ("task title coerces to 'True' on save") — TaskPanel's `saveEdit` sends Subject through verbatim; no coercion path in React, api.ts, or the updateTask handler. B9 ("task title not persisting on create") — `createTaskMutation` now builds payload explicitly and the new regression test locks Subject string type. Both bugs were on the QA checklist but I couldn't reproduce either; JP's decision: skip the bug fix, add regression tests that would catch the behavior if it ever regresses. Locked down in `TaskPanel.test.tsx`.
- **Scope fence — NOT doing.** Did NOT touch inline-edit cells (that's Lane A8/A9/A10). Did NOT extend the `TaskPanel` Delete flow beyond the existing row-level `ConfirmSaveButton` popover (which already exists). Did NOT add a corresponding `edit_all_*` permission for Account/Contact — the helper's `edit_all_perm=None` path codifies "admin-only bypass" for those sobjects, which matches the product decision that tier-1 account/contact data is admin-sensitive. Did NOT add an `is_service` check to the `check_permission` primitive itself — switching individual endpoints to `check_permission_or_internal` is the narrower, reviewable path.
- **Tests.** 23 new tests (16 backend + 7 frontend), zero regressions:
  - Backend: `TestEnforceRecordOwnership` (10 tests, renamed + expanded from `TestEnforceOppOwnershipForPayment`) — covers the 5-arg signature, the is_service bypass-without-querying-SF case, the admin bypass without `edit_all`, owner allowed, non-owner 403 with sobject in error message, Account ownership against a real `FROM Account` SOQL, Contact ownership against `contacts` error text. Three new DELETE endpoint classes — `TestSalesforceOpportunityDelete`, `TestSalesforceAccountDelete`, `TestSalesforceContactDelete` (3 tests each: success, SF failure 400, invalid id 400/422). `TestSalesforceOpportunityTasks` gained 3 new cases: `test_create_task_with_whoid_round_trips`, `test_create_task_url_whatid_wins_over_body_whatid` (B10 regression), `test_update_task_with_null_activity_date_succeeds` (B8 regression).
  - Frontend: `AccountEditDialog.test.tsx` NEW (1 test) + `ContactEditDialog.test.tsx` NEW (1 test) + `OpportunityEditDialog.test.tsx` extended (+1 test, 16 total) — destructive-confirm popover pattern + `onDeleted` wiring per dialog. `TaskPanel.test.tsx` NEW (4 tests): B6 picklists-from-schema, B5 Contact autocomplete wires WhoId, B9 Subject-persists-as-string regression, B8 diff-based-update regression.
- **Verification.**
  - `npx tsc --noEmit` clean.
  - `CI=true npx react-scripts test --watchAll=false` → **34 suites / 427 tests pass** (baseline 31/420 + 3 new files + 7 new tests).
  - `pytest tests/` → **19 failed, 765 passed, 22 skipped** (baseline on `ce6c5fd` was 29 failed / 739 passed; my work adds 16 new passes + 10 pre-existing failures in `test_permissions.py` / `test_projects_endpoints.py` / `test_sf_dependencies.py` happened to start passing as side effects of the ownership helper refactor. All 19 remaining failures are pre-existing per `tasks/remaining-32-test-failures-plan.md`).
- **Rebase note.** Branch was based on `1661ad8` (post-#166). PR #168 landed mid-work (strips 4 ghost fields from `OpportunityEditDialog.tsx` + `types/salesforce.ts` + `helpers.ts` + `conftest.py`). Clean rebase onto `ce6c5fd` — my Delete-button work is in the dialog footer region, #168's removals are in the Ownership & Contract section. Zero conflicts. Verified no downstream test references to the 4 deleted fields.
- **Pending for you.** Review PR #169 (~900 LOC Python + ~700 LOC TS + 23 new tests). No migrations. Unlocks Lane B11 (task delete cache invalidation) if you want it — though B11's scope is arguably already covered by #169's diff-based saveEdit + the standard react-query invalidation patterns in `deleteTaskMutation.onSuccess`. B12 (Activities list page) + B13 (DriveLink UI stub decision) remain as distinct follow-ups. The Pebble CRM-write pathway is now unblocked at the endpoint level — Pebble can reach `POST/PUT/DELETE /api/salesforce/payments` as a service principal without tripping permission gates. Pebble still needs its own auth layer wiring; separate workstream.

### 2026-04-21 — PR #164 payment-hardening round 2 (deferred items from #163) ✅ merged 2026-04-21

- **Why.** PR #163 scope-fenced four items to avoid post-merge scope creep: ownership check on the existing `update_payment` PUT (same pre-existing gap as create/delete had), rate limiting on all three payment write endpoints, unmounted-component guard in `PaymentCreateDialog`, and handler-naming cleanup in `PaymentSchedule.tsx`. JP asked for all four now as a round-2 follow-up.
- **Fix (backend, `main.py`).**
  - **Ownership parity on PUT.** `update_payment` now resolves the payment's parent Opp via a cheap SOQL lookup (same pattern as `delete_payment`) and defers to `_enforce_opp_ownership_for_payment`. 404 if the payment doesn't exist; 403 if the caller isn't the owner and doesn't have admin or `edit_all_opportunities`. Also added `cache.invalidate_prefix("opportunities:")` to the success path (rollup fields on the parent Opp may change when payment Amount/Paid fields update). Error-path sanitization matches POST/DELETE — `str(e)` stays server-side, client gets a generic message.
  - **Rate limiting.** `@limiter.limit("30/minute")` added to `create_payment`, `update_payment`, and `delete_payment`. Requires `request: Request` as the first parameter (slowapi convention). 30/minute is comfortable for legitimate use (bulk-adding ~3 payments per opp with review between each) but blocks the "compromised-account spams 10k payments" scenario from Agent A's review. The app's default limiter (60/min) still applies as a backstop on every route.
- **Fix (frontend).**
  - **`PaymentCreateDialog` unmounted-component guard.** Added `isMountedRef = useRef(true)` + cleanup useEffect. `handleSave`'s success/error/finally paths now all check `isMountedRef.current` before calling `setSaving`, `onCreated`, `onClose`, or `toast`. If the parent Opp drawer closes while the POST is in flight, the SF record still gets created (the POST already landed) but the UI follow-up is suppressed — no more React "state update on an unmounted component" warnings and no stale-callback mutations on the parent.
  - **Handler naming cleanup in `pages/PaymentSchedule.tsx`.** Renamed `handleDetailSaved` → `handleDetailClosed` (it's wired to both `onSaved` AND `onDeleted` on `PaymentEditDialog`, so the old name was misleading on the delete wiring). `handleDetailClose` stays as a separate thing — it's the no-refresh close path for Cancel.
- **Scope fence — NOT doing.** Stale Opp Payment Summary rollup after delete (requires full Opp refetch inside the still-open dialog — bigger refactor, `apiService.getOpportunities` only returns a list, no singular getter exists; accepting the limitation: rollups refresh on close/reopen). Color-consistency between the `color="error"` Delete button and the `color="warning"` popover (cosmetic, defer). `isAdmin`-vs-`edit_payments` frontend/backend divergence (verified in `routes/permissions.py:208-220`: backend doesn't auto-grant admins; theoretical edge case — admins typically have all perms so no practical mismatch; frontend `isAdmin ||` shortcut is defensive-defense-in-depth).
- **Tests.** 4 new backend tests, zero regressions:
  - `TestSalesforcePaymentUpdate` (NEW, 4 tests) — mirrors the post-#163 TestSalesforcePaymentDelete structure: success with admin bypass + update-record call verification, 404 when parent-opp lookup fails, 400 when SF rejects the update, 400/422 when payment_id is malformed. Proves the ownership helper is wired into PUT and that the parent-opp lookup happens before update.
  - Rate-limit tests deliberately skipped — slowapi's shared per-IP state + TestClient's fixed "testclient" IP make per-endpoint limits hard to isolate in unit tests without flakiness. The decorators are declarative library primitives; functional verification happens at integration-test time.
- **Verification.**
  - `npx tsc --noEmit` clean.
  - `CI=true npm test --watchAll=false` → **29/29 suites, 398/398 tests pass** (unchanged — frontend changes are behavioral guards that don't change rendered output).
  - `pytest tests/` → 20 failed (pre-existing in `test_sf_dependencies.py`, unchanged), **748 passed** (baseline post-#163: 744; +4 new in `TestSalesforcePaymentUpdate`), 22 skipped.
- **Note on delete_payment.** No functional change to `delete_payment` beyond adding the rate-limit decorator + `request: Request` parameter — ownership check was already in PR #163. Added for symmetry so all three write endpoints have consistent rate limits.
- **Pending for you.** Review PR #164 (backend-heavy, 4 main.py edits + 1 frontend component edit + 1 page rename + 4 new tests). No migrations. The "accept the limitation" item (stale Opp rollup after delete) is worth discussing post-merge — fixing it properly requires either a singular `getOpportunity(id)` API (minor backend + apiService work) or a larger refactor that makes `editForm` reactive to a react-query detail. Flag if you want that as a separate follow-up.

### 2026-04-21 — PR #163 security hardening + re-apply Delete flow ✅ merged 2026-04-21

- **Why.** Two adversarial Explore agents reviewed PR #161 post-open and found real issues: **Critical** — `check_permission("edit_payments")` alone let any user with that permission create/delete payments on **any** opportunity, including ones they didn't own (no ownership parity with `update_opportunity`'s pattern at `main.py:426-436`). **High** — `amount: float` had no Pydantic validator (negative/NaN/Infinity/1e308 all accepted) and `scheduled_date: str` had no format validator (10MB payloads, SOQL strings, malformed dates all sailed through to SF). **Medium** — `detail=str(e)` on error paths leaks SF internal error text (field names, instance URLs, rate-limit hints); Pydantic default `extra="allow"` silently accepts unknown fields (field-injection probing surface). Additional finding: the destructive Delete flow I wrote for #161 didn't land in the merge commit (JP squash-merged before my second push reached the remote); re-applied here.
- **Fix (backend, `main.py`).**
  - **Critical — ownership enforcement.** New helper `_enforce_opp_ownership_for_payment(salesforce, opportunity_id, user)` mirrors the pattern in `update_opportunity`: admin (`manage_users_roles`) or `edit_all_opportunities` bypasses; otherwise the caller's `sf_user_id` must match the Opp's `OwnerId`; 404 if opp absent; 403 if the user is not linked to a Salesforce user (can't evaluate ownership → deny). Wired into `create_payment` right after `validate_salesforce_id`. For `delete_payment`, which takes only `payment_id`, the endpoint now runs a cheap SOQL lookup for the payment's parent `npe01__Opportunity__c` first (also gives a clean 404 when the payment is absent), then calls the helper with the resolved opp id.
  - **High — Pydantic validation on `PaymentCreateRequest`.** Added `class Config: extra = "forbid"` to reject unknown fields; `@validator("amount")` rejects NaN/Infinity, `<= 0`, and `> 1e12` (sanity bound — no single payment >$1T); `@validator("scheduled_date")` enforces strict YYYY-MM-DD via `datetime.strptime` + exactly-10-char length check (blocks 10MB-string DoS); `@validator("payment_method")` caps at 255 chars (SF picklist max).
  - **Medium — error-message sanitization.** Both `create_payment` and `delete_payment` now log `str(e)` server-side with `exc_info=True`, but return a generic client detail ("Failed to create/delete payment. Check server logs or contact support.") — no SF internals leak to authed attackers.
- **Fix (frontend, re-applied from #161 work that didn't reach the merge).**
  - `components/PaymentEditDialog.tsx` — destructive Delete button in the footer (`variant="outlined" color="error"`, `marginRight: auto`), reuses `ConfirmSaveButton`'s 2-step popover with explicit warning "This permanently deletes the payment from Salesforce. This cannot be undone, and the parent opportunity's payment rollups will recalculate." New `onDeleted` prop, `handleDelete` handler, `deleting` state. Save button now also disabled when `deleting`. Delete button hidden when `!canEdit` or `!originalRecord`.
  - `services/api.ts` — NEW `deleteSfPayment(paymentId)` method.
  - `components/OpportunityEditDialog.tsx` + `pages/PaymentSchedule.tsx` — wire `onDeleted` to the same refresh path as `onSaved` so the inline payment list / schedule table drops the deleted row immediately.
  - Explicitly no quick-delete icon on the accordion rows, per JP constraint on #161.
- **Scope fence.** Did **NOT** apply the same ownership hardening to the existing `update_payment` PUT endpoint at `main.py:847-870`. It has the same pre-existing gap; the adversarial review didn't name it and expanding scope post-merge would creep the PR. Flagged explicitly in the PR body as a follow-up. Did NOT add rate-limiting (Medium finding #6) — separate concern best applied as a middleware-level sweep across all write endpoints. Did NOT address the UX findings (unmounted-component setState, stale Opp rollup after delete, handler naming) — deferred per my summary to JP.
- **Tests.** 19 new backend tests, zero regressions:
  - `TestPaymentCreateRequestValidation` (NEW, 12 tests) — unit tests on the Pydantic model: minimal valid payload succeeds; negative/zero/NaN/Infinity/overlarge amount rejected; malformed/out-of-range/giant-string dates rejected; extra field rejected; overlong payment_method rejected; None payment_method allowed.
  - `TestEnforceOppOwnershipForPayment` (NEW, 6 tests) — unit tests on the helper directly: admin bypasses without querying SF; edit_all_opportunities bypasses; owner allowed; non-owner 403; missing opp 404; unlinked user 403 without querying.
  - `TestSalesforcePaymentCreate` — unchanged (admin-path existing tests still pass because the helper admin-bypasses).
  - `TestSalesforcePaymentDelete` — extended with a `test_delete_payment_not_found_returns_404` case; existing tests updated to mock the new parent-opp lookup query (`mock_client.salesforce.query.return_value = {"records": [{"npe01__Opportunity__c": ...}]}`).
  - Frontend: re-applied 2 PaymentEditDialog tests (destructive-confirm popover fires before network call; Delete button hidden without edit_payments).
  - Full suite: **29/29 frontend suites, 398/398 tests pass** (tsc clean). `pytest tests/` → 20 failed (pre-existing in `test_sf_dependencies.py`, unchanged), 744 passed (baseline post-#162: 725; +19 new), 22 skipped.
- **Architecture note.** `_enforce_opp_ownership_for_payment` adds one extra SOQL round-trip per non-admin create (to look up OwnerId) and per any delete (to look up the parent Opp id, which is needed regardless of whether ownership bypass applies — so the SOQL runs for admins too). For MVP scale, the cost is acceptable.
- **Secret-rotation recap.** Earlier in this session I accidentally read `.env` and my sed redaction missed the `GOOGLE_CLIENT_SECRET` — Jac decided whether to rotate. That incident is why `memory/feedback_never_read_secrets.md` now exists; I will never read a secret-bearing file again. Unrelated to this PR's content, flagging for continuity.
- **Pending for you.** Review PR #163 (~250 LOC Python + ~230 LOC TS + 19 new backend tests + 2 new FE tests). Merge-after-review unlocks Lane B3 (`pr-dialog-audit-account`) to start. The follow-up for `update_payment` ownership parity is still pending — if you want me to do it as a trivial follow-up PR, say so.

### 2026-04-21 — PR #161 post-merge follow-up: always-visible Payment Schedule + Create ✅ merged 2026-04-21

**Delete addendum (2026-04-21 afternoon):** JP asked during the #161 work to also add delete, with the explicit constraint "don't allow quick delete from the dropdown schedule, but make sure there's a warning pop up before saving the deletion." **The Delete feature did NOT make the #161 merge** — squash happened before the second push landed. Delete is being re-applied in PR #163 (see entry above).


- **Why.** Post-#159 smoke on a Qualifying-stage Opp surfaced that the inline Payment Schedule accordion was hidden (it was nested inside the Payment Summary stage-gate, which only renders at Collecting/Closed). JP: "Payment section doesn't appear on Opportunity if no Payments are created yet, it should show the section and allow creating Payments using the dialog stack." Two issues in one ask: (1) accordion visibility gated too tightly, (2) no way to CREATE new payments from the inline UI — only edit existing ones.
- **Fix (frontend).**
  - Moved the `<Accordion>` OUT of the `PAYMENT_SUMMARY_STAGES.has(originalOpp.StageName) && (...)` conditional in `OpportunityEditDialog.tsx` so it renders for every loaded Opp regardless of stage. The Payment Summary **rollup cells** (Payments Received, Outstanding, Last/Most Recent/First Payment, Next Scheduled Payment picker) stay stage-gated — they're meaningful only once money is actually moving.
  - Added a "+ Add Payment" `<IconButton>` inside the `AccordionSummary`'s right edge. `e.stopPropagation()` prevents clicks from toggling the accordion. Button is hidden when `!canEdit` (no `edit_payments` permission).
  - New `components/PaymentCreateDialog.tsx` (237 LOC) — minimum-field form: Amount, Scheduled Date, optional Payment Method (from `useSchemaPicklist`). Distinct from `PaymentEditDialog` (which is PATCH) and from `PaymentScheduleModal` (bulk-create with sum-matches-Opp-amount validation). On save: POSTs via new `apiService.createSfPayment`, calls `onCreated(id)` which from `OpportunityEditDialog` expands the accordion + refetches so the new row is immediately visible.
- **Fix (backend).**
  - New `POST /api/salesforce/payments` endpoint at `main.py` (after the existing PUT handler). Pydantic `PaymentCreateRequest` model (`opportunity_id`, `amount`, `scheduled_date`, optional `payment_method`, default `paid=False`). Permission-gated on `edit_payments` (same as update). Calls `salesforce.create_record('npe01__OppPayment__c', fields)`, invalidates `payments:`, `opp-payments:`, and `opportunities:` cache prefixes (rollup fields on the parent Opp change when a new payment lands).
- **Scope fence.** Did NOT extend the bulk `routes/payment_schedules.py` create endpoint — it has `delete_existing=True` as default and a sum-matches-Opp-amount validation that makes it wrong for single-record append. Did NOT change the update endpoint. Did NOT convert `PaymentEditDialog` to also handle create — a dedicated `PaymentCreateDialog` keeps the two flows cleanly separated and avoids 20+ branches inside a single component.
- **Tests.** 9 new tests, zero regressions:
  - `PaymentCreateDialog.test.tsx` (NEW, 5 tests): renders required fields + opp-name subtitle, resets form on each open (stale-state leak guard), fires `createSfPayment` + `onCreated(id)` on successful save, surfaces validation errors when Amount ≤ 0 or Scheduled Date is empty, disables form + banner when `!edit_payments`.
  - `OpportunityEditDialog.test.tsx` (+2 tests, 15 total): accordion ALSO renders at early-pipeline stages (flips the previous "NOT rendered" assertion); "+ Add Payment" click opens PaymentCreateDialog without toggling the accordion; hidden when user lacks edit permission.
  - `tests/test_api_endpoints.py` (+1 class, 4 tests): `TestSalesforcePaymentCreate` covering success (with field-mapping verification), optional Payment Method omission, invalid `opportunity_id` 400/422, missing required fields 422.
  - Test fixture: added `"edit_payments": True` to the admin permissions dict in `mock_db` so the new tests don't 403.
- **Verification.**
  - `npx tsc --noEmit` clean.
  - `CI=true npm test --watchAll=false` → **29/29 suites, 396/396 tests pass** (baseline post-#159: 28/389; delta +1 suite, +7 tests — matches exactly).
  - `pytest tests/` → **20 failed, 722 passed, 22 skipped** (pre-existing 20 failures in `test_sf_dependencies.py` unchanged; baseline post-#158 was 718 passing, delta +4 matches the new TestSalesforcePaymentCreate class).
  - 5 verification passes per JP directive: functional, dead-code, user-flow trace, edge cases, scope fences — all clean.
- **Numbering.** Target was originally #160, but JP flagged Lane A is taking #160 → renamed branch to `feat/pr161-opp-payment-create` before push.
- **Pending for you.** Review PR #161. 5 files modified + 2 new files. No migrations; one backend endpoint added; one new Pydantic model. Manual smoke deferred to your review (new POST hits live SF — verify created records have the right parent Opp + field shape).

### 2026-04-21 — Lane B2 shipped (PR #159, scope-expanded + post-smoke iteration) ✅ merged 2026-04-21

**Post-smoke iteration (2026-04-21 afternoon):** First smoke test surfaced that the original "View Payment Schedule" nav link opened a dead-end — the user navigated away from the Opp drawer with no back-navigation. JP redirected: "look at the schedule and just see what's on the list, not immediately edit or create new. Let's have a drop down of the payment schedule first in the Opportunity." **Replaced the nav link with an inline Accordion** in the Opp dialog's Payment Summary block. Read-first: click the accordion header → lazy-fetches payments via `getSfOpportunityPayments` → shows a small table (Amount / Scheduled / Payment Date / Status / edit-icon). Per-row EditIcon opens `PaymentEditDialog` as a modal stacked on top of the Opp drawer — on save, `paymentListQuery.refetch()` refreshes the inline list and the user remains in the Opp drawer context (no navigation). Nav-link tests replaced with 4 accordion tests; full suite 28/28 suites, 389/389 tests pass post-iteration. `useNavigate` + `mockNavigate` references purged from both the component and the test file. PaymentSchedule page's Edit Details clickthrough retained — still reachable via the stage-transition flow from `Opportunities.tsx:217` and `Priorities.tsx:1509`, and stands on its own merit.


- **Why.** Lane B2's original charter (per `tasks/objects-production-readiness-plan.md` PR #154 section) was to convert three hardcoded dialog fields in `OpportunityEditDialog.tsx` to schema-driven picklists using `useSchemaPicklist` (shipped in PR #156): `StageName` (hardcoded 13-value `OPPORTUNITY_STAGES` tuple), `RenewalRepeat__c` (4 hardcoded `<MenuItem>`s), and `Earliest_Scheduled_Payment__c` (read-only display → editable). Hardcoded picklists silently drift from SF — per `project_stage_schema_drift`, SF Opportunity currently has 22 active stages vs. the 13 declared in the frontend enum. `feedback_sf_stages_sacred` says a stored stage value must never silently disappear, which the conversions preserve via a "(inactive)" not-in-list MenuItem. **JP expanded scope mid-plan** (2026-04-21 during planning): add a navigation link from the Opp dialog's Payment Summary block to a Payment list, with clickthrough to individual Payment records. Approved via explicit bundled-L-PR choice rather than split.
- **Fix (Opportunity dialog).** `components/OpportunityEditDialog.tsx`:
  - Remove `OPPORTUNITY_STAGES` import (13 other consumers still use it from `types/salesforce.ts`; leave that export alone).
  - Add `useSchemaPicklist` + `useNavigate` imports. New hook calls for `('Opportunity', 'StageName')` and `('Opportunity', 'RenewalRepeat__c')` adjacent to the existing `useOpportunityRecordTypes()`.
  - Stage select (was hardcoded `OPPORTUNITY_STAGES.map()`) → conditional-render pattern mirroring the Record Type dropdown: editable branch when `options.length > 0`, else disabled fallback TextField with distinguished helperText: `stages.error ? 'Stage list unavailable' : 'No active stages available'`. Editable branch appends an `(inactive)` disabled MenuItem if the stored stage isn't in the active picklist — data never silently vanishes.
  - RenewalRepeat__c select (was hardcoded `None/New/Renewal/Upsell`) → same conditional-render pattern. Field is nullable, so the editable branch keeps an explicit `<MenuItem value="">None</MenuItem>` prepended.
  - Earliest_Scheduled_Payment__c (read-only Typography inside the stage-gated Payment Summary block) → editable `<TextField type="date">` in place, mirroring the Close Date / Contract Start / Contract End pattern with `InputLabelProps={{ shrink: true }}`. Stage-gating preserved per JP direction.
  - New "View Payment Schedule →" Button below the Payment Summary grid (inside the same conditional) — navigates to the existing `/payment-schedule/:opportunityId` route via `useNavigate`. Route already exists (App.tsx:307; used by Opportunities.tsx:217 and Priorities.tsx:1509 for stage transitions).
- **Fix (orphan PaymentEditDialog picklist audit).** `components/PaymentEditDialog.tsx` was orphaned (defined but not imported anywhere) — B2 wires it up as the clickthrough target, which surfaces a demo-pattern anti-pattern per `feedback_no_demo_versions`: the component had `FALLBACK_PAYMENT_METHODS = ['ACH', 'Benevity', …]` (10-item hardcoded array) as the `useState` initial for Payment Method, plus an inline `useEffect` that fetched schema-describe once per open and mutated local state. Replaced with three `useSchemaPicklist('npe01__OppPayment__c', …)` calls (for Payment Method, Department, GL Account). Each now uses the same conditional-render + distinguished-helperText pattern as Part 1, with `<MenuItem value="">None</MenuItem>` prepended (all three fields are nullable). Department and GL Account were previously conditionally rendered only when the hook succeeded; after refactor, they always render (with disabled fallback on empty), matching Payment Method's structure.
- **Fix (PaymentSchedule clickthrough).** `pages/PaymentSchedule.tsx`:
  - Extend `PaymentRow` interface with optional `Id?: string`. Update `setPayments` at `PaymentSchedule.tsx:62-65` to retain `p.Id` from the `get_payment_schedule` response.
  - Add state: `detailPaymentId`, `detailPaymentData`, `detailLoading`.
  - `handleEditDetails(paymentId)` lazy-fetches the full SF record via `apiService.getSfOpportunityPayments(opportunityId)` (backend `main.py:691-719 get_opportunity_payments` queries all 29 fields in `PAYMENT_SOQL_FIELDS`; result-cached 5 min under key `opp-payments:{oppId}`). Response is an array directly (`main.py:713 return records`), NOT `{records: …}` — handler uses `Array.isArray(res.data) ? res.data : []` guard. On error, surfaces `detail` from axios response or falls back to a generic toast.
  - Why lazy-fetch: `get_payment_schedule` returns a simplified 5-field projection (`{Id, Amount, ScheduledDate, Paid, PaymentDate}` at `routes/payment_schedules.py:72-81`) — passing that as `initialData` would leave the PaymentEditDialog form mostly empty.
  - Add per-row "Edit Details" `IconButton` in the Actions column, rendered only when `payment.Id` is set (saved rows from SF; drafts the user adds client-side have no Id until bulk-save).
  - Render `<PaymentEditDialog>` at the bottom. `onSaved` → `loadPaymentSchedule()` to refresh the schedule rows, because PaymentEditDialog hits `/api/salesforce/payments/{id}` (not the opp-scoped endpoint), and react-query cache keys don't overlap.
- **Tests.** 21 new tests across 3 new files:
  - `OpportunityEditDialog.test.tsx` (12 tests): StageName happy-path + error fallback + empty fallback + not-in-list affordance; RenewalRepeat__c happy-path + empty fallback + not-in-list; Earliest_Scheduled_Payment__c renders as date input + onChange fires handleFieldChange; View Payment Schedule button renders when stage ∈ Collecting/Closed + click navigates correctly + absent when stage is early-pipeline. Mock strategy: `.mockImplementation` for `getSchemaDescribe` (three parallel callers: 2× useSchemaPicklist + 1× useOpportunityRecordTypes); `jest.mock('./ActivityTimeline', () => () => null)` to isolate the Details tab; `jest.mock('react-router-dom', …)` captures `useNavigate` via a shared `mockNavigate` jest.fn. First-test gotcha: Stage is `required` so MUI appends an asterisk to its label — `getByLabelText(/^Stage\s*\*?$/)` handles both "Stage" and "Stage *".
  - `PaymentEditDialog.test.tsx` (6 tests, first-ever for this component): renders key fields from initialData; Payment Method picklist populates from mocked schema; disabled fallback distinguishes error ("Payment Method list unavailable") vs empty ("No active payment methods available") — one test with `unmount()` + re-render to cover both subcases; Save → Confirm popover → `updateSfPayment` called with diffed delta only; no-changes save path emits "No changes detected" toast + `onClose`; `!edit_payments` permission disables all editable fields.
  - `PaymentSchedule.test.tsx` (3 tests, new file — none existed before): renders payment rows with retained SF Ids; Edit Details click opens PaymentEditDialog populated with the full SF record; after save, `getPaymentSchedule` is called a second time (schedule refresh). `MemoryRouter` + `Routes` + `Route path="/payment-schedule/:opportunityId"` wrapper provides `useParams` match.
- **Verification.**
  - `npx tsc --noEmit` clean (from `financial_forecasting/frontend`).
  - `CI=true npm test --watchAll=false` → **28/28 suites, 388/388 tests pass.** Pre-B2 baseline: 25/367 (per PR #156 entry + post-PR #158 unchanged). Delta: +3 suites, +21 tests — exactly matches the new files. Zero regressions. act() warnings are cosmetic noise from react-query's async settlement in `OpportunityEditDialog`'s `getUsers`/`getAccounts` useEffects (same pattern present pre-B2).
  - Backend pytest not re-run: no Python changes in this PR.
  - **Manual smoke test deferred to your review** — this Claude session doesn't have a running dev server + SF auth cookies to drive the `/payment-schedule/:oppId` → Edit Details → PaymentEditDialog → save → refresh flow end-to-end. Per CLAUDE.md's "say so explicitly" rule. Automated tests exercise the render + interaction + API-call contracts of each layer; what tests can't verify is (a) visual rhythm in the Payment Summary section with the new editable date field + link, (b) the actual SF PATCH landing via `updateSfPayment`, (c) the schedule-refresh feeling responsive. Your review should cover those.
- **Scope discipline.**
  - Did **NOT** build a new `PaymentListDrawer` or extend `DialogStackContext` (considered and rejected — `/payment-schedule/:opportunityId` already exists as an opp-scoped page and is reachable via `useNavigate`; adding a new drawer would duplicate 300+ LOC of scaffolding and introduce a modal-on-drawer stacking inconsistency with the existing Dialog-based PaymentEditDialog).
  - Did **NOT** convert PaymentEditDialog from `<Dialog>` to `<Drawer>` (the pattern-consistency improvement). Modal-on-page is visually clean when the parent is a full-page route, and converting would add ~100 LOC + a new test matrix for drawer behavior.
  - Did **NOT** add a single-GET `/api/salesforce/payments/{id}` endpoint. The lazy-fetch-via-list pattern (`getSfOpportunityPayments` + client-side filter) is trivially replaceable with a single-GET call in a future PR without changing the frontend integration point — deferred as a post-MVP optimization.
  - Did **NOT** touch `types/salesforce.ts` `OPPORTUNITY_STAGES` export. 13 other consumers still import it; this PR only removes the single import in OpportunityEditDialog.tsx.
- **Pre-existing footgun flagged (not introduced by this PR).** `routes/payment_schedules.py:132-138` — when users save the schedule via the bulk `savePaymentSchedule` endpoint (existing flow), `delete_existing=True` DELETEs all `npe01__OppPayment__c` records for the opp and CREATEs new ones with only 4 fields (`Opportunity, Amount, ScheduledDate, Paid=false`). This means: if a user clicks Edit Details, changes Payment Method via the dialog, saves it (persists to SF via `updateSfPayment`), then later clicks "Save Payment Schedule" at the bottom of the page (the bulk save), their Payment Method edit is **permanently lost**. This footgun existed pre-B2 (there was just no way for users to reach it before). Full fix (switch bulk save to in-place update OR add a confirm-before-overwrite dialog) is out of scope for B2 — flagged here for a follow-up PR. Call out in review.
- **Stage-list user-visible change.** Per `project_stage_schema_drift` memory, SF has 22 active Opportunity stages vs. the 13 declared in the `OPPORTUNITY_STAGES` enum. After this PR, the Stage dropdown in the Opp dialog will surface whatever SF has as active picklist values — possibly more than 13 stages. This is the intended behavior per the plan doc's schema-driven mandate, but is user-visible.
- **Three parallel schema fetches on dialog open** — after Part 1, Opp dialog fires 3 separate useQuery hooks (StageName, RenewalRepeat__c, Record Type) on the same `/api/salesforce/schema/Opportunity` endpoint, each with a distinct react-query key. First open pays 3× network cost; `staleTime: 30 min` dedupes subsequent opens. Not worth optimizing inside B2 (would require restructuring `useSchemaPicklist`'s query key). Acceptable at MVP scale.
- **Numbering drift.** Plan estimated B2 at #157 (from my 2026-04-21 planning baseline). Actual is **#159** — A2 #157 and A3 #158 both landed during planning, shifting B2 two slots later. `tasks/parallel-pr-lanes.md` shift table + Lane B row updated. Lane A4 estimate shifts to #160 accordingly.
- **Worktree workflow.** Built in a fresh `git worktree` at `/Users/jp/Desktop/pursuit-financial-forecasting-B2` off `origin/dev` at `b820d17` (post-A3 HEAD). Primary checkout was never touched. Pre-step: cleaned up the lingering B1 worktree at `/Users/jp/Desktop/pursuit-financial-forecasting-B1` (post-merge cleanup that had been skipped) via `git worktree remove` + `git branch -D feat/pr156-use-schema-picklist` (safe because `gh pr view 156` confirmed MERGED — local `-d` would have refused since squash-merge doesn't match by SHA). Symlinked `node_modules` from primary; symlink removed explicitly before `worktree remove` to avoid the "untracked files" refusal.
- **Unblocks.** Lane B3 (`pr-dialog-audit-account`) can now start — picks up the same `useSchemaPicklist` + conditional-render + distinguished-fallback pattern this PR established in OpportunityEditDialog + PaymentEditDialog.
- **Pending for you.** Review PR #159 — 3 file edits + 3 new test files + 3 doc updates. Watch for: (a) visual rhythm of the editable date picker inside the Payment Summary's Typography-only block, (b) the bulk-save overwrite footgun above — should that become its own follow-up PR before MVP?, (c) whether the "3 parallel schema fetches per dialog open" warrants a `useSchemaPicklist` refactor to key on sobject-only with a `select` projection.

### 2026-04-21 — Lane A3 shipped (PR #158) 👀 in review

- **Why.** The Settings → Progress Visibility feature (BUG-UI-19) was ripped from the frontend in PR #139 (2026-04-21). The backend router (`routes/progress_tracking.py`), its test suite (`tests/test_progress_tracking.py`), and the `bedrock.progress_tracked_override` table were deliberately left orphaned at that time, to be pruned "once we've confirmed no external caller depends on them" (per `tasks/pr-139-qa-bugs.md:239-240`). Verification via repo-wide grep in this PR found zero callers (FE, backend, config, or init.sql). Leaving the router registered means `/api/progress-tracking/*` keeps responding 200 on GET with no consumer — surface area for no benefit. This PR completes the teardown.
- **Fix (backend).** `main.py` unregister (delete lines 44 + 120 — the import + `include_router` call). `git rm routes/progress_tracking.py` (149 LOC, 2 endpoints: `GET /api/progress-tracking/users` auth-gated and `PUT /api/progress-tracking/overrides/{sf_user_id}` admin-gated). `git rm tests/test_progress_tracking.py` (236 LOC, 9 tests across 2 classes — `TestGetProgressTrackedUsers` 4 tests, `TestPutOverride` 5 tests). NEW `db/migrations/2026-04-21-drop-progress-tracked-override.sql` — idempotent `DROP TABLE IF EXISTS bedrock.progress_tracked_override` wrapped in `BEGIN; … COMMIT;`, schema-qualified per `feedback_schema_qualify_sql`. No CASCADE — the ADD migration created only the table + PK index + 3 COMMENT ON rows, all of which drop implicitly with the table; no dependent views/FKs/triggers per verification against the 2026-04-15 ADD file.
- **Fix (frontend).** 5 BUG-UI-19 stale comments scrubbed across 3 files:
  - `services/api.ts:326-330` — delete 5-line tombstone block (endpoints gone, "do not re-add client methods" guidance moot).
  - `pages/Settings.tsx:223-226` — delete 4-line floating tombstone between unrelated mutations.
  - `pages/Settings.tsx:680-681` — delete 2-line JSX tombstone pointing at an already-removed useQuery.
  - `pages/Progress.tsx:~450` — trim parenthetical from `"(set by JP + Jac 2026-04-15; Progress Visibility override removed 2026-04-21, BUG-UI-19)"` → `"(set by JP + Jac 2026-04-15)"`. Preserves the 3-criteria filter architectural doc, drops the dated BUG-ID rot.
  - Intentionally untouched: `pages/Progress.tsx:114-118` (comment above the live `sf-users-progress` useQuery — ongoing architectural value per JP).
- **Scope-expansion note.** Lane table originally listed 3 FE comments (`api.ts`, `Settings.tsx:680`, `Progress.tsx:~111-115`). Verification grep surfaced 2 additional BUG-UI-19 references (`Settings.tsx:223`, `Progress.tsx:450`). Per the standing directive to surface scope expansion, asked JP before widening: JP confirmed include both, and to leave `Progress.tsx:114-118` alone. Lane-table Touches field + numbering shift row updated in this PR diff to match.
- **Verification.**
  - `pytest tests/` → **20 failed, 718 passed, 22 skipped** (baseline post-#157: 20/727/22; delta −9 matches the 9 tests in deleted `test_progress_tracking.py` exactly — no regressions. The 20 failures are pre-existing in `test_sf_dependencies.py` per `tasks/remaining-32-test-failures-plan.md`).
  - `npx tsc --noEmit` clean (comment-only FE changes).
  - `rg -n "BUG-UI-19|progress-tracking|progress_tracked_override|progress_tracking" financial_forecasting/` → returns only expected hits: both migration files, `tests/test_api_endpoints.py:262` (reset_cache docstring — acknowledged out-of-scope), and `pages/Progress.tsx:115` (JP-preserved comment). Zero other hits.
- **Migration safety.** DROP migration is idempotent (`IF EXISTS`). Per JP 2026-04-21: not yet applied on segundo-db, so post-merge segundo-db behavior is unchanged. Local dev environments that applied the ADD migration will lose the table when the DROP migration runs; no cross-table cleanup needed.
- **Cross-lane note.** Parallel with Lane B3 `pr-dialog-audit-account` per Round 3 of the collision gate. Verified disjoint: A3 touches `main.py` (import + router registry region, far from B3's dialog region), `routes/progress_tracking.py`, `tests/test_progress_tracking.py`, Settings.tsx, Progress.tsx, api.ts, and a new migration file; B3 touches `AccountEditDialog.tsx` only. No shared files.
- **Numbering drift.** Plan docs estimated this PR at #177. Actual is **#158** (lanes interleaved: A1 #155, B1 #156, A2 #157, now A3 #158). `tasks/parallel-pr-lanes.md` numbering shift table + Lane A3 row updated to reflect the actual number.
- **Pending for you.** Review PR #158 (1 new migration, 2 file deletes, small diffs in `main.py` + 3 FE files + 2 doc files). Post-merge: optionally apply the DROP migration to any local dev DB that has the table (`psql "$DATABASE_URL" -f db/migrations/2026-04-21-drop-progress-tracked-override.sql`). No action needed for segundo-db — table never existed there.

### 2026-04-21 — Lane A2 shipped (PR #157) 👀 in review

- **Why.** `data_sync.py::sync_activities()` at lines 55-162 mirrors SF Tasks + Events into `bedrock.activity` (Sprint 9A impl already landed in commit `a7a...`). `tests/test_activities.py` has HTTP-layer coverage (sync_count, sync_trigger, sync_status) but never exercised the service-layer mapping + upsert + control-flow logic. Next refactor of `_map_sf_task` / `_map_sf_event` / `_upsert_activity` could silently mis-mirror production data.
- **Fix.** New `financial_forecasting/tests/test_activity_sync.py` — 54 tests across 5 classes, 607 LOC:
  1. `TestParseSfDatetime` (8) — Salesforce date/datetime parsing + UTC-aware-out invariants.
  2. `TestMapSfTask` (19) — email/call/note type decision, WhatId 006/001 routing, WhoId 003 routing, call-duration sec→min conversion, identity preservation, ActivityDate fallback to CreatedDate.
  3. `TestMapSfEvent` (11) — IsAllDayEvent → calendar-event vs meeting, WhatId/WhoId routing mirrored, Location → meeting_location, DurationInMinutes direct (NOT divided unlike Task's seconds), StartDateTime fallback.
  4. `TestUpsertActivity` (4) — `"INSERT 0 1"` → "upserted", `"INSERT 0 0"` → "skipped_deleted", `deleted_at IS NULL` guard in SQL, 15 positional params in correct order.
  5. `TestSyncActivitiesRoundTrip` (12) — skips when no db_pool / no SF, queries both objects, processes mixed batch (3 Tasks + 2 Events → 5 upserts), watermark-in-SOQL only when prior rows exist, soft-deleted counted separately, survives per-row mapping error + per-query failure, history entry shape.
  - Pins **all 5 plan canonical cases** (email subtype → email, call type → call, all-day → calendar-event, WhatId 006/001, soft-delete preservation).
- **Bugs found during test-writing.** Zero. The landed impl held up on every invariant. `data_sync.py` unchanged.
- **Verification.**
  - `pytest tests/` → **20 failed, 727 passed, 22 skipped** (baseline 20/673/22 post-#155; delta +54 matches new test count exactly — no regressions).
  - `pytest tests/test_activity_sync.py -v` → 54/54 pass in 0.05s.
  - Segundo-db spot-check: 6039 rows in `bedrock.activity` (JP ran queries locally).
- **Cross-lane note.** Parallel with Lane B1 `pr-use-schema-picklist` (JP's worktree, merged as #156). Fully disjoint — new test file + new hook file. No collision.
- **Pending for you.** Review PR #157. Manual segundo-db smoke post-merge (trigger sync via `/api/activities/sync/trigger`, spot-check row count + synced_at delta).

### 2026-04-21 — Lane B1 schema-picklist hook shipped (PR #156) 👀 in review

- **Why.** Four downstream dialog-audit PRs (B2 Opportunity, B3 Account, B4 Contact, B6 TaskPanel) all need to replace hardcoded `FALLBACK_TYPES` / `OPPORTUNITY_STAGES` / `FALLBACK_SALUTATIONS` / etc. arrays with live Salesforce picklist data — otherwise a Stage/Type rename in SF silently drifts from the frontend until someone notices. Lane B1 ships the shared hook so each dialog-audit PR downstream can stay focused on UI conversion instead of reimplementing caching/dedupe/active-filter logic. No user-visible change in this PR.
- **Fix.** NEW `frontend/src/hooks/useSchemaPicklist.ts` — signature `useSchemaPicklist(sobject: string, fieldName: string) → { options: string[], isLoading, error }`. Backed by `apiService.getSchemaDescribe(sobject)` (the existing `/api/salesforce/schema/:sobject` endpoint, no backend change). React-query v3 cache keyed on `['schema-picklist', sobject, fieldName]`, 30-min staleTime, `retry: 1`, defensive envelope access (`res.data?.data?.fields ?? res.data?.fields ?? []`) so both current-raw and legacy-wrapped response shapes work. Filters to active-only values, dedupes via `Set`, sorts lexicographically. Graceful-empty on every failure path (error, field-missing, non-picklist field, all-inactive). Mirrors `useOpportunityRecordTypes.ts` structure verbatim.
- **Tests.** NEW `useSchemaPicklist.test.tsx` — 7 cases: happy path, field-absent, non-picklist field, all-inactive, dedupe, API-rejection (asserts `retry: 1` fires = 2 total calls), defensive envelope. Inline per-test fresh `QueryClient` wrapper (`retry: false, cacheTime: 0, staleTime: 0`) pattern is new for this repo — first react-query hook to have direct unit tests. First-hit gotcha: hook's `retry: 1` overrides the QueryClient default `retry: false`, so the rejection test needed `waitFor({ timeout: 5000 })` and to wait on `error` directly (not `isLoading`, which stays `true` during the ~1s retry backoff). Documented inline in the test.
- **Verification.**
  - `npx tsc --noEmit` clean.
  - `CI=true npm test -- src/hooks/useSchemaPicklist` — 7/7 pass (2.16s).
  - `CI=true npm test --watchAll=false` — **25/25 suites, 367/367 tests pass.** Zero regressions. (Pre-existing babel parse error at `utils/fieldSensitivity.test.ts:114` noted in PR #142 entry is no longer surfacing — appears fixed in a later PR.)
  - Backend pytest not re-run: no Python changes in this PR.
- **Scope discipline.** I did **not** retire `useOpportunityTypePicklist` as a thin wrapper even though the original plan doc (`objects-production-readiness-plan.md` PR #153 section) called for it — Lane A4 (`pr-opp-type-deprecation`) deletes it cleanly along with `TypeCell`, grid column, `PipelineFilterBar` type filter, and the `main.py` Type references. Touching it here would duplicate A4's work. Plan doc updated in this PR to note the divergence.
- **Numbering drift.** Plan doc expected B1 at #160 and A1 at #155. A1 landed at #155 on-schedule; B1 opens right after at #156 (−4 from plan estimate). `tasks/parallel-pr-lanes.md` "Numbering shift" table and Lane B header updated accordingly; later Lane B slots will shift as lanes continue to interleave.
- **Worktree workflow.** Built in a `git worktree` at `/Users/jp/Desktop/pursuit-financial-forecasting-B1` so A1's in-flight `main.py` edits in the primary checkout were never touched. After A1 merged, rebased onto the new `origin/dev` HEAD `79741e0` — no conflicts (different files). `node_modules` symlinked from primary (A1 didn't touch frontend deps, safe). Post-merge: `git worktree remove /Users/jp/Desktop/pursuit-financial-forecasting-B1` + branch delete.
- **Unblocks.** Lane B2/B3/B4/B6 can now import `{ useSchemaPicklist }` and convert dialogs. Each lands as a separate small PR per the parallel-lanes table.
- **Pending for you.** Review PR #156 diff (2 new files in `hooks/` + 3 doc updates). No migrations, no env changes, no backend changes, no user-visible UI change.

### 2026-04-21 — Lane A1 shipped (PR #155) 👀 in review

- **Why.** Four Salesforce list endpoints in `main.py` used single-page `salesforce.query()` with a hard SOQL `LIMIT`: once the real row count exceeds 2000 (accounts, contacts, opp-tasks) or 500 (my-tasks), results silently truncate — no error, no pagination header, no client signal. Latent correctness bug that hasn't yet bitten at Pursuit's ~1k-row scale but would the moment any collection grows past its cap. `get_opportunities` was fixed in PR #68 (2026-03-25); this PR propagates the same pattern to the remaining 4 endpoints.
- **Fix (backend).** Mirror `get_opportunities` at `main.py:304-375` exactly:
  - `get_contacts` + `get_accounts` + `get_opportunity_tasks` → `limit: Optional[int] = Query(None, le=...)`, conditional `LIMIT` clause, `salesforce.query_all()` for automatic SOQL pagination. Cache keys now `f"...:{limit or 'all'}"`. Accounts kept `le=2000`; contacts kept `le=5000`; opp-tasks newly gains `le=2000` (had no param before).
  - `get_my_tasks` stays on `salesforce.query()` — the WHERE clause (`IsClosed = false` + optional per-user date range) scope-bounds counts well under any realistic cap. Default bumped 200 → 2000, `le=500` → `le=2000` to accommodate heavy users. Explicit MVP-scale assumption: if any single user's open-Task count ever crosses 2000, switch to `query_all()` in a follow-up.
- **Tests.** 14 new + 5 existing updated, covering:
  - Contacts / Accounts: `query` → `query_all` mock update + new `paginates_beyond_2000` test (mock 2500 records, assert full passthrough + no `LIMIT` in SOQL).
  - Opportunity-tasks: full-suite (returns-list, paginates-beyond-2000, limit-validation at `le=2000`).
  - My-tasks: **defensive 9-test suite** per JP direction — returns-list, empty, date-range variants (both/none/start/end), default-limit=2000 guard, cap-at-2000 validation, `query` vs `query_all` guard (pins the intentional non-pagination decision), `IsClosed = false` guard (pins the scope-bounding assumption that makes single-page safe), service-error propagation.
  - Fixture hygiene: added `service.query_all = AsyncMock(return_value={"records": []})` to both `tests/conftest.py::mock_salesforce_service` and `tests/test_api_endpoints.py::mock_salesforce` so future callers get a safe default instead of an auto-generated child AsyncMock.
- **Frontend comment trim (bundled per JP).** Two comments in `OpportunityEditDialog.tsx:269` and `inline-edit/cells/AccountCell.tsx:22` referenced the pre-fix "truncates at 2000 rows alphabetically" state and named this PR by slug. Tightened both to describe the defensive fallback's ongoing purpose (transient pre-load / fetch-error states) without the stale truncation claim. Comment-only — no prop types, JSX, or logic changed. `npx tsc --noEmit` clean.
- **Verification.**
  - `pytest tests/` → **20 failed, 673 passed, 22 skipped** (baseline pre-change: 20 failed, 659 passed, 22 skipped; delta +14 matches new test count exactly; the 20 failures are all pre-existing in `test_sf_dependencies.py` — tracked in `tasks/remaining-32-test-failures-plan.md`).
  - `npx tsc --noEmit` clean.
  - `git diff --stat origin/dev`: 207+ / 41− = 166 net LOC across 5 files (S-M bucket per plan estimate).
- **Cross-lane note.** Lane B1 (`pr-use-schema-picklist`) ran in parallel with disjoint files (new hook file vs. backend list endpoints). Round 1 of the collision gate holds.
- **Pending for you.** Review PR #155. No migrations, no env changes.

### 2026-04-21 — Singleton-race fix shipped (PR #153) 🚧 in review

- **Why.** Two-pass verification of Jac's PR #151 (2026-04-21) surfaced that BUG-AUTH-2's fix in `dependencies.py::get_mcp_client` mutates `client.services["salesforce"]` and `client._connected_services` in place on every cookie-bearing request. Combined with the `lambda: self.sf_client.query(soql)` capture pattern across all 8 CRUD methods in `mcp_client/services/salesforce.py`, two concurrent requests from different users could race on the shared `sf_client` reference → User A's in-flight SOQL executes against User B's session. Jac's own QA tracker (`tasks/pr-139-qa-bugs.md:32-35`) named the right fix verbatim; the implementation had diverged.
- **Fix.** Added `_PerRequestMCPClient(UnifiedMCPClient)` subclass in `dependencies.py`. On each cookie-bearing request, `get_mcp_client` now builds a fresh `SalesforceMCPService` from the decrypted cookie and wraps it in `_PerRequestMCPClient` whose `__init__` copies the base's `services` dict + `_connected_services` list (no mutation of the singleton) and overrides the SF slot. The inherited `@property` accessors (`.salesforce`, `.connected_services`) resolve through the copied attrs. Non-cookie path returns the base client unchanged — service-account path (background sync, forecasting_engine, data_sync) preserved.
- **Tests.** New `tests/test_per_request_sf_client.py` — 9 tests covering: no cookie → base returned, invalid cookie → base returned, missing-tokens cookie → base returned, valid cookie → wrapper with fresh SF service, wrapper builds SF from cookie when base has no SF, **base singleton never mutated after 3 distinct-cookie requests** (the critical invariant), services-dict isolation, connected_services-list isolation, concurrent `asyncio.gather` requests get distinct `SalesforceMCPService` instances.
- **Verification.** `pytest tests/` — 658 passed, 20 failed (same 20 pre-existing failures in `test_projects_endpoints.py` / `test_sf_dependencies.py` / `test_mcp_services.py` / `test_permissions.py` per `tasks/remaining-32-test-failures-plan.md`). Baseline was 649 passed; +9 matches exactly the new test count. No regressions. No frontend changes.
- **Numbering.** Plan's original `#149` → actual `#153` after Jac's `#151` + rollups `#150, #152` took intermediate numbers. All downstream PR numbers in `tasks/objects-production-readiness-plan.md` shift by +4. See `tasks/parallel-pr-lanes.md` for the authoritative current sequence.
- **Unblocks.** Lanes A and B can now run in parallel per `tasks/parallel-pr-lanes.md`. Next PRs: Lane A `#154 pr-contacts-accounts-pagination`, Lane B `#159 pr-use-schema-picklist`.
- **Pending for you.** Review PR #153 diff (dependencies.py + new test file). No migrations, no env changes, no frontend impact.

### 2026-04-20 — Page-rename cleanup shipped (PR #148)

- **Why.** PR #147 plan-verification surfaced a file/component name drift: the **Priorities** sidebar entry routed to `pages/MyDashboard.tsx` (component inside was `const MyDashboard`), and the **Progress** sidebar entry routed to `pages/Overview.tsx` (component inside was already correctly named `Progress`, but file name was stale — asymmetric).
- **Fix.** `git mv MyDashboard.tsx → Priorities.tsx` with matching `const`/`export` rename; `git mv Overview.tsx → Progress.tsx` (file-rename only — internal `const Progress` unchanged). `App.tsx` import + JSX call sites updated. Also cleaned up 7 cross-file comment/doc references that repo-grep surfaced during verification so they point at the new file names (`env.production.template`, `DEV_SETUP_GUIDE.md`, `Opportunities.tsx`, `WeeklyCalendar.tsx`, `Layout.tsx`, `COMPREHENSIVE_DATA_FIX.md`, `README.md`).
- **Routes unchanged.** `/priorities` and `/dashboard` stay stable — no bookmark impact.
- **Intentionally untouched.** Inside the new `Progress.tsx`, the user-visible "Current FY Overview" heading is semantic English (not a component reference) — left alone.
- **Verification.** `npx tsc --noEmit` clean; `CI=true npm test -- --watchAll=false` no new failures; manual smoke on `/priorities` + `/dashboard` — page-identity headers (rendered by `Layout` from `currentMenuItem.text`) unchanged.
- **Pending for you.** None.

### 2026-04-20 — Scope expanded; master plan opened as PR #147

- **Context.** From B3 investigation (see below): Reports-page "500-row cap" turned out to be a mix of real (Contacts backend uses `query()` not `query_all()`) and perceptual (Opportunities backend already correct since 2026-03-25; the user-visible symptom was pageSize=500 + stage-filter masking). Fixing only Contacts wasn't enough.
- **JP direction (2026-04-20).** "We need all the key objects listed here, Opportunities, Accounts, Contacts, Tasks, and Activities (ignore Leads as an object for Reports for MVP). We need edit dialogs to work throughout the site, not just fix the caps on Report page. … We have time to do this correctly, so ignore time constraints. … real SF schemas, not your guesses. … DO NOT DO ANY SHORTCUTS!"
- **Inventory.** Three parallel Explore agents ran a full audit: backend list + write endpoints per object, frontend list pages + row-count captions, edit dialogs + gap analysis. Verified directly against `origin/dev` HEAD `17732d3`.
- **Master plan.** `tasks/objects-production-readiness-plan.md` — 23-PR sequence (#147 through #169, with a page-rename cleanup at #148) organized by risk and dependency. Each PR production-ready on its own. Leads drops from Reports for MVP; Activities takes its place.
- **This PR (#147)** ships docs only: the plan itself, plus supersession banners across `tasks/mvp-launch-sprint.md`, `tasks/accounts-endpoint-pagination-followup.md`, `tasks/sprint9-activities-extension-plan.md`, this file, and `tasks/handoff-prompt.md`.
- **Pending for you.** Review the plan (~10 min read). Approve PR #147. Then PR #148 (`pr-page-rename-cleanup`) is the next concrete code PR — a small file/component rename to align `pages/MyDashboard.tsx` → `pages/Priorities.tsx` and `pages/Overview.tsx` → `pages/Progress.tsx` with their sidebar labels, before any larger code work touches those files.

### 2026-04-19 — B2 shipped (PR #144)

- **Problem.** From the 2026-04-17 session (~9:21–9:55): you looked up Mercy Corps for Data in Bedrock and expected to see its `Type` value. Salesforce has `Type = 'Other fee for service'` (you confirmed in the SF UI). Bedrock showed nothing. JP flagged: "type is not pulling in correctly."
- **Root cause.** The backend correctly queried and returned Type — verified at `main.py:333` (SELECT includes Type), `main.py:365–371` (records returned raw), `services/crm_parser.py:23–27` (cache stores raw). Frontend type definitions included Type at `types/salesforce.ts:129` and `pages/Opportunities/helpers.ts:69`. The bug was purely display-side: **no grid exposed a Type column**, and no filter targeted it. Users could only see/edit Type by opening the full-edit drawer per-record. Also caught: the test factory (`conftest.py:make_sf_opportunity`) had no Type default, so no test ever round-tripped Type — the regression was invisible to CI.
- **Fix.** JP's chosen scope: "everything + inline-edit column like Stage." Single PR:
  1. New hook `useOpportunityTypePicklist.ts` — react-query fetch of `/api/salesforce/schema/Opportunity` picklist, 30-min cache, graceful empty-on-error fallback.
  2. New `TypeCell.tsx` — mirrors `StageCell` pattern. Renders a neutral-pill inline-edit select. Falls back to read-only plain text when the picklist fetch fails.
  3. `buildPipelineColumns` — new Type column between Stage and Amount, using TypeCell.
  4. `buildPaymentColumns` — new Type column (read-only) between Account and Close Date; Finance view is scan-oriented so no inline-edit.
  5. `PipelineFilterBar.tsx` — new `types` field on `PipelineFilters`, new Autocomplete in the expanded drawer, active-filter chip when set.
  6. `OpportunityEditDialog.tsx:498` — free-text TextField upgraded to select-variant TextField populated from the shared picklist hook. Falls back to free-text if the picklist is empty. Inactive-but-current-value is shown as disabled "(inactive)" so users don't silently lose a value.
  7. `Accounts.tsx:627+` opportunity-detail columns — new read-only Type column between Stage and Amount.
  8. `conftest.py:make_sf_opportunity` — Type now defaults to `"Other fee for service"` so all factory-derived tests exercise Type by default.
  9. `test_api_endpoints.py:test_get_opportunities_returns_records` — new assertion `data[0]["Type"] == "Other fee for service"` guards the API contract.
- **Verification.** Frontend typecheck clean. Full test suite no new failures. Visual check against shared DB: Type column renders, picklist dropdown populates, filter works, edit dialog select replaces the free-text field.
- **Pending for you.** None. Pure frontend PR; no migration, no env change.

### 2026-04-19 — B1 shipped (PR #142)

- **Problem.** From the 2026-04-17 session (~44:01–47:27): your shared-DB query showed only the two targets you'd set yourself — JP's never arrived, despite his session displaying them as saved.
- **Root causes, all verified against source:**
  1. `db.py:37` silently fell back to local Postgres on missing `DATABASE_URL`. JP's local backend wrote to localhost while teammates read from the shared segundo-db.
  2. Permission-key mismatch: backend `owner_goals.py:106` gated on `manage_owner_goals`; frontend used `manage_targets` at 5 sites — a permission key that is not in `PERMISSION_KEYS` and therefore never resolves to `true`. Admin bypassed this via the `isAdmin` check.
  3. Admin + Executive profile seeds in `init.sql:392–425, 469–508` omitted `manage_owner_goals`. Worked for Admin via runtime `setdefault` auto-grant; Execs had no fallback and silently 403'd.
  4. `test_owner_goals.py` mock used the stale query pattern `"FROM bedrock.app_user"` (refactored to `public.org_users`) and omitted `profile_id` from mocked rows — every permission-gated test silently 403'd.
- **Fix.** Single PR, 9 files, +211 / −15. Fail-fast on `DATABASE_URL`; rename frontend `manage_targets` → `manage_owner_goals` (5 sites); add the key explicitly to Admin + Executive seeds; new migration to apply the grant to already-seeded shared-DB rows; fix stale mock; new `tests/test_db_init.py` (3 tests) covering the fail-fast guard.
- **Verification results.**
  - `pytest tests/test_db_init.py tests/test_owner_goals.py` → 17/17 pass (3 new + 14 previously silently-403'ing).
  - Full suite: baseline 32 failed, 634 passed → after 20 failed, 649 passed. Net +15: 3 new tests + 12 test_owner_goals.py tests now actually exercising their intended flow.
  - Fail-fast smoke (`env -u DATABASE_URL python3 -c "..."`): clear error, status `disconnected`, no `asyncpg` call.
  - Frontend `npx tsc --noEmit` clean.
- **Caveats.**
  - Pre-existing babel parse error at `frontend/src/utils/fieldSensitivity.test.ts:114` — confirmed on baseline via `git stash`, not introduced here. Out of scope for this fix; should be a separate PR.
  - 20 remaining test failures are all in `test_projects_endpoints.py` + `test_sf_dependencies.py`, tracked at `tasks/remaining-32-test-failures-plan.md`.

## Tuesday 2026-04-21 pair-build plan

From the 2026-04-17 session (57:04–57:43):
- **11:30** check-in (brief)
- **2:30–3:30** main working block (you moved the jobs PRD; Damon couldn't join)
- **4:00–5:00** final go/no-go after your Nick meeting

Monday night handoff: JP sends a state-of-the-world summary — what's shipped, what's in-flight, what's still open. You can pick up any item off the sprint plan from there.

## Pre-launch checklist

- [x] PR #139 dev → main rollup merged (2026-04-19)
- [x] B1 code shipped (PR #142)
- [ ] B1 migration applied to shared segundo-db (pending Jac action above)
- [ ] Deployed `DATABASE_URL` confirmed set (pending Jac action above)
- [x] B2 (opp Type field) shipped (PR #144, merged 2026-04-20)
- [ ] PR #147 planning PR merged
- [ ] PRs #148-#169 shipped per `tasks/objects-production-readiness-plan.md` sequence
- [ ] End-to-end workflow smoke test (from the meeting: "create an opportunity, create a contact, create a task, create an account, progress it all, change it all")
- [ ] Wall of Progress E2E: JP sets a target, Jac queries DB, target is present, target appears on Jac's Progress page after refresh
- [ ] All 5 core objects (Opportunities, Accounts, Contacts, Tasks, Activities) support: find (list returns all rows), edit (dialog covers workflow fields via real SF schema), organize (sort/filter/search)

## What's explicitly parked / deferred (agreed in session)

- **Drawer vs modal vs tab** for related-object editing — you: "This is not those edit things. Those edit things are going to be fine. We can change that later."
- **Progress-page "Wins" → "Closed" rename** — the semantic overload ("Closed Won" already means something specific) doesn't survive scrutiny. Dropped.
- **Pebble integration into Bedrock** — JP: "I need another week because we gotta roll out bedrock." Post-MVP.
- **Hackathon-style shortcut replacement for Nick's external tools** — JP: "let me, like, ship something. I've been working for weeks on this and I don't want to, like, hackathon it." Pebble proper ships after MVP.
- **RecordType filtering audit** across all frontend `getOpportunities()` callers — parked post-MVP v1 because MVP is philanthropy-only fundraisers. Full spec preserved at `tasks/recordtype-audit-post-mvp.md`.
- **Stage-list drift consolidation** (9 drift sites in Overview/Accounts/PaymentProcessing/Opportunities) — parked. Plan at `tasks/stage-list-drift-plan.md`. Partially dissolves into the RecordType audit once that ships.
- **`get_accounts` endpoint single-page → `query_all()`** — latent truncation bug if account count exceeds the cap. Tracked at `tasks/accounts-endpoint-pagination-followup.md`.
- **Remaining 32 test failures** in `test_projects_endpoints.py` + `test_sf_dependencies.py` + `test_mcp_services.py`. Plan at `tasks/remaining-32-test-failures-plan.md` (uses the closed PR #102's diagnostics as reference).

## Process notes from your side (adopting going forward)

- **PR = "I tested this and it's good,"** not "I built this, help me test it." JP is adopting this. Doc-only PRs are the exception you granted.
- **Consider Playwright for automated click-through tests** post-MVP. You already use this pattern at the factory.
- **"Put yourself in the CEO shoes"** — iterate tiny polish, page-by-page, before shipping. JP agreed to adopt after MVP goes out; pre-launch mode is build-fast to hit Wednesday.

## How this doc is maintained

- Updated **in the same PR diff** as each bug-fix that changes its status. No separate docs-churn PRs. This keeps the running log synchronized with the actual code state.
- Exception: this initial creation is its own small PR so it's visible right away.
- Newest entries at the top of the Progress log.
- Status table updates in-place as each bug moves across Queued → In Progress → Shipped.
