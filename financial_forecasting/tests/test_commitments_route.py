"""Tests for routes.commitments — CRUD + progress log.

Uses TestClient with mocked DB and permission-dependency overrides,
matching the pattern in test_awards_route.py.
"""

import sys
import os
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from fastapi.testclient import TestClient
from main import app
from auth import require_auth
from db import get_db
from dependencies import get_mcp_client
import routes.permissions as _perms_mod

app.router.on_startup.clear()
app.router.on_shutdown.clear()

USER = {"user_id": "u1", "email": "user@pursuit.org", "name": "Test User"}

_ALL_COMMITMENT_PERMS = {"view_commitments": True, "manage_commitments": True}
_original_get_user_permissions = _perms_mod.get_user_permissions


async def _fake_full_perms(email, db):
    """check_permission() calls this to resolve the caller's permissions —
    patched (not dependency_overrides'd) because check_permission() returns
    a fresh closure per call, so the route's dependency object and one
    built fresh in a test fixture are never the same object to override.
    Same pattern as test_projects_endpoints.py's authed_client fixture.
    """
    return {"permissions": dict(_ALL_COMMITMENT_PERMS)}

COMMITMENT_ID = "22222222-2222-2222-2222-222222222222"
AWARD_ID = "11111111-1111-1111-1111-111111111111"


class MockDBRow(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


def _commitment_row(**overrides):
    base = {
        "id": COMMITMENT_ID,
        "award_id": AWARD_ID,
        "commitment_type": "quantitative",
        "title": "50 Builders enrolled",
        "contract_language": "Grantee shall enroll 50 Builders...",
        "delivery_plan": "Recruit via partner pipeline.",
        "tracking_tier": "tracked",
        "target_value": 50,
        "target_unit": "Builders",
        "start_date": date(2026, 1, 1),
        "deadline": date(2027, 1, 1),
        "owner": "Jane Doe",
        "owner_ids": [],
        "notes": "",
        "sort_order": 0,
        "created_at": datetime(2026, 8, 12, 12, 0, 0, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 8, 12, 12, 0, 0, tzinfo=timezone.utc),
        "created_by": "user@pursuit.org",
        "award_date": date(2026, 1, 1),
        "latest_value": None,
        "latest_qualitative_status": None,
        "last_update_at": None,
        "last_update_by": None,
        "update_count": 0,
    }
    base.update(overrides)
    return MockDBRow(**base)


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(return_value=None)
    db.fetchval = AsyncMock(return_value=None)
    db.execute = AsyncMock(return_value="UPDATE 1")
    return db


@pytest.fixture
def client(mock_db):
    _perms_mod.get_user_permissions = _fake_full_perms
    app.dependency_overrides[require_auth] = lambda: USER
    app.dependency_overrides[get_db] = lambda: mock_db
    # No Salesforce session in tests — _enrich_opp_ids_with_sf degrades
    # gracefully to {} when client is falsy, same as an SF-unconfigured
    # request in production.
    app.dependency_overrides[get_mcp_client] = lambda: None
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()
    _perms_mod.get_user_permissions = _original_get_user_permissions


async def _fake_no_perms(email, db):
    return {"permissions": {"view_commitments": False, "manage_commitments": False}}


@pytest.fixture
def forbidden_client(mock_db):
    """Authenticated, but the resolved profile grants neither commitment
    permission — every route should 403, not silently succeed."""
    _perms_mod.get_user_permissions = _fake_no_perms
    app.dependency_overrides[require_auth] = lambda: USER
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_mcp_client] = lambda: None
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()
    _perms_mod.get_user_permissions = _original_get_user_permissions


@pytest.fixture
def unauthed_client(mock_db):
    """No auth override at all — tests 401 enforcement."""
    app.dependency_overrides[get_db] = lambda: mock_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Auth enforcement — every endpoint requires auth, and manage_commitments
# for writes / view_commitments for reads
# ---------------------------------------------------------------------------

