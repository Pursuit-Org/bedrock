"""Retained sessions and downstream grants must honor canonical deactivation."""
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import HTTPException
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

import auth
import db
from routes import auth as oauth_routes, permissions


def request(token=None, headers=None):
    values = dict(headers or {})
    if token:
        values["cookie"] = "access_token=" + token
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [(k.lower().encode(), v.encode()) for k, v in values.items()]})


@pytest.fixture
def identity(monkeypatch):
    conn = AsyncMock()
    conn.fetchrow.return_value = {"id": "synthetic-user", "name": "Admin", "is_active": True, "profile_id": 1, "profile_name": "Admin", "permissions": {"manage_users_roles": True}}
    conn.fetchval.return_value = 1
    pool = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(db, "_pool", pool)
    monkeypatch.setattr(oauth_routes, "_google_tokens", {})
    return conn


@pytest.mark.asyncio
async def test_retained_cookie_denied_on_next_request(identity):
    token = auth.create_access_token({"email": "Actor@pursuit.org", "sub": "synthetic"})
    assert (await auth.get_current_user(request(token)))["email"] == "Actor@pursuit.org"
    identity.fetchrow.return_value["is_active"] = False
    with pytest.raises(HTTPException) as error:
        await auth.get_current_user(request(token))
    assert error.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("email", [None, "", " ", 7, "unknown"])
async def test_malformed_signed_identity_rejected(identity, email):
    with pytest.raises(HTTPException) as error:
        await auth.get_current_user(request(auth.create_access_token({"email": email})))
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_anonymous_and_invalid_cookies_do_not_query(identity):
    assert await auth.get_current_user(request()) is None
    assert await auth.get_current_user(request("invalid")) is None
    identity.fetchrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_identity_store_failure_is_unavailable(identity):
    identity.fetchrow.side_effect = RuntimeError("synthetic store unavailable")
    with pytest.raises(HTTPException) as error:
        await auth.require_auth(request(auth.create_access_token({"email": "actor@pursuit.org"})))
    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_missing_pool_fails_closed(identity, monkeypatch):
    monkeypatch.setattr(db, "_pool", None)
    with pytest.raises(HTTPException) as error:
        await auth.require_auth(request(auth.create_access_token({"email": "actor@pursuit.org"})))
    assert error.value.status_code == 503


def test_former_admin_cannot_reactivate_self(identity):
    identity.fetchrow.return_value["is_active"] = False
    app = FastAPI()
    app.include_router(permissions.router)
    app.dependency_overrides[db.get_db] = lambda: identity
    with TestClient(app) as client:
        client.cookies.set("access_token", auth.create_access_token({"email": "actor@pursuit.org"}))
        response = client.put("/api/permissions/users/11111111-1111-1111-1111-111111111111", json={"is_active": True})
    assert response.status_code == 403
    identity.execute.assert_not_awaited()


def test_internal_permission_route_denies_inactive_subject(identity, monkeypatch):
    identity.fetchrow.return_value["is_active"] = False
    monkeypatch.setattr(auth, "_BEDROCK_INTERNAL_API_KEY", "synthetic-service-key")
    app = FastAPI()
    app.include_router(permissions.router)
    app.dependency_overrides[db.get_db] = lambda: identity
    with TestClient(app) as client:
        response = client.get("/api/permissions/internal/actor@pursuit.org", headers={"X-Internal-Key": "synthetic-service-key"})
    assert response.status_code == 403
    identity.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_service_identity_does_not_require_human_row(identity, monkeypatch):
    monkeypatch.setattr(auth, "_BEDROCK_INTERNAL_API_KEY", "synthetic-service-key")
    user = await auth.require_auth_or_internal(request(headers={"X-Internal-Key": "synthetic-service-key"}))
    assert user["is_service"] is True
    identity.fetchrow.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", [1, None])
async def test_inactive_resolver_never_grants_or_provisions(identity, profile):
    identity.fetchrow.return_value.update(is_active=False, profile_id=profile)
    with pytest.raises(HTTPException) as error:
        await permissions.get_user_permissions("actor@pursuit.org", identity)
    assert error.value.status_code == 403
    identity.execute.assert_not_awaited()
    identity.fetchval.assert_not_awaited()


@pytest.mark.asyncio
async def test_inactive_discovered_during_provisioning_denied(identity):
    inactive = dict(identity.fetchrow.return_value, is_active=False)
    identity.fetchrow.side_effect = [None, inactive, {"id": 1, "name": "Admin", "permissions": {"manage_users_roles": True}}]
    with pytest.raises(HTTPException) as error:
        await permissions.get_user_permissions("actor@pursuit.org", identity)
    assert error.value.status_code == 403
    identity.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_permissions_database_failure_is_not_bootstrap(identity):
    identity.fetchrow.side_effect = RuntimeError("synthetic schema unavailable")
    with pytest.raises(HTTPException) as error:
        await permissions.get_user_permissions("actor@pursuit.org", identity)
    assert error.value.status_code == 503
    identity.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_null_active_contract_keeps_permissions(identity):
    # The production query COALESCE(NULL, true) supplies True.
    identity.fetchrow.return_value["is_active"] = True
    result = await permissions.get_user_permissions("actor@pursuit.org", identity)
    assert result["permissions"]["manage_users_roles"] is True
    assert "COALESCE(ou.is_active, true)" in identity.fetchrow.await_args.args[0]


