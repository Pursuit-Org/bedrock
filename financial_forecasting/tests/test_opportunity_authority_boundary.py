"""The same opportunity authority applies to direct, stage and bulk writes."""
from unittest.mock import AsyncMock
import pytest
from tests.test_permissions_adversarial import rm_client, mock_client, mock_db, rm_row, MockDBRow, SF_USER_ID, OTHER_SF_USER_ID
from routes import opportunities_extra
from auth import require_auth_or_internal
from main import app

OPP = "006000000000001AAA"
OTHER = "006000000000002AAA"


@pytest.fixture(autouse=True)
def state(mock_db, mock_client, monkeypatch):
    app.dependency_overrides[require_auth_or_internal] = lambda: {"email": "rm@pursuit.org", "user_id": "test_user"}
    async def rows(sql, *args):
        return None if "opportunity_lock" in sql else rm_row()
    mock_db.fetchrow.side_effect = rows
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": SF_USER_ID, "Amount": 100}]}
    monkeypatch.setattr(opportunities_extra, "ensure_award_for_opp", AsyncMock(return_value={"id": "synthetic-award"}))


def mutate(client, route, updates=None):
    if route == "delete":
        return client.delete(f"/api/salesforce/opportunities/{OPP}")
    if route == "put":
        return client.put(f"/api/salesforce/opportunities/{OPP}", json={"opportunity_id": OPP, "updates": updates or {"Amount": 5}, "user_id": "display"})
    return client.post("/api/opportunities/update-stage", json={"opportunity_id": OPP, "new_stage": "Qualifying"})


@pytest.mark.parametrize("route", ["put", "stage", "delete"])
@pytest.mark.parametrize("case, status", [("foreign", 403), ("unmapped", 403), ("missing", 404), ("lookup_failure", 503), ("locked", 403)])
def test_denied_before_mutation(rm_client, mock_db, mock_client, route, case, status):
    row = rm_row()
    lock = None
    if case == "unmapped": row["sf_user_id"] = None
    elif case == "foreign": mock_client.salesforce.query.return_value = {"records": [{"OwnerId": OTHER_SF_USER_ID}]}
    elif case == "missing": mock_client.salesforce.query.return_value = {"records": []}
    elif case == "lookup_failure": mock_client.salesforce.query.side_effect = RuntimeError("synthetic unavailable")
    elif case == "locked": lock = MockDBRow(locked_by=OTHER_SF_USER_ID)
    mock_db.fetchrow.side_effect = lambda sql, *args: lock if "opportunity_lock" in sql else row
    assert mutate(rm_client, route).status_code == status
    mock_client.salesforce.update_record.assert_not_awaited()
    mock_client.salesforce.delete_record.assert_not_awaited()
    opportunities_extra.ensure_award_for_opp.assert_not_awaited()


@pytest.mark.parametrize("route", ["put", "stage", "delete"])
@pytest.mark.parametrize("access", ["owner", "own_lock", "admin", "edit_all"])
def test_legitimate_writes(rm_client, mock_db, mock_client, route, access):
    row = rm_row()
    row["permissions"] = {"edit_own_opportunities": True, "manage_users_roles": access == "admin", "edit_all_opportunities": access == "edit_all"}
    lock = MockDBRow(locked_by=SF_USER_ID) if access == "own_lock" else None
    if access == "admin": lock = MockDBRow(locked_by=OTHER_SF_USER_ID)
    if access in ("admin", "edit_all"):
        mock_client.salesforce.query.return_value = {"records": [{"OwnerId": OTHER_SF_USER_ID}]}
    mock_db.fetchrow.side_effect = lambda sql, *args: lock if "opportunity_lock" in sql else row
    response = mutate(rm_client, route)
    assert response.status_code == 200
    if route == "delete": mock_client.salesforce.delete_record.assert_awaited_once()
    else: mock_client.salesforce.update_record.assert_awaited_once()
    if route == "stage":
        assert response.json()["award_created"] is True


@pytest.mark.parametrize("route", ["put", "stage", "delete"])
def test_edit_all_does_not_override_lock(rm_client, mock_db, route):
    row = rm_row()
    row["permissions"] = {"edit_own_opportunities": True, "edit_all_opportunities": True}
    mock_db.fetchrow.side_effect = lambda sql, *args: MockDBRow(locked_by=OTHER_SF_USER_ID) if "opportunity_lock" in sql else row
    assert mutate(rm_client, route).status_code == 403


