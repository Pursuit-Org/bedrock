import { cn } from "@/lib/utils";
import type { DealType, JobStage } from "@/services/jobs";
import { DEAL_TYPE_LABELS, STAGE_LABELS } from "@/services/jobs";

const STAGE_STYLES: Record<JobStage, string> = {
  lead_submitted:               "bg-stone-100 text-stone-600",
  active_in_discussions:        "bg-amber-50 text-amber-700",
  active_opportunity_confirmed: "bg-emerald-50 text-emerald-700",
  reviewing_builders:           "bg-emerald-100 text-emerald-800 font-semibold",
  closed_won:                   "bg-green-100 text-green-800 font-semibold",
  closed_lost:                  "bg-red-50 text-red-600",
  // Legacy — kept so an un-migrated row still gets its colour rather than
  // falling through to the neutral default.
  initial_outreach:             "bg-blue-50 text-blue-700",
  active_builder_interview:     "bg-emerald-100 text-emerald-800 font-semibold",
  on_hold_not_selected:         "bg-stone-100 text-stone-500",
  on_hold_not_interested:       "bg-stone-100 text-stone-500",
  on_hold_not_responsive:       "bg-stone-100 text-stone-500",
};

const DEAL_TYPE_STYLES: Record<DealType, string> = {
  ft:          "bg-indigo-50 text-indigo-700",
  pt_contract: "bg-violet-50 text-violet-700",
  capstone:    "bg-cyan-50 text-cyan-700",
  volunteer:   "bg-teal-50 text-teal-700",
  workshop:    "bg-orange-50 text-orange-700",
  pilot:       "bg-pink-50 text-pink-700",
};

export function JobStageChip({ stage, className }: { stage: JobStage; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-4 tracking-wide", STAGE_STYLES[stage] ?? "bg-surface-2 text-ink-3", className)}>
      {STAGE_LABELS[stage] ?? stage ?? "—"}
    </span>
  );
}

export function DealTypeChip({ type, className }: { type: DealType; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-4 tracking-wide", DEAL_TYPE_STYLES[type] ?? "bg-surface-2 text-ink-3", className)}>
      {DEAL_TYPE_LABELS[type] ?? type ?? "—"}
    </span>
  );
}
