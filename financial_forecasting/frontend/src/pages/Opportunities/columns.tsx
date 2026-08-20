/**
 * Column definitions for the Opportunities DataGrid.
 *
 * Separated from the main component so the orchestrator stays focused on
 * layout and wiring rather than 600 lines of column config.
 */
import React from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Lock as LockIcon,
  LockOpen as LockOpenIcon,
} from '@mui/icons-material';
import EditRowButton from '../../components/EditRowButton';
import {
  GridColDef,
  GridRenderCellParams,
  GridValueGetterParams,
} from '@mui/x-data-grid';
import { format } from 'date-fns';
import { formatDollarMillions } from '../../utils/formatters';
import { getStageColor, getProbabilityColor, calculatePaymentDate } from './helpers';
import type { Opportunity } from './helpers';
import { StageCell } from '../../components/inline-edit/cells/StageCell';
import { OwnerCell } from '../../components/inline-edit/cells/OwnerCell';
import { AccountCell } from '../../components/inline-edit/cells/AccountCell';
import { AmountCell } from '../../components/inline-edit/cells/AmountCell';
import { DateCell } from '../../components/inline-edit/cells/DateCell';
import { ProbabilityCell } from '../../components/inline-edit/cells/ProbabilityCell';
import { InlineEditable } from '../../components/inline-edit/InlineEditable';

/**
 * Look up the display name of the user who holds the record-level lock on
 * the given opportunity. Returns `null` when the row isn't locked. Passed
 * into each domain cell so the record-lock tooltip can show a real name
 * (e.g. "Record locked by Jac.") instead of the generic fallback ("another
 * user."). Intentionally cheap — two Map lookups per render.
 */
function resolveLockerName(cb: ColumnCallbacks, rowId: string): string | null {
  const lock = cb.lockMap?.get(rowId);
  if (!lock) return null;
  return cb.userMap.get(lock.locked_by)?.Name ?? null;
}

// ---------------------------------------------------------------------------
// Callbacks the columns need from the parent component
// ---------------------------------------------------------------------------

export interface ColumnCallbacks {
  onTaskPanelOpen: (opp: Opportunity) => void;
  /**
   * Stage change handler. Signature chosen to decouple from MUI DataGrid's
   * GridRenderCellParams so the domain StageCell can call it cleanly.
   * Special-cased: transitioning to "Collecting / In Effect" navigates to
   * the payment-schedule page; other stages use the generic optimistic path.
   */
  onStageChange: (oppId: string, oldStage: string, newStage: string) => void;
  /**
   * Generic per-field save used by the domain cells (AccountCell,
   * OwnerCell, AmountCell). Invalidates the opportunities cache on success;
   * throws on failure so the cell can surface an error.
   */
  onSaveField?: (oppId: string, field: string, newValue: any) => Promise<void>;
  accountMap: Map<string, any>;
  userMap: Map<string, any>;
  /** Raw user list used by OwnerCell's autocomplete options. */
  users?: Array<{ Id: string; Name: string; IsActive?: boolean }>;
  /** Raw account list used by AccountCell's autocomplete options. */
  accounts?: Array<{ Id: string; Name: string }>;
  // Lock support
  lockMap?: Map<string, { locked_by: string; locked_at: string }>;
  onLockToggle?: (oppId: string, ownerId: string, isLocked: boolean) => void;
  currentSfUserId?: string | null;
  canLock?: boolean;
  // Edit dialog
  onEditDialogOpen?: (opp: any) => void;
}

// ---------------------------------------------------------------------------
// Pipeline columns (Sales team — focus on closing deals)
// ---------------------------------------------------------------------------

function lockColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: '_lock',
    headerName: '',
    width: 44,
    sortable: false,
    filterable: false,
    disableColumnMenu: true,
    renderCell: (params: GridRenderCellParams) => {
      const opp = params.row as Opportunity;
      const lock = cb.lockMap?.get(opp.Id);
      const isOwner = cb.currentSfUserId && opp.OwnerId === cb.currentSfUserId;
      const isLockedByMe = lock && lock.locked_by === cb.currentSfUserId;
      const isLockedByOther = lock && !isLockedByMe;

      if (isLockedByMe) {
        return (
          <Tooltip title="Unlock this opportunity">
            <IconButton size="small" onClick={() => cb.onLockToggle?.(opp.Id, opp.OwnerId, true)}
              sx={{ color: '#ed6c02' }}>
              <LockIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        );
      }
      if (isLockedByOther) {
        const lockerName = cb.userMap.get(lock!.locked_by)?.Name || 'another user';
        return (
          <Tooltip title={`Locked by ${lockerName}`}>
            <LockIcon sx={{ fontSize: 18, color: '#d32f2f', cursor: 'default' }} />
          </Tooltip>
        );
      }
      if (isOwner && cb.canLock) {
        return (
          <Tooltip title="Lock this opportunity">
            <IconButton size="small" onClick={() => cb.onLockToggle?.(opp.Id, opp.OwnerId, false)}
              sx={{ color: '#bdbdbd', '&:hover': { color: '#ed6c02' } }}>
              <LockOpenIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        );
      }
      return null;
    },
  };
}

export function buildPipelineColumns(cb: ColumnCallbacks): GridColDef[] {
  return [
    lockColumn(cb),
    taskColumn(cb),
    nameColumn(cb, { headerName: 'Opportunity Name', flex: 2, minWidth: 250 }),
    accountColumn(cb, { editable: true }),
    ownerColumn(cb),
    stageColumn(cb),
    amountColumn(cb),
    {
      field: 'Probability',
      headerName: 'Probability',
      flex: 0.7,
      minWidth: 110,
      type: 'number',
      // DataGrid native edit disabled; ProbabilityCell owns the edit flow
      // (sensitive field — requires unlock confirmation per the Apr-14
      // adversarial review C1 finding). getProbabilityColor was the only
      // caller of the inline Chip; ProbabilityCell handles its own display.
      editable: false,
      filterable: true,
      renderCell: (params: GridRenderCellParams) => (
        <ProbabilityCell
          value={(params.value as number | null) ?? null}
          onSave={async (v) => {
            if (cb.onSaveField) await cb.onSaveField(params.row.Id, 'Probability', v);
          }}
          recordLock={cb.lockMap?.get(params.row.Id) ?? null}
          recordLockedByName={resolveLockerName(cb, params.row.Id)}
        />
      ),
    },
    closeDateColumn(cb),
    {
      field: 'PaymentDate__c',
      headerName: '1st Payment Date',
      flex: 0.9,
      minWidth: 130,
      type: 'date',
      // DateCell owns the edit flow (sensitive field — requires unlock
      // confirmation). DataGrid's native date editor bypassed that gate.
      editable: false,
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
      renderCell: (params: GridRenderCellParams) => (
        <DateCell
          value={(params.row.PaymentDate__c as string) || ''}
          onSave={async (newDate) => {
            if (cb.onSaveField) await cb.onSaveField(params.row.Id, 'PaymentDate__c', newDate || null);
          }}
          fieldName="PaymentDate__c"
          objectType="Opportunity"
          displayFormat="MMM dd, yyyy"
          recordLock={cb.lockMap?.get(params.row.Id) ?? null}
          recordLockedByName={resolveLockerName(cb, params.row.Id)}
        />
      ),
    },
    lastModifiedColumn(),
    {
      field: 'expectedValue',
      headerName: 'Expected Value',
      flex: 0.9,
      minWidth: 130,
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => {
        const amount = params.row.Amount || 0;
        const probability = params.row.Probability || 0;
        return (amount * probability) / 100;
      },
      valueFormatter: (params) => formatDollarMillions(params.value as number),
    },
    editColumn(cb),
  ];
}

