"""Data models for financial forecasting system."""

from typing import Any, Dict, List, Optional, Union
from datetime import datetime, date
from decimal import Decimal
from enum import Enum
from pydantic import BaseModel, Field, validator


class OpportunityStage(str, Enum):
    """Pursuit's Salesforce opportunity stages (custom picklist)."""
    NONE = "--None--"
    LEAD_GEN = "Lead Gen"
    NEW_LEAD = "New Lead"
    QUALIFYING = "Qualifying"
    ASK_IN_PROGRESS = "Ask in Progress"
    PROPOSAL_SUBMITTED = "Proposal Submitted"
    CONTRACT_CREATION = "Contract Creation"
    CONTRACTING = "Contracting"
    COLLECTING = "Collecting / In Effect"
    CLOSED_DID_NOT_FULFILL = "Closed / Did not Fulfill"
    CLOSED_COMPLETED = "Closed / Completed"
    CLOSED_LOST = "Closed Lost"
    WITHDRAWN = "Withdrawn"


# Derived stage groups — single source of truth
OPEN_STAGES = frozenset({
    OpportunityStage.LEAD_GEN,
    OpportunityStage.NEW_LEAD,
    OpportunityStage.QUALIFYING,
    OpportunityStage.ASK_IN_PROGRESS,
    OpportunityStage.PROPOSAL_SUBMITTED,
    OpportunityStage.CONTRACT_CREATION,
    OpportunityStage.CONTRACTING,
})

COLLECTING_STAGES = frozenset({OpportunityStage.COLLECTING})

CLOSED_STAGES = frozenset({
    OpportunityStage.CLOSED_DID_NOT_FULFILL,
    OpportunityStage.CLOSED_COMPLETED,
    OpportunityStage.CLOSED_LOST,
    OpportunityStage.WITHDRAWN,
})


# String-valued bucket sets — admit stage values outside the OpportunityStage enum
# (notably "Closed Won", the Donorbox-auto-populated philanthropy stage, ~575 live
# records). Mirror of frontend/src/types/salesforce.ts WON_STAGES / LOST_STAGES /
# COLLECTING_STAGES / PAYMENT_RECEIVED_STAGES. Consumers: F2 Intacct bundle (deferred)
# + forecasting_engine follow-up. See tasks/f1-stage-buckets-plan.md.
WON_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.COLLECTING.value,          # "Collecting / In Effect"
    OpportunityStage.CLOSED_COMPLETED.value,    # "Closed / Completed"
    "Closed Won",                               # Donorbox philanthropy — not in enum
})

LOST_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.CLOSED_LOST.value,
    OpportunityStage.WITHDRAWN.value,
    OpportunityStage.CLOSED_DID_NOT_FULFILL.value,
})

COLLECTING_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.COLLECTING.value,
})

PAYMENT_RECEIVED_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.CLOSED_COMPLETED.value,
    "Closed Won",
})


class PaymentTerms(str, Enum):
    """Common payment terms."""
    NET_15 = "Net 15"
    NET_30 = "Net 30"
    NET_45 = "Net 45"
    NET_60 = "Net 60"
    NET_90 = "Net 90"
    IMMEDIATE = "Immediate"
    COD = "COD"


class InvoiceStatus(str, Enum):
    """Invoice status options."""
    DRAFT = "Draft"
    SENT = "Sent"
    VIEWED = "Viewed"
    PARTIAL = "Partial"
    PAID = "Paid"
    OVERDUE = "Overdue"
    CANCELLED = "Cancelled"


# Activity Models (local PostgreSQL — bedrock.activity table)

class ActivityType(str, Enum):
    """Activity type — matches CHECK constraint in bedrock.activity."""
    CALL = "call"
    EMAIL = "email"
    MEETING = "meeting"
    NOTE = "note"
    SLACK_MESSAGE = "slack-message"
    CALENDAR_EVENT = "calendar-event"


class ActivitySource(str, Enum):
    """Activity source — matches CHECK constraint in bedrock.activity."""
    SALESFORCE = "salesforce"
    EXTENSION = "extension"
    MANUAL = "manual"
    GMAIL_SYNC = "gmail-sync"
    CALENDAR_SYNC = "calendar-sync"