class TestAuthEnforcement:

    def test_list_requires_auth(self, unauthed_client):
        assert unauthed_client.get("/api/commitments").status_code == 401

    def test_get_requires_auth(self, unauthed_client):
        assert unauthed_client.get(f"/api/commitments/{COMMITMENT_ID}").status_code == 401

    def test_create_requires_auth(self, unauthed_client):
        assert unauthed_client.post("/api/commitments", json={}).status_code == 401

    def test_list_forbidden_without_view_permission(self, forbidden_client):
        assert forbidden_client.get("/api/commitments").status_code == 403

    def test_get_by_award_forbidden_without_view_permission(self, forbidden_client):
        assert forbidden_client.get(f"/api/commitments/by-award/{AWARD_ID}").status_code == 403

    def test_create_forbidden_without_manage_permission(self, forbidden_client):
        r = forbidden_client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "qualitative",
                "title": "x",
                "start_date": "2026-01-01",
                "deadline": "2027-01-01",
            },
        )
        assert r.status_code == 403

    def test_patch_forbidden_without_manage_permission(self, forbidden_client):
        r = forbidden_client.patch(f"/api/commitments/{COMMITMENT_ID}", json={"notes": "x"})
        assert r.status_code == 403

    def test_delete_forbidden_without_manage_permission(self, forbidden_client):
        assert forbidden_client.delete(f"/api/commitments/{COMMITMENT_ID}").status_code == 403

    def test_create_log_forbidden_without_manage_permission(self, forbidden_client):
        r = forbidden_client.post(f"/api/commitments/{COMMITMENT_ID}/log", json={"recorded_value": 1})
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# GET /api/commitments
# ---------------------------------------------------------------------------

class TestListCommitments:

    def test_list_empty_returns_empty_array(self, client, mock_db):
        mock_db.fetch.return_value = []
        r = client.get("/api/commitments")
        assert r.status_code == 200
        assert r.json() == []

    def test_list_returns_commitments_with_computed_status(self, client, mock_db):
        mock_db.fetch.return_value = [_commitment_row()]
        r = client.get("/api/commitments")
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 1
        assert body[0]["title"] == "50 Builders enrolled"
        # No status column exists on the row — it must be computed.
        assert body[0]["status"] in ("on-track", "ahead", "under", "complete")

    def test_list_invalid_tracking_tier_400(self, client):
        r = client.get("/api/commitments?tracking_tier=bogus")
        assert r.status_code == 400

    def test_list_defaults_to_tracked(self, client, mock_db):
        mock_db.fetch.return_value = []
        client.get("/api/commitments")
        called_sql = mock_db.fetch.call_args.args[0]
        assert "tracking_tier = $1" in called_sql


# ---------------------------------------------------------------------------
# GET /api/commitments/{id}
# ---------------------------------------------------------------------------

class TestGetCommitment:

    def test_get_404_when_missing(self, client, mock_db):
        mock_db.fetchrow.return_value = None
        r = client.get(f"/api/commitments/{COMMITMENT_ID}")
        assert r.status_code == 404

    def test_get_invalid_uuid_400(self, client):
        r = client.get("/api/commitments/not-a-uuid")
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/commitments
# ---------------------------------------------------------------------------

