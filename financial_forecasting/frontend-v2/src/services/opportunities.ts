import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { SfOpportunity, SfPayment, SfTask } from "@/types/salesforce";

export interface OpportunityFilters {
  /** RecordType.Name, e.g. "Grant", "Donation", "PBC". */
  recordType?: string;
  activeOnly?: boolean;
  limit?: number;
}

/**
 * RecordType.Name values that should be hidden everywhere in the UI.
 * Per JP 2026-05-03: ISA / Pursuit Bond is 2019–2020 legacy, tracked
 * in a separate enforcement system, and shouldn't appear in any of the
 * pipeline/awards/cleanup/account views.
 *
 * Pattern-matches rather than exact-equality because SF orgs sometimes
 * have multiple variant names ("ISA", "Income Share Agreement", "ISAs",
 * "Pursuit Bond / Income Share Agreement") and the user reported still
 * seeing some despite the original exclusion. The pattern below is
 * case-insensitive and uses word boundaries so it won't accidentally
 * match unrelated record types like "Visa Sponsorship".
 */
const EXCLUDED_RECORD_TYPE_PATTERN =
  /\bISA\b|\bIncome Share Agreement\b|\bPursuit Bond\b/i;

/**
 * Stage names that should be hidden everywhere — these aren't pipeline
 * data the fundraising team works with, regardless of open/closed
 * classification. ("In Collection" is a finance-team workflow
 * tracked elsewhere; treating it as Lost would still let it skew
 * the Lost rollups, so we drop the rows entirely instead.)
 */
const EXCLUDED_STAGE_NAMES: ReadonlySet<string> = new Set([
  "In Collection",
]);

export function isExcludedOpp(o: SfOpportunity): boolean {
  const rt = o.RecordType?.Name ?? "";
  if (EXCLUDED_RECORD_TYPE_PATTERN.test(rt)) return true;
  const stage = o.StageName ?? "";
  if (EXCLUDED_STAGE_NAMES.has(stage)) return true;
  return false;
}

