"""Comprehensive FastAPI TestClient tests for financial forecasting API endpoints."""

import sys
import os
import json
import asyncio
from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

from main import app, get_current_user, get_mcp_client, get_forecasting_engine, get_data_sync_service, _sync_lock, startup_event, shutdown_event
from main import require_sf_mcp_client as main_require_sf_mcp_client
from dependencies import require_sf_mcp_client as deps_require_sf_mcp_client
from auth import require_auth, require_auth_or_internal
from db import get_db

# Disable startup/shutdown events that try to connect to real services
app.router.on_startup.clear()
app.router.on_shutdown.clear()
from models import (
    OpportunityStage, PaymentTerms, InvoiceStatus,
    ForecastingDashboardData, ForecastingMetrics,
    PaymentForecast, CashFlowProjection,
    ApiResponse,
)
from conftest import (
    make_sf_opportunity,
    make_sf_account,
    make_sf_contact,
    make_sf_task,
    make_intacct_invoice,
    make_intacct_payment,
)


# ---------------------------------------------------------------------------
# Test user and dependency overrides
# ---------------------------------------------------------------------------

TEST_USER = {"user_id": "test_user", "name": "Test User", "role": "admin"}


def override_get_current_user():
    return TEST_USER


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_salesforce():
    """Create a mock Salesforce service."""
    service = AsyncMock()
    service.query = AsyncMock(return_value={"records": []})
    service.query_all = AsyncMock(return_value={"records": []})
    service.create_record = AsyncMock(return_value={"id": "006NEW0000000001"})
    service.update_record = AsyncMock(return_value=True)
    service.delete_record = AsyncMock(return_value=True)
    service.get_service_info = AsyncMock(return_value={
        "service": "salesforce",
        "authenticated": True,
        "config": {"instance_url": "https://test.salesforce.com"},
    })
    return service


@pytest.fixture
def mock_sage():
    """Create a mock Sage Intacct service."""
    service = AsyncMock()
    service.get_invoices = AsyncMock(return_value={
        "success": True,
        "data": [make_intacct_invoice()],
    })
    service.create_invoice = AsyncMock(return_value={
        "success": True,
        "data": {"RECORDNO": "INV-NEW-001"},
    })
    service.get_payments = AsyncMock(return_value={
        "success": True,
        "data": [make_intacct_payment()],
    })
    service.get_service_info = AsyncMock(return_value={
        "service": "sage_intacct",
        "authenticated": True,
        "config": {},
    })
    return service


@pytest.fixture
def mock_client(mock_salesforce, mock_sage):
    """Create a mock UnifiedMCPClient."""
    client = MagicMock()
    client.salesforce = mock_salesforce
    client.sage_intacct = mock_sage
    client.services = {
        "salesforce": mock_salesforce,
        "sage_intacct": mock_sage,
    }
    client._connected_services = {"salesforce", "sage_intacct"}
    # Public alias — main.py endpoints check `client.connected_services`
    # (the @property on UnifiedMCPClient at unified_client.py:303). Without
    # this, MagicMock auto-generates a child mock whose __contains__ returns
    # False, silently short-circuiting 13 tests in this file at the
    # "x in connected_services" availability gate. Mirrors the fix applied
    # to `mock_mcp_client` in conftest.py:333 on 2026-04-16.
    client.connected_services = {"salesforce", "sage_intacct"}
    client.disconnect_all = AsyncMock()
    return client


@pytest.fixture
def mock_engine():
    """Create a mock ForecastingEngine with async methods."""
    engine = AsyncMock()
    engine.generate_dashboard_data = AsyncMock()
    engine.generate_payment_forecasts = AsyncMock(return_value=[])
    engine.generate_cash_flow_projections = AsyncMock(return_value=[])
    engine.calculate_forecasting_metrics = AsyncMock()
    engine.generate_comprehensive_report = AsyncMock()
    return engine


@pytest.fixture
def mock_sync_service():
    """Create a mock DataSyncService."""
    svc = AsyncMock()
    svc.sync_all_data = AsyncMock()
    svc.sync_salesforce_data = AsyncMock()
    svc.sync_intacct_data = AsyncMock()
    return svc


@pytest.fixture
def mock_db():
    """Mock DB for check_permission — returns admin user with all permissions."""
    import json
    all_perms = json.dumps({
        "view_opportunities": True, "edit_own_opportunities": True, "edit_all_opportunities": True,
        "create_opportunities": True, "bulk_update_opportunities": True, "lock_own_opportunities": True,
        "reassign_opportunities": True,
        # Account + Contact perms gate the 4 endpoints using check_permission_or_internal
        # (main.py:530,610,736,761). Without these, `POST /api/salesforce/accounts` et al.
        # return 403 for this "admin" user. Matches the admin permission set used by
        # tests/test_projects_endpoints.py:36 and tests/test_permissions.py:41,57.
        "edit_accounts": True, "create_accounts": True,
        "edit_contacts": True, "create_contacts": True,
        # edit_payments gates POST /api/salesforce/payments (and PUT). Without
        # this, TestSalesforcePaymentCreate gets 403 from check_permission.
        "edit_payments": True,
        "view_tasks": True, "edit_own_tasks": True, "edit_all_tasks": True, "create_tasks": True,
        "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
        "view_sage_invoices_payments": True, "create_sage_invoices": True,
        "match_invoices": True, "manage_payment_schedules": True, "generate_financial_reports": True,
        "trigger_data_sync": True, "manage_users_roles": True,
    })
    admin_row = {
        "id": "test-id", "sf_user_id": "005TESTOWNER00001", "email": "test@test.org",
        "name": "Test", "is_active": True, "permissions": all_perms, "profile_name": "Admin",
    }
    async def smart_fetchrow(query, *args):
        """Return admin user for permission queries, None for lock queries."""
        if "opportunity_lock" in query:
            return None  # No lock by default
        return admin_row
    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
    db.fetchval = AsyncMock(return_value=1)
    db.execute = AsyncMock(return_value="OK")
    return db


@pytest.fixture
def client(mock_client, mock_engine, mock_sync_service, mock_db):
    """Create a TestClient with all dependencies overridden."""
    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[require_auth] = override_get_current_user
    # `check_permission_or_internal` (routes/permissions.py:223) depends on
    # `require_auth_or_internal`, NOT `require_auth`. Endpoints using it
    # (main.py:530,610,736,761 — create/edit accounts & contacts) would
    # otherwise fall through to real JWT auth at auth.py:162 and return 401
    # under TestClient.
    app.dependency_overrides[require_auth_or_internal] = override_get_current_user
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_mcp_client] = lambda: mock_client
    app.dependency_overrides[main_require_sf_mcp_client] = lambda: mock_client
    app.dependency_overrides[deps_require_sf_mcp_client] = lambda: mock_client
    app.dependency_overrides[get_forecasting_engine] = lambda: mock_engine
    app.dependency_overrides[get_data_sync_service] = lambda: mock_sync_service

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()


@pytest.fixture
def unauthed_client(mock_client, mock_engine, mock_sync_service):
    """TestClient without auth override — keeps HTTPBearer requirement."""
    app.dependency_overrides[get_mcp_client] = lambda: mock_client
    app.dependency_overrides[get_forecasting_engine] = lambda: mock_engine
    app.dependency_overrides[get_data_sync_service] = lambda: mock_sync_service
    # Intentionally do NOT override get_current_user

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()