class TestCreateCommitment:

    def test_create_quantitative_without_target_400(self, client, mock_db):
        mock_db.fetchval.return_value = 1  # award exists
        r = client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "quantitative",
                "title": "Missing target",
                "start_date": "2026-01-01",
                "deadline": "2027-01-01",
            },
        )
        assert r.status_code == 400

    def test_create_invalid_commitment_type_400(self, client):
        r = client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "bogus",
                "title": "x",
                "start_date": "2026-01-01",
                "deadline": "2027-01-01",
            },
        )
        assert r.status_code == 400

    def test_create_missing_award_404(self, client, mock_db):
        mock_db.fetchval.return_value = None
        r = client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "qualitative",
                "title": "x",
                "start_date": "2026-01-01",
                "deadline": "2027-01-01",
            },
        )
        assert r.status_code == 404

    def test_create_success(self, client, mock_db):
        mock_db.fetchval.return_value = 1
        mock_db.fetchrow.side_effect = [
            MockDBRow(id=COMMITMENT_ID),  # INSERT ... RETURNING id
            _commitment_row(),  # re-fetch via _SELECT
        ]
        r = client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "quantitative",
                "title": "50 Builders enrolled",
                "target_value": 50,
                "start_date": "2026-01-01",
                "deadline": "2027-01-01",
            },
        )
        assert r.status_code == 200
        assert r.json()["title"] == "50 Builders enrolled"

    def test_create_empty_title_400(self, client, mock_db):
        mock_db.fetchval.return_value = 1
        r = client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "qualitative",
                "title": "   ",
                "start_date": "2026-01-01",
                "deadline": "2027-01-01",
            },
        )
        assert r.status_code == 400

    def test_create_deadline_before_start_date_400(self, client, mock_db):
        mock_db.fetchval.return_value = 1
        r = client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "qualitative",
                "title": "x",
                "start_date": "2027-01-01",
                "deadline": "2026-01-01",
            },
        )
        assert r.status_code == 400

    def test_create_malformed_owner_id_400(self, client, mock_db):
        mock_db.fetchval.return_value = 1
        r = client.post(
            "/api/commitments",
            json={
                "award_id": AWARD_ID,
                "commitment_type": "qualitative",
                "title": "x",
                "start_date": "2026-01-01",
                "deadline": "2027-01-01",
                "owner_ids": ["not-a-uuid"],
            },
        )
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# PATCH /api/commitments/{id}
# ---------------------------------------------------------------------------

class TestPatchCommitment:

    def test_patch_no_fields_400(self, client):
        r = client.patch(f"/api/commitments/{COMMITMENT_ID}", json={})
        assert r.status_code == 400

    def test_patch_invalid_tracking_tier_400(self, client):
        r = client.patch(
            f"/api/commitments/{COMMITMENT_ID}",
            json={"tracking_tier": "bogus"},
        )
        assert r.status_code == 400

    def test_patch_404_when_missing(self, client, mock_db):
        mock_db.fetchrow.return_value = None
        r = client.patch(
            f"/api/commitments/{COMMITMENT_ID}",
            json={"notes": "updated"},
        )
        assert r.status_code == 404

    def test_patch_success(self, client, mock_db):
        mock_db.fetchrow.side_effect = [
            MockDBRow(commitment_type="quantitative", start_date=date(2026, 1, 1), deadline=date(2027, 1, 1)),  # existing
            MockDBRow(id=COMMITMENT_ID),  # UPDATE ... RETURNING id
            _commitment_row(tracking_tier="reference"),  # re-fetch via _SELECT
        ]
        r = client.patch(
            f"/api/commitments/{COMMITMENT_ID}",
            json={"tracking_tier": "reference"},
        )
        assert r.status_code == 200
        assert r.json()["tracking_tier"] == "reference"

    def test_patch_empty_title_400(self, client, mock_db):
        mock_db.fetchrow.return_value = MockDBRow(
            commitment_type="quantitative", start_date=date(2026, 1, 1), deadline=date(2027, 1, 1)
        )
        r = client.patch(f"/api/commitments/{COMMITMENT_ID}", json={"title": "   "})
        assert r.status_code == 400

    def test_patch_cannot_clear_target_value_on_quantitative_400(self, client, mock_db):
        mock_db.fetchrow.return_value = MockDBRow(
            commitment_type="quantitative", start_date=date(2026, 1, 1), deadline=date(2027, 1, 1)
        )
        r = client.patch(f"/api/commitments/{COMMITMENT_ID}", json={"target_value": None})
        assert r.status_code == 400

    def test_patch_deadline_before_effective_start_date_400(self, client, mock_db):
        # Existing start_date is 2026-01-01; patching deadline earlier than
        # that (without also moving start_date) must be rejected.
        mock_db.fetchrow.return_value = MockDBRow(
            commitment_type="quantitative", start_date=date(2026, 1, 1), deadline=date(2027, 1, 1)
        )
        r = client.patch(f"/api/commitments/{COMMITMENT_ID}", json={"deadline": "2025-06-01"})
        assert r.status_code == 400

    def test_patch_malformed_owner_id_400(self, client, mock_db):
        mock_db.fetchrow.return_value = MockDBRow(
            commitment_type="quantitative", start_date=date(2026, 1, 1), deadline=date(2027, 1, 1)
        )
        r = client.patch(f"/api/commitments/{COMMITMENT_ID}", json={"owner_ids": ["not-a-uuid"]})
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Progress log
# ---------------------------------------------------------------------------

