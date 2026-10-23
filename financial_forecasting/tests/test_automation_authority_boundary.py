"""Queue creation cannot turn approval into shared Salesforce authority."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from auth import require_auth
from db import get_db
from dependencies import get_mcp_client, require_sf_mcp_client
from routes import ai

OPP = "006000000000001AAA"
OWN = "005000000000001AAA"
OTHER = "005000000000002AAA"


@pytest.fixture
def automation(monkeypatch):
    monkeypatch.setattr(ai, "_automation_queue", {})
    row = {"id": "synthetic", "sf_user_id": OWN, "profile_id": 1, "profile_name": "Restricted", "permissions": {"edit_own_opportunities": True, "create_tasks": True}}
    conn = AsyncMock()
    conn.fetchrow.side_effect = lambda sql, *args: None if "opportunity_lock" in sql else row
    sf = AsyncMock()
    sf.query.return_value = {"records": [{"OwnerId": OWN, "Description": "Existing"}]}
    sf.update_record.return_value = True
    sf.create_record.return_value = {"id": "00T000000000001AAA", "success": True}
    provider = SimpleNamespace(salesforce=sf)
    user = {"email": "actor@pursuit.org", "user_id": "actor@pursuit.org"}
    app = FastAPI()
    app.include_router(ai.router)
    app.dependency_overrides[require_auth] = lambda: user
    app.dependency_overrides[get_db] = lambda: conn
    app.dependency_overrides[get_mcp_client] = lambda: provider
    app.dependency_overrides[require_sf_mcp_client] = lambda: provider
    with TestClient(app) as client:
        seed = client.post("/api/slack/webhook", json={"text": "Fixture update.", "user_name": "Untrusted display"})
        assert seed.status_code == 200
        item_id = seed.json()["data"]["id"]
        yield SimpleNamespace(client=client, app=app, db=conn, sf=sf, row=row, id=item_id, original=deepcopy(ai._automation_queue[item_id]["parsed"]))


def approve(a, action="stage_change", **edits):
    return a.client.post(f"/api/automation-review/{a.id}/approve", json={"action": action, "matched_opportunity": OPP, "stage": "Qualifying", "detail": "Fixture detail", **edits})


def assert_pending_unchanged(a):
    assert ai._automation_queue[a.id]["status"] == "pending"
    assert ai._automation_queue[a.id]["parsed"] == a.original
    assert "approved_by" not in ai._automation_queue[a.id]


def test_missing_personal_salesforce_cannot_approve(automation):
    a = automation
    a.app.dependency_overrides.pop(require_sf_mcp_client)
    assert approve(a).status_code == 401
    a.sf.update_record.assert_not_awaited()
    assert_pending_unchanged(a)


@pytest.mark.parametrize("action", ["stage_change", "note", "task"])
def test_action_requires_its_permission(automation, action):
    a = automation
    a.row["permissions"] = {}
    assert approve(a, action).status_code == 403
    a.sf.update_record.assert_not_awaited()
    a.sf.create_record.assert_not_awaited()
    assert_pending_unchanged(a)


@pytest.mark.parametrize("action", ["stage_change", "note"])
@pytest.mark.parametrize("case, status", [("foreign", 403), ("missing_mapping", 403), ("missing", 404), ("lookup_failure", 503), ("lock", 403)])
def test_final_target_owner_and_lock_authority(automation, action, case, status):
    a = automation
    if case == "foreign": a.sf.query.return_value = {"records": [{"OwnerId": OTHER, "Description": "Secret"}]}
    elif case == "missing_mapping": a.row["sf_user_id"] = None
    elif case == "missing": a.sf.query.return_value = {"records": []}
    elif case == "lookup_failure": a.sf.query.side_effect = RuntimeError("synthetic unavailable")
    else: a.db.fetchrow.side_effect = lambda sql, *args: {"locked_by": OTHER} if "opportunity_lock" in sql else a.row
    assert approve(a, action).status_code == status
    a.sf.update_record.assert_not_awaited()
    assert_pending_unchanged(a)


@pytest.mark.parametrize("action", ["stage_change", "note", "task"])
def test_legitimate_approval_keeps_actor_and_final_fields(automation, action):
    a = automation
    response = approve(a, action, amount=0, close_date="2026-12-31", confidence=0.8)
    assert response.status_code == 200
    assert response.json()["data"]["approved_by"] == "actor@pursuit.org"
    assert response.json()["data"]["parsed"]["matched_opportunity"] == OPP
    if action == "task": a.sf.create_record.assert_awaited_once()
    elif action == "stage_change":
        a.sf.update_record.assert_awaited_once_with("Opportunity", OPP, {"StageName": "Qualifying", "Amount": 0, "CloseDate": "2026-12-31"})
    else:
        assert a.sf.update_record.await_args.args[2]["Description"].startswith("Existing\n[")


@pytest.mark.parametrize("action", ["stage_change", "note", "task"])
def test_false_provider_result_does_not_approve(automation, action):
    a = automation
    a.sf.update_record.return_value = False
    a.sf.create_record.return_value = {"success": False}
    assert approve(a, action).status_code == 502
    assert_pending_unchanged(a)


def test_locked_task_is_explicit_failure(automation):
    a = automation
    a.db.fetchrow.side_effect = lambda sql, *args: {"locked_by": OWN} if "opportunity_lock" in sql else a.row
    assert approve(a, "task").status_code == 403
    a.sf.create_record.assert_not_awaited()
    assert_pending_unchanged(a)


@pytest.mark.parametrize("action", ["stage_change", "note"])
@pytest.mark.parametrize("access", ["own_lock", "admin", "edit_all", "edit_all_locked"])
def test_explicit_authority_exceptions(automation, action, access):
    a = automation
    lock = {"locked_by": OWN if access == "own_lock" else OTHER} if access != "edit_all" else None
    a.db.fetchrow.side_effect = lambda sql, *args: lock if "opportunity_lock" in sql else a.row
    if access != "own_lock":
        a.sf.query.return_value = {"records": [{"OwnerId": OTHER, "Description": "Existing"}]}
        a.row["permissions"]["manage_users_roles" if access == "admin" else "edit_all_opportunities"] = True
    response = approve(a, action)
    assert response.status_code == (403 if access == "edit_all_locked" else 200)
    if access == "edit_all_locked":
        a.sf.update_record.assert_not_awaited()
        assert_pending_unchanged(a)
    else:
        a.sf.update_record.assert_awaited_once()


@pytest.mark.parametrize("case,status", [("missing", 404), ("lookup_failure", 503)])
def test_task_parent_must_be_visible(automation, case, status):
    a = automation
    if case == "missing": a.sf.query.return_value = {"records": []}
    else: a.sf.query.side_effect = RuntimeError("synthetic unavailable")
    assert approve(a, "task").status_code == status
    a.sf.create_record.assert_not_awaited()
    assert_pending_unchanged(a)


@pytest.mark.parametrize("action", ["stage_change", "note", "task"])
def test_provider_exception_keeps_pending_original(automation, action):
    a = automation
    a.sf.update_record.side_effect = RuntimeError("synthetic unavailable")
    a.sf.create_record.side_effect = RuntimeError("synthetic unavailable")
    assert approve(a, action).status_code >= 400
    assert_pending_unchanged(a)


@pytest.mark.parametrize("edits", [{"action": "unsupported"}, {"matched_opportunity": None}, {"stage": ""}, {"amount": {"bad": 1}}, {"close_date": "bad"}, {"OwnerId": OTHER}, {"detail": ["bad"]}])
def test_invalid_edits_never_mutate_queue_or_provider(automation, edits):
    a = automation
    assert approve(a, **edits).status_code == 400
    a.sf.update_record.assert_not_awaited()
    a.sf.create_record.assert_not_awaited()
    assert_pending_unchanged(a)


@pytest.mark.asyncio
async def test_concurrent_approvals_dispatch_once(automation):
    a = automation
    started, finish = asyncio.Event(), asyncio.Event()
    async def update(*args):
        started.set()
        await finish.wait()
        return True
    a.sf.update_record.side_effect = update
    payload = {"action": "stage_change", "matched_opportunity": OPP, "stage": "Qualifying"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a.app), base_url="http://fixture.invalid") as client:
        first = asyncio.create_task(client.post(f"/api/automation-review/{a.id}/approve", json=payload))
        await asyncio.wait_for(started.wait(), 2)
        second = asyncio.create_task(client.post(f"/api/automation-review/{a.id}/approve", json=payload))
        try:
            # The duplicate must fail while the first provider request is still blocked.
            duplicate = await asyncio.wait_for(asyncio.shield(second), 2)
            assert duplicate.status_code == 400
        finally:
            finish.set()
        responses = await asyncio.gather(first, second)
    assert sorted(r.status_code for r in responses) == [200, 400]
    a.sf.update_record.assert_awaited_once()
