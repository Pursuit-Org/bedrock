"""Shared fakes for jobs eval modules.

No live DB / SF / network. A FakeConn dispatches SQL by substring and records
every call; FakeSalesforce records queries/creates. make_jobs_client() wires
the FastAPI dependency overrides used across the jobs endpoints.

This is NOT a test module (no test_ prefix) so pytest imports it as a helper.
"""

from main import app, get_current_user
from auth import require_auth
import db as db_module
from db import get_db
from dependencies import (
    get_mcp_client as deps_get_mcp_client,
    require_sf_mcp_client as deps_require_sf_mcp_client,
)
from fastapi.testclient import TestClient


class FakeTxn:
    async def __aenter__(self): return None
    async def __aexit__(self, *a): return False


class FakeConn:
    """Query-aware fake asyncpg connection.

    rows/lists/vals are {sql_substring: result} maps consulted in insertion
    order; the first substring found in the query wins. Every call is recorded
    in .calls as (kind, query, args) so tests can assert what SQL ran.
    """
    def __init__(self, rows=None, lists=None, vals=None):
        self.rows = rows or {}      # fetchrow dispatch
        self.lists = lists or {}    # fetch dispatch
        self.vals = vals or {}      # fetchval dispatch
        self.calls: list[tuple] = []

    def transaction(self):
        return FakeTxn()

    def _match(self, table, query, default):
        for needle, val in table.items():
            if needle in query:
                return val
        return default

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self._match(self.rows, query, None)

    async def fetch(self, query, *args):
        self.calls.append(("fetch", query, args))
        return self._match(self.lists, query, [])

    async def fetchval(self, query, *args):
        self.calls.append(("fetchval", query, args))
        return self._match(self.vals, query, None)

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return self._match(self.vals, query, "OK")

    # helpers for assertions
    def queries(self, kind=None):
        return [c[1] for c in self.calls if kind is None or c[0] == kind]

    def executed(self, needle):
        return [c for c in self.calls if c[0] == "execute" and needle in c[1]]

    def ran(self, needle):
        return any(needle in c[1] for c in self.calls)


class FakeSalesforce:
    def __init__(self, query_results=None, create_ids=None):
        self.queries: list[str] = []
        self.creates: list[tuple] = []
        self._qr = query_results or {}
        self._ids = create_ids or {}

    async def query(self, soql):
        self.queries.append(soql)
        for needle, res in self._qr.items():
            if needle in soql:
                return res
        return {"records": []}

    async def query_all(self, soql):
        return await self.query(soql)

    async def create_record(self, sobject, data):
        self.creates.append((sobject, data))
        return {"id": self._ids.get(sobject, f"NEW{sobject}")}


class FakePool:
    """Stands in for the asyncpg pool behind db.get_pool(). Routes that fan
    out reads with `pool = get_pool(); asyncio.gather(pool.fetch(...))`
    (e.g. GET /api/jobs/accounts) bypass the get_db dependency entirely, so
    the FastAPI override can't reach them — the pool itself must be faked.
    Delegates every call to the same FakeConn so its substring dispatch and
    .calls recording keep working.
    """
    def __init__(self, conn):
        self._conn = conn

    async def fetch(self, query, *args):
        return await self._conn.fetch(query, *args)

    async def fetchrow(self, query, *args):
        return await self._conn.fetchrow(query, *args)

    async def fetchval(self, query, *args):
        return await self._conn.fetchval(query, *args)

    async def execute(self, query, *args):
        return await self._conn.execute(query, *args)

    def acquire(self, timeout=None):
        conn = self._conn
        class _Acq:
            async def __aenter__(self): return conn
            async def __aexit__(self, *a): return False
        return _Acq()


class FakeClient:
    def __init__(self, sf):
        self.salesforce = sf
        # Routes gate SF write-through on `"salesforce" in client.connected_services`.
        # Empty set = sync paths are skipped, keeping these tests hermetic.
        self.connected_services = set()


DEFAULT_USER = {"email": "tester@pursuit.org", "user_id": "tester@pursuit.org"}


def make_jobs_client(conn, sf=None, user=None):
    """TestClient with require_auth + get_db (+ SF) overridden. Caller should
    clear app.dependency_overrides afterward (the autouse fixture does)."""
    u = user or DEFAULT_USER
    app.dependency_overrides[require_auth] = lambda: u
    app.dependency_overrides[get_current_user] = lambda: u
    app.dependency_overrides[get_db] = lambda: conn
    fc = FakeClient(sf or FakeSalesforce())
    # Override BOTH client dependencies. Routes that Depends(get_mcp_client)
    # otherwise 503 ("MCP client not initialized") unless an earlier test file
    # happened to run app startup via `with TestClient(...)` — an ordering
    # accident, not a contract.
    app.dependency_overrides[deps_get_mcp_client] = lambda: fc
    app.dependency_overrides[deps_require_sf_mcp_client] = lambda: fc
    # Routes that read via get_pool() (not the get_db dependency) need the
    # module-level pool faked too. The autouse fixture in conftest.py
    # restores the real value after every test.
    db_module._pool = FakePool(conn)
    return TestClient(app, raise_server_exceptions=False)
