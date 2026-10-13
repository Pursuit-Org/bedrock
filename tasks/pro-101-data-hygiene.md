# PRO-101: activity counts everywhere, contacts linked to opportunities, history on every move, accounts picked from a list

Linear: https://linear.app/pursuit-org/issue/PRO-101 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16)

Data changes are scripts/migrations on the branch. Nothing touches production data until Jac runs them.

## What production says (read-only, 10/13)

- 57 open opportunities. Only 6 carry `sf_contact_ids`; 1 is pointed at by a membership's `opportunity_id`; 5 resolve to any contact.
- 139 converted contacts, 23 with `jobs_contact_membership.opportunity_id`.
- 49 of 57 open opportunities have no activity logged on them (notes excluded). Adding linked contacts' activity: 48.
  Adding contacts at the same account when none are linked: **15**.
- Queens Community House: the call is on the opportunity, but the contact (33140, linked by `membership.opportunity_id`,
  not `sf_contact_ids`) holds 37 synced emails and meetings, last 10/10. The opportunity page and `/opportunities` never read them.
- 42 won, 26 with no `closed_at`; 20 of those 26 have a `closed_won` history row to date them from.
- 26 opportunities and 353 of 1,241 memberships have no history row for the stage they sit in.
- Opportunity history starts 6/6 (table created 6/4, never backfilled).

## Decisions (Nina, 10/13)

- **Activity rule:** an opportunity's activity = logged on it, OR from its linked contacts; when it has no linked
  contacts, from contacts at its account (same name). An account's = its opportunities' + its contacts'.
  Notes and comments never count. (Same fallback the contacts list already uses for "linked deal".)