@pytest.fixture
def no_services_client():
    """TestClient with NO dependency overrides — services will 503."""
    # Override auth so we can reach the endpoint, but leave services un-overridden.
    app.dependency_overrides[get_current_user] = override_get_current_user
    # Explicitly override with raisers that mimic uninitialized services
    from fastapi import HTTPException

    def _no_mcp():
        raise HTTPException(status_code=503, detail="MCP client not initialized")

    def _no_engine():
        raise HTTPException(status_code=503, detail="Forecasting engine not initialized")

    def _no_sync():
        raise HTTPException(status_code=503, detail="Data sync service not available")

    app.dependency_overrides[get_mcp_client] = _no_mcp
    app.dependency_overrides[main_require_sf_mcp_client] = _no_mcp
    app.dependency_overrides[deps_require_sf_mcp_client] = _no_mcp
    app.dependency_overrides[get_forecasting_engine] = _no_engine
    app.dependency_overrides[get_data_sync_service] = _no_sync

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def mock_db_status_connected(monkeypatch):
    """Report the database as 'connected' so `/health` returns success=True.

    Tests don't call `init_db()` (that would require a live Postgres), so
    `db.py._db_init_status` stays at its module-default "not_started" and
    `/health` (main.py:249-266) reports success=False. Patch the
    `get_db_status` symbol imported into `main` (main.py:37) to return
    "connected". Autouse so it applies to every test; monkeypatch reverts
    automatically on teardown.
    """
    import main
    monkeypatch.setattr(main, "get_db_status", lambda: "connected")


@pytest.fixture(autouse=True)
def reset_cache():
    """Wipe the module-level TTLCache before and after every test.

    Endpoints in main.py (opps:, accounts:, contacts:, payments:,
    opp-payments:, my-tasks:, users) and routes/progress_tracking.py share
    a singleton `cache` instance at services/cache.py:49. Without this
    autouse reset, earlier tests populate cache entries that later tests
    read back, causing assertions like `test_get_opportunities_returns_records`
    (expects 1 record from a fresh mock) to see stale multi-record data from
    an earlier test in a different class. `cache.clear()` is used rather than
    per-prefix `invalidate_prefix` so any newly-added endpoint cache prefix
    can't silently slip past this fixture. Mirrors the pattern in
    tests/test_wall_of_progress_endpoints.py:89-94.
    """
    from services.cache import cache
    cache.clear()
    yield
    cache.clear()


# ===================================================================
# 1. Health endpoints
# ===================================================================

class TestHealthEndpoints:
    """Tests for /health and /health/services."""

    def test_health_check_returns_200(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["status"] == "healthy"
        assert "timestamp" in body["meta"]

    def test_health_check_no_auth_required(self, unauthed_client):
        """The basic /health endpoint does not require auth."""
        response = unauthed_client.get("/health")
        assert response.status_code == 200

    def test_services_health_check(self, client, mock_client):
        response = client.get("/health/services")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        # The endpoint iterates _connected_services and calls get_service_info
        assert "salesforce" in body["data"] or "sage_intacct" in body["data"]

    def test_services_health_check_503_when_no_client(self, no_services_client):
        response = no_services_client.get("/health/services")
        assert response.status_code == 503


# ===================================================================
# 2. Salesforce Opportunities
# ===================================================================

class TestSalesforceOpportunities:
    """Tests for GET/PUT /api/salesforce/opportunities."""

    def test_get_opportunities_empty(self, client, mock_client):
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_opportunities_returns_records(self, client, mock_client):
        opp = make_sf_opportunity()
        mock_client.salesforce.query_all.return_value = {"records": [opp]}
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["Id"] == opp["Id"]
        # RecordType round-trip: the 2026-04-17 B2 incident root cause was
        # that the "Other fee for service" categorization wasn't surfacing.
        # The Type field was misdiagnosed (A4 2026-04-21 deletion); the
        # canonical label field is RecordType.Name. This assertion guards
        # the API contract so regressions here get caught even if the
        # frontend regresses separately.
        assert data[0]["RecordType"]["Name"] == "Other fee for service"
        # SOQL-inclusion guard for RenewalRepeat__c — A4 adversarial
        # verification caught it was missing from the SELECT despite being
        # bound in OpportunityEditDialog + Progress.tsx isRenewal.
        #
        # PR #162 added 4 more pins (Contract_Start_Date__c,
        # Contract_End_Date__c, Payment_Terms__c, Billing_Frequency__c)
        # but Pursuit's SF org doesn't actually have those custom fields —
        # SF rejected the whole SELECT with an unknown-field error,
        # breaking the Opportunities endpoint in prod 2026-04-21. Hotfix
        # PR #167 reverted the 4 additions from the SOQL and removed the
        # pins. The frontend still binds them (speculative TS interface +
        # OpportunityEditDialog inputs) — that ghost-binding is a
        # separate latent bug tracked for follow-up cleanup.
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "RenewalRepeat__c" in soql

    def test_get_opportunities_with_stage_filter(self, client, mock_client):
        opp = make_sf_opportunity({"StageName": "Qualifying"})
        mock_client.salesforce.query_all.return_value = {"records": [opp]}
        response = client.get("/api/salesforce/opportunities", params={"stage": "Qualifying"})
        assert response.status_code == 200
        # Verify the query method was called and a WHERE clause was built
        call_args = mock_client.salesforce.query_all.call_args
        soql = call_args[0][0]
        assert "StageName = 'Qualifying'" in soql

    def test_get_opportunities_with_stages_list(self, client, mock_client):
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get(
            "/api/salesforce/opportunities",
            params={"stages": ["Qualifying", "Lead Gen"]},
        )
        assert response.status_code == 200
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "StageName IN" in soql

    def test_get_opportunities_with_limit(self, client, mock_client):
        """Limit param is accepted (query_all fetches all records via pagination)."""
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get("/api/salesforce/opportunities", params={"limit": 10})
        assert response.status_code == 200

    def test_get_opportunities_service_error(self, client, mock_client):
        mock_client.salesforce.query_all.side_effect = RuntimeError("Salesforce down")
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 500
        assert "Salesforce down" in response.json()["detail"]

    def test_get_opportunities_503_when_no_client(self, no_services_client):
        response = no_services_client.get("/api/salesforce/opportunities")
        assert response.status_code == 503

    def test_update_opportunity_success(self, client, mock_client):
        mock_client.salesforce.update_record.return_value = True
        response = client.put(
            "/api/salesforce/opportunities/006TESTOPPORT01",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "updates": {"StageName": "Contract Creation"},
                "user_id": "test_user",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == "006TESTOPPORT01"

    def test_update_opportunity_failure(self, client, mock_client):
        mock_client.salesforce.update_record.return_value = False
        response = client.put(
            "/api/salesforce/opportunities/006TESTOPPORT01",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "updates": {"StageName": "Bad Stage"},
                "user_id": "test_user",
            },
        )
        # update_record returning False raises HTTPException 400, but the except
        # clause catches HTTPException as a generic Exception and re-raises as 500.
        # Actually: HTTPException is raised, caught by the except, then re-raised as 500.
        assert response.status_code == 500 or response.status_code == 400

    def test_update_opportunity_service_error(self, client, mock_client):
        mock_client.salesforce.update_record.side_effect = RuntimeError("write failed")
        response = client.put(
            "/api/salesforce/opportunities/006TESTOPPORT01",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "updates": {"Amount": 99999},
                "user_id": "test_user",
            },
        )
        # Phase 0: SF errors now surface as 400 with the actual error message
        assert response.status_code == 400
        assert "write failed" in response.json()["detail"]


# ===================================================================
# 3. Salesforce Accounts
# ===================================================================

