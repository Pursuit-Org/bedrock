"""Pipeline-review hygiene flags — the "what looks wrong here" rules.

Requested by Angie and specified by Zhong (Slack, 2026-08-12) for the
fundraising pipeline review. Every rule is ADVISORY: it tints a cell, it never
blocks a save. Nothing here writes to Salesforce.

Grain, and the two pages
------------------------
Four of the five rules test fields on the PAYMENT object
(npe01__OppPayment__c), not the opportunity — an opportunity carries up to 38
payments, and "the scheduled date" is a property of one of them.

**Payments is the primary surface** (Jac, 2026-08-12). It is payment rows, and
it already carries every column the rules touch — Scheduled, Payment Date,
Mgr Prob., Close, Stage — so a flag lands on the exact cell that needs
changing, which is what Zhong asked for.

Pipeline gets the same flags at opportunity grain, where they still read
sensibly: an opportunity row can say "your close date is after the payment
you've scheduled" even though it can't say which of 38 payments.

So a rule does not name a column. It names SEMANTIC FIELDS, and each page maps
those onto its own column keys (PAYMENTS_CELLS / PIPELINE_CELLS below). One
evaluation, two projections — a rule can never say different things on the two
pages.

Rules are evaluated here rather than in the browser for three reasons: neither
grid loads everything the rules need, both pages want the identical answer, and
thresholds someone will want to tune belong in one file.

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

# ── Semantic fields a rule can implicate ─────────────────────────────────────
# Deliberately not column names: the two pages call these different things, and
# Payments splits into two date columns where Pipeline has one.
F_PROBABILITY = "probability"
F_CLOSE_DATE = "close_date"
F_STAGE = "stage"
F_SCHEDULED_DATE = "scheduled_date"

# Payments page — ColKey in frontend-v2/src/pages/Payments.tsx. Every field maps
# to its own real column, which is why this page is the better home.
PAYMENTS_CELLS = {
    F_PROBABILITY: "mgrProb",
    F_CLOSE_DATE: "closeDate",
    F_STAGE: "stage",
    F_SCHEDULED_DATE: "scheduledDate",
}

# Pipeline page — ColKey in frontend-v2/src/pages/Pipeline.tsx. Opportunity
# rows, so anything about a payment collapses onto the single "1st Payment"
# column and the UI names the offending payment on hover.
PIPELINE_CELLS = {
    F_PROBABILITY: "probability",
    F_CLOSE_DATE: "close",
    F_STAGE: "stage",
    F_SCHEDULED_DATE: "paymentDate",
}

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
                     "fields": [F_PROBABILITY, F_SCHEDULED_DATE]})
    elif upcoming and scheduled <= today + WINDOW_1_MONTH and probability <= PROBABILITY_AT_1_MONTH:
        # `elif`: a payment inside the 2-week window is already reported by the
        # tighter rule. Both firing would double-count one problem.
        hits.append({"rule": "prob_low_payment_within_1mo",
                     "fields": [F_PROBABILITY, F_SCHEDULED_DATE]})

    if close is not None and close > scheduled:
        hits.append({"rule": "close_after_scheduled",
                     "fields": [F_CLOSE_DATE, F_SCHEDULED_DATE]})

    if scheduled < today and stage != STAGE_COMPLETE:
        # Zhong: "highlight scheduled date" — the stage is the context, not the
        # thing to change, so it deliberately isn't tinted here.
        hits.append({"rule": "scheduled_past_stage_open",
                     "fields": [F_SCHEDULED_DATE]})

    return hits


def evaluate_opportunity(opp: Dict[str, Any], today: date) -> List[Dict[str, Any]]:
    """Rules that need only the opportunity. Runs for every row, including the
    opportunities that carry no payments at all."""
    hits: List[Dict[str, Any]] = []
    close = _as_date(opp.get("CloseDate"))
    stage = opp.get("StageName") or ""

    if close is not None and close < today and stage not in (STAGE_COMPLETE, STAGE_COLLECTING):
        hits.append({"rule": "close_past_stage_open",
                     "fields": [F_CLOSE_DATE, F_STAGE]})

    return hits


def _project(hits: Iterable[Dict[str, Any]], mapping: Dict[str, str]) -> Dict[str, List[str]]:
    """Semantic fields → one page's column keys → the rules that tinted them."""
    cells: Dict[str, List[str]] = {}
    for hit in hits:
        for field in hit["fields"]:
            column = mapping.get(field)
            if column is None:
                continue
            bucket = cells.setdefault(column, [])
            if hit["rule"] not in bucket:
                bucket.append(hit["rule"])
    return cells


def build_flags(opportunities: Iterable[Dict[str, Any]],
                payments: Iterable[Dict[str, Any]],
                today: Optional[date] = None) -> Dict[str, Any]:
    """Evaluate every rule once and project it for both pages.

    `payments` is keyed by payment id for the Payments grid — the primary
    surface, where every rule lands on its own cell. `opportunities` is keyed by
    opportunity id for Pipeline, where payment-level hits collapse onto the
    payment column and carry the offending payments so the UI can name them.

    Only flagged records appear in either map; both grids render thousands of
    rows and the clean ones need no payload.
    """
    today = today or date.today()

    by_opp: Dict[str, List[Dict[str, Any]]] = {}
    for p in payments:
        oid = p.get("npe01__Opportunity__c")
        if oid:
            by_opp.setdefault(oid, []).append(p)

    opp_flags: Dict[str, Any] = {}
    payment_flags: Dict[str, Any] = {}

    for opp in opportunities:
        oid = opp.get("Id")
        if not oid:
            continue

        # Opportunity-level hits apply to the opportunity row AND to every one
        # of its payment rows, because Payments shows Close and Stage as columns
        # off the parent — the same problem, visible from both grains.
        opp_hits = evaluate_opportunity(opp, today)
        all_hits = list(opp_hits)
        payment_detail: List[Dict[str, Any]] = []

        for payment in by_opp.get(oid, []):
            pid = payment.get("Id")
            hits = evaluate_payment(payment, opp, today)

            row_hits = list(opp_hits) + hits
            if pid and row_hits:
                payment_flags[pid] = {
                    "cells": _project(row_hits, PAYMENTS_CELLS),
                    "opportunity_id": oid,
                }

            if not hits:
                continue
            all_hits.extend(hits)
            payment_detail.append({
                "id": pid,
                "name": payment.get("Name"),
                "scheduled_date": payment.get("npe01__Scheduled_Date__c"),
                "amount": payment.get("npe01__Payment_Amount__c"),
                "rules": [h["rule"] for h in hits],
            })

        cells = _project(all_hits, PIPELINE_CELLS)
        if cells:
            opp_flags[oid] = {"cells": cells, "payments": payment_detail}

    return {
        "generated_at": today.isoformat(),
        "severity": "advisory",
        "rules": RULES,
        "opportunities": opp_flags,
        "payments": payment_flags,
    }
