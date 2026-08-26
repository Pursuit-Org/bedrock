/**
 * Search-based picker for selecting an existing bedrock.award — the
 * "contract" a new Commitment belongs to.
 *
 * Cloned from AccountPicker.tsx's portal-popover + client-filtered-search
 * pattern. No onCreateNew — unlike accounts, awards are never created
 * inline here; they're only ever created automatically off the
 * Salesforce closed-won pipeline (services/awards_service.py), so a
 * grant owner can only pick from what already exists.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

export interface AwardOption {
  value: string;
  label: string;
  sublabel?: string;
}

export interface AwardPickerProps {
  value: string | null;
  options: AwardOption[];
  onSelect: (next: string) => void;
  placeholder?: string;
  maxVisible?: number;
}

export function AwardPicker({
  value,
  options,
  onSelect,
  placeholder = "Search awards…",
  maxVisible = 50,
}: AwardPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const [coords, setCoords] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 0,
  });

  useLayoutEffect(() => {
    if (!open) return;
    const updateCoords = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setCoords({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    updateCoords();
    window.addEventListener("scroll", updateCoords, true);
    window.addEventListener("resize", updateCoords);
    return () => {
      window.removeEventListener("scroll", updateCoords, true);
      window.removeEventListener("resize", updateCoords);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => inputRef.current?.focus());
    } else {
      setQ("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options.slice(0, maxVisible);
    return options
      .filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          (o.sublabel ?? "").toLowerCase().includes(needle),
      )
      .slice(0, maxVisible);
  }, [options, q, maxVisible]);

  const current = options.find((o) => o.value === value) ?? null;

  const pick = (next: AwardOption) => {
    onSelect(next.value);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded border border-border-strong bg-surface px-3 py-2 text-left text-[13px] text-ink hover:border-accent",
          !current && "italic text-ink-4",
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="min-w-0 flex-1 truncate">
          {current ? current.label : placeholder}
        </span>
      </button>

      {open
        ? createPortal(
            <div
              ref={popoverRef}
              style={{
                position: "fixed",
                left: coords.left,
                top: coords.top,
                minWidth: Math.max(coords.width, 280),
                maxWidth: 420,
              }}
              className="z-50 rounded-md border border-border-strong bg-surface shadow-lg"
              role="listbox"
            >
              <div className="flex items-center gap-1 border-b border-border-strong px-2 py-1.5">
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search awards…"
                  className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
                />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-ink-3 hover:text-ink"
                  aria-label="Close"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="max-h-[260px] overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="px-3 py-3 text-center text-[12px] text-ink-3">
                    {q ? `No awards match "${q}"` : "No awards available."}
                  </div>
                ) : (
                  filtered.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => pick(o)}
                      className={cn(
                        "block w-full truncate px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2",
                        o.value === value && "bg-accent/10 font-medium text-ink",
                      )}
                      title={o.sublabel ? `${o.label} — ${o.sublabel}` : o.label}
                    >
                      <span className="block truncate">{o.label}</span>
                      {o.sublabel ? (
                        <span className="block truncate text-[11px] text-ink-3">{o.sublabel}</span>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
              {options.length > maxVisible && !q ? (
                <div className="border-t border-border-strong bg-surface-2 px-3 py-1 text-[11px] text-ink-3">
                  Showing first {maxVisible} of {options.length.toLocaleString()} —
                  type to narrow.
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
