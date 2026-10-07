# PRO-102: call type required, calls dated by booking, each call counted once

Linear: https://linear.app/pursuit-org/issue/PRO-102 · Branch: `integration/jobs-dashboards` · Reviewer: Jac (after 10/16)

## What production says (read-only, 10/7)

- `bedrock.activity.call_kind` is live and accepts `discovery` | `general`. 2 of 176 hand-logged calls carry one.
- "Call date" in the ticket is `jobs_contact_membership.call_booked_at`: 16 of 16 contacts at Call Booked have one,
  8 of 138 converted do (24 of 154 ≈ the ticket's 23 of 153). Nothing stores when each *call* was booked.
- The calendar sync stores a meeting once even with several staff invited (no duplicates by subject + start since 9/1).
- A hand-logged call and a calendar meeting can be the same call: Devika logged the 9/18 Mastercard call and
  the meeting synced from Avni's calendar. It counts twice today.
- 41 of 176 hand-logged calls (and texts, LinkedIn, emails) sit at exactly midnight UTC: the form sends a bare
  date, the API stores it as UTC, and in New York that is 8pm the day before. The Mastercard call reads as 9/17,
  so a same-day match misses it.

## Decisions (Nina, 10/7)

- **Two call types, relabeled.** Stored values stay `discovery` | `general`; the picker shows
  "Discovery" and "Check-in / other". No CHECK change.
- **A booked date per call.** New nullable `activity.booked_at`. Calls are counted by the date booked,
  falling back to the date held (calendar meetings have no booked date). The Calls booked card can switch to held.

## Plan

- [x] Migration `2026-10-07-activity-booked-at.sql`: `booked_at timestamptz`. No index: calls are a few
      hundred rows found by type, and a build would scan the 2 GB table.
- [x] Migration `2026-10-07-activity-manual-dates-ny.sql` (separate, review before applying): hand-logged rows at
      exactly midnight UTC move to midnight New York on the same date (170 rows on 10/7).
- [x] API `POST /activity`: call type required for calls; `booked_at`; a bare date is a New York day;
      a held date may be in the future but not before the booking; held empty → the booked date. Logging a call
      against a contact at Call Booked or converted fills a missing Call Booked date.
- [x] API `PATCH /activity/{id}/call-kind` for calls and meetings (the re-tag).
- [x] Counting (`services/outreach_counting.py`): calls dated by booking (or held, on request); meetings carry a
      call type; a calendar meeting that someone also logged as a call (same New York day, a shared contact, or the
      call's opportunity account matching an attendee's company) is that call and counts once, credited to whoever
      logged it. SQL twin in `counted_once_ctes`; dictionary queries regenerated.
- [x] Outreach summary takes `call_date=booked|held`, returns `calls_discovery`; the card says what it counts.
- [x] Frontend: one `CallDetailsFields` (type, booked, held) in all three log forms; Save waits for a type;
      today is the local date, not UTC; re-tag chip on calls/meetings in the activity timeline and the Calls booked list;
      prospect logs refresh the Outreach numbers.
- [x] Tests: discovery calls counted once per call; booked vs held windows; required type; SQL twin shape.
- [x] Dictionary text for `calls` / `call_discovery` / `call_general` ("Check-in / other calls").

## Review

**Verified.** Backend `pytest tests/` all green (new: `tests/test_call_type.py`, 23 tests). Frontend
`tsc --noEmit` clean, `node --test tests/*.test.ts` 49/49 (new: `tests/callLog.test.ts`), `vite build` OK.
The new events SQL ran read-only on production for 9/14–9/27 (without `booked_at`, which isn't there yet):
it parses, and with the call dates read as their intended day it pairs exactly three meetings with logged
calls, all Devika's 9/18 calls (Mastercard, Gutter, Newmark). Not exercised: the forms in a browser; there is
no local database and sign-in needs Google OAuth.

**Order to apply.** `2026-10-07-activity-booked-at.sql` before deploying (the code probes for the column and
works without it, but booked dates are dropped until it exists). The date fix is separate: until it runs,
the 41 calls already stored at midnight UTC sit on the day before in New York and won't match their meetings.

**Behaviour changes worth knowing.**
- Calls booked, Discovery / Check-in rows, the Owner cut and the trend all date a call by its booking day now.
  A meeting counts on the day it was held (no booking date to read).
- A meeting that is also a logged call counts as a call for the person who logged it, so with one person
  selected a meeting on their calendar can drop out of their calls. Per-person numbers add up to the team's.
  The meeting stays as activity for the accounts it reached: a call logged on an opportunity has no contact,
  so without it the account would lose the touch (found in review).
- Held mode is carried into the card's records link and named in its filters, so the card, the list behind
  it and the definition agree on which day a call counts (found in review). The dictionary measure counts booked.
- "General Calls" is "Check-in / Other Calls" on screen and in the dictionary draft.

**Open.** Calls logged on an opportunity match a meeting only by the opportunity's `account_name` against an
attendee's `current_company`, the same string key PRO-98 uses; account merges (PRO-101) will tighten it.
