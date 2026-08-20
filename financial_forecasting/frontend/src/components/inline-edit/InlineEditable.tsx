/**
 * <InlineEditable> — the framework-agnostic inline-edit primitive that all
 * domain cells (StageCell, OwnerCell, etc.) compose on top of.
 *
 *   - Pure React + MUI; no DataGrid coupling. To use inside MUI DataGrid
 *     `renderCell`, wrap with `<DataGridInlineCell>` (sibling file, lands
 *     in the Reports migration PR).
 *   - Variants: 'select' | 'autocomplete' | 'text' | 'number' | 'date'.
 *   - Display modes: 'pill' (chip-style) | 'inline' (plain text).
 *   - Click → opens an inline editor (popover for select/autocomplete/date,
 *     inline TextField for text/number).
 *   - Saves on blur or Enter; Escape cancels and reverts.
 *   - Sensitivity-aware: consumes useFieldPermission so devs can't bypass
 *     the lock check by reaching around the primitive. Sensitive fields
 *     show a lock icon on hover; click → UnlockWarningDialog → unlock for
 *     one edit; re-locks on save/blur.
 *
 * Adding a new field: add it to utils/fieldSensitivity.ts FIRST, then the
 * primitive will gate edit behavior automatically.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { format as formatDateFn } from 'date-fns';
import {
  Box,
  Chip,
  Typography,
  TextField,
  MenuItem,
  Menu,
  Autocomplete,
  Popover,
  IconButton,
  Tooltip,
  Checkbox,
} from '@mui/material';
import { Lock as LockIcon } from '@mui/icons-material';
import {
  useFieldPermission,
  UseFieldPermissionArgs,
} from '../../hooks/useFieldPermission';
import { formatDollarMillions } from '../../utils/formatters';
import { UnlockWarningDialog } from './UnlockWarningDialog';

export type InlineEditVariant =
  | 'select'
  | 'autocomplete'
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'email'
  | 'phone'
  | 'url';
export type InlineEditDisplay = 'pill' | 'inline';

export interface InlineEditableOption {
  value: string;
  label: string;
  /** Optional color for the option (used in pill display + dropdown swatch). */
  color?: string;
  /** Optional grouping key — for grouped autocompletes (e.g. Active vs Inactive owners). */
  group?: string;
}

export interface InlineEditableProps<TValue = unknown>
  extends Omit<UseFieldPermissionArgs, 'recordLockedByName'> {
  /** Current value. May be string, number, Date, or null. */
  value: TValue;
  /** Editor variant. Determines what control opens on click. */
  variant: InlineEditVariant;
  /** Pre-defined options for select/autocomplete. */
  options?: InlineEditableOption[];
  /** Display style. `pill` shows a chip; `inline` shows a plain text span. */
  display?: InlineEditDisplay;
  /** Save handler — return a Promise; primitive awaits before re-locking. */
  onSave: (newValue: TValue) => void | Promise<void>;
  /** Optional formatter for the display value (e.g. format dollars, dates). */
  formatDisplay?: (value: TValue) => React.ReactNode;
  /** Optional client-side validator. Return an error message or null. */
  validate?: (value: TValue) => string | null;
  /** Resolves a per-value pill color (overrides `option.color`). */
  pillColor?: (value: TValue) => string | undefined;
  /** Display when value is empty/null. Defaults to '—'. */
  placeholder?: string;
  /** Display name used in the unlock dialog header. Defaults to fieldName. */
  fieldLabel?: string;
  /** Display name of the user holding a record-level lock (for tooltip). */
  recordLockedByName?: string | null;
  /** When true, the edit affordance is suppressed entirely (read-only mode). */
  readOnly?: boolean;
}

