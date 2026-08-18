# Bulk-tagging a batch of contacts (runbook)

How the Operation 35 — LT_Nick batch was done on 2026-08-18, written down so the
next batch is a copy of a working thing rather than a rediscovery.
Reference implementation: `tag_operation_35_lt_nick.py`.

The job: someone hands over a list of names (usually name + title + company,
pasted from a sheet), one tag, and "check Jobs prospect if it isn't already".
Doing it by hand is the only reason a script exists.

---

## What the fields actually are

| The ask | The column |
|---|---|
| "the tag" | a **slug** in `bedrock.contact_tag_catalog`; `public.contacts.tags` (text[]) stores slugs, the catalog's `label` is display-only |
| "Jobs prospect" checkbox | `public.contacts.is_jobs_contact` (boolean) |

**Curated vs system tags.** Only slugs present in the catalog are curated. The
`email_review` marker is deliberately *not* in the catalog — it flags ~2.6k
auto-created contacts as a triage queue. It lives in the same array and must
survive any tag write.

**A brand-new tag needs a migration.** No endpoint inserts catalog rows and the
`*_dev` roles hold SELECT only on that table, so a slug that does not exist yet
can only be added via `db/migrations/` — see `2026-08-07-operation-35-tags.sql`.
Check the catalog first; if the tag is already there, no migration is needed and
this is pure data work.

```sql
SELECT slug, label, sort_order, active FROM bedrock.contact_tag_catalog ORDER BY sort_order;
```

---

## The one thing that makes this worth scripting

`PATCH /api/jobs/contacts/{id}` — what the Tags picker calls — **replaces** the
curated tag set. Tagging by hand therefore means re-sending every existing tag on
every contact, and dropping one is silent. The script instead writes:

```sql
UPDATE public.contacts
   SET tags = array_append(coalesce(tags, '{}'::text[]), $2), updated_at = now()
 WHERE contact_id = ANY($1::int[])
   AND NOT ($2 = ANY(coalesce(tags, '{}'::text[])));
```

Purely additive, and the `WHERE` makes it idempotent. The prospect flag is the
same shape and only ever goes false -> true:

```sql
UPDATE public.contacts SET is_jobs_contact = true, updated_at = now()
 WHERE contact_id = ANY($1::int[]) AND is_jobs_contact IS DISTINCT FROM true;
```

Nothing is ever unset. Contacts already carrying the tag — including ones outside
the batch — are untouched.

---

## Resolving names to ids

Match on a normalised name, then **disambiguate on the supplied title/company** —
never on the name alone. The normalisation that worked (strips a parenthetical
nickname, folds punctuation, collapses whitespace, case-insensitive):

```sql
btrim(regexp_replace(lower(regexp_replace(regexp_replace(
  coalesce(nullif(btrim(full_name),''), btrim(coalesce(first_name,'')||' '||coalesce(last_name,''))),
  '\(.*?\)', '', 'g'), '[^a-zA-Z ]', ' ', 'g')), '\s+', ' ', 'g'))
```

Expect roughly: most names hit exactly one row; a handful hit several (a real
record plus an empty `airtable-jobs`/`email_candidate` stub, or a genuine
namesake); a few hit nothing.

- **Multiple matches** — pick on title, then company. Prefer the row with the
  title/email/tags over the empty stub. Surface every pick for confirmation.
- **No match** — search surname alone, the company, and spelling variants before
  concluding it is absent (`Ben Sun` was stored as `Benjamin Sun`).
- **Cross-check.** Once resolved, compare every id's stored `current_company`
  against the company supplied with the batch. Last time 57 of 60 matched exactly
  and the 3 that differed were spelling variants of the same employer — that is
  what "the ids are right" looks like.

**Freeze the ids in the script.** Do not re-match at runtime; a frozen list plus
a name re-check that aborts on drift is auditable, a live match is not.

**MCP gotcha:** `pg_query` rejects a query containing `;` anywhere, including
inside a string literal — a `string_agg` delimiter of `' ;; '` fails with "Only a
single SQL statement is allowed". Use something else.

---

## Creating contacts that don't exist

Match `POST /api/jobs/contacts`: `source='manual'`, `airtable_id='manual-<uuid8>'`,
`contact_stage='lead'`, `full_name` split on the first space. Key the insert on
name + company so a re-run reuses the row rather than adding a second, and do the
creates in the **same transaction** as the tag/flag pass.

Use the company spelling already in the table when it is unambiguously the same
employer (`WHOOP`, not `Whoop`) — accounts key on `lower(trim(current_company))`,
so a variant spelling silently creates a second one-contact account.

---

## Environment (Kwame's Mac)

- Repo `/Users/kwameassoku/bedrock` — remote resolves to `Pursuit-Assets/bedrock`
  (org was renamed from `Pursuit-Org`; GitHub redirects, same repo).
- **venv:** `financial_forecasting/.venv` — has `asyncpg` and `python-dotenv`.
  System python3.13 does **not**; `ModuleNotFoundError: asyncpg` means the venv
  was not activated.
- Run from the `financial_forecasting/` directory.
- **Give `cd` its own line.** `cd x && cmd` followed by more lines on separate
  lines runs those from the original directory.

```bash
cd /Users/kwameassoku/bedrock
git fetch origin
git checkout <branch>
cd financial_forecasting
source .venv/bin/activate
python3 scripts/<script>.py            # dry run
python3 scripts/<script>.py --apply
```

## Which database

`.env` `DATABASE_URL` points at **`segundo-db` as `jobs_dev`** — that is
production. DEV_SETUP_GUIDE says local dev *should* point at shared staging, so
do not assume; the script prints its target first in both modes:

```
target: segundo-db on 34.57.101.141/32 as jobs_dev  (from .env DATABASE_URL)
```

Read that line before applying. There is a logged incident (2026-04-17) from a
dev session silently writing to the wrong DB. `--database-url` overrides it
without editing `.env`.

`jobs_dev` has INSERT/SELECT/UPDATE on `public.contacts` and USAGE on
`contacts_contact_id_seq` (needed for creates) — verified 2026-08-18.

---

## Verify from SQL, not from the script's own output

```sql
-- every batch id tagged and flagged, and nothing outside the batch disturbed
SELECT count(*) AS batch_rows,
       count(*) FILTER (WHERE '<slug>' = ANY(coalesce(tags,'{}'))) AS tagged,
       count(*) FILTER (WHERE is_jobs_contact)                    AS prospect
FROM public.contacts WHERE contact_id IN (...);

SELECT count(*) FROM public.contacts WHERE '<slug>' = ANY(coalesce(tags,'{}'));
```

Then spot-check the contacts that had the most tags to lose: each should show its
old tags **plus** the new slug, nothing missing.

---

## Tell them what it moves

Adding a curated tag is not inert:

1. **My Network → Pursuit scope** admits any contact with a curated tag other
   than `alumni_*`/`influence` — the batch starts appearing there.
2. The nightly **jobs-prospect recuration** keeps any contact with a curated tag,
   so they stop being sweepable.
3. New prospect flags land in **Total Leads** and the funnel counts, in the
   not-yet-assigned band (the script sets no pipeline stage).

---

## 2026-08-18 result

64 names → 60 resolved, 4 created (`55194`–`55197`), 61 tagged, 53 flagged.
`operation_35_lt_nick` went 31 → 92 contacts; the 28 pre-existing tagged contacts
outside the batch were untouched.
