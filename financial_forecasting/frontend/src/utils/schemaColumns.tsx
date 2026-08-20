/**
 * Schema-driven column generator for MUI DataGrid.
 *
 * Converts a Salesforce schema describe response into GridColDef[] arrays,
 * so users can toggle ANY object field as a visible column. Every editable
 * field is rendered through the <InlineEditable> primitive (text, number,
 * currency, percent, date, datetime, boolean, select, email, phone, url)
 * or one of the inline-edit cell components (AccountCell, OwnerCell) for
 * reference fields. DataGrid native cell-edit is OFF — the primitive owns
 * the edit flow end-to-end (single-click entry, dark-mode fill affordance,
 * sensitivity gate, per-row ownership gate).
 *
 * Invariant — fail-safe sensitivity (mega-B rewrite, 2026-04-23):
 *   Every schema-emitted InlineEditable passes `defaultSensitivity: 'safe'`.
 *   Hand-coded InlineEditable call sites omit the prop and retain the
 *   fail-safe 'sensitive' default in fieldSensitivity.ts. If someone flips
 *   this default to 'sensitive', ~100 fields across Account/Contact/Task/
 *   Activity would lock on first click overnight — every cell would demand
 *   an unlock confirmation. Keep it 'safe'; rely on SF's field-level
 *   security + the server-side `_enforce_record_ownership` helper
 *   (financial_forecasting/main.py:862) as the authoritative write gate.
 *
 * Usage:
 *   const schema = await apiService.getSchemaDescribe('Account');
 *   const columns = buildSchemaColumns(schema.data.fields, {
 *     entityType: 'Account',
 *     onSaveField: (id, field, value) => apiService.updateAccount(id, { [field]: value }),
 *     canEditObject: canEdit,         // page-level permission
 *     sfUserId,                       // from usePermissions()
 *     accounts, users,                // preloaded reference data
 *   });
 */
import React from 'react';
import { format } from 'date-fns';
import type { GridColDef, GridRenderCellParams, GridValueGetterParams } from '@mui/x-data-grid';

import { formatDollarMillions } from './formatters';
import {
  InlineEditable,
  InlineEditVariant,
} from '../components/inline-edit/InlineEditable';
import AccountCell from '../components/inline-edit/cells/AccountCell';
import OwnerCell from '../components/inline-edit/cells/OwnerCell';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SchemaField {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  updateable: boolean;
  calculated: boolean;
  nillable: boolean;
  defaultValue: any;
  picklistValues?: Array<{ value: string; label: string; active: boolean }>;
  referenceTo?: string[];
  relationshipName?: string;
}

