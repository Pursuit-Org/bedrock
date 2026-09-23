import { useMemo } from "react";
import {
  LEGACY_STAGES,
  STAGES_ORDERED,
  STAGE_LABELS,
  useStageVocabulary,
  type JobStage,
} from "@/services/jobs";

/** Opportunity stage picker options.
 *
 *  Lives here rather than in JobsTeam.tsx so the account tabs and the inline
 *  expand-panel rows can use it too: JobsTeam already imports from
 *  components/jobs/jobsEntity, so importing the hook back out of JobsTeam
 *  would close an import cycle.
 */
const STAGE_OPTIONS: { value: JobStage; label: string }[] = STAGES_ORDERED.map((s) => ({
  value: s,
  label: STAGE_LABELS[s] ?? s,
}));

const LEGACY_SET = new Set<JobStage>(LEGACY_STAGES);

/** STAGES_ORDERED is the offerable set; retired values are never proposed. A
 *  deal still sitting on one keeps it pinned at the top of its own picker, so
 *  opening the row doesn't silently propose a stage change. */
export function stageOptionsFor(stage: JobStage): { value: JobStage; label: string }[] {
  return LEGACY_SET.has(stage)
    ? [{ value: stage, label: STAGE_LABELS[stage] ?? stage }, ...STAGE_OPTIONS]
    : STAGE_OPTIONS;
}

/** Stage options gated on what the database currently accepts.
 *
 *  STAGES_ORDERED carries the 2026-09-21 expansion, but the CHECK constraint
 *  only accepts those four once the migration is applied — so an ungated picker
 *  offers stages that fail on save. Unavailable values render disabled with the
 *  reason, rather than being hidden (missing reads as "not built"; disabled
 *  reads as "waiting on the migration").
 */
export function useOppStageOptions(stage: JobStage) {
  return useGatedStageOptions(stage);
}

/** The gated option list with no row-specific pinning — for table-wide pickers
 *  that aren't tied to one deal's current stage. */
export type StageOption = { value: JobStage; label: string; disabled?: boolean; title?: string };

export function useGatedStageOptions(stage?: JobStage): StageOption[] {
  const { data: vocab } = useStageVocabulary();
  return useMemo(() => {
    const base = stage ? stageOptionsFor(stage) : STAGE_OPTIONS;
    if (!vocab) return base;
    const byValue = new Map(vocab.opportunity_stages.map((o) => [o.value, o]));
    return base.map((o) => {
      const v = byValue.get(o.value);
      // Unknown to the vocabulary (a legacy value pinned in for the current
      // row) stays selectable — it's already stored, so it can be written back.
      if (!v || v.available) return o;
      return { ...o, disabled: true, title: v.unavailable_reason ?? undefined };
    });
  }, [vocab, stage]);
}