async function fetchOpportunities(
  filters: OpportunityFilters = {},
): Promise<SfOpportunity[]> {
  const params = new URLSearchParams();
  if (filters.recordType) params.set("record_type", filters.recordType);
  if (filters.activeOnly) params.set("active_only", "true");
  if (filters.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const path = qs
    ? `/api/salesforce/opportunities?${qs}`
    : "/api/salesforce/opportunities";
  const { data } = await api.get<SfOpportunity[]>(path);
  // Strip the excluded record types at the data boundary so every UI
  // consumer (Pipeline, Awards, Cleanup, Account detail, Dashboard…)
  // gets a clean list without each having to remember.
  return data.filter((o) => !isExcludedOpp(o));
}

export function useOpportunities(filters: OpportunityFilters = {}) {
  return useQuery({
    queryKey: ["opportunities", filters],
    queryFn: () => fetchOpportunities(filters),
    staleTime: 60_000,
  });
}

export interface PriorStage {
  prior_stage: string | null;
  transitioned_at: string | null;
}

export interface StageHistoryEntry {
  old_value: string | null;
  new_value: string | null;
  created_date: string | null;
}

/** Org-wide stage-history row for the pipeline funnel. */
export interface FunnelStageChange {
  OpportunityId: string;
  OpportunityName: string | null;
  Amount: number;
  CurrentStage: string | null;
  OwnerId: string | null;
  OldValue: string | null;
  NewValue: string | null;
  CreatedDate: string;
}

/** All StageName changes in the last N days, across every opp. Drives
 *  the org-wide funnel's movement counts. Backend caches per-day key. */
export function useStageHistory(days: number = 30) {
  return useQuery({
    queryKey: ["stage-history", days],
    queryFn: async () => {
      const { data } = await api.get<FunnelStageChange[]>(
        `/api/salesforce/opportunities/stage-history?days=${days}`,
      );
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Full stage-transition history for one opp, oldest-first. Drives the
 *  StageProgression bar on the opp detail page. SF retains
 *  OpportunityFieldHistory for ~18 months; older opps may have a
 *  truncated history (the visualization handles missing history by
 *  showing only the current stage as active). */
export function useOpportunityStageHistory(opportunityId: string | null | undefined) {
  return useQuery({
    queryKey: ["opp-stage-history", opportunityId],
    queryFn: async () => {
      const { data } = await api.get<StageHistoryEntry[]>(
        `/api/salesforce/opportunities/${encodeURIComponent(opportunityId!)}/stage-history`,
      );
      return data;
    },
    enabled: !!opportunityId,
    staleTime: 5 * 60_000,
  });
}

export function useOpportunityPriorStages(ids: string[]) {
  // Sort the id list so the cache key is stable regardless of input order.
  const stableKey = useMemo(() => [...ids].sort(), [ids]);
  return useQuery({
    queryKey: ["opp-prior-stages", stableKey],
    queryFn: async (): Promise<Record<string, PriorStage>> => {
      if (stableKey.length === 0) return {};
      const { data } = await api.get<Record<string, PriorStage>>(
        `/api/salesforce/opportunities/prior-stages?ids=${stableKey.join(",")}`,
      );
      return data;
    },
    enabled: stableKey.length > 0,
    staleTime: 5 * 60_000,
  });
}

async function fetchOpportunityPayments(oppId: string): Promise<SfPayment[]> {
  const { data } = await api.get<SfPayment[]>(
    `/api/salesforce/opportunities/${encodeURIComponent(oppId)}/payments`,
  );
  return data;
}

export function useOpportunityPayments(oppId: string | undefined) {
  return useQuery({
    queryKey: ["opportunity-payments", oppId],
    queryFn: () => fetchOpportunityPayments(oppId!),
    staleTime: 60_000,
    enabled: !!oppId,
  });
}

interface TasksResponse {
  success: boolean;
  data: SfTask[];
}

async function fetchOpportunityTasks(oppId: string): Promise<SfTask[]> {
  const { data } = await api.get<TasksResponse>(
    `/api/salesforce/opportunities/${encodeURIComponent(oppId)}/tasks`,
  );
  return data.data ?? [];
}

export function useOpportunityTasks(oppId: string | undefined) {
  return useQuery({
    queryKey: ["opportunity-tasks", oppId],
    queryFn: () => fetchOpportunityTasks(oppId!),
    staleTime: 60_000,
    enabled: !!oppId,
  });
}

export function useOppRecordTypes() {
  return useQuery({
    queryKey: ["opp-record-types"],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data } = await api.get<{ id: string; name: string }[]>(
        "/api/salesforce/opportunities/record-types",
      );
      return data;
    },
    staleTime: 60 * 60_000,
  });
}

export interface CreateOpportunityBody {
  Name: string;
  StageName: string;
  CloseDate: string;
  AccountId: string;
  Amount?: number | null;
  OwnerId?: string | null;
  RecordTypeId?: string | null;
  Description?: string | null;
  /** Grant record type only — see components/GrantPeriodInputs. */
  Grant_Start_Date__c?: string | null;
  Grant_End_Date__c?: string | null;
}

export function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateOpportunityBody) => {
      const { data } = await api.post<{ success: boolean; data: { id: string; message: string } }>(
        "/api/salesforce/opportunities",
        body,
      );
      // Backend wraps response in ApiResponse envelope: { success, data: { id, message } }
      return data.data;
    },
    // Insert a synthesized opp into the cache immediately so the
    // detail page can render instantly when the user navigates to
    // /opportunities/<id>. OpportunityDetail finds its opp by
    // scanning the cached useOpportunities list — without this, the
    // page sits empty until the next refetch lands.
    onSuccess: (created, body) => {
      const synth: SfOpportunity = {
        Id: created.id,
        Name: body.Name,
        StageName: body.StageName,
        CloseDate: body.CloseDate ?? null,
        Amount: body.Amount ?? null,
        AccountId: body.AccountId,
        OwnerId: body.OwnerId ?? null,
        RecordTypeId: body.RecordTypeId ?? null,
        Description: body.Description ?? null,
        IsClosed: false,
        IsWon: false,
      } as SfOpportunity;
      qc.setQueriesData<SfOpportunity[]>({ queryKey: ["opportunities"] }, (old) =>
        old ? [synth, ...old] : old,
      );
      // Background refresh so the next refetch pulls the full SF
      // record (with the joined Account, Owner, RecordType, etc.).
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
  });
}

