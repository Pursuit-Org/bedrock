import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download } from "lucide-react";

import { useExportColumns, type ExportEntity } from "@/services/jobs";
import { cn } from "@/lib/utils";

/**
 * Export the selection as .xlsx, with an optional column picker.
 *
 * A split control on purpose: the left half exports immediately, so the
 * one-click path nobody wants to lose stays one click. The caret opens the
 * picker for the times you need something outside the default set.
 *
 * The column list is fetched from the server (GET /export/{entity}/columns)
 * rather than declared here — the same list is the allowlist that filters the
 * export request, and two copies would drift.
 */
export function ExportButton({ entity = "contacts", count, busy, onExport }: {
  entity?: ExportEntity;
  count: number;
  busy: boolean;
  onExport: (columns?: string[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const { data: available = [] } = useExportColumns(entity, open);
  const ref = useRef<HTMLDivElement>(null);

  // null = "whatever the server calls default". Only once you touch the picker
  // does an explicit list get sent, so a default export keeps working even if
  // the column set changes server-side.
  const [picked, setPicked] = useState<string[] | null>(null);

  const defaults = useMemo(
    () => available.filter((c) => c.default).map((c) => c.key),
    [available],
  );
  const effective = picked ?? defaults;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (key: string) =>
    setPicked((prev) => {
      const base = prev ?? defaults;
      return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    });

  const run = () => {
    setOpen(false);
    void onExport(picked ?? undefined);
  };

  const label = `${count} contact${count === 1 ? "" : "s"}`;

  return (
    <div className="relative flex" ref={ref}>
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="inline-flex h-7 items-center gap-1 rounded-l border border-r-0 border-border-strong bg-surface px-3 font-medium text-ink-2 hover:text-ink disabled:opacity-50"
        title={`Download the ${label} as an Excel file`}
      >
        <Download size={12} /> {busy ? "Exporting…" : "Export"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        aria-label="Choose export columns"
        aria-expanded={open}
        className={cn(
          "inline-flex h-7 items-center rounded-r border border-border-strong bg-surface px-1.5 text-ink-3 hover:text-ink disabled:opacity-50",
          open && "border-ink-3 bg-surface-2 text-ink",
        )}
      >
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-50 w-[240px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-border-strong/70 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-4">
              Columns
            </span>
            <span className="flex gap-2 text-[11px]">
              <button type="button" onClick={() => setPicked(available.map((c) => c.key))}
                className="font-medium text-accent hover:underline">All</button>
              <button type="button" onClick={() => setPicked(null)}
                className="font-medium text-ink-3 hover:text-ink hover:underline">Reset</button>
            </span>
          </div>

          <div className="max-h-[300px] overflow-y-auto p-1">
            {available.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-ink-4">Loading…</p>
            ) : available.map((c) => {
              const on = effective.includes(c.key);
              return (
                <button key={c.key} type="button" onClick={() => toggle(c.key)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface-2",
                    on ? "text-ink" : "text-ink-3",
                  )}>
                  <span className={cn(
                    "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                    on ? "border-accent bg-accent text-white" : "border-border-strong bg-surface",
                  )}>
                    {on && <Check size={10.5} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                </button>
              );
            })}
          </div>

          <div className="border-t border-border-strong/70 p-2">
            <button type="button" disabled={busy || effective.length === 0} onClick={run}
              className="h-7 w-full rounded-md bg-accent text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
              Export {label} · {effective.length} column{effective.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
