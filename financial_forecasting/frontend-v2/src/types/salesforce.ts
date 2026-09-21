/**
 * Salesforce-shaped types — keys are PascalCase to match the SF REST API
 * (and per `tasks/lessons.md` 2026-03-26: SF returns PascalCase, do not
 * lowercase).
 *
 * Mirrors the field set returned by `GET /api/salesforce/accounts` in
 * financial_forecasting/main.py:535.
 */

export interface SfReference {
  Name?: string | null;
}

/**
 * Mirrors `GET /api/salesforce/users` (main.py:1299).
 */
export interface SfUser {
  Id: string;
  Name: string;
  Email?: string | null;
  IsActive?: boolean | null;
}

/** Playbook-defined Account Status, derived server-side. Values come
 *  from services/account_status.py — kept in sync there. */
export type AccountStatus =
  | "Deprioritized"
  | "On Hold"
  | "Prospect"
  | "Activating"
  | "Pursuing"
  | "Stewarding"
  | "Re-activating"
  | "Dormant";

export interface SfAccount {
  Id: string;
  Name: string;
  /** Playbook Account Status. Derived field, not stored on the SF
   *  record — see services/account_status.py for the rules. */
  account_status?: AccountStatus;
  Type?: string | null;
  Industry?: string | null;
  Phone?: string | null;
  Website?: string | null;
  Description?: string | null;
  BillingCity?: string | null;
  BillingState?: string | null;
  BillingCountry?: string | null;
  AnnualRevenue?: number | null;
  NumberOfEmployees?: number | null;
  AccountSource?: string | null;
  OwnerId?: string | null;
  Owner?: SfReference | null;
  RecordTypeId?: string | null;
  RecordType?: SfReference | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;
  LastActivityDate?: string | null;

  // Pursuit custom fields (from main.py:535 query)
  Account_Tier__c?: string | null;
  Active__c?: boolean | null;
  Qualification_Status__c?: string | null;
  Qualification_Date_Updated__c?: string | null;
  Qualification_Explanation__c?: string | null;
  Company_Size__c?: string | null;
  Philanthropy__c?: boolean | null;
  Fee_For_Service__c?: boolean | null;
  Hiring__c?: boolean | null;
  Investment__c?: boolean | null;
  Volunteering__c?: boolean | null;
  Fellow_Recruitment__c?: boolean | null;
  Media_Marketing__c?: boolean | null;
  Influence__c?: boolean | null;
  Startup__c?: boolean | null;
  Organization_Focus_Area_s__c?: string | null;

  // npo02 / npsp aggregates
  npo02__TotalOppAmount__c?: number | null;
  npo02__NumberOfClosedOpps__c?: number | null;
  npo02__AverageAmount__c?: number | null;
  npo02__LargestAmount__c?: number | null;
  npo02__LastCloseDate__c?: string | null;
  npo02__OppAmountThisYear__c?: number | null;
  npo02__OppAmountLastYear__c?: number | null;
  npsp__Grantmaker__c?: boolean | null;
  npsp__Funding_Focus__c?: string | null;

  Total_Revenue_Generated__c?: number | null;
  Last_Activity_Date__c?: string | null;
  Drive_Strategy_Folder_URL__c?: string | null;
}

/**
 * Mirrors `GET /api/salesforce/opportunities` (main.py:306).
 */
export interface SfOpportunity {
  Id: string;
  Name: string;
  AccountId?: string | null;
  Account?: SfReference | null;

  StageName: string;
  IsClosed?: boolean | null;
  IsWon?: boolean | null;
  Probability?: number | null;
  ForecastCategory?: string | null;

  Amount?: number | null;
  /** Ask amount — what was originally requested. May differ from
   *  Amount once the opp is closed (Amount is the realized number).
   *  SF API name is intentionally awkward (`..._if_different_...`)
   *  but the picklist label is just "Ask Amount". */
  Ask_Amount_if_different_from_actual__c?: number | null;
  /** Grant period — set during the post-Collecting award setup
   *  workflow. Source of truth for the award's active window. */
  Grant_Start_Date__c?: string | null;
  Grant_End_Date__c?: string | null;
  Philanthropy_Type__c?: string | null;
  Manager_Probability_Override__c?: number | null;
  /** SF picklist: "Low" | "Medium" | "High" (or null). Surfaced as a
   *  filter facet on /pipeline + /portfolio and as an editable pill
   *  in the Opportunity Detail header. */
  Priority__c?: string | null;
  CloseDate?: string | null;
  LeadSource?: string | null;
  NextStep?: string | null;
  Description?: string | null;

  OwnerId?: string | null;
  Owner?: SfReference | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;

  RecordTypeId?: string | null;
  RecordType?: SfReference | null;
  Active_Opportunity__c?: boolean | null;

