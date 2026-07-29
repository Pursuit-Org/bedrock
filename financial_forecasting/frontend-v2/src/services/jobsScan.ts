import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

// Separate from services/jobs.ts on purpose: keeps the scan feature from
// colliding with in-flight work in that file.

export type TriageState = "new" | "approved" | "rejected" | "promoted" | "snoozed";

export interface ScanResult {
  id: string;
  account_key: string;
  company: string | null;
  platform: string;
  slug: string;
  external_job_id: string;
  title: string | null;
  location: string | null;
  is_remote: boolean | null;
  url: string | null;
  salary_min: number | null;
  salary_max: number | null;
  comp_source: string | null;
  score: number | null;
  classification: string | null;
  matched_family: string | null;
  reasoning: string | null;
  criteria_version: string | null;
  liveness: string;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  posted_at: string | null;
  triage_state: TriageState;
  triaged_by: string | null;
  triaged_at: string | null;
  promoted_posting_id: number | null;
  opportunity_id: string | null;
  relationship: string | null;
  tier: string | null;
  warm_contact_count: number;
  warm_contacts: string[];
}

export interface ScanFilters {
  state?: TriageState;
  account_key?: string;
  platform?: string;
  min_score?: number;
  has_warm_contact?: boolean;
  include_closed?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ScanSummary {
  by_state: Record<string, number>;
  boards: {
    total?: number;
    verified?: number;
    stale?: number;
    failing?: number;
    last_scan_at?: string | null;
  };
  new_this_week: number;
}

export interface WatchBoard {
  id: string;
  platform: string;
  slug: string;
  status: string;
  last_scan_at: string | null;
  last_scan_status: string | null;
  last_role_count: number | null;
  consecutive_empty_scans: number;
}

export interface WatchCompany {
  account_key: string;
  display_name: string;
  domain: string | null;
  tier: string;
  relationship: string;
  why_watched: string | null;
  source_tags: string[] | null;
  owner_email: string | null;
  criteria_profile: string;
  active: boolean;
  do_not_present: boolean;
  notes: string | null;
  boards: WatchBoard[];
  open_roles: number;
}

export interface WatchProposal {
  account_key: string;
  display_name: string;
  domain: string;
  contacts: number;
  tags: string[];
}

const SCAN_KEY = ["jobs", "scan"];

function invalidateScan(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["jobs", "scan"] });
}

export function useScanResults(filters: ScanFilters) {
  return useQuery<{ results: ScanResult[]; limit: number; offset: number }>({
    queryKey: [...SCAN_KEY, "results", filters],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await api.get<{ results: ScanResult[]; limit: number; offset: number }>(
        "/api/jobs/scan/results",
        { params: filters },
      );
      return data;
    },
  });
}

export function useScanSummary() {
  return useQuery<ScanSummary>({
    queryKey: [...SCAN_KEY, "summary"],
    queryFn: async () => {
      const { data } = await api.get<ScanSummary>("/api/jobs/scan/summary");
      return data;
    },
  });
}

export function useTriageResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; triage_state: TriageState; note?: string }) => {
      const { data } = await api.patch(`/api/jobs/scan/results/${vars.id}`, {
        triage_state: vars.triage_state,
        note: vars.note,
      });
      return data;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.triage_state === "rejected" ? "Dismissed" : "Marked approved");
      invalidateScan(qc);
    },
    onError: () => toast.error("Could not update this row"),
  });
}

/** Publish (or unpublish) a scanned role on the builder-facing Pathfinder board. */
export function usePromoteToPathfinder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; share?: boolean }) => {
      const { data } = await api.post<{ action: string; posting_id: number | null }>(
        `/api/jobs/scan/results/${vars.id}/promote`,
        { share: vars.share ?? true },
      );
      return data;
    },
    onSuccess: (data) => {
      const msg: Record<string, string> = {
        created: "Published to Pathfinder",
        updated: "Pathfinder posting updated",
        unpublished: "Removed from Pathfinder",
        noop: "Nothing to do",
      };
      toast.success(msg[data.action] ?? data.action);
      invalidateScan(qc);
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: { message?: string } } } })
        ?.response?.data?.detail;
      toast.error(detail?.message ?? "Could not publish this role");
    },
  });
}

/** Create a tracked opportunity + role, optionally publishing to Pathfinder too. */
export function useCreateOpportunityFromScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      owner_email?: string;
      deal_type?: string;
      pathfinder_visible?: boolean;
      notes?: string;
    }) => {
      const { id, ...body } = vars;
      const { data } = await api.post<{
        opportunity_id: string;
        role_id: string;
        opportunity_reused: boolean;
        posting_id: number | null;
      }>(`/api/jobs/scan/results/${id}/opportunity`, body);
      return data;
    },
    onSuccess: (data) => {
      toast.success(
        data.opportunity_reused
          ? "Role added to the existing opportunity"
          : "Opportunity created — now tracked in the pipeline",
      );
      invalidateScan(qc);
      // The opportunities pipeline now has a new row.
      qc.invalidateQueries({ queryKey: ["jobs", "opportunities"] });
      qc.invalidateQueries({ queryKey: ["jobs", "pipeline"] });
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: { message?: string } } } })
        ?.response?.data?.detail;
      toast.error(detail?.message ?? "Could not create the opportunity");
    },
  });
}

export function useWatchlist(activeOnly = true) {
  return useQuery<{ companies: WatchCompany[] }>({
    queryKey: [...SCAN_KEY, "watchlist", activeOnly],
    queryFn: async () => {
      const { data } = await api.get<{ companies: WatchCompany[] }>(
        "/api/jobs/scan/watchlist",
        { params: { active_only: activeOnly } },
      );
      return data;
    },
  });
}

export function useWatchlistProposals(enabled = false) {
  return useQuery<{ proposals: WatchProposal[] }>({
    queryKey: [...SCAN_KEY, "watchlist-proposals"],
    enabled,
    queryFn: async () => {
      const { data } = await api.get<{ proposals: WatchProposal[] }>(
        "/api/jobs/scan/watchlist/proposals",
      );
      return data;
    },
  });
}

export function useAddWatchCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      display_name: string;
      account_key?: string;
      domain?: string;
      tier?: string;
      relationship?: string;
      why_watched?: string;
      source_tags?: string[];
      boards?: { platform: string; slug: string }[];
    }) => {
      const { data } = await api.post("/api/jobs/scan/watchlist", body);
      return data;
    },
    onSuccess: () => {
      toast.success("Added to the watchlist");
      invalidateScan(qc);
    },
    onError: () => toast.error("Could not add that company"),
  });
}

export function usePatchWatchCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { account_key: string; [k: string]: unknown }) => {
      const { account_key, ...body } = vars;
      const { data } = await api.patch(`/api/jobs/scan/watchlist/${encodeURIComponent(account_key)}`, body);
      return data;
    },
    onSuccess: () => invalidateScan(qc),
    onError: () => toast.error("Could not update that company"),
  });
}

export function formatComp(min: number | null, max: number | null): string {
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  if (min && max) return min === max ? k(min) : `${k(min)} – ${k(max)}`;
  if (min) return `${k(min)}+`;
  if (max) return `Up to ${k(max)}`;
  return "—";
}
