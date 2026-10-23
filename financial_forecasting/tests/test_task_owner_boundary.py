"""Exercise real task routes with distinct trusted owners and desired update fields."""
from unittest.mock import AsyncMock

import pytest

from tests.test_permissions_adversarial import (
    app, rm_client, mock_client, mock_db, rm_row, MockDBRow, SF_USER_ID,
    OTHER_SF_USER_ID, TASK_ID,
)


@pytest.fixture(autouse=True)
def task_state(mock_db, mock_client):
    async def rows(sql, *args):
        return None if "opportunity_lock" in sql else rm_row()
    mock_db.fetchrow.side_effect = rows
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": SF_USER_ID, "WhatId": None}]}


def mutate(client, method, body=None):
    if method == "put":
        return client.put(f"/api/salesforce/tasks/{TASK_ID}", json=body or {"Subject": "Updated"})
    return client.delete(f"/api/salesforce/tasks/{TASK_ID}")


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("parent", [None, "001000000000001AAA", "006000000000001AAA"])
def test_foreign_unlocked_task_denied(rm_client, mock_client, method, parent):
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": OTHER_SF_USER_ID, "WhatId": parent}]}
    response = mutate(rm_client, method, {"OwnerId": SF_USER_ID, "Subject": "Spoof"})
    assert response.status_code == 403
    mock_client.salesforce.update_record.assert_not_awaited()
    mock_client.salesforce.delete_record.assert_not_awaited()


@pytest.mark.parametrize("method", ["put", "delete"])
def test_owner_mutation_succeeds(rm_client, mock_client, method):
    assert mutate(rm_client, method).status_code == 200
    getattr(mock_client.salesforce, "update_record" if method == "put" else "delete_record").assert_awaited()


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("permission", ["edit_all_tasks", "manage_users_roles"])
def test_unlocked_authorized_bypass(rm_client, mock_client, mock_db, method, permission):
    row = rm_row()
    row["permissions"] = {"edit_own_tasks": True, permission: True}
    mock_db.fetchrow.side_effect = lambda sql, *args: None if "opportunity_lock" in sql else row
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": OTHER_SF_USER_ID, "WhatId": None}]}
    assert mutate(rm_client, method).status_code == 200


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("case, expected", [("missing_task", 404), ("missing_owner", 403), ("missing_mapping", 403), ("provider_failure", 503)])
def test_incomplete_authority_fails_closed(rm_client, mock_client, mock_db, method, case, expected):
    if case == "missing_task":
        mock_client.salesforce.query.return_value = {"records": []}
    elif case == "missing_owner":
        mock_client.salesforce.query.return_value = {"records": [{"WhatId": None}]}
    elif case == "missing_mapping":
        row = rm_row()
        row["sf_user_id"] = None
        mock_db.fetchrow.side_effect = lambda sql, *args: row
    else:
        mock_client.salesforce.query.side_effect = RuntimeError("synthetic unavailable")
    assert mutate(rm_client, method).status_code == expected
    mock_client.salesforce.update_record.assert_not_awaited()
    mock_client.salesforce.delete_record.assert_not_awaited()


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("role, expected", [("lock_holder", 200), ("admin", 200), ("edit_all", 403)])
def test_locked_exceptions_preserved(rm_client, mock_client, mock_db, method, role, expected):
    row = rm_row()
    row["permissions"] = {"edit_own_tasks": True, "edit_all_tasks": role == "edit_all", "manage_users_roles": role == "admin"}
    lock = MockDBRow(locked_by=SF_USER_ID if role == "lock_holder" else OTHER_SF_USER_ID)
    mock_db.fetchrow.side_effect = lambda sql, *args: lock if "opportunity_lock" in sql else row
    mock_client.salesforce.query.return_value = {"records": [{"OwnerId": OTHER_SF_USER_ID, "WhatId": "006000000000001AAA"}]}
    assert mutate(rm_client, method).status_code == expected


def test_empty_update_still_rejected(rm_client, mock_client):
    assert rm_client.put(f"/api/salesforce/tasks/{TASK_ID}", json={}).status_code == 400
    mock_client.salesforce.update_record.assert_not_awaited()
