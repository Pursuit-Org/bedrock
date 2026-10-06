"""Evals for jobs activity classification + the opportunities funnel shape."""
import pytest

from tests.jobs_fakes import EVENTS, PRIOR_EVENTS, FakeConn, event_row, make_jobs_client


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def test_jobs_activity_flag_tags_team_mailboxes():
    from routes.jobs import _jobs_activity_flag, JOBS_TEAM_EMAILS
    flag = _jobs_activity_flag("a")
    # tied-to-opp + manual channels + each team mailbox (both from + logged_by)
    assert "a.jobs_opportunity_id IS NOT NULL" in flag
    assert "a.source = 'manual'" in flag
    assert "a.type IN ('call','text','linkedin')" in flag
    for e in JOBS_TEAM_EMAILS:
        assert f"a.email_from ILIKE '%{e}%'" in flag
        assert f"a.logged_by ILIKE '%{e}%'" in flag


def test_jobs_activity_flag_respects_alias():
    from routes.jobs import _jobs_activity_flag
    assert "x.jobs_opportunity_id" in _jobs_activity_flag("x")


OPP_FUNNEL = "account_name AS name"
HIST = "jobs_stage_history h"


def test_funnel_opportunities_starts_with_in_discussions():
    # Initial Outreach was retired by the 2026-08-05 stage simplification: the
    # funnel now starts at In Discussions, and a legacy initial_outreach row is
    # canonicalized into it rather than dropped.
    conn = FakeConn(lists={
        OPP_FUNNEL: [
            {"stage": "initial_outreach", "name": "Acme", "deal_type": "ft", "owner": "a@p.org", "roles": None},
            {"stage": "active_in_discussions", "name": "Beta", "deal_type": "ft", "owner": "a@p.org", "roles": None},
        ],
        HIST: [],
    })
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/funnel/opportunities")
    assert r.status_code == 200, r.text
    stages = r.json()["data"]["stages"]
    assert stages[0]["key"] == "active_in_discussions" and stages[0]["label"] == "In Discussions"
    assert stages[0]["count"] == 2   # legacy initial_outreach folded in
    # full ordered pipeline present
    assert [s["key"] for s in stages] == [
        "active_in_discussions", "ask_submitted", "active_opportunity_confirmed",
        "builder_submitted", "builder_interviewing", "offer_contracting",
        "closed_won", "closed_lost"]


PERIOD = "?period_from=2026-09-28&period_to=2026-10-04"


def _entry(stage, name):
    from datetime import datetime, timezone
    return {"stage": stage, "entered_at": datetime(2026, 9, 30, tzinfo=timezone.utc),
            "changed_by": "k@p.org", "name": name, "deal_type": "ft", "owner": "a@p.org"}


def test_period_funnel_counts_moves_into_retired_stage_names():
    # PIP-07: history rows written before the 2026-09-21 rename carry retired
    # stage names. They matched no funnel row and silently dropped out.
    conn = FakeConn(lists={"WITH hist AS": [
        _entry("reviewing_builders", "Acme"),
        _entry("lead_submitted", "Beta"),
        _entry("builder_submitted", "Gamma"),
    ], OPP_FUNNEL: [], HIST: []})
    c = make_jobs_client(conn)
    r = c.get(f"/api/jobs/funnel/opportunities{PERIOD}")
    assert r.status_code == 200, r.text
    counts = {s["key"]: s["count"] for s in r.json()["data"]["stages"]}
    assert counts["builder_submitted"] == 2
    assert counts["active_in_discussions"] == 1
    # Folded before DISTINCT ON, so two retired names that fold together count once.
    q = next(call[1] for call in conn.calls if "WITH hist AS" in call[1])
    assert "DISTINCT ON (h.opportunity_id, (CASE h.to_stage" in q


def test_opportunities_funnel_follows_owner_filter():
    # PIP-07: the Pipeline page's Owner filter never reached the funnel.
    conn = FakeConn(lists={OPP_FUNNEL: [], HIST: []})
    c = make_jobs_client(conn)
    r = c.get(f"/api/jobs/funnel/opportunities{PERIOD}&owner=k@p.org")
    assert r.status_code == 200, r.text
    opp_calls = [call for call in conn.calls if "jobs_opportunity o" in call[1]]
    assert opp_calls
    for _kind, q, args in opp_calls:
        assert "o.owner_email = $" in q, q
        assert "k@p.org" in args
    # "all" means no filter.
    conn_all = FakeConn(lists={OPP_FUNNEL: [], HIST: []})
    make_jobs_client(conn_all).get("/api/jobs/funnel/opportunities?owner=all")
    assert all("k@p.org" not in call[2] for call in conn_all.calls)


def test_contacts_funnel_counts_not_a_fit():
    # OVR-08: the snapshot query filtered not_a_fit out, so its row read 0.
    conn = FakeConn(lists={"m.stage, c.full_name AS name": [
        {"stage": "not_a_fit", "name": "Ana", "company": "Acme"},
        {"stage": "not_a_fit", "name": "Ben", "company": "Beta"},
        {"stage": "assigned", "name": "Cy", "company": "Gamma"},
    ]}, rows={"reached_assigned": {"reached_assigned": 3, "reached_outreach": 0,
                                   "reached_converted": 0}})
    r = make_jobs_client(conn).get("/api/jobs/funnel/prospects")
    assert r.status_code == 200, r.text
    counts = {s["key"]: s["count"] for s in r.json()["data"]["stages"]}
    assert counts["not_a_fit"] == 2
    assert counts["assigned"] == 1
    # And no membership read in either mode drops not_a_fit rows.
    make_jobs_client(conn).get(f"/api/jobs/funnel/prospects{PERIOD}")
    assert not any("<> 'not_a_fit'" in q for q in conn.queries())


