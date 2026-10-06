"""Evals for PRO-96: no number on a Jobs page may come from a silently
truncated list.

Each capped list either loses its cap, or carries its uncapped size (a
`count(*) OVER ()` window taken before the LIMIT) so the page can say
"Showing X of Y". Offset-paged lists get a unique tiebreaker so a client
loading every page never sees a row twice or misses one.
"""
import asyncio
import uuid
from datetime import datetime, timezone

import pytest

from tests.jobs_fakes import EVENTS, PRIOR_EVENTS, FakeConn, event_row, make_jobs_client
from tests.test_jobs_opps_overview import OverviewConn, _set_row

NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def test_window_total_reads_the_uncapped_count():
    from routes.jobs import _window_total
    assert _window_total([]) == 0
    assert _window_total([{"total_rows": 412}, {"total_rows": 412}]) == 412


# ── Offset paging is deterministic ──────────────────────────────────────────

def test_contacts_list_orders_by_a_unique_tiebreaker():
    # Ordered by name alone, two contacts sharing a name could swap between
    # page requests, so loading every page could repeat one and drop the other.
    conn = FakeConn(lists={"is_jobs_contact = true": []}, vals={"count(": 7731})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/contacts?limit=2000&offset=2000")
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 7731
    main_q, args = next((call[1], call[2]) for call in conn.calls
                        if call[0] == "fetch" and "is_jobs_contact = true" in call[1])
    assert "c.full_name NULLS LAST, c.contact_id" in main_q
    assert list(args[-2:]) == [2000, 2000]   # limit, offset


def test_opportunities_list_orders_by_a_unique_tiebreaker():
    conn = FakeConn(lists={"FROM bedrock.jobs_opportunity o": []}, vals={"count(": 155})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/opportunities?limit=500&offset=500")
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 155
    q = next(call[1] for call in conn.calls
             if call[0] == "fetch" and "FROM bedrock.jobs_opportunity o" in call[1])
    assert "ORDER BY o.updated_at DESC, o.id" in q


# ── Needs attention (HOME-01, HOME-04, PIP-12) ──────────────────────────────

def test_needs_attention_lists_every_flagged_deal_not_30():
    rows = [_set_row(str(uuid.uuid4()), f"Acct {i}", created_days=60, moved_days=60)
            for i in range(35)]
    c = make_jobs_client(OverviewConn(rows))
    d = c.get("/api/jobs/opportunities/overview").json()["data"]
    assert len(d["needs_attention"]) == 35


# ── KPI drawers (/outreach/summary) ─────────────────────────────────────────

def test_outreach_summary_lists_carry_their_full_length():
    """Each card's list is the events the card counted, so its full length is
    the card's own number, even past the 60 shown."""
    from datetime import timedelta
    from routes.jobs import _outreach_windows
    t = _outreach_windows("week", None, None)[0] + timedelta(hours=1)   # inside last week
    sends = [event_row(ts=t, contact_id=i, companies=[f"acct{i}"]) for i in range(75)]
    calls = [event_row(kind="meeting", ts=t, source="calendar-sync") for _ in range(3)]
    converted = {"contact_id": 2, "name": "Al", "account": "Y", "at": NOW,
                 "owner": None, "editor": None}
    conn = FakeConn(lists={"converted_to_opportunity": [converted],
                           PRIOR_EVENTS: [],          # no account worked before
                           EVENTS: sends + calls})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/outreach/summary")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert (d["outreach_activity"], d["calls_booked"], d["accounts_activated"], d["converted"]) == (75, 3, 75, 1)
    assert d["drill_totals"] == {"accounts_activated": 75, "outreach_activity": 75,
                                 "calls_booked": 3, "converted": 1}
    assert len(d["drills"]["outreach_activity"]) == 60
    assert len(d["drills"]["accounts_activated"]) == 60


# ── Leadership metric drawer (/metrics/{key}) ───────────────────────────────

def test_metric_drawer_count_is_the_true_total_not_the_500_returned():
    rows = [{"email": f"p{i}@x.com", "first_touch": NOW, "full_name": None,
             "current_company": None, "total_rows": 1800} for i in range(3)]
    conn = FakeConn(lists={"ext.first_touch DESC": rows})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/metrics/outreach_total")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["count"] == 1800
    assert len(d["rows"]) == 3
    assert all("total_rows" not in row for row in d["rows"])


def test_metric_drawer_count_without_a_cap_is_the_row_count():
    conn = FakeConn(lists={"bedrock.jobs_opportunity": [
        {"id": "a", "account_name": "X"}, {"id": "b", "account_name": "Y"}]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/metrics/in_discussion")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["count"] == 2


# ── Activity feeds ──────────────────────────────────────────────────────────

def test_outreach_activity_feed_reports_events_before_its_cap():
    """One row per thing sent (OUT-11), and the full count past the limit."""
    sends = [event_row(ts=NOW) for _ in range(950)]
    conn = FakeConn(lists={EVENTS: sends + [event_row(kind="meeting", ts=NOW)]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/outreach/activity")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["total"] == 950           # the meeting is not a send
    assert len(d["events"]) == 300


def test_account_activity_reports_its_total_and_hides_the_window_column():
    act = {"id": uuid.uuid4(), "type": "email", "subject": "Hi", "description": None,
           "activity_date": NOW, "source": "gmail-sync", "logged_by": None,
           "synced_at": None, "email_from": None, "email_to": None, "email_snippet": None,
           "email_body_text": None, "meeting_duration_minutes": None,
           "jobs_relevance": None, "jobs_relevance_override": None, "is_jobs": True,
           "deleted_at": None, "total_rows": 640}
    conn = FakeConn(lists={"FROM bedrock.activity a": [act]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/account-activity?key=acme")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 640
    assert "total_rows" not in body["data"][0]


def test_intro_rows_report_their_uncapped_total():
    from routes.jobs import _intro_activity_rows
    row = {"id": uuid.uuid4(), "specific_ask": None, "context": None, "status": "accepted",
           "requested_by_email": "a@p.org", "activity_date": NOW,
           "connector_name": "Kim", "connector_email": None, "total_rows": 70}
    conn = FakeConn(lists={"bedrock.intro_request": [row]})
    rows, total = asyncio.run(_intro_activity_rows(conn, [1]))
    assert total == 70 and len(rows) == 1
    assert asyncio.run(_intro_activity_rows(conn, [])) == ([], 0)


# ── Home "Replied — needs a decision" ───────────────────────────────────────

def test_responded_contacts_is_not_capped():
    conn = FakeConn(lists={"FROM replies r": []})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/outreach/responded-contacts")
    assert r.status_code == 200, r.text
    q = next(q for q in conn.queries("fetch") if "FROM replies r" in q)
    # The statement ends at its ORDER BY: no LIMIT clause after it.
    assert q.rstrip().endswith("ORDER BY r.last_reply ASC, c.contact_id")


# ── Outreach scorecard row drill ────────────────────────────────────────────

def test_scorecard_drill_lists_everything_its_row_counted():
    row = {"contact_id": 1, "full_name": "Jo", "current_company": "X",
           "converted_at": NOW, "actor": None}
    conn = FakeConn(lists={"converted_at DESC": [row] * 640})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/outreach/scorecard/detail?key=converted_opportunities")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["touches_listed"] == d["touches_total"] == 640
