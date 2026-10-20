"""PRO-100: one "contacted", campaigns that agree with themselves, and
conversion as a real rate (D10, D11, D14; Nina 10/13).

No database: the rules are pure Python over rows shaped like the SQL's, and
the endpoints run on FakeConn.
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from services import jobs_metrics as jm
from services import outreach_counting as oc
from tests.jobs_fakes import EVENTS, FakeConn, assert_records_match, event_row, make_jobs_client

T = datetime(2026, 9, 24, 15, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _ev(**kw):
    return oc.Event.from_row(event_row(ts=kw.pop("ts", T), **kw))


# ── contacted: activity, once per piece ──────────────────────────────────────

def test_a_call_booking_alone_is_not_contact():
    act = oc.activity_by_contact([_ev(kind="call_booked", contact_id=1)], {1})
    assert act == {}


def test_activity_reaches_every_contact_on_it_and_no_one_else():
    e = _ev(contact_id=1, contact_ids=[1, 2, 9])
    act = oc.activity_by_contact([e], {1, 2})
    assert set(act) == {1, 2} and act[1] == (1, T)


def test_a_meeting_logged_as_a_call_is_one_piece_of_activity():
    call = _ev(kind="call", contact_id=1, activity_id="call-1")
    meeting = _ev(kind="meeting", contact_id=1, logged_as="call-1", ts=T + timedelta(minutes=5))
    email = _ev(contact_id=1)
    n, last = oc.activity_by_contact([call, meeting, email], {1})[1]
    assert n == 2 and last == T + timedelta(minutes=5)


# ── who is in a campaign ─────────────────────────────────────────────────────

def test_campaign_groups():
    assert jm.campaign_key("operation_35_lt_nick") == "operation_35"
    assert jm.campaign_key("alumni_7") == "alumni"
    assert jm.campaign_key("board_advisors") == "board_advisors"


def test_in_pipeline_is_the_membership_and_staff_are_out():
    sql = jm.CAMPAIGN_CONTACTS_SQL
    assert "m.contact_id IS NOT NULL AS in_pipeline" in sql
    assert "is_jobs_contact" not in sql          # the 5x larger prospect flag (CMP-01)
    assert f"NOT {jm.internal_contact_sql('c')}" in sql


def test_staff_rule_reads_current_staff_and_the_company():
    s = jm.internal_contact_sql("c")
    assert "o.is_active" in s and "s.enabled" in s and "unnest(s.aliases)" in s
    assert "= 'pursuit'" in s and "LIKE 'alumni%'" in s
    # No address is "not staff", never NULL (NOT NULL would drop the contact).
    assert "coalesce(lower(btrim(c.email)) IN (" in s and "), false)" in s
    # A former staffer's old domain isn't a rule: Erick Chang is at Uber.
    assert "c4q" not in s and "@pursuit" not in s


def _row(cid, stage, account="acme", in_pipeline=True, company=None):
    return {"campaign": "op35", "contact_id": cid, "full_name": f"C{cid}",
            "company": company if company is not None else account, "account_key": account,
            "in_pipeline": in_pipeline, "stage": stage if in_pipeline else None,
            "owner_email": None, "stage_entered_at": None}


ROWS = [
    _row(1, "initial_outreach"),
    _row(2, "converted_to_opportunity"),                 # converted with no activity (Nick)
    _row(3, "converted_to_opportunity", account="beta", company="Beta "),
    _row(4, "not_a_fit", account="gamma"),               # ruled out, never contacted
    _row(5, "assigned", account=None),                   # contacted, still at Assigned
    _row(6, "scheduling", account="beta", company="BETA"),
    _row(7, None, in_pipeline=False),                    # tagged, not in the pipeline
]
CONTACTED = {1, 3, 5, 6}


def test_campaign_numbers():
    n = jm.campaign_numbers(ROWS, CONTACTED)
    assert (n.contacts, n.in_pipeline, n.accounts) == (7, 6, 3)
    assert (n.contacted, n.accounts_reached) == (4, 2)
    assert n.stages["scheduling"] == 1                   # was dropped into "not yet"
    assert sum(n.stages.values()) == n.in_pipeline
    assert sum(n.stages_contacted.values()) == n.contacted
    # Of the 4 contacted, 1 converted. Contact 2 converted without activity and
    # is in neither number, so the rate can't pass 100%.
    assert (n.converted, n.converted_contacted, n.conversion) == (2, 1, 25)


# ── the endpoints agree with each other ──────────────────────────────────────

CATALOG = [
    {"slug": "operation_35_lt", "label": "Operation 35 — LT", "sort_order": 130,
     "owner_email": None, "is_current": True},
    {"slug": "operation_35_other", "label": "Operation 35 — Other", "sort_order": 170,
     "owner_email": "avni@pursuit.org", "is_current": True},
    {"slug": "board", "label": "Board", "sort_order": 30, "owner_email": None, "is_current": False},
]


def _conn(rows=ROWS, catalog=CATALOG):
    events = [event_row(ts=T, contact_id=c) for c in sorted(CONTACTED)]
    events += [event_row(kind="call_booked", ts=T, contact_id=4),
               event_row(ts=T + timedelta(days=1), contact_id=1)]
    return FakeConn(lists={
        "FROM bedrock.contact_tag_catalog WHERE active": catalog,
        "SELECT DISTINCT ON (g.campaign": [{**r, "campaign": "operation_35"} for r in rows],
        "DISTINCT lower(email) AS email": [{"email": "avni@pursuit.org"}],
        EVENTS: events,
    })


def test_row_activation_sankey_and_drill_say_the_same_contacted():
    conn = _conn()
    c = make_jobs_client(conn)
    listed = {x["key"]: x for x in c.get("/api/jobs/tag-campaigns").json()["data"]}
    stats = c.get("/api/jobs/tag-campaigns/operation_35/stats").json()["data"]["totals"]
    recs = c.get("/api/jobs/tag-campaigns/operation_35/records").json()["data"]

    row = listed["operation_35"]
    assert row["contacted"] == stats["contacted"] == 4
    assert sum(stats["stages_contacted"].values()) == 4
    assert sum(1 for r in recs["contacts"] if r["contacted"]) == 4
    assert row["accounts_reached"] == stats["accounts_reached"] == 2
    assert sum(a["reached"] > 0 for a in recs["accounts"]) == 2
    assert row["in_pipeline"] == stats["in_pipeline"] == len(recs["contacts"]) == 6
    assert row["conversion"] == stats["conversion"] == 25


def test_drill_activity_is_the_same_rule_and_accounts_fold_spellings():
    recs = make_jobs_client(_conn()).get("/api/jobs/tag-campaigns/operation_35/records").json()["data"]
    by_id = {r["contact_id"]: r for r in recs["contacts"]}
    assert by_id[1]["activity"] == 2                     # two emails
    assert by_id[4]["activity"] == 0 and not by_id[4]["contacted"]   # a booking isn't activity
    # "Beta " and "BETA" are one account; no company is unassigned, not "(no company)".
    names = {a["company"]: a for a in recs["accounts"]}
    assert set(names) == {"acme", "Beta", "gamma"}
    assert (names["Beta"]["contacts"], names["Beta"]["reached"]) == (2, 2)
    assert all(a["company"] != "(no company)" for a in recs["accounts"])
    assert recs["unassigned"] == {"contacts": 1, "reached": 1}


def test_current_campaign_and_past_ones():
    listed = make_jobs_client(_conn()).get("/api/jobs/tag-campaigns").json()["data"]
    assert [(x["key"], x["current"]) for x in listed] == [("board", False), ("operation_35", True)]
    op = next(x for x in listed if x["key"] == "operation_35")
    assert op["slugs"] == ["operation_35_lt", "operation_35_other"]
    assert op["owner_email"] == "avni@pursuit.org"


def test_before_the_migration_every_campaign_reads_current():
    import asyncpg

    class NoColumn(FakeConn):
        async def fetch(self, query, *args, timeout=None):
            if "is_current" in query:
                raise asyncpg.exceptions.UndefinedColumnError("column is_current does not exist")
            return await super().fetch(query, *args, timeout=timeout)

    conn = NoColumn(lists=_conn().lists)
    listed = make_jobs_client(conn).get("/api/jobs/tag-campaigns").json()["data"]
    assert all(x["current"] for x in listed)


def test_make_current_marks_every_slug_of_one_campaign():
    conn = _conn()
    r = make_jobs_client(conn).put("/api/jobs/tag-campaigns/current", json={"key": "operation_35"})
    assert r.status_code == 200, r.text
    (_, q, args), = conn.executed("SET is_current")
    assert args[0] == ["operation_35_lt", "operation_35_other"]
    assert make_jobs_client(_conn()).put("/api/jobs/tag-campaigns/current",
                                         json={"key": "nope"}).status_code == 404


def test_reorder_and_owner_reach_a_grouped_campaign():
    """Operation 35's key is no slug, so both used to update nothing."""
    conn = _conn()
    c = make_jobs_client(conn)
    c.put("/api/jobs/tag-campaigns/order", json={"order": ["operation_35", "board"]})
    c.put("/api/jobs/tag-campaigns/owner", json={"key": "operation_35", "owner_email": "Kwame@pursuit.org"})
    orders = conn.executed("SET sort_order")
    assert [a for _, _, a in orders] == [(10, ["operation_35_lt", "operation_35_other"]), (20, ["board"])]
    (_, _, owner_args), = conn.executed("SET owner_email")
    assert owner_args == ("kwame@pursuit.org", ["operation_35_lt", "operation_35_other"])


