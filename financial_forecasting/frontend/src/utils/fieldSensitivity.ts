/**
 * Field sensitivity classification — central source of truth for which CRM
 * fields are safe to edit inline vs. need an unlock confirmation vs. are
 * permission-gated.
 *
 * Consumed by `useFieldPermission` (../hooks/useFieldPermission.ts), which
 * is in turn consumed by the `<InlineEditable>` primitive
 * (../components/inline-edit/InlineEditable.tsx). Devs cannot bypass the
 * sensitivity check — the primitive gates behavior off this table, so
 * adding a new editable field to a domain cell *requires* declaring its
 * sensitivity here first.
 *
 * Categories:
 *   - safe              → freely inline-editable
 *   - sensitive         → shows a lock icon on hover; click to unlock; the
 *                         unlock applies to a single edit and re-locks on
 *                         save/blur. Anyone with edit access can unlock.
 *   - permission-gated  → same hover lock UX, but unlocking requires the
 *                         declared permission key. Without the permission
 *                         the lock is sticky and tooltip says "no permission".
 *
 * Unknown (field, object) pairs default to `sensitive` (fail-safe) — a
 * future field that wasn't classified will demand an unlock action rather
 * than silently expose itself as freely editable.
 */

export type FieldSensitivity = 'safe' | 'sensitive' | 'permission-gated';

export interface FieldClassification {
  sensitivity: FieldSensitivity;
  /** Required permission key. Only honored when sensitivity === 'permission-gated'. */
  permission?: string;
  /** Tooltip text shown on the lock icon. Falls back to a generic message. */
  lockReason?: string;
}

/**
 * Object-name → field-name → classification.
 *
 * Object names use Salesforce conventions where applicable (`Opportunity`,
 * `Account`, `Contact`) and the local snake_case for our own tables
 * (`Project`, `Milestone`, `Task`, `Target`). Field names match the
 * underlying API field name exactly so callers can pass `fieldName` from
 * a column definition without remapping.
 */
const FIELD_CLASSIFICATIONS: Record<string, Record<string, FieldClassification>> = {
  Opportunity: {
    Name:                 { sensitivity: 'safe' },
    // StageName stays sensitive per feedback_sf_stages_sacred — stage changes
    // drive pipeline bucketing and funnel reporting, fat-finger risk is high.
    StageName:            { sensitivity: 'sensitive',        lockReason: 'Stage changes affect pipeline metrics. Click to confirm.' },
    // Amount + Probability softened to 'safe' in A9 (mega-B, 2026-04-22).
    // Previously required per-edit unlock; friction outweighed the fat-finger
    // risk for RM daily-edit workflow. Reverting is a single-line flip back
    // to 'sensitive' + lockReason if the softening turns out to be wrong.
    Amount:               { sensitivity: 'safe' },
    Probability:          { sensitivity: 'safe' },
    CloseDate:            { sensitivity: 'safe' },
    OwnerId:              { sensitivity: 'sensitive',        lockReason: 'Reassigning changes accountability. Click to confirm.' },
    AccountId:            { sensitivity: 'sensitive',        lockReason: 'Changing the account affects commission rollups. Click to confirm.' },
    PaymentDate__c:       { sensitivity: 'sensitive',        lockReason: 'Payment date affects finance reconciliation. Click to confirm.' },
    NextStep:             { sensitivity: 'safe' },
    Description:          { sensitivity: 'safe' },
    LeadSource:           { sensitivity: 'safe' },
    Type:                 { sensitivity: 'safe' },
    RenewalRepeat__c:     { sensitivity: 'safe' },
  },
  Account: {
    Name:                 { sensitivity: 'safe' },
    Industry:             { sensitivity: 'safe' },
    Phone:                { sensitivity: 'safe' },
    Website:              { sensitivity: 'safe' },
    Description:          { sensitivity: 'safe' },
    Type:                 { sensitivity: 'safe' },
    OwnerId:              { sensitivity: 'sensitive',        lockReason: 'Reassigning the account changes ownership. Click to confirm.' },
    AnnualRevenue:        { sensitivity: 'sensitive',        lockReason: 'Revenue figures impact reporting. Click to confirm.' },
    NumberOfEmployees:    { sensitivity: 'sensitive',        lockReason: 'Employee count feeds segmentation reports. Click to confirm.' },
    BillingStreet:        { sensitivity: 'safe' },
    BillingCity:          { sensitivity: 'safe' },
    BillingState:         { sensitivity: 'safe' },
    BillingPostalCode:    { sensitivity: 'safe' },
  },
  Contact: {
    FirstName:            { sensitivity: 'safe' },
    LastName:             { sensitivity: 'safe' },
    Email:                { sensitivity: 'safe' },
    Phone:                { sensitivity: 'safe' },
    Title:                { sensitivity: 'safe' },
    Department:           { sensitivity: 'safe' },
    AccountId:            { sensitivity: 'sensitive',        lockReason: 'Reassigning the contact changes the linked account. Click to confirm.' },
    OwnerId:              { sensitivity: 'sensitive',        lockReason: 'Reassigning the contact changes ownership. Click to confirm.' },
    npsp__Primary_Affiliation__c: { sensitivity: 'sensitive', lockReason: "Reassigning affiliation rewrites the contact's household + rollups. Click to confirm." },
  },
  Project: {
    name:                 { sensitivity: 'safe' },
    description:          { sensitivity: 'safe' },
    status:               { sensitivity: 'permission-gated', permission: 'edit_project_status', lockReason: 'Project-level status changes require Admin or Executive permission.' },
  },
  Milestone: {
    name:                 { sensitivity: 'safe' },
    status:               { sensitivity: 'safe' },
    phase:                { sensitivity: 'safe' },
    priority:             { sensitivity: 'safe' },
    due_date:             { sensitivity: 'safe' },
    notes:                { sensitivity: 'safe' },
    owner_id:             { sensitivity: 'sensitive',        lockReason: 'Reassigning a milestone changes accountability. Click to confirm.' },
  },
  Task: {
    Subject:              { sensitivity: 'safe' },
    Status:               { sensitivity: 'safe' },
    Priority:             { sensitivity: 'safe' },
    ActivityDate:         { sensitivity: 'safe' },
    Description:          { sensitivity: 'safe' },
    OwnerId:              { sensitivity: 'sensitive',        lockReason: 'Reassigning a task changes accountability. Click to confirm.' },
  },
  Activity: {
    Subject:              { sensitivity: 'safe' },
    Status:               { sensitivity: 'safe' },
    Priority:             { sensitivity: 'safe' },
    ActivityDate:         { sensitivity: 'safe' },
    Description:          { sensitivity: 'safe' },
    OwnerId:              { sensitivity: 'sensitive',        lockReason: 'Reassigning an activity changes accountability. Click to confirm.' },
    WhatId:               { sensitivity: 'sensitive',        lockReason: 'Changing the parent record rewrites activity linkage. Click to confirm.' },
    WhoId:                { sensitivity: 'sensitive',        lockReason: 'Changing the related contact affects linkage. Click to confirm.' },
  },
  Target: {
    amount:               { sensitivity: 'permission-gated', permission: 'manage_owner_goals', lockReason: 'Revenue targets require Admin or Executive permission.' },
    period:               { sensitivity: 'permission-gated', permission: 'manage_owner_goals', lockReason: 'Target periods require Admin or Executive permission.' },
  },
};