/**
 * Generic Opp patch — backend PUT /api/salesforce/opportunities/{id}.
 * Use for fields like NextStep, Description, Amount. For StageName,
 * prefer useUpdateOpportunityStage which goes through validate +
 * award-creation handler.
 */
export function useUpdateOpportunity() {
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
      const { data } = await api.put<SfOpportunity>(
        `/api/salesforce/opportunities/${encodeURIComponent(id)}`,
        { updates: patch, reason: "Updated via Bedrock" },
      );
      return data;
    },
    onSuccess: (_data, { id, patch, displayPatch }) => {
      const merged = { ...patch, ...(displayPatch ?? {}) };
      qc.setQueriesData<SfOpportunity[]>(
        { queryKey: ["opportunities"] },
        (old) =>
          old?.map((o) =>
            o.Id === id ? ({ ...o, ...merged } as SfOpportunity) : o,
          ),
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
  });
}

interface TaskCreateBody {
  Subject: string;
  Status?: string;
  Priority?: string;
  ActivityDate?: string | null;
  Description?: string | null;
  OwnerId?: string | null;
  WhoId?: string | null;
  WhatId?: string | null;
}

interface TaskUpdateBody {
  Subject?: string;
  Status?: string;
  Priority?: string;
  ActivityDate?: string | null;
  Description?: string | null;
  OwnerId?: string | null;
  WhoId?: string | null;
}

interface TaskCreateResult {
  success?: boolean;
  data?: {
    id?: string;
    /** Legacy single-field flag — kept for compat, mirrors clobbered_fields. */
    saved_subject?: string | null;
    subject_clobbered?: boolean;
    /** Names of fields SF saved differently from what we sent. */
    clobbered_fields?: string[];
    /** Field → value map of what SF actually has after the write. */
    saved_values?: Record<string, unknown>;
  };
}

interface TaskUpdateResult {
  success?: boolean;
  data?: {
    message?: string;
    clobbered_fields?: string[];
    saved_values?: Record<string, unknown>;
  };
}

/**
 * Create a Salesforce task linked to an opportunity. The backend stamps
 * WhatId from the URL path; we only ship body fields.
 */
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      opportunityId,
      body,
    }: {
      opportunityId: string;
      body: TaskCreateBody;
    }) => {
      const { data } = await api.post<TaskCreateResult>(
        `/api/salesforce/opportunities/${encodeURIComponent(opportunityId)}/tasks`,
        body,
      );
      return data;
    },
    // Optimistic insert so the new row shows up the instant the user
    // hits Enter. We deliberately do NOT invalidate the query on
    // settled — Salesforce's read-after-write isn't always consistent
    // (a refetch fired right after the POST can come back without the
    // new task and the row briefly disappears + reappears, which felt
    // glitchy to RMs). Instead, on success we swap the optimistic
    // row's temp id for the SF id in-place, leaving the cache
    // correct without another round-trip.
    onMutate: async ({ opportunityId, body }) => {
      const key = ["opportunity-tasks", opportunityId] as const;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<SfTask[]>(key);
      const optimistic = buildOptimisticTask(body, opportunityId);
      qc.setQueryData<SfTask[]>(key, (old) => [optimistic, ...(old ?? [])]);
      return { key, prev, optimisticId: optimistic.Id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined && ctx.key) {
        qc.setQueryData(ctx.key, ctx.prev);
      }
    },
    onSuccess: (data, vars, ctx) => {
      const newId = data?.data?.id;
      if (!newId || !ctx?.optimisticId) return;
      const key = ["opportunity-tasks", vars.opportunityId] as const;
      qc.setQueryData<SfTask[]>(key, (old) =>
        old?.map((t) => (t.Id === ctx.optimisticId ? { ...t, Id: newId } : t)),
      );
    },
  });
}

/** Build a synthetic SfTask for optimistic list insertion. The temp Id
 *  is replaced when the real task lands via the refetch in onSettled. */
