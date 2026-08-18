"""Evals for opportunity + role + hire endpoints in routes/jobs.py.

Covers create (relationship_owner persisted, linked contacts flagged),
update validation, delete, the _resolve_contacts crash-guard, role create
validation, and the hire → employment_record flow.
"""
import asyncio
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

UUID1 = "11111111-1111-1111-1111-111111111111"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _opp_row(**ov):
    row = {"id": UUID1, "account_id": None, "account_name": "Acme", "stage": "initial_outreach",
           "deal_type": "ft", "title": "Eng", "owner_email": "a@p.org", "relationship_owner": None,
           "closed_at": None}
    row.update(ov)
    return row


# ── create ──────────────────────────────────────────────────────────────────────

def test_create_opportunity_persists_relationship_owner_and_flags_contacts():
    conn = FakeConn(
        rows={"SELECT * FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()},
        vals={"INSERT INTO bedrock.jobs_opportunity (": UUID1},
    )
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/opportunities", json={
        "account_id": "UNKNOWN", "account_name": "Acme", "stage": "initial_outreach",
        "owner_email": "lead@p.org", "relationship_owner": "rel@p.org",
        "sf_contact_ids": ["pub:5"],
    })
    assert r.status_code == 200, r.text
    # relationship_owner is the 12th INSERT arg (0-based index 11)
    insert = next(c2 for c2 in conn.calls if c2[0] == "fetchval" and "INSERT INTO bedrock.jobs_opportunity (" in c2[1])
    assert insert[2][11] == "rel@p.org"
    # linked contact flagged is_jobs_contact
    flag = conn.executed("WHERE contact_id = ANY")
    assert flag and flag[0][2][0] == [5]


def test_create_opportunity_invalid_stage_400():
    c = make_jobs_client(FakeConn())
    r = c.post("/api/jobs/opportunities", json={"account_id": "x", "stage": "bogus"})
    assert r.status_code == 400


def test_create_opportunity_invalid_likelihood_400():
    c = make_jobs_client(FakeConn())
    r = c.post("/api/jobs/opportunities", json={
        "account_id": "x", "stage": "initial_outreach", "likelihood": "huge"})
    assert r.status_code == 400


# ── update ──────────────────────────────────────────────────────────────────────

def test_update_opportunity_not_found_404():
    c = make_jobs_client(FakeConn())   # existing fetch returns None
    r = c.patch(f"/api/jobs/opportunities/{UUID1}", json={"title": "x"})
    assert r.status_code == 404


def test_update_opportunity_invalid_likelihood_400():
    conn = FakeConn(rows={"WHERE id=$1 AND deleted_at IS NULL": _opp_row()})
    c = make_jobs_client(conn)
    r = c.patch(f"/api/jobs/opportunities/{UUID1}", json={"likelihood": "enormous"})
    assert r.status_code == 400


def test_update_opportunity_priority_out_of_range_400():
    conn = FakeConn(rows={"WHERE id=$1 AND deleted_at IS NULL": _opp_row()})
    c = make_jobs_client(conn)
    r = c.patch(f"/api/jobs/opportunities/{UUID1}", json={"priority": 9})
    assert r.status_code == 400


def test_update_opportunity_clears_owner_when_explicit_null():
    # Unassigning an owner: an explicit null must write owner_email = NULL,
    # not be silently dropped (the "owner won't save on unassigned opps" bug).
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row(owner_email="a@p.org")})
    c = make_jobs_client(conn)
    r = c.patch(f"/api/jobs/opportunities/{UUID1}", json={"owner_email": None})
    assert r.status_code == 200, r.text
    upd = next(c2 for c2 in conn.calls if c2[0] == "execute"
               and "UPDATE bedrock.jobs_opportunity SET" in c2[1])
    assert "owner_email = $1" in upd[1]
    assert upd[2][0] is None          # null is written through, clearing the owner


def test_update_opportunity_ignores_omitted_owner():
    # Omitting owner_email entirely must NOT touch it (only the sent field changes).
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row(owner_email="a@p.org")})
    c = make_jobs_client(conn)
    r = c.patch(f"/api/jobs/opportunities/{UUID1}", json={"title": "New"})
    assert r.status_code == 200, r.text
    upd = next(c2 for c2 in conn.calls if c2[0] == "execute"
               and "UPDATE bedrock.jobs_opportunity SET" in c2[1])
    assert "owner_email" not in upd[1] and "title = $1" in upd[1]


# ── delete ──────────────────────────────────────────────────────────────────────

def test_delete_opportunity_not_found_404():
    conn = FakeConn(vals={"SET deleted_at=now()": "UPDATE 0"})
    c = make_jobs_client(conn)
    r = c.delete(f"/api/jobs/opportunities/{UUID1}")
    assert r.status_code == 404


def test_get_opportunity_not_found_404():
    c = make_jobs_client(FakeConn())
    r = c.get(f"/api/jobs/opportunities/{UUID1}")
    assert r.status_code == 404


# ── _resolve_contacts crash-guard ────────────────────────────────────────────────

