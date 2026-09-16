"""YTD Revenue Snapshot endpoint.

Three revenue buckets for a given fiscal year:
  - revenue_closed:  Opportunity.Amount on Won deals whose CloseDate falls in year
                     (full grant value regardless of payment schedule)
  - cash_secured:    Payment records on Won opps scheduled to land in year
                     (what actually hits the books)
  - projected_total: cash_secured + probability-weighted open pipeline payments

Plus a future_years map (year+1, year+2) of already-secured payments
from multi-year grants.

All totals include a by_source breakdown keyed by display category
(Foundation / Corporate / Individual / Government / Other).
"""

import asyncio
import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from auth import decrypt_tokens
from dependencies import require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from routes.permissions import check_permission
from services.cache import cache, CACHE_TTL_CASHFLOW
from sf_errors import sf_http_error


def _sf_instance_url(request: Request) -> str | None:
    """Extract the Salesforce instance URL from the user's sf_tokens cookie."""
    try:
        cookie = request.cookies.get("sf_tokens")
        if cookie:
            tokens = decrypt_tokens(cookie)
            return (tokens or {}).get("instance_url")
    except Exception:
        pass
    return None

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/salesforce/revenue-snapshot", tags=["revenue-snapshot"])

# Won stages — mirrors main.py get_cashflow; includes legacy SF stage variants
_WON_STAGES_SOQL = (
    "('Collecting / In Effect', 'Collecting', 'In Effect', "
    "'Closed Won', 'Closed / Completed', 'Closed / Fulfilled')"
)

ANNUAL_TARGET = 20_000_000

# Map raw Salesforce Account.Type values to four display categories.
# Unknown/null types fall into "Other".
_SOURCE_MAP: dict[str, str] = {
    "Foundation": "Foundation",
    "Private Foundation": "Foundation",
    "Community Foundation": "Foundation",
    "Educational Foundation": "Foundation",
    "Corporate": "Corporate",
    "Corporation": "Corporate",
    "Business": "Corporate",
    "Individual": "Individual",
    "Household": "Individual",
    "Household Account": "Individual",
    "Person Account": "Individual",
    "Government": "Government",
    "Government Agency": "Government",
    "Federal Government": "Government",
    "State/Local Government": "Government",
    "Public": "Government",
}
_CATEGORIES = ["Foundation", "Corporate", "Individual", "Government", "Other"]

# Reverse map: canonical category → list of raw SF Account.Type values
_SOURCE_TYPES: dict[str, list[str]] = {}
for _raw, _canonical in _SOURCE_MAP.items():
    _SOURCE_TYPES.setdefault(_canonical, []).append(_raw)
_ALL_KNOWN_TYPES = list(_SOURCE_MAP.keys())


def _source_filter(source: str, type_field: str) -> str:
    """SOQL WHERE fragment restricting Account.Type to the given display category."""
    if source == "Other":
        known = ", ".join(f"'{t}'" for t in _ALL_KNOWN_TYPES)
        return f"({type_field} NOT IN ({known}) OR {type_field} = null)"
    types = _SOURCE_TYPES.get(source, [])
    quoted = ", ".join(f"'{t}'" for t in types)
    return f"{type_field} IN ({quoted})"


def _src(account_type: str | None) -> str:
    if not account_type:
        return "Other"
    return _SOURCE_MAP.get(account_type, "Other")


def _empty() -> dict[str, float]:
    return {c: 0.0 for c in _CATEGORIES}


def _total(d: dict[str, float]) -> float:
    return sum(d.values())


