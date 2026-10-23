"""Lock authority comes from Salesforce, never the caller's owner assertion."""
from unittest.mock import AsyncMock

import pytest

from tests.test_permissions_adversarial import (
    app, rm_client, mock_client, mock_db, rm_row, MockDBRow, SF_USER_ID, OTHER_SF_USER_ID,
)
from dependencies import require_sf_mcp_client

OPPORTUNITY = "006000000000001AAA"


@pytest.fixture(autouse=True)
def lock_state(mock_db, mock_client):
    async def rows(sql, *args):
        if "INSERT INTO bedrock.opportunity_lock" in sql:
            return MockDBRow(sf_opportunity_id=args[0], locked_by=args[1])
        if "opportunity_lock" in sql:
            return MockDBRow(locked_by=OTHER_SF_USER_ID)
        return rm_row()
    mock_db.fetchrow.side_effect = rows
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": SF_USER_ID}]}


def lock(client, owner=SF_USER_ID):
    return client.post(f"/api/opportunities/{OPPORTUNITY}/lock", json={"owner_id": owner})


def assert_no_insert(mock_db):
    assert not any("INSERT INTO bedrock.opportunity_lock" in call.args[0] for call in mock_db.fetchrow.await_args_list)


@pytest.mark.parametrize("body_owner", [SF_USER_ID, OTHER_SF_USER_ID, "untrusted-display-value"])
def test_foreign_owner_denied_independent_of_body(rm_client, mock_client, mock_db, body_owner):
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": OTHER_SF_USER_ID}]}
    assert lock(rm_client, body_owner).status_code == 403
    assert_no_insert(mock_db)


@pytest.mark.parametrize("body_owner", [SF_USER_ID, OTHER_SF_USER_ID])
def test_actual_owner_succeeds_with_legacy_body(rm_client, mock_client, body_owner):
    response = lock(rm_client, body_owner)
    assert response.status_code == 200
    assert response.json()["data"]["locked_by"] == SF_USER_ID
    assert "SELECT OwnerId FROM Opportunity" in mock_client.salesforce.query.await_args.args[0]


@pytest.mark.parametrize("case, expected", [("missing", 404), ("missing_owner", 503), ("unavailable", 503), ("unmapped", 400), ("permission", 403)])
def test_incomplete_authority_cannot_insert(rm_client, mock_client, mock_db, case, expected):
    if case == "missing":
        mock_client.salesforce.query.return_value = {"records": []}
    elif case == "missing_owner":
        mock_client.salesforce.query.return_value = {"records": [{}]}
    elif case == "unavailable":
        mock_client.salesforce.query.side_effect = RuntimeError("synthetic provider failure")
    else:
        row = rm_row()
        if case == "unmapped":
            row["sf_user_id"] = None
        else:
            row["permissions"] = {}
        mock_db.fetchrow.side_effect = lambda *args: row
    assert lock(rm_client).status_code == expected
    assert_no_insert(mock_db)


def test_admin_cannot_lock_a_foreign_record(rm_client, mock_client, mock_db):
    row = rm_row()
    row["permissions"] = {"lock_own_opportunities": True, "manage_users_roles": True, "edit_all_opportunities": True}
    mock_db.fetchrow.side_effect = lambda *args: row
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": OTHER_SF_USER_ID}]}
    assert lock(rm_client).status_code == 403
    assert_no_insert(mock_db)


def test_existing_lock_not_replaced(rm_client, mock_db):
    mock_db.fetchrow.side_effect = lambda sql, *args: None if "INSERT INTO" in sql else rm_row()
    response = lock(rm_client)
    assert response.status_code == 200
    assert response.json()["message"] == "Opportunity is already locked"
    assert "ON CONFLICT (sf_opportunity_id) DO NOTHING" in mock_db.fetchrow.await_args.args[0]


def test_lock_requires_personal_salesforce_session(rm_client, mock_db):
    app.dependency_overrides.pop(require_sf_mcp_client, None)
    assert lock(rm_client).status_code == 401
    assert_no_insert(mock_db)


def test_admin_can_recover_without_salesforce(rm_client, mock_db, mock_client):
    row = rm_row()
    row["permissions"] = {"manage_users_roles": True}
    mock_db.fetchrow.side_effect = lambda sql, *args: MockDBRow(locked_by=OTHER_SF_USER_ID) if "opportunity_lock" in sql else row
    app.dependency_overrides.pop(require_sf_mcp_client, None)
    assert rm_client.delete(f"/api/opportunities/{OPPORTUNITY}/lock").status_code == 200
    mock_db.execute.assert_awaited_once()
    mock_client.salesforce.query.assert_not_awaited()


def test_invalid_target_never_queries_provider(rm_client, mock_client, mock_db):
    assert rm_client.post("/api/opportunities/invalid/lock", json={"owner_id": SF_USER_ID}).status_code == 400
    mock_client.salesforce.query.assert_not_awaited()
    assert_no_insert(mock_db)
