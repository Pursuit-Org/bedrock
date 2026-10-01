import { useEffect, useState } from "react";
import { Loader2, X, Building2, ArrowRight, Briefcase } from "lucide-react";

import { SF_STAGE_OPTIONS } from "@/lib/stages";
import {
  isSfAccountId,
  useHandoffOpportunity,
  useSearchSfAccounts,
  type SfAccountRef,
} from "@/services/jobsSf";

/**
 * Hand a jobs opportunity off to PBC — create a SEPARATE Salesforce revenue
 * Opportunity (RecordType PBC) linked back to the jobs opp. Not a field-map:
 * the user fills the revenue form. Salary is deliberately NOT the Amount.
 */
export function HandoffToPbcDialog({
  oppId,
  accountId,
  accountName,
  defaultName,
  defaultCloseDate,
  onClose,
}: {
  oppId: string;
  accountId: string | null;
  accountName: string;
  defaultName: string;
  /** Prefills Salesforce CloseDate from the jobs deal's target close date. */
  defaultCloseDate?: string | null;
  onClose: () => void;
}) {
  const handoff = useHandoffOpportunity();
  const searchAccounts = useSearchSfAccounts();

  const accountLinked = isSfAccountId(accountId);
  const [name, setName] = useState(defaultName);
  const [stage, setStage] = useState("New Lead");
  const [amount, setAmount] = useState("");
  const [closeDate, setCloseDate] = useState(defaultCloseDate ?? "");

  // account resolution (only when the opp's account isn't already in SF)
  const [acctQuery, setAcctQuery] = useState(accountName);
  const [acctResults, setAcctResults] = useState<SfAccountRef[] | null>(null);
  const [pickedAcct, setPickedAcct] = useState<SfAccountRef | null>(null);
  const [createAcct, setCreateAcct] = useState(false);

  useEffect(() => {
    if (!accountLinked && accountName.trim()) {
      searchAccounts.mutate(accountName.trim(), { onSuccess: setAcctResults });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const accountResolved = accountLinked || !!pickedAcct || createAcct;
  const canSubmit = name.trim() && closeDate && accountResolved && !handoff.isPending;

  function submit() {
    handoff.mutate(
      {
        opp_id: oppId,
        name: name.trim(),
        stage,
        amount: amount ? Number(amount) : null,
        close_date: closeDate,
        account_sf_id: accountLinked ? accountId! : pickedAcct?.id,
        account_create_name: !accountLinked && createAcct ? accountName : undefined,
      },
      { onSuccess: onClose },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-3.5">
          <div>
            <h2 className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-ink"><Briefcase size={15} /> Hand off to PBC</h2>
            <p className="text-[11.5px] text-ink-4">Creates a separate Salesforce revenue opportunity, linked to this deal.</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-3.5">
            <Field label="Opportunity name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inp} />
            </Field>

            {/* Account */}
            <Field label="Salesforce account">
              {accountLinked ? (
                <div className="flex items-center gap-2 rounded-md border border-green/40 bg-green/10 px-3 py-1.5 text-[12.5px] text-green">
                  <Building2 size={13} /> {accountName} <span className="text-[11px] text-green/70">· already in Salesforce</span>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {searchAccounts.isPending ? (
                    <div className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 size={12} className="animate-spin" /> Searching…</div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input value={acctQuery} onChange={(e) => setAcctQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchAccounts.mutate(acctQuery.trim(), { onSuccess: setAcctResults }); } }} placeholder="Search Salesforce accounts…" className={inp} />
                        <button type="button" onClick={() => searchAccounts.mutate(acctQuery.trim(), { onSuccess: setAcctResults })} className="rounded-md border border-border-strong px-3 text-[12px] text-ink hover:border-accent">Search</button>
                      </div>
                      {acctResults?.map((a) => (
                        <button key={a.id} type="button" onClick={() => { setPickedAcct(a); setCreateAcct(false); }} className={`flex items-center justify-between rounded-lg border px-3 py-1.5 text-left ${pickedAcct?.id === a.id ? "border-accent bg-accent-soft" : "border-border-strong hover:border-accent"}`}>
                          <span className="truncate text-[12.5px] text-ink">{a.name}</span>
                          <span className="text-[11px] text-ink-4">{[a.type, a.city].filter(Boolean).join(" · ")}</span>
                        </button>
                      ))}
                      <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 ${createAcct ? "border-accent bg-accent-soft" : "border-border-strong"}`}>
                        <input type="checkbox" checked={createAcct} onChange={(e) => { setCreateAcct(e.target.checked); if (e.target.checked) setPickedAcct(null); }} />
                        <span className="text-[12.5px] text-ink">Create new account "{accountName}"</span>
                      </label>
                    </>
                  )}
                </div>
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Stage">
                <select value={stage} onChange={(e) => setStage(e.target.value)} className={inp}>
                  {SF_STAGE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Close date">
                <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} className={inp} />
              </Field>
            </div>

            <Field label="Amount (revenue $ — not the builder salary)">
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Optional — PBC can fill in" className={inp} />
            </Field>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-strong px-5 py-3">
          <button type="button" onClick={onClose} className="text-[12.5px] text-ink-3 hover:text-ink">Cancel</button>
          <button type="button" onClick={submit} disabled={!canSubmit} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40">
            {handoff.isPending ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
            Create PBC opportunity
          </button>
        </div>
      </div>
    </div>
  );
}

const inp = "w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">{label}</label>
      {children}
    </div>
  );
}
