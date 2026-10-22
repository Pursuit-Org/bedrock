/**
 * Custom hook that encapsulates all Opportunities data fetching,
 * mutations, and derived state (maps, metrics, filtered lists).
 */
import { useState, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import { apiService } from '../../services/api';
import {
  OPEN_STAGES,
  COLLECTING_STAGES,
  CLOSED_STAGES,
} from '../../types/salesforce';
import type { Opportunity } from './helpers';

export type ViewMode = 'open' | 'collecting' | 'closed';

/**
 * Canonical query key for the opportunities cache. Exported so both the hook
 * and any external optimistic-update callsite read/write the *same* cache
 * entry. The key does NOT include `viewMode` — stage filtering happens
 * client-side on the shared dataset (see `opportunities` memo below).
 */
export const oppQueryKey = (philanthropyOnly: boolean) =>
  philanthropyOnly
    ? ['opportunities', { philanthropyOnly }]
    : 'opportunities';

export function useOpportunityData(
  viewMode: ViewMode,
  philanthropyOnly: boolean,
) {
  const queryClient = useQueryClient();

  // Track recently-changed rows so they stay visible briefly after stage change
  const [recentlyChangedIds, setRecentlyChangedIds] = useState<Record<string, boolean>>({});
  const recentlyChangedRef = useRef<Set<string>>(new Set());

  // ---------- Queries ----------

  const stagesForView = viewMode === 'open' ? OPEN_STAGES
    : viewMode === 'collecting' ? COLLECTING_STAGES : CLOSED_STAGES;

  // Always fetch unfiltered by stage so tab counts reflect the full dataset.
  // Stage-filtering for the visible grid happens client-side below.
  // Share cache with Priorities/Dashboard/etc. when no philanthropy filter.
  const useFilteredFetch = philanthropyOnly;
  const queryKey = oppQueryKey(philanthropyOnly);

  const { data: opportunitiesData, isLoading, error } = useQuery(
    queryKey,
    async () => {
      const params: any = {};
      if (philanthropyOnly) {
        // SF renamed Philanthropy → Grant on 2026-10-22 (Donation split out).
        params.record_type = 'Grant';
        params.active_only = true;
      }
      const response = await apiService.getOpportunities(
        useFilteredFetch ? params : undefined,
      );
      return response.data;
    },
  );

  const rawOpportunities = useMemo(() => {
    if (Array.isArray(opportunitiesData)) return opportunitiesData;
    return (opportunitiesData as any)?.opportunities
      ?? (opportunitiesData as any)?.data
      ?? [];
  }, [opportunitiesData]);

  // Visible grid = stage-filtered subset of the full cache for the current tab.
  const opportunities: Opportunity[] = useMemo(
    () => rawOpportunities.filter((opp: Opportunity) =>
      (stagesForView as readonly string[]).includes(opp.StageName),
    ),
    [rawOpportunities, stagesForView],
  );

  const { data: usersData } = useQuery(
    'users',
    async () => {
      const response = await apiService.getUsers({ limit: 1000 });
      return response.data;
    },
    { staleTime: 300000 },
  );

  const { data: accountsData } = useQuery(
    'accounts',
    async () => {
      const response = await apiService.getAccounts();
      return response.data;
    },
    { staleTime: 300000 },
  );

  // ---------- Derived lookups ----------

  const users = useMemo(
    () => (Array.isArray(usersData) ? usersData : (usersData as any)?.users ?? []),
    [usersData],
  );

  const accounts = useMemo(
    () => (Array.isArray(accountsData) ? accountsData : (accountsData as any)?.accounts ?? []),
    [accountsData],
  );

  const accountMap = useMemo(() => {
    const map = new Map<string, any>();
    accounts.forEach((a: any) => map.set(a.Id, a));
    return map;
  }, [accounts]);

  const userMap = useMemo(() => {
    const map = new Map<string, any>();
    users.forEach((u: any) => map.set(u.Id, u));
    return map;
  }, [users]);

  // ---------- Tab counts ----------
  // Counts are derived from `rawOpportunities` (the full cache), not the
  // stage-filtered `opportunities`, so every tab chip shows the correct total
  // regardless of which tab is currently active.

  const openCount = useMemo(
    () => rawOpportunities.filter((opp: Opportunity) =>
      (OPEN_STAGES as readonly string[]).includes(opp.StageName),
    ).length,
    [rawOpportunities],
  );

  const collectingCount = useMemo(
    () => rawOpportunities.filter((opp: Opportunity) =>
      (COLLECTING_STAGES as readonly string[]).includes(opp.StageName),
    ).length,
    [rawOpportunities],
  );

  const closedCount = useMemo(
    () => rawOpportunities.filter((opp: Opportunity) =>
      (CLOSED_STAGES as readonly string[]).includes(opp.StageName),
    ).length,
    [rawOpportunities],
  );

  // ---------- Mutations ----------

  const updateMutation = useMutation(
    async ({ oppId, updates }: { oppId: string; updates: any }) => {
      return await apiService.updateOpportunity(oppId, updates);
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries('opportunities');
        toast.success('Opportunity updated successfully!');
      },
      onError: (error: any) => {
        toast.error(`Failed to update: ${error.message}`);
      },
    },
  );

  const bulkUpdateMutation = useMutation(
    async ({ oppIds, updates }: { oppIds: string[]; updates: any }) => {
      const response = await apiService.bulkUpdateOpportunities(oppIds, updates);
      return response.data;
    },
    {
      onSuccess: (data) => {
        queryClient.invalidateQueries('opportunities');
        if (data.failed_count > 0) {
          toast(`Updated ${data.success_count} of ${data.total} opportunities. ${data.failed_count} failed.`, {
            icon: '\u26A0\uFE0F',
            duration: 5000,
          });
        } else {
          toast.success(`Successfully updated ${data.success_count} opportunities!`);
        }
      },
      onError: (error: any) => {
        toast.error(`Failed to update: ${error.message}`);
      },
    },
  );

  // ---------- Recently-changed helpers ----------

  const markRecentlyChanged = (id: string) => {
    recentlyChangedRef.current.add(id);
    setRecentlyChangedIds((prev) => ({ ...prev, [id]: true }));

    setTimeout(() => {
      recentlyChangedRef.current.delete(id);
      setRecentlyChangedIds((prev) => {
        const { [id]: _, ...rest } = prev;
        return rest;
      });
    }, 5000);
  };

  const clearRecentlyChanged = (id: string) => {
    setRecentlyChangedIds((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  };

  // ---------- Opportunity Locks ----------

  const { data: locksData } = useQuery('opportunity-locks', async () => {
    const res = await apiService.getOpportunityLocks();
    return res.data?.data || [];
  }, { staleTime: 30_000 });

  const lockMap = useMemo(() => {
    const map = new Map<string, { locked_by: string; locked_at: string }>();
    for (const lock of (locksData || [])) {
      map.set(lock.sf_opportunity_id, { locked_by: lock.locked_by, locked_at: lock.locked_at });
    }
    return map;
  }, [locksData]);

  const lockMutation = useMutation(
    async ({ oppId, ownerId }: { oppId: string; ownerId: string }) => apiService.lockOpportunity(oppId, ownerId),
    {
      onSuccess: () => { queryClient.invalidateQueries('opportunity-locks'); toast.success('Opportunity locked'); },
      onError: (err: any) => { toast.error(err.response?.data?.detail || 'Failed to lock'); },
    }
  );

  const unlockMutation = useMutation(
    async (oppId: string) => apiService.unlockOpportunity(oppId),
    {
      onSuccess: () => { queryClient.invalidateQueries('opportunity-locks'); toast.success('Opportunity unlocked'); },
      onError: (err: any) => { toast.error(err.response?.data?.detail || 'Failed to unlock'); },
    }
  );

  return {
    // raw
    opportunities,
    rawOpportunities,
    users,
    accounts,
    accountMap,
    userMap,
    openCount,
    collectingCount,
    closedCount,
    isLoading,
    error,
    // mutations
    updateMutation,
    bulkUpdateMutation,
    queryClient,
    // recently-changed tracking
    recentlyChangedIds,
    recentlyChangedRef,
    markRecentlyChanged,
    clearRecentlyChanged,
    // locks
    lockMap,
    lockMutation,
    unlockMutation,
  };
}
