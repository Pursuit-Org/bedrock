"""Evals for interview-round logging on the Roles board (public.interviews).

public.interviews is the platform's table — Pathfinder writes it too — so these
pin the write shape to the platform's (same columns, same type list, created_at
on insert, updated_at on edit), round numbering (staff-entered round_number, else
the date-order ordinal), the stage nudge into 'interview', the 503s while the
grants / round_number migration are pending, the date-order fallback for reads
before the migration, and the rollup fields the board's three application
payloads now carry.

FakeConn only (no get_pool()), so this module runs in CI.
"""
from datetime import date, datetime, timedelta

import asyncpg
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

PENDING = "Interview logging isn't enabled yet (database permission pending)"
APP_LOOKUP = "SELECT job_application_id, stage FROM public.job_applications"
LIST_SQL = "ORDER BY date ASC NULLS LAST, interview_id ASC"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _iv(iid, day, type_="Behavioral", app_id=42, round_number=None, **ov):
    row = {"interview_id": iid, "job_application_id": app_id, "date": date(2026, 10, day),
           "type": type_, "round_number": round_number, "title": None, "interviewer_name": None, "interviewer_email": None,
           "content_type": None, "feedback": None,
           "created_at": datetime(2026, 10, 1, 12), "updated_at": None}
    row.update(ov)
    return row


class DeniedConn(FakeConn):
    """Raises the error asyncpg gives when the role lacks a grant on the table."""
    def __init__(self, deny: str, **kw):
        super().__init__(**kw)
        self.deny = deny

    async def fetchrow(self, query, *args):
        if self.deny in query:
            self.calls.append(("fetchrow", query, args))
            raise asyncpg.exceptions.InsufficientPrivilegeError("permission denied for table interviews")
        return await super().fetchrow(query, *args)


class NoRoundColumnConn(FakeConn):
    """public.interviews before the round_number migration: any statement that
    names the column fails the way Postgres does."""
    def _check(self, kind, query, args):
        if "round_number" in query and "NULL::int AS round_number" not in query:
            self.calls.append((kind, query, args))
            raise asyncpg.exceptions.UndefinedColumnError('column "round_number" does not exist')

    async def fetch(self, query, *args):
        self._check("fetch", query, args)
        return await super().fetch(query, *args)

    async def fetchrow(self, query, *args):
        self._check("fetchrow", query, args)
        return await super().fetchrow(query, *args)


# ── list ─────────────────────────────────────────────────────────────────────

def test_list_numbers_rounds_by_date_order():
    conn = FakeConn(
        rows={APP_LOOKUP: {"job_application_id": 42, "stage": "interview"}},
        lists={LIST_SQL: [_iv(7, 2, "Phone Screen"), _iv(3, 9), _iv(9, 16, "Final Round")]},
    )
    r = make_jobs_client(conn).get("/api/jobs/job-applications/42/interviews")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert [(d["interview_id"], d["round"]) for d in data] == [(7, 1), (3, 2), (9, 3)]
    assert data[0]["date"] == "2026-10-02"
    assert data[0]["round_number"] is None


def test_list_mixes_entered_and_derived_rounds():
    """Entered numbers win; unnumbered rows keep their date-order ordinal
    (counted over every row), and the list comes back in round order."""
    conn = FakeConn(
        rows={APP_LOOKUP: {"job_application_id": 42, "stage": "interview"}},
        lists={LIST_SQL: [
            _iv(1, 2),                       # Pathfinder, unnumbered -> derived 1
            _iv(2, 9, round_number=3),       # staff skipped ahead: "round 3"
            _iv(3, 16),                      # later Pathfinder row -> derived 3
            _iv(4, 20, round_number=2),      # staff backfilled round 2 late
        ]},
    )
    data = make_jobs_client(conn).get("/api/jobs/job-applications/42/interviews").json()["data"]
    assert [(d["interview_id"], d["round"]) for d in data] == [(1, 1), (4, 2), (2, 3), (3, 3)]
    assert [d["round_number"] for d in data] == [None, 2, 3, None]


def test_list_before_migration_falls_back_to_date_order():
    conn = NoRoundColumnConn(
        rows={APP_LOOKUP: {"job_application_id": 42, "stage": "interview"}},
        lists={LIST_SQL: [_iv(7, 2), _iv(3, 9)]},
    )
    r = make_jobs_client(conn).get("/api/jobs/job-applications/42/interviews")
    assert r.status_code == 200, r.text
    assert [d["round"] for d in r.json()["data"]] == [1, 2]
    assert conn.ran("NULL::int AS round_number")


def test_list_404s_for_unknown_application():
    r = make_jobs_client(FakeConn()).get("/api/jobs/job-applications/999/interviews")
    assert r.status_code == 404


