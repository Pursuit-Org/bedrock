# Account dedupe + SF↔DB mirror — plan (PAUSED 2026-07-08)

Paused to return to jobs-page work. Resume from here.

## SUPERSEDED / EXPANDED by the foundation design (2026-07-08)
User asked to zoom out to a whole-suite data-foundation design. Full assessment + target model published as an artifact: https://claude.ai/code/artifact/016f1564-1bfa-4e6e-abf7-c5e7584ee37a (source: scratchpad/foundation_design.html). Backed by 3 code-sweep subagents + live-DB introspection (scratchpad/schema_map.md, schema_deepdive.py).

Key CORRECTED facts (I got these wrong earlier, now verified in code):
- `account_candidate`/`contact_candidate` (bedrock) = ORPHANED, zero live code refs. NOT a spine, NOT the live candidate system. Removable.
- Live contact/candidate system = `services/candidate_pipeline.py` (nightly via interaction_sync) → writes email-review candidates into `public.contacts` (contact_stage='candidate', source='email_candidate') + `email_candidate` + `contact_email_alias` + `candidate_enrichment`. Review via `/candidates` → promote/dismiss.
- Contacts are ~33k LinkedIn imports + 13.6k legacy `sf_mirror` (NO live code writes sf_mirror — bulk import since removed) + 5k email candidates. `staff_contact_relationships` (34.6k) = the LinkedIn staff↔contact connection graph.
- Accounts should DERIVE from contact email-domains + contacts' LinkedIn affiliated company + SF accounts — NOT from email activity. No real account entity exists today.
- SF = single service-account session; links spread across 6 tables (sf_contact_link, sf_account_company_map, placement_sf_sync, account_email_domain, jobs_opportunity.sf_opportunity_id, legacy sf_mirror); ≥10 create_record paths w/ uneven dedup (main.py + routes/prospects.py least guarded = dupe faucet). BUG: SF notification poller startup duplicated in main.py (~L250-260 & ~271-281) → starts twice.

## Jobs-team transcript (Damon, 2026-07-08) — refinements to the model
- Contacts = everyone (~40k: SF + LinkedIn + ad-hoc). Core problem: carve the VIABLE working set out of the 40k ("40k is meaningless as a working view").
- NEW concept **"flag for activation" / viability** = the carve. Triggers (recorded as reason): scraper found a job at their company · staffer manual pick · strategic "go after Stripe" · algorithm high-potential score. BI-DIRECTIONAL: account→flags its contacts, or strong contact→flags regardless of company. This IS the jobs-pipeline membership existence.
- Contact stage = ONE funnel spanning staff→jobs, with OWNER (which staff, so no double outreach): Cold → Flagged for outreach → Initial outreach → Activity → On hold → (handoff). Lives on the pipeline membership, not the person. Needed at contact level ("going after Uber — who are our contacts there, which have we tried?").
- Lifecycle spine: contact → flag for activation → outreach funnel → SIGNAL on a call → opportunity created (even before jobs exist) → jobs tagged on later. Opportunity = the handoff + the real working pipeline (not the contacts list). Account "Activating" = activity but no opp yet.
- Staff↔contact edge carries BOTH relationship STRENGTH (for warm-intro routing "who's closest to Carolina"; in sheets today, needs to scale via LinkedIn enrichment) AND disposition (connection_status: "can reach out"/"not a fit"). Per-staff — never collapse into global contact status.
- So axes: (1) person status global, (2) jobs pipeline membership = flag+funnel+owner+reason, (3) warmth derived, (4) staff-edge strength+disposition. Opportunity/account stages separate/calculated.

