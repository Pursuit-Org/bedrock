"""Evals for contact endpoints in routes/jobs.py.

Locks the /contacts perf fix (filter on is_jobs_contact, no sf_contact_ids
EXISTS), the notes-field removal, and the add/remove-to-jobs flag toggles.
"""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

CONTACTS_FETCH = "is_jobs_contact = true"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _list_row(**ov):
    row = {"contact_id": 1, "full_name": "Jo", "email": "j@x.com", "current_title": "PM",
           "current_company": "X", "contact_stage": "lead", "linkedin_url": None, "airtable_id": "a",
           "deal_id": None, "deal_account": None, "deal_stage": None,
           "deal_id_by_company": None, "deal_account_by_company": None, "deal_stage_by_company": None}
    row.update(ov)
    return row


def test_list_contacts_filters_on_flag_not_sf_ids():
    conn = FakeConn(lists={CONTACTS_FETCH: [_list_row()]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/contacts?limit=50")
    assert r.status_code == 200, r.text
    assert r.json()["data"][0]["full_name"] == "Jo"
    main_q = next(q for q in conn.queries("fetch") if CONTACTS_FETCH in q)
    # the perf fix: the WHERE filter is the indexed flag alone — NOT the old
    # `is_jobs_contact = true OR EXISTS(... sf_contact_ids ...)` that scanned ~33k rows.
    assert "OR EXISTS" not in main_q


def test_list_contacts_stage_filter_param():
    conn = FakeConn(lists={CONTACTS_FETCH: []})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/contacts?stage=lead")
    assert r.status_code == 200, r.text
    main = next(call for call in conn.calls if call[0] == "fetch" and CONTACTS_FETCH in call[1])
    assert "lead" in main[2]   # stage bound as a param


def test_create_contact_no_notes_column():
    conn = FakeConn(rows={"SELECT * FROM public.contacts WHERE contact_id=$1": _list_row()},
                    vals={"INSERT INTO public.contacts": 99})
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/contacts", json={"full_name": "Jo Lee", "email": "j@x.com"})
    assert r.status_code == 200, r.text
    insert_q = next(call[1] for call in conn.calls if "INSERT INTO public.contacts" in call[1])
    assert "notes" not in insert_q     # notes field was removed


def test_create_contact_activates_it_into_the_pipeline():
    """A contact created from a jobs screen must land IN the jobs pipeline.

    Regression for 2026-09-22: create wrote a public.contacts row and stopped,
    so the contact was invisible to /account-prospects (which filters on
    is_jobs_contact) and to /contacts (which filters on an EXISTS against
    jobs_contact_membership) — while the email UNIQUE index made a second
    attempt fail with "already exists". Added, undeletable, unfindable.
    """
    conn = FakeConn(rows={"SELECT * FROM public.contacts WHERE contact_id=$1": _list_row()},
                    vals={"INSERT INTO public.contacts": 99})
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/contacts", json={"full_name": "Jo Lee", "email": "j@x.com"})
    assert r.status_code == 200, r.text
    # The membership is what /contacts reads...
    mem = next((q for q in conn.queries() if "INSERT INTO bedrock.jobs_contact_membership" in q), None)
    assert mem is not None, "creating a contact left no jobs_contact_membership row"
    # ...and the flag is what /account-prospects reads. Both, or the contact is
    # invisible in one of the two places it was created to appear.
    assert conn.ran("is_jobs_contact"), "creating a contact left is_jobs_contact unset"
    # The new contact_id, not something else, is what got activated.
    assert any(99 in (call[2] or ()) or (call[2] and [99] in call[2])
               for call in conn.calls if "jobs_contact_membership" in call[1])


def test_create_contact_can_opt_out_of_activation():
    """`activate: false` still writes the bare contact row, for a caller that
    genuinely wants one — the default is on, because every UI that creates a
    contact does so in order to work it."""
    conn = FakeConn(rows={"SELECT * FROM public.contacts WHERE contact_id=$1": _list_row()},
                    vals={"INSERT INTO public.contacts": 99})
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/contacts",
               json={"full_name": "Jo Lee", "email": "j@x.com", "activate": False})
    assert r.status_code == 200, r.text
    assert not any("INSERT INTO bedrock.jobs_contact_membership" in q for q in conn.queries())


def test_add_contact_to_jobs_sets_flag_true():
    conn = FakeConn()
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/contacts/5/add-to-jobs")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["is_jobs_contact"] is True
    assert conn.executed("SET is_jobs_contact=true")


def test_add_contact_to_jobs_404_when_missing():
    conn = FakeConn(vals={"SET is_jobs_contact=true": "UPDATE 0"})
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/contacts/5/add-to-jobs")
    assert r.status_code == 404


def test_remove_contact_from_jobs_sets_flag_false():
    conn = FakeConn()
    c = make_jobs_client(conn)
    r = c.delete("/api/jobs/contacts/5/add-to-jobs")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["is_jobs_contact"] is False
    assert conn.executed("SET is_jobs_contact=false")


def test_update_contact_not_found_404():
    c = make_jobs_client(FakeConn())   # existing lookup returns None
    r = c.patch("/api/jobs/contacts/5", json={"email": "new@x.com"})
    assert r.status_code == 404
