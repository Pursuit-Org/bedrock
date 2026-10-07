"""PRO-102: every call has a type, is dated by when it was booked, and counts once.

No database. The counting rules run on events_sql-shaped rows; the routes run
through FakeConn. The meeting-to-call match itself is SQL (it has to see calls
outside the window), so its shape is asserted here and it was checked on
production on 2026-10-07: with the dates corrected, it pairs the 9/18
Mastercard, Gutter and Newmark meetings with the calls Devika logged for them,
and nothing else between 9/14 and 9/27.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from services import outreach_counting as oc
from tests.jobs_fakes import EVENTS, PRIOR_EVENTS, FakeConn, event_row, make_jobs_client

NY = ZoneInfo("America/New_York")
T = datetime(2026, 9, 18, 14, 0, tzinfo=NY)
TEAM = ["avni@pursuit.org", "devika@pursuit.org"]


def _events(*rows, senders=TEAM):
    return oc.attribute(rows, senders)


# ── each call once ───────────────────────────────────────────────────────────

def test_a_meeting_someone_logged_as_a_call_is_one_discovery_call():
    """Devika logged the 9/18 Mastercard call as discovery; the meeting synced
    from Avni's calendar is the same call."""
    call = event_row(kind="call", ts=T.replace(hour=0), sender="devika@pursuit.org",
                     activity_id="call-1", contact_id=7, call_kind="discovery")
    meeting = event_row(kind="meeting", ts=T, sender="avni@pursuit.org", source="calendar-sync",
                        contact_id=7, logged_as="call-1")
    c = oc.count(_events(call, meeting))
    assert c.calls == 1
    assert c.by_metric == {"call_discovery": 1}


def test_the_logged_call_wins_even_when_its_logger_is_outside_the_scope():
    """Avni alone: the meeting on her calendar is Devika's logged call, so it
    counts for Devika, never for both. Per-person counts add up to the team's."""
    call = event_row(kind="call", ts=T, sender="devika@pursuit.org", activity_id="call-1",
                     call_kind="discovery")
    meeting = event_row(kind="meeting", ts=T, sender="avni@pursuit.org", logged_as="call-1")
    assert oc.count(_events(call, meeting, senders=["avni@pursuit.org"])).calls == 0
    assert oc.count(_events(call, meeting, senders=["devika@pursuit.org"])).calls == 1


def test_the_meeting_still_reaches_its_account():
    """A call logged on an opportunity has no contact, so it reaches no
    account. The meeting it matched did: that touch stays (accounts activated,
    reached, campaigns), it just isn't a second call."""
    call = event_row(kind="call", ts=T, sender="devika@pursuit.org", activity_id="call-1",
                     call_kind="discovery")
    meeting = event_row(kind="meeting", ts=T, sender="avni@pursuit.org", contact_id=7,
                        companies=["acme"], logged_as="call-1")
    events = _events(call, meeting)
    assert set(oc.touched_accounts(events)) == {"acme"}
    assert [e.kind for e in events if e.is_call] == ["call"]
    assert oc.Event.from_row(meeting).metric() is None


def test_meetings_nobody_logged_still_count_and_carry_their_retag():
    retagged = event_row(kind="meeting", ts=T, source="calendar-sync", call_kind="discovery")
    untagged = event_row(kind="meeting", ts=T + timedelta(hours=1), source="calendar-sync")
    c = oc.count(_events(retagged, untagged), "general")
    assert c.calls == 2
    assert c.by_metric == {"call_discovery": 1, "call_general": 1}


def test_two_calls_logged_on_one_day_are_two():
    a = event_row(kind="call", ts=T, call_kind="discovery", contact_id=7)
    b = event_row(kind="call", ts=T, call_kind="general", contact_id=7)
    assert oc.count(_events(a, b)).calls == 2


def test_logged_as_reads_off_an_events_row():
    row = event_row(kind="meeting", logged_as="b0e3c1f2-0000-0000-0000-000000000001")
    assert oc.Event.from_row(row).logged_as == "b0e3c1f2-0000-0000-0000-000000000001"
    assert oc.Event.from_row(event_row()).logged_as is None


# ── the SQL ──────────────────────────────────────────────────────────────────

def _hand_logged_branch(sql: str) -> str:
    return sql.split("-- Hand-logged LinkedIn")[1].split("UNION ALL")[0]


def test_calls_are_dated_by_booking_unless_asked_for_held():
    booked = _hand_logged_branch(oc.events_sql())
    assert "coalesce(a.booked_at, a.activity_date)" in booked
    # The plain activity_date arm stays, so the date index still serves the range.
    assert "a.activity_date >= " in booked
    held = _hand_logged_branch(oc.events_sql(call_date="held"))
    assert "booked_at" not in held
    assert "booked_at" not in oc.events_sql(has_booked_at=False)
    with pytest.raises(ValueError):
        oc.events_sql(call_date="scheduled")