def test_funnel_unknown_type_404():
    c = make_jobs_client(FakeConn())
    r = c.get("/api/jobs/funnel/widgets")
    assert r.status_code == 404


def test_funnel_builders_job_ready_paid_ft():
    # bedrock.l3plus_funnel returns the L3+ pool with placement flags
    conn = FakeConn(lists={"l3plus_funnel": [
        {"name": "Ana", "is_paid": True,  "is_ft": True,  "company": "Acme", "role": "Eng"},
        {"name": "Ben", "is_paid": True,  "is_ft": False, "company": "Beta", "role": "PT"},
        {"name": "Cy",  "is_paid": False, "is_ft": False, "company": None,   "role": None},
    ]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/funnel/builders")
    assert r.status_code == 200, r.text
    stages = {s["key"]: s["count"] for s in r.json()["data"]["stages"]}
    assert stages == {"job_ready": 3, "paid": 2, "ft": 1}   # nested funnel
    # segment param is bound to the function call
    seg_conn = FakeConn(lists={"l3plus_funnel": []})
    sc = make_jobs_client(seg_conn)
    sc.get("/api/jobs/funnel/builders?segment=March%202025%20L3")
    call = next(x for x in seg_conn.calls if "l3plus_funnel" in x[1])
    assert call[2][0] == "March 2025 L3"


# ── activity-trends ─────────────────────────────────────────────────────────────

from datetime import datetime, timedelta, timezone  # noqa: E402

BASE = datetime(2026, 6, 15, tzinfo=timezone.utc)


def _this_bucket(hours: int = 1):
    """A moment inside the current week bucket (New York), so the trailing
    12-bucket spine always contains it."""
    from routes.jobs import _bucket_start, _NY
    return _bucket_start(datetime.now(_NY), "week") + timedelta(hours=hours)


def test_activity_trends_new_vs_existing_accounts():
    """Each (activity, account) counts once per bar. An account counts as NEW
    in the bucket of its first activity ever, EXISTING after that (D17)."""
    t = _this_bucket()
    conn = FakeConn(
        lists={
            # Globex was worked before this bucket; Acme never was.
            PRIOR_EVENTS: [event_row(ts=BASE, companies=["globex"])],
            EVENTS: [event_row(ts=t, companies=["acme", "globex"]),
                     event_row(ts=t, companies=["acme"], contact_id=7),
                     # Not activity, so not on the chart, though it activates.
                     event_row(kind="call_booked", ts=t, companies=["initech"])],
        },
        vals={"damon.kornhauser": 50},
    )
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/activity-trends?granularity=week&channel=all")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["channel"] == "all"
    assert len(d["buckets"]) == 12                     # trailing 12, zero-filled
    last = d["buckets"][-1]
    assert last["period"] == t.date().isoformat()
    assert last["new"] == 2 and last["existing"] == 1
    assert d["buckets"][0]["new"] == 0 and d["buckets"][0]["existing"] == 0   # zero-filled
    assert d["totals"] == {"new": 2, "existing": 1, "touches": 3}
    assert d["coverage_note"] is not None              # damon=50 < 200 → flagged


def test_activity_trends_channel_filters_the_bars_not_activation():
    t = _this_bucket()
    conn = FakeConn(lists={EVENTS: [
        event_row(ts=t, companies=["acme"]),
        event_row(kind="meeting", ts=t, companies=["acme"], source="calendar-sync"),
    ]}, vals={"damon.kornhauser": 50})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/activity-trends?granularity=week&channel=meeting")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["channel"] == "meeting"
    assert d["totals"] == {"new": 1, "existing": 0, "touches": 1}


def test_activity_trends_reads_team_senders_not_mailboxes():
    """The events query is bound to the team's addresses, matched exactly."""
    conn = FakeConn(lists={EVENTS: []}, vals={"damon.kornhauser": 500})
    c = make_jobs_client(conn)
    assert c.get("/api/jobs/activity-trends?granularity=week").status_code == 200
    call = next(x for x in conn.calls if x[0] == "fetch" and EVENTS in x[1])
    from routes.jobs import _jobs_team
    assert call[2][2] == [e.lower() for e in _jobs_team()]


def test_activity_trends_no_coverage_note_when_damon_synced():
    conn = FakeConn(lists={EVENTS: []}, vals={"damon.kornhauser": 500})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/activity-trends?granularity=week")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["coverage_note"] is None   # damon=500 ≥ 200


def test_activity_trends_monthly_has_12_buckets():
    conn = FakeConn(lists={EVENTS: []}, vals={"damon.kornhauser": 50})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/activity-trends?granularity=month")
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]["buckets"]) == 12


def test_activity_trends_bad_params_422():
    c = make_jobs_client(FakeConn())
    assert c.get("/api/jobs/activity-trends?granularity=daily").status_code == 422
    assert c.get("/api/jobs/activity-trends?channel=carrier-pigeon").status_code == 422


def test_builder_segments():
    conn = FakeConn(lists={"GROUP BY segment": [{"segment": "March 2025 L3", "n": 34}]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/builder-segments")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["total"] == 34
    assert d["segments"][0]["value"] == "March 2025 L3" and d["segments"][0]["count"] == 34