function buildOptimisticTask(body: TaskCreateBody, whatId: string): SfTask {
  return {
    Id: `__tmp__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    Subject: body.Subject ?? null,
    Status: body.Status ?? "Not Started",
    Priority: body.Priority ?? null,
    ActivityDate: body.ActivityDate ?? null,
    Description: body.Description ?? null,
    IsClosed: false,
    OwnerId: body.OwnerId ?? null,
    OwnerName: null,
    WhatId: whatId,
    WhatName: null,
  };
}

/** Cache-key prefixes that may hold a task list — used by useUpdateTask
 *  to broadcast optimistic edits across every list that contains the row. */
const TASK_LIST_PREFIXES = [
  "opportunity-tasks",
  "account-tasks",
  "contact-tasks",
  "user-tasks",
] as const;

function applyTaskPatch(t: SfTask, patch: TaskUpdateBody): SfTask {
  // IsClosed is SF-computed. When Status is patched, derive locally so
  // the checkbox flips immediately on both complete *and* reopen.
  const next = { ...t, ...patch } as SfTask;
  if (patch.Status !== undefined) {
    next.IsClosed = patch.Status === "Completed";
  }
  return next;
}

/**
 * Update one of a task's fields. The mutation finds every cached task
 * list that contains this task (across opp + account scopes) and
 * rewrites it optimistically, so an edit on the Account page reflects
 * instantly even if the Opportunity page has the same task cached.
 */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: TaskUpdateBody;
    }) => {
      const { data } = await api.put<TaskUpdateResult>(
        `/api/salesforce/tasks/${encodeURIComponent(id)}`,
        patch,
      );
      return data;
    },
    onMutate: async ({ id, patch }) => {
      const matches = qc.getQueryCache().findAll({
        predicate: (q) => {
          const k = q.queryKey;
          if (!Array.isArray(k) || typeof k[0] !== "string") return false;
          if (!TASK_LIST_PREFIXES.includes(k[0] as (typeof TASK_LIST_PREFIXES)[number])) {
            return false;
          }
          const data = q.state.data as SfTask[] | undefined;
          return Array.isArray(data) && data.some((t) => t.Id === id);
        },
      });

      const snapshots: { key: readonly unknown[]; data: SfTask[] }[] = [];
      for (const m of matches) {
        const prev = qc.getQueryData<SfTask[]>(m.queryKey);
        if (!prev) continue;
        snapshots.push({ key: m.queryKey, data: prev });
        await qc.cancelQueries({ queryKey: m.queryKey });
        qc.setQueryData<SfTask[]>(m.queryKey, (old) =>
          old?.map((t) => (t.Id === id ? applyTaskPatch(t, patch) : t)),
        );
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots?.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      // Invalidate all task lists 2s later so the server's truth wins.
      setTimeout(() => {
        TASK_LIST_PREFIXES.forEach((prefix) =>
          qc.invalidateQueries({ queryKey: [prefix] }),
        );
      }, 2000);
    },
  });
}

/* ────────────────────────────────────────────────────────────────────
 * Account-scoped task hooks. WhatId can point to Account directly or
 * to any of the account's opps; the backend unions both.
 * ──────────────────────────────────────────────────────────────────── */

async function fetchAccountTasks(accountId: string): Promise<SfTask[]> {
  const { data } = await api.get<TasksResponse>(
    `/api/salesforce/accounts/${encodeURIComponent(accountId)}/tasks`,
  );
  return data.data ?? [];
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/salesforce/tasks/${encodeURIComponent(id)}`);
    },
    onMutate: async (id) => {
      // Optimistically drop from every cached task list.
      const matches = qc.getQueryCache().findAll({
        predicate: (q) => {
          const k = q.queryKey;
          if (!Array.isArray(k) || typeof k[0] !== "string") return false;
          if (!TASK_LIST_PREFIXES.includes(k[0] as (typeof TASK_LIST_PREFIXES)[number])) {
            return false;
          }
          const data = q.state.data as SfTask[] | undefined;
          return Array.isArray(data) && data.some((t) => t.Id === id);
        },
      });
      const snapshots: { key: readonly unknown[]; data: SfTask[] }[] = [];
      for (const m of matches) {
        const prev = qc.getQueryData<SfTask[]>(m.queryKey);
        if (!prev) continue;
        snapshots.push({ key: m.queryKey, data: prev });
        await qc.cancelQueries({ queryKey: m.queryKey });
        qc.setQueryData<SfTask[]>(m.queryKey, (old) =>
          old?.filter((t) => t.Id !== id),
        );
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots?.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      setTimeout(() => {
        TASK_LIST_PREFIXES.forEach((prefix) =>
          qc.invalidateQueries({ queryKey: [prefix] }),
        );
      }, 2000);
    },
  });
}