export interface SchemaColumnOptions {
  /** Object type key for sensitivity classification ('Account', 'Contact', 'Task', 'Activity', …). */
  entityType: string;
  /**
   * Save handler. Called when InlineEditable commits a change. Implementations
   * typically dispatch to the matching /api/salesforce/{sobject}/{id} endpoint
   * and invalidate the relevant react-query cache on success. Errors thrown
   * from here surface in the InlineEditable primitive as inline helperText.
   */
  onSaveField: (recordId: string, fieldName: string, newValue: unknown) => Promise<void>;
  /**
   * Page-level permission gate (e.g. `canEdit = isAdmin || can('edit_accounts')`).
   * When false, every cell renders read-only regardless of per-field flags.
   */
  canEditObject: boolean;
  /**
   * Per-resource 'edit_all_*' permission key. Opportunity list passes
   * 'edit_all_opportunities' so RM-tier users can edit any opp. Account,
   * Contact, Task, Activity have no edit-all key in PERMISSION_KEYS — leave
   * undefined. Mirrors the backend's `_enforce_record_ownership` bypass.
   */
  editAllPermission?: string;
  /** Current user's Salesforce user ID, from usePermissions(). Null = can't evaluate ownership → deny. */
  sfUserId: string | null;
  /** Preloaded accounts for AccountId-reference autocomplete. Empty array = show "No Account". */
  accounts?: Array<{ Id: string; Name: string }>;
  /** Preloaded users for OwnerId-reference autocomplete. Empty array = show "Unassigned". */
  users?: Array<{ Id: string; Name: string; IsActive?: boolean }>;
  /** Field names to exclude entirely from the generated columns. */
  forceHide?: Set<string>;
  /** Per-field column definition overrides (merged after generation). */
  overrides?: Map<string, Partial<GridColDef>>;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** System/metadata fields that clutter the column picker without adding value. */
export const SYSTEM_FIELDS = new Set([
  'Id',
  'IsDeleted',
  'SystemModstamp',
  'CreatedById',
  'CreatedDate',
  'LastModifiedById',
  'LastModifiedDate',
  'LastActivityDate',
  'RecordTypeId',
  'MasterRecordId',
  'attributes',
]);

/** Salesforce field types that map to DataGrid number type. */
const NUMERIC_TYPES = new Set(['double', 'currency', 'int', 'percent']);

/** Salesforce field types that map to currency formatting. */
const CURRENCY_TYPES = new Set(['currency']);

/** Mapping from SF field `type` to the InlineEditable variant union. */
function variantForType(sfType: string): InlineEditVariant {
  switch (sfType) {
    case 'double':
    case 'int':
      return 'number';
    case 'currency':
      return 'currency';
    case 'percent':
      return 'percent';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'boolean':
      return 'boolean';
    case 'picklist':
      return 'select';
    case 'email':
      return 'email';
    case 'phone':
      return 'phone';
    case 'url':
      return 'url';
    case 'textarea':
    case 'string':
    case 'id':
    case 'combobox':
    default:
      return 'text';
  }
}

// ── Column Builder ──────────────────────────────────────────────────────────

/**
 * Convert Salesforce schema fields into MUI DataGrid column definitions.
 *
 * Filters out system fields and dotted pseudo-fields (Account.Name, etc.),
 * maps SF types to DataGrid types, and emits InlineEditable renderCells for
 * every editable field. Reference fields targeting Account or User use the
 * AccountCell / OwnerCell components (which take preloaded options from the
 * caller's state to avoid per-row async fetches). Other reference types fall
 * back to display-only.
 */
export function buildSchemaColumns(
  fields: SchemaField[],
  options: SchemaColumnOptions,
): GridColDef[] {
  const forceHide = options.forceHide ?? new Set<string>();
  const overrides = options.overrides ?? new Map<string, Partial<GridColDef>>();

  const columns: GridColDef[] = [];

  for (const field of fields) {
    // Skip system fields.
    if (SYSTEM_FIELDS.has(field.name)) continue;

    // Skip dotted relationship pseudo-fields (Account.Name, Owner.Name, etc.).
    if (field.name.includes('.')) continue;

    // Skip explicitly hidden fields.
    if (forceHide.has(field.name)) continue;

    const col = buildColumnForField(field, options);
    if (!col) continue;

    // Apply per-field overrides (can replace renderCell, headerName, flex, …).
    const override = overrides.get(field.name);
    if (override) {
      Object.assign(col, override);
    }

    columns.push(col);
  }

  // Sort alphabetically by header name for the column picker.
  columns.sort((a, b) => (a.headerName || '').localeCompare(b.headerName || ''));

  return columns;
}

// ── Per-field column builder ────────────────────────────────────────────────

function buildColumnForField(
  field: SchemaField,
  options: SchemaColumnOptions,
): GridColDef | null {
  const base: GridColDef = {
    field: field.name,
    headerName: field.label,
    flex: 1,
    minWidth: 120,
    filterable: true,
    // DataGrid native edit OFF — InlineEditable owns the edit flow. Setting
    // editable: false lets MUI correctly suppress its cell-edit CSS state
    // even when the DataGrid is configured with editMode="cell".
    editable: false,
  };

  const sfType = field.type;

  // ── Numeric types (currency, double, int, percent) ──
  if (NUMERIC_TYPES.has(sfType)) {
    base.type = 'number';
    if (CURRENCY_TYPES.has(sfType)) {
      base.valueFormatter = (params) =>
        params.value != null ? formatDollarMillions(params.value as number) : '';
    }
    if (sfType === 'percent') {
      base.valueFormatter = (params) =>
        params.value != null ? `${params.value}%` : '';
    }
    base.renderCell = makeStandardRenderCell(field, options);
    return base;
  }

  // ── Date ──
  if (sfType === 'date') {
    base.type = 'date';
    base.valueGetter = (params: GridValueGetterParams) =>
      params.value ? new Date(params.value) : null;
    base.valueFormatter = (params) =>
      params.value ? format(new Date(params.value as string), 'MMM dd, yyyy') : '';
    base.renderCell = makeStandardRenderCell(field, options);
    return base;
  }

  // ── DateTime ──
  if (sfType === 'datetime') {
    base.type = 'dateTime';
    base.valueGetter = (params: GridValueGetterParams) =>
      params.value ? new Date(params.value) : null;
    base.valueFormatter = (params) =>
      params.value ? format(new Date(params.value as string), 'MMM dd, yyyy h:mm a') : '';
    base.renderCell = makeStandardRenderCell(field, options);
    return base;
  }

  // ── Boolean ──
  if (sfType === 'boolean') {
    base.type = 'boolean';
    base.renderCell = makeStandardRenderCell(field, options);
    return base;
  }

  // ── Picklist ──
  if (sfType === 'picklist') {
    base.renderCell = makeStandardRenderCell(field, options);
    return base;
  }

  // ── Multipicklist — display-only (SF multi-select needs a distinct UI). ──
  if (sfType === 'multipicklist') {
    base.valueFormatter = (params) => {
      if (!params.value) return '';
      return String(params.value).replace(/;/g, ', ');
    };
    return base;
  }

  // ── Reference / Lookup ──
  if (sfType === 'reference') {
    const targets = field.referenceTo || [];
    const relName = field.relationshipName;

    // Display-mode fallback: read the related record's Name via the joined object.
    if (relName) {
      base.valueGetter = (params: GridValueGetterParams) =>
        params.row[relName]?.Name || '';
    }

    if (targets.includes('Account')) {
      base.renderCell = makeAccountReferenceRenderCell(field, options);
      return base;
    }

    if (targets.includes('User')) {
      base.renderCell = makeOwnerReferenceRenderCell(field, options);
      return base;
    }

    // Other reference types (Contact, Lead, polymorphic WhatId/WhoId) —
    // display-only. Edit via the entity's edit dialog. A dedicated
    // ContactCell/LeadCell would go here when demand materializes.
    return base;
  }

  // ── Address (compound) — display-only with joined components. ──
  if (sfType === 'address') {
    base.valueFormatter = (params) => {
      const v = params.value as Record<string, string | undefined> | null | undefined;
      if (!v || typeof v !== 'object') return '';
      return ['street', 'city', 'state', 'postalCode', 'country']
        .map((k) => v[k])
        .filter(Boolean)
        .join(', ');
    };
    return base;
  }

  // ── String / textarea / email / phone / url / id / combobox — text input. ──
  base.renderCell = makeStandardRenderCell(field, options);
  return base;
}

// ── renderCell makers ───────────────────────────────────────────────────────

function makeStandardRenderCell(
  field: SchemaField,
  options: SchemaColumnOptions,
): GridColDef['renderCell'] {
  return (params: GridRenderCellParams) => {
    const rowOwnerId = params.row.OwnerId ?? null;
    const variant = variantForType(field.type);
    // Client-side required-field validator — rejects empty string / null on
    // non-nillable fields so we don't round-trip a REQUIRED_FIELD_MISSING from
    // SF (which the backend sanitizes to a generic "Failed to update"). Only
    // applied to text-style variants since numeric/date/boolean have their
    // own shape constraints; picklist+autocomplete can't produce an empty
    // commit unless the user explicitly clears.
    const requiredValidate = !field.nillable
      ? (v: unknown) => (v == null || v === '' ? `${field.label} is required.` : null)
      : undefined;
    const picklistOptions =
      variant === 'select' && field.picklistValues
        ? field.picklistValues
            .filter((p) => p.active)
            .map((p) => ({ value: p.value, label: p.label }))
        : undefined;
    return (
      <InlineEditable
        variant={variant}
        value={params.value as any}
        onSave={(newVal) =>
          options.onSaveField(params.row.Id ?? params.row.id, field.name, newVal)
        }
        objectType={options.entityType}
        fieldName={field.name}
        fieldLabel={field.label}
        defaultSensitivity="safe"
        readOnly={
          !options.canEditObject || !field.updateable || field.calculated
        }
        ownerGate={{
          rowOwnerId,
          editAllPermission: options.editAllPermission,
        }}
        options={picklistOptions}
        validate={requiredValidate}
      />
    );
  };
}

function makeAccountReferenceRenderCell(
  field: SchemaField,
  options: SchemaColumnOptions,
): GridColDef['renderCell'] {
  return (params: GridRenderCellParams) => {
    const rowOwnerId = params.row.OwnerId ?? null;
    const relName = field.relationshipName;
    const displayName = (relName && params.row[relName]?.Name) || null;
    return (
      <AccountCell
        value={(params.value as string) ?? ''}
        accounts={options.accounts ?? []}
        displayName={displayName}
        fieldName={field.name}
        objectType={options.entityType}
        onSave={(newId) =>
          options.onSaveField(params.row.Id ?? params.row.id, field.name, newId)
        }
        readOnly={!options.canEditObject || !field.updateable}
        ownerGate={{
          rowOwnerId,
          editAllPermission: options.editAllPermission,
        }}
      />
    );
  };
}

function makeOwnerReferenceRenderCell(
  field: SchemaField,
  options: SchemaColumnOptions,
): GridColDef['renderCell'] {
  return (params: GridRenderCellParams) => {
    const rowOwnerId = params.row.OwnerId ?? null;
    return (
      <OwnerCell
        value={(params.value as string) ?? ''}
        users={options.users ?? []}
        fieldName={field.name}
        objectType={options.entityType}
        onSave={(newId) =>
          options.onSaveField(params.row.Id ?? params.row.id, field.name, newId)
        }
        readOnly={!options.canEditObject || !field.updateable}
        ownerGate={{
          rowOwnerId,
          editAllPermission: options.editAllPermission,
        }}
      />
    );
  };
}
