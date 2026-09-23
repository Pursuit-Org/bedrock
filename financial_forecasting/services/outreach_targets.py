"""Hand-edited targets for the Outreach Dashboard scorecard.

The scorecard's "Δ Target" column compares actual volume against a goal per
stage / activity type, per period length. These change rarely enough that a
human editing this dict is simpler than a DB table + CRUD UI — so v1 keeps them
here. If they ever need to be per-owner or editable in-app, promote to a
`bedrock.outreach_target` table; the endpoint reads through these helpers so the
call sites won't change.

Keys match the metric keys the scorecard endpoint emits:
  accounts_activated | total_outreach_activity | direct_email_sent |
  linkedin_message_sent | text_sent | facilitated_intro_sent | total_calls |
  call_discovery | call_general | converted_opportunities
Granularity keys match the API's granularity param: day | week | month.

USER_PIPELINE_TARGETS lived here until 2026-09-21, alongside the User Pipeline
table it fed. Both went when nothing rendered that table any more.
"""

from typing import Optional

# Working days in a week, and weeks in a month, for spreading a weekly goal.
#
# WEEKS_PER_MONTH is 4, not the calendar-accurate 4.33 (Kwame 2026-09-21): the
# monthly target is "four weeks of the weekly one", which is what he manages to
# and what he expects to read — 150 a week is 600 a month, not 649.
#
# Know the consequence before trusting a monthly row: an average month is 4.33
# weeks long, so a full month measured against 4 weeks of target is about 8%
# easier to hit than the same weeks measured one at a time. Weekly is the
# honest view; monthly is a convenience.
WORK_DAYS_PER_WEEK = 5
WEEKS_PER_MONTH = 4


def _weekly(n: int) -> dict[str, Optional[int]]:
    """A weekly goal, spread to the other two granularities.

    Kwame sets the number he manages to, which is the weekly one. The other two
    are arithmetic on it, not separate goals — replace either the moment the
    team has a real one.

    A goal that does not survive the division to a day reports NO daily target
    rather than 0. Converting 2 contacts a week is a real goal; "convert 0 today"
    is not one, and it rendered as a green 0 in Δ to Target — a day with nothing
    converted read as a day on plan. An explicit _weekly(0) still spreads to 0
    everywhere, because there the zero IS the goal.
    """
    per_day = round(n / WORK_DAYS_PER_WEEK)
    return {"day": per_day if (n == 0 or per_day >= 1) else None,
            "week": n,
            "month": n * WEEKS_PER_MONTH}

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
OWNER_ACTIVITY_TARGETS: dict[str, dict[str, dict[str, Optional[int]]]] = {
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


def _team_total(metric: str) -> dict[str, Optional[int]]:
    """The team goal for a metric: the sum of the personal goals.

    Summed rather than typed a second time, so moving one person's number can
    never leave the team figure quietly stale.
    """
    return {g: sum(t.get(metric, {}).get(g) or 0 for t in OWNER_ACTIVITY_TARGETS.values())
            for g in ("day", "week", "month")}


# Team goals. Only the three totals appear: a metric absent from this dict has
# no target, which the API reports as null and the UI as a dash.
ACTIVITY_PIPELINE_TARGETS: dict[str, dict[str, Optional[int]]] = {
    # The two totals carry a goal, and Discovery Calls carries one because the
    # ask is about the MIX, not extra volume: it is the same 15 calls, with an
    # expectation about what kind they are. Every other row is a breakdown of
    # how a total was hit, and a target on each would double-count the week.
    "total_outreach_activity": _team_total("total_outreach_activity"),
    "total_calls":            _team_total("total_calls"),
    "call_discovery":         _team_total("call_discovery"),
    # The two ends of the funnel (Kwame 2026-09-21). Typed directly rather than
    # summed, because neither is anyone's personal number: opening a dormant
    # account and converting one to an opportunity are team outcomes, and
    # splitting 20 four ways would invent commitments nobody made. That is also
    # why an owner column for either reads a dash, not a share.
    "accounts_activated":      _weekly(20),
    "converted_opportunities": _weekly(2),
    # Nothing else carries a number. The individual channels are a breakdown of
    # HOW a total was hit, not commitments of their own — the team owes 150
    # touches, not 150 emails — and a 0 in the Target column read as a goal of
    # zero rather than "no goal here". Absent means the API sends null and the
    # UI renders a dash (Kwame 2026-09-21).
}


def activity_pipeline_target(metric: str, granularity: str,
                             owner: Optional[str] = None) -> Optional[int]:
    """Target for an activity-pipeline metric, or None if unset.

    With `owner`, the personal goal — never the team's. See OWNER_ACTIVITY_TARGETS.
    """
    if owner:
        return OWNER_ACTIVITY_TARGETS.get(owner.strip().lower(), {}).get(metric, {}).get(granularity)
    return ACTIVITY_PIPELINE_TARGETS.get(metric, {}).get(granularity)
