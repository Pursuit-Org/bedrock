import { useState } from "react";

import { useUpdateOpportunity, type JobsOpportunity } from "@/services/jobs";
import { plainDay } from "@/components/jobs/pipelineText";
import { cn } from "@/lib/utils";

/** Local YYYY-MM-DD, `days` from today. */
function dayFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The owner's "slow but active" mark on an open opportunity (PRO-110; Avni,
 * 10/2): it is alive though nothing has happened for weeks, e.g. an enterprise
 * hiring cycle. A reason and a date to check again are both required. Until
 * that date the Thursday view lists it under Slow but active instead of
 * Stalled; after it, a quiet opportunity reads as stalled again.
 */
export function SlowButActive({ opp }: { opp: JobsOpportunity }) {
  const update = useUpdateOpportunity();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [checkAgain, setCheckAgain] = useState("");
  if (opp.stage.startsWith("closed")) return null;
  // The columns arrive with the 2026-10-20 migration; until then the API
  // doesn't return them and would refuse the save.
  if (!("slow_reason" in opp)) {
    return <span className="text-[12px] text-ink-4" title="2026-10-20-opportunity-slow-but-active.sql">Available once its migration runs</span>;
  }
  const today = dayFromToday(0);
  const marked = !!opp.slow_reason && !!opp.slow_check_again;
  const lapsed = marked && opp.slow_check_again!.slice(0, 10) < today;

  const startEdit = () => {
    setReason(opp.slow_reason ?? "");
    setCheckAgain(opp.slow_check_again?.slice(0, 10) && !lapsed ? opp.slow_check_again.slice(0, 10) : dayFromToday(30));
    setEditing(true);
  };
  const save = () => update.mutate(
    { id: opp.id, slow_reason: reason.trim(), slow_check_again: checkAgain },
    { onSuccess: () => setEditing(false) },
  );
  const clear = () => update.mutate({ id: opp.id, slow_reason: null, slow_check_again: null });

  if (editing) {
    const ok = reason.trim() !== "" && checkAgain >= today;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
          placeholder="Why it's still alive, e.g. next headcount cycle in November"
          className="h-7 min-w-[240px] flex-1 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none" />
        <label className="flex items-center gap-1 text-[11.5px] text-ink-3">
          Check again
          <input type="date" value={checkAgain} min={today} onChange={(e) => setCheckAgain(e.target.value)}
            className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink focus:border-accent focus:outline-none" />
        </label>
        <button type="button" onClick={save} disabled={!ok || update.isPending}
          title={!reason.trim() ? "Say why it's still alive" : checkAgain < today ? "Pick a date from today on" : undefined}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50">
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setEditing(false)} className="text-[12px] text-ink-3 hover:text-ink">Cancel</button>
      </div>
    );
  }
  if (!marked) {
    return (
      <button type="button" onClick={startEdit} className="text-[12px] text-accent hover:underline"
        title="It's alive but slow: list it under Slow but active instead of Stalled, until a date you pick">
        Mark slow but active
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 text-[12px]">
      <span className="text-ink-2">{opp.slow_reason}</span>
      <span className={cn(lapsed ? "font-medium text-[var(--red)]" : "text-ink-4")}>
        {lapsed ? `Check-again date passed (${plainDay(opp.slow_check_again!)})` : `check again ${plainDay(opp.slow_check_again!)}`}
      </span>
      <button type="button" onClick={startEdit} className="text-accent hover:underline">{lapsed ? "Renew" : "Edit"}</button>
      <button type="button" onClick={clear} disabled={update.isPending} className="text-ink-3 hover:text-red">Clear</button>
    </span>
  );
}