def test_resolve_contacts_skips_malformed_pub_ref():
    from routes.jobs import _resolve_contacts
    conn = FakeConn(lists={"WHERE contact_id = ANY": [
        {"contact_id": 5, "first_name": "A", "last_name": "B", "full_name": "A B", "email": None,
         "current_title": None, "current_company": None, "contact_stage": "lead",
         "linkedin_url": None, "source": None, "airtable_id": None}]})
    # 'pub:abc' is malformed and must be skipped (not crash int())
    res = asyncio.run(_resolve_contacts(conn, ["pub:abc", "pub:5"]))
    assert len(res) == 1
    pub_fetch = next(c for c in conn.calls if c[0] == "fetch" and "WHERE contact_id = ANY" in c[1])
    assert pub_fetch[2][0] == [5]   # only the valid pub ref


# ── roles ─────────────────────────────────────────────────────────────────────

def test_create_role_invalid_commitment_400():
    c = make_jobs_client(FakeConn())
    r = c.post(f"/api/jobs/opportunities/{UUID1}/roles", json={"title": "Eng", "commitment": "maybe"})
    assert r.status_code == 400


def test_create_role_opp_not_found_404():
    c = make_jobs_client(FakeConn())   # opp lookup returns None
    r = c.post(f"/api/jobs/opportunities/{UUID1}/roles", json={"title": "Eng"})
    assert r.status_code == 404


def test_update_placement_salary_syncs_role():
    conn = FakeConn()  # execute default "OK" (not "UPDATE 0")
    c = make_jobs_client(conn)
    r = c.patch("/api/jobs/placements/75", json={"salary": 87500})
    assert r.status_code == 200, r.text
    erc = conn.executed("UPDATE public.employment_records SET")
    assert erc and 87500 in erc[0][2]
    role = conn.executed("UPDATE bedrock.jobs_role SET approx_salary")
    assert role and role[0][2] == (87500, 75)   # sync linked role


def test_update_role_salary_syncs_filled_placement():
    # editing a FILLED role's salary writes through to its employment_record
    conn = FakeConn(rows={
        "SELECT * FROM bedrock.jobs_role WHERE id": {"id": UUID1, "employment_record_id": 75, "status": "filled", "job_posting_id": None},
        "UPDATE bedrock.jobs_role SET": {"id": UUID1, "employment_record_id": 75, "approx_salary": 87500, "job_posting_id": None},
    })
    c = make_jobs_client(conn)
    r = c.patch(f"/api/jobs/roles/{UUID1}", json={"approx_salary": 87500})
    assert r.status_code == 200, r.text
    sync = conn.executed("UPDATE public.employment_records SET payment_amount")
    assert sync and sync[0][2] == (87500, 75)


def test_update_role_salary_no_sync_when_unfilled():
    conn = FakeConn(rows={
        "SELECT * FROM bedrock.jobs_role WHERE id": {"id": UUID1, "employment_record_id": None, "status": "open", "job_posting_id": None},
        "UPDATE bedrock.jobs_role SET": {"id": UUID1, "employment_record_id": None, "approx_salary": 90000, "job_posting_id": None},
    })
    c = make_jobs_client(conn)
    r = c.patch(f"/api/jobs/roles/{UUID1}", json={"approx_salary": 90000})
    assert r.status_code == 200, r.text
    assert not conn.executed("UPDATE public.employment_records SET payment_amount")  # no placement to sync


def test_create_role_happy():
    conn = FakeConn(rows={
        "SELECT id FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL": {"id": UUID1},
        "INSERT INTO bedrock.jobs_role": {"id": UUID1, "opportunity_id": UUID1, "title": "Eng", "status": "open"},
    })
    c = make_jobs_client(conn)
    r = c.post(f"/api/jobs/opportunities/{UUID1}/roles", json={"title": "Eng"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["title"] == "Eng"


# ── hire ──────────────────────────────────────────────────────────────────────

def test_hire_creates_employment_record_and_fills_role():
    conn = FakeConn(
        rows={
            "SELECT * FROM bedrock.jobs_role WHERE id=$1": {
                "id": UUID1, "opportunity_id": UUID1, "title": "Eng",
                "employment_type": "full_time", "approx_salary": 90000, "start_date": None},
            "SELECT id, account_name, deal_type FROM bedrock.jobs_opportunity": {"id": UUID1, "account_name": "Acme", "deal_type": None},
            "UPDATE bedrock.jobs_role": {"id": UUID1, "status": "filled", "filled_by_user_id": 42, "job_posting_id": None},
        },
        vals={"INSERT INTO public.employment_records": 777},
    )
    c = make_jobs_client(conn)
    r = c.post(f"/api/jobs/roles/{UUID1}/hire", json={"user_id": 42})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["employment_record_id"] == 777
    assert d["role"]["status"] == "filled"
    # employment_record created with the role/opp context
    er = next(c2 for c2 in conn.calls if c2[0] == "fetchval" and "INSERT INTO public.employment_records" in c2[1])
    assert er[2][0] == 42                 # user_id
    assert er[2][2] == "Acme"             # company_name from opp


def test_hire_role_not_found_404():
    c = make_jobs_client(FakeConn())
    r = c.post(f"/api/jobs/roles/{UUID1}/hire", json={"user_id": 42})
    assert r.status_code == 404
