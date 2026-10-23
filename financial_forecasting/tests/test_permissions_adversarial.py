"""Adversarial tests — permission escalation, lock bypass, boundary enforcement."""

import sys
import os
import json
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
from main import app, get_current_user, get_mcp_client
from main import require_sf_mcp_client as main_require_sf_mcp_client
from dependencies import require_sf_mcp_client as deps_require_sf_mcp_client
from auth import require_auth
from db import get_db

app.router.on_startup.clear()
app.router.on_shutdown.clear()

TEST_USER = {"user_id": "test_user", "email": "rm@pursuit.org", "name": "Relationship Manager"}
ADMIN_PROFILE_ID = str(uuid.uuid4())
RM_PROFILE_ID = str(uuid.uuid4())
USER_ID = str(uuid.uuid4())
SF_USER_ID = "005RMUSER00000001"
OTHER_SF_USER_ID = "005OTHEROWNER0001"
OPP_ID = "006TESTOPPORT01"

RM_PERMS = json.dumps({
    "view_opportunities": True, "edit_own_opportunities": True, "edit_all_opportunities": False,
    "create_opportunities": True, "bulk_update_opportunities": False, "lock_own_opportunities": True,
    "reassign_opportunities": False,
    "view_tasks": True, "edit_own_tasks": True, "edit_all_tasks": False, "create_tasks": True,
    "edit_accounts": True, "create_accounts": True,
    "edit_contacts": True, "create_contacts": True,
    "edit_payments": False, "create_payments": False,
    "view_projects": False, "edit_projects": False,
    "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
    "view_sage_invoices_payments": False, "create_sage_invoices": False,
    "match_invoices": False, "manage_payment_schedules": False, "generate_financial_reports": False,
    "use_pebble_chat": False, "use_pebble_research": False, "pebble_crm_write": False,
    "trigger_data_sync": False, "manage_users_roles": False, "edit_permission_profiles": False,
})


class MockDBRow(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


def rm_row():
    return MockDBRow(
        id=USER_ID, sf_user_id=SF_USER_ID, email="rm@pursuit.org",
        name="Relationship Manager", is_active=True, permissions=RM_PERMS,
        profile_name="Relationship Manager", profile_id=RM_PROFILE_ID,
    )


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(return_value=rm_row())
    db.fetchval = AsyncMock(return_value=1)
    db.execute = AsyncMock(return_value="OK")
    return db


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.salesforce = AsyncMock()
    client.salesforce.query = AsyncMock(return_value={"records": []})
    client.salesforce.update_record = AsyncMock(return_value=True)
    client.salesforce.create_record = AsyncMock(return_value={"id": "006NEW"})
    client.salesforce.delete_record = AsyncMock(return_value=True)
    client.disconnect_all = AsyncMock()
    return client


@pytest.fixture
def rm_client(mock_db, mock_client):
    """Authenticated as a Relationship Manager (non-admin, restricted permissions)."""
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[require_auth] = lambda: TEST_USER
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_mcp_client] = lambda: mock_client
    app.dependency_overrides[main_require_sf_mcp_client] = lambda: mock_client
    app.dependency_overrides[deps_require_sf_mcp_client] = lambda: mock_client
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


# ===========================================================================
# ESCALATION: RM tries to gain admin access
# ===========================================================================


