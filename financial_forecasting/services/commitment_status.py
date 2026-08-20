"""Pure status-computation for grant commitments.

Status (on-track / ahead / under / complete) is never stored on
bedrock.grant_commitment — it's always derived from the commitment's
deadline plus the latest entry in bedrock.commitment_progress_log. This
module has no DB access so the formula stays independently testable; the
caller (routes/commitments.py) resolves the inputs from the DB rows first.

Both commitment types reduce to the same "progress so far vs. time
elapsed" comparison so there's a single tolerance band to tune, not two.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

# The four statuses this module ever returns.
ON_TRACK = "on-track"
AHEAD = "ahead"
UNDER = "under"
COMPLETE = "complete"

# Tolerance band (as a fraction of the timeline) within which actual
# progress is considered "on track" relative to expected (time-elapsed)
# progress. First-pass value — tune against real commitments once this
# is running against live data.
STATUS_BAND = 0.15

# Proxy "progress fraction" for each qualitative stage (the canonical
# Program Metric Status vocabulary — see canonical-definitions.md), so
# qualitative commitments can reuse the same time-vs-progress banding as
# quantitative ones. "met" and "not-met" are handled as terminal cases
# before this table is consulted.
_QUALITATIVE_PROGRESS_WEIGHT = {
    "not-started": 0.0,
    "in-progress": 0.5,
    "pending-verification": 0.9,
}


def compute_commitment_status(
    *,
    commitment_type: str,
    target_value: Optional[float],
    latest_value: Optional[float],
    latest_qualitative_status: Optional[str],
    start_date: date,
    deadline: date,
    today: Optional[date] = None,
) -> str:
    """Derive on-track/ahead/under/complete for one commitment.

    `latest_value`/`latest_qualitative_status` are the most recent entry
    from bedrock.commitment_progress_log (or None if nothing's been
    logged yet — treated as zero/no-progress).
    """
    today = today or date.today()

    if commitment_type == "qualitative":
        status = latest_qualitative_status or "not-started"
        if status == "met":
            return COMPLETE
        if status == "not-met":
            # Terminal — a confirmed miss, regardless of date.
            return UNDER
        progress_fraction = _QUALITATIVE_PROGRESS_WEIGHT.get(status, 0.0)
    else:
        target = target_value or 0.0
        actual = latest_value or 0.0
        if target <= 0:
            return COMPLETE  # degenerate target — nothing left to track
        progress_fraction = actual / target
        if progress_fraction >= 1.0:
            return COMPLETE  # target hit, even ahead of the deadline

    # Past the deadline and not complete/met → always "under". Being
    # "on track" presupposes a future deadline still being paced toward;
    # once the date has passed, partial progress is a miss, not a pace
    # judgment.
    if today > deadline:
        return UNDER

    if deadline <= start_date:
        elapsed_fraction = 1.0
    else:
        elapsed_fraction = (today - start_date).days / (deadline - start_date).days
        elapsed_fraction = max(0.0, min(1.0, elapsed_fraction))

    if progress_fraction >= elapsed_fraction + STATUS_BAND:
        return AHEAD
    if progress_fraction <= elapsed_fraction - STATUS_BAND:
        return UNDER
    return ON_TRACK