# ── create ───────────────────────────────────────────────────────────────────

def _create_conn(stage, existing=None, stage_result="UPDATE 1"):
    return FakeConn(
        rows={APP_LOOKUP: {"job_application_id": 42, "stage": stage},
              "INSERT INTO public.interviews": _iv(11, 20, "Technical", title="Round 2 w/ eng")},
        lists={LIST_SQL: (existing or []) + [_iv(11, 20, "Technical", title="Round 2 w/ eng")]},
        vals={"UPDATE public.job_applications": stage_result},
    )


def test_create_writes_the_platform_shape():
    conn = _create_conn("interview", existing=[_iv(5, 3)])
    r = make_jobs_client(conn).post("/api/jobs/job-applications/42/interviews", json={
        "date": "2026-10-20", "type": "Technical", "round_number": 2,
        "title": "  Round 2 w/ eng ", "interviewer_name": "",
    })
    assert r.status_code == 200, r.text
    insert = [c for c in conn.calls if "INSERT INTO public.interviews" in c[1]][0]
    # same column list and created_at = NOW() as pathfinderInterviews.createInterview
    assert "job_application_id, date, type, round_number, title,\n                    interviewer_name, interviewer_email, content_type, feedback, created_at" in insert[1]
    assert "NOW()" in insert[1]
    # blanks become NULL, text is trimmed
    assert insert[2] == (42, date(2026, 10, 20), "Technical", 2, "Round 2 w/ eng", None, None, None, None)
    data = r.json()["data"]
    assert data["interview"]["round"] == 2
    assert data["interview_count"] == 2
    # already interviewing — stage_history untouched
    assert data["stage_advanced"] is False
    assert not conn.executed("UPDATE public.job_applications")


