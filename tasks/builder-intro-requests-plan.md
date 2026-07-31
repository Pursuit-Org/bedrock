# Builder intro requests reach Bedrock "without associated Builders"

Source: Slack thread 2026-07-30 (Joanna, Avni, Jac) — screenshot of an intro
request card reading `from — (builder) · 1mo`.

Status: **plan for review — nothing built yet.**

---

## Root cause (confirmed against prod)

`public.users` has **row-level security enabled**. It is the only table in this
flow that does:

| table | RLS |
|---|---|
| `public.users` | **true** |
| `public.intro_requests` | false |
| `public.contacts` | false |
| `bedrock.intro_request` | false |
| `bedrock.staff_user_id_map` | false |

The only two policies on `public.users` are scoped to roles `uft_readonly` and
`ceo_dev`. The app role, **`bedrock_user`**, holds `SELECT` but has **no
policy** — so RLS default-denies and it reads **zero rows**.

`financial_forecasting/routes/jobs_intro.py:142` joins that table directly:

```sql
trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS builder_name,
u.email AS builder_email
FROM public.intro_requests ir
LEFT JOIN public.users u ON u.user_id = ir.builder_id   -- ← returns nothing under RLS
```

Because it is a **LEFT** join it fails **silently** instead of erroring, and
`trim(coalesce(NULL,'') || ' ' || coalesce(NULL,''))` yields an **empty string,
not NULL**. So the payload degrades to `""`, and `JobsHome.tsx:949` renders
`requested_by_name || requested_by || "—"` → **`—`**.

The contact name still renders because `public.contacts` has no RLS (and
`contact_name` is denormalised onto `intro_requests` anyway); connector names
render because they come from `bedrock.staff_user_id_map`. Only the builder
identity is lost — exactly the reported symptom.

**The data is fine.** Every pending row resolves correctly when queried as a role
that bypasses RLS (e.g. `intro_request_id` 15 → builder 428 → *Adedoyin Ahoton*,
`adedoyin.ahoton@pursuit.org`). Nothing needs backfilling.

### The fix already exists in this repo

`bedrock.builder_by_id(uid int)` is `SECURITY DEFINER STABLE`, returns
`(user_id, full_name, email, cohort)`, and is already granted `EXECUTE` to
`bedrock_user`. `routes/jobs.py:1395` already uses the correct pattern:

```sql
LEFT JOIN LATERAL bedrock.builder_by_id(er.user_id) b ON true
```

`jobs_intro.py` is the one place that skipped it. **No new migration required**
for this part.

### Same latent trap elsewhere (defended, but worth noting)

`jobs.py:713` and `jobs.py:743` also `LEFT JOIN public.users`, but wrap it in
`COALESCE(NULLIF(trim(...),''), 'Builder #'||er.user_id)`, so they degrade to
`Builder #428` rather than a bare dash. `sputnik.py:109` selects from
`public.users` inside a `try/except` and falls back to `User #N`. Both are
cosmetically wrong (never showing a real name) but not broken. Folding them onto
`builder_by_id` is cheap and in scope for step 5.

---

## What Sputnik captures that Bedrock never selects

This is Avni's *"this field is captured in Sputnik so just need to make sure it
is getting surfaced."* Every one of the 24 rows has all three populated (they are
`NOT NULL` columns), and the Bedrock query selects **none** of them:

| column | example |
|---|---|
| `builder_preparation` | 88–1007 chars of the builder's prep notes |
| `demo_url` | `https://mylabexpert.lovable.app/`, Loom links, GitHub repos |
| `readiness_checks` | `{demo_working, researched_company, available_this_week, can_articulate_value}` |

So a staff member is asked to make an intro with no idea who the builder is, what
they built, or whether they are ready. That — more than the missing name — is the
substance of "without associated Builders".

---

## Vocabulary drift between the two tables

`public.intro_requests.specific_ask` CHECK allows:
`job_referral, informational_interview, demo_feedback, industry_advice,
introductory_call, other`