class TestEscalation:
    """An RM must not be able to promote themselves to Admin."""

    def test_cannot_update_own_profile_assignment(self, rm_client):
        """PUT /api/permissions/users/{id} requires admin — RM gets 403."""
        resp = rm_client.put(
            f"/api/permissions/users/{USER_ID}",
            json={"profile_id": ADMIN_PROFILE_ID},
        )
        assert resp.status_code == 403

    def test_cannot_create_admin_profile(self, rm_client):
        """POST /api/permissions/profiles requires admin — RM gets 403."""
        resp = rm_client.post(
            "/api/permissions/profiles",
            json={"name": "Hacker", "permissions": {"manage_users_roles": True}},
        )
        assert resp.status_code == 403

    def test_cannot_update_existing_profile(self, rm_client):
        """PUT /api/permissions/profiles/{id} requires admin — RM gets 403."""
        resp = rm_client.put(
            f"/api/permissions/profiles/{RM_PROFILE_ID}",
            json={"permissions": {"manage_users_roles": True, "edit_all_opportunities": True}},
        )
        assert resp.status_code == 403

    def test_cannot_delete_profile(self, rm_client):
        """DELETE /api/permissions/profiles/{id} requires admin — RM gets 403."""
        resp = rm_client.delete(f"/api/permissions/profiles/{RM_PROFILE_ID}")
        assert resp.status_code == 403

    def test_cannot_list_users(self, rm_client):
        """GET /api/permissions/users requires admin — RM gets 403."""
        resp = rm_client.get("/api/permissions/users")
        assert resp.status_code == 403


# ===========================================================================
# LOCK BYPASS: User tries to edit a locked opportunity
# ===========================================================================


class TestLockBypass:
    """Locked opportunities must block edits at the API level."""

    def test_cannot_edit_locked_opportunity(self, rm_client, mock_db):
        """PUT /api/salesforce/opportunities/{id} blocked when locked by another user."""
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return MockDBRow(locked_by=OTHER_SF_USER_ID)  # Locked by someone else
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)

        resp = rm_client.put(
            f"/api/salesforce/opportunities/{OPP_ID}",
            json={"opportunity_id": OPP_ID, "updates": {"Amount": 99999}, "user_id": "test"},
        )
        assert resp.status_code == 403
        assert "locked" in resp.json()["detail"].lower()

    def test_owner_can_still_edit_own_locked_opportunity(self, rm_client, mock_db):
        """Owner who locked it should still be able to edit."""
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return MockDBRow(locked_by=SF_USER_ID)  # Locked by THIS user
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)

        resp = rm_client.put(
            f"/api/salesforce/opportunities/{OPP_ID}",
            json={"opportunity_id": OPP_ID, "updates": {"Amount": 50000}, "user_id": "test"},
        )
        # Should succeed (200) or hit SF mock (500), but NOT 403
        assert resp.status_code != 403


# ===========================================================================
# LOCK SPOOFING: Non-owner tries to lock someone else's opportunity
# ===========================================================================


class TestLockSpoofing:
    """Only the actual owner should be able to lock their opportunity."""

    def test_cannot_lock_others_opportunity(self, rm_client, mock_db):
        """POST /api/opportunities/{id}/lock with wrong owner_id → 403."""
        mock_db.fetchrow = AsyncMock(return_value=rm_row())
        resp = rm_client.post(
            f"/api/opportunities/{OPP_ID}/lock",
            json={"owner_id": OTHER_SF_USER_ID},  # Not this user's SF ID
        )
        assert resp.status_code == 403
        assert "only lock opportunities you own" in resp.json()["detail"]

    def test_can_lock_own_opportunity(self, rm_client, mock_db):
        """POST /api/opportunities/{id}/lock with matching owner_id → success."""
        mock_db.fetchrow = AsyncMock(side_effect=[
            rm_row(),  # Permission check
            MockDBRow(sf_opportunity_id=OPP_ID, locked_by=SF_USER_ID, locked_at="2026-01-01"),
        ])
        resp = rm_client.post(
            f"/api/opportunities/{OPP_ID}/lock",
            json={"owner_id": SF_USER_ID},
        )
        assert resp.status_code == 200

    def test_cannot_unlock_others_lock(self, rm_client, mock_db):
        """DELETE /api/opportunities/{id}/lock — non-owner non-admin gets 403."""
        mock_db.fetchrow = AsyncMock(side_effect=[
            rm_row(),  # Permission check
            MockDBRow(sf_opportunity_id=OPP_ID, locked_by=OTHER_SF_USER_ID, locked_at="2026-01-01"),
        ])
        resp = rm_client.delete(f"/api/opportunities/{OPP_ID}/lock")
        assert resp.status_code == 403


# ===========================================================================
# PERMISSION BOUNDARIES: RM blocked from restricted actions
# ===========================================================================


