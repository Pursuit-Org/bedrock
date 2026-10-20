"""PRO-105: "How is this calculated?" says which filters a number ignores.

A number that doesn't apply a filter on its page reports it under `ignored`,
with why, and never lists it among the filters it applied. No number changes
(decided 10/20); these only check what the icon is told.
"""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client
from tests.test_campaign_math import _conn as _campaign_conn
from tests.test_campaign_math import _funnel_conn
from tests.test_jobs_metrics import _conn as _outcome_conn


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _accounted(d: dict, *params: str) -> None:
    """Each param the page sent is applied or reported as ignored, not both."""
    for p in params:
        applied = p in d["filters"] or (p == "period" and (d["window"] or d["as_of"]))
        assert bool(applied) != (p in d["ignored"]), (d["key"], p, d["filters"], d["ignored"])


def test_builders_funnel_says_it_ignores_deal_type_owner_and_period():
    conn = FakeConn(lists={"l3plus_funnel": [], "jobs_employment_records()": []})
    d = make_jobs_client(conn).get(
        "/api/jobs/funnel/builders?deal_type=ft&owner=k@p.org"
        "&period_from=2026-09-28&period_to=2026-10-04").json()["data"]
    for key in ("job_ready", "paid", "placed"):
        ign = d["definitions"][key]["ignored"]
        assert set(ign) >= {"deal_type", "owner", "period"}, key
        assert "owner" not in d["definitions"][key]["filters"]


def test_contacts_funnel_says_it_ignores_the_owner():
    c = make_jobs_client(_funnel_conn())
    d = c.get("/api/jobs/funnel/prospects?owner=k@p.org&deal_type=ft").json()["data"]
    count = d["definitions"]["count"]
    _accounted(count, "owner", "deal_type")
    assert "owner" in count["ignored"]
    for m in d["milestones"]:
        assert "owner" in m["definition"]["ignored"]
    # The opportunities funnel does apply it.
    d = c.get("/api/jobs/funnel/opportunities?owner=k@p.org").json()["data"]
    assert d["definitions"]["count"]["filters"]["owner"] == "k@p.org"
    assert d["definitions"]["count"]["ignored"] == {}


def test_outcome_cards_say_what_the_cohort_and_job_type_dont_narrow():
    c = make_jobs_client(_outcome_conn(committed=[{"id": "r1", "approx_salary": 85000,
                                                   "account_name": "Acme", "title": "Eng"}]))
    d = c.get("/api/jobs/placements?segment=L3%20-%20March%202025&job_type=contract").json()["data"]
    defs = d["definitions"]
    assert set(defs["committed_roles"]["ignored"]) == {"segment", "job_type"}
    assert set(defs["committed_expected_salary"]["ignored"]) == {"segment", "job_type"}
    assert set(defs["paid_work"]["ignored"]) == {"job_type"}
    assert set(defs["avg_ft_salary_placed"]["ignored"]) == {"job_type"}
    assert defs["placed"]["ignored"] == {}
    # Under the defaults nothing is ignored but paid work's job type.
    d = c.get("/api/jobs/placements").json()["data"]
    assert {k: set(v["ignored"]) for k, v in d["definitions"].items() if v["ignored"]} == {
        "paid_work": {"job_type"}}


def test_campaign_totals_say_the_date_range_is_not_theirs():
    c = make_jobs_client(_campaign_conn())
    d = c.get("/api/jobs/tag-campaigns/operation_35/stats"
              "?date_from=2026-09-21&date_to=2026-09-27").json()["data"]
    assert all("period" in v["ignored"] for v in d["definitions"].values())
    d = c.get("/api/jobs/tag-campaigns/operation_35/stats").json()["data"]
    assert all(v["ignored"] == {} for v in d["definitions"].values())


def test_conversions_say_they_ignore_the_sender_scope():
    from tests.test_outreach_counting import NO_CONVERSIONS
    from tests.jobs_fakes import EVENTS, PRIOR_EVENTS
    conn = FakeConn(rows={NO_CONVERSIONS: {"n0": 0, "n1": 0}}, lists={EVENTS: [], PRIOR_EVENTS: []})
    c = make_jobs_client(conn)
    rows = c.get("/api/jobs/outreach/scorecard?scope=staff").json()["data"]["activity_pipeline"]
    by = {r["metric"]: r["definition"] for r in rows}
    assert "scope" in by["converted_opportunities"]["ignored"]
    assert "scope" not in by["converted_opportunities"]["filters"]
    assert by["total_outreach_activity"]["filters"]["scope"] == "staff"
    assert by["total_outreach_activity"]["ignored"] == {}