export function useAccountTasks(accountId: string | undefined) {
  return useQuery({
    queryKey: ["account-tasks", accountId],
    queryFn: () => fetchAccountTasks(accountId!),
    staleTime: 60_000,
    enabled: !!accountId,
  });
}

async function fetchContactTasks(contactId: string): Promise<SfTask[]> {
  const { data } = await api.get<TasksResponse>(
    `/api/salesforce/contacts/${encodeURIComponent(contactId)}/tasks`,
  );
  return data.data ?? [];
}

/** Tasks where SF Task.WhoId points at this contact. */
export function useContactTasks(contactId: string | undefined) {
  return useQuery({
    queryKey: ["contact-tasks", contactId],
    queryFn: () => fetchContactTasks(contactId!),
    staleTime: 60_000,
    enabled: !!contactId,
  });
}

async function fetchUserTasks(ownerId: string, includeClosed: boolean): Promise<SfTask[]> {
  const qs = includeClosed ? "?include_closed=true" : "";
  const { data } = await api.get<TasksResponse>(
    `/api/salesforce/users/${encodeURIComponent(ownerId)}/tasks${qs}`,
  );
  return data.data ?? [];
}

/** Tasks owned by a Salesforce user (Task.OwnerId).
 *  By default returns only open tasks; pass `includeClosed` to fetch
 *  all (used by the homebase "Show done" toggle). */
export function useUserTasks(ownerId: string | undefined, includeClosed = false) {
  return useQuery({
    queryKey: ["user-tasks", ownerId, includeClosed],
    queryFn: () => fetchUserTasks(ownerId!, includeClosed),
    staleTime: 60_000,
    enabled: !!ownerId,
  });
}

/**
 * Create a task tied directly to an Account (WhatId = account_id). For
 * tasks tied to a specific opportunity, use useCreateTask instead.
 */
export function useCreateAccountTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      accountId,
      body,
    }: {
      accountId: string;
      body: TaskCreateBody;
    }) => {
      const { data } = await api.post<TaskCreateResult>(
        `/api/salesforce/accounts/${encodeURIComponent(accountId)}/tasks`,
        body,
      );
      return data;
    },
    onMutate: async ({ accountId, body }) => {
      const key = ["account-tasks", accountId] as const;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<SfTask[]>(key);
      const optimistic = buildOptimisticTask(body, accountId);
      qc.setQueryData<SfTask[]>(key, (old) => [optimistic, ...(old ?? [])]);
      return { key, prev, optimisticId: optimistic.Id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined && ctx.key) {
        qc.setQueryData(ctx.key, ctx.prev);
      }
    },
    onSuccess: (data, vars, ctx) => {
      // Swap the optimistic temp Id for the SF id in-place. See note
      // on useCreateTask — invalidating + refetching here would fight
      // SF's read-after-write delay and the new row would flash out
      // and back in.
      const newId = data?.data?.id;
      if (!newId || !ctx?.optimisticId) return;
      const key = ["account-tasks", vars.accountId] as const;
      qc.setQueryData<SfTask[]>(key, (old) =>
        old?.map((t) => (t.Id === ctx.optimisticId ? { ...t, Id: newId } : t)),
      );
    },
  });
}

/**
 * Generic Task creation against `POST /api/salesforce/tasks`. Use this
 * when the parent record is set via UI (Contact expand panel, Tasks
 * page link-picker) rather than fixed by the URL route. The body's
 * WhoId / WhatId / OwnerId / ActivityDate are all optional, so this
 * also covers ownerless "My Tasks" entries.
 *
 * Optimistic insert: drops the new row into the matching cache list
 * (contact-tasks if WhoId present, my-tasks otherwise). The temp Id
 * is replaced when the cache refetches onSettled.
 */