// ---------------------------------------------------------------------------
// Payment columns (Finance team — focus on tracking payments)
// ---------------------------------------------------------------------------

export function buildPaymentColumns(cb: ColumnCallbacks): GridColDef[] {
  return [
    taskColumn(cb),
    nameColumn(cb, { headerName: 'Grant Name', flex: 2, minWidth: 250 }),
    accountColumn(cb, { editable: false }),
    closeDateColumn(cb),
    amountColumn(cb),
    {
      field: 'npe01__Payments_Made__c',
      headerName: 'Received',
      flex: 0.9,
      minWidth: 130,
      type: 'number',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => params.row.npe01__Payments_Made__c || 0,
      valueFormatter: (params) => formatDollarMillions((params.value as number) || 0),
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ color: 'success.main', fontWeight: 600 }}>
          {formatDollarMillions((params.value as number) || 0)}
        </Box>
      ),
    },
    {
      field: 'remainingAmount',
      headerName: 'Remaining',
      flex: 0.9,
      minWidth: 130,
      type: 'number',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => {
        const total = params.row.Amount || 0;
        const received = params.row.npe01__Payments_Made__c || 0;
        return total - received;
      },
      valueFormatter: (params) => formatDollarMillions(params.value as number),
      renderCell: (params: GridRenderCellParams) => {
        const remaining = params.value as number;
        return (
          <Box sx={{ color: remaining > 0 ? 'warning.main' : 'success.main', fontWeight: 600 }}>
            {formatDollarMillions(remaining)}
          </Box>
        );
      },
    },
    progressColumn(),
    {
      field: 'Number_of_Payments_Received__c',
      headerName: 'Payments',
      flex: 0.7,
      minWidth: 100,
      type: 'number',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => params.row.Number_of_Payments_Received__c || 0,
      renderCell: (params: GridRenderCellParams) => (
        <Chip
          label={`${params.value || 0} / ${params.row.npe01__Number_of_Payments__c || 0}`}
          color={((params.value as number) || 0) > 0 ? 'success' : 'default'}
          size="small"
        />
      ),
    },
    {
      field: 'Most_Recent_Payment_Date__c',
      headerName: 'Last Payment',
      flex: 0.9,
      minWidth: 130,
      type: 'date',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
      valueFormatter: (params) => (!params.value ? 'No payments yet' : format(new Date(params.value as string), 'MMM dd, yyyy')),
    },
    {
      field: 'expectedPaymentDate',
      headerName: 'Next Expected',
      flex: 0.9,
      minWidth: 130,
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => calculatePaymentDate(params.row.CloseDate),
      valueFormatter: (params) => (!params.value ? 'N/A' : format(params.value as Date, 'MMM dd, yyyy')),
    },
    paymentStatusColumn(),
    editColumn(cb),
  ];
}

// ---------------------------------------------------------------------------
// Edit column
// ---------------------------------------------------------------------------

function editColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: '__edit__',
    headerName: '',
    width: 50,
    sortable: false,
    filterable: false,
    disableColumnMenu: true,
    renderCell: (params: GridRenderCellParams) => (
      <EditRowButton
        onClick={() => cb.onEditDialogOpen?.(params.row)}
        tooltip="Edit opportunity"
      />
    ),
  };
}

// ---------------------------------------------------------------------------
// Shared column fragments
// ---------------------------------------------------------------------------

function taskColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'tasks',
    headerName: 'Tasks',
    width: 80,
    sortable: false,
    filterable: false,
    disableColumnMenu: true,
    renderCell: (params: GridRenderCellParams) => (
      <Button
        size="small"
        variant="text"
        onClick={(e) => { e.stopPropagation(); cb.onTaskPanelOpen(params.row); }}
        sx={{ minWidth: 0, fontSize: '0.75rem', textTransform: 'none' }}
      >
        Tasks
      </Button>
    ),
  };
}

