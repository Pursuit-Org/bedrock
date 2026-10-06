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

from tests.jobs_fakes import FakeConn, make_jobs_client
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

def test_outreach_summary_reports_each_drill_list_uncapped_size():
    touch = {"at": NOW, "subkind": "email", "editor": "a@p.org", "subject": "Hi",
             "contact_id": 1, "name": "Jo", "account": "X", "owner": None, "total_rows": 412}
    activated = {"name": "X", "at": NOW, "editor": None, "owner": None,
                 "last_prior": None, "total_rows": 75}
    converted = {"contact_id": 2, "name": "Al", "account": "Y", "at": NOW,
                 "owner": None, "editor": None, "total_rows": 3}
    conn = FakeConn(
        rows={"acct_win": {"accounts_activated": 75, "accounts_reached": 90,
                           "outreach_activity": 300, "calls_booked": 20},
              "count(*) AS n": {"n": 3}},
        lists={"converted_to_opportunity": [converted],
               "FROM win w": [activated],
               "FROM linked l": [touch]},
    )
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/outreach/summary")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["drill_totals"] == {"accounts_activated": 75, "outreach_activity": 412,
                                 "calls_booked": 412, "converted": 3}
    assert "total_rows" not in d["drills"]["outreach_activity"][0]
    # The count is a window over the full set, taken before the LIMIT.
    drill_qs = [q for q in conn.queries("fetch") if "LIMIT 60" in q]
    assert len(drill_qs) == 4
    assert all("count(*) OVER () AS total_rows" in q for q in drill_qs)


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
    row = {"at": NOW, "subkind": "email", "editor": "a@p.org", "subject": "Hi",
           "snippet": None, "contact_id": 1, "full_name": "Jo", "account": "X",
           "owner": None, "owner_source": None, "total_rows": 950}
    conn = FakeConn(lists={"FROM linked l": [row]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/outreach/activity")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["total"] == 950
    assert len(d["events"]) == 1


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

def test_scorecard_drill_reports_touches_listed_and_matched():
    row = {"contact_id": 1, "full_name": "Jo", "current_company": "X",
           "converted_at": NOW, "actor": None, "total_rows": 640}
    conn = FakeConn(lists={"converted_at DESC LIMIT 500": [row]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/outreach/scorecard/detail?key=converted_opportunities")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["touches_listed"] == 1
    assert d["touches_total"] == 640
