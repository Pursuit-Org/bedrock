"""Evals for the Placement > Roles board (GET /api/jobs/roles/board).

Seats of one req are separate jobs_role rows, so these cover the pooling rule
that makes them read as one opening: a filled seat leaves the board, and the
candidates who applied to it stay with the req's remaining openings.

Unlike the other jobs eval modules this one never reaches get_pool(), so it
runs in CI.
"""
from datetime import date

import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

OPP = "11111111-1111-1111-1111-111111111111"
ROLE1 = "aaaaaaaa-1111-1111-1111-111111111111"
ROLE2 = "bbbbbbbb-2222-2222-2222-222222222222"
ROLE3 = "cccccccc-3333-3333-3333-333333333333"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _role_row(rid, **ov):
    """A bedrock.jobs_role row as the board query returns it (role + opp columns)."""
    row = {"id": rid, "opportunity_id": OPP, "title": "Software Engineer",
           "approx_salary": 80000, "employment_type": "full_time", "start_date": None,
           "status": "open", "filled_by_user_id": None, "employment_record_id": None,
           "notes": None, "created_at": None, "updated_at": None,
           "commitment": "committed", "is_trial": False, "converts_to_role_id": None,
           "pay_rate": None, "rate_period": None, "end_date": None, "pay_cadence": None,
           "benefits": None, "payment_schedule": None, "negotiation_notes": None,
           "jd_url": None, "pathfinder_visible": False, "job_posting_id": None,
           "pathfinder_synced_at": None,
           "account_name": "Acme", "opp_stage": "closed_won", "sort_position": None}
    row.update(ov)
    return row


def _app_row(app_id, role_id, builder, day):
    return {"job_application_id": app_id, "jobs_role_id": role_id, "builder": builder,
            "stage": "interview", "date_applied": date(2026, 9, day),
            "updated_at": date(2026, 9, day)}


def _board(roles, apps):
    conn = FakeConn(lists={
        "LEFT JOIN jobs_analytics.role_sort_order": roles,
        "FROM public.job_applications ja": apps,
    })
    r = make_jobs_client(conn).get("/api/jobs/roles/board")
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_open_seats_keep_their_own_applications():
    data = _board(
        [_role_row(ROLE1), _role_row(ROLE2)],
        [_app_row(1, ROLE1, "Ann", 1), _app_row(2, ROLE2, "Bo", 2)],
    )
    assert [d["id"] for d in data] == [ROLE1, ROLE2]
    assert [a["job_application_id"] for a in data[0]["applications"]] == [1]
    assert [a["job_application_id"] for a in data[1]["applications"]] == [2]


def test_filled_seat_repools_its_applications_onto_a_remaining_seat():
    """Hiring one of three identical seats must not take its candidates off the
    board with it — they applied to the req, not to that one opening."""
    data = _board(
        [_role_row(ROLE1, status="filled", filled_by_user_id=7, employment_record_id=3),
         _role_row(ROLE2), _role_row(ROLE3)],
        [_app_row(1, ROLE1, "Hired Hannah", 1), _app_row(2, ROLE2, "Open Omar", 3)],
    )
    # the filled seat itself drops off the board
    assert [d["id"] for d in data] == [ROLE2, ROLE3]
    # its candidate re-pools onto the first remaining seat, newest first...
    assert [a["job_application_id"] for a in data[0]["applications"]] == [2, 1]
    # ...and onto only that one, so the UI's per-req pooling counts it once
    assert data[1]["applications"] == []


def test_repooling_stays_within_one_req():
    """A filled Data Engineer seat's candidates never land on Software Engineer."""
    data = _board(
        [_role_row(ROLE1, title="Data Engineer", status="filled", filled_by_user_id=7),
         _role_row(ROLE2), _role_row(ROLE3)],
        [_app_row(1, ROLE1, "Data Dana", 1), _app_row(2, ROLE2, "Open Omar", 3)],
    )
    assert [d["id"] for d in data] == [ROLE2, ROLE3]
    assert [a["job_application_id"] for a in data[0]["applications"]] == [2]
    assert data[1]["applications"] == []


def test_trial_seat_is_not_treated_as_filled():
    """An active trial still shows on the board, so its candidates stay put."""
    data = _board(
        [_role_row(ROLE1, status="filled", filled_by_user_id=7, is_trial=True), _role_row(ROLE2)],
        [_app_row(1, ROLE1, "Trial Tess", 1)],
    )
    assert [d["id"] for d in data] == [ROLE1, ROLE2]
    assert [a["job_application_id"] for a in data[0]["applications"]] == [1]


def test_repooling_survives_a_salary_edited_after_the_hire():
    """update_placement writes the agreed salary back onto the filled role, so
    the req match must not depend on salary staying equal across seats."""
    data = _board(
        [_role_row(ROLE1, status="filled", filled_by_user_id=7, approx_salary=92000),
         _role_row(ROLE2, approx_salary=80000)],
        [_app_row(1, ROLE1, "Hired Hannah", 1), _app_row(2, ROLE2, "Open Omar", 3)],
    )
    assert [d["id"] for d in data] == [ROLE2]
    assert [a["job_application_id"] for a in data[0]["applications"]] == [2, 1]