function accountColumn(cb: ColumnCallbacks, opts: { editable: boolean }): GridColDef {
  return {
    field: 'AccountId',
    headerName: 'Funder/Account',
    flex: 1.5,
    minWidth: 180,
    // DataGrid editing is disabled — the AccountCell manages its own edit
    // flow (including the sensitive-field unlock confirmation).
    editable: false,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const account = cb.accountMap.get(params.row.AccountId);
      return account?.Name || params.row.Account?.Name || 'Unknown';
    },
    renderCell: (params: GridRenderCellParams) => (
      <AccountCell
        value={params.row.AccountId}
        accounts={cb.accounts || []}
        displayName={params.row.Account?.Name}
        onSave={async (newId) => {
          if (cb.onSaveField) await cb.onSaveField(params.row.Id, 'AccountId', newId);
        }}
        recordLock={cb.lockMap?.get(params.row.Id) ?? null}
        recordLockedByName={resolveLockerName(cb, params.row.Id)}
        readOnly={!opts.editable}
      />
    ),
  };
}

function ownerColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'OwnerId',
    headerName: 'Owner',
    flex: 1,
    minWidth: 150,
    editable: false,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const user = cb.userMap.get(params.row.OwnerId);
      return user?.Name || params.row.Owner?.Name || 'Unassigned';
    },
    renderCell: (params: GridRenderCellParams) => (
      <OwnerCell
        value={params.row.OwnerId}
        users={cb.users || []}
        onSave={async (newId) => {
          if (cb.onSaveField) await cb.onSaveField(params.row.Id, 'OwnerId', newId);
        }}
        recordLock={cb.lockMap?.get(params.row.Id) ?? null}
        recordLockedByName={resolveLockerName(cb, params.row.Id)}
      />
    ),
  };
}

function stageColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'StageName',
    headerName: 'Stage',
    flex: 1.2,
    minWidth: 160,
    editable: false,
    filterable: true,
    renderCell: (params: GridRenderCellParams) => (
      <StageCell
        value={(params.value as string) || ''}
        onSave={(newStage) =>
          cb.onStageChange(params.row.Id, (params.value as string) || '', newStage)
        }
        recordLock={cb.lockMap?.get(params.row.Id) ?? null}
        recordLockedByName={resolveLockerName(cb, params.row.Id)}
      />
    ),
  };
}

function amountColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'Amount',
    headerName: 'Amount',
    flex: 0.8,
    minWidth: 120,
    type: 'number',
    // DataGrid native edit disabled; AmountCell owns the edit flow (includes
    // unlock confirmation for this sensitive field).
    editable: false,
    filterable: true,
    renderCell: (params: GridRenderCellParams) => (
      <AmountCell
        value={(params.value as number | null) ?? null}
        onSave={async (newAmount) => {
          if (cb.onSaveField) await cb.onSaveField(params.row.Id, 'Amount', newAmount);
        }}
        recordLock={cb.lockMap?.get(params.row.Id) ?? null}
        recordLockedByName={resolveLockerName(cb, params.row.Id)}
      />
    ),
  };
}

function closeDateColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'CloseDate',
    headerName: 'Close Date',
    flex: 0.9,
    minWidth: 120,
    type: 'date',
    // DataGrid native edit disabled; DateCell owns the edit flow so Close
    // Date picks up the same single-click affordance + sensitivity pipeline
    // as PaymentDate__c and the other inline-edit cells. A10 Opp audit
    // (mega-B, 2026-04-22) — CloseDate is classified 'safe' in
    // fieldSensitivity.ts:52 so no unlock prompt is expected.
    editable: false,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
    valueFormatter: (params) => (!params.value ? 'N/A' : format(new Date(params.value as string), 'MMM dd, yyyy')),
    renderCell: (params: GridRenderCellParams) => (
      <DateCell
        value={(params.row.CloseDate as string) || ''}
        onSave={async (newDate) => {
          if (cb.onSaveField) await cb.onSaveField(params.row.Id, 'CloseDate', newDate || null);
        }}
        fieldName="CloseDate"
        objectType="Opportunity"
        displayFormat="MMM dd, yyyy"
        recordLock={cb.lockMap?.get(params.row.Id) ?? null}
        recordLockedByName={resolveLockerName(cb, params.row.Id)}
      />
    ),
  };
}

