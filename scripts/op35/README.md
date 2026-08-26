# Operation 35 — Pursuit · tag the P1 + P2 accounts

Applies the P1 (commit partners) and P2 (hiring history + major giving/PBD) rows from
`product/analysis/operation-35-pursuit-additions.csv` to the live database:

1. adds `operation_35_pursuit` to the most senior contact at each account
2. sets `is_jobs_contact = true` on those contacts
3. creates the missing `bedrock.jobs_account` rows
4. creates `bedrock.jobs_contact_membership` rows at stage `assigned`

**30 contacts across 30 accounts.** P3 is deliberately excluded.

## Run it

```bash
cd ~/bedrock                      # run from the repo root — the scripts use \i with repo-relative paths
export DATABASE_URL="$(gcloud secrets versions access latest --secret=jobs-dev-database-url --project=pursuit-ops)"

# 1. read what it will do — writes nothing, rolls back at the end
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/op35/01-preview.sql

# 2. apply, once you're happy with the preview
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v owner=kwame@pursuit.org -f scripts/op35/02-apply.sql
```

`-v owner=` sets `owner_email` on the new jobs accounts and pipeline memberships. Change it
if these should sit with Avni or Damon instead.

To undo: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/op35/03-rollback.sql` — it stops
before committing so you can inspect first, then type `COMMIT;` or `ROLLBACK;` yourself.

### No psql? Use `run.py`

`run.py` executes the same three `.sql` files over `asyncpg` (already in
`financial_forecasting/requirements.txt`), translating the handful of psql-only constructs
they use. The `.sql` files remain the source of truth — there is no second copy of the logic.

```bash
cd ~/bedrock
export DATABASE_URL="$(gcloud secrets versions access latest --secret=jobs-dev-database-url --project=pursuit-ops)"

python3 scripts/op35/run.py preview
python3 scripts/op35/run.py apply --owner kwame@pursuit.org   # prompts for confirmation
python3 scripts/op35/run.py rollback
```

`preview` and `rollback` always roll back. `apply` commits only if every statement succeeds
and the verification block passes; any error rolls the whole transaction back.
If asyncpg is missing: `pip3 install asyncpg==0.30.0`.

## Expected preview output

Validated read-only against the live database on 2026-08-26:

| | |
|---|---|
| targets | 30 |
| guard failures | **0** |
| tags to add | 30 |
| `is_jobs_contact` flags to set | 18 |
| `jobs_account` rows to create | 12 |
| pipeline memberships to create | 26 |
| existing memberships preserved | 4 |
| `operation_35_pursuit` contacts | **89 → 119** |

If your preview disagrees with these, the data has moved since — stop and re-check
rather than applying.

## Safety properties

- **Purely additive.** The tag update is `tags || 'operation_35_pursuit'`, guarded by a
  `NOT (... = ANY(tags))`. No existing tag is removed, rewritten, or reordered.
- **Existing state is never overwritten.** `jobs_account` inserts are `ON CONFLICT DO NOTHING`;
  `jobs_contact_membership` inserts are `ON CONFLICT (contact_id) DO NOTHING`, so the four
  contacts already in the pipeline keep their current stage (Ballistic Ventures → `revisit`;
  Cedar, iCapital, SeatGeek → `assigned`).
- **Idempotent.** Re-running changes nothing.
- **Guarded.** Aborts before writing if any `contact_id` no longer resolves to the name it was
  resolved to, and aborts after writing if any target didn't land in the expected state.
- **No DDL** beyond an `ON COMMIT DROP` temp table. Nothing touches Salesforce or
  `public.staff_contact_relationships`.
- One transaction — it all lands or none of it does.

## Resolve-first notes

Every contact was resolved by name + `current_company` against `public.contacts`. Four names were
ambiguous and are pinned by `contact_id` in `_targets.sql`, with the reason in a comment:

| Account | Chosen | Rejected |
|---|---|---|
| BlackRock | `12409` Shirin Chen, VP, BlackRock | `46855` Shirin Chen, **Pursuit staff** — different person |
| Mizuho | `34923` John Buchanan, CIO Mizuho Americas (has email) | `46313` duplicate of the same person |
| Charter Communications | `31359` Rhonda Crichlow, SVP Community Impact | `49525` "spectrum", no title — duplicate |
| Lyft | `14902` CJ Macklin, Director, Lyft | `37460` CJ Macklin, copywriter at Berlin Rosen |

The 14 new `jobs_account` keys were checked against all 277 existing rows on both `account_key`
and `display_name` — no near-duplicates. Keys follow the existing lowercase convention
(`oscar`, `meta (formerly facebook)`, `cbre`).

The duplicate contact pairs above are worth merging separately — this pass leaves them alone.

## Two accounts are blocked, not skipped

**Barclays** (4 hires) and **T-Mobile** (4 hires) are in P2 but have **no contact in
`public.contacts` at all**, so there is nobody to tag. Creating one would break the
resolve-first rule, so they are excluded here and need sourcing first. Once a contact exists,
add two rows to `_targets.sql` and re-run — the script is idempotent.

Also thin, and worth a look before you lean on them:

- **Fidelity** → Amy Wick is a *retail branch* VP. Weak anchor for a $1M donor on the PBD list.
- **BlackRock** → the most senior contact for a $2.27M donor is a VP.
- **Meta** → an Engineering Manager is the most senior contact on file.