@pytest.mark.asyncio
async def test_first_login_still_provisions_default_profile(identity):
    created = {"id": "synthetic-user", "is_active": True, "email": "actor@pursuit.org"}
    profile = {"id": 2, "name": "Relationship Manager", "permissions": {"view_tasks": True}}
    identity.fetchrow.side_effect = [None, None, created, profile]
    result = await permissions.get_user_permissions("actor@pursuit.org", identity)
    assert result["permissions"] == {"view_tasks": True}
    assert result["profile_id"] == 2
    identity.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_oauth_first_login_can_create_identity(identity, monkeypatch):
    async def rows(sql, *args):
        if "bool_and" in sql:
            return {"is_active": True}
        if "INSERT INTO public.org_users" in sql:
            return {"id": "synthetic-user", "is_active": True}
        return None
    identity.fetchrow.side_effect = rows
    token = {"userinfo": {"email": "new@pursuit.org", "sub": "synthetic"}, "access_token": "synthetic-google"}
    monkeypatch.setattr(oauth_routes.oauth.google, "authorize_access_token", AsyncMock(return_value=token))
    response = await oauth_routes.auth_google_callback(request())
    assert "dashboard" in response.headers["location"]
    assert "set-cookie" in response.headers
    assert any("INSERT INTO public.org_users" in call.args[0] for call in identity.fetchrow.await_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize("active, location", [(False, "access_denied"), (True, "dashboard")])
async def test_oauth_denies_before_cache_or_cookie(identity, monkeypatch, active, location):
    identity.fetchrow.return_value["is_active"] = active
    token = {"userinfo": {"email": "actor@pursuit.org", "sub": "synthetic", "name": "Fixture"}, "access_token": "synthetic-google"}
    monkeypatch.setattr(oauth_routes.oauth.google, "authorize_access_token", AsyncMock(return_value=token))
    monkeypatch.delenv("ALLOWED_EMAILS", raising=False)
    response = await oauth_routes.auth_google_callback(request())
    assert location in response.headers["location"]
    if not active:
        assert "set-cookie" not in response.headers
        assert oauth_routes._google_tokens == {}
        identity.execute.assert_not_awaited()
    else:
        assert "access_token=" in response.headers["set-cookie"]
        assert oauth_routes._google_tokens["actor@pursuit.org"]["access_token"] == "synthetic-google"


@pytest.mark.asyncio
async def test_oauth_unavailable_does_not_issue(identity, monkeypatch):
    identity.fetchrow.side_effect = RuntimeError("synthetic unavailable")
    token = {"userinfo": {"email": "actor@pursuit.org", "sub": "synthetic"}, "access_token": "synthetic-google"}
    monkeypatch.setattr(oauth_routes.oauth.google, "authorize_access_token", AsyncMock(return_value=token))
    response = await oauth_routes.auth_google_callback(request())
    assert "auth_failed" in response.headers["location"]
    assert "set-cookie" not in response.headers
    assert oauth_routes._google_tokens == {}


@pytest.fixture
def pebble(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    import pebble.main as module
    return module


@pytest.mark.asyncio
@pytest.mark.parametrize("expiry", [time.time() + 600, 0])
@pytest.mark.parametrize("failure", ["denied", "unavailable", "revoked"])
async def test_pebble_old_grants_never_survive_recheck(pebble, monkeypatch, expiry, failure):
    monkeypatch.setattr(pebble, "_permission_cache", {"actor@pursuit.org": {"permissions": {"use_pebble_chat": True}, "expires": expiry}}, raising=False)
    if failure == "revoked":
        resolver = AsyncMock(return_value={"use_pebble_chat": False})
    elif failure == "denied":
        response = httpx.Response(403, request=httpx.Request("GET", "https://fixture.invalid/permissions"))
        resolver = AsyncMock(side_effect=httpx.HTTPStatusError("denied", request=response.request, response=response))
    else:
        resolver = AsyncMock(side_effect=RuntimeError("synthetic unavailable"))
    monkeypatch.setattr(pebble, "_fetch_user_permissions", resolver)
    with pytest.raises(HTTPException) as error:
        await pebble.require_pebble_permission("use_pebble_chat")(request(headers={"X-User-Email": "actor@pursuit.org"}))
    assert error.value.status_code == (503 if failure == "unavailable" else 403)
    resolver.assert_awaited_once()


@pytest.mark.asyncio
async def test_pebble_active_permission_still_sets_context(pebble, monkeypatch):
    resolver = AsyncMock(return_value={"use_pebble_chat": True})
    monkeypatch.setattr(pebble, "_fetch_user_permissions", resolver)
    req = request(headers={"X-User-Email": "Actor@pursuit.org"})
    assert await pebble.require_pebble_permission("use_pebble_chat")(req) == "actor@pursuit.org"
    assert req.state.user_permissions == {"use_pebble_chat": True}
