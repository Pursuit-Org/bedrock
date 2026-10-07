"""Evals for the editable Jobs team + targets (Settings > Targets > Jobs).

Covers the store (fallback, roll-up modes, validation on load), how the
existing target lookups read it, and the /api/jobs/targets endpoints
(pending-migration 409, validation, permission gate).
"""
import asyncio
import json
from datetime import date

import pytest

from services import jobs_targets_store as store
from services.outreach_targets import activity_pipeline_target, scorecard_owners
from tests.jobs_fakes import FakeConn, make_jobs_client

ADMIN_ROW = {"id": "u", "profile_id": "p", "sf_user_id": None, "email": "test@test.org",
             "name": "T", "is_active": True, "permissions": json.dumps({}),
             "profile_name": "Admin", "org_user_id": None}
RM_ROW = {**ADMIN_ROW, "profile_name": "Relationship Manager",
          "permissions": json.dumps({"view_opportunities": True})}


@pytest.fixture(autouse=True)
def _reset():
    from main import app
    store.reset()
    yield
    store.reset()
    app.dependency_overrides.clear()


class Pool:
    """Just enough pool for store.refresh()."""
    def __init__(self, exists=True, members=None, targets=None, history=None):
        self.exists, self.members, self.targets = exists, members or [], targets or []
        self.history = history or []

    async def fetchval(self, q, *a):
        return self.exists

    async def fetch(self, q, *a):
        if "jobs_team_change" in q:
            return self.history
        return self.members if "jobs_team_member" in q else self.targets


def _t(metric, owner=None, value=None, mode=None, section="outreach", start=None):
    return {"section": section, "metric": metric, "owner_email": owner,
            "period_start": start, "value": value, "team_mode": mode}


def _load(**kw):
    asyncio.run(store.refresh(Pool(**kw), force=True))


# ── store ──────────────────────────────────────────────────────────────────────

def test_fallback_until_migration():
    assert not store.available()
    assert store.team_emails() == store.DEFAULT_TEAM
    # Today's hardcoded numbers, unchanged.
    assert activity_pipeline_target("total_outreach_activity", "week") == 150
    assert activity_pipeline_target("total_outreach_activity", "week", "kwame@pursuit.org") == 10
    assert "kwame@pursuit.org" in scorecard_owners()


def test_team_sum_and_set_modes():
    _load(members=[{"email": "a@pursuit.org"}, {"email": "b@pursuit.org"}], targets=[
        _t("total_outreach_activity", "a@pursuit.org", 40),
        _t("total_outreach_activity", "b@pursuit.org", 30),
        _t("total_outreach_activity", mode="sum"),
        # A team number while the people carry nothing: the "set" case.
        _t("converted_opportunities", "a@pursuit.org", 0),
        _t("converted_opportunities", mode="set", value=5),
    ])
    assert store.available()
    assert activity_pipeline_target("total_outreach_activity", "week") == 70
    assert activity_pipeline_target("total_outreach_activity", "month") == 280
    assert activity_pipeline_target("converted_opportunities", "week") == 5
    assert activity_pipeline_target("converted_opportunities", "week", "a@pursuit.org") == 0
    # No team row = no target, not zero.
    assert activity_pipeline_target("total_calls", "week") is None
    assert scorecard_owners() == ["a@pursuit.org", "b@pursuit.org"]


def test_sum_counts_only_current_team():
    # c@ left the team; their row must not keep inflating the team target.
    _load(members=[{"email": "a@pursuit.org"}], targets=[
        _t("total_calls", "a@pursuit.org", 5), _t("total_calls", "c@pursuit.org", 9),
        _t("total_calls", mode="sum")])
    assert activity_pipeline_target("total_calls", "week") == 5
    assert activity_pipeline_target("total_calls", "week", "c@pursuit.org") is None


def test_unsafe_addresses_dropped_on_load():
    # These end up inside SQL literals; anything off-pattern never reaches them.
    _load(members=[{"email": "a@pursuit.org"}, {"email": "x'); DROP TABLE t;--@pursuit.org"},
                         {"email": "someone@gmail.com"}])
    assert store.team_emails() == ["a@pursuit.org"]


def test_empty_team_falls_back_to_default():
    _load(members=[])
    assert store.team_emails() == store.DEFAULT_TEAM


def test_pipeline_targets_loaded():
    _load(targets=[_t("jobs", section="pipeline", value=12, start=date(2026, 10, 1))])
    assert store.pipeline_targets() == {date(2026, 10, 1): 12}


# ── endpoints ──────────────────────────────────────────────────────────────────

