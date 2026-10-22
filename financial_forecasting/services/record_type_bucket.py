"""Shared record-type bucket filter for the dashboard's record-type pills
(All / Grant + Donation / Grant / Donation / PBC / Capital Grants / Other).

Used by both main.py's cashflow/ACV endpoints (querying npe01__OppPayment__c
via the npe01__Opportunity__r relationship) and routes/revenue_snapshot.py
(which queries Opportunity directly as well as via that same relationship).

Salesforce Opportunity record types (as of 2026-10-22): the former
'Philanthropy' record type was renamed 'Grant' (same Id, 0121U0000002h3SQAQ)
and donation-style opps were moved to 'Donation'. Active types are Grant,
Donation, PBC, Debt / Equity, Other Fee For Service, Other In-Kind, ISA.
See product/crm-architecture/canonical-definitions.md § Opportunity Record Types.
"""

RT_GRANT = "Grant"
RT_DONATION = "Donation"
RT_PBC = "PBC"
RT_ISA = "ISA"

# Record types that together make up philanthropic fundraising — what the
# old 'Philanthropy' record type covered before the split.
PHILANTHROPY_RECORD_TYPES = (RT_GRANT, RT_DONATION)

CAPITAL_GRANT_TYPE = "Capital Grant"

VALID_BUCKETS = (
    "all",
    "philanthropy",
    "grant",
    "donation",
    "pbc",
    "capital_grants",
    "other",
)

# FastAPI Query(regex=...) pattern for bucket params.
BUCKET_PATTERN = "^(" + "|".join(VALID_BUCKETS) + ")$"


def bucket_soql_filter(bucket: str, opp_prefix: str = "npe01__Opportunity__r") -> str:
    """Return a SOQL fragment to AND into a query so it only matches the
    requested record-type bucket.

    `opp_prefix` is the relationship path to the Opportunity fields being
    filtered — pass "" when querying Opportunity fields directly, or the
    default "npe01__Opportunity__r" when querying a related object like
    npe01__OppPayment__c.

    Every bucket carries the ISA exclusion — ISA opps are not in scope
    for bedrock's cashflow views.

    Buckets:
        all             — only ISA excluded
        philanthropy    — Grant + Donation, not a Capital Grant (the $20M goal)
        grant           — RecordType.Name = 'Grant' AND not a Capital Grant
        donation        — RecordType.Name = 'Donation' AND not a Capital Grant
        capital_grants  — Philanthropy_Type__c = 'Capital Grant' (any RT, but in
                          practice all sit under Grant)
        pbc             — RecordType.Name = 'PBC'
        other           — none of Grant / Donation / PBC / ISA (includes NULL RT,
                          Debt / Equity, Other Fee For Service, Other In-Kind,
                          and inactive legacy types); Capital Grants excluded
    """
    opp = f"{opp_prefix}." if opp_prefix else ""
    isa = f" AND {opp}RecordType.Name != '{RT_ISA}'"
    not_capital = (
        f"({opp}Philanthropy_Type__c != '{CAPITAL_GRANT_TYPE}' "
        f"OR {opp}Philanthropy_Type__c = null)"
    )

    if bucket == "all":
        return isa
    if bucket == "philanthropy":
        names = ", ".join(f"'{n}'" for n in PHILANTHROPY_RECORD_TYPES)
        return f" AND {opp}RecordType.Name IN ({names}) AND {not_capital}"
    if bucket == "grant":
        return f" AND {opp}RecordType.Name = '{RT_GRANT}' AND {not_capital}"
    if bucket == "donation":
        return f" AND {opp}RecordType.Name = '{RT_DONATION}' AND {not_capital}"
    if bucket == "capital_grants":
        return f" AND {opp}Philanthropy_Type__c = '{CAPITAL_GRANT_TYPE}'" + isa
    if bucket == "pbc":
        return f" AND {opp}RecordType.Name = '{RT_PBC}'"
    if bucket == "other":
        excluded = ", ".join(f"'{n}'" for n in (*PHILANTHROPY_RECORD_TYPES, RT_PBC, RT_ISA))
        return (
            f" AND ({opp}RecordType.Name = null OR "
            f"{opp}RecordType.Name NOT IN ({excluded})) "
            f"AND {not_capital}"
        )
    return isa