# ── conversion between milestones (D11) ──────────────────────────────────────

NY = jm.NY


def _start(cid, first, at, opps=("o1",)):
    return {"contact_id": cid, "name": f"C{cid}", "company": "acme", "first_stage": first,
            "started_at": at, "opp_ids": list(opps)}


def test_only_contacts_that_started_at_the_first_stage_count():
    at = datetime(2026, 9, 29, 14, tzinfo=timezone.utc)
    starts = [
        _start(1, "assigned", at),                      # reached interview
        _start(2, "assigned", at, opps=()),             # no linked opportunity
        _start(3, "call_booked", at),                   # added straight at Call Booked
        _start(4, "on_hold", at, opps=("o2",)),         # folds to revisit, not assigned
    ]
    m = jm.first_stage_to_interview(starts, {"o1": [date(2026, 10, 2)], "o2": [date(2026, 10, 2)]},
                                    first_stage="assigned")
    assert [r["contact_id"] for r in m.started] == [1, 2]
    assert [r["contact_id"] for r in m.reached] == [1] and m.rate == 50


def test_an_interview_before_the_start_does_not_count():
    at = datetime(2026, 10, 5, 14, tzinfo=timezone.utc)
    m = jm.first_stage_to_interview([_start(1, "assigned", at)], {"o1": [date(2026, 10, 1)]},
                                    first_stage="assigned")
    assert m.rate == 0


