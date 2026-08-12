"""Evals for the pipeline-review hygiene rules (Zhong, 2026-08-12).

These are advisory flags a fundraiser reads while reviewing the pipeline, so the
cost of a wrong rule is a wall of colour nobody trusts. Each rule is pinned at
its boundary, because "within 2 weeks" and "has passed" are exactly where an
off-by-one hides.
"""
from datetime import date, timedelta

import pytest

from services import pipeline_review as pr

TODAY = date(2026, 8, 12)


def opp(**ov):
    row = {"Id": "006A", "StageName": "Ask in Progress",
           "CloseDate": "2026-12-31", "Probability": 100,
           "Manager_Probability_Override__c": None}
    row.update(ov)
    return row


def pay(**ov):
    row = {"Id": "npeA", "Name": "PMT-1", "npe01__Opportunity__c": "006A",
           "npe01__Scheduled_Date__c": "2026-12-01",
           "npe01__Payment_Date__c": None, "npe01__Payment_Amount__c": 1000,
           "npe01__Paid__c": False, "npe01__Written_Off__c": False}
    row.update(ov)
    return row


def rules_for(o, p):
    return {h["rule"] for h in pr.evaluate_payment(p, o, TODAY)}


def iso(days):
    return (TODAY + timedelta(days=days)).isoformat()


# ── probability vs upcoming payment ──────────────────────────────────────────

@pytest.mark.parametrize("days,prob,expected", [
    (10, 90, True),    # inside 2 weeks, at the threshold — inclusive
    (10, 91, False),   # inside 2 weeks, above it
    (14, 50, True),    # exactly 2 weeks out — boundary is inclusive
    (15, 50, False),   # just outside 2 weeks: the 1-month rule takes it instead
])
def test_two_week_rule_boundaries(days, prob, expected):
    o, p = opp(Probability=prob), pay(npe01__Scheduled_Date__c=iso(days))
    assert ("prob_low_payment_within_2wk" in rules_for(o, p)) is expected


@pytest.mark.parametrize("days,prob,expected", [
    (20, 50, True),
    (20, 51, False),
    (30, 50, True),    # exactly a month out
    (31, 50, False),   # beyond the window
])
def test_one_month_rule_boundaries(days, prob, expected):
    o, p = opp(Probability=prob), pay(npe01__Scheduled_Date__c=iso(days))
    assert ("prob_low_payment_within_1mo" in rules_for(o, p)) is expected


def test_the_two_windows_do_not_double_report():
    """A payment 10 days out at 40% satisfies both rules as written. Reporting
    both would tint one cell for one problem twice."""
    hits = rules_for(opp(Probability=40), pay(npe01__Scheduled_Date__c=iso(10)))
    assert "prob_low_payment_within_2wk" in hits
    assert "prob_low_payment_within_1mo" not in hits


def test_manager_override_wins_over_probability():
    """The grid renders the override, so the rule has to read the same number —
    a flag that contradicts the cell beside it is worse than no flag."""
    o = opp(Probability=100, Manager_Probability_Override__c=20)
    assert "prob_low_payment_within_2wk" in rules_for(o, pay(npe01__Scheduled_Date__c=iso(7)))
    assert pr.effective_probability(o) == 20


# ── date-ordering and staleness ──────────────────────────────────────────────

def test_close_after_scheduled():
    o = opp(CloseDate="2026-12-05")
    assert "close_after_scheduled" in rules_for(o, pay(npe01__Scheduled_Date__c="2026-12-01"))
    o2 = opp(CloseDate="2026-11-01")
    assert "close_after_scheduled" not in rules_for(o2, pay(npe01__Scheduled_Date__c="2026-12-01"))


def test_scheduled_past_flags_unless_stage_complete():
    late = pay(npe01__Scheduled_Date__c=iso(-1))
    assert "scheduled_past_stage_open" in rules_for(opp(), late)
    assert "scheduled_past_stage_open" not in rules_for(opp(StageName=pr.STAGE_COMPLETE), late)


def test_scheduled_today_is_not_yet_past():
    assert "scheduled_past_stage_open" not in rules_for(opp(), pay(npe01__Scheduled_Date__c=iso(0)))


@pytest.mark.parametrize("stage,expected", [
    ("Ask in Progress", True),
    (pr.STAGE_COMPLETE, False),
    (pr.STAGE_COLLECTING, False),
])
def test_close_past_stage_open(stage, expected):
    hits = {h["rule"] for h in pr.evaluate_opportunity(
        opp(StageName=stage, CloseDate=iso(-1)), TODAY)}
    assert ("close_past_stage_open" in hits) is expected


# ── settled money is not a scheduling problem ────────────────────────────────

@pytest.mark.parametrize("field", ["npe01__Paid__c", "npe01__Written_Off__c"])
def test_settled_payments_are_skipped(field):
    """Money already in or written off can't be late. Without this the review
    drowns in thousands of historical rows."""
    late = pay(npe01__Scheduled_Date__c=iso(-1), **{field: True})
    assert rules_for(opp(), late) == set()


def test_payment_with_a_payment_date_is_settled():
    late = pay(npe01__Scheduled_Date__c=iso(-1), npe01__Payment_Date__c=iso(-2))
    assert rules_for(opp(), late) == set()


def test_payment_with_no_scheduled_date_is_ignored():
    assert rules_for(opp(), pay(npe01__Scheduled_Date__c=None)) == set()


# ── assembly ─────────────────────────────────────────────────────────────────

def test_build_flags_reports_cells_and_the_payment_behind_them():
    o = opp(StageName="Ask in Progress", CloseDate=iso(-5))
    p = pay(npe01__Scheduled_Date__c=iso(-3))
    out = pr.build_flags([o], [p], today=TODAY)

    flags = out["flagged"]["006A"]
    assert flags["cells"][pr.CELL_CLOSE] == ["close_past_stage_open"]
    assert flags["cells"][pr.CELL_STAGE] == ["close_past_stage_open"]
    assert "scheduled_past_stage_open" in flags["cells"][pr.CELL_PAYMENT]
    # The payment is named so the cell's hover can say which one to fix.
    assert flags["payments"][0]["name"] == "PMT-1"
    assert out["severity"] == "advisory"


def test_clean_opportunities_are_omitted():
    """The grid renders thousands of rows; the clean ones need no payload."""
    out = pr.build_flags([opp(CloseDate=iso(30))], [pay(npe01__Scheduled_Date__c=iso(60))],
                         today=TODAY)
    assert out["flagged"] == {}


def test_opportunity_rules_run_without_any_payments():
    out = pr.build_flags([opp(CloseDate=iso(-1))], [], today=TODAY)
    assert "close_past_stage_open" in out["flagged"]["006A"]["cells"][pr.CELL_CLOSE]


def test_acknowledgment_rule_is_not_shipped():
    """Zhong's sixth rule is held: the payment acknowledgment fields are unused
    org-wide (0 of 12,046), so it would flag every paid payment. See the module
    docstring — this pins the omission so it isn't quietly 'fixed' later."""
    assert not any("acknowledg" in r["key"] for r in pr.RULES)
