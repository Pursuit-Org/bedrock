"""Pipeline-review hygiene flags — the "what looks wrong here" rules.

Requested by Angie and specified by Zhong (Slack, 2026-08-12) for the
fundraising pipeline review. Every rule is ADVISORY: it tints a cell, it never
blocks a save. Nothing here writes to Salesforce.

Grain
-----
Four of the five rules test fields on the PAYMENT object
(npe01__OppPayment__c), not the opportunity — an opportunity carries up to 38
payments, and "the scheduled date" is a property of one of them. The Pipeline
grid is opportunity rows, so payment-level problems are reported against the
opportunity's payment cell with the offending payments listed alongside, and
the UI names the payment on hover.

Rules are evaluated here rather than in the browser for three reasons: the grid
never loads payments (they'd be ~6.6k extra records on the wire), the same
flags will be wanted on Portfolio and Payments, and thresholds someone will
want to tune belong in one file.

What is NOT here
----------------
Zhong's sixth rule — "if payment date is populated and acknowledgment is blank,
highlight acknowledgment" — is deliberately unimplemented. The payment
acknowledgment fields exist (npsp__Payment_Acknowledgment_Status__c, picklist
To Be Acknowledged / Acknowledged / Do Not Acknowledge, and
npsp__Payment_Acknowledged_Date__c) but are entirely unused in this org: of
12,046 payments carrying a payment date, ZERO have either field set
(checked 2026-08-12). Implemented literally the rule would flag every paid
payment in the org, which is noise rather than signal. It needs a decision from
Zhong first — most likely either scoping it to payments after an adoption date,
or pointing at Opportunity.Acknowledgement_Letter__c (149 records populated)
instead.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional

# Canonical stage strings. These mirror SF_STAGE_OPTIONS in
# frontend-v2/src/lib/stages.ts — Zhong's "complete" and "collecting in effect".
STAGE_COMPLETE = "Closed / Completed"
STAGE_COLLECTING = "Collecting / In Effect"

# "within 1 month" / "within 2 weeks", forward-looking from today. Past-due
# payments are rule `scheduled_past_stage_open`'s job, so these two windows
# deliberately do not reach backwards — otherwise every overdue payment would
# light up three rules at once and the cell colour would stop meaning anything.
WINDOW_1_MONTH = timedelta(days=30)
WINDOW_2_WEEKS = timedelta(days=14)

PROBABILITY_AT_1_MONTH = 50
PROBABILITY_AT_2_WEEKS = 90

# Grid column keys, matching ColKey in frontend-v2/src/pages/Pipeline.tsx.
CELL_PROBABILITY = "probability"
CELL_CLOSE = "close"
CELL_STAGE = "stage"
CELL_PAYMENT = "paymentDate"

RULES: List[Dict[str, str]] = [
    {"key": "prob_low_payment_within_1mo",
     "label": "Payment scheduled within a month but probability is 50% or less"},
    {"key": "prob_low_payment_within_2wk",
     "label": "Payment scheduled within two weeks but probability is 90% or less"},
    {"key": "close_after_scheduled",
     "label": "Close date is after the scheduled payment date"},
    {"key": "scheduled_past_stage_open",
     "label": "Scheduled payment date has passed and the stage is not Closed / Completed"},
    {"key": "close_past_stage_open",
     "label": "Close date has passed and the stage is neither Closed / Completed nor Collecting / In Effect"},
]


def _as_date(value: Any) -> Optional[date]:
    """Salesforce date fields arrive as 'YYYY-MM-DD' (or None)."""
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def effective_probability(opp: Dict[str, Any]) -> float:
    """The probability the GRID shows.

    Pipeline.tsx renders `Manager_Probability_Override__c ?? Probability`, so
    the rules have to read the same value — a flag that disagrees with the
    number in the cell beside it is worse than no flag.
    """
    override = opp.get("Manager_Probability_Override__c")
    if override is not None:
        return float(override)
    return float(opp.get("Probability") or 0)


def _is_settled(payment: Dict[str, Any]) -> bool:
    """Money that has already arrived or been written off.

    Scheduling rules are about whether expected money will show up, so a
    settled payment can't be late or mis-forecast. Flagging them would bury the
    live problems under thousands of historical rows. Flagged here as an
    explicit judgement, not in Zhong's spec — worth confirming with him.
    """
    return bool(payment.get("npe01__Paid__c")
                or payment.get("npe01__Written_Off__c")
                or payment.get("npe01__Payment_Date__c"))


def evaluate_payment(payment: Dict[str, Any], opp: Dict[str, Any],
                     today: date) -> List[Dict[str, Any]]:
    """Rules that test a single payment against its parent opportunity.

    Returns a list of {rule, cells} — `cells` are the grid columns to tint.
    """
    hits: List[Dict[str, Any]] = []
    scheduled = _as_date(payment.get("npe01__Scheduled_Date__c"))
    if scheduled is None or _is_settled(payment):
        return hits

    probability = effective_probability(opp)
    stage = opp.get("StageName") or ""
    close = _as_date(opp.get("CloseDate"))

    upcoming = scheduled >= today

    if upcoming and scheduled <= today + WINDOW_2_WEEKS and probability <= PROBABILITY_AT_2_WEEKS:
        hits.append({"rule": "prob_low_payment_within_2wk",
                     "cells": [CELL_PROBABILITY, CELL_PAYMENT]})
    elif upcoming and scheduled <= today + WINDOW_1_MONTH and probability <= PROBABILITY_AT_1_MONTH:
        # `elif`: a payment inside the 2-week window is already reported by the
        # tighter rule. Both firing would double-count one problem.
        hits.append({"rule": "prob_low_payment_within_1mo",
                     "cells": [CELL_PROBABILITY, CELL_PAYMENT]})

    if close is not None and close > scheduled:
        hits.append({"rule": "close_after_scheduled",
                     "cells": [CELL_CLOSE, CELL_PAYMENT]})

    if scheduled < today and stage != STAGE_COMPLETE:
        hits.append({"rule": "scheduled_past_stage_open",
                     "cells": [CELL_PAYMENT]})

    return hits


def evaluate_opportunity(opp: Dict[str, Any], today: date) -> List[Dict[str, Any]]:
    """Rules that need only the opportunity. Runs for every row, including the
    opportunities that carry no payments at all."""
    hits: List[Dict[str, Any]] = []
    close = _as_date(opp.get("CloseDate"))
    stage = opp.get("StageName") or ""

    if close is not None and close < today and stage not in (STAGE_COMPLETE, STAGE_COLLECTING):
        hits.append({"rule": "close_past_stage_open",
                     "cells": [CELL_CLOSE, CELL_STAGE]})

    return hits


def build_flags(opportunities: Iterable[Dict[str, Any]],
                payments: Iterable[Dict[str, Any]],
                today: Optional[date] = None) -> Dict[str, Any]:
    """Evaluate every rule and return flags keyed by opportunity id.

    Only flagged opportunities are returned — the grid renders thousands of
    rows and the clean ones need no payload.
    """
    today = today or date.today()

    by_opp: Dict[str, List[Dict[str, Any]]] = {}
    for p in payments:
        oid = p.get("npe01__Opportunity__c")
        if oid:
            by_opp.setdefault(oid, []).append(p)

    flagged: Dict[str, Any] = {}

    for opp in opportunities:
        oid = opp.get("Id")
        if not oid:
            continue

        cells: Dict[str, List[str]] = {}
        payment_detail: List[Dict[str, Any]] = []

        def add(hit: Dict[str, Any]) -> None:
            for cell in hit["cells"]:
                bucket = cells.setdefault(cell, [])
                if hit["rule"] not in bucket:
                    bucket.append(hit["rule"])

        for hit in evaluate_opportunity(opp, today):
            add(hit)

        for payment in by_opp.get(oid, []):
            hits = evaluate_payment(payment, opp, today)
            if not hits:
                continue
            for hit in hits:
                add(hit)
            payment_detail.append({
                "id": payment.get("Id"),
                "name": payment.get("Name"),
                "scheduled_date": payment.get("npe01__Scheduled_Date__c"),
                "amount": payment.get("npe01__Payment_Amount__c"),
                "rules": [h["rule"] for h in hits],
            })

        if cells:
            flagged[oid] = {"cells": cells, "payments": payment_detail}

    return {
        "generated_at": today.isoformat(),
        "severity": "advisory",
        "rules": RULES,
        "flagged": flagged,
    }
