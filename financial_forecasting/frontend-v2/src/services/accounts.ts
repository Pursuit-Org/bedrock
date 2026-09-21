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

// Patches sent to SF that the read-back hasn't confirmed yet. Module-level so
// the re-apply works regardless of which component fired the mutation.
//
// Keyed per account, but tracked PER FIELD: two edits to the same account
// inside the 2s window used to overwrite each other's map entry, so the first
// one reverted on refetch — which is the exact bug this mechanism exists to
// prevent.
type PendingAccountPatch = {
  /** Raw SF fields still awaiting confirmation, merged across edits. */
  fields: Record<string, unknown>;
  /** Display-only fields (e.g. account_status) — applied, never confirmed. */
  display: Record<string, unknown>;
  /** Wall clock of the most recent edit, for expiry. */
  since: number;
};
const pendingAccountPatches = new Map<string, PendingAccountPatch>();

/** Stop re-applying after this long.
 *
 *  Entries used to be evicted only on exact equality, so anything Salesforce
 *  normalizes — a trailing space trimmed, an empty string stored as null —
 *  never matched and the patch was force-written over every later refetch for
 *  the rest of the session. A ceiling means the worst case is a stale value
 *  for 30s, not forever. */
const PENDING_TTL_MS = 30_000;

/** Did SF confirm this value?
 *
 *  Deliberately lenient: SF trims trailing whitespace and stores empty text as
 *  null, so a strict === comparison reports "unconfirmed" for writes that in
 *  fact landed exactly as intended. */
function sfConfirms(actual: unknown, sent: unknown): boolean {
  if (actual === sent) return true;
  const norm = (v: unknown) =>
    v == null ? "" : typeof v === "string" ? v.trim() : String(v);
  return norm(actual) === norm(sent);
}

/** Drop expired entries. Returns true if anything is still pending. */
function prunePending(now: number): boolean {
  for (const [id, p] of pendingAccountPatches) {
    if (now - p.since > PENDING_TTL_MS) pendingAccountPatches.delete(id);
  }
  return pendingAccountPatches.size > 0;
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
      await api.put(
        `/api/salesforce/accounts/${encodeURIComponent(id)}`,
        { updates: patch, reason: "Updated via Bedrock" },
      );
    },
    onSuccess: (_data, { id, patch, displayPatch }) => {
      const merged = { ...patch, ...(displayPatch ?? {}) };
      // Merge per field rather than replacing the entry, so a second edit to
      // the same account doesn't discard the first one's pending fields.
      const prev = pendingAccountPatches.get(id);
      pendingAccountPatches.set(id, {
        fields: { ...(prev?.fields ?? {}), ...patch },
        display: { ...(prev?.display ?? {}), ...(displayPatch ?? {}) },
        since: Date.now(),
      });
      const patchCache = (old: SfAccount[] | undefined) => {
        if (!old) return old;
        return old.map((a) => (a.Id === id ? ({ ...a, ...merged } as SfAccount) : a));
      };
      qc.setQueryData<SfAccount[]>(["accounts"], patchCache);
      qc.setQueryData<SfAccount[]>(["accounts", "active-only"], patchCache);
      // The jobs pages render from the ["jobs","accounts",...] caches, whose
      // rows carry `sf_active` (not Active__c). Patch every variant so the
      // Deprioritize toggle is visible immediately on the jobs side too.
      if ("Active__c" in patch) {
        qc.setQueriesData<Array<{ sf_account_id?: string | null; sf_active?: boolean | null }>>(
          { queryKey: ["jobs", "accounts"] },
          (old) =>
            old?.map((a) =>
              a.sf_account_id === id ? { ...a, sf_active: patch.Active__c as boolean } : a,
            ),
        );
      }
    },
    onSettled: (_data, error) => {
      if (error) return;
      // Delayed refetch: give Salesforce a moment to propagate. After the
      // refetch lands, re-apply any patches SF hasn't confirmed yet so the UI
      // doesn't silently revert while SF is still catching up.
      setTimeout(() => {
        // Wrapped: an async setTimeout callback returns a floating promise, so
        // anything throwing in here surfaces as an unhandled rejection rather
        // than a failed refresh. Pending state is cleared on the way out so a
        // throw can't strand entries that would then be force-written.
        void (async () => {
          try {
            await qc.refetchQueries({ queryKey: ["accounts"] });
            void qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
            reapplyPending(qc);
          } catch (err) {
            console.error("account read-back re-apply failed", err);
            pendingAccountPatches.clear();
          }
        })();
      }, 2000);
    },
  });
}

/** Re-apply any field Salesforce hasn't confirmed yet. */
function reapplyPending(qc: ReturnType<typeof useQueryClient>) {
  {
        if (!prunePending(Date.now())) return;

        // Drop fields SF has now confirmed, judged against the canonical list.
        const canonical = qc.getQueryData<SfAccount[]>(["accounts"]);
        if (canonical) {
          const byId = new Map(canonical.map((a) => [a.Id, a]));
          for (const [id, pending] of pendingAccountPatches) {
            const row = byId.get(id) as unknown as Record<string, unknown> | undefined;
            if (!row) continue;
            for (const key of Object.keys(pending.fields)) {
              if (sfConfirms(row[key], pending.fields[key])) delete pending.fields[key];
            }
            if (Object.keys(pending.fields).length === 0) pendingAccountPatches.delete(id);
          }
        }
        if (pendingAccountPatches.size === 0) return;

        // Re-apply what's left, mapping each cached query over ITS OWN rows.
        //
        // The previous version built one array from the full ["accounts"] cache
        // and wrote a filtered projection of it into every ["accounts"*] query.
        // That made the active-only cache inherit the full list's rows and
        // ordering, silently dropped any row present in active-only but absent
        // from the full list, and cost a linear scan per element — O(n·m) over
        // caches holding thousands of accounts, run synchronously on the main
        // thread after every edit.
        qc.setQueriesData<SfAccount[]>({ queryKey: ["accounts"] }, (old) => {
          if (!old) return old;
          let changed = false;
          const next = old.map((a) => {
            const pending = pendingAccountPatches.get(a.Id);
            if (!pending) return a;
            changed = true;
            return { ...a, ...pending.fields, ...pending.display } as SfAccount;
          });
          return changed ? next : old;
        });
  }
}
