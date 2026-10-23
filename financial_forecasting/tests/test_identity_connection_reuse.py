"""Authentication must not acquire a second connection held by the same request."""
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import Depends, FastAPI

import auth
import db
from dependencies import require_sf_mcp_client
from routes import opportunities_extra


class BoundedPool:
    """Fill all ten slots before releasing requests into their next dependency."""
    def __init__(self, active=True):
        self.active = active
        self.slots = asyncio.Semaphore(10)
        self.full = asyncio.Event()
        self.acquisitions = 0
        self.held = 0
        self.peak = 0
        self.starved = 0

    @asynccontextmanager
    async def acquire(self, timeout=10):
        self.acquisitions += 1
        try:
            await asyncio.wait_for(self.slots.acquire(), 0.25)
        except asyncio.TimeoutError:
            self.starved += 1
            raise
        self.held += 1
        self.peak = max(self.peak, self.held)
        if self.held == 10:
            self.full.set()
        try:
            await asyncio.wait_for(self.full.wait(), 2)
            yield SimpleNamespace(fetchrow=self.fetchrow)
        finally:
            self.held -= 1
            self.slots.release()

    async def fetchrow(self, sql, *args):
        if self.active == "unavailable":
            raise RuntimeError("synthetic identity store unavailable")
        return {"id": "synthetic", "is_active": self.active, "profile_id": 1,
                "profile_name": "Owner", "permissions": {"edit_own_opportunities": True}}


@pytest.mark.asyncio
@pytest.mark.parametrize("active,status", [(True, 200), (False, 403), ("unavailable", 503)])
async def test_stage_auth_reuses_request_connection_at_pool_capacity(monkeypatch, active, status):
    pool = BoundedPool(active)
    monkeypatch.setattr(db, "_pool", pool)
    monkeypatch.setattr(opportunities_extra, "ensure_award_for_opp", AsyncMock(return_value=None))
    sf = AsyncMock()
    sf.update_record.return_value = True
    app = FastAPI()
    app.include_router(opportunities_extra.router)
    app.dependency_overrides[require_sf_mcp_client] = lambda: SimpleNamespace(salesforce=sf)
    token = auth.create_access_token({"email": "actor@pursuit.org"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture.invalid", cookies={"access_token": token}) as client:
        responses = await asyncio.wait_for(asyncio.gather(*[
            client.post("/api/opportunities/update-stage", json={"opportunity_id": "006000000000001AAA", "new_stage": "Qualifying"})
            for _ in range(10)
        ]), 3)
    assert [response.status_code for response in responses] == [status] * 10
    assert pool.acquisitions == 10
    assert pool.peak == 10
    assert pool.held == pool.starved == 0
    assert sf.update_record.await_count == (10 if active is True else 0)


@pytest.mark.asyncio
async def test_auth_before_database_dependency_does_not_hold_two_connections(monkeypatch):
    pool = BoundedPool()
    monkeypatch.setattr(db, "_pool", pool)
    app = FastAPI()

    @app.get("/auth-first")
    async def auth_first(user=Depends(auth.require_auth), conn=Depends(db.get_db)):
        return {"email": user["email"]}

    token = auth.create_access_token({"email": "actor@pursuit.org"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture.invalid", cookies={"access_token": token}) as client:
        responses = await asyncio.wait_for(asyncio.gather(*[client.get("/auth-first") for _ in range(10)]), 3)
    assert all(response.status_code == 200 for response in responses)
    assert pool.acquisitions == 20
    assert pool.held == pool.starved == 0


def test_anonymous_and_internal_routes_do_not_acquire_identity_connection(monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setattr(db, "_pool", None)
    monkeypatch.setattr(auth, "_BEDROCK_INTERNAL_API_KEY", "synthetic-key")
    app = FastAPI()

    @app.get("/optional")
    async def optional(user=Depends(auth.get_current_user_dep)):
        return {"user": user}

    @app.get("/internal")
    async def internal(user=Depends(auth.require_auth_or_internal)):
        return {"service": user["is_service"]}

    with TestClient(app) as client:
        assert client.get("/optional").json() == {"user": None}
        assert client.get("/internal", headers={"X-Internal-Key": "synthetic-key"}).json() == {"service": True}