def test_a_later_interview_on_the_same_deal_counts():
    """A contact linked to a deal after its first interview still reaches
    the next one (review, 10/13)."""
    at = datetime(2026, 10, 5, 14, tzinfo=timezone.utc)
    rows = [{"job_application_id": i, "stage": "interview", "jobs_opportunity_id": "o1",
             "stage_history": [{"date": d, "stage": "interview"}]}
            for i, d in enumerate(["2026-09-30", "2026-10-20"])]
    iv = jm.interview_by_opportunity(rows)
    assert iv == {"o1": [date(2026, 9, 30), date(2026, 10, 20)]}
    m = jm.first_stage_to_interview([_start(1, "assigned", at)], iv, first_stage="assigned")
    assert m.rate == 100 and m.reached[0]["interview_on"] == date(2026, 10, 20)


def test_the_period_picks_who_started_in_it():
    inside = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)
    before = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)
    starts = [_start(1, "assigned", inside), _start(2, "assigned", before)]
    start, end = jm.date_window("2026-09-28", "2026-10-04")
    m = jm.first_stage_to_interview(starts, {"o1": [date(2026, 10, 1)]}, first_stage="assigned",
                                    start=start, end=end)
    assert [r["contact_id"] for r in m.started] == [1] and m.rate == 100


def test_opportunities_start_at_in_discussions_including_retired_names():
    at = datetime(2026, 9, 1, tzinfo=timezone.utc)
    opps = [{"id": "a", "first_stage": "initial_outreach", "started_at": at},     # folds
            {"id": "b", "first_stage": "closed_won", "started_at": at},           # imported won
            {"id": "c", "first_stage": "active_in_discussions", "started_at": at}]
    m = jm.first_stage_to_interview(opps, {"a": [date(2026, 9, 10)], "b": [date(2026, 9, 10)]},
                                    first_stage=jm.FIRST_OPPORTUNITY_STAGE)
    assert [r["id"] for r in m.started] == ["a", "c"] and m.rate == 50


def test_interview_to_hire_is_never_over_100():
    rows = [{"job_application_id": i, "stage": s, "jobs_opportunity_id": "o1",
             "stage_history": [{"date": "2026-09-30", "stage": "interview"}]}
            for i, s in enumerate(["accepted", "interview", "rejected"])]
    rows.append({"job_application_id": 9, "stage": "accepted", "jobs_opportunity_id": "o1",
                 "stage_history": [{"date": "2026-09-30", "stage": "accepted"}]})  # no interview
    m = jm.interview_to_hire(jm.interviews(rows))
    assert (len(m.reached), len(m.started), m.rate) == (1, 3, 33)
    assert jm.interview_by_opportunity(rows) == {"o1": [date(2026, 9, 30)] * 3}


OPP_STARTS = "AS first_stage,\n           o.created_at AS started_at"
CONTACT_STARTS = "AS first_stage,\n           least(f.changed_at"
APPS = "FROM public.job_applications ja"