class TestPermissionBoundaries:
    """RM must be blocked from actions their profile doesn't allow."""

    def test_blocked_from_sync_trigger(self, rm_client):
        resp = rm_client.post("/api/sync/trigger")
        assert resp.status_code == 403

    def test_blocked_from_invoice_matching(self, rm_client):
        resp = rm_client.post("/api/matching/save-match", json={
            "invoice_id": "INV-001", "opportunity_id": OPP_ID,
            "confidence": "high", "notes": "", "customer_name": "Test",
            "invoice_amount": 1000, "invoice_date": "2026-01-01",
        })
        assert resp.status_code == 403

    def test_blocked_from_deleting_match(self, rm_client):
        resp = rm_client.delete("/api/matching/delete-match/INV-001")
        assert resp.status_code == 403

    def test_blocked_from_sage_invoice_creation(self, rm_client):
        resp = rm_client.post("/api/intacct/invoices", json={
            "opportunity_id": OPP_ID, "customer_id": "CUST001",
            "items": [{"description": "Grant", "amount": 1000}],
        })
        assert resp.status_code == 403

    def test_blocked_from_bulk_update(self, rm_client):
        """bulk_update_opportunities is false for RM."""
        # The bulk update endpoint in main.py doesn't use check_permission directly
        # (it's in Opportunities.tsx frontend), but the API should still check
        # This test documents the expected behavior
        pass  # Bulk update uses frontend gating — backend hardening is a follow-up

    def test_allowed_to_edit_own_tasks(self, rm_client, mock_db, mock_client):
        """An owned, unlocked task remains editable with edit_own_tasks."""
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return None
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
        mock_client.salesforce.query.return_value = {
            "records": [{"OwnerId": SF_USER_ID, "WhatId": None, "Subject": "Updated task"}]
        }
        resp = rm_client.put(
            f"/api/salesforce/tasks/00T000000000001AAA",
            json={"Subject": "Updated task"},
        )
        assert resp.status_code == 200
        mock_client.salesforce.update_record.assert_awaited_once()

    def test_allowed_to_create_opportunities(self, rm_client):
        """create_opportunities is true for RM."""
        resp = rm_client.post("/api/salesforce/accounts", json={"Name": "Test Org"})
        # Should pass permission check (200 or 500 from SF mock, NOT 403)
        assert resp.status_code != 403


# ===========================================================================
# INVALID INPUTS: Malformed requests
# ===========================================================================


class TestInvalidInputs:
    def test_lock_with_invalid_opportunity_id(self, rm_client):
        resp = rm_client.post("/api/opportunities/bad-id/lock", json={"owner_id": SF_USER_ID})
        assert resp.status_code == 400

    def test_lock_without_owner_id_body(self, rm_client):
        resp = rm_client.post(f"/api/opportunities/{OPP_ID}/lock", json={})
        assert resp.status_code == 422  # Pydantic validation error

    def test_unlock_with_invalid_opportunity_id(self, rm_client):
        resp = rm_client.delete("/api/opportunities/bad-id/lock")
        assert resp.status_code == 400

    def test_profile_create_empty_name(self, rm_client):
        """Even if they could reach this endpoint, empty name should fail."""
        # RM gets 403 before validation — that's correct too
        resp = rm_client.post("/api/permissions/profiles", json={"name": "", "permissions": {}})
        assert resp.status_code in (403, 422)


# ===========================================================================
# TASK LOCK VECTORS: resolve_task_lock enforcement
# ===========================================================================


TASK_ID = "00T000000000001AAA"


