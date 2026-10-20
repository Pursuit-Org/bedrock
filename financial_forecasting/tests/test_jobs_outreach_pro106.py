"""PRO-106: the Monday Outreach view.

Targets that fit any range, new outreach vs follow-ups on live opportunities,
accounts activated per person, where outreach is stuck, and an account's
contacts with their outreach status. No database: the rules are pure, and the
routes run over FakeConn.
"""

from datetime import date, datetime, timedelta, timezone

import pytest

from services import jobs_metrics as jm
from services import jobs_targets_store
from services import outreach_counting as oc
from services import outreach_targets as ot
from tests.jobs_fakes import EVENTS, PRIOR_EVENTS, FakeConn, event_row, make_jobs_client

TEAM = ["avni@pursuit.org", "damon.kornhauser@pursuit.org", "devika@pursuit.org"]
T0 = datetime(2026, 10, 14, 15, 0, tzinfo=timezone.utc)      # a Wednesday


@pytest.fixture(autouse=True)
def _fallback_targets():
    """The hardcoded targets (Avni 45, team accounts 20), not a live store."""
    jobs_targets_store.reset()
    yield
    jobs_targets_store.reset()


@pytest.fixture
def _clear_overrides():
    from main import app
    yield
    app.dependency_overrides.clear()


# ── targets for any range ────────────────────────────────────────────────────

def test_weekdays_in_a_range():
    mon = date(2026, 10, 12)
    assert ot.weekdays_in(mon, mon + timedelta(days=7)) == 5          # Mon-Sun
    assert ot.weekdays_in(mon, mon + timedelta(days=3)) == 3          # Mon-Wed
    assert ot.weekdays_in(mon + timedelta(days=5), mon + timedelta(days=7)) == 0   # Sat-Sun
    assert ot.weekdays_in(mon, mon + timedelta(days=14)) == 10


def test_a_range_gets_a_fifth_of_the_weekly_goal_per_weekday():
    mon = date(2026, 10, 12)
    week = (mon, mon + timedelta(days=7))
    assert ot.target_for_window("total_outreach_activity", *week, owner="avni@pursuit.org") == 45
    # This week so far, on a Wednesday: three fifths.
    assert ot.target_for_window("total_outreach_activity", mon, mon + timedelta(days=3),
                                owner="avni@pursuit.org") == 27
    # A fortnight is two weeks' worth, not one.
    assert ot.target_for_window("accounts_activated", mon, mon + timedelta(days=14)) == 40


def test_a_weekend_has_no_goal_rather_than_a_goal_of_zero():
    sat = date(2026, 10, 17)
    assert ot.target_for_window("accounts_activated", sat, sat + timedelta(days=2)) is None
    # A goal that IS zero stays zero.
    assert ot.target_for_window("total_calls", sat, sat + timedelta(days=2),
                                owner="kwame@pursuit.org") == 0


def test_no_goal_set_is_none():
    mon = date(2026, 10, 12)
    assert ot.target_for_window("text_sent", mon, mon + timedelta(days=7)) is None
    assert ot.target_for_window("accounts_activated", mon, mon + timedelta(days=7),
                                owner="avni@pursuit.org") is None


def test_a_range_needs_its_dates(_clear_overrides):
    r = make_jobs_client(FakeConn()).get("/api/jobs/outreach/summary?granularity=range")
    assert r.status_code == 400


# ── new outreach vs follow-ups ───────────────────────────────────────────────

def _send(ts, contact_id=1, **kw):
    return oc.Event(kind=kw.pop("kind", "email"), ts=ts, sender="avni@pursuit.org",
                    activity_id=kw.pop("activity_id", str(ts)), contact_id=contact_id,
                    source="gmail-sync", **kw)


def test_a_send_while_the_opportunity_is_open_is_a_follow_up():
    opened, closed = T0 - timedelta(days=10), T0 + timedelta(days=10)
    spans = oc.open_opportunity_spans([{"contact_id": 1, "created_at": opened, "closed_at": closed}])
    before, during, after = (_send(opened - timedelta(days=1)), _send(T0),
                             _send(closed + timedelta(days=1)))
    assert not oc.is_follow_up(before, spans)
    assert oc.is_follow_up(during, spans)
    assert not oc.is_follow_up(after, spans)
    assert oc.split_follow_ups([before, during, after], spans) == {"new": 2, "follow_up": 1}