class ActivityCreate(BaseModel):
    """POST /api/activities request body."""
    type: ActivityType
    subject: str
    activity_date: datetime
    source: ActivitySource
    description: Optional[str] = None
    description_html: Optional[str] = None
    opportunity_id: Optional[str] = None
    account_id: Optional[str] = None
    contact_ids: List[str] = []
    project_task_id: Optional[str] = None
    sf_task_id: Optional[str] = None
    source_ref: Optional[str] = None
    source_thread_id: Optional[str] = None
    email_from: Optional[str] = None
    email_to: Optional[List[str]] = None
    email_cc: Optional[List[str]] = None
    email_snippet: Optional[str] = None
    meeting_duration_minutes: Optional[int] = None
    meeting_attendees: Optional[List[Dict[str, Any]]] = None
    meeting_location: Optional[str] = None
    logged_by: Optional[str] = None
    owner_id: Optional[str] = None


class LogCallCreate(BaseModel):
    """POST /api/activities/log-call request body."""
    account_id: str
    subject: str
    activity_date: datetime
    description: Optional[str] = None
    contact_id: Optional[str] = None      # SF Contact Id (003…) → WhoId
    opportunity_id: Optional[str] = None  # SF Opportunity Id (006…) → WhatId


class ActivityUpdate(BaseModel):
    """PUT /api/activities/{id} request body. All fields optional (partial update)."""
    type: Optional[ActivityType] = None
    subject: Optional[str] = None
    activity_date: Optional[datetime] = None
    description: Optional[str] = None
    description_html: Optional[str] = None
    opportunity_id: Optional[str] = None
    account_id: Optional[str] = None
    contact_ids: Optional[List[str]] = None
    project_task_id: Optional[str] = None
    sf_task_id: Optional[str] = None
    source_ref: Optional[str] = None
    source_thread_id: Optional[str] = None
    email_from: Optional[str] = None
    email_to: Optional[List[str]] = None
    email_cc: Optional[List[str]] = None
    email_snippet: Optional[str] = None
    meeting_duration_minutes: Optional[int] = None
    meeting_attendees: Optional[List[Dict[str, Any]]] = None
    meeting_location: Optional[str] = None
    logged_by: Optional[str] = None
    owner_id: Optional[str] = None


class Activity(BaseModel):
    """Full activity response model (bedrock.activity row)."""
    id: str
    sf_id: Optional[str] = None
    sf_type: Optional[str] = None
    type: ActivityType
    subject: str
    description: Optional[str] = None
    description_html: Optional[str] = None
    activity_date: datetime
    opportunity_id: Optional[str] = None
    account_id: Optional[str] = None
    contact_ids: List[str] = []
    project_task_id: Optional[str] = None
    sf_task_id: Optional[str] = None
    source: ActivitySource
    source_ref: Optional[str] = None
    source_thread_id: Optional[str] = None
    email_from: Optional[str] = None
    email_to: Optional[List[str]] = None
    email_cc: Optional[List[str]] = None
    email_snippet: Optional[str] = None
    meeting_duration_minutes: Optional[int] = None
    meeting_attendees: Optional[List[Dict[str, Any]]] = None
    meeting_location: Optional[str] = None
    attachments: Optional[List[Dict[str, Any]]] = None
    logged_by: Optional[str] = None
    owner_id: Optional[str] = None
    sf_last_modified: Optional[datetime] = None
    synced_at: Optional[datetime] = None
    sf_sync_status: Optional[str] = "synced"
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ActivityInsightsResponse(BaseModel):
    """POST /api/activities/insights response."""
    summary: str
    key_findings: List[str] = []
    action_items: List[str] = []
    momentum: Optional[str] = None
    generated_at: str
    confidence: str = "structured"


# Salesforce Models