`ASK_LABELS` in `jobs_intro.py:33` covers only `hiring_intro, industry_advice,
job_referral`; the frontend map adds `mock_interview`. So **four of the six real
Sputnik values have no label** — live rows use `introductory_call` (3),
`informational_interview` (5) and `other` (1). The frontend falls back to
`a.replace(/_/g," ")` → lowercase *"introductory call"*; the Slack payload falls
back to the raw `introductory_call` with the underscore intact.

**Status mapping bug.** `BUILDER_STATUS_MAP` (`jobs_intro.py:38`) maps *both*
`accepted` **and** `completed` → `approved`, collapsing "I'll do it" into "I did
it". `public.intro_requests`' CHECK constraint allows `completed` natively, so
this is a self-inflicted loss. The UI compounds it: `JobsHome.tsx:968` gates
"Mark intro made" behind `r.source === "staff"`, so a builder ask can never be
completed from Bedrock at all.

---

## Notifications: the two Slack bots

`enqueue_notification` is called **only** from Bedrock's `POST
/api/jobs/intro-requests` (staff→staff). Rows created in Sputnik never produce a
Bedrock bell item or Slack DM — they only hit Sputnik's own "builder intro
request" channel. That is Avni's *"are these also going to the Bedrock slackbot
(vs. the builder intro request slack channel)"*, and Jac's *"yes we should merge
the two."*

Infrastructure for this already exists and is the established pattern:

- `bedrock.notification_watermark (source PK, last_seen)` — already used by
  `sf_task` and `sf_opp_owner_history`
- `services/sf_notification_poller.py` — watermark poller; insert + watermark
  bump in one transaction, errors swallowed so the watermark only advances on
  success (missed events replay on the next good poll)
- wired in-process at startup via `main.py:256`

Adding a `sputnik_intro_request` source is a direct extension. The existing
`intro_request` notification type can be reused with a `requester_kind` field in
the payload, so **no CHECK-constraint migration is needed**.

---

## Plan

### 1. Fix the builder identity (P0 — the actual reported bug)
- [ ] `jobs_intro.py`: replace the `LEFT JOIN public.users` with
      `LEFT JOIN LATERAL bedrock.builder_by_id(ir.builder_id) b ON true`
- [ ] Return `builder_id` in the payload so the card can link to the builder
- [ ] Fallback chain that can never render a bare dash:
      `full_name → email → 'Builder #<id>'`
- [ ] Add `requested_by_name` to `_staff_row()` too — staff asks currently show a
      raw email because the key is simply absent

### 2. Surface what Sputnik captured
- [ ] Select `builder_preparation`, `demo_url`, `readiness_checks`, `cohort`
- [ ] Extend the `IntroRequest` TS interface
- [ ] Card: builder name links to their profile; `demo_url` as a labelled link;
      prep notes collapsed behind a disclosure; readiness as a compact check row

### 3. Colour-code builder vs jobs-team (Avni's ask)
- [ ] Dedicated source `Tag` — `sky` = "Builder", `accent` = "Jobs team" —
      distinct from the ask-type tag, which currently smuggles the source signal
      into its `variant` (semantically wrong and easy to miss)
- [ ] Left border accent on the card so the split is visible while scanning
- [ ] Keep the `(builder)` text as the non-colour fallback (accessibility)

### 4. Merge the notification paths (Avni + Jac)
- [ ] `services/intro_notification_poller.py` — watermark source
      `sputnik_intro_request`, enqueue `intro_request` to the connector staff for
      new `public.intro_requests` rows
- [ ] Payload carries `requester_kind: "builder"`, builder name, demo URL
- [ ] `_format_slack_message`: distinguish builder vs staff asks in the DM
- [ ] Wire into `main.py` startup alongside the SF poller
- [ ] Seed the watermark at deploy time so the first poll doesn't DM the team
      about all 17 pending backlog rows

### 5. Vocabulary + status correctness
- [ ] Single shared ask-label map covering all six Sputnik values, backend and
      frontend in sync
- [ ] `BUILDER_STATUS_MAP`: `completed → completed` (allowed by the CHECK
      constraint), so accept and done stop collapsing
- [ ] Drop the `source === "staff"` gate on "Mark intro made"
- [ ] Fold `jobs.py:713/743` and `sputnik.py:109` onto `builder_by_id`

### 6. Tests
- [ ] Regression test asserting the builder name resolves — the current bug would
      have been caught by one assertion that `requested_by_name` is non-empty for
      a builder-sourced row
- [ ] A guard test that fails if any query in `routes/` joins `public.users`
      directly, so this trap cannot be reintroduced
- [ ] Poller test: watermark advances once, no duplicate notification

---

## What "Bedrock DM" means (it is just a Slack DM)

There is no Bedrock-specific message surface. `enqueue_notification()` produces
two things per event:

1. a row in `bedrock.notification` → the bell in the Bedrock web app
   (`NotificationBell.tsx`)
2. a **real Slack DM from the Bedrock Slack app** — `_dispatch_slack()` →
   `_resolve_slack_id()` (`users.lookupByEmail`, cached indefinitely in
   `bedrock.slack_user_cache`) → `chat_postMessage(channel=<slack_user_id>)`

This is live in prod today for staff→staff asks.

### Builders are not reachable from this Slack workspace

Checked directly against the workspace the Bedrock bot lives in. Four builders,
searched by email *and* by display name:

| looked up | result |
|---|---|
| `adedoyin.ahoton@pursuit.org` | no match |
| `francis.rutledge@pursuit.org` | no match |
| `michelle.brooks@pursuit.org` | no match |
| `Adedoyin Ahoton`, `Jimmy Ong` (by name) | no match |
| `avni@pursuit.org` (control) | **U0AKQFH36CW** — resolves |

The control proves lookup works, so builders genuinely are not in this
workspace. `bedrock.slack_user_cache` corroborates: 17 cached users, **0 with
`role='builder'`**.

Consequence: a DM aimed at a builder would silently no-op — `_resolve_slack_id`
returns `None` and the notification is marked `slack_status='skipped'`,
`note='no_slack_id'`. Nothing breaks, but the builder never hears anything.

**This does not block the fix.** The person who must act on an intro request is
the *connector staff member*, and they are reachable today. Notifying builders
back would need either Slack Connect / a cross-workspace app, or leaving
builder-facing comms to Sputnik. Deferred, not required.

---

## Sputnik is a separate app — what we can and cannot touch

Sputnik's code is **not in this repo**. All that exists here is read-only access
to its tables on the shared segundo-db (`public.intro_requests`,
`public.outreach`) through `routes/sputnik.py`. The builder-facing form, and
whatever posts into the "builder intro request" Slack channel Avni mentioned,
live in Sputnik's codebase where I cannot see or change them.

So the earlier "does Sputnik get switched off" question was mis-scoped as a
blocker. The concrete risk is narrow: if Bedrock starts DMing the connector staff
and that Sputnik channel keeps posting the same ask, staff hear it twice. The
Bedrock side is purely additive and safe either way — this is a coordination note
for whoever owns Sputnik, not a decision needed before building.

---

## Resolved

- **Backlog — do not notify.** Seed the watermark at deploy time. The 17 pending
  asks (oldest 2026-03) stay visible on the Jobs page and get worked from there.
  No retroactive DMs.
- **`demo_feedback` / `other` are not columns.** They are two of six allowed
  *values* of the `specific_ask` column (`varchar(100)`) on
  `public.intro_requests`, enforced by its CHECK constraint. Usage across all 24
  rows:

  | `specific_ask` | rows | last used |
  |---|---|---|
  | `industry_advice` | 9 | 2026-06-24 |
  | `informational_interview` | 7 | 2026-06-15 |
  | `job_referral` | 4 | 2026-07-16 |
  | `introductory_call` | 3 | 2026-07-27 |
  | `other` | 1 | 2026-07-13 |
  | `demo_feedback` | **0 — never used** | — |

  `demo_feedback` is legal but has never been selected. Labelling all six anyway
  is trivial and prevents the raw-underscore fallback.

- **The two tables have different vocabularies.** Bedrock's own
  `bedrock.intro_request` uses `hiring_intro` / `industry_advice` /
  `job_referral` (plus `mock_interview` in the frontend map). `hiring_intro` and
  `mock_interview` are **not** valid Sputnik values. The shared label map must
  cover the union of eight, with `industry_advice` and `job_referral` common to
  both.
