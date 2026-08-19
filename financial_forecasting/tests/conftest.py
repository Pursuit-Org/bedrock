"""Shared test fixtures for financial forecasting backend tests."""

import sys
import os
import asyncio
from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from models import (
    OpportunityStage, PaymentTerms, InvoiceStatus,
    OPEN_STAGES, CLOSED_STAGES,
)
from forecasting_engine import ForecastingEngine
from data_sync import DataSyncService


# ---------------------------------------------------------------------------
# Event loop fixture for async tests
# ---------------------------------------------------------------------------

@pytest.fixture
def event_loop():
    """Create an event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(autouse=True)
def _restore_db_pool():
    """jobs_fakes.make_jobs_client swaps db._pool for a FakePool so routes
    that read via get_pool() stay hermetic. Restore the previous value after
    every test so the fake never leaks into unrelated tests."""
    import db as _db_module
    saved = _db_module._pool
    yield
    _db_module._pool = saved


# ---------------------------------------------------------------------------
# Salesforce mock data factories
# ---------------------------------------------------------------------------

def make_sf_opportunity(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Salesforce opportunity record."""
    opp = {
        "Id": "006TESTOPPORTUNITY01",
        "AccountId": "001TESTACCOUNT001",
        "Name": "Test Grant - Spring 2026",
        "StageName": "Qualifying",
        "Amount": 50000,
        "Probability": 40,
        "CloseDate": (date.today() + timedelta(days=30)).isoformat(),
        "ExpectedRevenue": 20000,
        "ForecastCategory": "Pipeline",
        "LeadSource": "Web",
        "NextStep": "Submit proposal",
        "Description": "Test opportunity",
        # RecordType.Name is the canonical label for "how we categorize this
        # opportunity" (e.g. Philanthropy vs. Other fee for service). The B2
        # 2026-04-19 fixture added Opportunity.Type with this value; A4
        # (2026-04-21) corrected the misdiagnosis — "Other fee for service"
        # is a RecordType.Name value, not a Type value. RecordTypeId is a
        # mock 18-char ID; RecordType.Name round-trips via the SOQL join in
        # get_opportunities (main.py SELECT includes RecordType.Name).
        "RecordTypeId": "012TESTRECORDTYPE01",
        "RecordType": {"Name": "Other fee for service"},
        # RenewalRepeat__c — Pursuit custom picklist {New, Renewal, Upsell}.
        # Load-bearing for Progress.tsx isRenewal() forecast logic and the
        # OpportunityEditDialog Renewal/Repeat picker. A4 (2026-04-21)
        # discovered it was missing from the get_opportunities SOQL; fixed
        # in the same PR. Default to None (matches a never-set SF field).
        "RenewalRepeat__c": None,
        "OwnerId": "005TESTOWNER00001",
        "CreatedDate": "2026-01-15T10:00:00.000+0000",
        "LastModifiedDate": "2026-03-10T14:30:00.000+0000",
        # NOTE: Payment_Terms__c / Contract_Start_Date__c /
        # Contract_End_Date__c / Billing_Frequency__c removed 2026-04-21
        # — they don't exist on Opportunity in Pursuit's live SF org.
        # test_forecasting_engine and test_forecasting_integration still
        # pass Payment_Terms__c via explicit overrides (forecasting code
        # reads it); not reintroducing as a default here since that's
        # misleading about Pursuit's real schema.
    }
    if overrides:
        opp.update(overrides)
    return opp


