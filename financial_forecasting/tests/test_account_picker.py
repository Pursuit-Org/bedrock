"""PRO-101 part 5 (D9): accounts are picked from a list; a second spelling of
an existing account is refused.

JPMorgan Chase had 10 spellings with its 7 opportunities split 4 ways. Account
creation now refuses a name that is the same account once case, punctuation and
legal suffixes are dropped, and returns the existing one. No database.
"""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

CANDIDATES = "FROM bedrock.jobs_account WHERE account_key LIKE"


@pytest.fixture(autouse=True)
def _clear_overrides():
    """make_jobs_client stubs auth; later test files must get the real one."""
    from main import app
    yield
    app.dependency_overrides.clear()


def _conn(*rows):
    return FakeConn(lists={CANDIDATES: [{"k": k, "display": d, "n": n} for k, d, n in rows]})


def test_another_spelling_of_an_account_is_refused_with_the_existing_one():
    conn = _conn(("jpmorgan chase", "JPMorgan Chase", 7), ("jp morgan", "JP Morgan", 1))
    r = make_jobs_client(conn).post("/api/jobs/accounts", json={"name": "JPMorgan Chase & Co."})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["existing"] == {"account_key": "jpmorgan chase", "account": "JPMorgan Chase"}
    assert not conn.executed("INSERT INTO bedrock.jobs_account")


def test_the_variant_with_the_most_records_is_the_one_returned():
    conn = _conn(("con ed", "Con Ed", 1), ("con ed inc", "Con Ed Inc", 4))
    r = make_jobs_client(conn).post("/api/jobs/accounts", json={"name": "Con Ed, LLC"})
    assert r.status_code == 409
    assert r.json()["detail"]["existing"]["account_key"] == "con ed inc"


def test_the_same_account_again_is_still_idempotent():
    """Picking an account we hold (e.g. to link its Salesforce id) isn't a duplicate."""
    conn = _conn(("blackstone", "Blackstone", 7))
    r = make_jobs_client(conn).post("/api/jobs/accounts", json={"name": "Blackstone", "sf_account_id": "001x"})
    assert r.status_code == 200, r.text
    assert conn.executed("INSERT INTO bedrock.jobs_account")


def test_a_genuinely_new_account_is_created():
    conn = _conn(("con edison", "Con Edison", 3))   # shares a word, not the name
    r = make_jobs_client(conn).post("/api/jobs/accounts", json={"name": "Con Ed"})
    assert r.status_code == 200, r.text
    assert conn.executed("INSERT INTO bedrock.jobs_account")


def test_pickers_list_accounts_created_before_anyone_is_at_them():
    conn = FakeConn()
    make_jobs_client(conn).get("/api/jobs/accounts/names")
    make_jobs_client(conn).get("/api/jobs/accounts/search", params={"q": "acme"})
    for q in conn.queries("fetch"):
        assert "FROM bedrock.jobs_account" in q