class TestTaskLockVectors:
    """Tests for all critical lock bypass vectors (V1, V7, V8, V10)."""

    def _mock_sf_task(self, mock_client, what_id=OPP_ID, owner_id=SF_USER_ID):
        """Mock SF to return a task with given WhatId and OwnerId."""
        mock_client.salesforce.query = AsyncMock(return_value={"records": [{
            "WhatId": what_id, "OwnerId": owner_id,
        }]})

    def _mock_locked(self, mock_db, locked_by=OTHER_SF_USER_ID):
        """Mock DB to return locked opportunity + RM user for permission checks."""
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return MockDBRow(locked_by=locked_by)
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)

    def _mock_unlocked(self, mock_db):
        """Mock DB to return unlocked opportunity."""
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return None
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)

    # V1: WhatId omission bypass
    def test_update_no_whatid_still_checks_lock(self, rm_client, mock_client, mock_db):
        """V1: Sending update with NO WhatId should still check the task's actual opp lock."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=OTHER_SF_USER_ID)
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        resp = rm_client.put(
            f"/api/salesforce/tasks/{TASK_ID}",
            json={"Status": "Completed"},  # No WhatId sent
        )
        assert resp.status_code == 403

    # V10: Quick-toggle bypass
    def test_quick_toggle_blocked_for_non_owner_on_locked(self, rm_client, mock_client, mock_db):
        """V10: Quick status toggle (no WhatId) blocked for non-task-owner on locked opp."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=OTHER_SF_USER_ID)
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        resp = rm_client.put(
            f"/api/salesforce/tasks/{TASK_ID}",
            json={"Status": "Completed"},
        )
        assert resp.status_code == 403

    def test_quick_toggle_allowed_for_task_owner_on_locked(self, rm_client, mock_client, mock_db):
        """Task owner CAN toggle status on a locked opportunity."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=SF_USER_ID)  # user IS task owner
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        mock_client.salesforce.update_record = AsyncMock(return_value=True)
        resp = rm_client.put(
            f"/api/salesforce/tasks/{TASK_ID}",
            json={"Status": "Completed"},
        )
        assert resp.status_code == 200

    # V1: WhatId change by task owner blocked
    def test_task_owner_cannot_change_whatid_on_locked(self, rm_client, mock_client, mock_db):
        """Task owner cannot move task to a different opportunity when locked."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=SF_USER_ID)
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        resp = rm_client.put(
            f"/api/salesforce/tasks/{TASK_ID}",
            json={"Subject": "Updated", "WhatId": "006DIFFERENTOPP01"},  # Trying to move task
        )
        assert resp.status_code == 403
        assert "Cannot move task" in resp.json()["detail"]

    # V7: Delete blocked on locked opp
    def test_delete_blocked_on_locked_opp(self, rm_client, mock_client, mock_db):
        """V7: Non-owner/non-admin cannot delete task from locked opportunity."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=SF_USER_ID)
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        resp = rm_client.delete(f"/api/salesforce/tasks/{TASK_ID}")
        assert resp.status_code == 403
        assert "locked" in resp.json()["detail"].lower()

    # V7: Task owner also cannot delete
    def test_task_owner_cannot_delete_from_locked_opp(self, rm_client, mock_client, mock_db):
        """Task owner should NOT be able to delete tasks from locked opportunities."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=SF_USER_ID)
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        resp = rm_client.delete(f"/api/salesforce/tasks/{TASK_ID}")
        assert resp.status_code == 403

    # V8: Duplicate from locked opp blocked
    def test_duplicate_from_locked_opp_blocked(self, rm_client, mock_client, mock_db):
        """V8: Cannot duplicate a task from a locked opportunity."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=OTHER_SF_USER_ID)
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        resp = rm_client.post(
            f"/api/salesforce/tasks/{TASK_ID}/duplicate",
            json={},
        )
        assert resp.status_code == 403

    # Task owner can update description on locked opp
    def test_task_owner_can_update_description_on_locked(self, rm_client, mock_client, mock_db):
        """Task owner can add notes/description to their task on a locked opportunity."""
        self._mock_sf_task(mock_client, what_id=OPP_ID, owner_id=SF_USER_ID)
        self._mock_locked(mock_db, locked_by=OTHER_SF_USER_ID)
        mock_client.salesforce.update_record = AsyncMock(return_value=True)
        resp = rm_client.put(
            f"/api/salesforce/tasks/{TASK_ID}",
            json={"Description": "Added progress notes"},
        )
        assert resp.status_code == 200

    # SF unavailable → fail closed
    def test_sf_unavailable_fails_closed(self, rm_client, mock_client, mock_db):
        """If Salesforce is down during lock check, return 503 (not allow)."""
        mock_client.salesforce.query = AsyncMock(side_effect=Exception("Connection refused"))
        self._mock_unlocked(mock_db)
        resp = rm_client.put(
            f"/api/salesforce/tasks/{TASK_ID}",
            json={"Status": "Completed"},
        )
        assert resp.status_code == 503


# ===========================================================================
# OWNERSHIP ENFORCEMENT: edit_own only edits your own opportunities
# ===========================================================================


class TestOwnershipEnforcement:
    """RM with edit_own_opportunities can only edit opportunities they own."""

    def test_rm_blocked_from_editing_others_opp(self, rm_client, mock_client, mock_db):
        """RM without edit_all cannot edit another user's opportunity."""
        # Mock: no lock, ownership query returns OTHER user as owner
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return None
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
        mock_client.salesforce.query = AsyncMock(return_value={
            "records": [{"OwnerId": OTHER_SF_USER_ID}]
        })

        resp = rm_client.put(
            f"/api/salesforce/opportunities/{OPP_ID}",
            json={"opportunity_id": OPP_ID, "updates": {"Amount": 50000}, "user_id": "test"},
        )
        assert resp.status_code == 403
        assert "only edit opportunities you own" in resp.json()["detail"]

    def test_rm_can_edit_own_opp(self, rm_client, mock_client, mock_db):
        """RM can edit an opportunity they own."""
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return None
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
        # Ownership query returns THIS user as owner
        mock_client.salesforce.query = AsyncMock(return_value={
            "records": [{"OwnerId": SF_USER_ID}]
        })
        mock_client.salesforce.update_record = AsyncMock(return_value=True)

        resp = rm_client.put(
            f"/api/salesforce/opportunities/{OPP_ID}",
            json={"opportunity_id": OPP_ID, "updates": {"Amount": 50000}, "user_id": "test"},
        )
        assert resp.status_code == 200


