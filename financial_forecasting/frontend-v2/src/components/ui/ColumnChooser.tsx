import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Columns3 } from "lucide-react";

import { cn } from "@/lib/utils";

interface ColumnChooserProps<K extends string> {
  allColumns: K[];
  labels: Record<K, string>;
  visible: K[];
  required?: K[];
  onToggle: (col: K) => void;
  /** When given, shown columns list in table order with up/down arrows that
   *  move a column one place left (-1) or right (+1). */
  onMove?: (col: K, dir: -1 | 1) => void;
}

/** Column visibility menu, shared by every data grid. Styled check rows
 * (no native checkboxes), z-50 so sticky table headers can't paint over it,
 * scrolls internally past ~12 items, closes on outside click or Escape. */
export function ColumnChooser<K extends string>({
  allColumns,
  labels,
  visible,
  required = [],
  onToggle,
  onMove,
}: ColumnChooserProps<K>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = visible.length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink",
          open && "border-ink-3 bg-surface-2 text-ink",
        )}
      >
        <Columns3 size={12} />
        Columns
        {shown < allColumns.length && (
          <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-semibold tabular-nums text-ink-3">
            {shown}/{allColumns.length}
          </span>
        )}
      </button>

      {open && (
        <div className={cn("absolute right-0 top-8 z-50 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl",
          onMove ? "w-[250px]" : "w-[210px]")}>
          <div className="border-b border-border-strong/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
            {onMove ? "Show and order columns" : "Show columns"}
          </div>
          <div className="max-h-[320px] overflow-y-auto p-1">
            {(onMove ? [...visible, ...allColumns.filter((c) => !visible.includes(c))] : allColumns).map((col) => {
              const isReq = required.includes(col);
              const isVisible = visible.includes(col);
              const at = visible.indexOf(col);
              const toggleBtn = (
                <button
                  key={col}
                  type="button"
                  disabled={isReq}
                  onClick={() => onToggle(col)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
                    isReq ? "cursor-default" : "hover:bg-surface-2",
                    isVisible ? "text-ink" : "text-ink-3",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                      isVisible
                        ? "border-accent bg-accent text-white"
                        : "border-border-strong bg-surface",
                      isReq && "opacity-45",
                    )}
                  >
                    {isVisible && <Check size={10.5} strokeWidth={3} />}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", isReq && "opacity-60")}>
                    {labels[col]}
                  </span>
                  {isReq && <span className="text-[9.5px] uppercase tracking-wide text-ink-4">fixed</span>}
                </button>
              );
              if (!onMove) return toggleBtn;
              return (
                <div key={col} className="flex items-center gap-0.5">
                  <div className="min-w-0 flex-1">{toggleBtn}</div>
                  {isVisible && (
                    <span className="flex shrink-0 gap-0.5 pr-1">
                      <button type="button" aria-label={`Move ${labels[col]} left`} disabled={at === 0}
                        onClick={() => onMove(col, -1)}
                        className="grid h-5 w-5 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-25">
                        <ChevronUp size={12} />
                      </button>
                      <button type="button" aria-label={`Move ${labels[col]} right`} disabled={at === visible.length - 1}
                        onClick={() => onMove(col, 1)}
                        className="grid h-5 w-5 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-25">
                        <ChevronDown size={12} />
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
