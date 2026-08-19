import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { SfDeliverable, SfDeliverableWithOppName } from "@/types/salesforce";

export interface DeliverablePatch {
  name?: string;
  type?: string | null;
  due_date?: string | null;
  requirements?: string | null;
  close_date?: string | null;
}

export function useDeliverables(opportunityId: string | null) {
  return useQuery({
    queryKey: ["deliverables", opportunityId],
    queryFn: async () => {
      const { data } = await api.get<SfDeliverable[]>(
        `/api/opportunities/${opportunityId}/deliverables`,
      );
      return data;
    },
    enabled: !!opportunityId,
    staleTime: 30_000,
  });
}

export function useCreateDeliverable(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; type?: string; due_date?: string }) => {
      const { data } = await api.post<SfDeliverable>(
        `/api/opportunities/${opportunityId}/deliverables`,
        body,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deliverables", opportunityId] });
    },
  });
}

export function useUpdateDeliverable(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: DeliverablePatch }) => {
      const { data } = await api.patch<SfDeliverable>(`/api/deliverables/${id}`, patch);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deliverables", opportunityId] });
    },
  });
}

export function useDeleteDeliverable(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/deliverables/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deliverables", opportunityId] });
    },
  });
}

export function useAccountUpcomingDeliverables(accountId: string | null) {
  return useQuery({
    queryKey: ["deliverables", "upcoming", "account", accountId],
    queryFn: async () => {
      const { data } = await api.get<SfDeliverableWithOppName[]>(
        `/api/accounts/${accountId}/deliverables/upcoming`,
      );
      return data;
    },
    enabled: !!accountId,
    staleTime: 60_000,
  });
}

export function usePortfolioUpcomingDeliverables(sfUserId: string | null) {
  return useQuery({
    queryKey: ["deliverables", "upcoming", "portfolio", sfUserId],
    queryFn: async () => {
      const { data } = await api.get<SfDeliverableWithOppName[]>(
        `/api/portfolio/deliverables/upcoming`,
        { params: { sf_user_id: sfUserId } },
      );
      return data;
    },
    enabled: !!sfUserId,
    staleTime: 60_000,
  });
}