# ===========================================================================
# REASSIGNMENT: OwnerId changes require reassign_opportunities permission
# ===========================================================================


class TestReassignmentPermission:
    """OwnerId changes are gated by the reassign_opportunities permission."""

    def test_rm_blocked_from_reassign(self, rm_client, mock_client, mock_db):
        """RM (reassign_opportunities=False) cannot change OwnerId."""
        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return None
            return rm_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
        mock_client.salesforce.query = AsyncMock(return_value={
            "records": [{"OwnerId": SF_USER_ID}]
        })

        resp = rm_client.put(
            f"/api/salesforce/opportunities/{OPP_ID}",
            json={"opportunity_id": OPP_ID, "updates": {"OwnerId": OTHER_SF_USER_ID}, "user_id": "test"},
        )
        assert resp.status_code == 403
        assert "reassign" in resp.json()["detail"].lower()

    def test_user_with_reassign_can_change_owner(self, rm_client, mock_client, mock_db):
        """A user with reassign_opportunities=True can change OwnerId."""
        reassign_perms = json.dumps({
            **json.loads(RM_PERMS), "reassign_opportunities": True,
        })

        def reassign_row():
            return MockDBRow(
                id=USER_ID, sf_user_id=SF_USER_ID, email="rm@pursuit.org",
                name="Relationship Manager", is_active=True, permissions=reassign_perms,
                profile_name="Relationship Manager", profile_id=RM_PROFILE_ID,
            )

        async def smart_fetchrow(query, *args):
            if "opportunity_lock" in query:
                return None
            return reassign_row()
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
        mock_client.salesforce.query = AsyncMock(return_value={
            "records": [{"OwnerId": SF_USER_ID}]
        })
        mock_client.salesforce.update_record = AsyncMock(return_value=True)

        resp = rm_client.put(
            f"/api/salesforce/opportunities/{OPP_ID}",
            json={"opportunity_id": OPP_ID, "updates": {"OwnerId": OTHER_SF_USER_ID}, "user_id": "test"},
        )
        assert resp.status_code == 200