def test_internal_delete_preserves_explicit_service_contract(rm_client, mock_db, mock_client):
    app.dependency_overrides[require_auth_or_internal] = lambda: {"is_service": True, "user_id": "service:pebble", "email": "pebble@internal"}
    mock_db.fetchrow.side_effect = RuntimeError("must not resolve human scope")
    assert mutate(rm_client, "delete").status_code == 200
    mock_db.fetchrow.assert_not_awaited()
    mock_client.salesforce.query.assert_not_awaited()
    mock_client.salesforce.delete_record.assert_awaited_once()


@pytest.mark.parametrize("owner_key", ["OwnerId", "ownerid", "OWNERID"])
def test_reassignment_still_separate(rm_client, mock_db, mock_client, owner_key):
    row = rm_row()
    row["permissions"] = {"edit_own_opportunities": True, "edit_all_opportunities": True}
    mock_db.fetchrow.side_effect = lambda sql, *args: None if "opportunity_lock" in sql else row
    assert mutate(rm_client, "put", {owner_key: OTHER_SF_USER_ID}).status_code == 403
    row["permissions"]["reassign_opportunities"] = True
    assert mutate(rm_client, "put", {owner_key: OTHER_SF_USER_ID}).status_code == 200


def test_collecting_stage_payment_validation_preserved(rm_client, mock_client):
    response = rm_client.post("/api/opportunities/update-stage", json={"opportunity_id": OPP, "new_stage": "Collecting / In Effect"})
    assert response.status_code == 400
    mock_client.salesforce.update_record.assert_not_awaited()


def test_stage_false_provider_result_not_success(rm_client, mock_client):
    mock_client.salesforce.update_record.return_value = False
    assert mutate(rm_client, "stage").status_code == 502
    opportunities_extra.ensure_award_for_opp.assert_not_awaited()


def test_bulk_owns_each_target_and_reports_partial_results(rm_client, mock_db, mock_client):
    row = rm_row()
    # Preserve bulk as its own operation capability, with per-record scope.
    row["permissions"] = {"bulk_update_opportunities": True}
    mock_db.fetchrow.side_effect = lambda sql, *args: None if "opportunity_lock" in sql else row
    async def query(sql):
        return {"records": [{"OwnerId": SF_USER_ID if OPP in sql else OTHER_SF_USER_ID}]}
    mock_client.salesforce.query.side_effect = query
    response = rm_client.put("/api/salesforce/opportunities/bulk-update", json={"opportunity_ids": [OPP, OTHER], "updates": {"Amount": 5}})
    assert response.status_code == 200
    assert response.json() == {"success": True, "total": 2, "success_count": 1, "failed_count": 1, "failed_ids": [OTHER]}
    mock_client.salesforce.update_record.assert_awaited_once_with("Opportunity", OPP, {"Amount": 5})


@pytest.mark.parametrize("case", ["locked", "reassign", "reassign_case", "provider_false"])
def test_bulk_denials_are_not_counted_successful(rm_client, mock_db, mock_client, case):
    row = rm_row()
    row["permissions"] = {"bulk_update_opportunities": True, "edit_all_opportunities": True}
    lock = MockDBRow(locked_by=OTHER_SF_USER_ID) if case == "locked" else None
    mock_db.fetchrow.side_effect = lambda sql, *args: lock if "opportunity_lock" in sql else row
    if case == "provider_false": mock_client.salesforce.update_record.return_value = False
    updates = {"OwnerId": OTHER_SF_USER_ID} if case == "reassign" else {"ownerid": OTHER_SF_USER_ID} if case == "reassign_case" else {"Amount": 5}
    response = rm_client.put("/api/salesforce/opportunities/bulk-update", json={"opportunity_ids": [OPP], "updates": updates})
    assert response.status_code == 200
    assert response.json()["success_count"] == 0
    assert response.json()["failed_ids"] == [OPP]
    if case != "provider_false": mock_client.salesforce.update_record.assert_not_awaited()
