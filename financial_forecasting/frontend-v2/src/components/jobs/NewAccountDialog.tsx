import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Plus, X } from "lucide-react";

import { jobsAccountPath } from "@/components/jobs/jobsEntity";
import { sameNameAccount, useCreateJobsAccount, useResolveAccount, type AccountMatch } from "@/services/jobs";

function Spinner() {
  return <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>;
}

/**
 * Create an account — but only if it doesn't already exist. As the name is typed
 * we show a single de-duplicated list of matching accounts (our pipeline and
 * Salesforce merged into one — the user never sees the split). Pick one to open
 * it, or create a genuinely new one. Reconciliation between systems is handled
 * silently by the backend.
 */
export function NewAccountDialog({ onClose, initialName = "", onPicked }: {
  onClose: () => void;
  initialName?: string;
  /** When provided, selecting/creating returns the account to the caller instead
   *  of navigating to it (used when picking a company mid-form). */
  onPicked?: (a: { account_key: string; display: string }) => void;
}) {
  const nav = useNavigate();
  const [name, setName] = useState(initialName);
  const [debounced, setDebounced] = useState(initialName);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(name), 250);
    return () => clearTimeout(t);
  }, [name]);

  const { data, isFetching } = useResolveAccount(debounced);
  const create = useCreateJobsAccount();
  const matches = data?.matches ?? [];
  const exact = data?.exact ?? false;

  const done = (a: { account_key: string; display: string }) => {
    if (onPicked) onPicked(a); else nav(jobsAccountPath(a.account_key));
    onClose();
  };
  // Open a match: if we already hold it locally, go straight there; otherwise
  // materialize it (carrying its SF id) and then open — all invisible.
  // Another spelling of an account we already have is refused: take that one.
  const onError = (e: unknown) => { const existing = sameNameAccount(e); if (existing) done(existing); };
  const openMatch = (m: AccountMatch) => {
    if (m.key) return done({ account_key: m.key, display: m.label });
    create.mutate({ name: m.label, sf_account_id: m.sf_account_id }, { onSuccess: done, onError });
  };
  const createNew = () => create.mutate({ name: name.trim(), sf_account_id: null }, { onSuccess: done, onError });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Building2 size={15} className="text-accent" />New Account</h2>
          <button type="button" onClick={onClose} className="text-ink-3 transition-colors hover:text-ink" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Company Name <span className="text-red-500">*</span></label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp"
                   className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40" />
          </div>

          {name.trim().length >= 2 && (
            <div className="flex flex-col gap-1">
              {matches.length > 0 && (
                <>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Existing accounts</div>
                  <div className="flex flex-col">
                    {matches.map((m, i) => (
                      <button type="button" key={m.key ?? m.sf_account_id ?? i} disabled={create.isPending} onClick={() => openMatch(m)}
                              className="flex items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-2 disabled:opacity-50">
                        <Building2 size={14} className="shrink-0 text-ink-4" />
                        <span className="flex-1 truncate text-[13px] text-ink">{m.label}</span>
                        {m.record_count > 0 && <span className="shrink-0 text-[11px] text-ink-4">{m.record_count} contact{m.record_count === 1 ? "" : "s"}</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {isFetching && <div className="px-2 py-1 text-[11px] text-ink-4">Searching…</div>}
              {!exact && !isFetching && (
                <button type="button" disabled={create.isPending || !name.trim()} onClick={createNew}
                        className="mt-1 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-accent bg-accent-soft px-4 py-2 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50">
                  {create.isPending ? <Spinner /> : <Plus size={14} />}Create “{name.trim()}”
                </button>
              )}
              {exact && matches.length > 0 && (
                <div className="px-2 pt-1 text-[11px] text-ink-4">This account already exists — open it above.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