@pytest.mark.parametrize("stage", [None, "applied", "prospect"])
def test_create_moves_pre_interview_application_to_interview(stage):
    conn = _create_conn(stage)
    r = make_jobs_client(conn).post("/api/jobs/job-applications/42/interviews",
                                    json={"date": "2026-10-20", "type": "Phone Screen"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["stage_advanced"] is True
    (call,) = conn.executed("UPDATE public.job_applications")
    # the same stage_history-appending write as the inline stage editor
    assert "stage_history = COALESCE(stage_history, '[]'::jsonb) || jsonb_build_object(" in call[1]
    assert "stage IS NULL OR stage IN ('prospect', 'applied')" in call[1]
    assert call[2] == ("interview", 42, "tester@pursuit.org")


@pytest.mark.parametrize("stage", ["screen", "oa", "offer", "rejected"])
def test_create_leaves_later_stages_alone(stage):
    conn = _create_conn(stage)
    r = make_jobs_client(conn).post("/api/jobs/job-applications/42/interviews",
                                    json={"date": "2026-10-20", "type": "Panel"})
    assert r.status_code == 200, r.text
    assert not conn.executed("UPDATE public.job_applications")


@pytest.mark.parametrize("type_", [None, "", "  "])
def test_create_without_a_type_stores_interview(type_):
    """interviews.type is NOT NULL, so "no type" is the plain default."""
    conn = _create_conn("interview")
    body = {"date": "2026-10-20"} if type_ is None else {"date": "2026-10-20", "type": type_}
    r = make_jobs_client(conn).post("/api/jobs/job-applications/42/interviews", json=body)
    assert r.status_code == 200, r.text
    insert = [c for c in conn.calls if "INSERT INTO public.interviews" in c[1]][0]
    assert insert[2][2] == "Interview"
    assert insert[2][3] is None  # no round entered -> numbered by date order


@pytest.mark.parametrize("type_", ["Super Day", "Work Trial", "Culture Fit"])
def test_create_accepts_added_types(type_):
    r = make_jobs_client(_create_conn("interview")).post(
        "/api/jobs/job-applications/42/interviews", json={"date": "2026-10-20", "type": type_})
    assert r.status_code == 200, r.text


def test_create_allows_future_dates():
    future = (date.today() + timedelta(days=30)).isoformat()
    r = make_jobs_client(_create_conn("interview")).post(
        "/api/jobs/job-applications/42/interviews", json={"date": future, "type": "Final Round"})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("body,status", [
    ({"type": "Behavioral"}, 422),                                     # no date
    ({"date": "2026-10-20", "round_number": 0}, 422),                  # rounds start at 1
    ({"date": "2026-10-20", "type": "Vibes check"}, 400),              # not an allowed type
    ({"date": "2026-10-20", "type": "Technical", "content_type": "x"}, 400),
    ({"date": "2026-10-20", "type": "Technical", "interviewer_email": "nope"}, 400),
])
def test_create_validates(body, status):
    conn = _create_conn("applied")
    r = make_jobs_client(conn).post("/api/jobs/job-applications/42/interviews", json=body)
    assert r.status_code == status
    assert not conn.ran("INSERT INTO public.interviews")


def test_create_404s_for_unknown_application():
    conn = FakeConn()
    r = make_jobs_client(conn).post("/api/jobs/job-applications/999/interviews",
                                    json={"date": "2026-10-20", "type": "Technical"})
    assert r.status_code == 404
    assert not conn.ran("INSERT INTO public.interviews")


def test_create_without_grant_is_a_clear_503_and_leaves_stage_alone():
    conn = DeniedConn("INSERT INTO public.interviews",
                      rows={APP_LOOKUP: {"job_application_id": 42, "stage": "applied"}})
    r = make_jobs_client(conn).post("/api/jobs/job-applications/42/interviews",
                                    json={"date": "2026-10-20", "type": "Technical"})
    assert r.status_code == 503
    assert r.json()["detail"] == PENDING
    assert not conn.executed("UPDATE public.job_applications")


def test_create_before_migration_is_a_clear_503():
    conn = NoRoundColumnConn(rows={APP_LOOKUP: {"job_application_id": 42, "stage": "applied"}})
    r = make_jobs_client(conn).post("/api/jobs/job-applications/42/interviews",
                                    json={"date": "2026-10-20", "round_number": 1})
    assert r.status_code == 503
    assert r.json()["detail"] == "Round numbers aren't enabled yet (database change pending)"
    assert not conn.executed("UPDATE public.job_applications")


# ── update ───────────────────────────────────────────────────────────────────

def test_update_writes_only_sent_fields_and_can_clear_them():
    conn = FakeConn(
        rows={"UPDATE public.interviews": _iv(3, 12)},
        lists={LIST_SQL: [_iv(7, 2), _iv(3, 12)]},
    )
    r = make_jobs_client(conn).patch("/api/jobs/interviews/3", json={"date": "2026-10-12", "title": None})
    assert r.status_code == 200, r.text
    call = [c for c in conn.calls if "UPDATE public.interviews" in c[1]][0]
    assert "SET date = $2, title = $3, updated_at = NOW()" in call[1]
    assert call[2] == (3, date(2026, 10, 12), None)
    assert r.json()["data"]["round"] == 2


@pytest.mark.parametrize("body", [{}, {"date": None}, {"type": "Lunch"}])
def test_update_rejects_bad_bodies(body):
    conn = FakeConn()
    r = make_jobs_client(conn).patch("/api/jobs/interviews/3", json=body)
    assert r.status_code == 400
    assert not conn.ran("UPDATE public.interviews")


def test_update_round_number_and_clearing_type():
    conn = FakeConn(
        rows={"UPDATE public.interviews": _iv(3, 12, "Interview", round_number=4)},
        lists={LIST_SQL: [_iv(3, 12, "Interview", round_number=4)]},
    )
    r = make_jobs_client(conn).patch("/api/jobs/interviews/3", json={"type": None, "round_number": 4})
    assert r.status_code == 200, r.text
    call = [c for c in conn.calls if "UPDATE public.interviews" in c[1]][0]
    assert "SET type = $2, round_number = $3, updated_at = NOW()" in call[1]
    assert call[2] == (3, "Interview", 4)
    assert r.json()["data"]["round"] == 4


def test_update_round_before_migration_is_a_clear_503():
    r = make_jobs_client(NoRoundColumnConn()).patch("/api/jobs/interviews/3", json={"round_number": 2})
    assert r.status_code == 503
    assert r.json()["detail"] == "Round numbers aren't enabled yet (database change pending)"


def test_update_404s_for_unknown_interview():
    r = make_jobs_client(FakeConn()).patch("/api/jobs/interviews/3", json={"type": "Panel"})
    assert r.status_code == 404


def test_update_without_grant_is_a_clear_503():
    r = make_jobs_client(DeniedConn("UPDATE public.interviews")).patch(
        "/api/jobs/interviews/3", json={"type": "Panel"})
    assert r.status_code == 503
    assert r.json()["detail"] == PENDING


# ── delete ───────────────────────────────────────────────────────────────────

def test_delete_removes_the_round_and_leaves_stage_alone():
    conn = FakeConn(rows={"DELETE FROM public.interviews": {"interview_id": 3, "job_application_id": 42}})
    r = make_jobs_client(conn).delete("/api/jobs/interviews/3")
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"interview_id": 3, "job_application_id": 42, "deleted": True}
    assert not conn.ran("UPDATE public.job_applications")


def test_delete_404s_for_unknown_interview():
    r = make_jobs_client(FakeConn()).delete("/api/jobs/interviews/3")
    assert r.status_code == 404


def test_delete_without_grant_is_a_clear_503():
    r = make_jobs_client(DeniedConn("DELETE FROM public.interviews")).delete("/api/jobs/interviews/3")
    assert r.status_code == 503
    assert r.json()["detail"] == PENDING


# ── board payloads carry the rollup ──────────────────────────────────────────

ROLLUP = {"interview_count": 3, "latest_round": 4, "latest_interview_date": date(2026, 10, 16),
          "latest_interview_type": "Final Round"}


def _assert_rollup(app):
    assert app["interview_count"] == 3
    assert app["latest_round"] == 4
    assert app["latest_interview_date"] == "2026-10-16"
    assert app["latest_interview_type"] == "Final Round"


def test_builder_sourced_rows_carry_interview_rollup():
    row = {"job_application_id": 5, "builder_id": 9, "company_name": "Acme", "role_title": "SWE",
           "date_applied": date(2026, 10, 1), "updated_at": None, "stage": "interview",
           "builder": "Ann", "jobs_role_id": "aaaaaaaa-1111-1111-1111-111111111111", **ROLLUP}
    conn = FakeConn(lists={"FROM combined ja": [row]})
    r = make_jobs_client(conn).get("/api/jobs/job-applications/builder-sourced")
    assert r.status_code == 200, r.text
    _assert_rollup(r.json()["data"][0])
    # highest effective round: entered number, else the date-order ordinal
    assert conn.ran("COALESCE(i.round_number, row_number() OVER (ORDER BY i.date ASC NULLS LAST, i.interview_id ASC))")
    assert conn.ran("max(r.eff)::int AS latest_round")


def test_staff_sourced_rows_carry_interview_rollup():
    row = {"job_application_id": 5, "builder_id": 9, "company_name": "Acme", "role_title": "SWE",
           "date_applied": date(2026, 10, 1), "updated_at": None, "stage": "interview",
           "builder": "Ann", **ROLLUP}
    conn = FakeConn(lists={"ja.source_type IN ('Pursuit_referred', 'staff_sourced')": [row]})
    r = make_jobs_client(conn).get("/api/jobs/job-applications/staff-sourced")
    assert r.status_code == 200, r.text
    _assert_rollup(r.json()["data"][0]["applications"][0])


def test_roles_board_applications_carry_interview_rollup():
    from tests.test_jobs_roles_board import ROLE1, _role_row
    app_row = {"job_application_id": 1, "jobs_role_id": ROLE1, "builder": "Ann", "stage": "interview",
               "date_applied": date(2026, 9, 1), "updated_at": None, **ROLLUP}
    conn = FakeConn(lists={
        "LEFT JOIN jobs_analytics.role_sort_order": [_role_row(ROLE1)],
        "FROM public.job_applications ja": [app_row],
    })
    r = make_jobs_client(conn).get("/api/jobs/roles/board")
    assert r.status_code == 200, r.text
    _assert_rollup(r.json()["data"][0]["applications"][0])


def test_board_before_migration_falls_back_to_date_order_rounds():
    from tests.test_jobs_roles_board import ROLE1, _role_row
    app_row = {"job_application_id": 1, "jobs_role_id": ROLE1, "builder": "Ann", "stage": "interview",
               "date_applied": date(2026, 9, 1), "updated_at": None, **ROLLUP}
    conn = NoRoundColumnConn(lists={
        "LEFT JOIN jobs_analytics.role_sort_order": [_role_row(ROLE1)],
        "FROM public.job_applications ja": [app_row],
    })
    r = make_jobs_client(conn).get("/api/jobs/roles/board")
    assert r.status_code == 200, r.text
    _assert_rollup(r.json()["data"][0]["applications"][0])
    retry = [q for q in conn.queries("fetch") if "FROM public.job_applications ja" in q][-1]
    assert "round_number" not in retry
    assert "row_number() OVER" in retry


def test_inline_stage_editor_saves_any_application():
    """Refactored onto _set_application_stage, without the old
    jobs_opportunity_id guard (unlinked Builder-/Staff-Sourced rows 404'd)."""
    conn = FakeConn(vals={"UPDATE public.job_applications": "UPDATE 1"})
    r = make_jobs_client(conn).patch("/api/jobs/builder-activity/42", json={"stage": "offer"})
    assert r.status_code == 200, r.text
    (call,) = conn.executed("UPDATE public.job_applications")
    assert "jobs_opportunity_id" not in call[1]
    assert "WHERE job_application_id=$2 AND (true)" in call[1]
    assert call[2] == ("offer", 42, "tester@pursuit.org")
