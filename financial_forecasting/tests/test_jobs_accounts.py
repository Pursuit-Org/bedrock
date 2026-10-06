"""Evals for GET /accounts — the account-hub status derivation.

Status vocabulary: Pursuing (any open opp) > Stewarding (won, none open) >
Re-activating (all stale but recent) / Dormant (all stale, old) > Prospect
(prospects only, no opps). Plus owner + sf_account_id overrides from
bedrock.jobs_account, and the deal_type filter.
"""
from datetime import datetime, timedelta, timezone

import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

OPP_SQL = "FROM bedrock.jobs_opportunity"
PROSPECT_SQL = "c.is_jobs_contact = true"  # the per-company prospect COUNT aggregate
JA_SQL = "account_key, display_name, owner_email, status_override, sf_account_id"  # the override-record SELECT (not jobs_account_task)
ACT_SQL = "c.contact_id = a.participant_public_contact_id"  # the per-account warmth/actor aggregate
HIRES_SQL = "count(DISTINCT user_id) AS n FROM ("           # builders-hired-per-account aggregate

# Relative to the real clock: the status rule compares against now(), so the
# fixed 2026-06-01 that used to sit here aged out of the 90-day window and
# flipped Re-activating to Dormant.
_NOW = datetime.now(timezone.utc)
RECENT = _NOW - timedelta(days=20)    # within the 90-day window
OLD = _NOW - timedelta(days=400)      # well outside it


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _opp(account_name, stage, **ov):
    row = {"id": "o1", "account_id": None, "account_name": account_name, "stage": stage,
           "deal_type": "ft", "title": "Eng", "owner_email": "a@p.org", "priority": None,
           "num_roles": 1, "likelihood": None, "updated_at": RECENT,
           "target_close_date": None, "estimated_jobs": None}
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
    # ACC-01: the four stages added 2026-09-21 have no "active_" prefix and
    # used to fall through to Re-activating / Dormant.
    ("ask_submitted", "Pursuing"),
    ("builder_submitted", "Pursuing"),
    ("builder_interviewing", "Pursuing"),
    ("offer_contracting", "Pursuing"),
    ("lead_submitted", "Pursuing"),
    ("reviewing_builders", "Pursuing"),
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


# ── ACC-02: task rollups use the stored status vocabulary ──────────────────────

def test_account_tasks_sort_completed_last():
    # jobs_task stores "Completed"; there is no "done". Sorting on
    # (status = 'done') left finished tasks mixed in with open ones.
    conn = FakeConn(lists={
        "SELECT id, title FROM bedrock.jobs_opportunity": [{"id": "o1", "title": "Eng"}],
        "FROM bedrock.jobs_task": [],
    })
    r = make_jobs_client(conn).get("/api/jobs/account-tasks?key=acme")
    assert r.status_code == 200, r.text
    q = next(call[1] for call in conn.calls if "FROM bedrock.jobs_task" in call[1])
    assert "ORDER BY (status = 'Completed')" in q


def test_no_task_status_compares_to_done():
    # Guard: every task status the API writes is in VALID_STATUSES.
    import inspect
    import re
    import routes.jobs as jobs
    from routes.jobs_tasks import VALID_STATUSES
    assert "done" not in {s.lower() for s in VALID_STATUSES}
    assert not re.search(r"status\s*(=|<>|!=)\s*'done'", inspect.getsource(jobs))


# ── Top-bar search: jobs accounts (Kwame 2026-10-02) ───────────────────────────

ACCT_SEARCH = "WHERE key LIKE $1"


def test_account_search_finds_account_by_name():
    conn = FakeConn(lists={ACCT_SEARCH: [{"key": "blackstone", "name": "Blackstone", "opps": 7}]})
    r = make_jobs_client(conn).get("/api/jobs/accounts/search?q=Blackstone")
    assert r.status_code == 200, r.text
    assert r.json()["data"] == [{"account_key": "blackstone", "account": "Blackstone", "opp_count": 7}]
    q, args = next((c[1], c[2]) for c in conn.calls if ACCT_SEARCH in c[1])
    # Case-insensitive contains, prefix matches ranked first, default limit 8.
    assert args == ("%blackstone%", "blackstone%", 8)
    assert "FROM bedrock.jobs_opportunity" in q and "public.contacts c" in q


def test_account_search_escapes_like_wildcards():
    conn = FakeConn(lists={ACCT_SEARCH: []})
    make_jobs_client(conn).get("/api/jobs/accounts/search?q=50%25_off")
    args = next(c[2] for c in conn.calls if ACCT_SEARCH in c[1])
    assert args[0] == "%50\%\_off%"


def test_account_search_needs_two_characters():
    r = make_jobs_client(FakeConn()).get("/api/jobs/accounts/search?q=b")
    assert r.status_code == 422


def test_account_search_route_is_not_shadowed():
    # /accounts/{key}-style routes must not capture "search".
    from main import app
    paths = [getattr(r, "path", "") for r in app.routes]
    assert "/api/jobs/accounts/search" in paths


def test_opportunity_search_takes_a_limit():
    conn = FakeConn(lists={"FROM bedrock.jobs_opportunity": []})
    r = make_jobs_client(conn).get("/api/jobs/opportunities/search?q=black&limit=5")
    assert r.status_code == 200, r.text
    args = next(c[2] for c in conn.calls if "FROM bedrock.jobs_opportunity" in c[1])
    assert args == ("%black%", 5)