export function useCreateGenericTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TaskCreateBody) => {
      const { data } = await api.post<TaskCreateResult>("/api/salesforce/tasks", body);
      return data;
    },
    onMutate: async (body) => {
      // Primary cache list: contact-tasks if WhoId, opp-tasks if WhatId,
      // my-tasks otherwise. Snapshot for rollback.
      const targetKey: readonly unknown[] = body.WhoId
        ? (["contact-tasks", body.WhoId] as const)
        : body.WhatId
          ? (["opportunity-tasks", body.WhatId] as const)
          : (["my-tasks"] as const);
      await qc.cancelQueries({ queryKey: targetKey });
      const prev = qc.getQueryData<SfTask[]>(targetKey);
      const optimistic = buildOptimisticTask(body, body.WhatId ?? body.WhoId ?? "");
      qc.setQueryData<SfTask[]>(targetKey, (old) => [optimistic, ...(old ?? [])]);

      // ALSO push the optimistic row into every cached `user-tasks`
      // list whose ownerId matches this task's OwnerId. PortfolioTasks
      // (My Tasks panel on /portfolio) reads from `["user-tasks",
      // ownerId, includeClosed]` — without this insert it'd wait for
      // the server roundtrip + invalidate before the new row appears.
      const userTaskSnapshots: { key: readonly unknown[]; data: SfTask[] | undefined }[] = [];
      if (body.OwnerId) {
        const matches = qc.getQueryCache().findAll({
          predicate: (q) => {
            const k = q.queryKey;
            return Array.isArray(k) && k[0] === "user-tasks" && k[1] === body.OwnerId;
          },
        });
        for (const m of matches) {
          const previous = qc.getQueryData<SfTask[]>(m.queryKey);
          userTaskSnapshots.push({ key: m.queryKey, data: previous });
          qc.setQueryData<SfTask[]>(m.queryKey, (old) => [optimistic, ...(old ?? [])]);
        }
      }

      return { targetKey, prev, userTaskSnapshots, optimisticId: optimistic.Id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined && ctx.targetKey) {
        qc.setQueryData(ctx.targetKey, ctx.prev);
      }
      ctx?.userTaskSnapshots?.forEach(({ key, data }) => qc.setQueryData(key, data));
    },
    onSuccess: (data, _body, ctx) => {
      // Swap temp Id for the real SF id across every cache the
      // optimistic row landed in. We deliberately do NOT invalidate
      // here — SF's read-after-write isn't consistent and a refetch
      // can come back without the new task, flashing the row out and
      // back in. The in-place Id swap leaves every cache correct
      // without another round-trip.
      const newId = data?.data?.id;
      if (!newId || !ctx?.optimisticId) return;
      const swap = (old: SfTask[] | undefined) =>
        old?.map((t) => (t.Id === ctx.optimisticId ? { ...t, Id: newId } : t));
      qc.setQueryData<SfTask[]>(ctx.targetKey, swap);
      ctx.userTaskSnapshots?.forEach(({ key }) => {
        qc.setQueryData<SfTask[]>(key, swap);
      });
    },
  });
}

/**
 * Stage transition — uses POST /api/opportunities/update-stage so the
 * server-side validation runs and the awards auto-create handler fires
 * on closed-won transitions.
 *
 * Optimistic update: immediately patch StageName in every opportunities
 * cache entry so the detail page reflects the new stage without waiting
 * for a refetch. Rolls back on error.
 */
export function useUpdateOpportunityStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      newStage,
    }: {
      id: string;
      newStage: string;
    }) => {
      const { data } = await api.post(`/api/opportunities/update-stage`, {
        opportunity_id: id,
        new_stage: newStage,
      });
      return data;
    },
    onMutate: async ({ id, newStage }) => {
      await qc.cancelQueries({ queryKey: ["opportunities"] });
      const snapshots = qc
        .getQueriesData<SfOpportunity[]>({ queryKey: ["opportunities"] })
        .map(([key, data]) => ({ key, data }));
      qc.setQueriesData<SfOpportunity[]>({ queryKey: ["opportunities"] }, (old) =>
        old?.map((o) =>
          o.Id === id ? { ...o, StageName: newStage } : o,
        ),
      );
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.snapshots.forEach(({ key, data }) => {
        qc.setQueryData(key, data);
      });
    },
    onSuccess: (data) => {
      if (data?.award_created) {
        toast.success("Award created");
      }
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}