def _funnel_conn(owner_rows=()):
    at = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)
    hist = [{"date": "2026-10-01", "stage": "interview"}]
    return FakeConn(lists={
        OPP_STARTS: [
            {"id": "o1", "name": "Acme", "owner_email": "k@p.org", "deal_type": "ft",
             "first_stage": "active_in_discussions", "started_at": at},
            {"id": "o2", "name": "Beta", "owner_email": "a@p.org", "deal_type": "ft",
             "first_stage": "active_in_discussions", "started_at": at},
            {"id": "o3", "name": "Gamma", "owner_email": "k@p.org", "deal_type": "ft",
             "first_stage": "closed_won", "started_at": at},
        ],
        CONTACT_STARTS: [_start(1, "assigned", at, opps=("o1",)),
                         _start(2, "assigned", at, opps=())],
        APPS: [
            {"job_application_id": 1, "stage": "accepted", "stage_history": hist,
             "jobs_opportunity_id": "o1", "owner_email": "k@p.org", "deal_type": "ft"},
            {"job_application_id": 2, "stage": "interview", "stage_history": hist,
             "jobs_opportunity_id": "o3", "owner_email": "k@p.org", "deal_type": "ft"},
        ],
    })


PERIOD = "?period_from=2026-09-28&period_to=2026-10-04"


@pytest.mark.parametrize("ftype", ["opportunities", "prospects"])
@pytest.mark.parametrize("qs", ["", PERIOD])
def test_funnels_carry_milestones_not_row_rates(ftype, qs):
    d = make_jobs_client(_funnel_conn()).get(f"/api/jobs/funnel/{ftype}{qs}").json()["data"]
    assert all(s["conversion_in"] is None and s["conversion_to_next"] is None for s in d["stages"])
    ms = {m["key"]: m for m in d["milestones"]}
    assert set(ms) == {"first_stage_to_interview", "interview_to_hire"}
    for m in ms.values():
        assert m["rate"] is None or 0 <= m["rate"] <= 100
        assert m["numerator"] <= m["denominator"]
    first = ms["first_stage_to_interview"]
    # Opportunities: o3 was created at Closed Won, so it is in neither number
    # (D11). Contacts: one of two assigned is linked to an interviewed one.
    assert (first["numerator"], first["denominator"]) == (1, 2)
    assert (ms["interview_to_hire"]["numerator"], ms["interview_to_hire"]["denominator"]) == (1, 2)
    if qs == "":
        # The Overview has no period, so no prior window to compare with.
        assert all(m["rate_prev"] is None for m in ms.values())


def test_opportunity_milestones_follow_the_owner_filter():
    d = make_jobs_client(_funnel_conn()).get(
        f"/api/jobs/funnel/opportunities{PERIOD}&owner=k@p.org").json()["data"]
    first = next(m for m in d["milestones"] if m["key"] == "first_stage_to_interview")
    assert (first["numerator"], first["denominator"]) == (1, 1)


def test_deal_type_lens_matches_the_sql_one():
    from routes import jobs as jobs_routes
    assert jobs_routes._deal_type_matches(None, ["unset"]) and not jobs_routes._deal_type_matches("ft", ["pt"])


# ── activity depth (OUT-10) ──────────────────────────────────────────────────

def test_activity_depth_covers_every_contact_in_outreach():
    cohort = [{"contact_id": 1, "owner_email": None, "full_name": "A", "current_company": "acme"},
              {"contact_id": 2, "owner_email": "x@p.org", "full_name": "B", "current_company": "b"}]
    now = datetime.now(timezone.utc)
    conn = FakeConn(lists={
        "WHERE m.stage = 'initial_outreach'": cohort,
        "DISTINCT lower(email) AS email": [{"email": "avni@pursuit.org"}],
        EVENTS: [event_row(kind="call", ts=now, contact_id=1, activity_id="c1"),
                 event_row(kind="meeting", ts=now, contact_id=1, logged_as="c1"),
                 event_row(kind="call_booked", ts=now, contact_id=2)],
    })
    d = make_jobs_client(conn).get("/api/jobs/outreach/touch-depth?scope=team").json()["data"]
    assert d["total"] == 2                               # the unowned contact is in the queue
    by = {b["key"]: b["count"] for b in d["buckets"]}
    assert by["1"] == 1 and by["0"] == 1                 # call + its meeting = 1; a booking = 0
    q = next(c[1] for c in conn.calls if "WHERE m.stage = 'initial_outreach'" in c[1])
    assert "owner_email) IN" not in q and jm.internal_contact_sql("p") in q


def test_every_campaign_number_opens_the_records_it_counts():
    """PRO-105: Contacts is everyone tagged, so its records include the
    contacts outside the pipeline; the rest are narrowed to what they count."""
    c = make_jobs_client(_conn())
    d = c.get("/api/jobs/tag-campaigns/operation_35/stats").json()["data"]
    assert d["definitions"]["contacts"]["value"] > d["totals"]["in_pipeline"]
    assert_records_match(c, d["definitions"])
