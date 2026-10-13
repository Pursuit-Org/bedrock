/**
 * Converting a contact names its opportunity (D15, decided 10/2).
 *
 * Only 23 of 138 converted contacts pointed to an opportunity, so an
 * opportunity's activity and its conversions couldn't be found from the
 * contact. Converting now means picking the opportunity (or opportunities) at
 * the contact's account, or creating one with the contact already on it.
 * The dialog only collects the choice; useContactStageChange writes it.
 */
import { useEffect, useMemo, useState } from "react";
import { Handshake } from "lucide-react";

import { CompanyPicker } from "@/components/jobs/CompanyPicker";
import {
  useContactOpportunities, DEAL_TYPE_LABELS, STAGE_LABELS,
  type DealType,
} from "@/services/jobs";

export interface NewOpportunityChoice {
  account_name: string;
  deal_type: DealType;
  title: string;
  target_close_date: string;
}

export interface ConvertChoice {
  opportunityIds: string[];
  create: NewOpportunityChoice | null;
}

const CLOSED = new Set(["closed_won", "closed_lost"]);

export function ConvertDialog({ contactId, contactName, company, onCancel, onSave }: {
  contactId: number;
  contactName: string;
  company?: string | null;
  onCancel: () => void;
  onSave: (choice: ConvertChoice) => void;
}) {
  const { data: opps = [], isLoading } = useContactOpportunities(contactId);
  // Open opportunities first; lost ones aren't something to convert into.
  const choices = useMemo(
    () => opps.filter((o) => o.stage !== "closed_lost")
      .sort((a, b) => Number(CLOSED.has(a.stage)) - Number(CLOSED.has(b.stage))),
    [opps]);
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<NewOpportunityChoice>({
    account_name: company?.trim() ?? "", deal_type: "ft", title: "", target_close_date: "",
  });

  // One open opportunity at the account: that's almost always the one.
  useEffect(() => {
    if (isLoading) return;
    const open = choices.filter((o) => !CLOSED.has(o.stage));
    if (open.length === 1) setPicked([open[0].id]);
    if (choices.length === 0) setCreating(true);
  }, [isLoading, choices]);

  const newValid = !!form.account_name.trim() && !!form.target_close_date;
  const canSave = (picked.length > 0 || creating) && (!creating || newValid);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div className="w-full max-w-[440px] rounded-xl border border-border-strong bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Handshake size={15} className="text-green" />
          <h2 className="text-[14px] font-semibold text-ink">Convert {contactName}</h2>
        </div>
        <p className="mt-1 text-[12px] text-ink-3">
          Which opportunity did they convert to? Their activity will count on it.
        </p>

        <div className="mt-3 flex flex-col gap-1">
          {isLoading && <div className="text-[12px] text-ink-4">Loading opportunities…</div>}
          {!isLoading && choices.length === 0 && (
            <div className="text-[12px] text-ink-4">
              No opportunities at {company?.trim() || "their account"} yet. Create one below.
            </div>
          )}
          {choices.map((o) => (
            <label key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border-strong px-2.5 py-1.5 hover:bg-surface-2">
              <input type="checkbox" checked={picked.includes(o.id)} onChange={() => toggle(o.id)} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                {o.title || o.account_name}
                {o.title && <span className="text-ink-3"> · {o.account_name}</span>}
              </span>
              <span className="shrink-0 text-[11px] text-ink-4">
                {STAGE_LABELS[o.stage] ?? o.stage}
                {o.deal_type ? ` · ${DEAL_TYPE_LABELS[o.deal_type] ?? o.deal_type}` : ""}
              </span>
            </label>
          ))}
        </div>

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-ink-2">
          <input type="checkbox" checked={creating} onChange={(e) => setCreating(e.target.checked)} />
          Create a new opportunity
        </label>
        {creating && (
          <div className="mt-2 flex flex-col gap-2 rounded-md border border-border-strong bg-surface-2/40 p-2.5">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Account</span>
              <div className="mt-1">
                <CompanyPicker value={form.account_name}
                  onChange={(v) => setForm((f) => ({ ...f, account_name: v }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Opportunity type</span>
                <select value={form.deal_type}
                  onChange={(e) => setForm((f) => ({ ...f, deal_type: e.target.value as DealType }))}
                  className="mt-1 h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-ink">
                  {(Object.keys(DEAL_TYPE_LABELS) as DealType[]).map((t) => (
                    <option key={t} value={t}>{DEAL_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Target close date</span>
                <input type="date" value={form.target_close_date} required
                  onChange={(e) => setForm((f) => ({ ...f, target_close_date: e.target.value }))}
                  className="mt-1 h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-ink" />
              </label>
            </div>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Name (optional)</span>
              <input value={form.title} placeholder="e.g. Software engineering cohort"
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className="mt-1 h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-ink" />
            </label>
            <p className="text-[11px] text-ink-4">{contactName} is added as its contact.</p>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="h-8 rounded-md border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2">
            Cancel
          </button>
          <button type="button" disabled={!canSave}
            onClick={() => onSave({ opportunityIds: picked, create: creating ? form : null })}
            className="h-8 rounded-md bg-accent px-3 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-40">
            Convert
          </button>
        </div>
      </div>
    </div>
  );
}
