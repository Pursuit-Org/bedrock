import { useState } from "react";
import { X } from "lucide-react";

import { CompanyPicker } from "@/components/jobs/CompanyPicker";
import { cn } from "@/lib/utils";

/**
 * A contact's company, edited in place by picking an account (D9, PRO-101).
 * Typing a company freely is how JPMorgan Chase ended up with ten spellings, so
 * the editor is the account picker: an existing account, or a new one through
 * the dialog that checks for duplicates first.
 */
export function InlineCompany({ value, onSave, placeholder = "—" }: {
  value: string | null | undefined;
  onSave: (name: string) => Promise<unknown>;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    const has = !!value?.trim();
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title={error ?? (has ? value! : placeholder)}
        className={cn(
          "flex w-full max-w-full items-center rounded px-1.5 py-1 text-left text-[13px] text-ink-2 hover:bg-surface hover:ring-1 hover:ring-border-strong",
          !has && "italic text-ink-4", error && "ring-1 ring-red", saving && "opacity-60")}>
        <span className="min-w-0 flex-1 truncate">{has ? value : placeholder}</span>
      </button>
    );
  }

  return (
    <div className="flex items-start gap-1" onClick={(e) => e.stopPropagation()}>
      <div className="min-w-0 flex-1">
        <CompanyPicker value="" onChange={async (name) => {
          if (!name) return;
          setEditing(false);
          if (name.trim() === (value ?? "").trim()) return;
          setSaving(true);
          setError(null);
          try {
            await onSave(name);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Failed");
          } finally {
            setSaving(false);
          }
        }} />
      </div>
      <button type="button" onClick={() => setEditing(false)} aria-label="Cancel"
        className="mt-2 text-ink-4 hover:text-ink"><X size={13} /></button>
    </div>
  );
}
