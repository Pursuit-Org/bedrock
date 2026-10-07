"""PRO-117: interviews are counted over time, from each application's stage history.

No database. The rule (services/jobs_metrics.interviews) runs on rows shaped
like INTERVIEW_APPLICATIONS_SQL's; the routes run through FakeConn.

SAMPLE is the Jobs team's applications as production had them on 2026-10-07
(ids and histories verbatim; builders, companies and who made each change left
out): every one with an interview entry, plus the cases around them. The
dictionary's reference query (jobs_metrics.interviews_reference_sql) ran on
production that day for 9/28-10/11 and returned 6 interviews, 0 hired: the
same six applications counted here.
"""
import json
from datetime import date
from uuid import uuid4

import pytest

from services import jobs_metrics as jm
from tests.jobs_fakes import FakeConn, make_jobs_client

OPP = str(uuid4())


def app_row(id, stage, hist, *, deal_type="ft", on_opp=True, owner="avni@pursuit.org"):
    return {
        "job_application_id": id, "builder_id": id, "stage": stage,
        "stage_history": json.dumps(hist),          # selected as text
        "builder": f"Builder {id}", "company_name": "Company", "role_title": "Role",
        "jobs_opportunity_id": OPP if on_opp else None,
        "owner_email": owner if on_opp else None, "deal_type": deal_type if on_opp else None,
    }


def h(*entries):
    return [{"date": d, "stage": s} for d, s in entries]


SAMPLE = [
    # Moved to interview through Bedrock since 9/29: dated, counted.
    app_row(932, "interview", h(("2026-09-29", "interview"))),
    app_row(875, "interview", h(("2026-10-06", "interview"))),
    app_row(877, "interview", h(("2026-10-06", "interview"))),
    app_row(879, "interview", h(("2026-10-06", "applied"), ("2026-10-06", "interview"))),
    # A correction: rejected, then put back at interview the same day.
    app_row(965, "interview", h(("2026-10-06", "rejected"), ("2026-10-06", "interview"))),
    # On an opportunity with no deal type.
    app_row(960, "interview", h(("2026-10-07", "interview")), deal_type=None),
    # At interview now, but the move wasn't recorded (before 9/29): undated.
    app_row(814, "interview", h(("2026-08-04", "applied"))),
    # Logged at interview with an empty history (before PRO-117): undated.
    app_row(841, "interview", []),
    # Rejected on 9/29 with nothing before it: no interview on record.
    app_row(911, "rejected", h(("2026-09-29", "rejected"))),
    # Entries with no stage or date (the platform wrote three of these).
    app_row(874, "withdrawn", [{"date": None, "stage": None}] * 3 + h(("2026-10-06", "withdrawn"))),
    # Logged straight at accepted: a hire with no recorded interview.
    app_row(902, "accepted", []),
    app_row(884, "applied", h(("2026-09-30", "applied"))),
    # Staff sourced and on no opportunity.
    app_row(909, "interview", [], on_opp=False),
]


# ── the rule ─────────────────────────────────────────────────────────────────

def test_the_count_matches_the_history_for_the_production_sample():
    iv = jm.interviews(SAMPLE)
    last_week = iv.in_window(date(2026, 9, 28), date(2026, 10, 4))
    this_week = iv.in_window(date(2026, 10, 5), date(2026, 10, 11))
    assert [r["job_application_id"] for r in last_week] == [932]
    assert sorted(r["job_application_id"] for r in this_week) == [875, 877, 879, 960, 965]
    # 6 over the two weeks, 0 hired: the reference query's answer on production.
    assert len(last_week) + len(this_week) == 6
    assert iv.hired(last_week + this_week) == []
    assert sorted(r["job_application_id"] for r in iv.undated) == [814, 841, 909]


def test_an_interview_still_counts_after_the_application_moves_on():
    rows = [app_row(1, "rejected", h(("2026-10-01", "applied"), ("2026-10-02", "interview"),
                                      ("2026-10-05", "rejected")))]
    iv = jm.interviews(rows)
    assert [r["job_application_id"] for r in iv.in_window(date(2026, 9, 28), date(2026, 10, 4))] == [1]
    assert iv.undated == []


def test_a_second_entry_into_interview_is_the_same_interview():
    rows = [app_row(1, "interview", h(("2026-10-02", "interview"), ("2026-10-03", "screen"),
                                       ("2026-10-07", "interview")))]
    iv = jm.interviews(rows)
    assert iv.dated == [(date(2026, 10, 2), rows[0])]


def test_interview_to_hire_counts_only_applications_that_reached_interview():
    rows = [
        app_row(1, "accepted", h(("2026-10-01", "interview"), ("2026-10-06", "accepted"))),
        app_row(2, "rejected", h(("2026-10-02", "interview"), ("2026-10-06", "rejected"))),
        app_row(3, "accepted", h(("2026-10-02", "accepted"))),   # no recorded interview
    ]
    iv = jm.interviews(rows)
    week = iv.in_window(date(2026, 9, 28), date(2026, 10, 4))
    assert [r["job_application_id"] for r in week] == [1, 2]
    assert [r["job_application_id"] for r in iv.hired(week)] == [1]


def test_owner_and_deal_type_narrow_to_the_opportunity():
    assert len(jm.interviews(SAMPLE, owner="AVNI@pursuit.org").undated) == 2   # 909 has no opportunity
    assert jm.interviews(SAMPLE, owner="devika@pursuit.org").dated == []
    ft = jm.interviews(SAMPLE, deal_types=["ft"])
    assert 960 not in [r["job_application_id"] for _d, r in ft.dated]
    assert [r["job_application_id"] for r in ft.undated] == [814, 841]
    unset = jm.interviews(SAMPLE, deal_types=["unset"])
    assert [r["job_application_id"] for _d, r in unset.dated] == [960]


