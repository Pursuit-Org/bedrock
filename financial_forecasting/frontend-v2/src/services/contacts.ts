import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { SfContact } from "@/types/salesforce";

export interface CreateContactBody {
  AccountId: string;
  FirstName?: string;
  LastName: string;
  Email?: string;
  Phone?: string;
  Title?: string;
  // Optional — set the new contact as the account's philanthropic
  // primary in the same round-trip.
  Philanthropic_Contact__c?: boolean;
}

async function fetchContacts(opts: { accountId?: string; activeOnly?: boolean } = {}): Promise<SfContact[]> {
  // ?fields=light cuts SOQL payload by ~70% — the list view, Cleanup
  // tab, and Contact-detail header only need the ~12 light fields.
  // Per-account drilldowns get the full set for the detail page that
  // exposes things like NPSP Primary Affiliation, deceased flag, etc.
  const params = new URLSearchParams();
  if (opts.accountId) params.set("account_id", opts.accountId);
  else params.set("fields", "light");
  if (opts.activeOnly) params.set("active_only", "true");
  const path = `/api/salesforce/contacts?${params.toString()}`;
  const { data } = await api.get<SfContact[]>(path);
  return data;
}

/**
 * Two-phase load (same pattern as useAccounts). Pursuit has ~15k
 * contacts total but only ~310 have been touched in the last 6
 * months. We fire both queries — the active subset resolves in
 * ~100 ms vs ~1.5 s for the full set, so any contacts surface paints
 * fast on cold cache and the full list lands silently behind it.
 *
 * Account-scoped queries (`useContacts(accountId)`) bypass this —
 * the contact-detail / account-detail use case wants every contact
 * for that account, no partial states.
 */
export function useContacts(accountId?: string) {
  // Account-scoped: single query, no progressive loading.
  const scopedQ = useQuery({
    queryKey: ["contacts", accountId ?? "all"],
    queryFn: () => fetchContacts({ accountId }),
    staleTime: 60_000,
    enabled: !!accountId,
  });
  // Cross-account: progressive 2-phase load.
  const activeQ = useQuery({
    queryKey: ["contacts", "active-only"],
    queryFn: () => fetchContacts({ activeOnly: true }),
    staleTime: 60_000,
    enabled: !accountId,
  });
  const fullQ = useQuery({
    queryKey: ["contacts", "all"],
    queryFn: () => fetchContacts({}),
    staleTime: 60_000,
    enabled: !accountId && activeQ.isSuccess,
  });

  if (accountId) {
    return {
      data: scopedQ.data,
      isLoading: scopedQ.isLoading,
      isFetching: scopedQ.isFetching,
      isError: scopedQ.isError,
      error: scopedQ.error,
      isStale: scopedQ.isStale,
      isPartial: false,
    };
  }
  return {
    data: (fullQ.data ?? activeQ.data) as SfContact[] | undefined,
    isLoading: activeQ.isLoading && !activeQ.data,
    isFetching: activeQ.isFetching || fullQ.isFetching,
    isError: activeQ.isError && fullQ.isError,
    error: fullQ.error ?? activeQ.error,
    isStale: fullQ.isStale,
    isPartial: !fullQ.data && !!activeQ.data,
  };
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateContactBody) => {
      const { data } = await api.post<{ success: boolean; data: { id: string; message: string } }>(
        "/api/salesforce/contacts",
        body,
      );
      return data.data;
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["contacts", vars.AccountId] });
      void qc.invalidateQueries({ queryKey: ["contacts", "all"] });
    },
  });
}

/**
 * Delete a Salesforce Contact. Backend invalidates contact + task caches
 * (Who.Name joins). We optimistically drop the row from every cached
 * contacts list (global + per-account) and rollback on error.
 */
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/salesforce/contacts/${encodeURIComponent(id)}`);
      return id;
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["contacts"] });
      const snapshots = qc
        .getQueriesData<SfContact[]>({ queryKey: ["contacts"] })
        .map(([key, data]) => ({ key, data }));
      qc.setQueriesData<SfContact[]>({ queryKey: ["contacts"] }, (old) =>
        old ? old.filter((c) => c.Id !== id) : old,
      );
      return { snapshots };
    },
    onError: (_err, _id, ctx) => {
      ctx?.snapshots?.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ["contacts"] }), 2000);
    },
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Record<string, unknown>;
      displayPatch?: Record<string, unknown>;
    }) => {
      const { data } = await api.put<SfContact>(
        `/api/salesforce/contacts/${encodeURIComponent(id)}`,
        { updates: patch, reason: "Updated via Bedrock" },
      );
      return data;
    },
    onMutate: async ({ id, patch, displayPatch }) => {
      // Apply optimistic update across all contacts query keys
      // (the global ["contacts"] list and per-account scoped lists).
      await qc.cancelQueries({ queryKey: ["contacts"] });
      const snapshots = qc
        .getQueriesData<SfContact[]>({ queryKey: ["contacts"] })
        .map(([key, data]) => ({ key, data }));
      const merged = { ...patch, ...(displayPatch ?? {}) };
      qc.setQueriesData<SfContact[]>({ queryKey: ["contacts"] }, (old) =>
        old?.map((c) => (c.Id === id ? ({ ...c, ...merged } as SfContact) : c)),
      );
      return { snapshots };
    },
    onSuccess: (_data, { id, patch, displayPatch }) => {
      // Re-apply the saved values after the API confirms success. The
      // onMutate optimistic patch may have been overwritten by a background
      // refetch racing the mutation, so this ensures the cache reflects what
      // actually persisted.
      const merged = { ...patch, ...(displayPatch ?? {}) };
      qc.setQueriesData<SfContact[]>({ queryKey: ["contacts"] }, (old) =>
        old?.map((c) => (c.Id === id ? ({ ...c, ...merged } as SfContact) : c)),
      );
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots?.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      // 3.5 s gives Salesforce time to propagate the write before the
      // refetch — a 2 s window was too tight and caused values to revert.
      setTimeout(() => qc.invalidateQueries({ queryKey: ["contacts"] }), 3500);
    },
  });
}
