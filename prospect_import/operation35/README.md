# Operation 35 — unassigned contacts, enriched

`operation35_enriched.csv` — the 240 Operation 35 contacts in bedrock that carry an
`operation_35_*` tag and have **no jobs stage** (`contacts.contact_stage IS NULL`),
enriched with headcount, headcount range, segment, Pursuit hiring history, HQ and
tri-state presence.

Pulled 2026-08-26.

## Columns

| column | meaning |
|---|---|
| `contact_id`, `name`, `title`, `company` | from `public.contacts` |
| `op35_tag` | the contact's full tag array (which Operation 35 list it came from) |
| `owner` | `contacts.owner_email` |
| `headcount` | exact employee count where one was found (81 of 240) |
| `headcount_source` | where that exact number came from |
| `headcount_range` | `Under 50` / `50-300` / `300-1,000` / `1,000+` |
| `range_source` | which source set the range |
| `confidence` | High / Medium / Low — see below |
| `segment` | `Enterprise` (over 300) or `SME` (under 300) |
| `hired_from_pursuit` | Yes/No — has this company ever hired a Pursuit builder |
| `n_hired_from_pursuit` | builders hired |
| `hq_location`, `hq_source` | headquarters |
| `tri_state`, `tri_state_source` | Yes / No / Remote / Unknown |
| `notes` | caveats on individual rows |

## The headcount range vocabulary

`Under 50` / `50-300` / `300-1,000` / `1,000+`, taken from the *Jobs priority list -
July 2026* workbook. That workbook derives the band from the **exact** headcount, not
from the CRM band, and this was reproduced here:

    < 50 -> Under 50    50-299 -> 50-300    300-999 -> 300-1,000    >= 1000 -> 1,000+

Verified against the workbook's own `headcount_band` / `headcount_exact` pairs on 18
rows. The CRM band is demonstrably unreliable where the two disagree — codepath is
784 people but banded `51-200` in the CRM, Bottom Line is 2,804 but banded `1-10` —
so an exact count always wins over a band.

`segment` follows from the range: `Under 50` + `50-300` are SME, `300-1,000` + `1,000+`
are Enterprise.

## Sources, in precedence order

1. **Web research** — only for companies the two internal sources could not settle
   (`web_overrides.json` records the figure and its provenance per company).
2. **Exact headcount from the workbook** — the ranked-accounts, company-research and
   PE/VC-portfolio tabs.
3. **Banded headcount from the workbook** — the priority-list and scored-account tabs.
4. **`public.companies.size_bucket`** in bedrock, mapped to the band above.

Hiring history is joined from *Pursuit_Builder_Hires_by_Company* (Salesforce Fellow
Affiliation records, pulled 2026-08-24; 671 employers, 1,145 hires). One hire = one
builder at one company. Counts were checked against the source sheet: Citi 51,
Uber 35, Spotify 18, Peloton 15.

## Confidence

* **High (131)** — an exact headcount, or a band stated directly in the workbook.
* **Medium (96)** — bedrock `size_bucket`, or a web figure with some spread between sources.
* **Low (13)** — an estimate, or a figure close enough to a band boundary that it could
  fall either side. These are the rows to check before acting on the segment call:
  Halfdays (~30-51, straddles 50), Vetcove (121-338, straddles 300), Codecademy
  (306-507), Techstars (figures include network entities), Twitter/X, Circle,
  Columbia Investment Management Company, Alabama School District 210, Flint,
  SongShift, ScopeXR.

## Known caveats

* **`201-1000` in the CRM straddles the 300 line.** 17 contacts sat in that bucket with
  no other source; each was resolved individually by web lookup rather than assigned to
  a side. Four flipped the segment call away from what the CRM bucket implied — Propel
  (~124) and United Way of NYC (~136) are SMEs, iCapital (~2,300) is well past
  Enterprise, and Red Canary (~400) sits above the line.
* **"Circle" is circle.so**, the community platform (Sid Yadav / Andrew Guttormsen,
  ~11-50) — *not* Circle Internet Financial, the USDC issuer. Easy to enrich wrongly.
* **Three contacts had no company** in bedrock and were resolved from their email
  domain or workbook notes: Soo Kim -> Standard General, Andrea Phillips -> Maycomb
  Capital, Aaron Rudenstine -> Tripadvisor. See `company_fix.json`.
* **Jukay Hsu (Pursuit)** carries 38 "hires" — builders hired onto Pursuit staff, not a
  hiring-partner signal. Excluded from partner analysis.
* **`tri_state` is Unknown for 49 contacts**, mostly where no HQ is on file. Where the
  workbook states tri-state presence explicitly that judgment was kept even when it
  disagrees with HQ (Amazon is HQ'd in Seattle but flagged tri-state for its NYC
  offices); otherwise it is derived from HQ and `tri_state_source` says so.
* **Rafael Richardson's** title reads "School Superintendent (2013-2022)" — the
  affiliation is stale regardless of the headcount.

## Reproducing

`parse_tabs.py` splits the workbook export into per-tab CSVs; `enrich.py` builds the
company attribute and hires indexes; `build_final.py` joins and writes the CSV. The two
Google Sheets are read via the Drive export endpoint and the Drive MCP; bedrock is read
read-only over `pg_query`. Nothing writes back to bedrock.