## VERIFIED cross-product + scraping impact (code sweeps, 2026-07-08)
Repos: platform monorepo (Pursuit-Org/platform) — FRONTEND client/ = /Users/jacquelinereverand (src/); BACKEND server/ = "/Users/jacquelinereverand/old platform folder/test-pilot-server" (local checkout of the pre-merge backend). bedrock app = scratchpad/bedrock-live/financial_forecasting.
- PLATFORM never refs contacts.is_jobs_contact or contacts.contact_stage → dropping/splitting them is PLATFORM-SAFE (bedrock-only). Never refs sf_contact_link/sf_account_company_map → bedrock-only to retire.
- PLATFORM "Employment Engine" (server/controllers/employmentEngineController.js) = builder-facing network+intros on the SHARED tables: reads contacts.current_company (string) AND contacts.company_id (FK→companies) [already mid string→FK migration], contacts.dedup_key, and gates builder intros on staff_contact_relationships.is_visible_to_builders (load-bearing). companies = platform-owned full CRUD (queries/companies.js). PathfinderNetwork.jsx/BuilderInsights.jsx read current_company string.
- employment_records.company_name = platform reads as display/sort only (adminDashboard.js), never joins to companies → adding company_id + keeping company_name as cache is SAFE. job_applications/job_postings.company_name = Pathfinder matches by NAME STRING (company_id FK exists but unused) → FK migration is a SEPARATE Pathfinder task, not required for jobs.
- CORRECTION: do NOT physically merge staff_contact_relationships + connection_status (platform Employment Engine depends on staff_contact_relationships.is_visible_to_builders). Keep staff_contact_relationships (shared/platform); connection_status = separate bedrock disposition satellite; "one edge" is read-layer only.
- SCRAPING (bedrock nightly): candidate_pipeline/builder_match/jobs_activity_link tightly coupled to is_jobs_contact+contact_stage with SILENT failure modes (0-row UPDATE WHERE contact_stage='candidate' "succeeds"). Step 3 must migrate the whole pipeline + bedrock.merge_contacts() fn ATOMICALLY. GOTCHA: bedrock.activity.account_id/contact_ids hold SALESFORCE ids (via sf_contact_link/account_email_domain); participant_public_contact_id is the public link. sf_contact_link→contacts.sf_id consolidation must preserve contact→SF-account path (via account.sf_id) or activity.account_id silently changes meaning.
- Net: risky flag-drop is platform-safe + bedrock-atomic; account FK move is ALIGNED with platform's in-progress company_id migration; don't merge staff edge; contacts-page + jobs_contact_membership remain bedrock-only shippable.

