import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface SfPayment {
  Id: string;
  Name?: string | null;
  npe01__Opportunity__c?: string | null;
  npe01__Payment_Amount__c: number | null;
  npe01__Scheduled_Date__c: string | null;
  npe01__Payment_Date__c: string | null;
  npe01__Paid__c: boolean;
  npe01__Written_Off__c?: boolean;
  npe01__Payment_Method__c?: string | null;
  npe01__Check_Reference_Number__c?: string | null;
  Write_off_reason__c?: string | null;
  Amount_Received__c?: number | null;
  Amount_Minus_Received__c?: number | null;
  Amount_Formula__c?: number | null;
  Payment_Status__c?: string | null;
  Paid_Status__c?: string | null;
  Delinquent__c?: boolean | null;
  Department__c?: string | null;
  GL_Account__c?: string | null;
  GL_Payment_Received__c?: string | null;
  Reconciled_with_Finance__c?: boolean | null;
  Batch_Name__c?: string | null;
  Payment_Estimate__c?: boolean | null;
  Affiliation__c?: string | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;
  npe01__Opportunity__r?: {
    Name?: string;
    AccountId?: string | null;
    Account?: { Name?: string };
    OwnerId?: string | null;
    Owner?: { Name?: string };
    StageName?: string | null;
    Amount?: number | null;
    Probability?: number | null;
    Manager_Probability_Override__c?: number | null;
    CloseDate?: string | null;
    RecordType?: { Name?: string };
    Active_Opportunity__c?: boolean | null;
    Philanthropy_Type__c?: string | null;
  };
}

async function fetchPayments(): Promise<SfPayment[]> {
  // `include_open_opps` guarantees every payment on a still-open opportunity is
  // present, on top of the recency window. Without it the page silently misses
  // most of what needs reviewing: the hygiene flags are about OVERDUE payments,
  // which have old scheduled dates and so sort out of a `scheduled DESC` window.
  // Measured 2026-08-12: only 36 of 103 flagged payments were inside the 2,000.
  const { data } = await api.get<SfPayment[]>(
    "/api/salesforce/payments?limit=2000&include_open_opps=true",
  );
  return data;
}

export function usePayments() {
  return useQuery({
    queryKey: ["payments"],
    queryFn: fetchPayments,
    staleTime: 60_000,
  });
}

export function useOpportunityPayments(opportunityId: string | null) {
  return useQuery({
    queryKey: ["opp-payments", opportunityId],
    queryFn: async () => {
      const { data } = await api.get<SfPayment[]>(
        `/api/salesforce/opportunities/${opportunityId}/payments`,
      );
      return data;
    },
    enabled: !!opportunityId,
    staleTime: 60_000,
  });
}

export interface PaymentPatch {
  npe01__Payment_Amount__c?: number;
  npe01__Scheduled_Date__c?: string | null;
  npe01__Payment_Date__c?: string | null;
  npe01__Paid__c?: boolean;
  npe01__Payment_Method__c?: string | null;
  npe01__Written_Off__c?: boolean;
  npe01__Check_Reference_Number__c?: string | null;
  Write_off_reason__c?: string | null;
  Department__c?: string | null;
  GL_Account__c?: string | null;
  GL_Payment_Received__c?: string | null;
  Reconciled_with_Finance__c?: boolean;
  Batch_Name__c?: string | null;
  Payment_Estimate__c?: boolean;
}