@router.get("")
async def get_revenue_snapshot(
    year: int = Query(..., ge=2000, le=2100),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    _user=Depends(check_permission("view_revenue_dashboard")),
):
    """YTD revenue snapshot for the given fiscal year.

    Returns three cumulative revenue buckets plus a multi-year secured tracker.
    Cached at the cashflow TTL (~10 min) since this data is SF-live.
    """
    cache_key = f"revenue_snapshot:{year}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        sf = client.salesforce
        today = date.today().isoformat()
        future_end = year + 2  # track 3 years total (current + 2)

        # Q1 — Won opps by CloseDate: full deal value (Opportunity.Amount)
        soql_closed = f"""
            SELECT Account.Type, Amount
            FROM Opportunity
            WHERE StageName IN {_WON_STAGES_SOQL}
            AND CloseDate >= {year}-01-01
            AND CloseDate <= {year}-12-31
            AND RecordType.Name != 'ISA'
            AND Amount != null
            LIMIT 2000
        """

        # Q2 — Payment records on Won opps covering current year through year+2.
        # We use Scheduled_Date to assign each payment to its year-bucket so
        # multi-year grants (e.g. Ascendium $4M paid in 3 tranches) appear
        # in the correct future-year column.
        soql_payments = f"""
            SELECT npe01__Opportunity__r.Account.Type,
                   npe01__Scheduled_Date__c,
                   npe01__Payment_Amount__c
            FROM npe01__OppPayment__c
            WHERE npe01__Opportunity__r.StageName IN {_WON_STAGES_SOQL}
            AND npe01__Scheduled_Date__c >= {year}-01-01
            AND npe01__Scheduled_Date__c <= {future_end}-12-31
            AND npe01__Written_Off__c = false
            AND npe01__Opportunity__r.RecordType.Name != 'ISA'
            AND npe01__Payment_Amount__c != null
            LIMIT 5000
        """

        # Q3 — Open pipeline payments this year (probability-weighted)
        soql_pipeline = f"""
            SELECT npe01__Opportunity__r.Account.Type,
                   npe01__Opportunity__r.Probability,
                   npe01__Opportunity__r.Manager_Probability_Override__c,
                   npe01__Payment_Amount__c
            FROM npe01__OppPayment__c
            WHERE npe01__Opportunity__r.IsClosed = false
            AND npe01__Opportunity__r.StageName NOT IN {_WON_STAGES_SOQL}
            AND npe01__Scheduled_Date__c >= {year}-01-01
            AND npe01__Scheduled_Date__c <= {year}-12-31
            AND npe01__Written_Off__c = false
            AND npe01__Opportunity__r.RecordType.Name != 'ISA'
            AND npe01__Payment_Amount__c != null
            LIMIT 2000
        """

        closed_res, payments_res, pipeline_res = await asyncio.gather(
            sf.query(soql_closed),
            sf.query(soql_payments),
            sf.query(soql_pipeline),
        )

        # ── Revenue Closed (Q1) ────────────────────────────────────────────
        rev_closed = _empty()
        for r in closed_res.get("records", []):
            amt = r.get("Amount") or 0
            acct = (r.get("Account") or {})
            rev_closed[_src(acct.get("Type"))] += amt

        # ── Cash Secured by year (Q2) ──────────────────────────────────────
        secured: dict[int, dict[str, float]] = {
            y: _empty() for y in range(year, year + 3)
        }
        for r in payments_res.get("records", []):
            amt = r.get("npe01__Payment_Amount__c") or 0
            sched = r.get("npe01__Scheduled_Date__c") or ""
            if not sched:
                continue
            try:
                py = int(sched[:4])
            except ValueError:
                continue
            if py not in secured:
                continue
            opp = r.get("npe01__Opportunity__r") or {}
            acct = (opp.get("Account") or {})
            secured[py][_src(acct.get("Type"))] += amt

        # ── Pipeline weighted (Q3) ─────────────────────────────────────────
        pipeline = _empty()
        for r in pipeline_res.get("records", []):
            amt = r.get("npe01__Payment_Amount__c") or 0
            opp = r.get("npe01__Opportunity__r") or {}
            prob = (
                opp.get("Manager_Probability_Override__c")
                or opp.get("Probability")
                or 0
            )
            acct = (opp.get("Account") or {})
            pipeline[_src(acct.get("Type"))] += amt * (prob / 100.0)

        # ── Projected total = secured[year] + pipeline ─────────────────────
        projected = {k: secured[year][k] + pipeline[k] for k in _CATEGORIES}

        result = {
            "year": year,
            "as_of": today,
            "annual_target": ANNUAL_TARGET,
            "revenue_closed": {
                "total": _total(rev_closed),
                "by_source": rev_closed,
            },
            "cash_secured": {
                "total": _total(secured[year]),
                "by_source": secured[year],
            },
            "projected_total": {
                "total": _total(projected),
                "secured": _total(secured[year]),
                "pipeline_weighted": _total(pipeline),
                "by_source": projected,
            },
            "future_years": {
                str(year + 1): {
                    "total": _total(secured[year + 1]),
                    "by_source": secured[year + 1],
                },
                str(year + 2): {
                    "total": _total(secured[year + 2]),
                    "by_source": secured[year + 2],
                },
            },
        }
        cache.set(cache_key, result, CACHE_TTL_CASHFLOW)
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error building revenue snapshot for year %s", year)
        raise sf_http_error(e, "revenue snapshot")


