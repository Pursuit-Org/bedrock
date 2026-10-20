"""Evals for the leadership metric drill-downs (GET /metrics/{key}) and the
Overview's outcome cards (GET /placements).

The load-bearing rule (PRO-99): a drill lists exactly what its card counts,
one row per builder, so its row count is the number. Placed (D2) is
full-time or a paid trial; committed roles sit beside it, never in it.
"""
from datetime import date

import pytest

from tests.jobs_fakes import FakeConn, assert_records_match, make_jobs_client

# Employment records, read through the placement rule (services/jobs_metrics).
SECURED = "bedrock.jobs_employment_records()"
POOL = "SELECT user_id, segment FROM pool"
COMMITTED = "r.is_trial = false"   # committed FT roles still open
CURRENT_L3 = "co.level = 'L3' AND ch.end_date IS NOT NULL"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _placement(uid, builder, **ov):
    row = {"id": uid * 10 + len(ov), "user_id": uid, "builder": builder, "role_title": "Engineer",
           "company_name": "Acme", "employment_type": "full_time", "payment_amount": 90000,
           "influenced": True, "source": "staff_created", "engagement_stage": "active",
           "opportunity_id": None, "start_date": date(2026, 7, 1), "end_date": None,
           "excluded": False, "is_trial": False, "from_role": False}
    row.update(ov)
    return row


def _pool(*uids, segment="L3 - March 2025"):
    return [{"user_id": u, "segment": segment} for u in uids]


# Ana: two full-time jobs. Ben: a paid trial (recorded as contract). Cy: contract
# work, not a trial. Di: a test account. Ed: placed but not job-ready (no L3+).
RECORDS = [
    _placement(1, "Ana"),
    _placement(1, "Ana", company_name="Beta", payment_amount=110000, engagement_stage="ended"),
    _placement(2, "Ben", employment_type="contract", payment_amount=97760, is_trial=True, from_role=True),
    _placement(3, "Cy", employment_type="contract", payment_amount=5000, source="imported"),
    _placement(4, "Di", excluded=True),
    _placement(6, "Ed"),
]


def _conn(records=RECORDS, pool=_pool(1, 2, 3, 4, 5), committed=(), current_l3=None):
    return FakeConn(lists={SECURED: list(records), POOL: list(pool), COMMITTED: list(committed)},
                    vals={CURRENT_L3: current_l3})


def test_placed_drill_is_one_row_per_builder_full_time_and_trials():
    c = make_jobs_client(_conn())
    r = c.get("/api/jobs/metrics/placements")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["title"] == "Placed"
    assert [row["builder"] for row in d["rows"]] == ["Ana", "Ben"]
    assert d["count"] == 2                       # the card's number
    ana, ben = d["rows"]
    assert ana["roles"] == 2 and ana["status"] == "In role" and ana["company"] == "Acme"
    assert [ch["company"] for ch in ana["_children"]] == ["Acme", "Beta"]
    assert ana["_children"][1]["status"] == "Left"
    assert ben["type"] == "Paid trial" and ben["_children"][0]["source"] == "Deal role"
    assert [c["key"] for c in d["child_columns"]][-1] == "source"
    assert ana["_children"][0]["start_date"] == "2026-07-01"


def test_placed_drill_follows_the_job_type():
    c = make_jobs_client(_conn())
    d = c.get("/api/jobs/metrics/placements?job_type=contract").json()["data"]
    assert d["title"] == "Placed — Contract"
    assert [row["builder"] for row in d["rows"]] == ["Ben", "Cy"]
    assert d["rows"][1]["_children"][0]["source"] == "Imported"
    d = c.get("/api/jobs/metrics/placements?job_type=all").json()["data"]
    assert [row["builder"] for row in d["rows"]] == ["Ana", "Ben", "Cy"]


def test_an_unknown_job_type_is_refused():
    c = make_jobs_client(_conn())
    assert c.get("/api/jobs/metrics/placements?job_type=FT;drop").status_code == 400
    assert c.get("/api/jobs/placements?job_type=1").status_code == 400


def test_paid_work_drill_folds_a_jobs_duplicate_copies():
    recs = RECORDS + [
        _placement(5, "Fay", employment_type="contract", payment_amount=3200, engagement_stage="completed",
                   start_date=date(2026, 5, 1)),
        _placement(5, "Fay", employment_type="contract", payment_amount=3200, start_date=date(2026, 8, 1),
                   id=999),
    ]
    d = make_jobs_client(_conn(recs)).get("/api/jobs/metrics/any_paid").json()["data"]
    fay = next(row for row in d["rows"] if row["builder"] == "Fay")
    assert fay["roles"] == 1 and fay["_children"][0]["id"] == "999"   # the copy she's in
    assert d["count"] == 4                                              # Ana, Ben, Cy, Fay


def test_ft_salaries_drill_is_what_the_average_averages():
    c = make_jobs_client(_conn(committed=[{"id": "r1", "approx_salary": 85000}]))
    d = c.get("/api/jobs/metrics/ft_salaries").json()["data"]
    assert [row["builder"] for row in d["rows"]] == ["Ana"]           # full-time only, no roles
    assert d["rows"][0]["pay"] == "$110,000"                          # her highest FT pay
    s = c.get("/api/jobs/placements").json()["data"]
    assert s["ft_salaried"] == d["count"] == 1
    assert s["avg_ft_salary_placed"] == 110000


