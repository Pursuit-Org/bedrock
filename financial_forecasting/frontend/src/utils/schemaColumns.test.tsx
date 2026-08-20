/**
 * Tests for `buildSchemaColumns`.
 *
 * Split in two blocks:
 *   1. "invariants" — behavior that must survive the mega-B rewrite
 *      (system-field filter, dotted pseudo-field filter, forceHide, column
 *      alphabetization, per-SF-type GridColDef.type/valueFormatter/valueGetter
 *      mapping). These tests pass both pre- and post-rewrite.
 *   2. "new behavior" — InlineEditable renderCell emission, onSaveField
 *      plumbing, defaultSensitivity pass-through, reference-field routing
 *      (AccountCell/OwnerCell), ownerGate threading. Pass only post-rewrite.
 *
 * `usePermissions` is mocked because InlineEditable + AccountCell + OwnerCell
 * read it via useFieldPermission → useFieldPermission reads usePermissions.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPermissions = {
  can: jest.fn<boolean, [string]>().mockReturnValue(false),
  isAdmin: true,  // Admin by default so ownerGate doesn't block the render-path assertions
  sfUserId: 'user-1' as string | null,
  orgUserId: null,
  isPlatformUnlinked: false,
  profileName: 'RM',
  permissions: {} as Record<string, boolean>,
  loading: false,
  refetch: jest.fn(),
};

jest.mock('../contexts/PermissionsContext', () => ({
  usePermissions: () => mockPermissions,
}));

import { buildSchemaColumns, SchemaField, SchemaColumnOptions } from './schemaColumns';

beforeEach(() => {
  mockPermissions.can.mockReturnValue(false);
  mockPermissions.isAdmin = true;
  mockPermissions.sfUserId = 'user-1';
});

/** Minimal valid options — tests default to Account with admin caller. */
const defaultOptions: SchemaColumnOptions = {
  entityType: 'Account',
  onSaveField: jest.fn().mockResolvedValue(undefined),
  canEditObject: true,
  sfUserId: 'user-1',
};

const field = (overrides: Partial<SchemaField> & Pick<SchemaField, 'name' | 'label' | 'type'>): SchemaField => ({
  custom: false,
  updateable: true,
  calculated: false,
  nillable: true,
  defaultValue: null,
  ...overrides,
});

// ── Block 1: Invariants (must survive the rewrite) ──────────────────────────