class TestProgressLog:

    def test_create_log_requires_a_value(self, client, mock_db):
        mock_db.fetchrow.return_value = MockDBRow(commitment_type="quantitative")
        r = client.post(f"/api/commitments/{COMMITMENT_ID}/log", json={})
        assert r.status_code == 400

    def test_create_log_quantitative_missing_value_400(self, client, mock_db):
        mock_db.fetchrow.return_value = MockDBRow(commitment_type="quantitative")
        r = client.post(
            f"/api/commitments/{COMMITMENT_ID}/log",
            json={"recorded_status": "in-progress"},
        )
        assert r.status_code == 400

    def test_create_log_invalid_status_400(self, client, mock_db):
        mock_db.fetchrow.return_value = MockDBRow(commitment_type="qualitative")
        r = client.post(
            f"/api/commitments/{COMMITMENT_ID}/log",
            json={"recorded_status": "bogus"},
        )
        assert r.status_code == 400

    def test_create_log_404_when_commitment_missing(self, client, mock_db):
        mock_db.fetchrow.return_value = None
        r = client.post(
            f"/api/commitments/{COMMITMENT_ID}/log",
            json={"recorded_value": 10},
        )
        assert r.status_code == 404

    def test_create_log_success(self, client, mock_db):
        mock_db.fetchrow.side_effect = [
            MockDBRow(commitment_type="quantitative"),
            MockDBRow(
                id="33333333-3333-3333-3333-333333333333",
                commitment_id=COMMITMENT_ID,
                recorded_value=10,
                recorded_status=None,
                note="",
                recorded_by_email="user@pursuit.org",
                recorded_at=datetime(2026, 8, 12, tzinfo=timezone.utc),
                created_at=datetime(2026, 8, 12, tzinfo=timezone.utc),
            ),
        ]
        r = client.post(
            f"/api/commitments/{COMMITMENT_ID}/log",
            json={"recorded_value": 10},
        )
        assert r.status_code == 200
        assert r.json()["recorded_value"] == 10

    def test_create_log_naive_recorded_at_treated_as_utc(self, client, mock_db):
        # No offset in the payload — must not be silently interpreted
        # under the DB session's local timezone.
        mock_db.fetchrow.side_effect = [
            MockDBRow(commitment_type="quantitative"),
            MockDBRow(
                id="33333333-3333-3333-3333-333333333333",
                commitment_id=COMMITMENT_ID,
                recorded_value=10,
                recorded_status=None,
                note="",
                recorded_by_email="user@pursuit.org",
                recorded_at=datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
                created_at=datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
            ),
        ]
        client.post(
            f"/api/commitments/{COMMITMENT_ID}/log",
            json={"recorded_value": 10, "recorded_at": "2026-01-01T12:00:00"},
        )
        insert_call = mock_db.fetchrow.call_args_list[-1]
        recorded_at_arg = insert_call.args[-1]
        assert recorded_at_arg.tzinfo is not None
        assert recorded_at_arg.utcoffset().total_seconds() == 0
