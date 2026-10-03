import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** Settings > Targets > Jobs. Backed by /api/jobs/targets (routes/jobs_targets.py). */

export type OutreachMetric =
  | "accounts_activated" | "total_outreach_activity" | "total_calls"
  | "call_discovery" | "converted_opportunities";

export type TeamMode = "sum" | "set";

export interface JobsTargets {
  /** False until the 2026-09-29 migration runs: values shown are the
   *  hardcoded defaults and nothing can be saved. */
  available: boolean;
  team: string[];
  /** email → metric → weekly target. A missing metric = no target. */
  owners: Record<string, Partial<Record<OutreachMetric, number | null>>>;
  team_targets: Record<OutreachMetric, { mode: TeamMode | null; value: number | null; effective: number | null }>;
  pipeline: { period_start: string; value: number }[];
  metrics: { key: OutreachMetric; label: string }[];
}

interface Resp<T> { success: boolean; data: T }

const KEY = ["jobs", "targets"] as const;

export function useJobsTargets() {
  return useQuery<JobsTargets>({
    queryKey: KEY,
    queryFn: async () => (await api.get<Resp<JobsTargets>>("/api/jobs/targets")).data.data,
    staleTime: 30_000,
  });
}

/** Every Jobs view that shows a target or is scoped to the team. */
function useInvalidateJobs() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: KEY });
    // Team membership and targets feed the Outreach page, Owner cut, trends
    // and the projection chart; the whole ["jobs"] family is the honest scope.
    qc.invalidateQueries({ queryKey: ["jobs"] });
  };
}

export function useSaveJobsTeam() {
  const invalidate = useInvalidateJobs();
  return useMutation({
    mutationFn: async (members: string[]) =>
      (await api.put<Resp<JobsTargets>>("/api/jobs/targets/team", { members })).data.data,
    onSuccess: invalidate,
  });
}

export function useSaveOutreachTargets() {
  const invalidate = useInvalidateJobs();
  return useMutation({
    mutationFn: async (body: {
      owners: Record<string, Partial<Record<OutreachMetric, number | null>>>;
      team: Partial<Record<OutreachMetric, { mode: TeamMode; value?: number | null }>>;
    }) => (await api.put<Resp<JobsTargets>>("/api/jobs/targets/outreach", body)).data.data,
    onSuccess: invalidate,
  });
}

export function useSavePipelineTargets() {
  const invalidate = useInvalidateJobs();
  return useMutation({
    mutationFn: async (quarters: { period_start: string; value: number | null }[]) =>
      (await api.put<Resp<JobsTargets>>("/api/jobs/targets/pipeline", { quarters })).data.data,
    onSuccess: invalidate,
  });
}