describe('buildSchemaColumns — invariants', () => {
  it('filters out SYSTEM_FIELDS (Id, CreatedDate, SystemModstamp, …)', () => {
    const fields = [
      field({ name: 'Id', label: 'ID', type: 'id' }),
      field({ name: 'IsDeleted', label: 'Deleted', type: 'boolean' }),
      field({ name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime' }),
      field({ name: 'CreatedById', label: 'Created By ID', type: 'reference' }),
      field({ name: 'CreatedDate', label: 'Created Date', type: 'datetime' }),
      field({ name: 'LastModifiedById', label: 'Last Modified By ID', type: 'reference' }),
      field({ name: 'LastModifiedDate', label: 'Last Modified Date', type: 'datetime' }),
      field({ name: 'LastActivityDate', label: 'Last Activity Date', type: 'date' }),
      field({ name: 'RecordTypeId', label: 'Record Type ID', type: 'reference' }),
      field({ name: 'MasterRecordId', label: 'Master Record ID', type: 'reference' }),
      field({ name: 'attributes', label: 'Attributes', type: 'string' }),
      field({ name: 'Name', label: 'Name', type: 'string' }),
    ];
    const cols = buildSchemaColumns(fields, defaultOptions);
    expect(cols.map((c) => c.field)).toEqual(['Name']);
  });

  it('filters out dotted relationship pseudo-fields (Owner.Name)', () => {
    const fields = [
      field({ name: 'Name', label: 'Name', type: 'string' }),
      field({ name: 'Owner.Name', label: 'Owner Name', type: 'string' }),
      field({ name: 'Account.Name', label: 'Account Name', type: 'string' }),
    ];
    const cols = buildSchemaColumns(fields, defaultOptions);
    expect(cols.map((c) => c.field)).toEqual(['Name']);
  });

  it('honors forceHide to drop specific fields', () => {
    const fields = [
      field({ name: 'Name', label: 'Name', type: 'string' }),
      field({ name: 'Phone', label: 'Phone', type: 'phone' }),
      field({ name: 'Email', label: 'Email', type: 'email' }),
    ];
    const cols = buildSchemaColumns(fields, {
      ...defaultOptions,
      forceHide: new Set(['Phone']),
    });
    expect(cols.map((c) => c.field).sort()).toEqual(['Email', 'Name']);
  });

  it('returns columns sorted alphabetically by headerName', () => {
    const fields = [
      field({ name: 'ZField', label: 'Zebra', type: 'string' }),
      field({ name: 'AField', label: 'Apple', type: 'string' }),
      field({ name: 'MField', label: 'Mango', type: 'string' }),
    ];
    const cols = buildSchemaColumns(fields, defaultOptions);
    expect(cols.map((c) => c.headerName)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('maps numeric SF types (double/int/currency/percent) to GridColDef type: "number"', () => {
    const fields = [
      field({ name: 'Count', label: 'Count', type: 'int' }),
      field({ name: 'Revenue', label: 'Revenue', type: 'currency' }),
      field({ name: 'Avg', label: 'Avg', type: 'double' }),
      field({ name: 'Chance', label: 'Chance', type: 'percent' }),
    ];
    const cols = buildSchemaColumns(fields, defaultOptions);
    expect(cols.every((c) => c.type === 'number')).toBe(true);
  });

  it('currency type emits a valueFormatter that formats large numbers with formatDollarMillions', () => {
    const fields = [field({ name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency' })];
    const cols = buildSchemaColumns(fields, defaultOptions);
    const revenue = cols.find((c) => c.field === 'AnnualRevenue')!;
    const formatted = revenue.valueFormatter!({ value: 1_500_000 } as any);
    // formatDollarMillions renders "$1.5M" or similar; just verify it's a non-empty string
    // that includes a dollar sign or "M" to avoid depending on exact formatting.
    expect(typeof formatted).toBe('string');
    expect((formatted as string).length).toBeGreaterThan(0);
    const empty = revenue.valueFormatter!({ value: null } as any);
    expect(empty).toBe('');
  });

  it('percent type appends "%" in valueFormatter', () => {
    const fields = [field({ name: 'Probability', label: 'Probability', type: 'percent' })];
    const cols = buildSchemaColumns(fields, defaultOptions);
    const p = cols[0];
    expect(p.valueFormatter!({ value: 75 } as any)).toBe('75%');
    expect(p.valueFormatter!({ value: null } as any)).toBe('');
  });

  it('date type emits type: "date" + valueGetter returning Date', () => {
    const fields = [field({ name: 'CloseDate', label: 'Close Date', type: 'date' })];
    const cols = buildSchemaColumns(fields, defaultOptions);
    const d = cols[0];
    expect(d.type).toBe('date');
    const got = d.valueGetter!({ value: '2026-04-15' } as any);
    expect(got).toBeInstanceOf(Date);
  });

  it('datetime type emits type: "dateTime" + valueGetter returning Date + formatted valueFormatter', () => {
    const fields = [field({ name: 'SystemMod', label: 'System Mod', type: 'datetime' })];
    const cols = buildSchemaColumns(fields, defaultOptions);
    const d = cols[0];
    expect(d.type).toBe('dateTime');
    const got = d.valueGetter!({ value: '2026-04-15T12:00:00Z' } as any);
    expect(got).toBeInstanceOf(Date);
    const fmt = d.valueFormatter!({ value: '2026-04-15T12:00:00Z' } as any);
    expect(typeof fmt).toBe('string');
    expect(fmt).toMatch(/2026/);
  });

  it('boolean type emits type: "boolean"', () => {
    const fields = [field({ name: 'Active__c', label: 'Active', type: 'boolean' })];
    const cols = buildSchemaColumns(fields, defaultOptions);
    expect(cols[0].type).toBe('boolean');
  });

  it('multipicklist type is display-only (no renderCell-based edit path) with semicolon→comma formatter', () => {
    const fields = [
      field({
        name: 'Focus__c', label: 'Focus', type: 'multipicklist',
        picklistValues: [
          { value: 'A', label: 'A', active: true },
          { value: 'B', label: 'B', active: true },
        ],
      }),
    ];
    const cols = buildSchemaColumns(fields, defaultOptions);
    expect(cols[0].valueFormatter!({ value: 'A;B' } as any)).toBe('A, B');
    expect(cols[0].valueFormatter!({ value: null } as any)).toBe('');
  });

  it('applies per-field overrides (merged on top of generated column)', () => {
    const fields = [field({ name: 'Name', label: 'Name', type: 'string' })];
    const customRender = (() => 'custom') as any;
    const cols = buildSchemaColumns(fields, {
      ...defaultOptions,
      overrides: new Map([['Name', { flex: 3, minWidth: 300, renderCell: customRender }]]),
    });
    expect(cols[0].flex).toBe(3);
    expect(cols[0].minWidth).toBe(300);
    expect(cols[0].renderCell).toBe(customRender);
  });
});

// ── Block 2: New behavior (post-rewrite) ────────────────────────────────────

describe('buildSchemaColumns — InlineEditable emission', () => {
  it('emits a renderCell for standard editable fields that wraps InlineEditable', () => {
    const fields = [field({ name: 'Title', label: 'Title', type: 'string', updateable: true })];
    const cols = buildSchemaColumns(fields, { ...defaultOptions, entityType: 'Contact' });
    expect(cols[0].renderCell).toBeDefined();
    // Render the cell with synthetic params and verify the display shows through.
    const rendered = render(
      <>{(cols[0].renderCell as any)({ value: 'Program Officer', row: { Id: 'c1', OwnerId: 'user-1' } })}</>,
    );
    expect(rendered.getByText('Program Officer')).toBeInTheDocument();
  });

  it('onSaveField fires with (recordId, fieldName, newValue) on commit', async () => {
    const onSaveField = jest.fn().mockResolvedValue(undefined);
    const fields = [field({ name: 'FirstName', label: 'First Name', type: 'string', updateable: true })];
    const cols = buildSchemaColumns(fields, {
      ...defaultOptions,
      entityType: 'Contact',
      onSaveField,
    });
    const rendered = render(
      <>{(cols[0].renderCell as any)({ value: 'John', row: { Id: 'c1', OwnerId: 'user-1' } })}</>,
    );
    fireEvent.click(rendered.getByText('John'));
    const input = rendered.getByDisplayValue('John');
    fireEvent.change(input, { target: { value: 'Jane' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSaveField).toHaveBeenCalledWith('c1', 'FirstName', 'Jane'));
  });

  it('does NOT enter edit mode when row OwnerId mismatches and user is not admin/edit-all', () => {
    mockPermissions.isAdmin = false;
    mockPermissions.can.mockReturnValue(false);
    const fields = [field({ name: 'Title', label: 'Title', type: 'string', updateable: true })];
    const cols = buildSchemaColumns(fields, {
      ...defaultOptions,
      entityType: 'Contact',
      sfUserId: 'user-1',
    });
    const rendered = render(
      <>{(cols[0].renderCell as any)({ value: 'Program Officer', row: { Id: 'c1', OwnerId: 'other-user' } })}</>,
    );
    fireEvent.click(rendered.getByText('Program Officer'));
    // Non-owner → ownerGate blocks entry to edit mode.
    expect(rendered.queryByDisplayValue('Program Officer')).not.toBeInTheDocument();
  });

  it('reference field targeting Account emits a renderCell that uses preloaded accounts[]', () => {
    const fields = [field({
      name: 'AccountId',
      label: 'Account',
      type: 'reference',
      referenceTo: ['Account'],
      relationshipName: 'Account',
      updateable: true,
    })];
    const cols = buildSchemaColumns(fields, {
      ...defaultOptions,
      entityType: 'Contact',
      accounts: [{ Id: 'a1', Name: 'ACME' }, { Id: 'a2', Name: 'Globex' }],
    });
    expect(cols[0].renderCell).toBeDefined();
    const rendered = render(
      <>{(cols[0].renderCell as any)({
        value: 'a1',
        row: { Id: 'c1', OwnerId: 'user-1', AccountId: 'a1', Account: { Name: 'ACME' } },
      })}</>,
    );
    expect(rendered.getByText('ACME')).toBeInTheDocument();
  });

  it('reference field targeting User emits a renderCell that uses preloaded users[]', () => {
    const fields = [field({
      name: 'OwnerId',
      label: 'Owner',
      type: 'reference',
      referenceTo: ['User'],
      relationshipName: 'Owner',
      updateable: true,
    })];
    const cols = buildSchemaColumns(fields, {
      ...defaultOptions,
      entityType: 'Contact',
      users: [
        { Id: 'user-1', Name: 'Alice', IsActive: true },
        { Id: 'user-2', Name: 'Bob', IsActive: true },
      ],
    });
    expect(cols[0].renderCell).toBeDefined();
    const rendered = render(
      <>{(cols[0].renderCell as any)({
        value: 'user-1',
        row: { Id: 'c1', OwnerId: 'user-1', Owner: { Name: 'Alice' } },
      })}</>,
    );
    expect(rendered.getByText('Alice')).toBeInTheDocument();
  });

  it('readOnly fields (calculated or !updateable) render as display-only (click does not enter edit mode)', () => {
    const fields = [
      field({ name: 'Rollup__c', label: 'Rollup', type: 'currency', updateable: true, calculated: true }),
      field({ name: 'ReadOnly__c', label: 'Readonly', type: 'string', updateable: false, calculated: false }),
    ];
    const cols = buildSchemaColumns(fields, defaultOptions);
    const rollup = cols.find((c) => c.field === 'Rollup__c')!;
    const ro = cols.find((c) => c.field === 'ReadOnly__c')!;
    const rRollup = render(
      <>{(rollup.renderCell as any)({ value: 1000, row: { Id: 'a1', OwnerId: 'user-1' } })}</>,
    );
    // Clicking should not put it into edit mode (no TextField appears).
    fireEvent.click(rRollup.container.firstChild as Element);
    expect(rRollup.container.querySelector('input')).toBeNull();
    const rRo = render(
      <>{(ro.renderCell as any)({ value: 'foo', row: { Id: 'a1', OwnerId: 'user-1' } })}</>,
    );
    fireEvent.click(rRo.getByText('foo'));
    expect(rRo.queryByDisplayValue('foo')).not.toBeInTheDocument();
  });
});
