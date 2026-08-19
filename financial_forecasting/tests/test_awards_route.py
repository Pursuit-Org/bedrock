"""Tests for routes.awards — read endpoints + PATCH.

Uses TestClient with mocked DB and auth dependency overrides, matching the
pattern in test_admin_sf_drift.py.
"""

import sys
import os
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from fastapi.testclient import TestClient
from main import app
from auth import require_auth
from db import get_db
from dependencies import get_mcp_client

app.router.on_startup.clear()
app.router.on_shutdown.clear()


USER = {"user_id": "u1", "email": "user@pursuit.org", "name": "Test User"}

# Stable IDs used across tests
AWARD_ID = "11111111-1111-1111-1111-111111111111"
OPP_ID = "006X000000ABCDE"  # 15-char SF id; route uses validate_salesforce_id


class MockDBRow(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


def _award_row(**overrides):
    base = {
        "id": AWARD_ID,
        "opportunity_id": OPP_ID,
        "award_status": "Active",
        "award_date": date(2024, 7, 15),
        "period_end_date": None,
        "notes": "",
        "created_at": datetime(2026, 4, 30, 12, 0, 0, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 4, 30, 12, 0, 0, tzinfo=timezone.utc),
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
    app.dependency_overrides[require_auth] = lambda: USER
    app.dependency_overrides[get_db] = lambda: mock_db
    # GET /awards/{id} depends on get_mcp_client for best-effort SF
    # enrichment; an empty connected_services makes it a no-op rather than
    # 503ing when app startup never ran.
    app.dependency_overrides[get_mcp_client] = lambda: MagicMock(connected_services=set())
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# GET /api/awards
# ---------------------------------------------------------------------------

class TestListAwards:

    def test_list_empty_returns_empty_array(self, client, mock_db):
        mock_db.fetch.return_value = []
        r = client.get("/api/awards")
        assert r.status_code == 200
        assert r.json() == []

    def test_list_returns_awards(self, client, mock_db):
        mock_db.fetch.return_value = [_award_row()]
        r = client.get("/api/awards")
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 1
        assert body[0]["opportunity_id"] == OPP_ID
        assert body[0]["award_status"] == "Active"

    def test_list_invalid_status_400(self, client):
        r = client.get("/api/awards?status=Bogus")
        assert r.status_code == 400

    def test_list_filtered_by_status(self, client, mock_db):
        mock_db.fetch.return_value = [_award_row(award_status="Closing")]
        r = client.get("/api/awards?status=Closing")
        assert r.status_code == 200
        assert r.json()[0]["award_status"] == "Closing"
        # Confirm the parameterized query was used
        called_sql = mock_db.fetch.call_args.args[0]
        assert "award_status = $1" in called_sql


# ---------------------------------------------------------------------------
# GET /api/awards/{award_id}
# ---------------------------------------------------------------------------

class TestGetAward:

    def test_get_by_id_404_when_missing(self, client, mock_db):
        mock_db.fetchrow.return_value = None
        r = client.get(f"/api/awards/{AWARD_ID}")
        assert r.status_code == 404

    def test_get_by_id_returns_award(self, client, mock_db):
        mock_db.fetchrow.return_value = _award_row()
        r = client.get(f"/api/awards/{AWARD_ID}")
        assert r.status_code == 200
        assert r.json()["id"] == AWARD_ID

    def test_get_by_id_invalid_uuid_400(self, client):
        r = client.get("/api/awards/not-a-uuid")
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# GET /api/awards/by-opp/{opp_id}
# ---------------------------------------------------------------------------

class TestGetAwardByOpp:

    def test_by_opp_404_when_missing(self, client, mock_db):
        mock_db.fetchrow.return_value = None
        r = client.get(f"/api/awards/by-opp/{OPP_ID}")
        assert r.status_code == 404

    def test_by_opp_returns_award(self, client, mock_db):
        mock_db.fetchrow.return_value = _award_row()
        r = client.get(f"/api/awards/by-opp/{OPP_ID}")
        assert r.status_code == 200
        assert r.json()["opportunity_id"] == OPP_ID

    def test_by_opp_invalid_id_rejected(self, client):
        # validate_salesforce_id rejects non-15/18-char ids with non-alnum.
        r = client.get("/api/awards/by-opp/short")
        assert r.status_code in (400, 422)


# ---------------------------------------------------------------------------
# PATCH /api/awards/{award_id}
# ---------------------------------------------------------------------------

class TestPatchAward:

    def test_patch_status(self, client, mock_db):
        mock_db.fetchrow.return_value = _award_row(award_status="Closing")
        r = client.patch(
            f"/api/awards/{AWARD_ID}",
            json={"award_status": "Closing"},
        )
        assert r.status_code == 200
        assert r.json()["award_status"] == "Closing"

    def test_patch_invalid_status_400(self, client):
        r = client.patch(
            f"/api/awards/{AWARD_ID}",
            json={"award_status": "Bogus"},
        )
        assert r.status_code == 400

    def test_patch_no_fields_400(self, client):
        r = client.patch(f"/api/awards/{AWARD_ID}", json={})
        assert r.status_code == 400

    def test_patch_404_when_missing(self, client, mock_db):
        mock_db.fetchrow.return_value = None
        r = client.patch(
            f"/api/awards/{AWARD_ID}",
            json={"notes": "updated"},
        )
        assert r.status_code == 404

    def test_patch_invalid_uuid_400(self, client):
        r = client.patch(
            "/api/awards/not-a-uuid",
            json={"notes": "x"},
        )
        assert r.status_code == 400

    def test_patch_period_end_date(self, client, mock_db):
        mock_db.fetchrow.return_value = _award_row(period_end_date=date(2027, 6, 30))
        r = client.patch(
            f"/api/awards/{AWARD_ID}",
            json={"period_end_date": "2027-06-30"},
        )
        assert r.status_code == 200
        assert r.json()["period_end_date"] == "2027-06-30"

    def test_patch_contract_file_link_rejects_non_http_scheme(self, client):
        # A stored javascript:/data: URI would be a click-to-execute XSS
        # vector wherever contract_file_link renders as <a href>.
        r = client.patch(
            f"/api/awards/{AWARD_ID}",
            json={"contract_file_link": "javascript:alert(1)"},
        )
        assert r.status_code == 400

    def test_patch_contract_file_link_accepts_https(self, client, mock_db):
        mock_db.fetchrow.return_value = _award_row(
            contract_file_link="https://drive.example.com/grant.pdf"
        )
        r = client.patch(
            f"/api/awards/{AWARD_ID}",
            json={"contract_file_link": "https://drive.example.com/grant.pdf"},
        )
        assert r.status_code == 200
        assert r.json()["contract_file_link"] == "https://drive.example.com/grant.pdf"