- **Scope:** ticket order. Parts 1, 2, 4, the picker and same-name block in 5, plus a link backfill script.
  Later: owner field (3, waits on D6), merges (5, Jac), stale Initial Outreach (6, Avni's review), picker cleanup (7), Jobs Home (8).

## Plan

### 1. Activity counts everywhere (D5)
- [x] One SQL builder for "an opportunity's contacts" and "an opportunity's / account's activity" (linked contacts:
      `membership.opportunity_id`, `pub:`/`airtable:`/SF refs in `sf_contact_ids`; else same-account contacts;
      participant contact or meeting attendee). External activity only (no notes).
- [x] Use it in: Overview / Jobs Home needs-attention + stalled, `/opportunities` list, opportunity detail feed
      (with the relevance fields), `/accounts` hub + detail (add opportunity-logged activity; the shown
      "Last activity" reads activity, not record edits), `/account-activity`.
- [ ] ~~`/outreach/accounts` last activity stops counting comments and tasks.~~ Not done: no screen reads that
      endpoint (`useOutreachAccounts` has no caller); its "last activity" is a notes-and-tasks worklist order.
- [x] The jobs / not-jobs override works on every activity type, not just email and meeting.
- [x] Dictionary reference SQL (`stalled_*`) regenerated to match.

### 2. Contacts linked to opportunities (D15)
- [x] API: moving a contact to Converted requires one or more opportunity ids (existing or just created); the link is
      written both ways (`membership.opportunity_id` + `pub:` ref in `sf_contact_ids`). Bulk convert is refused.
- [x] UI: every Converted move opens a dialog: pick the account's opportunities, or create one (contact pre-picked).
- [x] Creating an opportunity requires picking its contacts (all three forms).
- [x] Fix `findRef` so removing an airtable/SF-ref'd contact from an opportunity works; `get_contact` reads `pub:` refs.
- [x] "Deal" → "Opportunity" in every on-screen string (Jobs screens, toasts, CSV header; "Deal type" reads
      "Opportunity type"). Airtable mirror and fundraising screens untouched; code identifiers unchanged.
- [x] Script: link converted contacts with no opportunity to the single open/won opportunity at their account;
      ambiguous ones go to a review CSV.

### 4. Stage history on every move
- [x] `log_activity`'s assigned → initial_outreach move writes a history row.
- [x] Opportunity create at a closed stage stamps `closed_at`; lost → won restamps it.
- [x] Migration (review first): won/lost with no `closed_at` take their latest move into that stage from history;
      the rest are listed, not guessed.
- [x] Migration (review first): each opportunity and membership with no row for its current stage gets one, dated
      only by evidence (closed_at; the stage's own stamp; for Initial Outreach the first jobs activity),
      `changed_by='backfill:PRO-101'`; Initial Outreach only by activity on or after assignment. Not `updated_at`:
      252 memberships were last touched on 7/8, the day memberships were created, so that date would be invented.

### 5. Accounts picked from a list (D9)
- [x] `POST /accounts` refuses a name that normalizes to an existing account (409 with the existing one), using the
      same normalizer as `/accounts/resolve`; the dialog then uses the existing one. `PATCH /accounts` is left: it
      edits an account the hub already lists (owner, status), keyed by that account's own name.
- [x] The account pickers' list includes `jobs_account` rows (a new account with no contacts yet shows up).
- [x] Contact detail, prospect panel, candidate review and the New Opportunity form pick the account with `CompanyPicker`.

## Review

**Verified.** Backend `pytest tests/` all green (new: `test_activity_rollup.py` 17, `test_contact_opportunity_links.py`
14, `test_account_picker.py` 5; fixtures updated in five existing files for the new query text and required contacts).
Frontend `tsc --noEmit` clean, `node --test tests/*.test.ts` 49/49, `vite build` OK. The rollup SQL, the link
migration's selection and the backfill's selection ran read-only on production on 10/13 (counts above and below).
Not exercised: the screens in a browser (no local database; sign-in needs Google OAuth).

**Order to apply** (after deploy; both are transactions with counts, read their headers first):
1. `migrations/2026-10-13-contact-opportunity-links.sql`: links 34 converted contacts (9 already on one
   opportunity's list by any ref, 25 with exactly one live opportunity at their account) and puts every linked
   contact on its opportunity's list. 82 are left for a person: 2 with two candidates, 80 with no opportunity at an
   account of the same name (often a duplicate spelling; the merges in part 5 will help). Creates
   `bedrock.data_fix_audit`, where both files record what they change, for review and undo.
2. `migrations/2026-10-13-stage-history-backfill.sql`: 20 won get a close date; closed ones get a history row; 24
   contacts get a row dated by evidence.
Both leave `updated_at` alone (the opportunity trigger is switched off for their one UPDATE, inside the transaction),
so lists sorted by it don't reshuffle.

**Behaviour changes worth knowing.**
- Open opportunities with no activity: 49 of 57 by what's logged on them, **17** under the new rule. An opportunity
  with linked contacts reads only those contacts, not everyone at its account (it used to read everyone).
- Queens Community House now finds its contact (linked from the contact's side) and shows 8 activities, last on
  10/2 (2 calls on it, 6 jobs emails with the contact). The contact's other 31 rows don't count: 16 the classifier
  marked not-jobs (it reads the contact as a Pursuit builder) and 15 are emails with no Pursuit reply in the
  thread, which the classifier never looks at.
- Notes no longer count on the opportunities list, its suggested priority, the account hub or "Last activity".
- An opportunity's or account's feed lists every row reached through its contacts, each with its Jobs / Not jobs tag,
  so owners can retag (Kwame). For a big account with no linked contacts that includes other teams' mail with
  anyone there, tagged Not jobs; linking contacts narrows it.
- A not-jobs tag now removes a logged call, text or LinkedIn message from every count, outreach included.
- The account hub and account page "Last activity" show activity; they showed the last record edit.
- Converting a contact asks for its opportunity everywhere (Jobs Home, Contacts, contact page and drawer); the bulk
  bar no longer offers Converted. Every new-opportunity form needs at least one contact.
- A new account that is another spelling of an existing one is refused and the existing one is used. Spellings the
  normalizer can't see ("jpmorgan" vs "JPMorgan Chase") still need the merges.

**Left after the scripts (10/13 data):** 329 of 1,241 contacts (27%) and 9 open opportunities have no history row for
their stage, and 10 closed opportunities no close date. 263 Initial Outreach contacts: 73 had outreach before their
`assigned_at`, which for most is 7/8, the day memberships were created from the old contact stages (dating them by
that outreach would put Initial Outreach before Assigned), and 190 have no outreach at all (the 6/23 mass email is
part of this; part 6's review may retire many). 63 are Revisit from the 8/5 On Hold migration, 3 Not a fit. The
ticket's "fewer than 5% missing a stage date" needs a decision: date the 73 by their outreach, accept "before
tracking began" for the rest, or have owners date them.

**Open.**
- Inbound-only email threads are never classified, so they never count (about 40% of synced contact email each week).
  Whether a contact writing in counts as activity is a definition question for D5.
- Query cost: the rollup ran inside the read-only tool's timeout on production for every open opportunity and for
  all 1,097 accounts, but was not timed. The meeting arm expands every calendar row's attendees (21k meetings, 125k
  attendees); run EXPLAIN ANALYZE on the hub and the opportunity page after deploy.
- The contacts summary's "accounts engaged" still uses the older rule (notes count, no meetings); not on this
  ticket's screens.
- Parts 3 (owner field, waits on D6), 5 merges (Jac), 6 (Avni's stale review), 7 and 8 are not in this pass.
