"""Derives Account Status per the RM playbook.

Status definitions (verbatim from the playbook):
  Prospect       Target account. Pursuit has never won business with this
                 account across any record type. No opportunity has ever
                 made it past Ask in Progress.
  Pursuing       There is an open, active opportunity at this account.
  Stewarding     There is an active award with this account, but no open
                 opportunity.
  Re-activating  There are past awards or late-stage opportunities but
                 no open opportunities. There is activity within the
                 last 3 months.
  Dormant        There are past awards or late-stage opportunities but
                 no open opportunities, and no activity in the last 3
                 months.

This is a pure derivation — no schema change required. The status is
computed on-the-fly when the backend serves `/api/salesforce/accounts`.

If perf becomes a concern at higher account counts, materialize the
status into a `bedrock.account_status_cache` table on a periodic +
on-mutation recompute. v1 keeps it computed-on-read; 2 k accounts
benchmarks at < 100 ms once opp/award/activity lookups are batched.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

STATUS_INACTIVE = "Inactive"
STATUS_PROSPECT = "Prospect"
STATUS_PURSUING = "Pursuing"
STATUS_STEWARDING = "Stewarding"
STATUS_REACTIVATING = "Re-activating"
STATUS_DORMANT = "Dormant"

ACCOUNT_STATUSES = (
    STATUS_INACTIVE,
    STATUS_PROSPECT,
    STATUS_PURSUING,
    STATUS_STEWARDING,
    STATUS_REACTIVATING,
    STATUS_DORMANT,
)

# Stage rank — anything strictly past "Ask in Progress" (rank > 2)
# is the "late stage" history that gates Re-activating / Dormant.
# Mirrors frontend SF_STAGE_OPTIONS order.
STAGE_RANK: Dict[str, int] = {
    "New Lead": 0,
    "Qualifying": 1,
    "Ask in Progress": 2,
    "Proposal Submitted": 3,
    "Contracting": 4,
    "Collecting / In Effect": 5,
    "Closed / Completed": 6,
    "Closed Won": 6,
    "closed-won": 6,
    "Closed Lost": 7,
    "Withdrawn": 8,
}
LATE_STAGE_RANK = 3  # strictly past Ask in Progress

# Maximum stage rank that still counts as "in pursuit". Anything beyond
# this is delivery / post-close work, even if SF's IsClosed flag is
# still false. Contracting (rank 4) IS pursuit (the deal isn't won
# until paper signs); Collecting / In Effect (rank 5) is delivery —
# the money is committed, RM work has shifted from winning to
# stewardship. Without this cap, accounts with a Collecting opp
# misclassify as Pursuing instead of Stewarding.
PURSUIT_STAGE_RANK_MAX = 4

REACTIVATING_WINDOW_DAYS = 90  # "last 3 months"

# Award statuses that count as "past" (i.e. eligible for the
# Re-activating / Dormant gates). "Active" is handled separately as
# the Stewarding signal.
PAST_AWARD_STATUSES = {"Closed", "Closing", "Did Not Fulfill"}


def _is_late_stage(stage_name: Optional[str]) -> bool:
    if not stage_name:
        return False
    return STAGE_RANK.get(stage_name, -1) >= LATE_STAGE_RANK


def _is_open_active(opp: Dict[str, Any]) -> bool:
    """An opportunity counts toward "Pursuing" when SF marks it
    not-closed AND its stage is still in the pursuit phase
    (Contracting or earlier). Collecting / In Effect onward is
    delivery, not pursuit — those opps belong to Stewarding, gated on
    the award row instead.

    The previously-required Active_Opportunity__c flag was dropped:
    RMs were leaving open opps with that flag set to false and not
    seeing them reflect in the account's Pursuing status. Any open
    opp now counts so the user-visible signal matches what they see
    on the opp itself."""
    if opp.get("IsClosed"):
        return False
    rank = STAGE_RANK.get(opp.get("StageName") or "", -1)
    return rank >= 0 and rank <= PURSUIT_STAGE_RANK_MAX


def compute_account_status(
    account_id: str,
    opps_by_account: Dict[str, List[Dict[str, Any]]],
    awards_by_opp: Dict[str, List[Dict[str, Any]]],
    latest_activity_by_account: Dict[str, datetime],
    now: Optional[datetime] = None,
    is_active: bool = True,
) -> str:
    """Pure derivation. Caller assembles the three lookup maps.

    Args:
        account_id: SF Account Id.
        opps_by_account: AccountId → list of SfOpportunity dicts. Each
            dict needs Id, IsClosed, IsWon, StageName.
        awards_by_opp: opportunity_id → list of bedrock award dicts.
            Each dict needs award_status.
        latest_activity_by_account: AccountId → most recent activity_date
            as a tz-aware datetime. Missing accounts mean "no activity".
        now: defaults to datetime.now(tz=UTC). Pass in tests.
        is_active: if False (SF Active__c unchecked), returns Inactive
            immediately, overriding all playbook-derived statuses.
    """
    if not is_active:
        return STATUS_INACTIVE

    if now is None:
        now = datetime.now(timezone.utc)

    opps = opps_by_account.get(account_id, [])

    # 1. Pursuing — at least one open + active opp.
    if any(_is_open_active(o) for o in opps):
        return STATUS_PURSUING

    # 2. Stewarding — at least one active award (and no open opp, which
    # is already ruled out by the above branch).
    awards: List[Dict[str, Any]] = []
    for o in opps:
        oid = o.get("Id")
        if oid:
            awards.extend(awards_by_opp.get(oid, []))
    if any(a.get("award_status") == "Active" for a in awards):
        return STATUS_STEWARDING

    # 3. Has any history? Past award OR late-stage opp (past "Ask in
    # Progress"). If neither, this account has never been touched
    # beyond very early prospecting → Prospect.
    has_past_award = any(a.get("award_status") in PAST_AWARD_STATUSES for a in awards)
    has_late_stage = any(_is_late_stage(o.get("StageName")) for o in opps)
    if not (has_past_award or has_late_stage):
        return STATUS_PROSPECT

    # 4. Re-activating vs Dormant — depends on whether there's activity
    # within the last REACTIVATING_WINDOW_DAYS.
    latest = latest_activity_by_account.get(account_id)
    if latest is not None and (now - latest) <= timedelta(days=REACTIVATING_WINDOW_DAYS):
        return STATUS_REACTIVATING
    return STATUS_DORMANT


def build_lookups(
    opps: Iterable[Dict[str, Any]],
    awards: Iterable[Dict[str, Any]],
    activities: Iterable[Dict[str, Any]],
) -> tuple[
    Dict[str, List[Dict[str, Any]]],
    Dict[str, List[Dict[str, Any]]],
    Dict[str, datetime],
]:
    """Group inputs by the join keys compute_account_status needs.

    - opps_by_account is grouped by AccountId
    - awards_by_opp is grouped by opportunity_id
    - latest_activity_by_account picks the max activity_date per account_id
    """
    opps_by_account: Dict[str, List[Dict[str, Any]]] = {}
    for o in opps:
        aid = o.get("AccountId")
        if aid:
            opps_by_account.setdefault(aid, []).append(o)

    awards_by_opp: Dict[str, List[Dict[str, Any]]] = {}
    for a in awards:
        oid = a.get("opportunity_id")
        if oid:
            awards_by_opp.setdefault(oid, []).append(a)

    latest_activity_by_account: Dict[str, datetime] = {}
    for act in activities:
        aid = act.get("account_id")
        if not aid:
            continue
        d = act.get("activity_date")
        if d is None:
            continue
        prev = latest_activity_by_account.get(aid)
        if prev is None or d > prev:
            latest_activity_by_account[aid] = d

    return opps_by_account, awards_by_opp, latest_activity_by_account
