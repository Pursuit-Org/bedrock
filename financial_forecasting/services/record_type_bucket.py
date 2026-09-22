"""Shared record-type bucket filter for the dashboard's All / Philanthropy /
PBC / Capital Grants / Other pills.

Used by both main.py's cashflow/ACV endpoints (querying npe01__OppPayment__c
via the npe01__Opportunity__r relationship) and routes/revenue_snapshot.py
(which queries Opportunity directly as well as via that same relationship).
"""

VALID_BUCKETS = {"all", "philanthropy", "pbc", "capital_grants", "other"}


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
        philanthropy    — RecordType.Name = 'Philanthropy' AND not a Capital Grant
        capital_grants  — Philanthropy_Type__c = 'Capital Grant' (any RT, but in
                          practice all sit under Philanthropy)
        pbc             — RecordType.Name = 'PBC'
        other           — neither Philanthropy nor PBC nor ISA (includes NULL RT;
                          Capital Grants are excluded since they're RT=Philanthropy)
    """
    opp = f"{opp_prefix}." if opp_prefix else ""
    isa = f" AND {opp}RecordType.Name != 'ISA'"
    if bucket == "all":
        return isa
    if bucket == "philanthropy":
        return (
            f" AND {opp}RecordType.Name = 'Philanthropy' "
            f"AND ({opp}Philanthropy_Type__c != 'Capital Grant' "
            f"OR {opp}Philanthropy_Type__c = null)"
        )
    if bucket == "capital_grants":
        return (
            f" AND {opp}Philanthropy_Type__c = 'Capital Grant'"
            + isa
        )
    if bucket == "pbc":
        return f" AND {opp}RecordType.Name = 'PBC'"
    if bucket == "other":
        return (
            f" AND ({opp}RecordType.Name = null OR "
            f"{opp}RecordType.Name NOT IN ('Philanthropy', 'PBC', 'ISA')) "
            f"AND ({opp}Philanthropy_Type__c != 'Capital Grant' "
            f"OR {opp}Philanthropy_Type__c = null)"
        )
    return isa
