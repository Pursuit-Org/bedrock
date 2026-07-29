"""Deterministic pre-filter, driven by DB-backed criteria.

Runs BEFORE the expensive detail fetch and before any LLM call, on data the
board list endpoint already gave us (title + location). Two reasons that
ordering is load-bearing: Greenhouse comp costs one extra request per posting,
and LLM scoring costs money per posting.

Posture is RECALL. A false drop -- a good role never seen -- is worse than a
false include, which a reviewer dismisses in two seconds. So: absent data
passes, ambiguous cases pass with a flag, and every drop is counted by reason.
A drop-reason count nobody reads is how "we covered everything" becomes false.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Optional

# US state codes matched as whole words, so "DE" doesn't fire on "Dedham".
_STATE_RE_CACHE: dict[tuple[str, ...], re.Pattern] = {}


@dataclass
class FunnelCounts:
    """Per-run drop accounting. Printed with every scan."""

    raw: int = 0
    passing: int = 0
    drops: Counter = field(default_factory=Counter)

    def drop(self, reason: str) -> None:
        self.drops[reason] += 1

    def as_dict(self) -> dict[str, Any]:
        return {"raw": self.raw, "passing": self.passing, "drops": dict(self.drops)}

    def render(self) -> str:
        lines = [f"  raw postings        {self.raw}"]
        for reason, count in self.drops.most_common():
            lines.append(f"  dropped: {reason:<18} {count}")
        lines.append(f"  passing             {self.passing}")
        return "\n".join(lines)


def _state_re(states: tuple[str, ...]) -> re.Pattern:
    if states not in _STATE_RE_CACHE:
        joined = "|".join(re.escape(s) for s in states)
        _STATE_RE_CACHE[states] = re.compile(rf"\b({joined})\b", re.IGNORECASE)
    return _STATE_RE_CACHE[states]


def _seniority_kill(title: str, criteria: dict) -> Optional[str]:
    """Return the matched kill term, or None.

    Manager-family titles are exempted first: Product/Project/Account/Program
    Manager are individual-contributor titles, not people management, and
    killing them silently removes a whole target family.
    """
    seniority = criteria.get("seniority") or {}
    lowered = title.lower()

    for exception in seniority.get("manager_exceptions") or []:
        if exception.lower() in lowered:
            return None

    for term in seniority.get("kill") or []:
        if re.search(rf"\b{re.escape(term.lower())}\b", lowered):
            return term
    return None


def location_matches(location: Optional[str], is_remote: bool, criteria: dict) -> bool:
    geo = criteria.get("geography") or {}

    if is_remote and geo.get("remote_ok", True):
        return True

    if not location or not location.strip():
        # Absent location is not evidence of a miss.
        return bool(geo.get("absent_location_passes", True))

    lowered = location.lower()
    if geo.get("remote_ok", True) and any(
        kw in lowered for kw in ("remote", "anywhere", "distributed", "work from home")
    ):
        return True

    for metro in geo.get("metros") or []:
        if metro.lower() in lowered:
            return True

    states = tuple(geo.get("states") or ())
    if states and _state_re(states).search(location):
        return True

    # Whole-country postings are ambiguous, not misses -- an East Coast opening
    # is often listed as "United States".
    return any(kw in lowered for kw in ("united states", "usa", "u.s.", "nationwide"))


def comp_in_band(
    salary_min: Optional[int], salary_max: Optional[int], criteria: dict
) -> tuple[bool, Optional[str]]:
    """Band check, not a floor check. Returns (passes, flag)."""
    comp = criteria.get("comp") or {}
    floor = comp.get("min", 50_000)
    ceiling_headroom = comp.get("ceiling_headroom", 160_000)

    if salary_min is None and salary_max is None:
        # Most postings publish no comp. Dropping them would gut recall.
        if comp.get("unknown_passes", True):
            return True, "comp_unknown"
        return False, "comp_unknown"

    # Entirely below the floor: usually support or contract work mislabeled.
    if salary_max is not None and salary_max < floor:
        return False, None

    # Entirely above a generous ceiling: a senior role that won't hire entry.
    if salary_min is not None and salary_min > ceiling_headroom:
        return False, None

    return True, None


def prefilter(
    roles: list, criteria: dict, counts: Optional[FunnelCounts] = None
) -> tuple[list, FunnelCounts]:
    """Filter roles on title + location only. Comp is checked post-enrichment.

    Returns (survivors, counts). Survivors carry a `.flags` list when something
    was ambiguous rather than clean.
    """
    counts = counts or FunnelCounts()
    survivors = []

    for role in roles:
        counts.raw += 1
        title = (role.title or "").strip()

        if not title:
            counts.drop("no_title")
            continue

        killed_by = _seniority_kill(title, criteria)
        if killed_by:
            counts.drop("seniority")
            role.drop_reason = f"seniority:{killed_by}"
            continue

        if not location_matches(role.location, role.is_remote, criteria):
            counts.drop("location")
            role.drop_reason = f"location:{role.location}"
            continue

        survivors.append(role)

    counts.passing = len(survivors)
    return survivors, counts


def postfilter_comp(
    roles: list, criteria: dict, counts: FunnelCounts
) -> list:
    """Comp band check, run after enrichment has resolved salary."""
    survivors = []
    for role in roles:
        passes, flag = comp_in_band(role.salary_min, role.salary_max, criteria)
        if not passes:
            counts.drop("comp_band")
            role.drop_reason = (
                f"comp_band:{role.salary_min}-{role.salary_max}"
            )
            continue
        if flag:
            existing = getattr(role, "flags", None) or []
            role.flags = existing + [flag]
        survivors.append(role)

    counts.passing = len(survivors)
    return survivors
