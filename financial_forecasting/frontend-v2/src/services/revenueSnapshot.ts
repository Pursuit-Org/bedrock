import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CashflowBucket } from "@/services/cashflow";

export type SourceCategory = "Foundation" | "Corporate" | "Individual" | "Government" | "Other";

export interface SourceBreakdown {
  Foundation: number;
  Corporate: number;
  Individual: number;
  Government: number;
  Other: number;
}

export interface RevenueSnapshotBucket {
  total: number;
  by_source: SourceBreakdown;
}

export interface ProjectedBucket {
  total: number;
  secured: number;
  pipeline_weighted: number;
  by_source: SourceBreakdown;
}

export interface RevenueSnapshot {
  year: number;
  as_of: string;
  annual_target: number;
  revenue_closed: RevenueSnapshotBucket;
  cash_secured: RevenueSnapshotBucket;
  projected_total: ProjectedBucket;
  future_years: Record<string, RevenueSnapshotBucket>;
}

export type BucketKey = "revenue_closed" | "cash_secured" | "projected_total";

export interface DetailRecord {
  id: string;
  opp_id: string | null;  // Opportunity Id — use for SF links
  name: string | null;
  account: string | null;
  amount: number;
  close_date?: string;
  scheduled_date?: string;
  // projected_total only
  weighted_amount?: number;
  probability?: number;
  kind?: "secured" | "pipeline";
}

export interface RevenueSnapshotDetail {
  bucket: BucketKey;
  bucket_label: string;
  source: string;
  year: number;
  records: DetailRecord[];
  total: number;
  sf_instance_url: string | null;
}

export function useRevenueSnapshot(year: number, recordBucket: CashflowBucket) {
  return useQuery({
    queryKey: ["revenue-snapshot", year, recordBucket],
    queryFn: async () => {
      const { data } = await api.get<RevenueSnapshot>(
        `/api/salesforce/revenue-snapshot?year=${year}&record_bucket=${recordBucket}`,
      );
      return data;
    },
    staleTime: 10 * 60_000,
  });
}

export function useRevenueSnapshotDetail(
  year: number,
  bucket: BucketKey | null,
  source: string | null,
  recordBucket: CashflowBucket,
) {
  return useQuery({
    queryKey: ["revenue-snapshot-detail", year, bucket, source, recordBucket],
    queryFn: async () => {
      const { data } = await api.get<RevenueSnapshotDetail>(
        `/api/salesforce/revenue-snapshot/detail?year=${year}&bucket=${bucket}&source=${source}&record_bucket=${recordBucket}`,
      );
      return data;
    },
    enabled: !!bucket && !!source,
    staleTime: 10 * 60_000,
  });
}
