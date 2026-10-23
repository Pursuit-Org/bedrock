"""Actor authorization must precede subject mapping and write attribution."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from auth import require_auth
from db import get_db
from routes import jobs, permissions


@pytest.fixture
def network(monkeypatch):
    actor = {"email": "actor@pursuit.org"}
    grants = {"profile_name": "Relationship Manager", "permissions": {}}
    async def resolve(email, conn):
        return grants if email == "actor@pursuit.org" else {"profile_name": "Admin", "permissions": {"manage_users_roles": True}}
    resolver = AsyncMock(side_effect=resolve)
    monkeypatch.setattr(permissions, "get_user_permissions", resolver)
    mapping = AsyncMock(return_value=None)
    monkeypatch.setattr(jobs, "_ensure_staff_mapping", mapping)
    conn = AsyncMock()
    conn.fetchval.return_value = True
    app = FastAPI()
    # Only these real handlers: unrelated router-wide target refresh is infrastructure.
    app.add_api_route("/network", jobs.my_network, methods=["GET"])
    app.add_api_route("/facets", jobs.my_network_facets, methods=["GET"])
    app.add_api_route("/status", jobs.set_connection_status, methods=["PATCH"])
    app.dependency_overrides[require_auth] = lambda: actor
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, actor=actor, grants=grants, mapping=mapping, conn=conn, resolver=resolver, app=app)


def call(n, endpoint, **params):
    if endpoint == "status":
        return n.client.patch("/status", params=params, json={"contact_id": 7, "status": "will_reach_out"})
    return n.client.get("/" + endpoint, params=params)


@pytest.mark.parametrize("endpoint", ["network", "facets", "status"])
def test_nonadmin_cannot_select_admin_subject(network, endpoint):
    assert call(network, endpoint, staff_email="admin@pursuit.org").status_code == 403
    network.mapping.assert_not_awaited()
    network.conn.execute.assert_not_awaited()


@pytest.mark.parametrize("endpoint", ["network", "facets"])
def test_subject_profile_cannot_grant_leadership_scope(network, endpoint):
    response = call(network, endpoint, staff_email="admin@pursuit.org", scope="pursuit")
    assert response.status_code == 403
    network.mapping.assert_not_awaited()


@pytest.mark.parametrize("endpoint", ["network", "facets"])
@pytest.mark.parametrize("override", [None, " ACTOR@PURSUIT.ORG "])
def test_self_equivalent_override_keeps_unmapped_success(network, endpoint, override):
    params = {} if override is None else {"staff_email": override}
    assert call(network, endpoint, **params).status_code == 200
    assert network.mapping.await_args.args[0] == "actor@pursuit.org"


@pytest.mark.parametrize("endpoint", ["network", "facets"])
def test_leadership_actor_keeps_pursuit_access(network, endpoint):
    network.grants["profile_name"] = "Executive"
    assert call(network, endpoint, scope="pursuit").status_code == 200
    assert network.resolver.await_args.args[0] == "actor@pursuit.org"


def test_executive_scope_does_not_grant_delegated_write(network):
    network.grants["profile_name"] = "Executive"
    assert call(network, "status", staff_email="admin@pursuit.org").status_code == 403
    network.mapping.assert_not_awaited()


def test_admin_delegation_uses_subject_but_records_actor(network):
    network.grants["permissions"] = {"manage_users_roles": True}
    network.mapping.return_value = 37
    response = call(network, "status", staff_email=" ADMIN@PURSUIT.ORG ")
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "expect_response"
    assert network.mapping.await_args.args[0] == "admin@pursuit.org"
    args = network.conn.execute.await_args.args
    assert args[1] == 37
    assert args[-1] == "actor@pursuit.org"


def test_partial_self_update_preserves_clear_and_note_contract(network):
    network.mapping.return_value = 37
    response = network.client.patch("/status", json={"contact_id": 7, "hiring_fit": "", "note": "  legacy note  "})
    assert response.status_code == 200
    assert response.json()["data"] == {"contact_id": 7, "hiring_fit": None, "note": "legacy note"}
    assert "status=EXCLUDED.status" not in network.conn.execute.await_args.args[0]


@pytest.mark.parametrize("principal", [{}, {"email": " "}, {"email": 7}])
def test_missing_actor_cannot_borrow_subject_identity(network, principal):
    network.app.dependency_overrides[require_auth] = lambda: principal
    assert call(network, "network", staff_email="admin@pursuit.org").status_code == 401
    network.mapping.assert_not_awaited()


def test_attribute_principal_compatibility(network):
    network.app.dependency_overrides[require_auth] = lambda: SimpleNamespace(email=" ACTOR@PURSUIT.ORG ")
    assert call(network, "network").status_code == 200
    assert network.mapping.await_args.args[0] == "actor@pursuit.org"