  // Payments roll-ups
  npe01__Payments_Made__c?: number | null;
  Outstanding_Payments__c?: number | null;
  Number_of_Payments_Received__c?: number | null;
  npe01__Number_of_Payments__c?: number | null;
  Most_Recent_Payment_Date__c?: string | null;
  Last_Actual_Payment__c?: string | null;
  PaymentDate__c?: string | null;
  Earliest_Scheduled_Payment__c?: string | null;
  RenewalRepeat__c?: string | null;

  // Primary contact (NPSP lookup)
  npsp__Primary_Contact__c?: string | null;
  npsp__Primary_Contact__r?: {
    Name?: string | null;
    Email?: string | null;
  } | null;

  // Stage-terminal reasons
  /** Reason for closing as lost — SF field npsp__Closed_Lost_Reason__c. */
  npsp__Closed_Lost_Reason__c?: string | null;
  /** Reason for withdrawal — SF field Withdrawn_Reason__c. */
  Withdrawn_Reason__c?: string | null;

  // Reporting
  Reporting_Method__c?: string | null;
  npsp__Next_Grant_Deadline_Due_Date__c?: string | null;
}

/** Mirrors `npsp__Grant_Deadline__c` — deliverable attached to an Opportunity. */
export interface SfDeliverable {
  id: string;
  name: string | null;
  opportunity_id: string;
  type: "LOI" | "Application" | "Interim Report" | "Final Report" | null;
  due_date: string | null;
  close_date: string | null;
  requirements: string | null;
}

/** Returned by the /upcoming endpoints — includes the parent opportunity name. */
export interface SfDeliverableWithOppName extends SfDeliverable {
  opportunity_name: string | null;
}

/**
 * Mirrors `GET /api/salesforce/contacts` (main.py:621).
 */
export interface SfContact {
  Id: string;
  AccountId?: string | null;
  Account?: SfReference | null;
  FirstName?: string | null;
  LastName?: string | null;
  Name?: string | null;
  Title?: string | null;
  Department?: string | null;
  Email?: string | null;
  Phone?: string | null;
  MobilePhone?: string | null;
  MailingCity?: string | null;
  MailingState?: string | null;
  OwnerId?: string | null;
  Owner?: SfReference | null;
  LeadSource?: string | null;
  Description?: string | null;
  RecordTypeId?: string | null;
  RecordType?: SfReference | null;
  CreatedDate?: string | null;
  LastActivityDate?: string | null;
  Last_Activity_Date__c?: string | null;
  Days_Since_Last_Activity__c?: number | null;
  Preferred_Name__c?: string | null;
  Pronouns__c?: string | null;
  LinkedIn_URL__c?: string | null;
  Philanthropic_Contact__c?: boolean | null;
  Philanthropy__c?: boolean | null;
  Board_Status__c?: string | null;
  Volunteer__c?: boolean | null;
  npsp__Primary_Affiliation__c?: string | null;
  npsp__Primary_Affiliation__r?: SfReference | null;
}

/**
 * Mirrors `GET /api/salesforce/opportunities/{id}/payments` — npe01__OppPayment__c.
 */
export interface SfPayment {
  Id: string;
  Name?: string | null;
  npe01__Opportunity__c?: string | null;
  npe01__Payment_Amount__c?: number | null;
  npe01__Scheduled_Date__c?: string | null;
  npe01__Payment_Date__c?: string | null;
  npe01__Paid__c?: boolean | null;
  npe01__Payment_Method__c?: string | null;
  npe01__Written_Off__c?: boolean | null;
  Amount_Received__c?: number | null;
  Payment_Status__c?: string | null;
  Delinquent__c?: boolean | null;
  Paid_Status__c?: string | null;
  Amount_Minus_Received__c?: number | null;
}

/**
 * Mirrors `GET /api/salesforce/opportunities/{id}/tasks` response shape
 * (the formatted dict at main.py:1446).
 */
export interface SfTask {
  Id: string;
  Subject?: string | null;
  Status?: string | null;
  Priority?: string | null;
  ActivityDate?: string | null;
  Description?: string | null;
  IsClosed?: boolean | null;
  OwnerId?: string | null;
  OwnerName?: string | null;
  WhoId?: string | null;
  WhoName?: string | null;
  WhatId?: string | null;
  WhatName?: string | null;
  Type?: string | null;
  TaskSubtype?: string | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;
}

/**
 * Bedrock activity (matches routes/activities.py shape).
 */
export interface BedrockActivity {
  id: string;
  type: string;
  source?: string | null;
  subject?: string | null;
  description?: string | null;
  email_snippet?: string | null;
  email_body_text?: string | null;
  occurred_at?: string | null;
  activity_date?: string | null;
  created_at?: string | null;
  opportunity_id?: string | null;
  account_id?: string | null;
  contact_ids?: string[] | null;
  award_id?: string | null;
  owner_id?: string | null;
  owner_email?: string | null;
  owner_name?: string | null;
  /** Meeting metadata for type=meeting / calendar-event rows. */
  meeting_duration_minutes?: number | null;
  meeting_location?: string | null;
  /** Enriched by /account/{id}/full endpoint */
  _context_type?: "account" | "opportunity" | "contact" | null;
  _context_name?: string | null;
}
