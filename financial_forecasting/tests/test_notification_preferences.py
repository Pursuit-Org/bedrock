"""Evals for the notification-preferences feature added 2026-09-23:

  - GET/PUT /api/notifications/preferences (routes/notifications.py)
  - Per-entity-bucket muting in services.notifications.enqueue_notification
  - The global Slack on/off gate in services.notifications._dispatch_slack
  - services.entity_owner (owner resolution + owner-changed fan-out)
  - routes/entity_comments.py's new "notify the record owner" behavior

No live DB / SF — FakeConn + FakeSalesforce dispatch by SQL/SOQL substring,
matching the pattern in tests/jobs_fakes.py used across the jobs_* eval
modules.
"""
import pytest

from tests.jobs_fakes import DEFAULT_USER, FakeConn, FakeSalesforce, make_jobs_client

from services import entity_owner as entity_owner_module
from services import notifications as notif_module
from services.notifications import (
    TYPE_ACCOUNT_COMMENT_ADDED,
    TYPE_ACCOUNT_OWNER_CHANGED,
    TYPE_PROJECT_TASK_ASSIGNED,
    enqueue_notification,
)


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _pref_row(**ov):
    row = {
        "slack_enabled": True,
        "account_activity_enabled": True,
        "contact_activity_enabled": True,
        "opportunity_activity_enabled": True,
    }
    row.update(ov)
    return row


# ── GET/PUT /api/notifications/preferences ──────────────────────────────────


def test_get_preferences_defaults_when_no_row():
    conn = FakeConn()  # no row configured -> fetchrow returns None
    c = make_jobs_client(conn)
    r = c.get("/api/notifications/preferences")
    assert r.status_code == 200, r.text
    assert r.json()["data"] == _pref_row()


def test_get_preferences_returns_existing_row():
    conn = FakeConn(rows={"notification_preference": _pref_row(slack_enabled=False, account_activity_enabled=False)})
    c = make_jobs_client(conn)
    r = c.get("/api/notifications/preferences")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["slack_enabled"] is False
    assert data["account_activity_enabled"] is False
    assert data["contact_activity_enabled"] is True


