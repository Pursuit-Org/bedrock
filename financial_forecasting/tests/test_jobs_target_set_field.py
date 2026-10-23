"""Evals for the per-contact Target set flag on GET /api/jobs/contacts."""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

TS_PROBE = "to_regclass('bedrock.jobs_target_set')"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    from routes import jobs
    jobs._TABLE_SEEN.discard("jobs_target_set")
    yield
    jobs._TABLE_SEEN.discard("jobs_target_set")
    app.dependency_overrides.clear()


def _list_sql(conn):
    return next(x[1] for x in conn.calls if "AS in_target_set" in x[1])


def test_contacts_carry_target_set_once_the_table_exists():
    conn = FakeConn(vals={TS_PROBE: True})
    make_jobs_client(conn).get("/api/jobs/contacts?limit=10")
    assert "EXISTS (SELECT 1 FROM bedrock.jobs_target_set ts WHERE ts.contact_id = c.contact_id) AS in_target_set" in _list_sql(conn)


def test_contacts_report_null_target_set_before_the_migration():
    conn = FakeConn(vals={TS_PROBE: False})
    make_jobs_client(conn).get("/api/jobs/contacts?limit=10")
    sql = _list_sql(conn)
    assert "NULL::boolean AS in_target_set" in sql and "jobs_target_set ts " not in sql


def test_target_set_filter_matches_the_table():
    conn = FakeConn(vals={TS_PROBE: True})
    rules = '[{"field":"target_set","op":"equals","values":["yes"]}]'
    make_jobs_client(conn).get(f"/api/jobs/contacts?limit=10&filters={rules}")
    assert any("jobs_target_set ts2" in x[1] for x in conn.calls)
