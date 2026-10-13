/**
 * The campaign pipeline's buckets: what the Sankey draws and what each of its
 * labels lists. Pure, so the chart, the contact list it opens and the tests
 * all read one definition (PRO-100).
 *
 *   In pipeline → Contacted / Not yet contacted → the stage each one is at
 *
 * "Contacted" is the one rule the campaign row and the Activation card use:
 * reached by activity from anyone at Pursuit (services/outreach_counting). It
 * used to be "any stage past Assigned" here and "Initial Outreach now" on the
 * row, so one Operation 35 screen read 78 and 25. A contact can sit at any
 * stage either way — ruled out without a word (Not a fit, never contacted), or
 * worked and still at Assigned — so both branches feed the stage nodes.
 */
import type { CampaignNumbers, MembershipStage } from "../../services/jobs";

export type PipelineStage = Exclude<MembershipStage, "on_hold">;

export type PipelineBucket = "all" | "contacted" | "not_contacted" | PipelineStage;

/** Funnel order, the off-ramps last. */
export const PIPELINE_STAGES: PipelineStage[] = [
  "assigned", "initial_outreach", "scheduling", "call_booked",
  "converted_to_opportunity", "revisit", "not_a_fit",
];

export const BUCKET_LABELS: Record<PipelineBucket, string> = {
  all: "In pipeline",
  contacted: "Contacted",
  not_contacted: "Not yet contacted",
  assigned: "Assigned",
  initial_outreach: "In outreach",
  scheduling: "Scheduling",
  call_booked: "Call booked",
  converted_to_opportunity: "Converted to oppty",
  revisit: "Revisit",
  not_a_fit: "Not a fit",
};

type Totals = Pick<CampaignNumbers, "in_pipeline" | "contacted" | "stages" | "stages_contacted">;

/** Contacts per bucket. Every stage node counts both branches. */
export function pipelineCounts(t: Totals): Record<PipelineBucket, number> {
  const out = {
    all: t.in_pipeline,
    contacted: t.contacted,
    not_contacted: Math.max(0, t.in_pipeline - t.contacted),
  } as Record<PipelineBucket, number>;
  for (const s of PIPELINE_STAGES) out[s] = t.stages[s] ?? 0;
  return out;
}

export interface PipelineLink { from: PipelineBucket; to: PipelineBucket; value: number }

/** The ribbons, zero-width ones dropped: a branch nobody is on draws nothing. */
export function pipelineLinks(t: Totals): PipelineLink[] {
  const links: PipelineLink[] = [
    { from: "all", to: "contacted", value: t.contacted },
    { from: "all", to: "not_contacted", value: Math.max(0, t.in_pipeline - t.contacted) },
  ];
  for (const s of PIPELINE_STAGES) {
    const reached = t.stages_contacted[s] ?? 0;
    links.push({ from: "contacted", to: s, value: reached });
    links.push({ from: "not_contacted", to: s, value: Math.max(0, (t.stages[s] ?? 0) - reached) });
  }
  return links.filter((l) => l.value > 0);
}

/** Whether a pipeline contact belongs to a bucket. Mirrors pipelineCounts, so
 *  a label's number and the list it opens always match. */
export function inBucket(bucket: PipelineBucket, c: { stage: string | null; contacted: boolean }): boolean {
  switch (bucket) {
    case "all": return true;
    case "contacted": return c.contacted;
    case "not_contacted": return !c.contacted;
    case "revisit": return c.stage === "revisit" || c.stage === "on_hold";
    default: return c.stage === bucket;
  }
}