const HOVER_LOCK_SX = {
  // Show the lock icon on cell hover; hide it otherwise so display mode
  // stays clean. Targeted via a parent class so we don't need React state.
  //
  // Use `position: absolute` (not just `visibility: hidden`) so the
  // hidden icon does NOT reserve layout width. Previously the ~22px
  // IconButton slot was reserved even when invisible, pushing the
  // displayed value left of the cell's right edge in right-aligned
  // columns (Amount, Prob). That caused the header text — which has
  // no icon slot — to look ~20px to the right of the value, breaking
  // column alignment (BUG-UI-10).
  //
  // With absolute positioning, the icon floats in the cell's right
  // padding area on hover and the host Box's width collapses to just
  // the text content, so right-aligned headers and values share a
  // common right edge.
  visibility: 'hidden',
  position: 'absolute',
  right: '-22px',
  top: '50%',
  transform: 'translateY(-50%)',
  '.inline-editable-host:hover &': { visibility: 'visible' },
};

export function InlineEditable<TValue = unknown>(
  props: InlineEditableProps<TValue>,
): React.ReactElement {
  const {
    objectType,
    fieldName,
    fieldLabel,
    value,
    variant,
    options,
    display = 'inline',
    onSave,
    formatDisplay,
    validate,
    pillColor,
    placeholder = '—',
    recordLock,
    recordLockedByName,
    readOnly,
    defaultSensitivity,
    ownerGate,
  } = props;

  const permission = useFieldPermission({
    objectType,
    fieldName,
    recordLock,
    recordLockedByName,
    defaultSensitivity,
    ownerGate,
  });

  // Editor state: which mode we're in right now.
  //   - 'display'  : showing the value (default)
  //   - 'editing'  : the inline editor is open
  //   - 'unlock'   : the unlock-confirmation dialog is open
  type Mode = 'display' | 'editing' | 'unlock';
  const [mode, setMode] = useState<Mode>('display');
  const [draft, setDraft] = useState<TValue>(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Reset draft if `value` changes from outside while we're in display mode.
  useEffect(() => {
    if (mode === 'display') setDraft(value);
  }, [value, mode]);

  // ── Computed permission flags ───────────────────────────────────────────
  const lockedFromRecord = permission.recordLockedByOther;
  const canEditAtAll = !readOnly && !lockedFromRecord && (
    permission.sensitivity === 'safe' || permission.canUnlock
  );
  const requiresUnlock = !readOnly && permission.requiresUnlock && permission.canUnlock;

  // ── Click on display mode ───────────────────────────────────────────────
  const handleDisplayClick = useCallback(() => {
    if (!canEditAtAll) return;
    if (requiresUnlock) {
      setMode('unlock');
    } else {
      setDraft(value);
      setError(null);
      setMode('editing');
    }
  }, [canEditAtAll, requiresUnlock, value]);

  const handleUnlockConfirm = useCallback(() => {
    setDraft(value);
    setError(null);
    setMode('editing');
  }, [value]);

  const handleUnlockCancel = useCallback(() => {
    setMode('display');
  }, []);

  // ── Save / cancel from edit mode ────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setDraft(value);
    setError(null);
    setMode('display');
  }, [value]);

  const handleSave = useCallback(async () => {
    // Guard against concurrent invocations. Tab + onBlur, Enter followed by
    // a blur, or a rapid re-click can all fire handleSave while a prior
    // await onSave() is still in flight — without this guard, the primitive
    // would send a duplicate PATCH.
    if (saving) return;
    if (validate) {
      const err = validate(draft);
      if (err) {
        setError(err);
        return;
      }
    }
    if (draft === value) {
      setMode('display');
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setMode('display');
    } catch (err: any) {
      setError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [draft, value, validate, onSave, saving]);

  // ── Display rendering ───────────────────────────────────────────────────
  // When no custom formatDisplay is provided, apply a sensible default per
  // variant so schemaColumns-generated cells don't each have to pass one.
  // Caller-provided formatDisplay always wins.
  const defaultFormatForVariant = (v: TValue): React.ReactNode => {
    if (v == null || v === '') return placeholder;
    switch (variant) {
      case 'currency':
        return typeof v === 'number' ? formatDollarMillions(v) : String(v);
      case 'percent':
        return typeof v === 'number' ? `${v}%` : String(v);
      case 'boolean':
        return v ? 'Yes' : 'No';
      case 'datetime': {
        const d = typeof v === 'string' ? new Date(v) : (v as unknown as Date);
        return d instanceof Date && !Number.isNaN(d.getTime())
          ? formatDateFn(d, 'MMM dd, yyyy h:mm a')
          : String(v);
      }
      case 'date': {
        const d = typeof v === 'string' ? new Date(v) : (v as unknown as Date);
        return d instanceof Date && !Number.isNaN(d.getTime())
          ? formatDateFn(d, 'MMM dd, yyyy')
          : String(v);
      }
      default:
        return String(v);
    }
  };

  const renderDisplay = () => {
    const formatted = formatDisplay ? formatDisplay(value) : defaultFormatForVariant(value);

    if (display === 'pill') {
      const color =
        (pillColor && pillColor(value)) ||
        options?.find((o) => o.value === String(value))?.color ||
        '#9e9e9e';
      return (
        <Chip
          label={formatted}
          size="small"
          sx={{
            bgcolor: `${color}20`,
            color,
            border: `1px solid ${color}`,
            fontWeight: 600,
            cursor: canEditAtAll ? 'pointer' : 'default',
            '&:hover': canEditAtAll ? { bgcolor: `${color}33` } : undefined,
          }}
        />
      );
    }
    return (
      <Typography
        variant="body2"
        component="span"
        sx={{
          cursor: canEditAtAll ? 'pointer' : 'default',
          color: value == null || value === '' ? 'text.disabled' : 'text.primary',
          '&:hover': canEditAtAll ? { textDecoration: 'underline dotted' } : undefined,
        }}
      >
        {formatted}
      </Typography>
    );
  };

  // ── Auto-save helper for select/autocomplete (single-click commit) ───
  const commitNow = useCallback(async (newVal: TValue) => {
    // Same re-entrancy guard as handleSave — rapid double-clicks on a
    // Menu/Autocomplete option can otherwise fire commitNow twice before
    // the Menu unmounts on setMode('display').
    if (saving) return;
    if (validate) {
      const err = validate(newVal);
      if (err) {
        setError(err);
        return;
      }
    }
    if (newVal === value) {
      setMode('display');
      return;
    }
    setSaving(true);
    try {
      await onSave(newVal);
      setMode('display');
    } catch (err: any) {
      setError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [validate, value, onSave, saving]);

  // ── Inline TextField editor (all text-input-based variants) ─────────
  // Maps each variant to the matching HTML input type. Number-style
  // variants (number, currency, percent) coerce strings to numbers on
  // change; others pass through as strings.
  const renderInlineTextEditor = () => {
    const inputType: React.InputHTMLAttributes<unknown>['type'] =
      variant === 'date' ? 'date'
      : variant === 'datetime' ? 'datetime-local'
      : variant === 'number' || variant === 'currency' || variant === 'percent' ? 'number'
      : variant === 'email' ? 'email'
      : variant === 'phone' ? 'tel'
      : variant === 'url' ? 'url'
      : 'text';
    const isNumeric = variant === 'number' || variant === 'currency' || variant === 'percent';
    return (
      <TextField
        type={inputType}
        value={(draft as unknown as string) ?? ''}
        autoFocus
        onChange={(e) => {
          const raw = e.target.value;
          const next = (isNumeric ? (raw === '' ? '' : Number(raw)) : raw) as unknown as TValue;
          setDraft(next);
        }}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
          } else if (e.key === 'Escape') {
            handleCancel();
          }
        }}
        size="small"
        sx={{ minWidth: 140 }}
        InputLabelProps={
          inputType === 'date' || inputType === 'datetime-local' ? { shrink: true } : undefined
        }
        inputProps={variant === 'percent' ? { min: 0, max: 100, step: 1 } : undefined}
        error={!!error}
        helperText={error || undefined}
        disabled={saving}
      />
    );
  };

  // ── Boolean editor (checkbox — click-to-toggle-and-save) ─────────────
  // Boolean doesn't fit the click-then-type-or-select model; clicking
  // the checkbox toggles and saves immediately via commitNow.
  const renderBooleanEditor = () => (
    <Checkbox
      checked={!!draft}
      onChange={(e) => {
        const next = e.target.checked as unknown as TValue;
        setDraft(next);
        commitNow(next);
      }}
      autoFocus
      disabled={saving}
      sx={{ p: 0.5, color: 'primary.contrastText', '&.Mui-checked': { color: 'primary.contrastText' } }}
    />
  );

  // ── Lock icon (hover-only when sensitive; always when locked-by-other) ──
  const renderLockBadge = () => {
    if (lockedFromRecord) {
      return (
        <Tooltip title={permission.lockTooltip} arrow>
          <LockIcon sx={{ fontSize: 14, color: 'text.disabled', ml: 0.5 }} />
        </Tooltip>
      );
    }
    if (!permission.requiresUnlock) return null;
    return (
      <Tooltip title={permission.lockTooltip} arrow>
        <span>
          <IconButton
            size="small"
            sx={{
              ml: 0.25,
              p: 0.25,
              ...HOVER_LOCK_SX,
              color: permission.canUnlock ? 'text.secondary' : 'text.disabled',
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (permission.canUnlock) setMode('unlock');
            }}
          >
            <LockIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </span>
      </Tooltip>
    );
  };

  // ── Render shell ────────────────────────────────────────────────────────
  // The .inline-editable-host class is the hover target for HOVER_LOCK_SX.
  // Display mode is always rendered (it doubles as the anchor for popovers);
  // text-style editors replace it inline; menu/autocomplete float over it;
  // boolean toggles a checkbox inline.
  const TEXT_INPUT_VARIANTS: ReadonlyArray<InlineEditVariant> = [
    'text', 'number', 'currency', 'percent', 'date', 'datetime', 'email', 'phone', 'url',
  ];
  const editingTextStyle = mode === 'editing' && TEXT_INPUT_VARIANTS.includes(variant);
  const editingBooleanStyle = mode === 'editing' && variant === 'boolean';

  return (
    <>
      <Box
        ref={anchorRef}
        className="inline-editable-host"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          maxWidth: '100%',
          borderRadius: 1,
          // `position: relative` anchors the hover-lock IconButton's
          // `position: absolute` (HOVER_LOCK_SX) so the icon floats in
          // the cell's right padding area without reserving layout width.
          position: 'relative',
          transition: 'box-shadow 120ms ease, background-color 120ms ease, color 120ms ease',
          // Active edit-or-unlock mode — dark-mode fill (primary bg + white
          // text) so the targeted cell is unmistakable the instant you click,
          // even while the unlock dialog is up. A10 upgrade (mega-B,
          // 2026-04-22) from the prior 3px blue-ring affordance — the ring
          // was easy to miss on small cells / dense grids. `mode !== 'display'`
          // covers both 'unlock' and 'editing' so the fill appears the
          // instant you click, not after dialog confirmation. Child text +
          // svg nodes inherit primary.contrastText so placeholders, lock
          // icons, and input text all flip to white together.
          //
          // Using box-shadow (not border) + bgcolor keeps the cell's
          // intrinsic width unchanged, so grid layout doesn't shift
          // around the activated cell.
          ...(mode !== 'display' && {
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            boxShadow: 2,
            '& input, & .MuiInputBase-input, & .MuiTypography-root, & svg, & .MuiChip-label': {
              color: 'primary.contrastText',
            },
          }),
          // Display-mode hover when editable — medium inset ring hints
          // that clicking opens an editor. Suppressed once we enter
          // edit or unlock so the active ring is the only thing you see.
          ...(mode === 'display' && canEditAtAll && {
            '&:hover': {
              boxShadow: 'inset 0 0 0 2px rgba(25, 118, 210, 0.45)',
            },
          }),
        }}
        onClick={mode === 'display' ? handleDisplayClick : undefined}
        onMouseDown={(e) => {
          // Stop the bubble so MUI DataGrid's GridCell.onMouseDown publishEvent('cellMouseDown')
          // (node_modules/@mui/x-data-grid/.../components/cell/GridCell.js:320) doesn't record
          // this click. That handler pairs with a document-level mouseup listener in useGridFocus
          // that runs setCellFocus → forceUpdate, which steals focus from our autoFocus'd
          // TextField during the edit-mode transition (InlineEditable.tsx:350 onBlur=handleSave
          // then fires with draft===value → silent revert to display mode). Stopping the
          // mousedown bubble neutralizes that path; DataGrid's "mouseup target inside focused
          // cell" branch (useGridFocus.js:291-294) handles the mouseup gracefully.
          //
          // Gated on display-mode + editable so we don't block the inner Menu/Popover/TextField
          // from receiving their own mousedowns (those are rendered outside this Box), and don't
          // interfere once we've entered edit/unlock mode. Without this gate, select/autocomplete
          // variants (which already worked because their popover is detached) would break.
          if (mode === 'display' && canEditAtAll) e.stopPropagation();
        }}
      >
        {editingTextStyle
          ? renderInlineTextEditor()
          : editingBooleanStyle
            ? renderBooleanEditor()
            : renderDisplay()}
        {mode === 'display' && renderLockBadge()}
      </Box>

      {/* Select editor — Menu anchored to the display element.
          A8 popper fix: slotProps.paper caps the Paper height so long option
          lists scroll internally instead of overflowing off-screen when a
          cell is near the viewport bottom. marginThreshold aligns with
          MUI's default shift-into-viewport behavior. */}
      {mode === 'editing' && variant === 'select' && (
        <Menu
          open
          anchorEl={anchorRef.current}
          onClose={handleCancel}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          marginThreshold={8}
          slotProps={{
            paper: {
              sx: { maxHeight: '50vh', overflowY: 'auto' },
            },
          }}
        >
          {(options || []).map((o) => (
            <MenuItem
              key={o.value}
              selected={o.value === String(draft)}
              onClick={() => commitNow(o.value as unknown as TValue)}
              dense
            >
              {o.color && (
                <Box
                  component="span"
                  sx={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: o.color,
                    mr: 1,
                  }}
                />
              )}
              {o.label}
            </MenuItem>
          ))}
        </Menu>
      )}

      {/* Autocomplete editor — Popover anchored to display.
          A8 popper fix: adds transformOrigin (was missing — the anchor pair
          was incomplete), slotProps.paper height cap, and marginThreshold
          to match the Menu's overflow behavior. */}
      {mode === 'editing' && variant === 'autocomplete' && (
        <Popover
          open
          anchorEl={anchorRef.current}
          onClose={handleCancel}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          marginThreshold={8}
          slotProps={{
            paper: {
              sx: { maxHeight: '50vh', overflowY: 'auto' },
            },
          }}
        >
          <Box sx={{ p: 1, minWidth: 260 }}>
            <Autocomplete
              options={options || []}
              getOptionLabel={(o) => o.label}
              value={(options || []).find((o) => o.value === String(draft)) || null}
              onChange={(_e, newOption) => {
                const newVal = (newOption?.value ?? null) as unknown as TValue;
                commitNow(newVal);
              }}
              openOnFocus
              groupBy={(o) => o.group || ''}
              isOptionEqualToValue={(a, b) => a.value === b.value}
              size="small"
              sx={{ minWidth: 240 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') handleCancel();
                  }}
                  error={!!error}
                  helperText={error || undefined}
                />
              )}
            />
          </Box>
        </Popover>
      )}

      <UnlockWarningDialog
        open={mode === 'unlock'}
        fieldLabel={fieldLabel || fieldName}
        reason={permission.lockTooltip}
        onConfirm={handleUnlockConfirm}
        onCancel={handleUnlockCancel}
      />
    </>
  );
}

export default InlineEditable;