def _conn(user_row=ADMIN_ROW, exists=True, members=None, targets=None):
    conn = FakeConn(rows={"FROM public.org_users": user_row},
                    vals={"to_regclass": exists},
                    lists={"FROM bedrock.jobs_team_member": members if members is not None
                           else [{"email": "a@pursuit.org"}],
                           "FROM bedrock.jobs_target": targets or []})
    return conn


def test_get_reports_pending_before_migration():
    c = make_jobs_client(_conn(exists=False))
    d = c.get("/api/jobs/targets").json()["data"]
    assert d["available"] is False
    assert d["team"] == store.DEFAULT_TEAM
    assert d["team_targets"]["total_outreach_activity"]["effective"] == 150
    assert [m["key"] for m in d["metrics"]][0] == "accounts_activated"


def test_put_refused_before_migration():
    c = make_jobs_client(_conn(exists=False))
    r = c.put("/api/jobs/targets/team", json={"members": ["a@pursuit.org"]})
    assert r.status_code == 409


def test_put_team_validates_addresses():
    conn = _conn()
    c = make_jobs_client(conn)
    r = c.put("/api/jobs/targets/team", json={"members": ["a@pursuit.org", "bob@evil.com"]})
    assert r.status_code == 400
    assert not conn.ran("INSERT INTO bedrock.jobs_team_member")


def test_put_team_deactivates_removed_and_upserts():
    conn = _conn()
    c = make_jobs_client(conn)
    r = c.put("/api/jobs/targets/team", json={"members": ["A@Pursuit.org", "b@pursuit.org"]})
    assert r.status_code == 200, r.text
    deact = conn.executed("SET active = false")
    assert deact and deact[0][2][0] == ["a@pursuit.org", "b@pursuit.org"]
    assert len(conn.executed("INSERT INTO bedrock.jobs_team_member")) == 2


def test_put_team_needs_permission():
    c = make_jobs_client(_conn(user_row=RM_ROW))
    r = c.put("/api/jobs/targets/team", json={"members": ["a@pursuit.org"]})
    assert r.status_code == 403


def test_put_outreach_replaces_section():
    conn = _conn()
    c = make_jobs_client(conn)
    r = c.put("/api/jobs/targets/outreach", json={
        "owners": {"a@pursuit.org": {"total_outreach_activity": 40, "total_calls": None}},
        "team": {"total_outreach_activity": {"mode": "sum"},
                 "converted_opportunities": {"mode": "set", "value": 3}},
    })
    assert r.status_code == 200, r.text
    assert conn.executed("DELETE FROM bedrock.jobs_target WHERE section = 'outreach'")
    inserts = [c2[2] for c2 in conn.executed("INSERT INTO bedrock.jobs_target")]
    # the null cell is dropped; person row + two team rows remain
    assert ("total_outreach_activity", "a@pursuit.org", 40, None) in [i[:4] for i in inserts]
    assert ("converted_opportunities", None, 3, "set") in [i[:4] for i in inserts]
    assert ("total_outreach_activity", None, None, "sum") in [i[:4] for i in inserts]
    assert len(inserts) == 3


def test_put_outreach_rejects_non_member():
    c = make_jobs_client(_conn())
    r = c.put("/api/jobs/targets/outreach", json={
        "owners": {"z@pursuit.org": {"total_calls": 4}}, "team": {}})
    assert r.status_code == 400


def test_put_outreach_set_needs_value():
    c = make_jobs_client(_conn())
    r = c.put("/api/jobs/targets/outreach", json={
        "owners": {}, "team": {"total_calls": {"mode": "set"}}})
    assert r.status_code == 400


def test_put_pipeline_requires_quarter_start():
    c = make_jobs_client(_conn())
    r = c.put("/api/jobs/targets/pipeline", json={"quarters": [{"period_start": "2026-11-01", "value": 5}]})
    assert r.status_code == 400


def test_put_pipeline_upserts_and_clears():
    conn = _conn()
    c = make_jobs_client(conn)
    r = c.put("/api/jobs/targets/pipeline", json={"quarters": [
        {"period_start": "2026-10-01", "value": 12}, {"period_start": "2027-01-01", "value": None}]})
    assert r.status_code == 200, r.text
    assert conn.executed("INSERT INTO bedrock.jobs_target (section, metric, period_start")
    assert conn.executed("DELETE FROM bedrock.jobs_target WHERE section = 'pipeline'")


# ── review fixes (2026-09-30) ─────────────────────────────────────────────────

def test_like_wildcards_rejected_in_team_emails():
    # % and _ would widen the ILIKE team predicates to all of Pursuit.
    assert not store.valid_email("%@pursuit.org")
    assert not store.valid_email("a_ni@pursuit.org")
    assert store.valid_email("damon.kornhauser@pursuit.org")
    c = make_jobs_client(_conn())
    r = c.put("/api/jobs/targets/team", json={"members": ["%@pursuit.org"]})
    assert r.status_code == 400


