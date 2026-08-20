"""Evals for GET /accounts — the account-hub status derivation.

Status vocabulary: Pursuing (any open opp) > Stewarding (won, none open) >
Re-activating (all stale but recent) / Dormant (all stale, old) > Prospect
(prospects only, no opps). Plus owner + sf_account_id overrides from
bedrock.jobs_account, and the deal_type filter.
"""
from datetime import datetime, timezone

import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

OPP_SQL = "FROM bedrock.jobs_opportunity"
PROSPECT_SQL = "c.is_jobs_contact = true"  # the per-company prospect COUNT aggregate
JA_SQL = "account_key, display_name, owner_email, status_override, sf_account_id"  # the override-record SELECT (not jobs_account_task)
ACT_SQL = "c.contact_id = a.participant_public_contact_id"  # the per-account warmth/actor aggregate
HIRES_SQL = "count(DISTINCT user_id) AS n FROM ("           # builders-hired-per-account aggregate

RECENT = datetime(2026, 6, 1, tzinfo=timezone.utc)   # within 90d of 2026-06-21
OLD = datetime(2025, 1, 1, tzinfo=timezone.utc)      # > 90d


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _opp(account_name, stage, **ov):
    row = {"id": "o1", "account_id": None, "account_name": account_name, "stage": stage,
           "deal_type": "ft", "title": "Eng", "owner_email": "a@p.org", "priority": None,
           "num_roles": 1, "likelihood": None, "updated_at": RECENT}
    row.update(ov)
    return row


def _conn(opps=None, prospects=None, ja=None, activity=None, hires=None):
    return FakeConn(lists={OPP_SQL: opps or [], PROSPECT_SQL: prospects or [],
                           JA_SQL: ja or [], ACT_SQL: activity or [], HIRES_SQL: hires or []})


def _act(company, recent=1, responded=False, actors=None, last=RECENT):
    return {"company": company, "last_act": last, "first_act": last, "recent": recent,
            "responded": responded, "actors": actors or []}


def _find(data, name):
    return next(a for a in data if a["account"] == name)


def _accounts(conn):
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/accounts")
    assert r.status_code == 200, r.text
    return r.json()["data"]


@pytest.mark.parametrize("stage,expected", [
    ("active_in_discussions", "Pursuing"),
    ("initial_outreach", "Pursuing"),
    ("active_builder_interview", "Pursuing"),
    ("closed_won", "Stewarding"),
])
def test_status_open_and_won(stage, expected):
    data = _accounts(_conn(opps=[_opp("Acme", stage)]))
    assert _find(data, "Acme")["account_status"] == expected


def test_status_reactivating_when_recent_stale():
    data = _accounts(_conn(opps=[_opp("Acme", "closed_lost", updated_at=RECENT)]))
    assert _find(data, "Acme")["account_status"] == "Re-activating"


def test_status_dormant_when_old_stale():
    data = _accounts(_conn(opps=[_opp("Acme", "on_hold_not_responsive", updated_at=OLD)]))
    assert _find(data, "Acme")["account_status"] == "Dormant"


def test_status_prospect_when_only_contacts():
    # Prospects arrive pre-aggregated per company since the #260 payload trim.
    prospects = [{"key": "acme", "display": "Acme", "n": 1, "last_updated": RECENT}]
    data = _accounts(_conn(prospects=prospects))
    acc = _find(data, "Acme")
    assert acc["account_status"] == "Prospect"
    assert acc["prospect_count"] == 1 and acc["opp_count"] == 0


def test_status_activated_when_contact_touched_no_opp():
    # A prospect we've done outreach to (activity exists) but with no opportunity
    # is "Activating" — between untouched Prospect and active Pursuing.
    prospects = [{"key": "acme", "display": "Acme", "n": 1, "last_updated": RECENT}]
    data = _accounts(_conn(prospects=prospects,
                           activity=[_act("acme", recent=2, actors=["avni@pursuit.org"])]))
    acc = _find(data, "Acme")
    assert acc["account_status"] == "Activating"
    assert acc["opp_count"] == 0 and acc["recent_activity_count"] == 2


def test_activity_actors_surfaced():
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions")],
                           activity=[_act("acme", actors=["avni@pursuit.org", "damon.kornhauser@pursuit.org"])]))
    assert _find(data, "Acme")["activity_actors"] == [
        "avni@pursuit.org", "damon.kornhauser@pursuit.org"]   # sorted distinct


def test_builders_hired_count_surfaced():
    data = _accounts(_conn(opps=[_opp("Acme", "closed_won")],
                           hires=[{"company": "acme", "n": 3}]))
    acc = _find(data, "Acme")
    assert acc["builders_hired"] == 3
    assert acc["fellows_hired"] is None   # SF half merged separately


def test_builders_hired_defaults_zero():
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions")]))
    assert _find(data, "Acme")["builders_hired"] == 0


def test_status_override_wins():
    ja = [{"account_key": "acme", "display_name": None, "owner_email": None, "status_override": "Dormant", "sf_account_id": None}]
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions")], ja=ja))
    assert _find(data, "Acme")["account_status"] == "Dormant"   # override beats derived "Pursuing"


def test_owner_and_sf_account_overrides():
    ja = [{"account_key": "acme", "display_name": None, "owner_email": "boss@p.org", "status_override": None, "sf_account_id": "001PIN"}]
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions", owner_email="a@p.org")], ja=ja))
    acc = _find(data, "Acme")
    assert acc["owner_email"] == "boss@p.org"     # stored owner wins over derived
    assert acc["account_id"] == "001PIN"          # explicit SF link wins


def test_account_id_derived_from_sf_opp():
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions", account_id="001REAL")]))
    assert _find(data, "Acme")["account_id"] == "001REAL"


def test_deal_type_filter_excludes_nonmatching():
    conn = _conn(opps=[_opp("Acme", "active_in_discussions", deal_type="capstone")])
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/accounts?deal_type=ft")
    assert r.status_code == 200, r.text
    assert all(a["account"] != "Acme" for a in r.json()["data"])   # capstone-only account filtered out
