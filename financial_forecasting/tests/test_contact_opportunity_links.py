"""PRO-101 part 2 (D15): contacts are linked to opportunities.

Converting a contact is gated on picking (or creating) its opportunity, and
creating an opportunity means picking its contacts. The link is written from
both sides: the contact's opportunity_id and the opportunity's contact list.
No database; the routes run through FakeConn.
"""
import uuid
from datetime import datetime, timezone

import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

OPP = uuid.UUID("2a1a1484-3f6b-4ff0-8744-119541c5c11a")
OPP2 = uuid.UUID("33333333-3333-3333-3333-333333333333")
MEMBERSHIP = "/api/jobs/contacts/33140/jobs-membership"


@pytest.fixture(autouse=True)
def _clear_overrides():
    """make_jobs_client stubs auth; later test files must get the real one."""
    from main import app
    yield
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _history_table():
    from services import jobs_activity_link
    jobs_activity_link._HAS_MEMBERSHIP_HISTORY = True
    yield
    jobs_activity_link._HAS_MEMBERSHIP_HISTORY = None


def _conn(old_stage="call_booked", opps=(OPP,), refs=None):
    return FakeConn(
        lists={"SELECT id FROM bedrock.jobs_opportunity WHERE id = ANY": [{"id": o} for o in opps]},
        vals={"SELECT stage FROM bedrock.jobs_contact_membership": old_stage,
              "SELECT sf_contact_ids FROM bedrock.jobs_opportunity": refs},
    )


# ── converting needs an opportunity ──────────────────────────────────────────

def test_converting_without_an_opportunity_is_refused():
    conn = _conn()
    r = make_jobs_client(conn).patch(MEMBERSHIP, json={"stage": "converted_to_opportunity"})
    assert r.status_code == 400
    assert "opportunity" in r.json()["detail"]
    assert not conn.executed("UPDATE bedrock.jobs_contact_membership SET")


def test_converting_links_the_contact_from_both_sides():
    conn = _conn()
    r = make_jobs_client(conn).patch(MEMBERSHIP, json={
        "stage": "converted_to_opportunity", "opportunity_ids": [str(OPP)]})
    assert r.status_code == 200, r.text
    upd = conn.executed("UPDATE bedrock.jobs_contact_membership SET stage")[0]
    assert "opportunity_id = $" in upd[1] and OPP in upd[2]
    listed = conn.executed("sf_contact_ids = coalesce(sf_contact_ids, '{}') ||")[0]
    assert listed[2] == (OPP, ["pub:33140"])
    hist = conn.executed("INSERT INTO bedrock.jobs_membership_stage_history")[0]
    assert hist[2][1:3] == ("call_booked", "converted_to_opportunity")


def test_a_contact_can_convert_to_more_than_one_opportunity():
    conn = _conn(opps=(OPP, OPP2))
    r = make_jobs_client(conn).patch(MEMBERSHIP, json={
        "stage": "converted_to_opportunity", "opportunity_ids": [str(OPP), str(OPP2)]})
    assert r.status_code == 200, r.text
    # The first is the contact's own; it is on both contact lists.
    upd = conn.executed("UPDATE bedrock.jobs_contact_membership SET stage")[0]
    assert OPP in upd[2] and OPP2 not in upd[2]
    listed = [c[2][0] for c in conn.executed("sf_contact_ids = coalesce(sf_contact_ids, '{}') ||")]
    assert listed == [OPP, OPP2]


def test_a_contact_already_on_the_list_is_not_added_twice():
    conn = FakeConn(
        lists={"SELECT id FROM bedrock.jobs_opportunity WHERE id = ANY": [{"id": OPP}],
               "FROM public.contacts WHERE contact_id = ANY": [{"contact_id": 33140}]},
        vals={"SELECT stage FROM bedrock.jobs_contact_membership": "call_booked",
              "SELECT sf_contact_ids FROM bedrock.jobs_opportunity": ["pub:33140"]},
    )
    r = make_jobs_client(conn).patch(MEMBERSHIP, json={
        "stage": "converted_to_opportunity", "opportunity_ids": [str(OPP)]})
    assert r.status_code == 200, r.text
    assert not conn.executed("sf_contact_ids = coalesce(sf_contact_ids, '{}') ||")


def test_an_unknown_opportunity_is_refused():
    conn = _conn(opps=())
    r = make_jobs_client(conn).patch(MEMBERSHIP, json={
        "stage": "converted_to_opportunity", "opportunity_ids": [str(OPP)]})
    assert r.status_code == 404
    assert not conn.executed("UPDATE bedrock.jobs_contact_membership SET")


