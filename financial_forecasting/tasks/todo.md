# Build plan: account fields, campaigns, touch depth, export, pipeline stages

Status: **IN PROGRESS.** Built and pushed 2026-08-05: assigned period-scoping,
follow-up depth (D), account firmographics (part of B), export Phase 1 for
Contacts (part of E), and the additive migration for Jac. NOT built yet: stage
changes (A), opportunity tags UI (C), investor picker UI, Accounts/Opportunities
row selection. See "Remaining" at the bottom.
Decisions: (1) build on this branch; (2) closed-lost reasons = existing seven
+ not_interested/not_selected/not_responsive/revisit; (3) call_booked goes
after initial_outreach; (4) investor is a RELATIONSHIP — see item B, redesigned.
Source: Kwame's build request of 2026-08-05, re-verified against production
(read-only) and against this branch (`claude/bedrock-new-pages-builds-6nuwm4`)
on 2026-08-05. Nothing below is implemented yet.

## Corrections to the request doc (verified against live data)

The request doc was grounded in `main`. Four of its claims don't survive
contact with production or with this branch:

1. **Contact stages are not `flagged → initial_outreach → qualified → …`.**
   Live values and counts: `assigned` 147 · `initial_outreach` 827 ·
   `converted_to_opportunity` 127 · `on_hold` 71 · `not_a_fit` 8. There is no
   `flagged` and no `qualified` stage (only an unused `qualified_at` stamp
   column). So "Call Booked between Qualified and Converted" needs a new
   anchor — presumably between `initial_outreach` and
   `converted_to_opportunity`. **Question 3.**

2. **`closed_lost_reason` and `closed_lost_note` already exist** on
   `jobs_opportunity` — the doc drafts a migration to add them. There is no
   DB CHECK on the reason, and the live UI (ClosedLostModal) already uses a
   different vocabulary: budget / timing / hired_elsewhere / not_a_fit /
   no_response / role_cancelled / other. The doc proposes not_interested /
   not_selected / not_responsive / revisit / other. Only ~10 closed-lost rows
   exist, so switching is cheap either way. **Question 2.**

3. **Live opportunity stage counts** (deleted excluded): active_in_discussions
   54 · closed_won 28 · initial_outreach 16 · on_hold_not_interested 14 ·
   active_opportunity_confirmed 12 · closed_lost 10 · on_hold_not_responsive 4
   · active_builder_interview 4 · lead_submitted 0 · on_hold_not_selected 0.
   The backfill is small and concrete: 16 remaps, 18 on-hold→closed-lost,
   4 renames.

4. **Row selection exists only on Contacts.** Accounts and Opportunities have
   no checkboxes today, so export needs selection UI added there, not just a
   button. Upside the doc missed: `openpyxl>=3.1.0` is already in
   requirements.txt — no new dependency.

Also verified: `jobs_task` carries `parent_type/parent_id/owner/owner_ids/
deadline/status` (the Revisit task mechanism works as described — note
`owner_ids` is `uuid[]` referencing `org_users`, which bit us before);
`jobs_account` = key/name/owner/status/notes + sf_account_id/pbd_owner_* (no
account_type — genuinely new); `companies` has size_bucket/hq_location/
industry/stage but no `employee_count` (genuinely new).

## Branch reality (why "grounded in main" matters)

This branch has heavily rewritten the exact files items 2, 3, 6 and 7 touch:
`routes/jobs.py` (funnel period mode, outreach drills, scorecard),
`TagCampaigns.tsx` (campaign picker), `JobsOutreach.tsx` (drills, touch log).
The opportunity funnel's stage list, `_STAGE_ENTERED_COL`, STAGE_LABELS, the
Pipeline board columns and the Stage×Time heatmap all encode stage values —
a stage rename off `main` would collide with all of it. **Question 1** (base
branch) is therefore the first decision, not a formality.

## Work items

### A. Stage changes (contacts + opportunities) — first, alone, coordinated deploy
- Opportunities: drop `initial_outreach` (16 rows → `active_in_discussions`),
  rename `active_builder_interview` → `reviewing_builders` (4 rows), fold
  `on_hold_not_interested`/`_not_responsive`/`_not_selected` (14/4/0 rows)
  into `closed_lost` + reason. Rebuild the stage CHECK to 6 values.
- Closed Lost flow: reason picker (vocabulary per Question 2) + note;
  reason=revisit asks a date → stored on existing `follow_up_date` → creates
  `jobs_task(parent_type='opportunity')` for the opportunity owner. Contact
  name goes in the note free-text. No Revisit stage.
- Contacts: add `call_booked` (anchor per Question 3) with a `call_booked_at`
  stamp so period-flow funnels can count entries; rename `on_hold` → `revisit`
  (71 rows) + `revisit_date` column + task creation on set, surfacing in the
  existing Jobs Home task widget.
- History: map `on_hold` → `revisit` in `jobs_membership_stage_history`
  to_stage values (or translate at read time) so period funnels don't lose
  old entries. Same for opportunity history in `jobs_stage_history`.