class SalesforceAccount(BaseModel):
    """Salesforce Account model."""
    id: str = Field(..., alias="Id")
    name: str = Field(..., alias="Name")
    type: Optional[str] = Field(None, alias="Type")
    industry: Optional[str] = Field(None, alias="Industry")
    annual_revenue: Optional[Decimal] = Field(None, alias="AnnualRevenue")
    number_of_employees: Optional[int] = Field(None, alias="NumberOfEmployees")
    billing_street: Optional[str] = Field(None, alias="BillingStreet")
    billing_city: Optional[str] = Field(None, alias="BillingCity")
    billing_state: Optional[str] = Field(None, alias="BillingState")
    billing_postal_code: Optional[str] = Field(None, alias="BillingPostalCode")
    billing_country: Optional[str] = Field(None, alias="BillingCountry")
    phone: Optional[str] = Field(None, alias="Phone")
    website: Optional[str] = Field(None, alias="Website")
    created_date: Optional[datetime] = Field(None, alias="CreatedDate")
    last_modified_date: Optional[datetime] = Field(None, alias="LastModifiedDate")

    class Config:
        allow_population_by_field_name = True


class SalesforceContact(BaseModel):
    """Salesforce Contact model."""
    id: str = Field(..., alias="Id")
    account_id: Optional[str] = Field(None, alias="AccountId")
    first_name: Optional[str] = Field(None, alias="FirstName")
    last_name: str = Field(..., alias="LastName")
    email: Optional[str] = Field(None, alias="Email")
    phone: Optional[str] = Field(None, alias="Phone")
    title: Optional[str] = Field(None, alias="Title")
    department: Optional[str] = Field(None, alias="Department")
    created_date: Optional[datetime] = Field(None, alias="CreatedDate")

    class Config:
        allow_population_by_field_name = True


class SalesforceOpportunity(BaseModel):
    """Salesforce Opportunity model."""
    id: str = Field(..., alias="Id")
    account_id: str = Field(..., alias="AccountId")
    name: str = Field(..., alias="Name")
    stage_name: OpportunityStage = Field(..., alias="StageName")
    amount: Optional[Decimal] = Field(None, alias="Amount")
    probability: Optional[int] = Field(None, alias="Probability")
    close_date: Optional[date] = Field(None, alias="CloseDate")
    expected_revenue: Optional[Decimal] = Field(None, alias="ExpectedRevenue")
    forecast_category: Optional[str] = Field(None, alias="ForecastCategory")
    lead_source: Optional[str] = Field(None, alias="LeadSource")
    next_step: Optional[str] = Field(None, alias="NextStep")
    description: Optional[str] = Field(None, alias="Description")
    owner_id: str = Field(..., alias="OwnerId")
    created_date: Optional[datetime] = Field(None, alias="CreatedDate")
    last_modified_date: Optional[datetime] = Field(None, alias="LastModifiedDate")
    
    # Custom fields for forecasting
    payment_terms: Optional[PaymentTerms] = Field(None, alias="Payment_Terms__c")
    contract_start_date: Optional[date] = Field(None, alias="Contract_Start_Date__c")
    contract_end_date: Optional[date] = Field(None, alias="Contract_End_Date__c")
    billing_frequency: Optional[str] = Field(None, alias="Billing_Frequency__c")

    # Pursuit custom fields
    renewal_repeat: Optional[str] = Field(None, alias="RenewalRepeat__c")
    active_opportunity: Optional[bool] = Field(None, alias="Active_Opportunity__c")
    type: Optional[str] = Field(None, alias="Type")
    last_activity_date: Optional[date] = Field(None, alias="LastActivityDate")

    # NPSP payment rollup fields (read-only in Salesforce)
    payments_made: Optional[Decimal] = Field(None, alias="npe01__Payments_Made__c")
    outstanding_payments: Optional[Decimal] = Field(None, alias="Outstanding_Payments__c")
    number_of_payments_received: Optional[int] = Field(None, alias="Number_of_Payments_Received__c")
    most_recent_payment_date: Optional[date] = Field(None, alias="Most_Recent_Payment_Date__c")
    last_actual_payment: Optional[Decimal] = Field(None, alias="Last_Actual_Payment__c")
    number_of_payments: Optional[int] = Field(None, alias="npe01__Number_of_Payments__c")
    payment_date: Optional[date] = Field(None, alias="PaymentDate__c")
    earliest_scheduled_payment: Optional[date] = Field(None, alias="Earliest_Scheduled_Payment__c")

    class Config:
        allow_population_by_field_name = True

    @validator('probability')
    def validate_probability(cls, v):
        if v is not None and (v < 0 or v > 100):
            raise ValueError('Probability must be between 0 and 100')
        return v