def make_sf_account(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Salesforce account record."""
    account = {
        "Id": "001TESTACCOUNT001",
        "Name": "Test Foundation Inc",
        "Type": "Customer",
        "Industry": "Nonprofit",
        "AnnualRevenue": 5000000,
        "NumberOfEmployees": 50,
        "BillingStreet": "123 Test St",
        "BillingCity": "New York",
        "BillingState": "NY",
        "BillingPostalCode": "10001",
        "BillingCountry": "US",
        "Phone": "555-0100",
        "Website": "https://testfoundation.org",
        "CreatedDate": "2025-01-01T00:00:00.000+0000",
        "LastModifiedDate": "2026-03-01T00:00:00.000+0000",
        "Intacct_Customer_ID__c": None,
    }
    if overrides:
        account.update(overrides)
    return account


def make_sf_contact(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Salesforce contact record."""
    contact = {
        "Id": "003TESTCONTACT001",
        "FirstName": "Jane",
        "LastName": "Donor",
        "Name": "Jane Donor",
        "AccountId": "001TESTACCOUNT001",
        "Title": "Program Director",
        "Email": "jane@testfoundation.org",
        "Phone": "555-0101",
        "Primary_Affiliation__c": "Test Foundation Inc",
        "CreatedDate": "2025-06-01T00:00:00.000+0000",
        "LastModifiedDate": "2026-02-15T00:00:00.000+0000",
    }
    if overrides:
        contact.update(overrides)
    return contact


# ---------------------------------------------------------------------------
# Sage Intacct mock data factories
# ---------------------------------------------------------------------------

def make_sf_task(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Salesforce Task record."""
    task = {
        "Id": "00T0000000TEST01",
        "Subject": "Follow up on grant proposal",
        "Status": "Completed",
        "Priority": "Normal",
        "ActivityDate": "2026-03-15",
        "Description": "Discussed next steps for spring grant",
        "OwnerId": "005TESTOWNER00001",
        "Owner": {"Name": "Test User"},
        "WhoId": "003TESTCONTACT001",
        "Who": {"Name": "Jane Donor"},
        "WhatId": "006TESTOPPORTUNITY01",
        "What": {"Name": "Test Grant - Spring 2026"},
        "Type": "Call",
        "TaskSubtype": "Call",
        "CreatedById": "005TESTOWNER00001",
        "CreatedBy": {"Name": "Test User"},
        "CreatedDate": "2026-03-10T10:00:00.000+0000",
        "LastModifiedDate": "2026-03-15T14:30:00.000+0000",
        "IsClosed": True,
        "CallType": "Outbound",
        "CallDurationInSeconds": 1800,
    }
    if overrides:
        task.update(overrides)
    return task


def make_sf_event(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Salesforce Event record."""
    event = {
        "Id": "00U0000000TEST01",
        "Subject": "Quarterly review meeting",
        "Description": "Annual grant review with program team",
        "StartDateTime": "2026-03-20T14:00:00.000+0000",
        "EndDateTime": "2026-03-20T15:00:00.000+0000",
        "OwnerId": "005TESTOWNER00001",
        "Owner": {"Name": "Test User"},
        "WhoId": "003TESTCONTACT001",
        "Who": {"Name": "Jane Donor"},
        "WhatId": "006TESTOPPORTUNITY01",
        "What": {"Name": "Test Grant - Spring 2026"},
        "Type": "Meeting",
        "Location": "Conference Room A",
        "DurationInMinutes": 60,
        "IsAllDayEvent": False,
        "CreatedById": "005TESTOWNER00001",
        "CreatedBy": {"Name": "Test User"},
        "CreatedDate": "2026-03-18T09:00:00.000+0000",
        "LastModifiedDate": "2026-03-20T16:00:00.000+0000",
    }
    if overrides:
        event.update(overrides)
    return event


def make_activity(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock bedrock.activity row (as returned by asyncpg)."""
    activity = {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "sf_id": "00T0000000TEST01",
        "sf_type": "Task",
        "type": "call",
        "subject": "Follow up on grant proposal",
        "description": "Discussed next steps for spring grant",
        "description_html": None,
        "activity_date": datetime(2026, 3, 15, 14, 30),
        "opportunity_id": "006TESTOPPORTUNITY01",
        "account_id": None,
        "contact_ids": ["003TESTCONTACT001"],
        "project_task_id": None,
        "sf_task_id": None,
        "source": "salesforce",
        "source_ref": None,
        "source_thread_id": None,
        "email_from": None,
        "email_to": None,
        "email_cc": None,
        "email_snippet": None,
        "meeting_duration_minutes": 30,
        "meeting_attendees": None,
        "meeting_location": None,
        "attachments": [],
        "logged_by": "005TESTOWNER00001",
        "owner_id": "005TESTOWNER00001",
        "sf_last_modified": datetime(2026, 3, 15, 14, 30),
        "synced_at": datetime(2026, 3, 15, 15, 0),
        "sf_sync_status": "synced",
        "search_vector": None,
        "deleted_at": None,
        "created_at": datetime(2026, 3, 15, 15, 0),
        "updated_at": datetime(2026, 3, 15, 15, 0),
    }
    if overrides:
        activity.update(overrides)
    return activity


def make_intacct_invoice(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Sage Intacct invoice record."""
    invoice = {
        "RECORDNO": "INV-001",
        "CUSTOMERID": "CUST-001",
        "CUSTOMERNAME": "Test Foundation Inc",
        "TOTALAMOUNT": "50000.00",
        "TOTALPAID": "0.00",
        "STATE": "Submitted",
        "WHENCREATED": "2026-03-01T00:00:00",
        "WHENDUE": "2026-03-31T00:00:00",
    }
    if overrides:
        invoice.update(overrides)
    return invoice


def make_intacct_payment(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Sage Intacct payment record."""
    payment = {
        "RECORDNO": "PMT-001",
        "CUSTOMERID": "CUST-001",
        "PAYMENTAMOUNT": "50000.00",
        "PAYMENTMETHOD": "Check",
        "RECEIPTDATE": "2026-03-15T00:00:00",
        "WHENCREATED": "2026-03-15T00:00:00",
    }
    if overrides:
        payment.update(overrides)
    return payment


def make_intacct_customer(overrides: Dict[str, Any] = None) -> Dict[str, Any]:
    """Create a mock Sage Intacct customer record."""
    customer = {
        "CUSTOMERID": "CUST-001",
        "NAME": "Test Foundation Inc",
        "DISPLAYCONTACT": "Test Foundation Inc",
        "TOTALDUE": "50000.00",
        "CREDITLIMIT": "100000.00",
        "WHENMODIFIED": "2026-03-10",
    }
    if overrides:
        customer.update(overrides)
    return customer


# ---------------------------------------------------------------------------
# Mock MCP services
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_salesforce_service():
    """Create a mock Salesforce MCP service."""
    service = AsyncMock()
    service.query = AsyncMock(return_value={"records": []})
    service.query_all = AsyncMock(return_value={"records": []})
    service.create_record = AsyncMock(return_value={"id": "006NEW0000000001"})
    service.update_record = AsyncMock(return_value=True)
    service.get_record = AsyncMock(return_value=make_sf_opportunity())
    service.is_authenticated = True
    service.get_service_info = AsyncMock(return_value={
        "service": "salesforce",
        "authenticated": True,
        "config": {"instance_url": "https://test.salesforce.com"},
    })
    return service


@pytest.fixture
def mock_sage_service():
    """Create a mock Sage Intacct MCP service."""
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
    service.get_customers = AsyncMock(return_value={
        "success": True,
        "data": [make_intacct_customer()],
    })
    service.get_financial_metrics = AsyncMock(return_value={
        "success": True,
        "data": {"total_revenue": 1000000},
    })
    service.is_authenticated = True
    service.get_service_info = AsyncMock(return_value={
        "service": "sage_intacct",
        "authenticated": True,
        "config": {},
    })
    return service


@pytest.fixture
def mock_mcp_client(mock_salesforce_service, mock_sage_service):
    """Create a mock UnifiedMCPClient with mocked services."""
    client = MagicMock()
    client.services = {
        "salesforce": mock_salesforce_service,
        "sage_intacct": mock_sage_service,
    }
    client._connected_services = {"salesforce", "sage_intacct"}
    # Public alias — data_sync._intacct_available / _salesforce_available read
    # the public `connected_services` property (see unified_client.py:303).
    # Without this, MagicMock auto-generates a child mock whose __contains__
    # returns False, causing 15 integration tests to silently early-return
    # at the availability check. Keep _connected_services for callers that
    # use the private attr directly (main.py, dependencies.py, etc.).
    client.connected_services = {"salesforce", "sage_intacct"}
    client.salesforce = mock_salesforce_service
    client.sage_intacct = mock_sage_service
    client.disconnect_all = AsyncMock()
    client.health_check = AsyncMock(return_value={
        "salesforce": {"status": "healthy"},
        "sage_intacct": {"status": "healthy"},
    })
    return client


# ---------------------------------------------------------------------------
# Service instances with mocked dependencies
# ---------------------------------------------------------------------------

@pytest.fixture
def forecasting_engine(mock_mcp_client):
    """Create a ForecastingEngine with mocked MCP client."""
    engine = ForecastingEngine(mock_mcp_client)
    # Pre-populate cache to avoid async I/O
    engine.historical_data_cache = {
        "closed_opportunities": [
            make_sf_opportunity({
                "Id": "006CLOSED001",
                "AccountId": "001TESTACCOUNT001",
                "StageName": "Closed / Completed",
                "Amount": 50000,
                "CreatedDate": "2025-01-01",
                "CloseDate": "2025-03-01",
            }),
            make_sf_opportunity({
                "Id": "006CLOSED002",
                "AccountId": "001TESTACCOUNT001",
                "StageName": "Closed / Completed",
                "Amount": 30000,
                "CreatedDate": "2025-04-01",
                "CloseDate": "2025-06-01",
            }),
            make_sf_opportunity({
                "Id": "006CLOSED003",
                "AccountId": "001TESTACCOUNT001",
                "StageName": "Closed Lost",
                "Amount": 40000,
                "CreatedDate": "2025-07-01",
                "CloseDate": "2025-09-01",
            }),
        ],
        "invoices": [make_intacct_invoice()],
        "payments": [make_intacct_payment()],
    }
    return engine


@pytest.fixture
def data_sync_service(mock_mcp_client):
    """Create a DataSyncService with mocked MCP client."""
    return DataSyncService(mock_mcp_client)


# ---------------------------------------------------------------------------
# Pipeline scenario factories
# ---------------------------------------------------------------------------

def make_pipeline_scenario(scenario: str = "mixed") -> List[Dict[str, Any]]:
    """Create common pipeline scenarios for testing.

    Scenarios:
        empty: no opportunities
        all_closed: all closed/completed
        all_open: all in early stages
        mixed: realistic mix of stages
        single_large: one large deal dominating
    """
    today = date.today()
    if scenario == "empty":
        return []

    if scenario == "all_closed":
        return [
            make_sf_opportunity({
                "Id": f"006CLOSED{i:03d}",
                "StageName": "Closed / Completed",
                "Amount": 30000 + (i * 10000),
                "Probability": 100,
                "CloseDate": (today - timedelta(days=30 + i * 10)).isoformat(),
            })
            for i in range(5)
        ]

    if scenario == "all_open":
        return [
            make_sf_opportunity({
                "Id": f"006OPEN{i:03d}",
                "StageName": "Lead Gen",
                "Amount": 20000 + (i * 5000),
                "Probability": 5,
                "CloseDate": (today + timedelta(days=60 + i * 30)).isoformat(),
            })
            for i in range(5)
        ]

    if scenario == "single_large":
        return [
            make_sf_opportunity({
                "Id": "006LARGE001",
                "StageName": "Contract Creation",
                "Amount": 500000,
                "Probability": 70,
                "CloseDate": (today + timedelta(days=14)).isoformat(),
            }),
            make_sf_opportunity({
                "Id": "006SMALL001",
                "StageName": "Qualifying",
                "Amount": 10000,
                "Probability": 30,
                "CloseDate": (today + timedelta(days=45)).isoformat(),
            }),
        ]

    # "mixed" — realistic scenario
    stages = [
        ("Lead Gen", 5, 90),
        ("Qualifying", 30, 60),
        ("Proposal Development", 50, 45),
        ("Contract Creation", 70, 20),
        ("Closed / Completed", 100, -10),
    ]
    return [
        make_sf_opportunity({
            "Id": f"006MIX{i:03d}",
            "StageName": stage,
            "Amount": 25000 + (i * 15000),
            "Probability": prob,
            "CloseDate": (today + timedelta(days=days)).isoformat(),
        })
        for i, (stage, prob, days) in enumerate(stages)
    ]
