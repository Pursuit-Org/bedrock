"""Evals for the leadership metric drill-downs (GET /metrics/{key}).

The load-bearing one is `placements` ("FT Roles Secured"): the drill must show
exactly what the headline counts — FT-placed builders + committed open FT
roles — and never PT/contract placements.
"""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

SECURED = "FROM bedrock.secured_jobs()"
TRIALS = "r.is_trial = true"       # committed active trials (shown, not counted)
COMMITTED = "r.is_trial = false"   # committed FT roles still open


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _placement(uid, builder, **ov):
    row = {"id": f"er{uid}", "user_id": uid, "builder": builder, "role_title": "Engineer",
           "company_name": "Acme", "employment_type": "full_time", "payment_amount": 90000,
           "influenced": True, "source": "staff", "engagement_stage": None,
           "opportunity_id": None, "start_date": None, "job_application_id": None,
           "opp_id": None}
    row.update(ov)
    return row


def test_placements_drill_is_ft_placed_plus_committed():
    conn = FakeConn(lists={
        # two FT placements for the same builder + one for another — the drill
        # is flat (one row per placement/role), no per-builder grouping
        SECURED: [_placement(1, "Ana"), _placement(1, "Ana", company_name="Beta"), _placement(2, "Ben")],
        TRIALS: [],
        COMMITTED: [{"id": "r9", "approx_salary": 85000, "opp_id": None,
                     "account_name": "Acme", "title": "AI Analyst"}],
    })
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/metrics/placements")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["title"] == "FT Roles Secured"
    # 3 placement rows + 1 committed open req = 4 rows
    assert d["count"] == 4
    placed = [row for row in d["rows"] if row["status"] == "Full-time placed"]
    committed = [row for row in d["rows"] if row["status"] == "Committed – open req"]
    assert len(placed) == 3 and len(committed) == 1
    assert {row["builder"] for row in placed} == {"Ana", "Ben"}
    assert all(row["counted"] == "✓" for row in placed + committed)
    assert committed[0]["company"] == "Acme" and committed[0]["role"] == "AI Analyst"
    assert committed[0]["builder"] == "—"   # seat locked in, nobody placed yet


def test_placements_drill_query_filters_full_time_only():
    conn = FakeConn(lists={SECURED: [], COMMITTED: []})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/metrics/placements")
    assert r.status_code == 200
    secured_q = next(q for q in conn.queries("fetch") if SECURED in q)
    assert "employment_type = 'full_time'" in secured_q   # never PT/contract


def test_ft_salaries_drill_flat_editable():
    conn = FakeConn(lists={
        SECURED: [_placement(1, "Ana", role_title="Eng", company_name="Acme", payment_amount=90000)],
        "FROM bedrock.jobs_role r": [{"id": "r1", "account_name": "Beta", "title": "FT role", "approx_salary": 85000}],
    })
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/metrics/ft_salaries")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["entity"] == "salary"
    kinds = {row["kind"] for row in d["rows"]}
    assert kinds == {"placed", "committed"}
    placed = next(row for row in d["rows"] if row["kind"] == "placed")
    assert placed["salary"] == "90000" and placed["id"]  # raw number + id for editing


def test_unknown_metric_key_404():
    c = make_jobs_client(FakeConn())
    r = c.get("/api/jobs/metrics/not_a_metric")
    assert r.status_code == 404


def test_deals_drill_shape():
    conn = FakeConn(lists={"FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL":
                           [{"id": "o1", "account_name": "Acme", "stage": "active_in_discussions",
                             "deal_type": "ft", "owner_email": "a@p.org", "title": "Eng"}]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/metrics/active_orgs")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert [col["key"] for col in d["columns"]] == ["account_name", "stage", "deal_type", "owner_email", "title"]
    assert d["rows"][0]["account_name"] == "Acme"


def test_total_leads_drill_filters_jobs_contacts():
    conn = FakeConn(lists={"FROM public.contacts WHERE is_jobs_contact=true":
                           [{"id": 1, "full_name": "Jo", "current_company": "X",
                             "current_title": "PM", "contact_stage": "lead", "email": "j@x.com"}]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/metrics/total_leads")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["rows"][0]["full_name"] == "Jo"
