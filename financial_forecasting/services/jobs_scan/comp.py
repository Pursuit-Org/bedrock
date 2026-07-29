"""Salary extraction from job-description text.

Naive `$X-$Y` regexes produce confident garbage. Real misparses this guards
against, each of which became a test case in tests/test_jobs_scan_comp.py:

    "$1M+ quota"              -> a $1,000,000 salary
    "$4.6M research stipend"  -> a $4,600,000 salary
    "raised $50M Series B"    -> a $50,000,000 salary

The algorithm scores every candidate by its surrounding context and returns the
best one, rather than taking the first match. Always record `source` alongside
the numbers so downstream consumers know how much to trust them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# Trust ordering, best first. Structured page/API data beats text scraping.
COMP_SOURCES = ("api", "gh_page", "ashby_jsonld", "jd_regex", "not_found")

# Below this, a dollar figure in a JD is gift-card / coupon / fee noise.
NOISE_FLOOR = 50_000
# Nothing above this is a base salary.
SANITY_CAP = 2_000_000

_AMOUNT = r"\$\s?([\d,]+(?:\.\d+)?)\s?([KkMm])?"
_MONEY_RE = re.compile(
    _AMOUNT + r"(?:\s*(?:[-–—]|to)\s*\$?\s?([\d,]+(?:\.\d+)?)\s?([KkMm])?)?"
)

# "$45/hour", "$52.50 per hr" -- entry-level postings often quote comp hourly,
# and the dollar regex would otherwise discard them as below the noise floor.
_HOURLY_RE = re.compile(
    r"\$\s?(\d{2,3}(?:\.\d{2})?)\s*(?:/|\s+per\s+)\s?h(?:ou)?r", re.IGNORECASE
)
HOURS_PER_YEAR = 2080

# Within 20 chars BEFORE a match, these mean it is not a salary.
_HARD_NEGATIVE = re.compile(
    r"quota|stipend|grant|raised|fundrais|funding round|series\s+[a-e]\b|"
    r"valuation|bonus pool|acv|tcv|gtv|gmv",
    re.IGNORECASE,
)

# Within 15 chars AFTER a bare singleton, these mean it is not a base salary --
# unless the prefix explicitly says salary (preserves "Base salary $345K with
# OTE up to $500K").
_TAIL_NEGATIVE = re.compile(
    r"quota|ote|on-target earnings|arr\b|funding|capital", re.IGNORECASE
)

# Marks a match as an hourly rate, which the hourly path handles instead.
_HOURLY_TAIL = re.compile(r"^\s*(?:/|per\s+)?\s?h(?:ou)?r\b|^\s*(?:/|per)\s*hour",
                          re.IGNORECASE)

_SALARY_KEYWORD = re.compile(
    r"salary|base|compensation|comp range|comp band|pay range|pay band|"
    r"annualized|annually|annual|per year|per annum|/\s?yr|/\s?year|base pay",
    re.IGNORECASE,
)


@dataclass
class CompResult:
    min_amount: Optional[int] = None
    max_amount: Optional[int] = None
    source: str = "not_found"

    @property
    def found(self) -> bool:
        return self.min_amount is not None or self.max_amount is not None


def _expand(raw: str, suffix: Optional[str]) -> Optional[int]:
    """'95,000' -> 95000; '95' + 'K' -> 95000; '1.2' + 'M' -> 1200000.

    A bare figure is NOT promoted to thousands. Doing so turned "$500 wellness
    stipend" into a $500,000 salary; requiring an explicit K/M suffix or full
    digits is the safer trade, since a wrong salary is indistinguishable from a
    right one downstream.
    """
    try:
        value = float(raw.replace(",", ""))
    except ValueError:
        return None
    if suffix:
        s = suffix.lower()
        if s == "k":
            value *= 1_000
        elif s == "m":
            value *= 1_000_000
    return int(round(value))


def _score(prefix: str, suffix: str, is_range: bool) -> int:
    """Rank a candidate by context. Higher wins."""
    if _SALARY_KEYWORD.search(prefix):
        return 4
    if is_range:
        return 3
    if _SALARY_KEYWORD.search(suffix):
        return 2
    return 1


def extract_comp(text: Optional[str], source: str = "jd_regex") -> CompResult:
    """Pull the most plausible salary range out of free text.

    Returns a CompResult; `.found` is False when nothing survived. `source` is
    echoed back so callers can label where the number came from.
    """
    if not text:
        return CompResult()

    best: Optional[tuple[int, int, Optional[int]]] = None  # (score, min, max)

    for m in _MONEY_RE.finditer(text):
        # "$95K-120K" and "$95-120K" are both real: when only one side carries a
        # K/M suffix, the other inherits it.
        lo_suffix, hi_suffix = m.group(2), m.group(4)
        if m.group(3):
            lo_suffix = lo_suffix or hi_suffix
            hi_suffix = hi_suffix or m.group(2)

        low = _expand(m.group(1), lo_suffix)
        high = _expand(m.group(3), hi_suffix) if m.group(3) else None
        if low is None:
            continue

        prefix = text[max(0, m.start() - 20):m.start()]
        suffix = text[m.end():m.end() + 25]
        is_range = high is not None

        # An hourly rate is real comp but belongs to the hourly path, which
        # annualizes it. Skipping it here stops "$45 - $55 / hour" from being
        # read as a $45-$55 annual range and then dying at the noise floor.
        if _HOURLY_TAIL.search(suffix):
            continue

        # A hard negative on EITHER side disqualifies the match. Checking only
        # the prefix let "$900K bonus pool" through as a salary.
        if _HARD_NEGATIVE.search(prefix) or _HARD_NEGATIVE.search(suffix):
            continue

        # Ranges are strong evidence on their own; only gate singletons on the
        # tail, and let an explicit salary prefix override even that.
        if not is_range:
            if low > SANITY_CAP:
                continue
            if _TAIL_NEGATIVE.search(suffix) and not _SALARY_KEYWORD.search(prefix):
                continue

        # Compare against the floor using the low end of whatever we matched.
        if low < NOISE_FLOOR and (high is None or high < NOISE_FLOOR):
            continue

        score = _score(prefix, suffix, is_range)
        if best is None or score > best[0]:
            best = (score, low, high)

    if best is not None:
        _, low, high = best
        return CompResult(min_amount=low, max_amount=high or low, source=source)

    # Nothing in annual terms -- try hourly before giving up.
    hourly = _extract_hourly(text)
    if hourly.found:
        return hourly

    return CompResult()


def _extract_hourly(text: str) -> CompResult:
    """Annualize hourly rates at 2080h. Returns a range when two rates appear."""
    # Ranges first. In "$45 - $55 / hour" only the second figure carries the
    # unit, so a single-rate scan would see just $55 and report a point value.
    m = re.search(
        r"\$\s?(\d{2,3}(?:\.\d{2})?)\s*(?:[-–—]|to)\s*\$?\s?"
        r"(\d{2,3}(?:\.\d{2})?)\s*(?:/|\s+per\s+)\s?h(?:ou)?r",
        text, re.IGNORECASE,
    )
    if m and not _HARD_NEGATIVE.search(text[max(0, m.start() - 20):m.start()]):
        return CompResult(
            int(round(float(m.group(1)) * HOURS_PER_YEAR)),
            int(round(float(m.group(2)) * HOURS_PER_YEAR)),
            "jd_regex",
        )

    rates: list[int] = []
    for m in _HOURLY_RE.finditer(text):
        prefix = text[max(0, m.start() - 20):m.start()]
        if _HARD_NEGATIVE.search(prefix):
            continue
        try:
            rates.append(int(round(float(m.group(1)) * HOURS_PER_YEAR)))
        except ValueError:
            continue

    if not rates:
        return CompResult()
    return CompResult(min(rates), max(rates), "jd_regex")


def extract_greenhouse_pay_ranges(html: str) -> CompResult:
    """Pull Greenhouse's structured `pay_ranges` array out of a rendered page.

    Greenhouse never returns comp in its API, so this reads the embedded JSON on
    the job page. A naive regex truncates on a `]` inside a description string,
    so the array is extracted with a string-aware balanced-bracket walk.
    """
    marker = '"pay_ranges":'
    idx = html.find(marker)
    if idx == -1:
        return CompResult()

    start = html.find("[", idx)
    if start == -1:
        return CompResult()

    depth, in_string, escaped, end = 0, False, False, None
    for i, ch in enumerate(html[start:], start=start):
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        return CompResult()

    import json

    try:
        entries = json.loads(html[start:end])
    except (ValueError, TypeError):
        return CompResult()

    lows, highs = [], []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        for key, bucket in (("min", lows), ("max", highs)):
            raw = entry.get(key)
            if raw is None:
                continue
            digits = re.sub(r"[^\d]", "", str(raw))
            if digits:
                bucket.append(int(digits))

    if not lows and not highs:
        return CompResult()
    return CompResult(min(lows) if lows else None,
                      max(highs) if highs else None, "gh_page")