_BUCKET_LABELS = {
    "revenue_closed": "Revenue Closed",
    "cash_secured": "Cash Secured",
    "projected_total": "Total Projected",
}


@router.get("/detail")
async def get_revenue_snapshot_detail(
    request: Request,
    year: int = Query(..., ge=2000, le=2100),
    bucket: str = Query(...),
    source: str = Query(...),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    _user=Depends(check_permission("view_revenue_dashboard")),
):
    """Drill-down records for one bucket + source category."""
    if bucket not in _BUCKET_LABELS:
        raise HTTPException(status_code=400, detail="Invalid bucket")
    if source not in _CATEGORIES and source != "__all__":
        raise HTTPException(status_code=400, detail="Invalid source")

    instance_url = _sf_instance_url(request)

    cache_key = f"revenue_snapshot_detail:{year}:{bucket}:{source}"
    cached = cache.get(cache_key)
    if cached is not None:
        # Always inject the (session-specific) instance URL — it's not cached
        return {**cached, "sf_instance_url": instance_url}

    try:
        sf = client.salesforce

        if bucket == "revenue_closed":
            filt_clause = "" if source == "__all__" else f"AND {_source_filter(source, 'Account.Type')}"
            soql = f"""
                SELECT Id, Name, Account.Name, Amount, CloseDate
                FROM Opportunity
                WHERE StageName IN {_WON_STAGES_SOQL}
                AND CloseDate >= {year}-01-01
                AND CloseDate <= {year}-12-31
                AND RecordType.Name != 'ISA'
                AND Amount != null
                {filt_clause}
                ORDER BY Amount DESC
                LIMIT 500
            """
            res = await sf.query(soql)
            records = [
                {
                    "id": r["Id"],
                    "opp_id": r["Id"],  # opp IS the record for this bucket
                    "name": r.get("Name"),
                    "account": (r.get("Account") or {}).get("Name"),
                    "amount": r.get("Amount") or 0,
                    "close_date": r.get("CloseDate"),
                }
                for r in res.get("records", [])
            ]
            total = sum(r["amount"] for r in records)

        elif bucket == "cash_secured":
            filt_clause = "" if source == "__all__" else f"AND {_source_filter(source, 'npe01__Opportunity__r.Account.Type')}"
            soql = f"""
                SELECT Id, npe01__Opportunity__r.Id, npe01__Opportunity__r.Name,
                       npe01__Opportunity__r.Account.Name,
                       npe01__Payment_Amount__c, npe01__Scheduled_Date__c
                FROM npe01__OppPayment__c
                WHERE npe01__Opportunity__r.StageName IN {_WON_STAGES_SOQL}
                AND npe01__Scheduled_Date__c >= {year}-01-01
                AND npe01__Scheduled_Date__c <= {year}-12-31
                AND npe01__Written_Off__c = false
                AND npe01__Opportunity__r.RecordType.Name != 'ISA'
                AND npe01__Payment_Amount__c != null
                {filt_clause}
                ORDER BY npe01__Payment_Amount__c DESC
                LIMIT 500
            """
            res = await sf.query(soql)
            records = []
            for r in res.get("records", []):
                opp = r.get("npe01__Opportunity__r") or {}
                records.append({
                    "id": r["Id"],
                    "opp_id": opp.get("Id"),
                    "name": opp.get("Name"),
                    "account": (opp.get("Account") or {}).get("Name"),
                    "amount": r.get("npe01__Payment_Amount__c") or 0,
                    "scheduled_date": r.get("npe01__Scheduled_Date__c"),
                })
            total = sum(r["amount"] for r in records)

        else:  # projected_total — secured (won) + pipeline (open, weighted)
            filt_clause = "" if source == "__all__" else f"AND {_source_filter(source, 'npe01__Opportunity__r.Account.Type')}"
            soql_s = f"""
                SELECT Id, npe01__Opportunity__r.Id, npe01__Opportunity__r.Name,
                       npe01__Opportunity__r.Account.Name,
                       npe01__Payment_Amount__c, npe01__Scheduled_Date__c
                FROM npe01__OppPayment__c
                WHERE npe01__Opportunity__r.StageName IN {_WON_STAGES_SOQL}
                AND npe01__Scheduled_Date__c >= {year}-01-01
                AND npe01__Scheduled_Date__c <= {year}-12-31
                AND npe01__Written_Off__c = false
                AND npe01__Opportunity__r.RecordType.Name != 'ISA'
                AND npe01__Payment_Amount__c != null
                {filt_clause}
                LIMIT 500
            """
            soql_p = f"""
                SELECT Id, npe01__Opportunity__r.Id, npe01__Opportunity__r.Name,
                       npe01__Opportunity__r.Account.Name,
                       npe01__Opportunity__r.Probability,
                       npe01__Opportunity__r.Manager_Probability_Override__c,
                       npe01__Payment_Amount__c, npe01__Scheduled_Date__c
                FROM npe01__OppPayment__c
                WHERE npe01__Opportunity__r.IsClosed = false
                AND npe01__Opportunity__r.StageName NOT IN {_WON_STAGES_SOQL}
                AND npe01__Scheduled_Date__c >= {year}-01-01
                AND npe01__Scheduled_Date__c <= {year}-12-31
                AND npe01__Written_Off__c = false
                AND npe01__Opportunity__r.RecordType.Name != 'ISA'
                AND npe01__Payment_Amount__c != null
                {filt_clause}
                LIMIT 500
            """
            secured_res, pipeline_res = await asyncio.gather(
                sf.query(soql_s), sf.query(soql_p)
            )
            records = []
            for r in secured_res.get("records", []):
                opp = r.get("npe01__Opportunity__r") or {}
                amt = r.get("npe01__Payment_Amount__c") or 0
                records.append({
                    "id": r["Id"],
                    "opp_id": opp.get("Id"),
                    "name": opp.get("Name"),
                    "account": (opp.get("Account") or {}).get("Name"),
                    "amount": amt,
                    "weighted_amount": amt,
                    "probability": 100,
                    "scheduled_date": r.get("npe01__Scheduled_Date__c"),
                    "kind": "secured",
                })
            for r in pipeline_res.get("records", []):
                opp = r.get("npe01__Opportunity__r") or {}
                amt = r.get("npe01__Payment_Amount__c") or 0
                prob = opp.get("Manager_Probability_Override__c") or opp.get("Probability") or 0
                records.append({
                    "id": r["Id"],
                    "opp_id": opp.get("Id"),
                    "name": opp.get("Name"),
                    "account": (opp.get("Account") or {}).get("Name"),
                    "amount": amt,
                    "weighted_amount": amt * (prob / 100.0),
                    "probability": prob,
                    "scheduled_date": r.get("npe01__Scheduled_Date__c"),
                    "kind": "pipeline",
                })
            records.sort(key=lambda x: x["weighted_amount"], reverse=True)
            total = sum(r["weighted_amount"] for r in records)

        result = {
            "bucket": bucket,
            "bucket_label": _BUCKET_LABELS[bucket],
            "source": source,
            "year": year,
            "records": records,
            "total": total,
            "sf_instance_url": instance_url,
        }
        cache.set(cache_key, result, CACHE_TTL_CASHFLOW)
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error fetching revenue detail %s/%s for %s", bucket, source, year)
        raise sf_http_error(e, "revenue snapshot detail")