export function useUpdatePayment(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: PaymentPatch }) => {
      const { data } = await api.put(`/api/salesforce/payments/${id}`, { updates: patch });
      return data;
    },
    onMutate: async ({ id, patch }) => {
      const keys = [
        ["opp-payments", opportunityId],
        ["opportunity-payments", opportunityId],
      ] as const;
      await Promise.all(keys.map((key) => qc.cancelQueries({ queryKey: key })));
      const snapshots = keys.map((key) => ({ key, data: qc.getQueryData<SfPayment[]>(key) }));
      for (const key of keys) {
        qc.setQueryData<SfPayment[]>(key, (old) =>
          old?.map((p) => (p.Id === id ? { ...p, ...patch } : p)),
        );
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["opp-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunity-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

/** Same write path as useUpdatePayment, but scoped to the global
 *  /payments page (no parent opp context). Invalidates the
 *  ["payments"] query so the table refreshes. */
export function useUpdateAnyPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: PaymentPatch }) => {
      const { data } = await api.put(`/api/salesforce/payments/${id}`, { updates: patch });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["opp-payments"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}

export interface PaymentScheduleItem {
  amount: number;
  scheduled_date: string; // YYYY-MM-DD
}

/**
 * Create a payment schedule by replacing (or appending to) the existing
 * SF payments. Backend rejects if `sum(amounts) !== Opportunity.Amount`,
 * so callers should validate the total before submitting.
 */
interface ACVSummary {
  fy: number;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
}

export function useACVSummary(year: number, bucket: string = "all") {
  return useQuery({
    queryKey: ["acv-summary", year, bucket],
    queryFn: async () => {
      const { data } = await api.get<ACVSummary>(
        `/api/salesforce/payments/acv-summary?year=${year}&bucket=${bucket}`,
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

/**
 * Delete a single payment by SF Id. Used by the builder's diff-save
 * path to remove individual rows without blowing away the whole
 * schedule. Backend cascades cache invalidation.
 */
export function useDeletePayment(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paymentId: string) => {
      await api.delete(`/api/salesforce/payments/${encodeURIComponent(paymentId)}`);
      return paymentId;
    },
    onMutate: async (paymentId) => {
      const keys = [
        ["opp-payments", opportunityId],
        ["opportunity-payments", opportunityId],
      ] as const;
      await Promise.all(keys.map((key) => qc.cancelQueries({ queryKey: key })));
      const snapshots = keys.map((key) => ({ key, data: qc.getQueryData<SfPayment[]>(key) }));
      for (const key of keys) {
        qc.setQueryData<SfPayment[]>(key, (old) => old?.filter((p) => p.Id !== paymentId));
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["opp-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunity-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

/**
 * Create one payment under an opportunity. Differs from
 * useCreatePaymentSchedule (which bulk-creates and can wipe existing)
 * — this hook is for adding a single row to an already-existing
 * schedule without touching the others.
 */
export function useCreateSinglePayment(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PaymentScheduleItem) => {
      // Reuse the bulk endpoint with a single-item payload + the
      // delete_existing flag off so existing rows are preserved.
      const { data } = await api.post<{ success: boolean; payments_created: number }>(
        "/api/opportunities/create-payment-schedule",
        {
          opportunity_id: opportunityId,
          payments: [input],
          delete_existing: false,
        },
      );
      return data;
    },
    onMutate: async (input) => {
      const keys = [
        ["opp-payments", opportunityId],
        ["opportunity-payments", opportunityId],
      ] as const;
      await Promise.all(keys.map((key) => qc.cancelQueries({ queryKey: key })));
      const snapshots = keys.map((key) => ({ key, data: qc.getQueryData<SfPayment[]>(key) }));
      const tempRow: SfPayment = {
        Id: `temp-${Date.now()}`,
        npe01__Opportunity__c: opportunityId,
        npe01__Payment_Amount__c: input.amount,
        npe01__Scheduled_Date__c: input.scheduled_date,
        npe01__Payment_Date__c: null,
        npe01__Paid__c: false,
      };
      for (const key of keys) {
        qc.setQueryData<SfPayment[]>(key, (old) => [...(old ?? []), tempRow]);
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["opp-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunity-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}

export function useCreatePaymentSchedule(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      payments: PaymentScheduleItem[];
      delete_existing?: boolean;
    }) => {
      const { data } = await api.post<{ success: boolean; payments_created: number }>(
        "/api/opportunities/create-payment-schedule",
        {
          opportunity_id: opportunityId,
          payments: input.payments,
          delete_existing: input.delete_existing ?? true,
        },
      );
      return data;
    },
    // Optimistic: drop synthetic rows into the payments cache so the
    // schedule appears the instant the user clicks Create, instead of
    // waiting on N sequential SF round-trips. Real Ids come in via
    // the refetch from onSettled below.
    onMutate: async (input) => {
      const keys = [
        ["opp-payments", opportunityId],
        ["opportunity-payments", opportunityId],
      ] as const;
      await Promise.all(keys.map((key) => qc.cancelQueries({ queryKey: key })));
      const snapshots = keys.map((key) => ({ key, data: qc.getQueryData<SfPayment[]>(key) }));
      const tempRows: SfPayment[] = input.payments.map((p, i) => ({
        Id: `temp-${Date.now()}-${i}`,
        npe01__Opportunity__c: opportunityId,
        npe01__Payment_Amount__c: p.amount,
        npe01__Scheduled_Date__c: p.scheduled_date,
        npe01__Payment_Date__c: null,
        npe01__Paid__c: false,
      }));
      for (const key of keys) {
        qc.setQueryData<SfPayment[]>(key, (old) =>
          input.delete_existing === false
            ? [...(old ?? []), ...tempRows]
            : tempRows,
        );
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      // Always refetch so temp Ids get replaced with real SF Ids.
      qc.invalidateQueries({ queryKey: ["opp-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunity-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}
