import { useState } from "react";
import { X } from "lucide-react";

import { useUpdateOpportunity } from "@/services/jobs";

// Structured closed-lost reasons (drives the "why deals die" analysis).
// The combined vocabulary (Kwame 2026-08-05): the seven already in use plus the
// four from the stage simplification, rather than replacing one list with the
// other. `revisit` is the interesting one — picking it asks for a date and files
// a task, which is how "come back to this" survives being closed lost.
// Offered reasons, trimmed 2026-08-05: "Went cold / no response" overlapped
// Not responsive, and "Timing / not now" overlapped Revisit later — which is the
// same thing with a date attached. "Hired elsewhere" dropped too. The retired
// values stay in CLOSED_LOST_LABELS and in the database CHECK, because four live
// rows still carry them; they render, they just can't be chosen again.
const CLOSED_LOST_REASONS: { value: string; label: string }[] = [
  { value: "budget",          label: "No budget" },
  { value: "not_a_fit",       label: "Not a fit" },
  { value: "role_cancelled",  label: "Role cancelled" },
  { value: "not_interested",  label: "Not interested" },
  { value: "not_selected",    label: "Not selected" },
  { value: "not_responsive",  label: "Not responsive" },
  { value: "revisit",         label: "Revisit later" },
  { value: "other",           label: "Other" },
];

/**
 * Closing an opportunity as lost. The reason is required (PRO-110: 12 of 88
 * lost opportunities had none on 10/20, so the Thursday view couldn't say why
 * deals were lost), so this modal makes the move: the stage, reason and note
 * go in one save. Cancel leaves the stage as it was. It used to open after
 * the stage had already saved, and Skip left the opportunity lost with no
 * reason.
 */
export function ClosedLostModal({
  deal,
  onClose,
}: {
  deal: { id: string; account_name: string };
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // Revisit is the one reason that isn't an ending — it needs a date, or it's
  // just Closed Lost with extra steps. Defaults a month out so the common case
  // is one click.
  const [revisitDate, setRevisitDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const isRevisit = reason === "revisit";
  const updateOpp = useUpdateOpportunity();

  function save() {
    updateOpp.mutate(
      {
        id: deal.id,
        stage: "closed_lost",
        closed_lost_reason: reason,
        closed_lost_note: note.trim() || null,
        // Reuses follow_up_date — the column that already exists for exactly
        // this. The backend turns it into a jobs_task for the deal's owner.
        ...(isRevisit ? { follow_up_date: revisitDate } : {}),
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">Why did {deal.account_name} fall through?</h2>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Reason <span className="text-red">*</span>
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              <option value="">— select —</option>
              {CLOSED_LOST_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          {isRevisit && (
            <div className="flex flex-col gap-1 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                Come back to this on
              </label>
              <input
                type="date"
                value={revisitDate}
                onChange={(e) => { if (e.target.value) setRevisitDate(e.target.value); }}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
              <span className="text-[11px] text-accent">
                Files a task for the opportunity's owner on that date.
              </span>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Note <span className="text-red">*</span>
            </label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={isRevisit
                ? "Who to check back with, and why — e.g. \"check with Jane Doe once budget resets in Q1\""
                : "Context — what happened, who said what…"}
              className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border-strong px-5 py-3">
          <button type="button" onClick={onClose} title="The stage stays as it was"
            className="text-[13px] font-medium text-ink-3 hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            // Reason AND note are both required: a bare reason code loses the
            // one thing worth keeping, which is what actually happened.
            disabled={updateOpp.isPending || !reason || !note.trim()}
            title={!reason ? "Pick a reason" : !note.trim() ? "Add a note — it's required" : undefined}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {updateOpp.isPending ? "Saving…" : "Close as lost"}
          </button>
        </div>
      </div>
    </div>
  );
}
