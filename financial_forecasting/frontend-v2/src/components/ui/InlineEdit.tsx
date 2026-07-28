import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";

import { fmtDate, fmtDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Briefly true after a successful save — drives the checkmark fade.
 */
function useSavedFlash() {
  const [flashing, setFlashing] = useState(false);
  const timer = useRef<number | null>(null);

  const flash = () => {
    setFlashing(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlashing(false), 1200);
  };

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  return { flashing, flash };
}

/**
 * Status icon shown at the right edge of an inline-edit cell.
 *  - saving (>250ms): spinner
 *  - just-saved: animated checkmark for ~1.2s
 *  - error: red alert
 *  - idle: nothing
 */
function StatusIndicator({
  saving,
  saved,
  error,
}: {
  saving: boolean;
  saved: boolean;
  error: boolean;
}) {
  if (error) {
    return (
      <AlertCircle
        size={11}
        className="pointer-events-none ml-1 flex-shrink-0 text-red"
      />
    );
  }
  if (saving) {
    return (
      <Loader2
        size={11}
        className="pointer-events-none ml-1 flex-shrink-0 animate-spin text-ink-3"
      />
    );
  }
  if (saved) {
    return (
      <Check
        size={11}
        className="pointer-events-none ml-1 flex-shrink-0 text-green animate-in fade-in zoom-in duration-150"
      />
    );
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────
 * InlineText — click to edit, Enter saves, Esc cancels, blur saves.
 * ──────────────────────────────────────────────────────────────────── */

interface InlineTextProps {
  value: string | null | undefined;
  onSave: (next: string) => Promise<void> | void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  emptyLabel?: string;
  /**
   * Optional formatter for the resting-state label only — the editor
   * still operates on the raw `value`. Use this for currency / percent
   * fields where the display should be "$5,000" or "20%" but the user
   * types digits when editing.
   *
   * Receives the raw string value (already-trimmed). Return any string;
   * if it's empty / null we fall back to the placeholder.
   */
  formatDisplay?: (raw: string) => string;
}

export function InlineText({
  value,
  onSave,
  placeholder = "—",
  multiline,
  className,
  emptyLabel,
  formatDisplay,
}: InlineTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const startedAtRef = useRef<number>(0);
  const { flashing: saved, flash } = useSavedFlash();

  useEffect(() => {
    setDraft(value ?? "");
    // Don't drop the optimistic shadow if the incoming value matches it —
    // that means the cache caught up. Drop it only when the value differs
    // (e.g. server returned something else, like trimmed/canonicalized).
    setOptimistic((prev) => (prev != null && prev === value ? null : prev));
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select?.();
    }
  }, [editing]);

  const commit = async () => {
    if (saving) return;
    if ((draft ?? "").trim() === (value ?? "").trim()) {
      setEditing(false);
      return;
    }
    const next = draft;
    setOptimistic(next);
    setEditing(false);
    setSaving(true);
    setError(null);
    startedAtRef.current = Date.now();
    try {
      await onSave(next);
      flash();
    } catch (e) {
      setOptimistic(null);
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(value ?? "");
    setEditing(false);
    setError(null);
  };

  const showSpinner = saving && Date.now() - startedAtRef.current > 250;
  const display = optimistic ?? value;

  if (!editing) {
    const rawDisplay = display != null ? String(display) : "";
    const hasValue = rawDisplay.trim().length > 0;
    // formatDisplay only runs in resting state — the editor input
    // shows the raw value so the user can type digits without
    // fighting the formatter.
    const shown = hasValue && formatDisplay ? formatDisplay(rawDisplay) : rawDisplay;
    const shownHasValue = shown.trim().length > 0;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className={cn(
          "group/edit relative flex w-full max-w-full items-center rounded px-1.5 py-1 text-left text-[13px] text-ink-2 hover:bg-surface hover:ring-1 hover:ring-border-strong",
          !shownHasValue && "italic text-ink-4",
          error && "ring-1 ring-red",
          className,
        )}
        title={shownHasValue ? shown : (emptyLabel ?? placeholder)}
      >
        <span className="min-w-0 flex-1 truncate">
          {shownHasValue ? shown : (emptyLabel ?? placeholder)}
        </span>
        <StatusIndicator saving={showSpinner} saved={saved} error={!!error} />
      </button>
    );
  }

  const inputCls =
    "block w-full border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4";

  return (
    <div className="rounded ring-2 ring-accent">
      {multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
          placeholder={placeholder}
          className={cn(inputCls, "resize-none px-1.5 py-1")}
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          placeholder={placeholder}
          className={cn(inputCls, "px-1.5 py-1")}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * InlineSelect — single-click native dropdown via invisible-overlay.
 * ──────────────────────────────────────────────────────────────────── */

interface InlineSelectProps<T extends string> {
  value: T | null | undefined;
  options: { value: T; label: string }[];
  onSave: (next: T) => Promise<void> | void;
  emptyLabel?: string;
  renderValue?: (v: T | null | undefined) => React.ReactNode;
  className?: string;
}

export function InlineSelect<T extends string>({
  value,
  options,
  onSave,
  emptyLabel = "—",
  renderValue,
  className,
}: InlineSelectProps<T>) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<T | null>(null);
  const startedAtRef = useRef<number>(0);
  const { flashing: saved, flash } = useSavedFlash();

  useEffect(() => {
    setOptimistic((prev) => (prev != null && prev === value ? null : prev));
  }, [value]);

  const commit = async (next: T) => {
    if (saving || next === value) return;
    setOptimistic(next);
    setSaving(true);
    setError(null);
    startedAtRef.current = Date.now();
    try {
      await onSave(next);
      flash();
    } catch (e) {
      setOptimistic(null);
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const display = optimistic ?? value;
  // Show the option's LABEL, not the raw stored value — otherwise ids (e.g. a
  // task owner's UUID) or lowercase codes (e.g. "low") leak into the UI. Falls
  // back to the raw value when no option matches.
  const displayLabel = display != null ? (options.find((o) => o.value === display)?.label ?? display) : null;
  const showSpinner = saving && Date.now() - startedAtRef.current > 250;

  return (
    <div
      className={cn(
        "group/edit relative flex items-center rounded px-1 py-0.5 hover:bg-surface hover:ring-1 hover:ring-border-strong",
        error && "ring-1 ring-red",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="pointer-events-none min-w-0 flex-1 truncate">
        {renderValue ? (
          renderValue(display ?? null)
        ) : (
          <span className="text-[13px] text-ink-2">
            {displayLabel ?? <span className="italic text-ink-4">{emptyLabel}</span>}
          </span>
        )}
      </div>
      <StatusIndicator saving={showSpinner} saved={saved} error={!!error} />
      <select
        value={display ?? ""}
        onChange={(e) => {
          e.stopPropagation();
          void commit(e.target.value as T);
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={saving}
        className="absolute inset-0 cursor-pointer appearance-none border-0 bg-transparent text-transparent opacity-0 outline-none focus:opacity-0"
        aria-label="Edit"
      >
        <option value="" disabled>
          {emptyLabel}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * InlineDate — click to edit, native date picker, ISO YYYY-MM-DD on save.
 * ──────────────────────────────────────────────────────────────────── */

interface InlineDateProps {
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void> | void;
  placeholder?: string;
  className?: string;
  align?: "left" | "right";
  /**
   * Display variant for the resting-state label:
   *   - "long"  → "May 4, 2026" — used on detail pages where the year
   *               matters and there's room
   *   - "short" → "May 4" — used in dense table rows / task lists
   *
   * Defaults to "long" so detail-page callers get the year for free
   * without opting in. Compact callers (TaskListTab, opp pipeline
   * row, etc.) opt into "short" explicitly.
   */
  variant?: "long" | "short";
}

function toIsoDate(raw: string | null | undefined): string {
  if (!raw) return "";
  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function InlineDate({
  value,
  onSave,
  placeholder = "—",
  className,
  align = "left",
  variant = "long",
}: InlineDateProps) {
  const formatter = variant === "long" ? fmtDate : fmtDateShort;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(toIsoDate(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const startedAtRef = useRef<number>(0);
  const { flashing: saved, flash } = useSavedFlash();

  useEffect(() => {
    setDraft(toIsoDate(value));
    setOptimistic((prev) => (prev != null && prev === value ? null : prev));
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      // Try to open the picker on browsers that support it (Chromium/Safari).
      inputRef.current.showPicker?.();
    }
  }, [editing]);

  const commit = async () => {
    if (saving) return;
    const nextIso = draft || null;
    const currentIso = toIsoDate(value) || null;
    if (nextIso === currentIso) {
      setEditing(false);
      return;
    }
    setOptimistic(nextIso);
    setEditing(false);
    setSaving(true);
    setError(null);
    startedAtRef.current = Date.now();
    try {
      await onSave(nextIso);
      flash();
    } catch (e) {
      setOptimistic(null);
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(toIsoDate(value));
    setEditing(false);
    setError(null);
  };

  const showSpinner = saving && Date.now() - startedAtRef.current > 250;
  const display = optimistic ?? value;
  const hasValue = display != null && String(display).trim().length > 0;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className={cn(
          "group/edit relative flex w-full max-w-full items-center rounded px-1.5 py-1 text-left text-[13px] text-ink-2 hover:bg-surface hover:ring-1 hover:ring-border-strong",
          align === "right" && "justify-end text-right",
          !hasValue && "italic text-ink-4",
          error && "ring-1 ring-red",
          className,
        )}
        title={hasValue ? formatter(display) : placeholder}
      >
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {hasValue ? formatter(display) : placeholder}
        </span>
        <StatusIndicator saving={showSpinner} saved={saved} error={!!error} />
      </button>
    );
  }

  return (
    <div className="rounded ring-2 ring-accent">
      <input
        ref={inputRef}
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        className="block w-full border-0 bg-transparent px-1.5 py-1 text-[13px] text-ink outline-none"
      />
    </div>
  );
}
