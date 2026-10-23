"""Tests for the per-request Salesforce client wrapper in ``dependencies.py``.

Covers the fix for the singleton race (BUG-AUTH-2 follow-up): before this
fix, ``get_mcp_client`` mutated ``base.services["salesforce"]`` and
``base._connected_services`` in place on every cookie-bearing request, so
two concurrent requests from different users could race on the shared
``sf_client`` reference and leak a session across users.

The fix wraps the base client in a ``_PerRequestMCPClient`` subclass that
copies ``services`` + ``_connected_services`` at wrap time and slots in a
fresh per-request ``SalesforceMCPService``. The base singleton is never
mutated by any request path.

These tests lock in that invariant.
"""

import asyncio
import sys
import os
from unittest.mock import MagicMock, patch

import pytest

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import dependencies
from dependencies import _PerRequestMCPClient, get_mcp_client
from fastapi import HTTPException
from mcp_client import UnifiedMCPClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def base_client():
    """A bare UnifiedMCPClient with no services wired — simulates the
    process-wide singleton that ``main.py`` startup would populate."""
    return UnifiedMCPClient()


@pytest.fixture
def base_client_with_service_account():
    """Singleton with a pre-wired service-account SF service, simulating
    the state after ``main.py`` startup when SF credentials are present."""
    client = UnifiedMCPClient()
    service_account_sf = MagicMock(name="service_account_sf")
    client.services["salesforce"] = service_account_sf
    client._connected_services.append("salesforce")
    return client


@pytest.fixture(autouse=True)
def _populate_services(request, monkeypatch):
    """Ensure ``dependencies._services["mcp_client"]`` is the test's base
    client for each test that requests either ``base_client`` or
    ``base_client_with_service_account``.

    Using a fixture (rather than a helper function) keeps each test
    isolated — the mutation is reverted automatically after the test.
    """
    # Only wire up if the test actually uses one of the base-client
    # fixtures. Otherwise leave ``_services`` untouched (the module-level
    # dict persists across tests; we don't want to clobber state for
    # tests that set up their own ``_services``).
    for name in ("base_client", "base_client_with_service_account"):
        if name in request.fixturenames:
            base = request.getfixturevalue(name)
            monkeypatch.setitem(dependencies._services, "mcp_client", base)
            return


def _make_request(cookies: dict):
    """Build a minimal ``Request``-shaped stand-in with the given cookies."""
    return MagicMock(cookies=cookies)