def test_other_edits_to_a_converted_contact_need_no_opportunity():
    conn = _conn(old_stage="converted_to_opportunity")
    r = make_jobs_client(conn).patch(MEMBERSHIP, json={
        "stage": "converted_to_opportunity", "owner_email": "avni@pursuit.org"})
    assert r.status_code == 200, r.text


def test_bulk_convert_is_refused():
    conn = FakeConn()
    r = make_jobs_client(conn).post("/api/jobs/contacts/flag-jobs", json={
        "contact_ids": [1, 2], "stage": "converted_to_opportunity"})
    assert r.status_code == 400
    assert not conn.executed("INSERT INTO bedrock.jobs_contact_membership")


# ── creating an opportunity needs contacts ───────────────────────────────────

def _create_conn():
    return FakeConn(
        rows={"SELECT * FROM bedrock.jobs_opportunity WHERE id=$1": {"id": OPP}},
        vals={"INSERT INTO bedrock.jobs_opportunity (": OPP},
        lists={"FROM public.contacts WHERE contact_id = ANY": [{"contact_id": 5}]},
    )


def test_creating_an_opportunity_without_contacts_is_refused():
    conn = _create_conn()
    r = make_jobs_client(conn).post("/api/jobs/opportunities", json={
        "account_id": "UNKNOWN", "account_name": "Acme", "target_close_date": "2026-12-15",
        "sf_contact_ids": []})
    assert r.status_code == 400
    assert "contacts" in r.json()["detail"]
    assert not conn.ran("INSERT INTO bedrock.jobs_opportunity (")


def test_a_converted_contact_picked_on_a_new_opportunity_points_back_at_it():
    conn = _create_conn()
    r = make_jobs_client(conn).post("/api/jobs/opportunities", json={
        "account_id": "UNKNOWN", "account_name": "Acme", "target_close_date": "2026-12-15",
        "sf_contact_ids": ["pub:5"]})
    assert r.status_code == 200, r.text
    back = conn.executed("UPDATE bedrock.jobs_contact_membership SET opportunity_id")[0]
    assert back[2] == (OPP, [5])
    assert "stage = 'converted_to_opportunity' AND opportunity_id IS NULL" in back[1]


# ── close dates (part 4) ─────────────────────────────────────────────────────

def test_an_opportunity_created_closed_is_dated_today():
    conn = _create_conn()
    make_jobs_client(conn).post("/api/jobs/opportunities", json={
        "account_id": "UNKNOWN", "account_name": "Acme", "target_close_date": "2026-12-15",
        "stage": "closed_won", "sf_contact_ids": ["pub:5"]})
    insert = next(c for c in conn.calls if "INSERT INTO bedrock.jobs_opportunity (" in c[1])
    assert "CASE WHEN $3 IN ('closed_won', 'closed_lost') THEN now() END" in insert[1]


@pytest.mark.parametrize("before,after,restamped", [
    ("closed_lost", "closed_won", True),    # won on a new day
    ("closed_won", "closed_won", False),    # no move
    ("offer_contracting", "closed_won", False),  # already dated: kept
])
def test_moving_between_closed_stages_restamps_the_close_date(before, after, restamped):
    old = datetime(2026, 8, 1, tzinfo=timezone.utc)
    conn = FakeConn(rows={"SELECT * FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL": {
        "id": OPP, "stage": before, "closed_at": old, "account_name": "Acme", "owner_email": None,
        "target_close_date": None}})
    make_jobs_client(conn).patch(f"/api/jobs/opportunities/{OPP}", json={"stage": after})
    upd = next((c for c in conn.executed("UPDATE bedrock.jobs_opportunity SET")), None)
    assert upd is not None
    assert ("closed_at = $" in upd[1]) is restamped


# ── history on every move (part 4) ───────────────────────────────────────────

def test_a_logged_touch_records_the_move_into_initial_outreach():
    """The Log activity form moves an Assigned contact to Initial Outreach.
    That move now writes its history row, dated by the touch."""
    conn = FakeConn(vals={"INSERT INTO bedrock.activity": "new-id"},
                    rows={"SELECT * FROM bedrock.activity WHERE id": {"id": "new-id"}})
    r = make_jobs_client(conn).post("/api/jobs/activity", json={
        "contact_id": 7, "type": "text", "activity_date": "2026-10-12"})
    assert r.status_code == 200, r.text
    move = next(c for c in conn.executed("SET stage = 'initial_outreach'"))
    assert "INSERT INTO bedrock.jobs_membership_stage_history" in move[1]
    assert "'assigned', 'initial_outreach', $3, 'logged activity', $2" in move[1]
    assert move[2][0] == 7
