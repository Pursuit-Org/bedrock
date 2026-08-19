import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type CommitmentType = "quantitative" | "qualitative";
export type TrackingTier = "tracked" | "reference";
export type CommitmentStatus = "on-track" | "ahead" | "under" | "complete";
export type QualitativeStatus =
  | "not-started"
  | "in-progress"
  | "met"
  | "not-met"
  | "pending-verification";

export interface Commitment {
  id: string;
  award_id: string;
  commitment_type: CommitmentType;
  title: string;
  contract_language: string;
  delivery_plan: string;
  tracking_tier: TrackingTier;
  target_value: number | null;
  target_unit: string | null;
  start_date: string;
  deadline: string;
  owner: string;
  owner_ids: string[];
  notes: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;

  // Server-computed — never sent by the client, never storable.
  status: CommitmentStatus;

  // Latest entry from the progress log (LATERAL-joined at read time).
  latest_value: number | null;
  latest_qualitative_status: QualitativeStatus | null;
  last_update_at: string | null;
  last_update_by: string | null;
  update_count: number;

  // Only present on GET /api/commitments/{id} (SF-enriched).
  opportunity_id?: string;
  opportunity_name?: string | null;
  account_name?: string | null;
}

export interface CommitmentProgressLogEntry {
  id: string;
  commitment_id: string;
  recorded_value: number | null;
  recorded_status: QualitativeStatus | null;
  note: string;
  recorded_by_email: string;
  recorded_at: string;
  created_at: string;
}

// ── Commitments ───────────────────────────────────────────────────────────

export function useCommitments(tier: TrackingTier | "all" = "tracked") {
  return useQuery({
    queryKey: ["commitments", tier],
    queryFn: async () => {
      const { data } = await api.get<Commitment[]>(
        `/api/commitments?tracking_tier=${encodeURIComponent(tier)}`,
      );
      return data;
    },
    staleTime: 30_000,
  });
}

export function useCommitmentsByAward(awardId: string | null | undefined) {
  return useQuery({
    queryKey: ["commitments-by-award", awardId],
    queryFn: async () => {
      const { data } = await api.get<Commitment[]>(`/api/commitments/by-award/${awardId}`);
      return data;
    },
    enabled: !!awardId,
    staleTime: 30_000,
  });
}

export function useCommitment(commitmentId: string | null | undefined) {
  return useQuery({
    queryKey: ["commitment", commitmentId],
    queryFn: async () => {
      const { data } = await api.get<Commitment>(`/api/commitments/${commitmentId}`);
      return data;
    },
    enabled: !!commitmentId,
    staleTime: 15_000,
  });
}

export interface CommitmentCreateBody {
  award_id: string;
  commitment_type: CommitmentType;
  title: string;
  contract_language?: string;
  delivery_plan?: string;
  tracking_tier?: TrackingTier;
  target_value?: number | null;
  target_unit?: string | null;
  start_date: string;
  deadline: string;
  owner?: string;
  owner_ids?: string[];
  notes?: string;
}

function invalidateCommitmentLists(qc: ReturnType<typeof useQueryClient>, awardId?: string) {
  qc.invalidateQueries({ queryKey: ["commitments"] });
  if (awardId) qc.invalidateQueries({ queryKey: ["commitments-by-award", awardId] });
}

export function useCreateCommitment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CommitmentCreateBody) => {
      const { data } = await api.post<Commitment>("/api/commitments", body);
      return data;
    },
    onSuccess: (data) => invalidateCommitmentLists(qc, data.award_id),
  });
}

export interface CommitmentPatch {
  title?: string;
  contract_language?: string;
  delivery_plan?: string;
  tracking_tier?: TrackingTier;
  target_value?: number | null;
  target_unit?: string | null;
  start_date?: string;
  deadline?: string;
  owner?: string;
  owner_ids?: string[];
  notes?: string;
  sort_order?: number;
}

export function useUpdateCommitment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: CommitmentPatch }) => {
      const { data } = await api.patch<Commitment>(`/api/commitments/${id}`, patch);
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["commitment", data.id] });
      invalidateCommitmentLists(qc, data.award_id);
    },
  });
}

export function useDeleteCommitment(awardId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/commitments/${id}`);
    },
    onSuccess: () => invalidateCommitmentLists(qc, awardId),
  });
}

// ── Progress log ─────────────────────────────────────────────────────────

export function useCommitmentLog(commitmentId: string | null | undefined) {
  return useQuery({
    queryKey: ["commitment-log", commitmentId],
    queryFn: async () => {
      const { data } = await api.get<CommitmentProgressLogEntry[]>(
        `/api/commitments/${commitmentId}/log`,
      );
      return data;
    },
    enabled: !!commitmentId,
    staleTime: 15_000,
  });
}

export interface ProgressLogCreateBody {
  recorded_value?: number | null;
  recorded_status?: QualitativeStatus | null;
  note?: string;
  recorded_at?: string;
}

export function useCreateProgressLog(commitmentId: string, awardId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProgressLogCreateBody) => {
      const { data } = await api.post<CommitmentProgressLogEntry>(
        `/api/commitments/${commitmentId}/log`,
        body,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitment-log", commitmentId] });
      qc.invalidateQueries({ queryKey: ["commitment", commitmentId] });
      invalidateCommitmentLists(qc, awardId);
    },
  });
}

export function useDeleteProgressLog(commitmentId: string, awardId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (logId: string) => {
      await api.delete(`/api/commitments/log/${logId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitment-log", commitmentId] });
      qc.invalidateQueries({ queryKey: ["commitment", commitmentId] });
      invalidateCommitmentLists(qc, awardId);
    },
  });
}