def test_a_send_that_also_reached_someone_on_the_opportunity_is_a_follow_up():
    spans = oc.open_opportunity_spans([{"contact_id": 2, "created_at": T0 - timedelta(days=1),
                                        "closed_at": None}])
    assert oc.is_follow_up(_send(T0, contact_id=1, contact_ids=(1, 2)), spans)


def test_the_split_counts_sends_only_and_adds_up_to_outreach():
    spans = oc.open_opportunity_spans([{"contact_id": 1, "created_at": T0 - timedelta(days=1),
                                        "closed_at": None}])
    events = [_send(T0), _send(T0, kind="linkedin", activity_id="li"),
              _send(T0, kind="call", activity_id="call"), _send(T0, contact_id=7, activity_id="x")]
    split = oc.split_follow_ups(events, spans)
    assert split == {"new": 1, "follow_up": 2}
    assert sum(split.values()) == oc.count(events).outreach


def test_the_follow_up_rule_uses_the_rollup_contacts():
    """Who is on an opportunity is activity_scope_ctes' opp_contacts: linked
    contacts, else everyone at the account."""
    sql = jm.open_opportunity_contacts_sql()
    assert "opp_contacts" in sql and "No linked contacts: everyone at the opportunity's account" in sql
    assert jm.OPPORTUNITY_CLOSED_AT_SQL in sql


# ── where outreach is stuck ──────────────────────────────────────────────────

def _member(cid, owner="avni@pursuit.org", stage="assigned", **kw):
    return {"contact_id": cid, "owner": owner, "stage": stage, "call_booked": False,
            "intro_from": None, "revisit_date": None, "not_a_fit_reason": None, **kw}


def test_the_reason_is_the_first_one_recorded():
    assert jm.stuck_reason(_member(1, intro_from="Nick", stage="revisit"), False) == \
        {"kind": "intro", "detail": "Nick"}
    assert jm.stuck_reason(_member(1, stage="revisit", revisit_date=date(2026, 11, 1)), False) == \
        {"kind": "revisit", "detail": "2026-11-01"}
    assert jm.stuck_reason(_member(1, stage="not_a_fit", not_a_fit_reason="No roles"), False) == \
        {"kind": "not_a_fit", "detail": "No roles"}
    assert jm.stuck_reason(_member(1), False) == {"kind": "none", "detail": None}


def test_reached_or_booked_is_not_stuck():
    assert jm.stuck_reason(_member(1), True) is None
    # A meeting Nick set up, with no outreach behind it.
    assert jm.stuck_reason(_member(1, stage="call_booked", call_booked=True), False) is None


def test_stuck_numbers_per_owner():
    rows = [_member(1), _member(2), _member(3, call_booked=True, stage="call_booked"),
            _member(4, stage="revisit"), _member(5, owner=None)]
    n = jm.stuck_numbers(rows, reached=[1, 3])
    a = n["avni@pursuit.org"]
    assert (a["assigned"], a["reached"], a["call_booked"], a["not_reached"]) == (4, 2, 1, 2)
    assert a["reasons"] == {"intro": 0, "revisit": 1, "not_a_fit": 0, "none": 1}
    assert n[None]["not_reached"] == 1


def test_the_reference_query_names_each_measure_column():
    sql = jm.stuck_reference_sql()
    for col in ("assigned", "reached", "call_booked"):
        assert f"AS {col}" in sql
    assert "lower(coalesce(m.owner_email, c.owner_email)) AS owner" in sql


CATALOG = "FROM bedrock.contact_tag_catalog WHERE active"
CAMPAIGN = "SELECT DISTINCT ON (g.campaign"
DETAIL = "AS intro_from"


def _campaign_row(cid, name=None):
    return {"campaign": "operation_35", "contact_id": cid, "full_name": name or f"C{cid}",
            "company": "Acme", "account_key": "acme", "in_pipeline": True,
            "stage": "assigned", "owner_email": None, "stage_entered_at": None}


def _detail_row(cid, owner="avni@pursuit.org", **kw):
    return {"contact_id": cid, "owner": owner, "assigned_at": T0 - timedelta(days=20),
            "revisit_date": None, "not_a_fit_reason": None, "call_booked": False,
            "intro_from": None, **kw}


