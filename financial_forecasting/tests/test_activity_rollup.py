"""PRO-101 part 1: activity logged once counts everywhere.

No database. The jobs tag is evaluated in SQLite (the predicate is plain SQL);
the rollup's shape is asserted on the SQL, and the routes run through FakeConn.
The rollup itself ran read-only on production on 2026-10-13: 40 of 57 open
opportunities have activity under it (8 by what is logged on them alone), and
Queens Community House picks up its contact's 37 synced emails and meetings.
"""
import sqlite3
import uuid
from datetime import datetime, timezone

import pytest

from services import jobs_metrics as jm
from services.outreach_counting import jobs_relevant_sql
from tests.jobs_fakes import FakeConn, make_jobs_client


@pytest.fixture(autouse=True)
def _clear_overrides():
    """make_jobs_client stubs auth; later test files must get the real one."""
    from main import app
    yield
    app.dependency_overrides.clear()


# ── the jobs tag ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("type_,verdict,override,counts", [
    ("email", "jobs", None, True),
    ("email", "not_jobs", None, False),
    ("email", None, None, False),          # not classified yet
    ("email", "not_jobs", "jobs", True),   # a person's tag wins
    ("meeting", "jobs", "not_jobs", False),
    ("call", None, None, True),            # typed into the jobs tool
    ("call", None, "not_jobs", False),     # ...unless someone untags it
    ("text", None, "not_jobs", False),
    ("linkedin", None, "jobs", True),
])
def test_a_tag_wins_on_every_type(type_, verdict, override, counts):
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE a (type text, jobs_relevance text, jobs_relevance_override text)")
    db.execute("INSERT INTO a VALUES (?, ?, ?)", (type_, verdict, override))
    got = db.execute(f"SELECT count(*) FROM a WHERE {jobs_relevant_sql('a')}").fetchone()[0]
    assert bool(got) is counts


# ── whose activity it is ─────────────────────────────────────────────────────

def test_an_opportunity_reads_its_linked_contacts_from_both_sides():
    sql = jm.activity_scope_ctes()
    assert "jobs_contact_membership m JOIN opp_scope os ON os.id = m.opportunity_id" in sql
    for ref in ("'^pub:[0-9]{1,9}$'", "'airtable:%'", "sf_contact_link"):
        assert ref in sql


def test_only_an_opportunity_with_no_linked_contacts_borrows_its_account():
    sql = jm.activity_scope_ctes()
    fallback = sql[sql.index("opp_contacts AS ("):sql.index("scope_contacts AS (")]
    assert "NOT EXISTS (SELECT 1 FROM opp_links l WHERE l.opp_id = os.id)" in fallback
    assert "lower(btrim(c.current_company)) = os.k" in fallback


def test_notes_and_comments_never_count():
    sql = jm.activity_scope_ctes(accounts="TRUE")
    assert "'note'" not in sql
    assert "jobs_comment" not in sql and "jobs_account_comment" not in sql
    assert sql.count(jm.external_activity_sql("a")) == 4   # every arm that reads activity


def test_an_account_adds_its_opportunities_and_contacts():
    sql = jm.activity_scope_ctes(opps="FALSE", accounts="{k} = $1")
    assert "OR (lower(btrim(o.account_name)) = $1)" in sql
    assert "lower(btrim(c.current_company)) = $1" in sql
    touches = sql[sql.index("account_touches AS ("):]
    assert "JOIN contact_touches" in touches and "JOIN opp_touches" in touches
    assert "account_touches" not in jm.activity_scope_ctes()


def test_a_bound_on_activity_reaches_every_arm():
    bound = "a.activity_date < $3::timestamptz"
    sql = jm.activity_scope_ctes(activity=f"{jm.external_activity_sql('a')} AND {bound}")
    assert sql.count(bound) == 4


# ── the screens read it ──────────────────────────────────────────────────────

OPP_ID = uuid.UUID("2a1a1484-3f6b-4ff0-8744-119541c5c11a")
LAST = datetime(2026, 10, 10, 18, 7, tzinfo=timezone.utc)


def _opp_row():
    return {"id": OPP_ID, "account_name": "Queens Community House", "account_id": "UNKNOWN",
            "stage": "active_in_discussions", "sf_contact_ids": [], "builder_ids": [], "tags": [],
            "deal_type": "ft", "owner_email": "avni@pursuit.org"}


def test_the_opportunity_page_lists_its_contacts_activity():
    feed_row = {"id": "a1", "type": "email", "activity_date": LAST, "deleted_at": None,
                "total_rows": 1, "last_activity_at": LAST}
    conn = FakeConn(
        rows={"FROM bedrock.jobs_opportunity WHERE id": _opp_row()},
        lists={"jobs_contact_membership WHERE opportunity_id": [
            {"contact_id": 33140, "full_name": "QCH contact", "airtable_id": None}],
               "FROM opp_touches)": [feed_row]},
    )
    r = make_jobs_client(conn).get(f"/api/jobs/opportunities/{OPP_ID}")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["last_activity_at"].startswith("2026-10-10")
    # A contact converted onto it shows as linked even with an empty contact list.
    assert [c["contact_id"] for c in data["contacts"]] == [33140]
    assert "last_activity_at" not in data["activity"][0]
    feed = next(q for q in conn.queries("fetch") if "FROM opp_touches" in q and "LIMIT 250" in q)
    assert "o.id = $1" in feed and "jobs_relevance_override" in feed
    # "Last activity" is only what counts, over every row before the LIMIT.
    assert f"FILTER (WHERE {jm.external_activity_sql('a')}) OVER ()" in feed


def test_the_opportunities_list_counts_the_same_activity():
    conn = FakeConn()
    r = make_jobs_client(conn).get("/api/jobs/opportunities")
    assert r.status_code == 200, r.text
    q = next(q for q in conn.queries("fetch") if "FROM bedrock.jobs_opportunity o" in q and "LIMIT" in q)
    assert "FROM opp_touches GROUP BY opp_id" in q
    assert "coalesce(act.recent_activity_count, 0)" in q


def test_the_account_activity_tab_is_the_accounts_share():
    conn = FakeConn()
    r = make_jobs_client(conn).get("/api/jobs/account-activity", params={"key": " Queens Community House "})
    assert r.status_code == 200, r.text
    call = next(c for c in conn.calls if "account_touches" in c[1])
    assert call[2] == ("queens community house",)
    assert "WHERE a.id IN (SELECT activity_id FROM account_touches)" in call[1]