# Sage Intacct Models

class IntacctCustomer(BaseModel):
    """Sage Intacct Customer model."""
    customer_id: str = Field(..., alias="CUSTOMERID")
    name: str = Field(..., alias="NAME")
    display_contact: Optional[str] = Field(None, alias="DISPLAYCONTACT")
    company_name: Optional[str] = Field(None, alias="COMPANYNAME")
    print_as: Optional[str] = Field(None, alias="PRINTAS")
    taxable: Optional[bool] = Field(None, alias="TAXABLE")
    tax_id: Optional[str] = Field(None, alias="TAXID")
    credit_limit: Optional[Decimal] = Field(None, alias="CREDITLIMIT")
    total_due: Optional[Decimal] = Field(None, alias="TOTALDUE")
    status: Optional[str] = Field(None, alias="STATUS")
    when_created: Optional[datetime] = Field(None, alias="WHENCREATED")
    when_modified: Optional[datetime] = Field(None, alias="WHENMODIFIED")

    class Config:
        allow_population_by_field_name = True


class IntacctInvoice(BaseModel):
    """Sage Intacct Invoice model."""
    record_no: str = Field(..., alias="RECORDNO")
    customer_id: str = Field(..., alias="CUSTOMERID")
    customer_name: Optional[str] = Field(None, alias="CUSTOMERNAME")
    doc_number: Optional[str] = Field(None, alias="DOCNUMBER")
    description: Optional[str] = Field(None, alias="DESCRIPTION")
    total_amount: Optional[Decimal] = Field(None, alias="TOTALAMOUNT")
    total_paid: Optional[Decimal] = Field(None, alias="TOTALPAID")
    total_due: Optional[Decimal] = Field(None, alias="TOTALDUE")
    when_created: Optional[datetime] = Field(None, alias="WHENCREATED")
    when_posted: Optional[datetime] = Field(None, alias="WHENPOSTED")
    when_due: Optional[datetime] = Field(None, alias="WHENDUE")
    state: Optional[str] = Field(None, alias="STATE")
    
    class Config:
        allow_population_by_field_name = True


class IntacctPayment(BaseModel):
    """Sage Intacct Payment model."""
    record_no: str = Field(..., alias="RECORDNO")
    customer_id: str = Field(..., alias="CUSTOMERID")
    customer_name: Optional[str] = Field(None, alias="CUSTOMERNAME")
    receipt_date: Optional[datetime] = Field(None, alias="RECEIPTDATE")
    payment_amount: Optional[Decimal] = Field(None, alias="PAYMENTAMOUNT")
    payment_method: Optional[str] = Field(None, alias="PAYMENTMETHOD")
    reference_no: Optional[str] = Field(None, alias="REFERENCENO")
    description: Optional[str] = Field(None, alias="DESCRIPTION")
    when_created: Optional[datetime] = Field(None, alias="WHENCREATED")
    
    class Config:
        allow_population_by_field_name = True


# Forecasting Models

class PaymentForecast(BaseModel):
    """Payment forecast for an opportunity."""
    opportunity_id: str
    account_id: str
    account_name: str
    opportunity_name: str
    stage_name: OpportunityStage
    amount: Decimal
    probability: int
    expected_amount: Decimal
    close_date: date
    payment_terms: PaymentTerms
    expected_payment_date: date
    payment_probability: float  # Adjusted probability based on historical data
    risk_factors: List[str] = []
    
    @validator('expected_amount')
    def calculate_expected_amount(cls, v, values):
        if 'amount' in values and 'probability' in values:
            return values['amount'] * (values['probability'] / 100)
        return v


class CashFlowProjection(BaseModel):
    """Cash flow projection for a specific period."""
    period_start: date
    period_end: date
    opening_balance: Decimal
    projected_receipts: Decimal
    projected_payments: Decimal
    net_cash_flow: Decimal
    closing_balance: Decimal
    confidence_level: float  # 0.0 to 1.0
    
    @validator('closing_balance')
    def calculate_closing_balance(cls, v, values):
        if all(k in values for k in ['opening_balance', 'net_cash_flow']):
            return values['opening_balance'] + values['net_cash_flow']
        return v
    
    @validator('net_cash_flow')
    def calculate_net_cash_flow(cls, v, values):
        if all(k in values for k in ['projected_receipts', 'projected_payments']):
            return values['projected_receipts'] - values['projected_payments']
        return v