## Generalization (user, 2026-07-08): "flag for activation" → "flag for JOBS activation"
Program-scoped, NOT a global contact bit (same mistake as is_jobs_contact). Model = ONE neutral Person/Account spine (shared layer, no program columns) + per-PROGRAM memberships each in their OWN schema: jobs (bedrock) = flag-for-jobs-activation + outreach funnel + opps/placements; fundraising (bedrock) = donor stage + awards; admissions (platform) = applicant/lead role; learning (platform) = builder user_id + enrollment. applicant / builder-user_id / flag-for-jobs-activation are all the same shape (program membership on one person) → end-state links to one party_id. Two person populations in jobs: external CONTACTS (employer side) + BUILDERS (learners, user_id); placement links them; one spine handles alum-turned-hiring-manager. SF = mirror spine (sf_id) + confirmed OUTCOMES (won opps, affiliations=placements); flag/funnel/40k-triage stays LOCAL (SF isn't where you triage leads → "some data in SF not all" is intended, not a gap).

Target model (Party): Person (public.contacts, drop is_jobs_contact, add `status` lifecycle axis) + Account (public.companies + name_key UNIQUE + sf_id, derived/resolved). contact_stage split into 3 axes: status (lifecycle) / pipeline-membership (per-pipeline stage, off the person) / derived warmth. SF = one nullable sf_id per party, one reconciling sync, dedup-on-write. Removable tables: account_candidate, contact_candidate, activity_scan_domain/person, sf_contact_dupe_flags, sf_namematch_flags, prospect_sf_*, public *_backup_20260617; confirm-don't-drop pebble_*/world_model/dd_* (sibling-owned). Migration: dedupe→add ids→reference by id→collapse status→consolidate SF→(deepest) unify person across products via party_id. is_jobs_contact removal blast radius mapped (~12 filter sites, write sites in add-to-jobs/promote/auto-flag).

## The problem (root cause, not just symptom)
There is **no single mirrored account** today. Three disconnected representations pretend to be "the account":
1. **Salesforce Accounts** — 6,223 Organization records, with their own internal dupes.
2. **`public.companies`** — 21,064 local rows. **No `sf_account_id` column** → never hard-linked to SF.
3. **Name strings** — the jobs Accounts page groups `contacts.current_company` / `jobs_opportunity.account_name` **text** on the fly. Identity = "whatever normalizes together," not a record.

Only bridge is `bedrock.sf_account_company_map` — fuzzy, one-directional, stale (1,898 of 21k), never updates on rename. Nothing propagates a name change either direction. New dupes get minted whenever a write path can't find an EXACT name match and creates a new SF account (e.g. `JP Morgan Chase` SF acct created 2026-07-02; see `services/placement_sf.py` ~L170-190 create branch, and check other write paths / nightly sync).

## GUIDING PRINCIPLE (user, 2026-07-08) — abstract SF/DB from the user
The user should NEVER see the SF-vs-DB split. To them an account either EXISTS
(pick it) or DOESN'T (create it) — one de-duplicated list, no "local account",
no "link", no ids/dates, no source sections. The two-system reconciliation is
the system's job, done silently. Applied to the create-account dialog
(GET /accounts/resolve now returns ONE merged list; each match carries
key/sf_account_id invisibly; selecting an SF-only match materializes+links
behind the scenes). **The dedupe artifact still violates this** — it makes the
user pick a "DB canonical" AND an "SF master" separately. When we resume dedupe,
reframe it as "here are duplicate accounts → pick the winner", with SF/DB hidden
(the engine figures out DB survivor + SF master from the choice).

## Decisions locked with user
- **Source of truth**: SF usually, but **human reviews & chooses** — esp. when SF itself has dupes to pick between (handled in the dedupe artifact's SF "master" radio). After dedupe, SF is steady-state source for the name (SF→DB on refresh); nothing to ping-pong once 1:1.
- **NOT a heavy two-way mirror.** User wants "pull from both." Agreed: store only the LINK (one id), read federated, cache name for speed. No bidirectional sync engine, no drift.
- **Name strings**: overwrite in place on merge + snapshot every changed row for reversibility.
- **SF-side dupes**: merge them too (native SF Account.merge).
- **Staged**: artifact → pick winners → dry-run → execute (DB first, then SF) on explicit go.

## Target architecture ("link + pull from both", the light option)
1. **The link**: add `public.companies.sf_account_id` (UNIQUE), backfilled from dedupe survivors. SF Account Id becomes the identity, replacing name-string grouping.
2. **Reads (accounts page)**: DB supplies contacts/opps/activity/warmth/hires (already local); SF supplies canonical name + fellows-hired; join on the link. Cache SF name locally, refresh on nightly pull (one-way SF→DB read-cache, NOT a mirror). Live SF calls only for single-account detail (fellows), never bulk-per-load.
3. **Writes (create/rename account)**: resolve-or-link to an existing SF id first (match by id, then normalized name) — **never blind-create**. This is the fix for the dupe faucet.

## Build sequence
1. **Dedupe both sides** (IN PROGRESS) — collapse to one DB company + one SF account each. Human chooses in the artifact. Prerequisite for a clean 1:1 link.
2. **Add `sf_account_id` link** + backfill from survivors. Switch accounts identity to the id.
3. **Guard writes** — resolve-or-link, kill blind-create (audit placement_sf.py + data_sync.py + create_opp_placement + nightly sync for create branches).
4. **Federated reads + name cache refresh.**

## Where the dedupe work stands
- **Artifact (v2, live)**: https://claude.ai/code/artifact/db063da0-d7b8-4b19-bb2c-83e2c1ab30a1
  - 258 DB families + 89 Salesforce-only dup families.
  - Per family: pick DB canonical, pick SF **master** (live-matched SF accts), **Merge group** label (same label unifies families — how JP Morgan's 3 spelling-split families combine), edit final name, skip.
  - Exports `account-dedupe-decisions.json` **schema v2**: `db_merges[{group,canonical_name,canonical_key,canonical_company_id,merge_keys,excluded_keys,sf_master,sf_ids}]` + `sf_only_merges[{nkey,master,merge_ids}]`.
  - **AWAITING**: user reviews + returns the exported JSON.
- **Engine**: `scripts/account_dedupe_merge.py` — DB dry-run VALIDATED (737 contact-name rewrites, 81 company_id repoints, 37 company deletes on all-suggested). **TODO on resume**: add SF Account.merge execution + group unification (union merge_keys/sf_ids across families sharing a group) + sf_only_merges + row-level backup snapshot to `bedrock.account_merge_backup`. Execute path needs superuser (RLS) + likely a SECURITY DEFINER fn; prod writes/DDL are guardrail-blocked until explicit go.

## Scratchpad artifacts (regenerate if needed)
- `scratchpad/dedupe_families.py` → `families.json` (DB dup families; set-based)
- `scratchpad/sf_match.py` → `families_sf.json` (enriches families w/ LIVE SF matches; SalesforceLogin username/password/domain from .env, NO token — client_credentials & password grants both 400)
- `scratchpad/gen_artifact.py` → `dedupe_artifact.html` (reads families_sf.json)
- Normalizer (must stay identical in dedupe_families.py + sf_match.py): strip parenthetical acronyms `(…)` + cosmetic legal suffixes only; does NOT strip capital/ventures/fund/foundation (Bain Capital ≠ Bain & Company). Under-merge safe, over-merge not.

## JP Morgan concrete example (the messy case that proved the design)
- SF has 3 dup org accounts: `JPMorgan Chase (JPMC)` 0011U00000DnvwxQAB (2019, has contacts → master), `J.P Morgan` 0011U00001iYDU7QAO (2021), `JP Morgan Chase` 001Pa00001XfH6EIAV (2026-07-02 stray).
- DB has 3 families split by spelling: `jp morgan chase`, `jpmorgan chase`, `j p morgan` (~8 name-variants).
- Resolution: same Merge group on all 3 families → collapse to one; SF master = JPMC 2019.