def test_meetings_carry_a_call_type_and_the_call_they_are():
    branch = _hand_logged_branch(oc.events_sql())
    assert "CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END" in branch
    assert "SELECT lc.id FROM logged_calls lc" in branch
    logged = oc.events_sql().split("logged_calls AS MATERIALIZED (")[1].split("raw AS (")[0]
    # Hand-logged calls only, matched on the New York day they were held.
    assert "c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL" in logged
    assert "(c.activity_date AT TIME ZONE 'America/New_York')::date" in logged
    assert "o.account_name" in logged
    assert "lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)" in branch
    assert "pc.contact_id = lc.contact_id" in branch
    assert "lower(btrim(coalesce(pc.current_company, ''))) = lc.account" in branch


def test_every_union_branch_has_the_same_columns():
    """UNION ALL needs the same column count in each branch; logged_as is the
    newest one and has to be in all five."""
    raw = oc.events_sql().split("raw AS (")[1].split("ev AS (")[0]
    assert raw.count("NULL::uuid AS logged_as") == 1
    assert raw.count("UNION ALL") == 4
    assert raw.count(", NULL::uuid\n") == 3            # email (unindexed), intro, call_booked


def test_the_sql_twin_counts_the_logged_call_and_keeps_the_meeting_for_reach():
    sql = oc.reference_sql()
    # Every call count leaves the matched meeting out...
    assert sql.count("kind IN ('call', 'meeting') AND logged_as IS NULL") == 3
    # ...while `once`, which activation reads, keeps it.
    assert "logged_as" not in oc.counted_once_ctes().split("once AS (")[1]


# ── logging a call ───────────────────────────────────────────────────────────

@pytest.fixture
def columns(monkeypatch):
    """bedrock.activity.call_kind / booked_at and the membership's
    call_booked_at exist, without probing information_schema."""
    import routes.jobs as jobs
    for col in (("bedrock", "activity", "call_kind"), ("bedrock", "activity", "booked_at"),
                ("bedrock", "jobs_contact_membership", "call_booked_at")):
        monkeypatch.setitem(jobs._COLUMN_CACHE, col, True)


@pytest.fixture
def _clear_overrides():
    from main import app
    yield
    app.dependency_overrides.clear()


def _log_conn():
    return FakeConn(vals={"INSERT INTO bedrock.activity": "new-id"},
                    rows={"SELECT * FROM bedrock.activity WHERE id": {"id": "new-id"}})


def _insert(conn):
    return next(c for c in conn.calls if "INSERT INTO bedrock.activity" in c[1])


def test_a_call_needs_a_type(columns, _clear_overrides):
    conn = _log_conn()
    r = make_jobs_client(conn).post("/api/jobs/activity", json={"contact_id": 7, "type": "call"})
    assert r.status_code == 400
    assert "call type" in r.json()["detail"]
    assert not any("INSERT" in c[1] for c in conn.calls)


def test_other_activity_needs_no_type(columns, _clear_overrides):
    r = make_jobs_client(_log_conn()).post("/api/jobs/activity", json={"contact_id": 7, "type": "text"})
    assert r.status_code == 200, r.text


def test_a_call_stores_its_type_and_both_days_in_new_york(columns, _clear_overrides):
    conn = _log_conn()
    r = make_jobs_client(conn).post("/api/jobs/activity", json={
        "contact_id": 7, "type": "call", "call_kind": "discovery",
        "booked_at": "2026-09-14", "activity_date": "2026-09-18"})
    assert r.status_code == 200, r.text
    _, sql, args = _insert(conn)
    assert sql.split("VALUES")[0].rstrip().endswith("jobs_relevance_override, call_kind, booked_at)")
    held, kind, booked = args[3], args[-2], args[-1]
    # Bare dates are New York days: midnight there, 04:00 UTC in September.
    assert held == datetime(2026, 9, 18, tzinfo=NY)
    assert booked == datetime(2026, 9, 14, tzinfo=NY)
    assert kind == "discovery"
    # The contact's missing Call Booked date is the booked day.
    stamp = next(c for c in conn.calls if "SET call_booked_at" in c[1])
    assert "call_booked_at IS NULL" in stamp[1]
    assert "stage IN ('call_booked', 'converted_to_opportunity')" in stamp[1]
    assert stamp[2] == (7, booked)


def test_a_call_with_no_held_day_is_held_the_day_booked(columns, _clear_overrides):
    conn = _log_conn()
    r = make_jobs_client(conn).post("/api/jobs/activity", json={
        "jobs_opportunity_id": "8a0f0c9e-0000-4000-8000-000000000001", "type": "call",
        "call_kind": "general", "booked_at": "2026-09-14"})
    assert r.status_code == 200, r.text
    args = _insert(conn)[2]
    assert args[3] == args[-1] == datetime(2026, 9, 14, tzinfo=NY)
    # Logged on a deal, not a contact: no contact's date to fill.
    assert not any("SET call_booked_at" in c[1] for c in conn.calls)


def test_a_call_cannot_be_booked_in_the_future(columns, _clear_overrides):
    tomorrow = (datetime.now(NY) + timedelta(days=2)).date().isoformat()
    r = make_jobs_client(_log_conn()).post("/api/jobs/activity", json={
        "contact_id": 7, "type": "call", "call_kind": "discovery", "booked_at": tomorrow})
    assert r.status_code == 400


