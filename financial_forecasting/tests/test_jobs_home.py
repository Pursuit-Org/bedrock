"""Evals for the command-center aggregate endpoints:
  GET /api/jobs/tasks/all          — all open tasks, enriched with parent + assignee
  GET /api/jobs/interview-pipeline  — confirmed roles + builders by interview stage
"""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

UUID1 = "11111111-1111-1111-1111-111111111111"
OWNER = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _task(**ov):
    row = {"id": UUID1, "parent_type": "opportunity", "parent_id": UUID1, "title": "Sign contract",
           "status": "Not Started", "owner": None, "owner_ids": [OWNER], "deadline": None,
           "start_date": None, "description": "", "links": [], "sort_order": 0,
           "created_at": None, "updated_at": None}
    row.update(ov)
    return row


# ── /tasks/all ───────────────────────────────────────────────────────────────

def test_tasks_all_enriches_parent_and_owner():
    conn = FakeConn(lists={
        "FROM bedrock.jobs_task WHERE": [_task()],
        "FROM bedrock.jobs_account_task WHERE": [],
        "FROM bedrock.jobs_opportunity WHERE id = ANY": [
            {"id": UUID1, "account_name": "Acme", "title": "AI Eng", "stage": "active_in_discussions"}],
        "FROM public.org_users WHERE id = ANY": [
            {"id": OWNER, "display_name": "Avni Nahar", "email": "avni@p.org"}],
    })
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/tasks/all")
    assert r.status_code == 200, r.text
    t = r.json()["data"][0]
    assert t["parent_label"] == "Acme"            # opp account name
    assert t["parent_sublabel"] == "AI Eng"
    assert t["owner_names"] == ["Avni Nahar"]     # owner_ids resolved


def test_tasks_all_excludes_completed_by_default():
    conn = FakeConn(lists={"FROM bedrock.jobs_task WHERE": [_task()], "FROM bedrock.jobs_account_task WHERE": []})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/tasks/all")
    assert r.status_code == 200
    q = next(x for x in conn.queries("fetch") if "FROM bedrock.jobs_task WHERE" in x)
    assert "status <> 'Completed'" in q           # open-only default


def test_tasks_all_invalid_status_400():
    c = make_jobs_client(FakeConn())
    r = c.get("/api/jobs/tasks/all?status=Bogus")
    assert r.status_code == 400


# ── /interview-pipeline ────────────────────────────────────────────────────────

def test_interview_pipeline_groups_roles_and_builders():
    conn = FakeConn(lists={
        "FROM bedrock.jobs_role r": [
            {"id": "r1", "opportunity_id": UUID1, "title": "FT Eng", "status": "open",
             "employment_type": "full_time", "approx_salary": 90000, "filled_by_user_id": None,
             "commitment": None, "is_trial": False,
             "account_name": "Acme", "opp_stage": "active_builder_interview", "owner_email": "a@p.org"}],
        "FROM public.job_applications ja": [
            {"job_application_id": 1, "jobs_opportunity_id": UUID1, "jobs_role_id": "r1",
             "builder": "Ana", "role_title": "FT Eng", "stage": "interview", "date_applied": None,
             "account_name": "Acme", "opp_stage": "active_builder_interview", "owner_email": "a@p.org"},
            {"job_application_id": 2, "jobs_opportunity_id": UUID1, "jobs_role_id": "r1",
             "builder": "Ben", "role_title": "FT Eng", "stage": "applied", "date_applied": None,
             "account_name": "Acme", "opp_stage": "active_builder_interview", "owner_email": "a@p.org"}],
    })
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/interview-pipeline")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert len(data) == 1
    g = data[0]
    assert g["account_name"] == "Acme"
    assert len(g["roles"]) == 1 and len(g["builders"]) == 2
    assert g["summary"] == {"applied": 1, "interview": 1, "accepted": 0, "open_roles": 1}


def test_interview_pipeline_empty():
    conn = FakeConn(lists={"FROM bedrock.jobs_role r": [], "FROM public.job_applications ja": []})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/interview-pipeline")
    assert r.status_code == 200
    assert r.json()["data"] == []