class ForecastingMetrics(BaseModel):
    """Key forecasting metrics and KPIs."""
    total_pipeline_value: Decimal
    weighted_pipeline_value: Decimal
    expected_revenue_30_days: Decimal
    expected_revenue_60_days: Decimal
    expected_revenue_90_days: Decimal
    average_deal_size: Decimal
    average_sales_cycle_days: int
    win_rate: float
    payment_collection_rate: float
    average_payment_delay_days: int
    cash_conversion_cycle_days: int
    
    # Risk indicators
    overdue_invoices_amount: Decimal
    at_risk_opportunities_amount: Decimal
    concentration_risk_score: float  # Based on customer concentration


class ForecastScenario(BaseModel):
    """Different forecasting scenarios (optimistic, realistic, pessimistic)."""
    scenario_name: str
    probability_multiplier: float  # Applied to opportunity probabilities
    payment_delay_factor: float  # Applied to payment timing
    collection_rate_adjustment: float  # Adjustment to collection rates
    description: str
    
    # Scenario results
    projected_revenue: Optional[Decimal] = None
    projected_cash_flow: Optional[Decimal] = None
    risk_level: Optional[str] = None


# Integration Models

class OpportunityInvoiceMapping(BaseModel):
    """Mapping between Salesforce opportunities and Sage Intacct invoices."""
    opportunity_id: str
    invoice_record_no: Optional[str] = None
    mapping_status: str  # "pending", "mapped", "invoiced", "paid"
    created_date: datetime
    invoice_trigger_stage: OpportunityStage
    invoice_amount: Optional[Decimal] = None
    invoice_date: Optional[date] = None
    payment_due_date: Optional[date] = None
    notes: Optional[str] = None


class ForecastingReport(BaseModel):
    """Comprehensive forecasting report."""
    report_id: str
    generated_date: datetime
    report_period_start: date
    report_period_end: date
    
    # Data sources
    opportunities: List[SalesforceOpportunity]
    invoices: List[IntacctInvoice]
    payments: List[IntacctPayment]
    
    # Forecasts
    payment_forecasts: List[PaymentForecast]
    cash_flow_projections: List[CashFlowProjection]
    
    # Metrics
    metrics: ForecastingMetrics
    scenarios: List[ForecastScenario]
    
    # Recommendations
    recommendations: List[str] = []
    risk_alerts: List[str] = []


# API Request/Response Models

from typing import Generic, TypeVar

T = TypeVar('T')


class ApiResponse(BaseModel, Generic[T]):
    """Standard API response envelope.

    All non-Pydantic-model endpoints should return this shape so the frontend
    can rely on a single contract: { success, data?, error?, meta? }.
    """
    success: bool
    data: Optional[Any] = None
    error: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None


class OpportunityUpdateRequest(BaseModel):
    """Request model for updating opportunities."""
    opportunity_id: Optional[str] = None  # handler uses path param; body field is legacy
    updates: Dict[str, Any]
    user_id: Optional[str] = None
    reason: Optional[str] = None


class InvoiceCreationRequest(BaseModel):
    """Request model for creating invoices."""
    opportunity_id: str
    customer_id: str
    amount: Decimal
    due_date: date
    line_items: List[Dict[str, Any]]
    notes: Optional[str] = None


class ForecastingDashboardData(BaseModel):
    """Data model for the forecasting dashboard."""
    current_metrics: ForecastingMetrics
    pipeline_summary: Dict[str, Any]
    cash_flow_chart_data: List[Dict[str, Any]]
    payment_forecast_data: List[Dict[str, Any]]
    risk_indicators: List[Dict[str, Any]]
    recent_activities: List[Dict[str, Any]]
    
    # Filters and settings
    date_range: Dict[str, date]
    selected_scenario: str
    refresh_timestamp: datetime

