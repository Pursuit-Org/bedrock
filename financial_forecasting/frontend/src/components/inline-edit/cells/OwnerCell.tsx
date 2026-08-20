/**
 * <OwnerCell> — Opportunity / Account / Contact / Task owner editor.
 *
 * Classified as `sensitive` in the sensitivity table — reassigning an owner
 * changes accountability, so the primitive requires an unlock confirmation.
 *
 * Options are passed in rather than fetched inside because the parent page
 * already holds a `users` array (from `apiService.getUsers()` at page load).
 * Active users are shown first, inactive grouped below.
 */
import React, { useMemo } from 'react';
import { InlineEditable, InlineEditableOption } from '../InlineEditable';

interface User {
  Id: string;
  Name: string;
  IsActive?: boolean;
}

interface OwnerCellProps {
  /** OwnerId (or equivalent user ID) — matched against user.Id. */
  value: string;
  /** Flat list of users. Cell sorts + groups active/inactive. */
  users: User[];
  /** API field name for sensitivity lookup — defaults to 'OwnerId' (most common). */
  fieldName?: string;
  /** Object type for sensitivity lookup — defaults to 'Opportunity'. */
  objectType?: string;
  onSave: (newOwnerId: string) => void | Promise<void>;
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
  /**
   * Per-row ownership gate — forwarded to InlineEditable → useFieldPermission.
   * Schema-driven cells pass this per-row; hand-coded call sites may omit it
   * when ownership is gated upstream. See useFieldPermission.ts for semantics.
   */
  ownerGate?: {
    rowOwnerId: string | null | undefined;
    editAllPermission?: string;
  };
}

export const OwnerCell: React.FC<OwnerCellProps> = ({
  value,
  users,
  fieldName = 'OwnerId',
  objectType = 'Opportunity',
  onSave,
  recordLock,
  recordLockedByName,
  readOnly,
  ownerGate,
}) => {
  const options: InlineEditableOption[] = useMemo(() => {
    const sorted = [...users].sort((a, b) => {
      const aActive = a.IsActive !== false ? 0 : 1;
      const bActive = b.IsActive !== false ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (a.Name || '').localeCompare(b.Name || '');
    });
    return sorted.map((u) => ({
      value: u.Id,
      label: u.Name || 'Unknown',
      group: u.IsActive === false ? 'Inactive' : 'Active',
    }));
  }, [users]);

  const formatDisplay = useMemo(() => {
    return (v: string) => {
      const user = users.find((u) => u.Id === v);
      return user?.Name || 'Unassigned';
    };
  }, [users]);

  return (
    <InlineEditable<string>
      objectType={objectType}
      fieldName={fieldName}
      fieldLabel="Owner"
      value={value}
      variant="autocomplete"
      options={options}
      onSave={onSave}
      formatDisplay={formatDisplay}
      placeholder="Unassigned"
      recordLock={recordLock}
      recordLockedByName={recordLockedByName}
      readOnly={readOnly}
      ownerGate={ownerGate}
    />
  );
};

export default OwnerCell;
