"""Hand-edited targets for the Outreach Dashboard scorecard.

The scorecard's "Δ Target" column compares actual volume against a goal per
stage / activity type, per period length. These change rarely enough that a
human editing this dict is simpler than a DB table + CRUD UI — so v1 keeps them
here. If they ever need to be per-owner or editable in-app, promote to a
`bedrock.outreach_target` table; the endpoint reads through these helpers so the
call sites won't change.

Keys match the metric keys the scorecard endpoint emits:
  user pipeline     — flagged | initial_outreach | active | handed_off
  activity pipeline — total_outreach_activity | direct_email_sent |
                      linkedin_message_sent | facilitated_intro_sent |
                      total_calls | call_discovery | call_solution |
                      call_general | engagement | direct_email_response
Granularity keys match the API's granularity param: day | week | month.
"""

from typing import Optional

# Targets are 0 for now (per product) — the "Δ Target" column renders "—" until
# real goals are set. Bump these when the team agrees on per-period goals.
_ZERO = {"day": 0, "week": 0, "month": 0}

# Contacts ENTERING each funnel stage in the period (flow, not occupancy).
USER_PIPELINE_TARGETS: dict[str, dict[str, int]] = {
    "flagged":          dict(_ZERO),  # Lead Sourced
    "initial_outreach": dict(_ZERO),  # Outreached
    "active":           dict(_ZERO),  # Qualified Lead
    "handed_off":       dict(_ZERO),  # Committed
}

# Raw activity rows sent/received in the period.
ACTIVITY_PIPELINE_TARGETS: dict[str, dict[str, int]] = {
    "total_outreach_activity": dict(_ZERO),
    "total_calls":            dict(_ZERO),
    "call_discovery":         dict(_ZERO),
    "call_solution":          dict(_ZERO),
    "call_general":           dict(_ZERO),
    "direct_email_sent":      dict(_ZERO),
    "linkedin_message_sent":  dict(_ZERO),
    "facilitated_intro_sent": dict(_ZERO),
    "engagement":             dict(_ZERO),
    "direct_email_response":  dict(_ZERO),
}


def user_pipeline_target(stage: str, granularity: str) -> Optional[int]:
    """Target for a user-pipeline stage at a granularity, or None if unset."""
    return USER_PIPELINE_TARGETS.get(stage, {}).get(granularity)


def activity_pipeline_target(metric: str, granularity: str) -> Optional[int]:
    """Target for an activity-pipeline metric at a granularity, or None if unset."""
    return ACTIVITY_PIPELINE_TARGETS.get(metric, {}).get(granularity)