def _stuck_conn(details, events=()):
    return FakeConn(lists={
        CATALOG: [{"slug": "operation_35_cohort_a", "label": "Op 35 A", "sort_order": 1,
                   "owner_email": None, "is_current": True},
                  {"slug": "board", "label": "Board", "sort_order": 2,
                   "owner_email": None, "is_current": False}],
        CAMPAIGN: [_campaign_row(d["contact_id"]) for d in details],
        DETAIL: details,
        "DISTINCT lower(email) AS email": [{"email": "nick@pursuit.org"}],
        EVENTS: list(events),
    })


def test_stuck_defaults_to_the_current_campaign_and_counts_by_owner(_clear_overrides):
    details = [_detail_row(1), _detail_row(2), _detail_row(3, call_booked=True),
               _detail_row(4, owner="devika@pursuit.org", intro_from="Nick Smith"),
               _detail_row(5, owner=None)]
    conn = _stuck_conn(details, events=[event_row(ts=T0, contact_id=1)])
    r = make_jobs_client(conn).get("/api/jobs/outreach/stuck?scope=pursuit")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["campaign"] == "operation_35"
    by = {row["owner"]: row for row in d["rows"]}
    assert (by["avni@pursuit.org"]["assigned"], by["avni@pursuit.org"]["reached"],
            by["avni@pursuit.org"]["call_booked"], by["avni@pursuit.org"]["not_reached"]) == (3, 1, 1, 1)
    assert by["devika@pursuit.org"]["reasons"]["intro"] == 1
    assert d["rows"][-1]["owner"] is None                     # unowned last
    assert d["totals"]["assigned"] == 5
    # Every contact is listed, uncapped, with its reason when not reached.
    reasons = {c["contact_id"]: c["reason"] for c in d["contacts"]}
    assert len(reasons) == 5 and reasons[1] is None and reasons[4]["detail"] == "Nick Smith"
    assert d["contacts"][0]["days_waiting"] >= 20
    assert d["definitions"]["assigned"]["ignored"] == {"period": "Covers every week of the campaign, "
                                                                 "not the period picked"}


def test_stuck_team_scope_and_one_owner(_clear_overrides):
    details = [_detail_row(1), _detail_row(2, owner="kwame@pursuit.org"), _detail_row(3, owner=None)]
    team = make_jobs_client(_stuck_conn(details)).get("/api/jobs/outreach/stuck").json()["data"]
    assert [r["owner"] for r in team["rows"]] == ["avni@pursuit.org"]
    staff = make_jobs_client(_stuck_conn(details)).get("/api/jobs/outreach/stuck?scope=staff").json()["data"]
    assert [r["owner"] for r in staff["rows"]] == ["kwame@pursuit.org"]
    one = make_jobs_client(_stuck_conn(details)).get(
        "/api/jobs/outreach/stuck?owner=kwame@pursuit.org").json()["data"]
    assert one["totals"]["assigned"] == 1


def test_stuck_unknown_campaign_is_404(_clear_overrides):
    r = make_jobs_client(_stuck_conn([])).get("/api/jobs/outreach/stuck?campaign=nope")
    assert r.status_code == 404


# ── the summary and the owner table ──────────────────────────────────────────

LIVE = "SELECT contact_id, created_at, closed_at FROM live"
NO_CONVERSIONS = "m.converted_at IS NOT NULL"


def _week():
    from routes.jobs import _outreach_windows
    s, e, _, _ = _outreach_windows("week", None, None)
    return s, e


def test_summary_splits_outreach_and_scales_the_targets(_clear_overrides):
    s, e = _week()
    t = s + timedelta(hours=10)
    conn = FakeConn(lists={
        PRIOR_EVENTS: [],
        LIVE: [{"contact_id": 1, "created_at": s - timedelta(days=30), "closed_at": None}],
        EVENTS: [event_row(ts=t, contact_id=1, companies=["acme"]),
                 event_row(ts=t, contact_id=2, companies=["globex"]),
                 event_row(kind="linkedin", ts=t, contact_id=3)],
    })
    mon = s.date()
    wed = mon + timedelta(days=2)
    c = make_jobs_client(conn)
    d = c.get(f"/api/jobs/outreach/summary?granularity=range&date_from={mon}&date_to={wed}").json()["data"]
    assert d["outreach_split"] == {"new": 2, "follow_up": 1}
    assert d["outreach_split"]["new"] + d["outreach_split"]["follow_up"] == d["outreach_activity"]
    assert d["targets"]["accounts_activated"] == 12            # 20 a week x 3/5
    assert d["definitions"]["target"]["filters"]["scaled"].startswith("3 weekdays")
    week = c.get(f"/api/jobs/outreach/summary?granularity=week&date_from={mon}"
                 f"&date_to={mon + timedelta(days=6)}").json()["data"]
    assert week["targets"]["accounts_activated"] == 20