def test_put_preferences_upserts_and_returns_values():
    conn = FakeConn(rows={"notification_preference": _pref_row(slack_enabled=False)})
    c = make_jobs_client(conn)
    body = {
        "slack_enabled": False,
        "account_activity_enabled": True,
        "contact_activity_enabled": True,
        "opportunity_activity_enabled": True,
    }
    r = c.put("/api/notifications/preferences", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["slack_enabled"] is False
    assert conn.ran("INSERT INTO bedrock.notification_preference")
    assert conn.ran("ON CONFLICT (user_email) DO UPDATE")


def test_put_preferences_requires_all_fields():
    conn = FakeConn()
    c = make_jobs_client(conn)
    r = c.put("/api/notifications/preferences", json={"slack_enabled": True})
    assert r.status_code == 422


# ── enqueue_notification: per-entity-bucket muting ──────────────────────────


@pytest.mark.asyncio
async def test_enqueue_notification_skipped_when_bucket_disabled():
    """Muting the 'account' bucket suppresses account_owner_changed
    entirely — no bedrock.notification row is inserted at all (not just
    a Slack skip)."""
    conn = FakeConn(rows={"notification_preference": _pref_row(account_activity_enabled=False)})
    result = await enqueue_notification(
        conn,
        recipient_email="owner@pursuit.org",
        type=TYPE_ACCOUNT_OWNER_CHANGED,
        payload={"title": "t"},
        actor_email="actor@pursuit.org",
    )
    assert result is None
    assert not conn.ran("INSERT INTO bedrock.notification (recipient_email")


@pytest.mark.asyncio
async def test_enqueue_notification_fires_when_bucket_enabled():
    conn = FakeConn(
        rows={
            "notification_preference": _pref_row(),  # account_activity_enabled=True
            "recipient_email, type, payload": {"id": "11111111-1111-1111-1111-111111111111"},
        }
    )
    result = await enqueue_notification(
        conn,
        recipient_email="owner@pursuit.org",
        type=TYPE_ACCOUNT_OWNER_CHANGED,
        payload={"title": "t"},
        actor_email="actor@pursuit.org",
    )
    assert result == "11111111-1111-1111-1111-111111111111"
    assert conn.ran("INSERT INTO bedrock.notification")


@pytest.mark.asyncio
async def test_enqueue_notification_fires_when_no_preference_row_at_all():
    """No row in bedrock.notification_preference == every bucket defaults
    to enabled (opt-out, never opt-in)."""
    conn = FakeConn(rows={"recipient_email, type, payload": {"id": "22222222-2222-2222-2222-222222222222"}})
    result = await enqueue_notification(
        conn,
        recipient_email="owner@pursuit.org",
        type=TYPE_ACCOUNT_OWNER_CHANGED,
        payload={},
        actor_email=None,
    )
    assert result == "22222222-2222-2222-2222-222222222222"


@pytest.mark.asyncio
async def test_enqueue_notification_ungated_type_ignores_preference_row():
    """project_task_assigned isn't in _ACTIVITY_BUCKET_BY_TYPE — it must
    fire even if every bucket in the preference row is disabled."""
    conn = FakeConn(
        rows={
            "notification_preference": _pref_row(
                account_activity_enabled=False,
                contact_activity_enabled=False,
                opportunity_activity_enabled=False,
            ),
            "recipient_email, type, payload": {"id": "33333333-3333-3333-3333-333333333333"},
        }
    )
    result = await enqueue_notification(
        conn,
        recipient_email="someone@pursuit.org",
        type=TYPE_PROJECT_TASK_ASSIGNED,
        payload={},
        actor_email=None,
    )
    assert result == "33333333-3333-3333-3333-333333333333"


@pytest.mark.asyncio
async def test_enqueue_notification_unknown_type_still_rejected():
    """Pre-existing validation must survive the preference-gating change."""
    conn = FakeConn()
    with pytest.raises(ValueError):
        await enqueue_notification(
            conn, recipient_email="x@pursuit.org", type="not_a_real_type", payload={},
        )


@pytest.mark.asyncio
async def test_get_preference_defaults_missing_row_to_all_enabled():
    conn = FakeConn()
    pref = await notif_module._get_preference(conn, "nobody@pursuit.org")
    assert pref == _pref_row()


@pytest.mark.asyncio
async def test_get_preference_merges_partial_row_with_defaults():
    """asyncpg Record -> dict merge shouldn't drop keys the row happens
    to share with the defaults, and must surface the row's real values."""
    conn = FakeConn(rows={"notification_preference": {"slack_enabled": False}})
    pref = await notif_module._get_preference(conn, "x@pursuit.org")
    assert pref["slack_enabled"] is False
    # dict() over the fake row only has the one key we set — merge still
    # succeeds because _get_preference starts from the defaults dict.
    assert pref["account_activity_enabled"] is True


# ── services.entity_owner ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_entity_owner_returns_none_for_unknown_entity_type():
    sf = FakeSalesforce()
    result = await entity_owner_module.resolve_entity_owner(sf, "opportunity", "006X")
    assert result is None
    assert sf.queries == []  # never even attempted a SOQL for an unsupported type


@pytest.mark.asyncio
async def test_resolve_entity_owner_returns_none_when_record_missing():
    sf = FakeSalesforce(query_results={"FROM Account": {"records": []}})
    result = await entity_owner_module.resolve_entity_owner(sf, "account", "001MISSING")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_entity_owner_returns_none_without_owner_email():
    sf = FakeSalesforce(query_results={
        "FROM Account": {"records": [{"Id": "001A", "Name": "Acme", "OwnerId": "005X", "Owner": {}}]},
    })
    result = await entity_owner_module.resolve_entity_owner(sf, "account", "001A")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_entity_owner_parses_record():
    sf = FakeSalesforce(query_results={
        "FROM Account": {
            "records": [{
                "Id": "001A", "Name": "Acme", "OwnerId": "005X",
                "Owner": {"Email": "Owner@Pursuit.org", "Name": "Owner Person"},
            }],
        },
    })
    result = await entity_owner_module.resolve_entity_owner(sf, "account", "001A")
    assert result == {
        "record_id": "001A",
        "record_name": "Acme",
        "owner_id": "005X",
        "owner_email": "Owner@Pursuit.org",
        "owner_name": "Owner Person",
    }


@pytest.mark.asyncio
async def test_resolve_entity_owner_contact_uses_contact_sobject():
    sf = FakeSalesforce(query_results={
        "FROM Contact": {
            "records": [{"Id": "003C", "Name": "Jane Donor", "OwnerId": "005X",
                         "Owner": {"Email": "owner@pursuit.org", "Name": "Owner"}}],
        },
    })
    result = await entity_owner_module.resolve_entity_owner(sf, "contact", "003C")
    assert result["record_name"] == "Jane Donor"
    assert any("FROM Contact" in q for q in sf.queries)


@pytest.mark.asyncio
async def test_find_org_user_returns_none_for_empty_email():
    conn = FakeConn()
    assert await entity_owner_module.find_org_user(conn, None) is None
    assert await entity_owner_module.find_org_user(conn, "") is None


# ── notify_owner_changed: gained/lost + self-action + no-op suppression ─────


@pytest.mark.asyncio
async def test_notify_owner_changed_noop_when_owner_unchanged():
    conn = FakeConn()
    await entity_owner_module.notify_owner_changed(
        conn, entity_type="account", entity_id="001A",
        old_owner={"owner_id": "005SAME", "owner_email": "a@pursuit.org", "owner_name": "A"},
        new_owner={"owner_id": "005SAME", "owner_email": "a@pursuit.org", "owner_name": "A", "record_name": "Acme"},
        actor_email="admin@pursuit.org",
    )
    assert not conn.ran("INSERT INTO bedrock.notification")


@pytest.mark.asyncio
async def test_notify_owner_changed_skips_recipient_who_is_the_actor():
    """The gainer made the change themselves (self-reassign) -> no
    'gained' ping to them; likewise the actor never gets a 'lost' ping
    for their own action."""
    conn = FakeConn(rows={"org_users": {"email": "new@pursuit.org", "display_name": "New"}})
    await entity_owner_module.notify_owner_changed(
        conn, entity_type="account", entity_id="001A",
        old_owner={"owner_id": "005OLD", "owner_email": "new@pursuit.org", "owner_name": "New"},
        new_owner={"owner_id": "005NEW", "owner_email": "new@pursuit.org", "owner_name": "New", "record_name": "Acme"},
        actor_email="new@pursuit.org",
    )
    assert not conn.ran("INSERT INTO bedrock.notification (recipient_email")


@pytest.mark.asyncio
async def test_notify_owner_changed_fires_gained_and_lost():
    conn = FakeConn(
        rows={
            "org_users": {"email": "resolved@pursuit.org", "display_name": "Resolved"},
            # enqueue_notification's insert is a fetchrow (RETURNING id) —
            # must live under `rows`, not `vals` (fetchval/execute only).
            "recipient_email, type, payload": {"id": "99999999-9999-9999-9999-999999999999"},
        },
    )
    await entity_owner_module.notify_owner_changed(
        conn, entity_type="account", entity_id="001A",
        old_owner={"owner_id": "005OLD", "owner_email": "old@pursuit.org", "owner_name": "Old"},
        new_owner={"owner_id": "005NEW", "owner_email": "new@pursuit.org", "owner_name": "New", "record_name": "Acme"},
        actor_email="admin@pursuit.org",
    )
    inserts = [c for c in conn.calls if c[0] == "fetchrow" and "recipient_email, type, payload" in c[1]]
    # notification_preference lookups also go through fetchrow — filter
    # those out by checking the insert-specific fragment only.
    assert len(inserts) == 2  # one 'gained' to the new owner, one 'lost' to the old owner


@pytest.mark.asyncio
async def test_notify_owner_changed_swallows_errors():
    """A DB hiccup here must never propagate — this is called from inside
    update_account/update_contact and must not fail the actual SF write."""
    class ExplodingConn:
        def transaction(self):
            raise AssertionError("should not be reached")

        async def fetchrow(self, *a, **k):
            raise RuntimeError("boom")

    await entity_owner_module.notify_owner_changed(
        ExplodingConn(), entity_type="account", entity_id="001A",
        old_owner={"owner_id": "005OLD", "owner_email": "old@pursuit.org", "owner_name": "Old"},
        new_owner={"owner_id": "005NEW", "owner_email": "new@pursuit.org", "owner_name": "New", "record_name": "Acme"},
        actor_email="admin@pursuit.org",
    )  # no raise == pass


# ── routes/entity_comments.py: notify the account/contact owner ────────────


def test_create_entity_comment_notifies_account_owner_when_different():
    sf = FakeSalesforce(query_results={
        "FROM Account": {
            "records": [{"Id": "001A", "Name": "Acme",
                         "Owner": {"Email": "owner@pursuit.org", "Name": "Owner"}}],
        },
    })
    conn = FakeConn(
        rows={
            "entity_comment": {
                "id": "44444444-4444-4444-4444-444444444444", "entity_type": "account",
                "entity_id": "001A", "author_id": None, "author_email": DEFAULT_USER["email"],
                "content": "hello", "created_at": None, "updated_at": None,
            },
            "org_users": {"email": "owner@pursuit.org", "display_name": "Owner"},
            # enqueue_notification's insert is a fetchrow (RETURNING id).
            "recipient_email, type, payload": {"id": "88888888-8888-8888-8888-888888888888"},
        },
    )
    c = make_jobs_client(conn, sf=sf)
    r = c.post("/api/entity-comments", json={"entity_type": "account", "entity_id": "001A", "content": "hello"})
    assert r.status_code == 200, r.text
    assert any("FROM Account" in q for q in sf.queries)
    assert any(
        call[0] == "fetchrow" and "recipient_email, type, payload" in call[1]
        for call in conn.calls
    )


def test_create_entity_comment_skips_notify_when_author_is_owner():
    sf = FakeSalesforce(query_results={
        "FROM Account": {
            "records": [{"Id": "001A", "Name": "Acme",
                         "Owner": {"Email": DEFAULT_USER["email"], "Name": "Me"}}],
        },
    })
    conn = FakeConn(rows={
        "entity_comment": {
            "id": "55555555-5555-5555-5555-555555555555", "entity_type": "account",
            "entity_id": "001A", "author_id": None, "author_email": DEFAULT_USER["email"],
            "content": "hello", "created_at": None, "updated_at": None,
        },
    })
    c = make_jobs_client(conn, sf=sf)
    r = c.post("/api/entity-comments", json={"entity_type": "account", "entity_id": "001A", "content": "hello"})
    assert r.status_code == 200, r.text
    assert not any(
        call[0] == "fetchrow" and "recipient_email, type, payload" in call[1]
        for call in conn.calls
    )


def test_create_entity_comment_skips_notify_for_opportunity_type():
    """Only account/contact comments get the owner-notify treatment —
    opportunity comments are unchanged (product decision, not a bug)."""
    sf = FakeSalesforce()
    conn = FakeConn(rows={
        "entity_comment": {
            "id": "66666666-6666-6666-6666-666666666666", "entity_type": "opportunity",
            "entity_id": "006O", "author_id": None, "author_email": DEFAULT_USER["email"],
            "content": "hello", "created_at": None, "updated_at": None,
        },
    })
    c = make_jobs_client(conn, sf=sf)
    r = c.post("/api/entity-comments", json={"entity_type": "opportunity", "entity_id": "006O", "content": "hello"})
    assert r.status_code == 200, r.text
    assert sf.queries == []  # never even tried to resolve an owner


def test_create_entity_comment_survives_missing_salesforce_client():
    """No SF connected (get_mcp_client's degrade-gracefully path) must
    still let the comment through — the owner-notify is best-effort."""
    conn = FakeConn(rows={
        "entity_comment": {
            "id": "77777777-7777-7777-7777-777777777777", "entity_type": "account",
            "entity_id": "001A", "author_id": None, "author_email": DEFAULT_USER["email"],
            "content": "hello", "created_at": None, "updated_at": None,
        },
    })
    from main import app, get_current_user
    from auth import require_auth
    from db import get_db
    from dependencies import get_mcp_client, require_sf_mcp_client
    from fastapi.testclient import TestClient

    app.dependency_overrides[require_auth] = lambda: DEFAULT_USER
    app.dependency_overrides[get_current_user] = lambda: DEFAULT_USER
    app.dependency_overrides[get_db] = lambda: conn
    app.dependency_overrides[get_mcp_client] = lambda: None
    app.dependency_overrides[require_sf_mcp_client] = lambda: None
    c = TestClient(app, raise_server_exceptions=False)

    r = c.post("/api/entity-comments", json={"entity_type": "account", "entity_id": "001A", "content": "hello"})
    assert r.status_code == 200, r.text