- Code sweep: MEMBERSHIP_STAGES/STAGE_LABELS/stage_orders/_STAGE_ENTERED_COL/
  _NO_CONVERSION_FROM, Pipeline board columns, funnels, heatmap, filters.
- Migrations (for Jac, idempotent, no execution): stage CHECK rebuilds +
  backfills + `call_booked_at`/`revisit_date`; pre-verified counts above.
- Coordinated deploy, same as the 2026-07-16 contact-stage rename.

### B. Account fields
- Join accounts list/detail to `public.companies` for size_bucket, hq_location,
  industry (read-only display).
- **Investor as a relationship (per Kwame 2026-08-05):** a portfolio company
  names its investor/owner (Oak, Blackstone…), and that investor is itself an
  account, linked. Model: `jobs_account.investor_account_key` — nullable
  soft-FK to `jobs_account.account_key`. UI: an "Investor" account picker on
  the account detail panel (search existing accounts; creating the investor
  account goes through the normal resolve-before-create flow), an Investor
  column on the Accounts list (click navigates to the investor's account), and
  a reverse "Portfolio companies (n)" list on the investor's own account page.
  One investor per account for now; if multi-investor is ever needed, this
  column promotes to a link table without UI change. No separate account_type
  flag — "is an investor" is derivable (has portfolio companies).
- ~~`companies.employee_count`~~ — withdrawn by Kwame 2026-08-05; the
  size_bucket band is enough, and it was the only shared-table change here.

### C. Opportunity campaigns = shared tag catalog
- `jobs_opportunity.tags text[]` + GIN index; same catalog
  (`contact_tag_catalog`); no rename of the catalog table.
- Tag editor on the opportunity panel; extend TagCampaigns (this branch's
  version, with the campaign picker) to count opportunities per tag.
- `source` stays in schema, retired from UI.

### D. Touch depth panel (Outreach)
- Bucket contacts entering initial_outreach in the period by touch count
  (1/2/3/4+), reusing the drill's activity join + _jobs_relevant/
  _not_autoreply so it agrees with the rest of the tab. Row click reuses the
  existing contact drill (Staff/Tags/touch-log columns).

### E. Export (Phase 1)
- Shared selection + Export button on Contacts (has checkboxes) and add
  selection to Accounts + Opportunities; server-side .xlsx via openpyxl
  (already a dependency), returned as download. No Drive write.

## Sequencing
1. A (stages) — settle first, owns the risky backfill + deploy.
2. B and E in parallel (independent).
3. C, then D (D can filter by campaign once C lands).

## Questions — resolved 2026-08-05
1. Base branch → **this branch** (claude/bedrock-new-pages-builds-6nuwm4).
2. Closed-lost reasons → **combined list**: budget, timing, hired_elsewhere,
   not_a_fit, no_response, role_cancelled, not_interested, not_selected,
   not_responsive, revisit, other. Backfill maps on_hold_* to the matching
   not_* reasons.
3. call_booked → **after initial_outreach**:
   assigned → initial_outreach → call_booked → converted_to_opportunity.
4. Investor → **relationship, not a flag** (see item B).


## Built so far (2026-08-05)

- **Assigned period-scoped** — both columns of Outreach Detail now count entries
  into a stage during the window, so the ratio compares like with like. The
  contacts with no stage stamp (301 of 827 in production) are reported on the
  card instead of silently dropped.
- **D · Follow-up depth** — panel on Outreach, 0/1/2/3/4+ touches for the period
  cohort, each bucket expanding to its contacts. Server-side, same activity
  filters as the drills. Production check: 47 at one touch, 7 at two, 1 at three.
- **B (partial) · Account firmographics** — Size / HQ / Industry columns on the
  Accounts hub (Size visible by default, HQ + Industry opt-in), read-only from
  public.companies. The existing companies join gated on industry, hiding the
  size band for un-enriched companies; widened. Size sorts by headcount.
- **E (partial) · Export** — POST /api/jobs/export/{entity} streaming .xlsx,
  wired to the Contacts bulk bar.
- **Migration for Jac** — `2026-08-05-account-fields-and-opportunity-tags.sql`:
  investor_account_key on jobs_account, tags + GIN index on jobs_opportunity.
  Additive, no backfill. employee_count was withdrawn, so this touches no shared
  table — it is bedrock-only now.

## Remaining

1. **A · Stage changes** — the risky one. Migration + backfill (16 initial_outreach
   remaps, 18 on-hold folds, 4 renames), code sweep across funnels/board/heatmap/
   filters, coordinated deploy. Reasons vocabulary = existing seven + the four new.
   Deliberately not started alongside other work: writes must not offer a stage
   the live CHECK constraint rejects, and the backend talks to production.
2. **C · Opportunity tags UI** — column exists only after the migration; needs the
   tag editor on the opportunity panel and TagCampaigns counting opportunities.
3. **B remainder** — investor picker + reverse portfolio list. Needs the
   migration AND the UI, which is not written yet.
4. **E remainder** — row selection on Accounts and Opportunities, then their
   Export buttons (endpoint specs already built for both).