def test_put_outreach_keeps_removed_members_rows():
    conn = _conn()
    c = make_jobs_client(conn)
    r = c.put("/api/jobs/targets/outreach", json={"owners": {}, "team": {}})
    assert r.status_code == 200, r.text
    q, args = conn.executed("DELETE FROM bedrock.jobs_target WHERE section = 'outreach'")[0][1:]
    # Only the team rows and current members are replaced.
    assert "owner_email IS NULL OR owner_email = ANY($1::text[])" in q
    assert args[0] == ["a@pursuit.org"]


def test_put_outreach_duplicate_email_is_400():
    c = make_jobs_client(_conn())
    r = c.put("/api/jobs/targets/outreach", json={
        "owners": {"A@pursuit.org": {"total_calls": 1}, "a@pursuit.org": {"total_calls": 2}}, "team": {}})
    assert r.status_code == 400


# ── team history (decided 2026-10-07: changing the team never recounts the past) ──

from datetime import datetime, timezone  # noqa: E402

OCT5 = datetime(2026, 10, 5, 18, tzinfo=timezone.utc)
SEP24 = datetime(2026, 9, 24, 15, tzinfo=timezone.utc)
OCT6 = datetime(2026, 10, 6, 15, tzinfo=timezone.utc)
# What production records: D7's team since the start; on 10/5 Kwame added and
# Damon taken off.
HISTORY = [{"email": e, "on_team": True, "effective_at": None}
           for e in ("avni@pursuit.org", "damon.kornhauser@pursuit.org", "devika@pursuit.org")] + [
    {"email": "kwame@pursuit.org", "on_team": True, "effective_at": OCT5},
    {"email": "damon.kornhauser@pursuit.org", "on_team": False, "effective_at": OCT5},
]
NOW_TEAM = [{"email": "avni@pursuit.org"}, {"email": "devika@pursuit.org"}, {"email": "kwame@pursuit.org"}]


def test_membership_follows_the_history():
    _load(members=NOW_TEAM, history=HISTORY)
    assert store.member_at("damon.kornhauser@pursuit.org", SEP24)
    assert not store.member_at("damon.kornhauser@pursuit.org", OCT6)
    assert not store.member_at("kwame@pursuit.org", SEP24)
    assert store.member_at("kwame@pursuit.org", OCT6)
    assert store.team_emails() == ["avni@pursuit.org", "devika@pursuit.org", "kwame@pursuit.org"]
    assert store.ever_members() == ["avni@pursuit.org", "damon.kornhauser@pursuit.org",
                                    "devika@pursuit.org", "kwame@pursuit.org"]
    assert store.members_during(SEP24, OCT6) == store.ever_members()


def test_without_history_the_current_list_counts_for_all_time():
    """Before the migration runs, nothing changes."""
    _load(members=NOW_TEAM)
    assert not store.has_history()
    assert store.member_at("kwame@pursuit.org", SEP24)
    assert not store.member_at("damon.kornhauser@pursuit.org", SEP24)


def test_a_past_week_keeps_who_did_its_work():
    """Damon's 9/24 email still counts for the team; Kwame's doesn't (he joined
    10/5). After 10/5 it is the other way round."""
    from services import outreach_counting as oc
    from routes.jobs import _team_scope
    _load(members=NOW_TEAM, history=HISTORY)
    ev = lambda who, at: oc.Event(kind="email", ts=at, sender=who, activity_id=f"{who}{at}",
                                  contact_id=1, source="gmail-sync")
    rows = [ev("damon.kornhauser@pursuit.org", SEP24), ev("kwame@pursuit.org", SEP24),
            ev("damon.kornhauser@pursuit.org", OCT6), ev("kwame@pursuit.org", OCT6)]
    kept = {(e.sender, e.ts) for e in oc.attribute(rows, _team_scope())}
    assert kept == {("damon.kornhauser@pursuit.org", SEP24), ("kwame@pursuit.org", OCT6)}


def test_saving_the_team_records_who_joined_and_who_left():
    conn = _conn(members=[{"email": "avni@pursuit.org"}, {"email": "kwame@pursuit.org"}])
    c = make_jobs_client(conn)
    r = c.put("/api/jobs/targets/team",
              json={"members": ["avni@pursuit.org", "damon.kornhauser@pursuit.org"]})
    assert r.status_code == 200, r.text
    changes = {(a[0], a[1]) for _, _, a in conn.executed("INSERT INTO bedrock.jobs_team_change")}
    assert changes == {("damon.kornhauser@pursuit.org", True), ("kwame@pursuit.org", False)}
