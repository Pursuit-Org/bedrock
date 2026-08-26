# Operation 35 — Pursuit set: coverage audit

**Date:** 2026-08-26 · **Sources:** Salesforce (Account, Contact) + Bedrock Postgres (`public.contacts`, `bedrock.activity`, `bedrock.jobs_*`, `bedrock.priority_account_floor`)

## What the current set looks like

`operation_35_pursuit` is applied to **89 contacts across ~57 companies**. Sibling tags for
comparison: `operation_35_lt_nick` (94), `operation_35_staff` (76), `operation_35_lt` (24),
`operation_35_other` (0 in use).

Coverage was resolved two ways — Salesforce account IDs linked through `bedrock.sf_contact_link`
and `bedrock.sf_account_company_map` (64 accounts), plus normalised company-name matching against
the tagged contacts' `current_company` — then unioned.

## Signals used to find gaps

| Signal | Field / table | Coverage |
|---|---|---|
| Has hired builders | `Account.Number_of_Pursuit_Fellows_Hired_DLRS__c` | 686 accounts with ≥1 hire |
| Depth of relationship | `bedrock.activity` count, distinct active months, last 18 months | 1,651 accounts with logged activity |
| Serious PBD relationship | `Account.X2026_PBD_Portfolio_Distribution__c` | 166 accounts (80 corporate/gov/nonprofit) |
| Strategic designation | `Account.Account_Tier__c` | 9 corporate Strategic / Target Strategic |
| Giving relationship | `Account.npo02__TotalOppAmount__c` | lifetime gift total |
| Live hiring pipeline | `bedrock.jobs_opportunity` / `jobs_role` | 197 opportunities |
| Existing prospect ranking | `bedrock.priority_account_floor` | 976 ranked employer prospects (the parallel Google-doc approach) |
| Commit partner list | supplied by requester | 21 named accounts |

## Headline findings

**1. The "hired 5+ builders" tranche is already comprehensive.** Of the 30 Salesforce accounts with
≥5 recorded hires, only three are absent from the Pursuit set, and all three are non-actionable:
*Intrepid Pursuits* (6 hires; acquired/wound down), *AWS* (6 hires; Amazon is covered and the tagged
Amazon contact — David Ham — is in fact AWS Global Services), and *DeepMile* (5 hires; a Comcast
subsidiary, and Comcast is covered). **No action needed on this dimension.**

**2. 8 of the 21 commit partners are missing.** iCapital, SeatGeek, Cedar, Spring Health,
Ballistic Ventures, David Energy, Foursquare and Quizlet have no `operation_35_pursuit` contact.
Skillshare is nominally covered but only by a volunteer-level contact (Zainab Ebrahimi, no title),
which is thin for a commit partner.

**3. The real gap is at 2–4 hires plus a strong non-hiring relationship** — companies with proven
willingness to hire from Pursuit *and* an active giving or PBD relationship that nobody has converted
into a hiring channel. Deutsche Bank ($925k given, 89 activities, 0 hires), Salesforce ($1.05M, PBD),
Alphadyne ($1.18M, CTO already engaged), MetLife ($551k, PBD) and Mizuho (172 activities, live jobs
opportunity) are the clearest cases.

**4. Frontier-AI and VC/PE accounts are systematically under-represented.** Anthropic, OpenAI,
Stripe, a16z, USV, Apollo, KKR, Silver Lake, General Atlantic and AlleyCorp are all in the 2026 PBD
portfolio or carry heavy recent activity, and none are in the Pursuit set. For VC/PE the value is the
portfolio-hiring channel rather than direct headcount.

**5. Four accounts with real hiring history have no senior contact at all in the CRM** — Barclays
(4 hires), Meta (4 hires), T-Mobile (4 hires) and Palo Alto Networks (83 activities, $201k). BlackRock
is the starkest: a **$2.27M lifetime donor, Strategic tier, PBD portfolio — and the most senior
contact on file is a Vice President.** These need sourcing before they can be usefully tagged.

## Important caveat: high activity ≠ hiring prospect

Ranking purely on `bedrock.activity` volume surfaces Pursuit's **own vendors and service providers**,
not employers. These were verified by inspecting the actual email participants and are deliberately
**excluded** from the recommendations:

| Account | Activities (18mo) | What it actually is |
|---|---|---|
| Justworks | 601 (highest in CRM) | Pursuit's PEO/payroll provider — 832 of 1,322 emails are `support@justworks.com` |
| Newmark (NMRK) | 149 | Commercial real-estate broker (Daniel Levine, 42 emails) |
| Wachtell, Lipton, Rosen & Katz | 132 | Outside counsel |
| Powered by Professionals | 118 | Event production vendor |
| Russell Reynolds Associates | 109 | Executive search serving Pursuit |
| VVA LLC | 83 | Construction/project management |
| Cushman & Wakefield | 67 | Real-estate broker |
| Bolton St. Johns / Hudson Ferris | 252 / 202 | Lobbying / fundraising consultants |
| Cahill Gordon & Reindel, Acrisure | 36 / 34 | Outside counsel, insurance broker |

**Recommendation:** add a vendor/service-provider flag to Salesforce accounts so relationship-strength
scoring can exclude them automatically. This will otherwise keep polluting any warmth-ranked list.

## Recommended additions

See `operation-35-pursuit-additions.csv` — 55 accounts with the most senior contact currently on file,
tiered:

- **Priority 1 (8):** missing commit partners — non-negotiable per the brief.
- **Priority 2 (24):** hiring history + major giving / PBD relationship. Largest employers, fastest to convert.
- **Priority 3 (23):** frontier AI, VC/PE portfolio channels, and PBD accounts with no hiring channel yet.

## Data-quality issues found

1. **Hire counts disagree with the supplied list.** Salesforce `Number_of_Pursuit_Fellows_Hired_DLRS__c`
   reads Uber 35 / Citi 49 / Blackstone 5, against the supplied 47 / 17 / 18. Two different sources
   of truth for "hires" are in circulation; worth reconciling before either is used for targeting.
2. **`bedrock.jobs_account.sf_account_id` is null for all 277 rows**, so the jobs pipeline cannot be
   joined to Salesforce accounts programmatically. Matching had to fall back to name strings.
3. **Duplicate Salesforce accounts** for the same company (Citi/Citigroup, Verizon ×2, Mastercard ×2,
   Poll Everywhere ×2, Hughes (Richard) Household ×3, MetLife/Metlife Foundation) split hire counts,
   giving totals and activity across records.
4. **Only 64 of ~57 tagged companies resolve to a Salesforce account ID** via the contact link tables;
   several tagged contacts (Moody's, Thumbtack, Goldman Sachs, JPMC, NYTimes, OpenRouter, Kisi, TPG)
   have no `sf_contact_link` row at all.