def test_converted_lists_the_opportunity_it_became(_clear_overrides):
    s, _ = _week()
    conn = FakeConn(lists={
        "m.converted_at >= $1": [{"contact_id": 9, "name": "Ada", "account": "Acme",
                                  "at": s + timedelta(hours=3), "owner": None, "editor": None}],
        "o.title": [{"contact_id": 9, "id": "11111111-1111-1111-1111-111111111111",
                     "name": "Data analyst", "account_name": "Acme", "stage": "active_in_discussions"}],
    })
    d = make_jobs_client(conn).get("/api/jobs/outreach/summary").json()["data"]
    (row,) = d["drills"]["converted"]
    assert row["opportunities"] == [{"id": "11111111-1111-1111-1111-111111111111",
                                     "name": "Data analyst", "account": "Acme",
                                     "stage": "active_in_discussions"}]


def test_by_owner_credits_accounts_to_the_first_activity_and_splits_outreach(_clear_overrides, monkeypatch):
    import routes.jobs as jobs
    monkeypatch.setattr(jobs, "scorecard_owners", lambda: TEAM)
    s, _ = _week()
    conn = FakeConn(rows={NO_CONVERSIONS: {"n0": 0, "n1": 0}}, lists={
        PRIOR_EVENTS: [],
        LIVE: [{"contact_id": 1, "created_at": s - timedelta(days=30), "closed_at": None}],
        EVENTS: [
            event_row(ts=s + timedelta(hours=1), sender="avni@pursuit.org", contact_id=1, companies=["acme"]),
            event_row(ts=s + timedelta(hours=2), sender="devika@pursuit.org", contact_id=2, companies=["acme"]),
            event_row(ts=s + timedelta(hours=3), sender="devika@pursuit.org", contact_id=3, companies=["globex"]),
        ]})
    d = make_jobs_client(conn).get("/api/jobs/outreach/scorecard/by-owner").json()["data"]
    by = {r["owner"]: r for r in d["rows"]}
    assert by["avni@pursuit.org"]["accounts"]["this_period"] == 1      # Acme: Avni was first
    assert by["devika@pursuit.org"]["accounts"]["this_period"] == 1    # Globex
    assert d["totals"]["accounts"]["this_period"] == 2
    assert d["totals"]["accounts"]["target"] == 20                     # the team's goal
    assert by["avni@pursuit.org"]["outreach"]["split"] == {"new": 0, "follow_up": 1}
    assert d["totals"]["outreach"]["split"] == {"new": 2, "follow_up": 1}


# ── an account's contacts ────────────────────────────────────────────────────

def test_account_contacts_carry_their_outreach_status(_clear_overrides):
    conn = FakeConn(lists={
        "AS membership_stage": [
            {"contact_id": 1, "full_name": "Ada", "email": "ada@acme.com", "current_title": "CTO",
             "contact_stage": None, "linkedin_url": None, "membership_stage": "initial_outreach",
             "owner": "avni@pursuit.org"},
            {"contact_id": 2, "full_name": "Bo", "email": None, "current_title": None,
             "contact_stage": None, "linkedin_url": None, "membership_stage": None, "owner": None}],
        "DISTINCT lower(email) AS email": [{"email": "avni@pursuit.org"}],
        EVENTS: [event_row(ts=T0, contact_id=1)],
        "o.title": [{"contact_id": 1, "id": "22222222-2222-2222-2222-222222222222", "name": "Analyst",
                     "account_name": "Acme", "stage": "active_in_discussions"}],
    })
    r = make_jobs_client(conn).get("/api/jobs/account-prospects?key=acme&scope=all")
    assert r.status_code == 200, r.text
    ada, bo = r.json()["data"]
    assert (ada["membership_stage"], ada["owner"], ada["activity_count"]) == ("initial_outreach",
                                                                              "avni@pursuit.org", 1)
    assert ada["last_activity_at"] and ada["opportunities"][0]["name"] == "Analyst"
    assert (bo["activity_count"], bo["last_activity_at"], bo["opportunities"]) == (0, None, [])