/**
 * Look up the sensitivity classification for a (objectType, fieldName) pair.
 *
 * Unknown pairs fail safe to `sensitive` so untriaged fields still require
 * an unlock action — the primitive assumption is that a cell hand-coded
 * with an explicit (objectType, fieldName) deserves a deliberate entry.
 *
 * Schema-generated cells (via `buildSchemaColumns` in utils/schemaColumns.tsx)
 * emit renderCells for every SF `updateable` field — tens of fields per entity.
 * Declaring every one of them would be brittle and noisy, and SF already
 * enforces edit permission on the server. Those callers pass
 * `defaultSensitivity: 'safe'` to opt out of the fail-safe for fields they
 * know came from SF's own updateable list. Hand-coded call sites (no third
 * arg, or `defaultSensitivity` omitted) keep the fail-safe behavior.
 *
 * Explicit entries in FIELD_CLASSIFICATIONS always win — so a schema-
 * generated cell on `Opportunity.StageName` still reads `'sensitive'`
 * regardless of the default, because StageName is in the table.
 */
export function classifyField(
  objectType: string,
  fieldName: string,
  defaultSensitivity: FieldSensitivity = 'sensitive',
): FieldClassification {
  const objectMap = FIELD_CLASSIFICATIONS[objectType];
  const classification = objectMap?.[fieldName];
  if (!classification) {
    if (defaultSensitivity === 'sensitive') {
      return {
        sensitivity: 'sensitive',
        lockReason: `${fieldName} is not classified. Click to confirm the edit.`,
      };
    }
    // defaultSensitivity === 'safe' — no lockReason; the cell edits freely.
    return { sensitivity: defaultSensitivity };
  }
  return classification;
}

/**
 * Sanity-bound check for date fields — a Safe-with-bounds policy. Prevents
 * accidental dates before 1970 (epoch sanity) or more than 10 years in the
 * future (likely a typo). Returns the rejection reason or `null` if OK.
 */
export function validateDateBounds(value: string | Date): string | null {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return 'Invalid date.';
  const year = d.getFullYear();
  if (year < 1970) return 'Date must be on or after 1970.';
  const tenYearsOut = new Date();
  tenYearsOut.setFullYear(tenYearsOut.getFullYear() + 10);
  if (d > tenYearsOut) return 'Date must be within 10 years from today.';
  return null;
}