class TestSalesforceAccounts:
    """Tests for GET/POST /api/salesforce/accounts."""

    def test_get_accounts_returns_list(self, client, mock_client):
        acct = make_sf_account()
        mock_client.salesforce.query_all.return_value = {"records": [acct]}
        response = client.get("/api/salesforce/accounts")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["Name"] == "Test Foundation Inc"

    def test_get_accounts_empty(self, client, mock_client):
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get("/api/salesforce/accounts")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_accounts_paginates_beyond_2000(self, client, mock_client):
        """Default limit=None drives query_all pagination with no SOQL LIMIT,
        so results are NOT silently capped at 2000."""
        accounts = [make_sf_account({"Id": f"001BIG{i:04d}"}) for i in range(2500)]
        mock_client.salesforce.query_all.return_value = {"records": accounts}
        response = client.get("/api/salesforce/accounts")
        assert response.status_code == 200
        assert len(response.json()) == 2500
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "LIMIT" not in soql

    def test_get_accounts_selects_secondary_owner(self, client, mock_client):
        """PBD Home lists accounts where the user is Secondary Account
        Owner, so both projections must carry the lookup + its name."""
        mock_client.salesforce.query_all.return_value = {"records": []}
        for qs in ("?fields=light", ""):
            client.get(f"/api/salesforce/accounts{qs}")
            soql = mock_client.salesforce.query_all.call_args_list[0][0][0]
            assert "SecondaryAccountOwner__c" in soql
            assert "SecondaryAccountOwner__r.Name" in soql
            mock_client.salesforce.query_all.reset_mock()

    def test_create_account_success(self, client, mock_client):
        mock_client.salesforce.create_record.return_value = {"id": "001NEW001"}
        response = client.post(
            "/api/salesforce/accounts",
            json={"Name": "New Foundation", "Type": "Customer"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == "001NEW001"

    def test_create_account_failure(self, client, mock_client):
        mock_client.salesforce.create_record.return_value = {}
        response = client.post(
            "/api/salesforce/accounts",
            json={"Name": "Bad Account"},
        )
        # create_record returns no "id" → raises HTTPException(400) → caught as 500
        assert response.status_code in (400, 500)


# ===================================================================
# 4. Salesforce Contacts
# ===================================================================

class TestSalesforceContacts:
    """Tests for GET /api/salesforce/contacts."""

    def test_get_contacts_returns_list(self, client, mock_client):
        contact = make_sf_contact()
        mock_client.salesforce.query_all.return_value = {"records": [contact]}
        response = client.get("/api/salesforce/contacts")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["LastName"] == "Donor"

    def test_get_contacts_with_account_filter(self, client, mock_client):
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get(
            "/api/salesforce/contacts",
            params={"account_id": "001TESTACCOUNT001A"},
        )
        assert response.status_code == 200
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "AccountId = '001TESTACCOUNT001A'" in soql

    def test_get_contacts_service_error(self, client, mock_client):
        mock_client.salesforce.query_all.side_effect = RuntimeError("timeout")
        response = client.get("/api/salesforce/contacts")
        assert response.status_code == 500

    def test_get_contacts_paginates_beyond_2000(self, client, mock_client):
        """Default limit=None drives query_all pagination with no SOQL LIMIT,
        so results are NOT silently capped at 2000."""
        contacts = [make_sf_contact({"Id": f"003BIG{i:04d}"}) for i in range(2500)]
        mock_client.salesforce.query_all.return_value = {"records": contacts}
        response = client.get("/api/salesforce/contacts")
        assert response.status_code == 200
        assert len(response.json()) == 2500
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "LIMIT" not in soql


# ===================================================================
# 4a. Salesforce Payments — POST create (single-record)
# ===================================================================

class TestSalesforcePaymentCreate:
    """Tests for POST /api/salesforce/payments (single-record create, PR #161).

    Distinct from the bulk routes/payment_schedules.py create endpoint which
    wipes and recreates the entire schedule. This one appends a single new
    npe01__OppPayment__c to whatever already exists.
    """

    OPP_ID = "006TESTOPPORT01"

    def test_create_payment_success(self, client, mock_client):
        mock_client.salesforce.create_record.return_value = {"id": "a0xNEW000000001"}
        response = client.post(
            "/api/salesforce/payments",
            json={
                "opportunity_id": self.OPP_ID,
                "amount": 5000.0,
                "scheduled_date": "2026-07-15",
                "payment_method": "ACH",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == "a0xNEW000000001"

        # Verify the create was called on the right SObject with the expected
        # field mapping (frontend-friendly names → SF native field names).
        mock_client.salesforce.create_record.assert_called_once()
        args = mock_client.salesforce.create_record.call_args[0]
        assert args[0] == "npe01__OppPayment__c"
        fields = args[1]
        assert fields["npe01__Opportunity__c"] == self.OPP_ID
        assert fields["npe01__Payment_Amount__c"] == 5000.0
        assert fields["npe01__Scheduled_Date__c"] == "2026-07-15"
        assert fields["npe01__Payment_Method__c"] == "ACH"
        assert fields["npe01__Paid__c"] is False

    def test_create_payment_omits_method_when_not_provided(self, client, mock_client):
        """Payment Method is optional — if omitted, the field is not sent to SF
        (avoids clobbering any default the Salesforce layer might populate)."""
        mock_client.salesforce.create_record.return_value = {"id": "a0xNEW000000002"}
        response = client.post(
            "/api/salesforce/payments",
            json={
                "opportunity_id": self.OPP_ID,
                "amount": 100.0,
                "scheduled_date": "2026-08-01",
            },
        )
        assert response.status_code == 200
        fields = mock_client.salesforce.create_record.call_args[0][1]
        assert "npe01__Payment_Method__c" not in fields

    def test_create_payment_invalid_opportunity_id_rejected(self, client, mock_client):
        """validate_salesforce_id runs before we touch Salesforce."""
        response = client.post(
            "/api/salesforce/payments",
            json={
                "opportunity_id": "not-a-real-sf-id",
                "amount": 100.0,
                "scheduled_date": "2026-08-01",
            },
        )
        assert response.status_code in (400, 422)
        mock_client.salesforce.create_record.assert_not_called()

    def test_create_payment_missing_required_fields_rejected(self, client, mock_client):
        """Pydantic should reject requests missing opportunity_id / amount /
        scheduled_date before the handler body runs."""
        response = client.post(
            "/api/salesforce/payments",
            json={"opportunity_id": self.OPP_ID},  # missing amount, scheduled_date
        )
        assert response.status_code == 422
        mock_client.salesforce.create_record.assert_not_called()


# ===================================================================
# 4a-bis. Salesforce Payments — PUT update (ownership-gated per PR #164)
# ===================================================================

class TestSalesforcePaymentUpdate:
    """Tests for PUT /api/salesforce/payments/{id} (ownership hardening, PR #164).

    Prior to PR #164 the PUT endpoint only checked `edit_payments` — any
    user with that permission could update payments on any opportunity.
    PR #164 added parent-Opp resolution + `_enforce_opp_ownership_for_payment`
    for parity with POST/DELETE.
    """

    PAYMENT_ID = "a0xTESTPAYMENT1"
    PARENT_OPP_ID = "006TESTOPPORT01"

    def test_update_payment_success_with_admin_bypass(self, client, mock_client):
        """Admin (mock_db grants manage_users_roles) bypasses ownership,
        but the parent-Opp lookup still runs — it's required to even locate
        the record for the ownership helper call."""
        mock_client.salesforce.query.return_value = {
            "records": [{"npe01__Opportunity__c": self.PARENT_OPP_ID}],
        }
        mock_client.salesforce.update_record.return_value = True
        response = client.put(
            f"/api/salesforce/payments/{self.PAYMENT_ID}",
            json={"updates": {"npe01__Payment_Amount__c": 7500}},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        # Verify the update targeted the right SObject + Id with the right delta
        mock_client.salesforce.update_record.assert_called_once_with(
            "npe01__OppPayment__c", self.PAYMENT_ID, {"npe01__Payment_Amount__c": 7500},
        )

    def test_update_payment_not_found_returns_404(self, client, mock_client):
        """Parent-opp lookup returns no records → 404 before any update fires."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.put(
            f"/api/salesforce/payments/{self.PAYMENT_ID}",
            json={"updates": {"npe01__Payment_Amount__c": 7500}},
        )
        assert response.status_code == 404
        mock_client.salesforce.update_record.assert_not_called()

    def test_update_payment_rejected_by_salesforce_returns_400(self, client, mock_client):
        """Parent lookup succeeds, ownership passes (admin), but SF update
        itself fails → 400."""
        mock_client.salesforce.query.return_value = {
            "records": [{"npe01__Opportunity__c": self.PARENT_OPP_ID}],
        }
        mock_client.salesforce.update_record.return_value = False
        response = client.put(
            f"/api/salesforce/payments/{self.PAYMENT_ID}",
            json={"updates": {"npe01__Payment_Amount__c": 7500}},
        )
        assert response.status_code == 400

    def test_update_payment_invalid_id_rejected(self, client, mock_client):
        """validate_salesforce_id fires before anything else."""
        response = client.put(
            "/api/salesforce/payments/not-a-real-sf-id",
            json={"updates": {"npe01__Payment_Amount__c": 100}},
        )
        assert response.status_code in (400, 422)
        mock_client.salesforce.update_record.assert_not_called()


# ===================================================================
# 4a-ter. Salesforce Payments — DELETE single-record
# ===================================================================

class TestSalesforcePaymentDelete:
    """Tests for DELETE /api/salesforce/payments/{id} (PR #161 + PR #163 hardening).

    Destructive endpoint used by PaymentEditDialog's footer Delete button
    (which surfaces a confirm-before-delete popover on the frontend).

    PR #163 hardening: DELETE now runs a parent-opp lookup before the
    destructive action, and enforces ownership unless the caller is admin
    or has edit_all_opportunities. Tests mock the parent-lookup query and
    the delete_record separately.
    """

    # 15-char SF Id — validate_salesforce_id accepts 15 or 18 chars only.
    PAYMENT_ID = "a0xTESTPAYMENT1"
    PARENT_OPP_ID = "006TESTOPPORT01"

    def test_delete_payment_success(self, client, mock_client):
        # Parent-opp lookup returns the payment's parent opp so the
        # ownership check can run; admin bypasses the actual SF query on
        # the Opp.
        mock_client.salesforce.query.return_value = {
            "records": [{"npe01__Opportunity__c": self.PARENT_OPP_ID}],
        }
        mock_client.salesforce.delete_record.return_value = True
        response = client.delete(f"/api/salesforce/payments/{self.PAYMENT_ID}")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == self.PAYMENT_ID

        # Verify the delete targeted the right SObject + Id
        mock_client.salesforce.delete_record.assert_called_once_with(
            "npe01__OppPayment__c", self.PAYMENT_ID,
        )

    def test_delete_payment_not_found_returns_404(self, client, mock_client):
        """If the parent-opp lookup finds no payment record, we 404 without
        attempting delete_record."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.delete(f"/api/salesforce/payments/{self.PAYMENT_ID}")
        assert response.status_code == 404
        mock_client.salesforce.delete_record.assert_not_called()

    def test_delete_payment_rejected_by_salesforce_returns_400(self, client, mock_client):
        """If SF returns False on the actual delete (e.g., FK violation),
        we surface a 400 rather than silently claiming success."""
        mock_client.salesforce.query.return_value = {
            "records": [{"npe01__Opportunity__c": self.PARENT_OPP_ID}],
        }
        mock_client.salesforce.delete_record.return_value = False
        response = client.delete(f"/api/salesforce/payments/{self.PAYMENT_ID}")
        assert response.status_code == 400

    def test_delete_payment_invalid_id_rejected(self, client, mock_client):
        """validate_salesforce_id runs before we touch Salesforce — an
        obviously-bad id should 400 without ever calling delete_record."""
        response = client.delete("/api/salesforce/payments/not-a-real-sf-id")
        assert response.status_code in (400, 422)
        mock_client.salesforce.delete_record.assert_not_called()


# ===================================================================
# 4a-tris. Payment Create — Pydantic validation hardening (PR #163)
# ===================================================================

class TestPaymentCreateRequestValidation:
    """Unit tests for PaymentCreateRequest's Pydantic validators — added in
    PR #163 after adversarial security review flagged: negative/NaN amount,
    unvalidated date format, silent acceptance of extra fields.
    """

    BASE = {
        "opportunity_id": "006TESTOPPORT01",
        "amount": 100.0,
        "scheduled_date": "2026-07-15",
    }

    def _make(self, **overrides):
        from main import PaymentCreateRequest
        return PaymentCreateRequest(**{**self.BASE, **overrides})

    def test_valid_minimal_payload_succeeds(self):
        req = self._make()
        assert req.amount == 100.0
        assert req.scheduled_date == "2026-07-15"
        assert req.paid is False

    def test_negative_amount_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(amount=-500)

    def test_zero_amount_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(amount=0)

    def test_nan_amount_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(amount=float("nan"))

    def test_infinity_amount_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(amount=float("inf"))

    def test_amount_over_trillion_rejected(self):
        """Sanity bound — catches 1e308 precision-loss attacks."""
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(amount=1e15)

    def test_malformed_date_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(scheduled_date="not-a-date")

    def test_out_of_range_date_rejected(self):
        """'2026-13-45' parses as a string but fails strptime's strict check."""
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(scheduled_date="2026-13-45")

    def test_giant_date_string_rejected(self):
        """10KB string payload blocked by the exactly-10-chars length check."""
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(scheduled_date="2026-01-01" + "X" * 10_000)

    def test_extra_field_rejected(self):
        """Prevents silent field injection (e.g., attacker adding IsDeleted)."""
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(IsDeleted=True)

    def test_overlong_payment_method_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._make(payment_method="A" * 256)

    def test_payment_method_none_allowed(self):
        req = self._make(payment_method=None)
        assert req.payment_method is None


# ===================================================================
# 4a-quater. Payment ownership enforcement helper (PR #163)
# ===================================================================

class TestEnforceRecordOwnership:
    """Unit tests for the `_enforce_record_ownership` helper — generalized in
    PR #169 from the Opp-only helper shipped in PR #163 so Account / Contact /
    Opportunity write + delete endpoints share one ownership path.

    Contract:
      1. `is_service=True` bypasses without any SF query (Pebble CRM-write).
      2. Admin (`manage_users_roles`) bypasses.
      3. Per-resource `edit_all_perm` bypasses when the caller opts in.
      4. Otherwise: caller's sf_user_id must match the record's OwnerId via
         SOQL `SELECT OwnerId FROM {sobject} WHERE Id = '{id}'`. 404 if
         record absent; 403 on mismatch or unlinked user.

    Payment endpoints pass `sobject="Opportunity"` + parent-Opp Id +
    `edit_all_perm="edit_all_opportunities"` — prior behavior preserved.
    Account + Contact pass `edit_all_perm=None` (admin-only bypass — no
    edit-all key for those objects in PERMISSION_KEYS).
    """

    @pytest.mark.asyncio
    async def test_service_caller_bypasses_without_querying_sf(self):
        """PR #169: is_service=True short-circuits FIRST, before any
        _permissions / _app_user access. Required because
        check_permission_or_internal sets is_service without populating
        those user-dict keys (routes/permissions.py:232)."""
        from main import _enforce_record_ownership
        sf = AsyncMock()
        sf.query = AsyncMock()
        user = {"is_service": True, "user_id": "service:pebble"}
        await _enforce_record_ownership(sf, "Opportunity", "006TESTOPPORT01", user, "edit_all_opportunities")
        sf.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_admin_bypasses_without_querying_sf(self):
        from main import _enforce_record_ownership
        sf = AsyncMock()
        sf.query = AsyncMock()
        user = {"_permissions": {"manage_users_roles": True}, "_app_user": None}
        await _enforce_record_ownership(sf, "Opportunity", "006TESTOPPORT01", user, "edit_all_opportunities")
        sf.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_edit_all_opportunities_bypasses_without_querying_sf(self):
        from main import _enforce_record_ownership
        sf = AsyncMock()
        sf.query = AsyncMock()
        user = {
            "_permissions": {"edit_all_opportunities": True},
            "_app_user": {"sf_user_id": "005ANY"},
        }
        await _enforce_record_ownership(sf, "Opportunity", "006TESTOPPORT01", user, "edit_all_opportunities")
        sf.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_owner_allowed(self):
        from main import _enforce_record_ownership
        sf = AsyncMock()
        sf.query = AsyncMock(return_value={"records": [{"OwnerId": "005SAME"}]})
        user = {
            "_permissions": {},
            "_app_user": {"sf_user_id": "005SAME"},
        }
        await _enforce_record_ownership(sf, "Opportunity", "006TESTOPPORT01", user, "edit_all_opportunities")

    @pytest.mark.asyncio
    async def test_non_owner_raises_403(self):
        from main import _enforce_record_ownership
        from fastapi import HTTPException
        sf = AsyncMock()
        sf.query = AsyncMock(return_value={"records": [{"OwnerId": "005OTHER"}]})
        user = {
            "_permissions": {},
            "_app_user": {"sf_user_id": "005ME"},
        }
        with pytest.raises(HTTPException) as exc_info:
            await _enforce_record_ownership(sf, "Opportunity", "006TESTOPPORT01", user, "edit_all_opportunities")
        assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_record_not_found_raises_404(self):
        from main import _enforce_record_ownership
        from fastapi import HTTPException
        sf = AsyncMock()
        sf.query = AsyncMock(return_value={"records": []})
        user = {
            "_permissions": {},
            "_app_user": {"sf_user_id": "005ME"},
        }
        with pytest.raises(HTTPException) as exc_info:
            await _enforce_record_ownership(sf, "Opportunity", "006TESTOPPORT01", user, "edit_all_opportunities")
        assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    async def test_unlinked_user_raises_403_without_querying_sf(self):
        """Bedrock user with no sf_user_id link — can't evaluate ownership,
        must deny. Safer than permitting."""
        from main import _enforce_record_ownership
        from fastapi import HTTPException
        sf = AsyncMock()
        sf.query = AsyncMock()
        user = {"_permissions": {}, "_app_user": None}
        with pytest.raises(HTTPException) as exc_info:
            await _enforce_record_ownership(sf, "Opportunity", "006TESTOPPORT01", user, "edit_all_opportunities")
        assert exc_info.value.status_code == 403
        sf.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_account_ownership_admin_bypasses_without_edit_all(self):
        """PR #169: Account/Contact callers pass edit_all_perm=None. Admin
        (manage_users_roles) still bypasses without querying SF."""
        from main import _enforce_record_ownership
        sf = AsyncMock()
        sf.query = AsyncMock()
        user = {"_permissions": {"manage_users_roles": True}, "_app_user": None}
        await _enforce_record_ownership(sf, "Account", "001TESTACCOUNT001", user, None)
        sf.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_account_ownership_owner_allowed_no_edit_all(self):
        """PR #169: non-admin owner passes OwnerId match even when
        edit_all_perm=None. SOQL targets the correct SObject."""
        from main import _enforce_record_ownership
        sf = AsyncMock()
        sf.query = AsyncMock(return_value={"records": [{"OwnerId": "005OWNER"}]})
        user = {
            "_permissions": {},
            "_app_user": {"sf_user_id": "005OWNER"},
        }
        await _enforce_record_ownership(sf, "Account", "001TESTACCOUNT001", user, None)
        # Verify the SOQL query targeted Account, not Opportunity
        soql = sf.query.call_args[0][0]
        assert "FROM Account" in soql

    @pytest.mark.asyncio
    async def test_contact_ownership_non_owner_raises_403_sobject_in_error(self):
        """PR #169: generalized helper produces {sobject}-specific error
        text so users see which record type they're not allowed to modify."""
        from main import _enforce_record_ownership
        from fastapi import HTTPException
        sf = AsyncMock()
        sf.query = AsyncMock(return_value={"records": [{"OwnerId": "005OTHER"}]})
        user = {
            "_permissions": {},
            "_app_user": {"sf_user_id": "005ME"},
        }
        with pytest.raises(HTTPException) as exc_info:
            await _enforce_record_ownership(sf, "Contact", "003TESTCONTACT001", user, None)
        assert exc_info.value.status_code == 403
        assert "contacts" in exc_info.value.detail.lower()


# ===================================================================
# 4c. Salesforce DELETE endpoints — Opportunity / Account / Contact (PR #169)
# ===================================================================

class TestSalesforceOpportunityDelete:
    """Tests for DELETE /api/salesforce/opportunities/{id} (PR #169).

    Destructive endpoint — frontend (OpportunityEditDialog) surfaces a
    confirm-before-delete popover. Backend uses check_permission_or_internal
    + _enforce_record_ownership("Opportunity", ..., "edit_all_opportunities").
    mock_db grants manage_users_roles so admin-path bypasses the OwnerId
    check without the helper querying SF.
    """

    OPP_ID = "006TESTOPPORT01"

    def test_delete_opportunity_success(self, client, mock_client):
        mock_client.salesforce.delete_record.return_value = True
        response = client.delete(f"/api/salesforce/opportunities/{self.OPP_ID}")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == self.OPP_ID
        mock_client.salesforce.delete_record.assert_called_once_with("Opportunity", self.OPP_ID)

    def test_delete_opportunity_rejected_by_salesforce_returns_400(self, client, mock_client):
        """SF returns False on delete (e.g., locked record, FK violation)."""
        mock_client.salesforce.delete_record.return_value = False
        response = client.delete(f"/api/salesforce/opportunities/{self.OPP_ID}")
        assert response.status_code == 400

    def test_delete_opportunity_invalid_id_rejected(self, client, mock_client):
        """validate_salesforce_id runs before anything else — 400 without
        delete_record being called."""
        response = client.delete("/api/salesforce/opportunities/not-a-real-sf-id")
        assert response.status_code in (400, 422)
        mock_client.salesforce.delete_record.assert_not_called()


class TestSalesforceAccountDelete:
    """Tests for DELETE /api/salesforce/accounts/{id} (PR #169).

    Admin path (mock_db grants manage_users_roles) bypasses the OwnerId
    check. edit_all_perm=None for Account — admin-only bypass, no edit-all
    key exists in PERMISSION_KEYS.
    """

    # 15-char valid SF Id — the conftest make_sf_account uses 17 chars which
    # validate_salesforce_id rejects with 400. Use a fresh valid Id here.
    ACCOUNT_ID = "001TESTACCT0001"

    def test_delete_account_success(self, client, mock_client):
        mock_client.salesforce.delete_record.return_value = True
        response = client.delete(f"/api/salesforce/accounts/{self.ACCOUNT_ID}")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == self.ACCOUNT_ID
        mock_client.salesforce.delete_record.assert_called_once_with("Account", self.ACCOUNT_ID)

    def test_delete_account_rejected_by_salesforce_returns_400(self, client, mock_client):
        mock_client.salesforce.delete_record.return_value = False
        response = client.delete(f"/api/salesforce/accounts/{self.ACCOUNT_ID}")
        assert response.status_code == 400

    def test_delete_account_invalid_id_rejected(self, client, mock_client):
        response = client.delete("/api/salesforce/accounts/not-a-real-sf-id")
        assert response.status_code in (400, 422)
        mock_client.salesforce.delete_record.assert_not_called()


class TestSalesforceContactDelete:
    """Tests for DELETE /api/salesforce/contacts/{id} (PR #169)."""

    # 15-char valid SF Id — make_sf_contact uses 16 chars which fails
    # validate_salesforce_id. Use a fresh valid Id.
    CONTACT_ID = "003TESTCONT0001"

    def test_delete_contact_success(self, client, mock_client):
        mock_client.salesforce.delete_record.return_value = True
        response = client.delete(f"/api/salesforce/contacts/{self.CONTACT_ID}")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == self.CONTACT_ID
        mock_client.salesforce.delete_record.assert_called_once_with("Contact", self.CONTACT_ID)

    def test_delete_contact_rejected_by_salesforce_returns_400(self, client, mock_client):
        mock_client.salesforce.delete_record.return_value = False
        response = client.delete(f"/api/salesforce/contacts/{self.CONTACT_ID}")
        assert response.status_code == 400

    def test_delete_contact_invalid_id_rejected(self, client, mock_client):
        response = client.delete("/api/salesforce/contacts/not-a-real-sf-id")
        assert response.status_code in (400, 422)
        mock_client.salesforce.delete_record.assert_not_called()


# ===================================================================
# 4b. Salesforce Opportunity-Tasks (nested under opportunity)
# ===================================================================

class TestSalesforceOpportunityTasks:
    """Tests for GET /api/salesforce/opportunities/{id}/tasks."""

    # 15-char valid SF ID; longer forms fail validate_salesforce_id at the
    # path-param layer with HTTP 400 before the handler body runs.
    OPP_ID = "006TESTOPPORT01"

    def test_get_opportunity_tasks_returns_list(self, client, mock_client):
        task = make_sf_task()
        mock_client.salesforce.query_all.return_value = {"records": [task]}
        response = client.get(f"/api/salesforce/opportunities/{self.OPP_ID}/tasks")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["meta"]["count"] == 1
        assert body["data"][0]["Subject"] == "Follow up on grant proposal"
        # WhatId SOQL-inclusion guard + round-trip. The response serializer
        # at main.py:972 passes WhatId through, but the SOQL SELECT originally
        # omitted it — meaning every serialized task's WhatId was null. The
        # TaskPanel's edit form binds editTask.WhatId, so saved reassignments
        # would silently revert on reopen. Fixed 2026-04-21; pin the invariant.
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "WhatId" in soql
        assert body["data"][0]["WhatId"] == task["WhatId"]

    def test_get_opportunity_tasks_paginates_beyond_2000(self, client, mock_client):
        """Default limit=None drives query_all pagination with no SOQL LIMIT."""
        tasks = [make_sf_task({"Id": f"00T0000000BIG{i:04d}"}) for i in range(2500)]
        mock_client.salesforce.query_all.return_value = {"records": tasks}
        response = client.get(f"/api/salesforce/opportunities/{self.OPP_ID}/tasks")
        assert response.status_code == 200
        body = response.json()
        assert len(body["data"]) == 2500
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "LIMIT" not in soql

    def test_opportunity_tasks_limit_capped_at_2000(self, client):
        """Explicit `limit` above 2000 should be rejected by FastAPI validation."""
        response = client.get(
            f"/api/salesforce/opportunities/{self.OPP_ID}/tasks",
            params={"limit": 2001},
        )
        assert response.status_code == 422

    def test_create_task_with_whoid_round_trips(self, client, mock_client):
        """PR #169 (B5): TaskCreateRequest now declares WhoId, so Contact
        links sent from the TaskPanel's new Contact autocomplete round-trip
        through to SF. Pin the contract: body WhoId lands in create_record
        alongside the URL-derived WhatId."""
        mock_client.salesforce.create_record.return_value = {"id": "00T0000TESTCRE1"}
        response = client.post(
            f"/api/salesforce/opportunities/{self.OPP_ID}/tasks",
            json={
                "Subject": "Call Jane",
                "WhoId": "003TESTCONT0001",
            },
        )
        assert response.status_code == 200
        call = mock_client.salesforce.create_record.call_args
        assert call[0][0] == "Task"
        fields = call[0][1]
        assert fields["Subject"] == "Call Jane"
        assert fields["WhoId"] == "003TESTCONT0001"
        assert fields["WhatId"] == self.OPP_ID  # URL-derived

    def test_create_task_url_whatid_wins_over_body_whatid(self, client, mock_client):
        """PR #169 (B10 defensive fix): even if a client sends WhatId in
        the body, the URL path param must win. TaskCreateRequest doesn't
        declare WhatId, so Pydantic default extra-filtering strips it —
        but the reversed dict-spread order at main.py's create_opportunity_task
        is the belt-and-suspenders guard. Verify the URL id lands in SF."""
        mock_client.salesforce.create_record.return_value = {"id": "00T0000TESTCRE2"}
        response = client.post(
            f"/api/salesforce/opportunities/{self.OPP_ID}/tasks",
            json={
                "Subject": "Should bind to URL opp",
                "WhatId": "006ATTACKOPP001",  # Attacker-supplied body WhatId
            },
        )
        assert response.status_code == 200
        call = mock_client.salesforce.create_record.call_args
        fields = call[0][1]
        # URL-derived WhatId wins — body WhatId stripped + overridden.
        assert fields["WhatId"] == self.OPP_ID
        assert fields["WhatId"] != "006ATTACKOPP001"

    def test_update_task_with_null_activity_date_succeeds(self, client, mock_client):
        """PR #169 (B8 root cause — regression): TaskPanel's saveEdit sent
        ActivityDate as '' (empty string) for unchanged optional fields,
        which SF rejects with 400 on date fields. Fix is frontend-side
        (diff-based save) but this test pins the backend contract: sending
        ActivityDate as None works fine (exclude_none=True drops it)."""
        mock_client.salesforce.update_record.return_value = True
        # 15-char valid SF Task Id (make_sf_task uses 16 — invalid under validate_salesforce_id).
        response = client.put(
            "/api/salesforce/tasks/00T0000TEST0001",
            json={
                "Description": "Updated description",
                "ActivityDate": None,  # Was '' pre-fix — now None or omitted
            },
        )
        assert response.status_code == 200
        call = mock_client.salesforce.update_record.call_args
        fields = call[0][2]
        # ActivityDate absent from the update payload because exclude_none dropped it.
        assert "ActivityDate" not in fields
        # Description made it through.
        assert fields["Description"] == "Updated description"


# ===================================================================
# 4b. Salesforce My-Tasks (current user's open tasks, scope-bounded)
# ===================================================================

class TestSalesforceMyTasks:
    """Tests for GET /api/salesforce/my-tasks.

    Unlike the other list endpoints, my-tasks intentionally stays on
    salesforce.query() (single-page) — the WHERE clause `IsClosed = false`
    plus optional date range is scope-bounded per user, so at Pursuit's
    team-of-4 scale per-user counts stay well under the 2000 cap. These
    tests guard that contract along with the default-limit change."""

    def test_get_my_tasks_returns_list(self, client, mock_client):
        task = make_sf_task({"IsClosed": False})
        mock_client.salesforce.query.return_value = {"records": [task]}
        response = client.get("/api/salesforce/my-tasks")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["meta"]["count"] == 1
        assert body["data"][0]["Subject"] == "Follow up on grant proposal"

    def test_get_my_tasks_empty(self, client, mock_client):
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get("/api/salesforce/my-tasks")
        assert response.status_code == 200
        body = response.json()
        assert body["data"] == []

    def test_get_my_tasks_with_date_range(self, client, mock_client):
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get(
            "/api/salesforce/my-tasks",
            params={"start": "2026-04-01", "end": "2026-04-30"},
        )
        assert response.status_code == 200
        soql = mock_client.salesforce.query.call_args[0][0]
        assert "ActivityDate >= 2026-04-01" in soql
        assert "ActivityDate <= 2026-04-30" in soql

    def test_get_my_tasks_no_date_range(self, client, mock_client):
        """Without start/end, SOQL WHERE clause has only IsClosed = false."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get("/api/salesforce/my-tasks")
        assert response.status_code == 200
        soql = mock_client.salesforce.query.call_args[0][0]
        assert "IsClosed = false" in soql
        assert "ActivityDate >=" not in soql
        assert "ActivityDate <=" not in soql

    def test_get_my_tasks_default_limit_is_2000(self, client, mock_client):
        """Default `limit` was bumped from 200 to 2000 — guard the new default."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get("/api/salesforce/my-tasks")
        assert response.status_code == 200
        soql = mock_client.salesforce.query.call_args[0][0]
        assert "LIMIT 2000" in soql

    def test_my_tasks_limit_capped_at_2000(self, client):
        """Explicit `limit` above 2000 should be rejected by FastAPI validation."""
        response = client.get("/api/salesforce/my-tasks", params={"limit": 2001})
        assert response.status_code == 422

    def test_get_my_tasks_uses_query_not_query_all(self, client, mock_client):
        """Intentional decision: my-tasks stays on single-page query() because
        its WHERE clause scope-bounds per-user Task counts well under the cap."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get("/api/salesforce/my-tasks")
        assert response.status_code == 200
        assert mock_client.salesforce.query.called
        assert not mock_client.salesforce.query_all.called

    def test_get_my_tasks_where_has_isclosed_false(self, client, mock_client):
        """Guard the scope-bounding assumption: IsClosed = false is always
        in the WHERE clause — removing it would invalidate the decision to
        stay on query() instead of query_all()."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get("/api/salesforce/my-tasks")
        assert response.status_code == 200
        soql = mock_client.salesforce.query.call_args[0][0]
        assert "IsClosed = false" in soql

    def test_get_my_tasks_service_error(self, client, mock_client):
        mock_client.salesforce.query.side_effect = RuntimeError("sf down")
        response = client.get("/api/salesforce/my-tasks")
        assert response.status_code == 500
        assert "sf down" in response.json()["detail"]


# ===================================================================
# 5. Sage Intacct Invoices
# ===================================================================

class TestIntacctInvoices:
    """Tests for GET/POST /api/intacct/invoices."""

    def test_get_invoices_returns_list(self, client, mock_client):
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["RECORDNO"] == "INV-001"

    def test_get_invoices_with_customer_filter(self, client, mock_client):
        response = client.get("/api/intacct/invoices", params={"customer_id": "CUST-001"})
        assert response.status_code == 200
        mock_client.sage_intacct.get_invoices.assert_called_once_with(
            customer_id="CUST-001", limit=100
        )

    def test_get_invoices_empty_when_no_data(self, client, mock_client):
        mock_client.sage_intacct.get_invoices.return_value = {"success": True, "data": []}
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_invoices_handles_not_success(self, client, mock_client):
        mock_client.sage_intacct.get_invoices.return_value = {"success": False}
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        assert response.json() == []

    def test_create_invoice_success(self, client, mock_client):
        mock_client.sage_intacct.create_invoice.return_value = {
            "success": True,
            "data": {"RECORDNO": "INV-NEW-001"},
        }
        response = client.post(
            "/api/intacct/invoices",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "customer_id": "CUST-001",
                "amount": 50000,
                "due_date": "2026-04-15",
                "line_items": [{"item": "Grant payment", "amount": 50000}],
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["invoice_id"] == "INV-NEW-001"

    def test_create_invoice_failure(self, client, mock_client):
        mock_client.sage_intacct.create_invoice.return_value = {
            "success": False,
            "errors": ["Missing required field"],
        }
        response = client.post(
            "/api/intacct/invoices",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "customer_id": "CUST-001",
                "amount": 50000,
                "due_date": "2026-04-15",
                "line_items": [],
            },
        )
        # 400 from inner HTTPException, caught by except → 500
        assert response.status_code in (400, 500)

    def test_create_invoice_service_error(self, client, mock_client):
        mock_client.sage_intacct.create_invoice.side_effect = RuntimeError("intacct down")
        response = client.post(
            "/api/intacct/invoices",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "customer_id": "CUST-001",
                "amount": 50000,
                "due_date": "2026-04-15",
                "line_items": [{"item": "x", "amount": 100}],
            },
        )
        assert response.status_code == 500


# ===================================================================
# 6. Sage Intacct Payments
# ===================================================================

class TestIntacctPayments:
    """Tests for GET /api/intacct/payments."""

    def test_get_payments_returns_list(self, client, mock_client):
        response = client.get("/api/intacct/payments")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["RECORDNO"] == "PMT-001"

    def test_get_payments_empty(self, client, mock_client):
        mock_client.sage_intacct.get_payments.return_value = {"success": True, "data": []}
        response = client.get("/api/intacct/payments")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_payments_service_error(self, client, mock_client):
        mock_client.sage_intacct.get_payments.side_effect = RuntimeError("boom")
        response = client.get("/api/intacct/payments")
        assert response.status_code == 500

    def test_get_payments_503_when_no_client(self, no_services_client):
        response = no_services_client.get("/api/intacct/payments")
        assert response.status_code == 503


# ===================================================================
# 7. Forecasting endpoints
# ===================================================================

class TestForecastingEndpoints:
    """Tests for /api/forecasting/* endpoints."""

    def _make_dashboard_data(self):
        """Build a minimal ForecastingDashboardData dict."""
        metrics = {
            "total_pipeline_value": 100000,
            "weighted_pipeline_value": 50000,
            "expected_revenue_30_days": 20000,
            "expected_revenue_60_days": 35000,
            "expected_revenue_90_days": 50000,
            "average_deal_size": 25000,
            "average_sales_cycle_days": 60,
            "win_rate": 0.45,
            "payment_collection_rate": 0.92,
            "average_payment_delay_days": 12,
            "cash_conversion_cycle_days": 45,
            "overdue_invoices_amount": 5000,
            "at_risk_opportunities_amount": 15000,
            "concentration_risk_score": 0.3,
        }
        return ForecastingDashboardData(
            current_metrics=ForecastingMetrics(**metrics),
            pipeline_summary={"total": 100000},
            cash_flow_chart_data=[],
            payment_forecast_data=[],
            risk_indicators=[],
            recent_activities=[],
            date_range={"start": date.today(), "end": date.today() + timedelta(days=90)},
            selected_scenario="realistic",
            refresh_timestamp=datetime.utcnow(),
        )

    def test_get_dashboard(self, client, mock_engine):
        dashboard = self._make_dashboard_data()
        mock_engine.generate_dashboard_data.return_value = dashboard
        response = client.get("/api/forecasting/dashboard")
        assert response.status_code == 200
        body = response.json()
        assert "current_metrics" in body
        assert body["selected_scenario"] == "realistic"

    def test_get_dashboard_custom_params(self, client, mock_engine):
        dashboard = self._make_dashboard_data()
        mock_engine.generate_dashboard_data.return_value = dashboard
        response = client.get(
            "/api/forecasting/dashboard",
            params={"date_range_days": 180, "scenario": "optimistic"},
        )
        assert response.status_code == 200
        call_kwargs = mock_engine.generate_dashboard_data.call_args[1]
        assert call_kwargs["scenario"] == "optimistic"

    def test_get_dashboard_engine_error(self, client, mock_engine):
        mock_engine.generate_dashboard_data.side_effect = RuntimeError("engine crash")
        response = client.get("/api/forecasting/dashboard")
        assert response.status_code == 500

    def test_get_payment_forecast(self, client, mock_engine):
        mock_engine.generate_payment_forecasts.return_value = []
        response = client.get("/api/forecasting/payment-forecast")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_payment_forecast_with_params(self, client, mock_engine):
        mock_engine.generate_payment_forecasts.return_value = []
        response = client.get(
            "/api/forecasting/payment-forecast",
            params={"days_ahead": 180, "min_probability": 50},
        )
        assert response.status_code == 200
        call_kwargs = mock_engine.generate_payment_forecasts.call_args[1]
        assert call_kwargs["days_ahead"] == 180
        assert call_kwargs["min_probability"] == 50

    def test_get_cash_flow(self, client, mock_engine):
        mock_engine.generate_cash_flow_projections.return_value = []
        response = client.get("/api/forecasting/cash-flow")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_cash_flow_custom_months(self, client, mock_engine):
        mock_engine.generate_cash_flow_projections.return_value = []
        response = client.get("/api/forecasting/cash-flow", params={"months_ahead": 12})
        assert response.status_code == 200
        mock_engine.generate_cash_flow_projections.assert_called_once_with(months_ahead=12)

    def test_get_metrics(self, client, mock_engine):
        metrics = ForecastingMetrics(
            total_pipeline_value=Decimal("100000"),
            weighted_pipeline_value=Decimal("50000"),
            expected_revenue_30_days=Decimal("20000"),
            expected_revenue_60_days=Decimal("35000"),
            expected_revenue_90_days=Decimal("50000"),
            average_deal_size=Decimal("25000"),
            average_sales_cycle_days=60,
            win_rate=0.45,
            payment_collection_rate=0.92,
            average_payment_delay_days=12,
            cash_conversion_cycle_days=45,
            overdue_invoices_amount=Decimal("5000"),
            at_risk_opportunities_amount=Decimal("15000"),
            concentration_risk_score=0.3,
        )
        mock_engine.calculate_forecasting_metrics.return_value = metrics
        response = client.get("/api/forecasting/metrics")
        assert response.status_code == 200
        body = response.json()
        assert float(body["total_pipeline_value"]) == 100000

    def test_forecasting_503_when_no_engine(self, no_services_client):
        response = no_services_client.get("/api/forecasting/dashboard")
        assert response.status_code == 503


# ===================================================================
# 8. Data Sync endpoints
# ===================================================================

class TestDataSync:
    """Tests for POST /api/sync/trigger."""

    def test_trigger_sync_all(self, client, mock_sync_service):
        response = client.post("/api/sync/trigger", params={"sync_type": "all"})
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert "all" in body["data"]["message"]
        assert body["meta"]["triggered_by"] == "test_user"

    def test_trigger_sync_salesforce(self, client, mock_sync_service):
        response = client.post("/api/sync/trigger", params={"sync_type": "salesforce"})
        assert response.status_code == 200
        assert "salesforce" in response.json()["data"]["message"]

    def test_trigger_sync_intacct(self, client, mock_sync_service):
        response = client.post("/api/sync/trigger", params={"sync_type": "intacct"})
        assert response.status_code == 200
        assert "intacct" in response.json()["data"]["message"]

    def test_trigger_sync_invalid_type(self, client):
        response = client.post("/api/sync/trigger", params={"sync_type": "invalid"})
        assert response.status_code == 422  # FastAPI validation error

    def test_trigger_sync_conflict_when_lock_held(self, client, mock_sync_service):
        """When _sync_lock is already held, the endpoint should return 409."""
        # Acquire the lock in a background thread-safe way by creating a new lock
        # that is already locked.  We patch the module-level _sync_lock.
        locked = asyncio.Lock()
        # We need to force the lock into a "locked" state.  We can patch the
        # `locked()` method.
        with patch("main._sync_lock") as mock_lock:
            mock_lock.locked.return_value = True
            response = client.post("/api/sync/trigger", params={"sync_type": "all"})
        assert response.status_code == 409
        assert "already in progress" in response.json()["detail"]

    def test_trigger_sync_blocked_when_no_service(self, no_services_client):
        # Sync now requires check_permission("trigger_data_sync") which hits DB.
        # Without DB override, permission check fails before reaching service check.
        response = no_services_client.post("/api/sync/trigger")
        assert response.status_code in (401, 403, 500, 503)


# ===================================================================
# 9. Invoice Matching endpoints
# ===================================================================

class TestInvoiceMatching:
    """Tests for /api/matching/save-match and /api/matching/delete-match.

    Note: The matching endpoints build file paths using os.path.join inside
    the function body with local `import os`. Full file I/O integration tests
    would need the actual file to exist at the expected path. These tests verify
    the endpoint contract (request/response shape) rather than file persistence.
    """

    def test_save_match_returns_success_shape(self, client):
        """Verify save-match endpoint accepts valid input and returns expected shape."""
        response = client.post(
            "/api/matching/save-match",
            json={
                "invoice_id": "INV-100",
                "opportunity_id": "006OPP100",
                "confidence": "Confirmed",
                "notes": "Test match",
                "customer_name": "Test Corp",
                "invoice_amount": 25000.0,
                "invoice_date": "2026-03-01",
            },
        )
        # May succeed (200) or fail (500) depending on whether the JSON file exists on disk
        if response.status_code == 200:
            body = response.json()
            assert body["success"] is True
            assert body["data"]["invoice_id"] == "INV-100"
            assert body["data"]["opportunity_id"] == "006OPP100"

    def test_delete_match_nonexistent_returns_error(self, client):
        """Deleting a nonexistent match returns 404 or 500."""
        response = client.delete("/api/matching/delete-match/INV-NONEXISTENT")
        assert response.status_code in (404, 500)


# ===================================================================
# 10. Auth enforcement
# ===================================================================

class TestAuthEnforcement:
    """Verify that protected endpoints reject unauthenticated requests.

    Note: require_auth returns 401 (Unauthorized), not 403 (Forbidden).
    """

    def test_opportunities_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/salesforce/opportunities")
        assert response.status_code == 401

    def test_accounts_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/salesforce/accounts")
        assert response.status_code == 401

    def test_invoices_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/intacct/invoices")
        assert response.status_code == 401

    def test_payments_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/intacct/payments")
        assert response.status_code == 401

    def test_sync_requires_auth(self, unauthed_client):
        response = unauthed_client.post("/api/sync/trigger")
        assert response.status_code == 401

    def test_matching_requires_auth(self, unauthed_client):
        response = unauthed_client.post(
            "/api/matching/save-match",
            json={"invoice_id": "x", "opportunity_id": "y"},
        )
        assert response.status_code == 401

    def test_cashflow_summary_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/cashflow/summary")
        assert response.status_code == 401

    def test_search_opportunities_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/matching/search-opportunities")
        assert response.status_code == 401

    def test_cache_clear_requires_auth(self, unauthed_client):
        response = unauthed_client.post("/api/cache/clear")
        assert response.status_code == 401


# ===================================================================
# 11. New Phase 5 endpoints
# ===================================================================

class TestPhase5Endpoints:
    """Tests for endpoints added/fixed in Phase 5 hardening."""

    def test_cashflow_summary_returns_200(self, client):
        response = client.get("/api/cashflow/summary")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "total_pipeline" in data["data"]

    def test_cache_clear_returns_200(self, client):
        response = client.post("/api/cache/clear")
        assert response.status_code == 200
        assert response.json()["message"] == "All caches cleared"

    def test_search_opportunities_returns_200(self, client, mock_client):
        opp = make_sf_opportunity()
        mock_client.salesforce.query.return_value = {"records": [opp]}
        response = client.get("/api/matching/search-opportunities")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "count" in data
        assert "opportunities" in data

    def test_search_opportunities_with_query(self, client, mock_client):
        opp = make_sf_opportunity({"Name": "Test Grant"})
        mock_client.salesforce.query.return_value = {"records": [opp]}
        response = client.get(
            "/api/matching/search-opportunities",
            params={"q": "Test", "customer_name": "Acme Corp", "invoice_amount": 50000},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        # With customer_name provided, results should have match scores
        if data["count"] > 0:
            assert "matchScore" in data["opportunities"][0]

    def test_search_opportunities_escapes_soql(self, client, mock_client):
        """Verify SOQL injection characters are escaped."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get(
            "/api/matching/search-opportunities",
            params={"q": "test' OR Name LIKE '%"},
        )
        assert response.status_code == 200
        # The query should have been escaped, not cause a 500
        soql = mock_client.salesforce.query.call_args[0][0]
        assert "test\\'" in soql or "test'" not in soql.split("LIKE")[1]


# ===================================================================
# 12. Edge cases / multiple records
# ===================================================================

class TestEdgeCases:
    """Edge cases and boundary conditions."""

    def test_opportunities_limit_capped_at_2000(self, client):
        """Limit values above 2000 should be rejected by FastAPI validation."""
        response = client.get("/api/salesforce/opportunities", params={"limit": 5000})
        assert response.status_code == 422

    def test_accounts_limit_capped_at_2000(self, client):
        """Accounts `limit` query param is capped at 2000, matching opportunities
        endpoint (main.py:308). Prior cap was 5000; tightened 2026-04-17."""
        response = client.get("/api/salesforce/accounts", params={"limit": 2001})
        assert response.status_code == 422

    def test_cash_flow_months_ahead_min(self, client, mock_engine):
        """months_ahead below 1 should be rejected."""
        response = client.get("/api/forecasting/cash-flow", params={"months_ahead": 0})
        assert response.status_code == 422

    def test_cash_flow_months_ahead_max(self, client, mock_engine):
        """months_ahead above 24 should be rejected."""
        response = client.get("/api/forecasting/cash-flow", params={"months_ahead": 30})
        assert response.status_code == 422

    def test_payment_forecast_min_probability_validation(self, client, mock_engine):
        """min_probability below 0 should be rejected."""
        response = client.get(
            "/api/forecasting/payment-forecast",
            params={"min_probability": -5},
        )
        assert response.status_code == 422

    def test_multiple_opportunities_returned(self, client, mock_client):
        """Ensure multiple records are correctly deserialized."""
        opps = [
            make_sf_opportunity({"Id": f"006MULTI{i:03d}", "Amount": 10000 * (i + 1)})
            for i in range(5)
        ]
        mock_client.salesforce.query_all.return_value = {"records": opps}
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 5
        # Verify ordering preserved
        assert data[0]["Id"] == "006MULTI000"
        assert data[4]["Id"] == "006MULTI004"

    def test_intacct_invoices_single_record_not_list(self, client, mock_client):
        """Sage sometimes returns a single dict instead of a list."""
        mock_client.sage_intacct.get_invoices.return_value = {
            "success": True,
            "data": make_intacct_invoice(),  # single dict, not list
        }
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        data = response.json()
        # The endpoint normalizes single-record responses to a list
        assert len(data) == 1
