import { useState } from "react";
import { X } from "lucide-react";

import { useContactSearch, type ContactSearchResult } from "@/services/jobs";

/** A contact picked for a new opportunity: the ref stored on its contact list
 *  (pub:, airtable: or a Salesforce id) and a name to show. */
export interface PickedContact {
  ref: string;
  label: string;
}

/**
 * Pick the contacts of an opportunity that doesn't exist yet. Creating an
 * opportunity means picking its contacts (D15, PRO-101): its activity and its
 * conversions are found through them. Controlled; the form sends
 * `value.map((c) => c.ref)` as `sf_contact_ids`.
 */
export function ContactRefsPicker({ value, onChange, company, autoFocus }: {
  value: PickedContact[];
  onChange: (next: PickedContact[]) => void;
  /** The account, so its people come first in the results. */
  company?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const search = useContactSearch(q);
  const k = company?.trim().toLowerCase();
  const results: ContactSearchResult[] = q.length >= 2
    ? [...(search.data ?? [])].sort((a, b) =>
        Number((b.current_company ?? "").trim().toLowerCase() === k)
        - Number((a.current_company ?? "").trim().toLowerCase() === k))
    : [];

  const add = (r: ContactSearchResult) => {
    if (!value.some((c) => c.ref === r.contact_ref)) {
      onChange([...value, { ref: r.contact_ref, label: r.full_name ?? `#${r.contact_id}` }]);
    }
    setQ("");
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((c) => (
            <span key={c.ref}
              className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2">
              {c.label}
              <button type="button" onClick={() => onChange(value.filter((x) => x.ref !== c.ref))}
                className="text-ink-4 hover:text-red-500" aria-label={`Remove ${c.label}`}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          type="text"
          value={q}
          autoFocus={autoFocus}
          onFocus={() => { if (q.length >= 2) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          placeholder={value.length ? "Add another contact…" : "Search contacts by name…"}
          className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        {open && q.length >= 2 && (
          <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border-strong bg-surface shadow-lg">
            {search.isLoading ? (
              <li className="px-3 py-2 text-[12px] text-ink-3">Searching…</li>
            ) : results.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-ink-4">No contacts found.</li>
            ) : results.slice(0, 12).map((r) => (
              <li key={r.contact_id}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(r)}
                  className="flex w-full items-baseline gap-1.5 px-3 py-1.5 text-left text-[12.5px] text-ink hover:bg-surface-2">
                  <span className="font-medium">{r.full_name ?? `#${r.contact_id}`}</span>
                  <span className="truncate text-ink-3">
                    {[r.current_title, r.current_company].filter(Boolean).join(" @ ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
