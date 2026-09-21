"""Hand-edited targets for the Outreach Dashboard scorecard.

The scorecard's "Δ Target" column compares actual volume against a goal per
stage / activity type, per period length. These change rarely enough that a
human editing this dict is simpler than a DB table + CRUD UI — so v1 keeps them
here. If they ever need to be per-owner or editable in-app, promote to a
`bedrock.outreach_target` table; the endpoint reads through these helpers so the
call sites won't change.

Keys match the metric keys the scorecard endpoint emits:
  total_outreach_activity | direct_email_sent | linkedin_message_sent |
  text_sent | facilitated_intro_sent | total_calls | call_discovery |
  call_general
Granularity keys match the API's granularity param: day | week | month.

USER_PIPELINE_TARGETS lived here until 2026-09-21, alongside the User Pipeline
table it fed. Both went when nothing rendered that table any more.
"""

from typing import Optional

# Targets are 0 for now (per product) — the "Δ Target" column renders "—" until
# real goals are set. Bump these when the team agrees on per-period goals.
_ZERO = {"day": 0, "week": 0, "month": 0}


def _weekly(n: int) -> dict[str, int]:
    """A weekly goal, spread to the other two granularities.

    Kwame sets the number he manages to, which is the weekly one. Daily divides
    by five working days and monthly multiplies by 4.33 weeks, both rounded.
    They are arithmetic on his number, not separate goals — replace either the
    moment the team has a real one.
    """
    return {"day": round(n / 5), "week": n, "month": round(n * 4.33)}

# Per-person weekly goals (Kwame 2026-09-21). These are the source: the team
# figures below are their SUM, because that is how Kwame built them —
# 10 + 45 + 45 + 50 = 150 outreach, 0 + 5 + 5 + 5 = 15 calls.
#
# An owner view reads ONLY from here, never from the team dict. A person's row
# next to the team's 150 would read as a miss every week.
#
# CAVEAT worth knowing before trusting the team row: kwame@pursuit.org carries
# 10 of the 150, but he is not in JOBS_TEAM_EMAILS, so the "Jobs Team" SCOPE
# does not count his sends. The team view is therefore ~10 a week short of its
# own target by construction. Fixing it means adding him to JOBS_TEAM_EMAILS,
# which moves every team-scoped number across the Jobs pages, not just this one.
OWNER_ACTIVITY_TARGETS: dict[str, dict[str, dict[str, int]]] = {
    # call_discovery matches total_calls on purpose (Kwame 2026-09-21): the ask
    # is that every call in the goal is a discovery call. General carries no
    # target, so a week hit entirely on check-ins shows Total Calls met and
    # Discovery short, which is exactly the signal wanted.
    "avni@pursuit.org":             {"total_outreach_activity": _weekly(45),
                                     "total_calls":             _weekly(5),
                                     "call_discovery":          _weekly(5)},
    "damon.kornhauser@pursuit.org": {"total_outreach_activity": _weekly(45),
                                     "total_calls":             _weekly(5),
                                     "call_discovery":          _weekly(5)},
    "devika@pursuit.org":           {"total_outreach_activity": _weekly(50),
                                     "total_calls":             _weekly(5),
                                     "call_discovery":          _weekly(5)},
    # Kwame carries outreach but no call goal. An explicit 0 beats leaving it
    # out: the row then reads "the target is none" rather than "nobody set one".
    "kwame@pursuit.org":            {"total_outreach_activity": _weekly(10),
                                     "total_calls":             _weekly(0),
                                     "call_discovery":          _weekly(0)},
}


def _team_total(metric: str) -> dict[str, int]:
    """The team goal for a metric: the sum of the personal goals.

    Summed rather than typed a second time, so moving one person's number can
    never leave the team figure quietly stale.
    """
    return {g: sum(t.get(metric, {}).get(g, 0) for t in OWNER_ACTIVITY_TARGETS.values())
            for g in ("day", "week", "month")}


# Raw activity rows sent/received in the period.
ACTIVITY_PIPELINE_TARGETS: dict[str, dict[str, int]] = {
    # The two totals carry a goal, and Discovery Calls carries one because the
    # ask is about the MIX, not extra volume: it is the same 15 calls, with an
    # expectation about what kind they are. Every other row is a breakdown of
    # how a total was hit, and a target on each would double-count the week.
    "total_outreach_activity": _team_total("total_outreach_activity"),
    "total_calls":            _team_total("total_calls"),
    "call_discovery":         _team_total("call_discovery"),
    "call_general":           dict(_ZERO),
    "direct_email_sent":      dict(_ZERO),
    "linkedin_message_sent":  dict(_ZERO),
    "text_sent":              dict(_ZERO),
    "facilitated_intro_sent": dict(_ZERO),
    "engagement":             dict(_ZERO),
    "direct_email_response":  dict(_ZERO),
}


def activity_pipeline_target(metric: str, granularity: str,
                             owner: Optional[str] = None) -> Optional[int]:
    """Target for an activity-pipeline metric, or None if unset.

    With `owner`, the personal goal — never the team's. See OWNER_ACTIVITY_TARGETS.
    """
    if owner:
        return OWNER_ACTIVITY_TARGETS.get(owner.strip().lower(), {}).get(metric, {}).get(granularity)
    return ACTIVITY_PIPELINE_TARGETS.get(metric, {}).get(granularity)