@pytest.mark.parametrize("hist,expected", [
    (None, None),
    ("[]", None),
    ('[{"date": "2026-10-06", "stage": "interview"}]', date(2026, 10, 6)),
    ([{"date": "2026-10-06T21:00:00", "stage": "interview"}], date(2026, 10, 6)),
    ([{"date": None, "stage": "interview"}, {"date": "bad", "stage": "interview"}], None),
    ([{"stage": "interview"}, "not an entry"], None),
])
def test_entered_interview_reads_what_the_writers_left(hist, expected):
    assert jm.entered_interview(hist) == expected


def test_the_reference_query_is_the_same_rule():
    sql = jm.interviews_reference_sql()
    assert "source_type IN ('Pursuit_referred', 'staff_sourced')" in sql
    assert "min(left(e->>'date', 10)::date)" in sql and "e->>'stage' = 'interview'" in sql
    assert "count(*) FILTER (WHERE stage = 'accepted') AS hired" in sql
    assert "dd.window_from" in sql and "dd.window_to" in sql


def test_a_stage_entry_is_dated_in_new_york():
    sql = jm.stage_entry_sql("$1::varchar", "$2::text")
    assert "now() AT TIME ZONE 'America/New_York'" in sql
    assert "'stage', $1::varchar" in sql and "'changed_by', $2::text" in sql


# ── the writes ───────────────────────────────────────────────────────────────

def _insert(conn):
    return next(c for c in conn.calls if "INSERT INTO public.job_applications" in c[1])


def test_logging_an_application_on_an_opportunity_records_its_stage():
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity": {"account_name": "Acme"}},
                    vals={"INSERT INTO public.job_applications": 101})
    r = make_jobs_client(conn).post(f"/api/jobs/opportunities/{OPP}/builder-activity",
                                    json={"user_id": 5, "builder_name": "B", "stage": "interview"})
    assert r.status_code == 200, r.text
    _kind, sql, args = _insert(conn)
    assert "stage_history" in sql and "jsonb_build_array(jsonb_build_object(" in sql
    assert "'stage', $4::varchar" in sql and "'changed_by', $9::text" in sql
    assert args[3] == "interview" and args[8] == "tester@pursuit.org"


def test_logging_an_application_on_a_role_records_its_stage():
    conn = FakeConn(rows={"bedrock.builder_by_id": {"user_id": 5},
                          "FROM bedrock.jobs_role r": {"title": "Analyst", "opportunity_id": OPP,
                                                       "account_name": "Acme"}},
                    vals={"INSERT INTO public.job_applications": 102})
    r = make_jobs_client(conn).post(f"/api/jobs/roles/{uuid4()}/applications",
                                    json={"user_id": 5, "builder_name": "B", "stage": "accepted"})
    assert r.status_code == 200, r.text
    _kind, sql, args = _insert(conn)
    assert "'stage', $4::varchar" in sql and "'changed_by', $9::text" in sql
    assert args[3] == "accepted" and args[8] == "tester@pursuit.org"


def test_saving_the_same_stage_appends_nothing():
    conn = FakeConn(vals={"UPDATE public.job_applications": "UPDATE 1"})
    r = make_jobs_client(conn).patch("/api/jobs/builder-activity/7", json={"stage": "interview"})
    assert r.status_code == 200, r.text
    sql = conn.executed("UPDATE public.job_applications")[0][1]
    assert "CASE WHEN stage IS DISTINCT FROM $1::varchar" in sql
    assert "ELSE stage_history END" in sql
    assert "now() AT TIME ZONE 'America/New_York'" in sql


# ── the endpoint ─────────────────────────────────────────────────────────────

def _get(params):
    conn = FakeConn(lists={"FROM public.job_applications ja": SAMPLE})
    return make_jobs_client(conn).get("/api/jobs/interviews", params=params)


def test_interviews_endpoint_counts_the_window_and_the_weeks():
    r = _get({"date_from": "2026-10-05", "date_to": "2026-10-11", "weeks": 3})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["interviews"] == 5 and d["hired"] == 0 and d["rate_pct"] == 0
    assert d["undated"] == 3
    assert d["history_from"] == "2026-09-29"
    assert [(w["week_start"], w["interviews"], w["before_history"]) for w in d["weeks"]] == [
        ("2026-09-21", 0, True), ("2026-09-28", 1, False), ("2026-10-05", 5, False)]
    assert d["rows"][0]["entered"] == "2026-10-07"           # latest first
    assert {x["job_application_id"] for x in d["undated_rows"]} == {814, 841, 909}
    defs = d["definitions"]
    assert defs["interviews"]["measure"] == "interviews" and defs["interviews"]["value"] == 5
    assert defs["interview_to_hire"]["measure"] == "interview_to_hire"
    assert defs["interviews"]["window"] == {"from": "2026-10-05", "to": "2026-10-11", "tz": "America/New_York"}


def test_interviews_endpoint_applies_the_pipeline_filters():
    d = _get({"date_from": "2026-10-05", "date_to": "2026-10-11", "deal_type": "ft"}).json()["data"]
    assert d["interviews"] == 4 and d["undated"] == 2
    assert d["definitions"]["interviews"]["filters"] == {"deal_type": "ft"}


def test_no_interviews_reads_as_no_rate():
    d = _get({"date_from": "2026-09-14", "date_to": "2026-09-20"}).json()["data"]
    assert d["interviews"] == 0 and d["rate_pct"] is None


def test_a_bad_range_is_a_400():
    assert _get({"date_from": "2026-10-11", "date_to": "2026-10-05"}).status_code == 400
    assert _get({"date_from": "10/5/2026"}).status_code == 400