def test_the_drills_are_read_only():
    """Editing moved to the builder (Placement › Builders), Nina 10/13: the
    Overview drills carry no editable kinds."""
    d = make_jobs_client(_conn()).get("/api/jobs/metrics/placements").json()["data"]
    assert d["entity"] == "builder" and all("kind" not in row for row in d["rows"])


def test_placed_card_counts_trials_and_keeps_committed_beside_it():
    committed = [{"id": "r1", "approx_salary": 80000}, {"id": "r2", "approx_salary": 100000},
                 {"id": "r3", "approx_salary": None}]
    r = make_jobs_client(_conn(committed=committed)).get("/api/jobs/placements")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["job_ready"] == 5
    assert (d["placed"], d["placed_ft"], d["placed_trial"]) == (2, 1, 1)
    assert d["placed_in_role"] == 2 and d["placed_left"] == 0
    assert d["placed_rate"] == 40.0                                   # 2 of 5 job-ready
    assert d["committed_roles"] == 3                                  # beside, never added
    assert d["paid_work"] == 3                                        # Ana, Ben, Cy; not Di, not Ed
    assert d["avg_ft_salary_placed"] == 110000                        # placed only
    assert d["committed_expected_salary"] == 90000                    # its own line
    assert [t["value"] for t in d["job_types"]] == ["full_time", "contract", "all"]
    assert d["definitions"]["placed"]["records"]["endpoint"] == "/api/jobs/metrics/placements"


def test_current_l3_is_the_cohort_that_finished_last():
    pool = _pool(1, 2) + _pool(3, segment="L3 - March 2026")
    c = make_jobs_client(_conn(pool=pool, current_l3="L3 - March 2026"))
    d = c.get("/api/jobs/placements?segment=current_l3").json()["data"]
    assert d["segment"] == "L3 - March 2026"
    assert (d["job_ready"], d["placed"], d["paid_work"]) == (1, 0, 1)
    rows = c.get("/api/jobs/metrics/any_paid?segment=current_l3").json()["data"]["rows"]
    assert [row["builder"] for row in rows] == ["Cy"]
    segs = c.get("/api/jobs/builder-segments").json()["data"]["segments"]
    assert segs[0]["value"] == "current_l3" and segs[0]["cohort"] == "L3 - March 2026"


def test_current_l3_with_no_finished_cohort_matches_nobody():
    c = make_jobs_client(_conn(current_l3=None))
    d = c.get("/api/jobs/placements?segment=current_l3").json()["data"]
    assert (d["job_ready"], d["placed"]) == (0, 0)
    segs = c.get("/api/jobs/builder-segments").json()["data"]["segments"]
    assert "current_l3" not in [s["value"] for s in segs]


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


def test_builders_board_uses_the_cards_rule():
    """Placement › Builders (PLC-04): Placed is the card's placed; other
    counted paid work is its own status (Nina 10/13), so Placed + Paid work is
    the paid-work card. A test account's job doesn't make anyone placed."""
    roster = [{"user_id": u, "full_name": n, "email": None, "cohort": "L3+", "cohort_completed": True,
               "l3plus_segment": "L3 - March 2025"} for u, n in
              [(1, "Ana"), (2, "Ben"), (3, "Cy"), (4, "Di"), (5, "Fay")]]
    conn = FakeConn(lists={SECURED: list(RECORDS), "FROM roster ORDER BY full_name": roster})
    r = make_jobs_client(conn).get("/api/jobs/builders/board")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    status = {b["name"]: b["status"] for b in d["builders"]}
    assert status == {"Ana": "placed", "Ben": "placed", "Cy": "paid_work",
                      "Di": "not_started", "Fay": "not_started"}
    assert d["status_counts"]["placed"] == 2 and d["status_counts"]["paid_work"] == 1
    assert {b["name"]: b["counts"]["placements"] for b in d["builders"]}["Ana"] == 2


def test_builder_drawer_lists_every_record_and_derives_status_from_counted_ones():
    """The drawer is where placements are edited (Nina 10/13): it lists every
    record, says which ones count, and a test account's job doesn't make the
    builder placed (the board and the drawer agree)."""
    ident = {"user_id": 4, "full_name": "Di", "email": None, "cohort": "L3+", "cohort_completed": True,
             "linkedin_url": None, "github_url": None, "l3plus_segment": "L3 - March 2025"}
    conn = FakeConn(rows={"FROM roster WHERE user_id": ident}, lists={SECURED: list(RECORDS)})
    r = make_jobs_client(conn).get("/api/jobs/builders/4")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["derived_status"] == "not_started"
    [pl] = d["placements"]
    assert pl["counted"] is False and "excluded" not in pl and pl["provenance"] == "Entered by hand"


def test_every_outcome_number_opens_the_records_it_counts():
    """PRO-105: "View records" opens exactly the builders each line counts. Gus
    is placed but has left the role, so Placed and Still in the role differ."""
    recs = RECORDS + [_placement(5, "Gus", engagement_stage="ended")]
    committed = [{"id": "r1", "approx_salary": 85000, "account_name": "Acme", "title": "Eng"},
                 {"id": "r2", "approx_salary": None, "account_name": "Beta", "title": "Eng"}]
    c = make_jobs_client(_conn(recs, committed=committed))
    for job_type in ("full_time", "contract", "all"):
        d = c.get(f"/api/jobs/placements?job_type={job_type}").json()["data"]
        assert d["placed_in_role"] != d["placed"] or job_type != "full_time"
        assert_records_match(c, d["definitions"])
