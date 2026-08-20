/**
 * useFieldPermission — single hook that combines field-sensitivity classification
 * (../utils/fieldSensitivity.ts) with the user's permissions (PermissionsContext)
 * and the per-record edit-lock (e.g. Opportunity lockMap) into a uniform answer.
 *
 * Consumed by the `<InlineEditable>` primitive so every inline-edit cell
 * gates its behavior off the same source of truth — devs cannot bypass
 * the sensitivity table by reaching around the primitive.
 *
 * Returned shape:
 *   - `sensitivity` — raw classification ('safe' | 'sensitive' | 'permission-gated')
 *   - `requiresUnlock` — true iff the user must take an explicit unlock action
 *     before editing (sensitive or permission-gated and they have permission)
 *   - `recordLockedByOther` — true iff the entire record is held by another user
 *   - `recordLockedBy` — display string for whoever holds the record lock
 *   - `canUnlock` — true iff the user is permitted to unlock this field
 *   - `lockTooltip` — tooltip text shown next to the lock icon
 *
 * Combinations:
 *   - sensitivity=safe + recordLock=null              → free edit, no lock UI
 *   - sensitivity=sensitive                            → lock-on-hover, click to unlock for one edit
 *   - sensitivity=permission-gated + has perm          → lock-on-hover, click to unlock
 *   - sensitivity=permission-gated + no perm           → permanent lock, "no permission" tooltip
 *   - any sensitivity + recordLock by other user       → permanent lock, "locked by X" tooltip
 *   - any sensitivity + recordLock by self             → behaves as if no record lock
 */
import { useMemo } from 'react';
import { usePermissions } from '../contexts/PermissionsContext';
import {
  classifyField,
  FieldSensitivity,
} from '../utils/fieldSensitivity';

export interface FieldPermissionResult {
  sensitivity: FieldSensitivity;
  requiresUnlock: boolean;
  recordLockedByOther: boolean;
  recordLockedBy: string | null;
  canUnlock: boolean;
  lockTooltip: string;
}

export interface UseFieldPermissionArgs {
  /** Object type: 'Opportunity' | 'Account' | 'Contact' | 'Project' | 'Milestone' | 'Task' | 'Target' | 'Activity' | ... */
  objectType: string;
  /** API field name (matches the sensitivity table key) */
  fieldName: string;
  /** Optional record-level lock from a parent component (e.g. Opportunity lockMap entry) */
  recordLock?: { locked_by: string; locked_at: string } | null;
  /** Optional display name for the user holding the record lock */
  recordLockedByName?: string | null;
  /**
   * Default sensitivity for unclassified (objectType, fieldName) pairs.
   * Omit (or leave undefined) for hand-coded cells — unclassified fields get
   * the fail-safe 'sensitive' unlock prompt. Schema-generated cells (via
   * `buildSchemaColumns`) should pass 'safe' — SF already gates writes via
   * field-level security server-side, and declaring every updateable field
   * in the sensitivity table would be noisy. Explicit classifications in
   * `fieldSensitivity.ts` always override this default.
   */
  defaultSensitivity?: FieldSensitivity;
  /**
   * Per-row ownership gate. Mirrors the backend's `_enforce_record_ownership`
   * helper (financial_forecasting/main.py:862) — PATCH is rejected with 403
   * unless the caller is (a) admin ('manage_users_roles'), (b) holds the
   * `editAllPermission` key for this resource (Opportunity/Payment only —
   * Account/Contact/Task have no edit-all bypass), or (c) IS the row's Owner.
   *
   * When `ownerGate.rowOwnerId` is provided and the caller fails all three
   * bypasses, this hook returns a sticky-lock result with
   * `recordLockedByOther: true` + `canUnlock: false` — so the cell shows a
   * permanent lock and clicks are inert. Without this, a non-admin user
   * clicking an unowned cell would type, tab out, then see "Failed to update"
   * from the sanitized server error with no explanation.
   *
   * Omit this arg entirely for cells whose ownership is already enforced
   * upstream (e.g., Opportunities.tsx already filters OwnerId-free via the
   * checkboxSelection/lockMap path). Schema-driven cells pass it per-row.
   */
  ownerGate?: {
    rowOwnerId: string | null | undefined;
    editAllPermission?: string;
  };
}

export function useFieldPermission({
  objectType,
  fieldName,
  recordLock,
  recordLockedByName,
  defaultSensitivity,
  ownerGate,
}: UseFieldPermissionArgs): FieldPermissionResult {
  const { can, isAdmin, sfUserId } = usePermissions();

  return useMemo(() => {
    const classification = classifyField(objectType, fieldName, defaultSensitivity);

    // Record-lock takes precedence over everything else — if another user holds
    // the lock, no field on this record is editable regardless of sensitivity.
    const recordLockedByOther = !!(
      recordLock && sfUserId && recordLock.locked_by !== sfUserId
    );
    if (recordLockedByOther) {
      const lockedByLabel = recordLockedByName || 'another user';
      return {
        sensitivity: classification.sensitivity,
        requiresUnlock: false,
        recordLockedByOther: true,
        recordLockedBy: lockedByLabel,
        canUnlock: false,
        lockTooltip: `Record locked by ${lockedByLabel}.`,
      };
    }

    // Owner gate: non-admin / non-edit-all users can only edit records they own.
    // Mirrors backend's `_enforce_record_ownership`. Missing sfUserId → cannot
    // evaluate ownership → deny, matching backend (main.py:907-912). A null
    // rowOwnerId (record fetched without OwnerId, or record has no owner) ALSO
    // denies for the same safer-to-fail reason.
    if (ownerGate) {
      const hasEditAll = !!ownerGate.editAllPermission && can(ownerGate.editAllPermission);
      const isOwner = !!sfUserId && !!ownerGate.rowOwnerId && ownerGate.rowOwnerId === sfUserId;
      const ownerCanEdit = isAdmin || hasEditAll || isOwner;
      if (!ownerCanEdit) {
        return {
          sensitivity: classification.sensitivity,
          requiresUnlock: false,
          recordLockedByOther: true,
          recordLockedBy: 'record owner',
          canUnlock: false,
          lockTooltip: 'Only the record owner (or an admin) can edit this field.',
        };
      }
    }

    // Permission-gated: the lock is sticky if the user lacks the permission.
    if (classification.sensitivity === 'permission-gated') {
      const allowed = isAdmin || (
        classification.permission ? can(classification.permission) : true
      );
      return {
        sensitivity: 'permission-gated',
        requiresUnlock: true,
        recordLockedByOther: false,
        recordLockedBy: null,
        canUnlock: allowed,
        lockTooltip: allowed
          ? (classification.lockReason ?? 'Sensitive field. Click lock to edit.')
          : `You don't have permission to edit ${fieldName}. Contact Admin.`,
      };
    }

    // Sensitive: anyone with edit access can unlock per-edit.
    if (classification.sensitivity === 'sensitive') {
      return {
        sensitivity: 'sensitive',
        requiresUnlock: true,
        recordLockedByOther: false,
        recordLockedBy: null,
        canUnlock: true,
        lockTooltip: classification.lockReason ?? 'Sensitive field. Click lock to edit.',
      };
    }

    // Safe — no lock, free edit.
    return {
      sensitivity: 'safe',
      requiresUnlock: false,
      recordLockedByOther: false,
      recordLockedBy: null,
      canUnlock: true,
      lockTooltip: '',
    };
  }, [
    objectType,
    fieldName,
    recordLock,
    recordLockedByName,
    defaultSensitivity,
    ownerGate,
    can,
    isAdmin,
    sfUserId,
  ]);
}