def test_a_call_cannot_be_held_before_it_was_booked(columns, _clear_overrides):
    r = make_jobs_client(_log_conn()).post("/api/jobs/activity", json={
        "contact_id": 7, "type": "call", "call_kind": "discovery",
        "booked_at": "2026-09-14", "activity_date": "2026-09-12"})
    assert r.status_code == 400


def test_a_booking_date_on_an_email_is_ignored(columns, _clear_overrides):
    conn = _log_conn()
    r = make_jobs_client(conn).post("/api/jobs/activity", json={
        "contact_id": 7, "type": "email", "booked_at": "2026-09-14", "call_kind": "discovery"})
    assert r.status_code == 200, r.text
    assert "booked_at" not in _insert(conn)[1] and "call_kind" not in _insert(conn)[1]


# ── re-tagging a meeting ─────────────────────────────────────────────────────

MEETING_ID = "3d6f1e2a-0000-4000-8000-000000000002"


def test_a_meeting_can_be_retagged(columns, _clear_overrides):
    conn = FakeConn()
    r = make_jobs_client(conn).patch(f"/api/jobs/activity/{MEETING_ID}/call-kind",
                                     json={"call_kind": "discovery"})
    assert r.status_code == 200, r.text
    _, sql, args = next(c for c in conn.calls if "SET call_kind" in c[1])
    assert "type IN ('call', 'meeting')" in sql
    assert args[0] == "discovery" and str(args[1]) == MEETING_ID


def test_retagging_something_that_is_not_a_call_is_a_404(columns, _clear_overrides):
    conn = FakeConn(vals={"SET call_kind": "UPDATE 0"})
    r = make_jobs_client(conn).patch(f"/api/jobs/activity/{MEETING_ID}/call-kind",
                                     json={"call_kind": "general"})
    assert r.status_code == 404


def test_retag_rejects_an_unknown_type(columns, _clear_overrides):
    r = make_jobs_client(FakeConn()).patch(f"/api/jobs/activity/{MEETING_ID}/call-kind",
                                           json={"call_kind": "solution"})
    assert r.status_code == 400


# ── the Calls booked card ────────────────────────────────────────────────────

def _summary(conn, **params):
    return make_jobs_client(conn).get("/api/jobs/outreach/summary", params=params)


def test_calls_booked_counts_each_discovery_call_once(columns, _clear_overrides):
    from routes.jobs import _outreach_windows
    t = _outreach_windows("week", None, None)[0] + timedelta(hours=10)
    call = event_row(kind="call", ts=t, sender="devika@pursuit.org", activity_id="call-1",
                     contact_id=7, call_kind="discovery")
    same_call = event_row(kind="meeting", ts=t, source="calendar-sync", contact_id=7,
                          logged_as="call-1")
    other = event_row(kind="meeting", ts=t + timedelta(hours=2), source="calendar-sync")
    conn = FakeConn(lists={PRIOR_EVENTS: [], EVENTS: [call, same_call, other]})
    r = _summary(conn)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert (d["calls_booked"], d["calls_discovery"], d["call_date"]) == (2, 1, "booked")
    assert d["drill_totals"]["calls_booked"] == 2
    tagged = {row["activity_id"]: row["call_kind"] for row in d["drills"]["calls_booked"]}
    assert tagged == {"call-1": "discovery", other["activity_id"]: None}


def test_calls_booked_can_count_by_the_day_held(columns, _clear_overrides):
    conn = FakeConn(lists={PRIOR_EVENTS: [], EVENTS: []})
    assert _summary(conn, call_date="held").json()["data"]["call_date"] == "held"
    sql = next(c[1] for c in conn.calls if EVENTS in c[1] and PRIOR_EVENTS not in c[1])
    assert "booked_at" not in _hand_logged_branch(sql)
    assert _summary(FakeConn(), call_date="scheduled").status_code == 422


def test_held_mode_says_so_and_its_records_count_the_same_way(columns, _clear_overrides):
    d = _summary(FakeConn(lists={PRIOR_EVENTS: [], EVENTS: []}), call_date="held").json()["data"]
    calls = d["definitions"]["calls_booked"]
    assert calls["filters"].get("call_date") == "held"
    assert calls["records"]["params"]["call_date"] == "held"
    booked = _summary(FakeConn(lists={PRIOR_EVENTS: [], EVENTS: []})).json()["data"]["definitions"]
    assert "call_date" not in booked["calls_booked"]["records"]["params"]
    # The records endpoint reads calls the same way.
    conn = FakeConn(lists={PRIOR_EVENTS: [], EVENTS: []})
    r = make_jobs_client(conn).get("/api/jobs/outreach/scorecard/detail",
                                   params={"key": "total_calls", "call_date": "held"})
    assert r.status_code == 200, r.text
    sql = next(c[1] for c in conn.calls if EVENTS in c[1])
    assert "booked_at" not in _hand_logged_branch(sql)