def _valid_tokens() -> dict:
    return {
        "access_token": "fake-access-token",
        "refresh_token": "fake-refresh-token",
        "instance_url": "https://pursuit-dev.my.salesforce.com",
        "user_id": "005FAKEUSER001",
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_no_cookie_returns_base_client(base_client):
    """No ``sf_tokens`` cookie → return the base singleton unchanged."""
    request = _make_request(cookies={})
    result = get_mcp_client(request)
    assert result is base_client


def test_strict_dependency_rejects_construction_fallback(base_client_with_service_account):
    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    with (patch("auth.decrypt_tokens", return_value=_valid_tokens()),
          patch("simple_salesforce.Salesforce", side_effect=RuntimeError("synthetic construction failure"))):
        with pytest.raises(HTTPException) as error:
            dependencies.require_sf_mcp_client(request)
        assert error.value.status_code == 503
        # Background/permissive callers keep their explicitly shared service.
        assert get_mcp_client(request) is base_client_with_service_account


def test_strict_dependency_accepts_personal_wrapper(base_client_with_service_account):
    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    with (patch("auth.decrypt_tokens", return_value=_valid_tokens()),
          patch("simple_salesforce.Salesforce", return_value=MagicMock())):
        result = dependencies.require_sf_mcp_client(request)
        assert isinstance(result, _PerRequestMCPClient)
        assert result.salesforce is not base_client_with_service_account.salesforce


def test_invalid_cookie_falls_through_to_base(base_client):
    """Undecryptable cookie → return base unchanged, no exception raised.

    Simulates a stale or tampered cookie — we should degrade gracefully
    so the service-account path stays usable.
    """
    request = _make_request(cookies={"sf_tokens": "not-a-real-fernet-blob"})
    with patch("auth.decrypt_tokens", return_value=None):
        result = get_mcp_client(request)
    assert result is base_client


def test_tokens_missing_required_fields_fall_through(base_client):
    """Cookie decrypts but is missing access_token/instance_url → base."""
    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    with patch("auth.decrypt_tokens", return_value={"refresh_token": "only-this"}):
        result = get_mcp_client(request)
    assert result is base_client


def test_valid_cookie_builds_per_request_wrapper(base_client_with_service_account):
    """Cookie present with valid tokens → wrapper is returned, wrapper's
    salesforce is a FRESH service (not the base's service-account one)."""
    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    fake_sf_client = MagicMock(name="fake_sf_client_from_cookie")

    with patch("auth.decrypt_tokens", return_value=_valid_tokens()), \
         patch("simple_salesforce.Salesforce", return_value=fake_sf_client):
        result = get_mcp_client(request)

    # It's a wrapper, not the base
    assert isinstance(result, _PerRequestMCPClient)
    assert result is not base_client_with_service_account

    # The wrapper's SF service is a fresh SalesforceMCPService wrapping the
    # cookie's sf_client — NOT the base's service-account SF
    wrapper_sf = result.salesforce
    base_sf = base_client_with_service_account.services["salesforce"]
    assert wrapper_sf is not base_sf
    assert wrapper_sf.sf_client is fake_sf_client
    assert wrapper_sf._authenticated is True

    # connected_services includes salesforce on both (base had it pre-wired;
    # wrapper mirrors + ensures)
    assert "salesforce" in result.connected_services


def test_wrapper_adds_salesforce_when_base_has_none(base_client):
    """Base has no SF connected → wrapper still exposes SF via cookie."""
    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    fake_sf_client = MagicMock(name="fake_sf_client_from_cookie")

    with patch("auth.decrypt_tokens", return_value=_valid_tokens()), \
         patch("simple_salesforce.Salesforce", return_value=fake_sf_client):
        result = get_mcp_client(request)

    assert isinstance(result, _PerRequestMCPClient)
    assert "salesforce" in result.connected_services
    assert result.salesforce.sf_client is fake_sf_client


def test_base_singleton_not_mutated(base_client_with_service_account):
    """THE CRITICAL INVARIANT: three cookie-bearing requests from
    different users must NEVER mutate the base singleton's SF slot or
    connected_services list.

    This is the test that would have FAILED before this fix and PASSES
    after. Pre-fix, each ``get_mcp_client`` call did
    ``base.services["salesforce"] = svc``, so after 3 calls the base's
    SF reference would point at the LAST caller's sf_client —
    cross-user contamination.
    """
    base = base_client_with_service_account
    original_sf_service = base.services["salesforce"]
    original_connected = list(base._connected_services)

    fake_sf_clients = [MagicMock(name=f"user_{i}_sf_client") for i in range(3)]

    # Three requests with three distinct cookies from three different users
    for i, fake_sf_client in enumerate(fake_sf_clients):
        request = _make_request(cookies={"sf_tokens": f"cookie-user-{i}"})
        tokens = dict(_valid_tokens())
        tokens["user_id"] = f"005USER{i:012d}"

        with patch("auth.decrypt_tokens", return_value=tokens), \
             patch("simple_salesforce.Salesforce", return_value=fake_sf_client):
            _ = get_mcp_client(request)

    # Base singleton's SF service is untouched — still points at the
    # original service-account SF, not at any of the per-request fakes
    assert base.services["salesforce"] is original_sf_service
    for fake in fake_sf_clients:
        # None of the per-request sf_clients made it into the base
        assert base.services["salesforce"] is not fake

    # Base's _connected_services list is unchanged
    assert base._connected_services == original_connected


def test_base_services_dict_not_shared_with_wrapper(base_client_with_service_account):
    """Mutating ``wrapper.services`` must not affect ``base.services``.

    Defense-in-depth: even if a route handler ever mutated
    ``client.services`` mid-request, the mutation should stay in the
    request's wrapper and die with the request.
    """
    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    with patch("auth.decrypt_tokens", return_value=_valid_tokens()), \
         patch("simple_salesforce.Salesforce", return_value=MagicMock()):
        wrapper = get_mcp_client(request)

    # Mutate the wrapper's services dict
    wrapper.services["some_other_service"] = "leaked?"

    # Base's services dict is unaffected
    assert "some_other_service" not in base_client_with_service_account.services


def test_base_connected_services_list_not_shared_with_wrapper(base_client):
    """Same defense-in-depth for ``_connected_services``."""
    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    with patch("auth.decrypt_tokens", return_value=_valid_tokens()), \
         patch("simple_salesforce.Salesforce", return_value=MagicMock()):
        wrapper = get_mcp_client(request)

    # Wrapper has salesforce; base does not (it was never wired in this fixture)
    assert "salesforce" in wrapper._connected_services
    assert "salesforce" not in base_client._connected_services


def test_base_clients_dict_not_shared_with_wrapper(base_client):
    """Same defense-in-depth for ``clients`` — if a future route handler
    ever calls ``client.disconnect_service(...)`` or mutates
    ``client.clients`` directly, the mutation must not leak to the base
    singleton where it would affect other users' MCP transport wiring.

    We shallow-copy the dict on wrap: the ``MCPClient`` instances inside
    stay shared (intentional — they're startup-wired transports), but the
    dict container itself is distinct.
    """
    # Pre-populate base.clients with a sentinel so we can detect leakage
    base_client.clients["sentinel"] = "base-value"

    request = _make_request(cookies={"sf_tokens": "valid-blob"})
    with patch("auth.decrypt_tokens", return_value=_valid_tokens()), \
         patch("simple_salesforce.Salesforce", return_value=MagicMock()):
        wrapper = get_mcp_client(request)

    # Wrapper sees the pre-existing sentinel (shallow copy preserves entries)
    assert wrapper.clients["sentinel"] == "base-value"

    # Mutating wrapper.clients does NOT mutate base.clients
    wrapper.clients["request_scoped"] = "leaked?"
    assert "request_scoped" not in base_client.clients

    # And deleting from wrapper.clients doesn't affect base (catches the
    # latent risk in `disconnect_service` if ever called on a wrapper)
    del wrapper.clients["sentinel"]
    assert base_client.clients["sentinel"] == "base-value"


@pytest.mark.asyncio
async def test_concurrent_requests_get_distinct_sf_services(base_client):
    """Two concurrent cookie-bearing requests (different users) each get
    their own ``SalesforceMCPService`` instance pointing at their own
    ``sf_client``. No reference-sharing possible.

    This is the minimal in-process simulation of the cross-user race.
    """
    user_a_sf_client = MagicMock(name="user_a_sf_client")
    user_b_sf_client = MagicMock(name="user_b_sf_client")

    call_counter = {"n": 0}

    def salesforce_side_effect(**kwargs):
        # Alternate between user-A and user-B clients based on call order
        n = call_counter["n"]
        call_counter["n"] = n + 1
        return user_a_sf_client if n == 0 else user_b_sf_client

    def decrypt_side_effect(blob: str):
        # Distinct tokens per user cookie — ensures each request builds
        # its own SalesforceMCPService
        if "user-a" in blob:
            return {**_valid_tokens(), "user_id": "005USER-A"}
        return {**_valid_tokens(), "user_id": "005USER-B"}

    async def call_get_mcp(cookie_value: str):
        request = _make_request(cookies={"sf_tokens": cookie_value})
        # Yield once to interleave with the other coroutine
        await asyncio.sleep(0)
        return get_mcp_client(request)

    with patch("auth.decrypt_tokens", side_effect=decrypt_side_effect), \
         patch("simple_salesforce.Salesforce", side_effect=salesforce_side_effect):
        wrapper_a, wrapper_b = await asyncio.gather(
            call_get_mcp("cookie-user-a"),
            call_get_mcp("cookie-user-b"),
        )

    # Each wrapper is a distinct instance
    assert wrapper_a is not wrapper_b
    # Each wrapper's SF service is a distinct instance
    assert wrapper_a.salesforce is not wrapper_b.salesforce
    # Each wrapper's underlying sf_client points at the right user's session
    sf_clients_seen = {wrapper_a.salesforce.sf_client, wrapper_b.salesforce.sf_client}
    assert sf_clients_seen == {user_a_sf_client, user_b_sf_client}
    # And the base singleton's SF slot is still empty (never mutated)
    assert "salesforce" not in base_client.services
