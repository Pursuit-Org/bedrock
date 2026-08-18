import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { SfAccount } from "@/types/salesforce";

export interface AccountEnrichment {
  sf_account_id: string;
  company_id: number;
  name: string | null;
  domain: string | null;
  logo_url: string | null;
  industry: string | null;
  size_bucket: string | null;
  enrichment_source: string | null;
  enriched_at: string | null;
  confidence: string | null;
  matched_by: string | null;
}

/** Single-account enrichment lookup. Returns null if no match yet. */
export function useAccountEnrichment(sfAccountId: string | null | undefined) {
  return useQuery({
    queryKey: ["account-enrichment", sfAccountId],
    queryFn: async (): Promise<AccountEnrichment | null> => {
      if (!sfAccountId) return null;
      const { data } = await api.get<AccountEnrichment | null>(
        `/api/accounts/${encodeURIComponent(sfAccountId)}/enrichment`,
      );
      return data;
    },
    enabled: !!sfAccountId,
    staleTime: 5 * 60_000,
  });
}

/** Batch enrichment lookup. Returns `{sf_account_id: enrichment | null}`
 *  for every requested id. Chunks into 200-id GETs (URL gets too long
 *  past ~400 ids; Pursuit has 20k+ SF Accounts) and merges. Stable
 *  cache key via sorted ids so two callers with the same set share. */
const ENRICH_CHUNK = 200;

export function useAccountsEnrichment(sfAccountIds: string[]) {
  // React Query compares queryKey deeply on every cache lookup. With
  // 20k+ account ids passed straight in, the compare was bogging down
  // every Accounts page render and freezing navigation. Collapse the
  // key into a short fingerprint (count + first/last id) — duplicates
  // share a cache entry because the upstream set is deterministic
  // (same accounts query → same ordering).
  const stableKey = useMemo(
    () => `${sfAccountIds.length}:${sfAccountIds[0] ?? ""}:${sfAccountIds[sfAccountIds.length - 1] ?? ""}`,
    [sfAccountIds],
  );
  // The actual id list used for fetching — we still need them, just
  // not as the queryKey. Sorted once for stable chunking.
  const sortedIds = useMemo(() => [...sfAccountIds].sort(), [sfAccountIds]);
  return useQuery({
    queryKey: ["accounts-enrichment", stableKey],
    queryFn: async (): Promise<Record<string, AccountEnrichment | null>> => {
      if (sortedIds.length === 0) return {};
      const chunks: string[][] = [];
      for (let i = 0; i < sortedIds.length; i += ENRICH_CHUNK) {
        chunks.push(sortedIds.slice(i, i + ENRICH_CHUNK));
      }
      const results = await Promise.all(
        chunks.map((c) =>
          api
            .get<Record<string, AccountEnrichment | null>>(
              `/api/accounts/enrichment?ids=${c.join(",")}`,
            )
            .then((r) => r.data),
        ),
      );
      return Object.assign({}, ...results);
    },
    enabled: sortedIds.length > 0,
    staleTime: 5 * 60_000,
  });
}

/**
 * Fetch all SF Accounts via the existing FastAPI endpoint.
 *
 * The backend (main.py:535) returns [] if the SF session isn't connected
 * — we treat that as a non-error empty list, same as the legacy frontend.
 */
async function fetchAccounts(activeOnly = false): Promise<SfAccount[]> {
  const qs = activeOnly ? "&active_only=true" : "";
  const { data } = await api.get<SfAccount[]>(`/api/salesforce/accounts?fields=light${qs}`);
  return data;
}

/**
 * Two-phase load. Pursuit has ~20k total accounts but only ~5k are
 * active. The cold full-set fetch takes ~6 s; the active-only subset
 * takes ~1.5 s. We kick off both — the active query resolves first
 * so the UI paints fast, then the full set lands and React Query
 * silently swaps the larger array in. Consumers get the bigger one
 * whenever it's available, otherwise the active set, otherwise empty.
 *
 * Both queries share independent cache entries so navigation between
 * pages never re-fetches — once they're warm they stay warm for 60 s
 * (staleTime). The full set gates on the active set succeeding to
 * keep failure modes contained: if SF is down, both fail together.
 */
