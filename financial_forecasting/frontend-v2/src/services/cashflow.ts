import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface CashflowMonth {
  month: number; // 1–12
  actuals: number;
  scheduled: number;
  projected: number;
}

export type CashflowType = "actuals" | "scheduled" | "outstanding" | "projected";

/** Record-type buckets the cashflow page can filter to. Matches the
 *  backend `bucket` query param on /cashflow + /cashflow/detail. */
export type CashflowBucket =
  | "all"
  | "philanthropy" // Grant + Donation
  | "grant"
  | "donation"
  | "pbc"
  | "capital_grants"
  | "other";

export interface CashflowDetailRecord {
  payment_id: string | null;
  opp_id: string | null;
  amount: number;
  weighted_amount: number | null;
  probability: number | null;
  date: string | null;
  opp_name: string | null;
  account_name: string | null;
  stage: string | null;
}

export function useCashflowDetail(
  year: number,
  month: number | null,
  type: CashflowType | null,
  bucket: CashflowBucket = "all",
) {
  return useQuery({
    queryKey: ["cashflow-detail", year, month, type, bucket],
    queryFn: async () => {
      const { data } = await api.get<CashflowDetailRecord[]>(
        `/api/salesforce/cashflow/detail?year=${year}&month=${month}&type=${type}&bucket=${bucket}`,
      );
      return data;
    },
    enabled: month !== null && type !== null,
    staleTime: 5 * 60_000,
  });
}

export function useCashflow(year: number, bucket: CashflowBucket = "all") {
  return useQuery({
    queryKey: ["cashflow", year, bucket],
    queryFn: async () => {
      const { data } = await api.get<CashflowMonth[]>(
        `/api/salesforce/cashflow?year=${year}&bucket=${bucket}`,
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}
