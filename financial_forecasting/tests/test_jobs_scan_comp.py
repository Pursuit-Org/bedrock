"""Regression suite for the jobs-scan comp parser.

Every case here is a real misparse or a real format observed in production. A
wrong salary is invisible -- it just looks like a salary -- so this file is the
only thing standing between the scanner and confident garbage. Add a case for
every new misparse rather than tweaking the regex blind.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.jobs_scan.comp import (  # noqa: E402
    extract_comp,
    extract_greenhouse_pay_ranges,
)


# ---------------------------------------------------------------------------
# The three production misparses that motivated the scoring approach.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("text", [
    "You will own a $1M+ quota for the region.",
    "Backed by a $4.6M research stipend from the foundation.",
    "We raised $50M in our Series B last year.",
    "Recently closed a $120M funding round.",
    "Managing $2.5M ACV across enterprise accounts.",
    "Contributes to a $900K bonus pool.",
])
def test_rejects_non_salary_dollar_amounts(text):
    assert not extract_comp(text).found, f"should not parse a salary from: {text}"


# ---------------------------------------------------------------------------
# Formats that must parse.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("text,low,high", [
    ("The salary range is $95,000 - $120,000 per year.", 95_000, 120_000),
    ("Compensation: $95K–$120K", 95_000, 120_000),
    ("Base salary of $110,000 annually.", 110_000, 110_000),
    ("Pay range $85,000 to $105,000", 85_000, 105_000),
    ("Expected comp band: $70k - $90k", 70_000, 90_000),
    ("This role pays $150,000 — $180,000 depending on experience.", 150_000, 180_000),
])
def test_parses_annual_ranges(text, low, high):
    result = extract_comp(text)
    assert result.found
    assert result.min_amount == low
    assert result.max_amount == high


def test_noise_floor_rejects_small_amounts():
    # Perks and fees, not compensation.
    assert not extract_comp("We offer a $500 wellness stipend.").found
    assert not extract_comp("$1,200 annual learning budget").found


def test_sanity_cap_rejects_absurd_singletons():
    assert not extract_comp("Our platform processes $5,000,000 daily.").found


# ---------------------------------------------------------------------------
# The OTE case: a salary keyword in the prefix must beat a tail negative,
# otherwise "Base salary $345K with OTE up to $500K" parses as nothing.
# ---------------------------------------------------------------------------
def test_salary_prefix_survives_ote_suffix():
    result = extract_comp("Base salary $345,000 with OTE up to $500,000.")
    assert result.found
    assert result.min_amount == 345_000


def test_bare_singleton_followed_by_ote_is_rejected():
    assert not extract_comp("Earn $250,000 OTE in year one.").found


def test_range_beats_bare_singleton():
    # The range is the real comp; the bare figure is incidental.
    text = "Signing bonus available. Salary range $90,000 - $110,000."
    result = extract_comp(text)
    assert (result.min_amount, result.max_amount) == (90_000, 110_000)


# ---------------------------------------------------------------------------
# Hourly rates: entry-level postings often quote these, and they fall below the
# annual noise floor, so they must be annualized rather than dropped.
# ---------------------------------------------------------------------------
def test_hourly_range_annualized():
    result = extract_comp("This position pays $45 - $55 / hour.")
    assert result.found
    assert result.min_amount == 45 * 2080
    assert result.max_amount == 55 * 2080


def test_single_hourly_rate_annualized():
    result = extract_comp("Compensation is $52.50 per hour.")
    assert result.found
    assert result.min_amount == int(round(52.50 * 2080))


def test_hourly_ignored_when_annual_present():
    # Annual figures win; the hourly path is only a fallback.
    result = extract_comp("Salary $80,000 - $95,000. Overtime at $60/hour.")
    assert (result.min_amount, result.max_amount) == (80_000, 95_000)


# ---------------------------------------------------------------------------
# Empty / absent input must be a clean miss, never an exception.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("text", [None, "", "   ", "No compensation listed."])
def test_absent_comp_is_clean_miss(text):
    result = extract_comp(text)
    assert not result.found
    assert result.source == "not_found"


def test_source_is_echoed():
    result = extract_comp("Salary range $95,000 - $120,000", source="ashby_jsonld")
    assert result.source == "ashby_jsonld"


# ---------------------------------------------------------------------------
# Greenhouse pay_ranges: the balanced-bracket walk must not truncate on a `]`
# inside a description string, which is what a naive regex does.
# ---------------------------------------------------------------------------
def test_greenhouse_pay_ranges_basic():
    html = '<script>{"pay_ranges":[{"min":"$95,000","max":"$120,000"}]}</script>'
    result = extract_greenhouse_pay_ranges(html)
    assert (result.min_amount, result.max_amount) == (95_000, 120_000)
    assert result.source == "gh_page"


def test_greenhouse_pay_ranges_with_bracket_inside_string():
    html = (
        '{"pay_ranges":[{"min":"$90,000","max":"$100,000",'
        '"note":"see [details] in the posting"}]}'
    )
    result = extract_greenhouse_pay_ranges(html)
    assert (result.min_amount, result.max_amount) == (90_000, 100_000)


def test_greenhouse_pay_ranges_multiple_entries_spans_widest():
    html = (
        '{"pay_ranges":[{"min":"$80,000","max":"$95,000"},'
        '{"min":"$100,000","max":"$130,000"}]}'
    )
    result = extract_greenhouse_pay_ranges(html)
    assert (result.min_amount, result.max_amount) == (80_000, 130_000)


def test_greenhouse_pay_ranges_absent():
    assert not extract_greenhouse_pay_ranges("<html>no comp here</html>").found


def test_greenhouse_pay_ranges_malformed_json_is_clean_miss():
    assert not extract_greenhouse_pay_ranges('{"pay_ranges":[{oops}]}').found