export function useAccounts() {
  const activeQ = useQuery({
    queryKey: ["accounts", "active-only"],
    queryFn: () => fetchAccounts(true),
    staleTime: 60_000,
  });
  const fullQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => fetchAccounts(false),
    staleTime: 60_000,
    enabled: activeQ.isSuccess,
  });
  // Compose a single-query-like return shape so callers don't need to
  // know about the staged loading. Prefer the full set; fall back to
  // active while it's still in flight.
  return {
    data: (fullQ.data ?? activeQ.data) as SfAccount[] | undefined,
    isLoading: activeQ.isLoading && !activeQ.data,
    isFetching: activeQ.isFetching || fullQ.isFetching,
    isError: activeQ.isError && fullQ.isError,
    error: fullQ.error ?? activeQ.error,
    isStale: fullQ.isStale,
    /** True until the FULL set is loaded — useful for "results may be
     *  partial" UI hints. */
    isPartial: !fullQ.data && !!activeQ.data,
  };
}

export interface CreateAccountBody {
  Name: string;
  Type?: string;
  Industry?: string;
  Website?: string;
  BillingCity?: string;
  BillingState?: string;
  OwnerId?: string | null;
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateAccountBody) => {
      const { data } = await api.post<{ success: boolean; data: { id: string; message: string } }>(
        "/api/salesforce/accounts",
        body,
      );
      return data.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

/**
 * Patch a Salesforce Account. Backend: PUT /api/salesforce/accounts/{id}
 *
 * Optimistic update flow:
 * 1. `onMutate` cancels in-flight refetches and rewrites the cached
 *    accounts list in-place — so the UI shows the new value immediately
 *    AND it survives if anything else triggers a re-render.
 * 2. `onError` rolls back to the snapshot.
 * 3. `onSettled` waits 2s before invalidating, giving Salesforce time
 *    to propagate the write so the refetched list isn't stale.
 *
 * The `displayPatch` field on the input is merged into the cache as well
 * — used to update visible relationship fields (e.g. when changing
 * OwnerId, set `displayPatch: { Owner: { Name: 'Jane Doe' } }` so the
 * row's owner label updates immediately).
 */
/**
 * Delete a Salesforce Account. Backend cascade-invalidates contacts +
 * opps caches (they reference AccountId), so we only need to drop this
 * row from the accounts list optimistically and rollback on error.
 */
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/salesforce/accounts/${encodeURIComponent(id)}`);
      return id;
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["accounts"] });
      const prev = qc.getQueryData<SfAccount[]>(["accounts"]);
      qc.setQueryData<SfAccount[]>(["accounts"], (old) =>
        old ? old.filter((a) => a.Id !== id) : old,
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["accounts"], ctx.prev);
    },
    onSettled: () => {
      // Wait for SF propagation before refetch (mirrors useUpdateAccount).
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["accounts"] });
        void qc.invalidateQueries({ queryKey: ["contacts"] });
        void qc.invalidateQueries({ queryKey: ["opportunities"] });
      }, 1500);
    },
  });
}

export function useUpdateAccount() {
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
      const { data } = await api.put<SfAccount>(
        `/api/salesforce/accounts/${encodeURIComponent(id)}`,
        { updates: patch, reason: "Updated via Bedrock" },
      );
      return data;
    },
    onSuccess: (_data, { id, patch, displayPatch }) => {
      const merged = { ...patch, ...(displayPatch ?? {}) };
      const patchCache = (old: SfAccount[] | undefined) => {
        if (!old) return old;
        return old.map((a) => (a.Id === id ? ({ ...a, ...merged } as SfAccount) : a));
      };
      qc.setQueryData<SfAccount[]>(["accounts"], patchCache);
      qc.setQueryData<SfAccount[]>(["accounts", "active-only"], patchCache);
    },
    onSettled: () => {
      setTimeout(
        () => qc.invalidateQueries({ queryKey: ["accounts"] }),
        2000,
      );
    },
  });
}
