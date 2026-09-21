import { useState } from "react";
import { Loader2, X } from "lucide-react";

import { useUpdatePlacementStage, END_REASON_LABELS, type EndReason } from "@/services/jobs";

/**
 * Closing out a placement — fires when the Status dropdown in the placements
 * drill moves to a terminal stage, before anything is written.
 *
 * The end date is required: the API rejects a terminal stage without one, and
 * that requirement is the whole reason this dialog exists. A status dropdown
 * that silently sets a stage is how the table ended up with one end date across
 * 78 records. The reason is optional in spirit — "Unknown" is a real choice —
 * so nobody has to invent a cause just to record that someone moved on.
 *
 * On cancel: nothing is written and the dropdown keeps its old value.
 */
export function PlacementEndDialog({
  placementId,
  stage,
  builder,
  role,
  onClose,
  onSaved,
}: {
  placementId: string;
  /** 'completed' | 'ended' — which terminal stage was picked. */
  stage: string;
  builder: string;
  role: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const updateStage = useUpdatePlacementStage();
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState<EndReason>(
    stage === "completed" ? "contract_ended" : "unknown",
  );
  const [note, setNote] = useState("");
  const submitting = updateStage.isPending;

  const label = stage === "completed" ? "Completed" : "No longer in role";
  const fieldClass =
    "w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[13px] " +
    "text-ink outline-none focus:border-accent";

  async function confirm() {
    if (!endDate || submitting) return;
    await updateStage.mutateAsync({
      id: placementId,
      engagement_stage: stage,
      end_date: endDate,
      end_reason: reason,
      end_note: note.trim() || undefined,
    });
    onSaved?.();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="flex w-full max-w-[440px] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl">
        <header className="flex items-start justify-between border-b border-border-strong px-5 py-3">
          <div>
            <h2 className="text-[14px] font-medium text-ink">Mark as {label.toLowerCase()}</h2>
            <p className="mt-0.5 text-[12px] text-ink-4">
              {builder} · {role}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded p-1 text-ink-4 hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">End date</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className={fieldClass}
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">Reason</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as EndReason)}
              className={fieldClass}
            >
              {(Object.keys(END_REASON_LABELS) as EndReason[]).map((r) => (
                <option key={r} value={r}>
                  {END_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className={fieldClass}
            />
          </label>

          {/* Said plainly, because the number not moving is the surprising part. */}
          <p className="text-[11.5px] text-ink-4">
            They stay counted as placed — the metric is that they were placed. This
            only adds them to the "no longer in role" breakdown.
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border-strong px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded px-3 py-1.5 text-[13px] text-ink-3 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!endDate || submitting}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
          >
            {submitting && <Loader2 size={13} className="animate-spin" />}
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