function nameColumn(
  cb: ColumnCallbacks,
  opts: { headerName: string; flex: number; minWidth: number },
): GridColDef {
  return {
    field: 'Name',
    headerName: opts.headerName,
    flex: opts.flex,
    minWidth: opts.minWidth,
    // DataGrid native edit disabled; InlineEditable owns the edit flow so
    // Name gets single-click + the dark-mode fill affordance matching every
    // other editable cell in the row. A10 Opp audit (mega-B, 2026-04-22) —
    // Opportunity.Name is classified 'safe' in fieldSensitivity.ts:48.
    editable: false,
    filterable: true,
    renderCell: (params: GridRenderCellParams) => (
      <InlineEditable<string>
        value={(params.value as string) || ''}
        variant="text"
        objectType="Opportunity"
        fieldName="Name"
        fieldLabel="Opportunity Name"
        onSave={async (newName) => {
          if (cb.onSaveField) await cb.onSaveField(params.row.Id, 'Name', newName);
        }}
        recordLock={cb.lockMap?.get(params.row.Id) ?? null}
        recordLockedByName={resolveLockerName(cb, params.row.Id)}
      />
    ),
  };
}

function lastModifiedColumn(): GridColDef {
  return {
    field: 'LastModifiedDate',
    headerName: 'Last Modified',
    flex: 0.9,
    minWidth: 120,
    type: 'dateTime',
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
    valueFormatter: (params) => (!params.value ? 'N/A' : format(new Date(params.value as string), 'MMM dd, yyyy')),
  };
}

function progressColumn(): GridColDef {
  return {
    field: 'paymentProgress',
    headerName: 'Progress',
    flex: 1,
    minWidth: 140,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const amount = params.row.Amount || 0;
      const received = params.row.npe01__Payments_Made__c || 0;
      return amount === 0 ? 0 : Math.round((received / amount) * 100);
    },
    renderCell: (params: GridRenderCellParams) => {
      const pct = params.value as number;
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
          <Box sx={{ flex: 1, height: 10, bgcolor: 'grey.300', borderRadius: 1, overflow: 'hidden' }}>
            <Box
              sx={{
                width: `${Math.min(pct, 100)}%`,
                height: '100%',
                bgcolor: pct >= 100 ? 'success.main' : pct > 0 ? 'warning.main' : 'grey.400',
                transition: 'width 0.3s',
              }}
            />
          </Box>
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 40 }}>{pct}%</Typography>
        </Box>
      );
    },
  };
}

function paymentStatusColumn(): GridColDef {
  return {
    field: 'paymentStatus',
    headerName: 'Status',
    flex: 0.8,
    minWidth: 120,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const amount = params.row.Amount || 0;
      const received = params.row.npe01__Payments_Made__c || 0;
      const outstanding = params.row.Outstanding_Payments__c || 0;
      if (amount === 0) return 'No amount';
      if (received >= amount) return 'Paid';
      if (received > 0) return 'Partial';
      if (outstanding > 0) return 'Scheduled';
      return 'Pending';
    },
    renderCell: (params: GridRenderCellParams) => {
      const status = params.value as string;
      const colorMap: Record<string, 'success' | 'warning' | 'info' | 'error' | 'default'> = {
        Paid: 'success', Partial: 'warning', Scheduled: 'info', Pending: 'error',
      };
      return <Chip label={status} color={colorMap[status] || 'default'} size="small" />;
    },
  };
}
