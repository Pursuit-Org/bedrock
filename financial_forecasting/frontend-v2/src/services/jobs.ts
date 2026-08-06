import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient, keepPreviousData, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Invalidate the query families that depend on opportunities/activity — opp
 * list + detail, account rollups, and pipeline metrics. Replaces blanket
 * invalidation of the whole ["jobs"] tree (which also refetched staff and
 * unrelated metric drawers). `extra` adds caller-specific families.
 */
function invalidateOppDependents(qc: QueryClient, extra: string[][] = []) {
  const families = [
    ["jobs", "opportunities"],
    ["jobs", "opportunity"],
    ["jobs", "accounts"],
    ["jobs", "account-rollup"],
    ["jobs", "pipeline"],
    ["jobs", "funnel"],
    ["jobs", "this-week-summary"],
    ["jobs", "interview-pipeline"],
    ...extra,
  ];
  for (const queryKey of families) qc.invalidateQueries({ queryKey });
}

// ── Types ────────────────────────────────────────────────────────────────────

// The 2026-08-05 simplification: six stages. The legacy values stay in the union
// so rows written before the migration still type-check and render a label —
// they just aren't offered as choices (see STAGES_ORDERED / useStageVocabulary).
export type JobStage =
  | "lead_submitted"
  | "active_in_discussions"
  | "active_opportunity_confirmed"
  | "reviewing_builders"
  | "closed_won"
  | "closed_lost"
  // legacy, pre-2026-08-05
  | "initial_outreach"
  | "active_builder_interview"
  | "on_hold_not_selected"
  | "on_hold_not_interested"
  | "on_hold_not_responsive";

export type DealType = "ft" | "pt_contract" | "capstone" | "volunteer" | "workshop" | "pilot";

export interface JobsOpportunity {
  id: string;
  account_id: string;
  account_name: string;
  stage: JobStage;
  deal_type: DealType | null;
  title: string | null;
  description: string | null;
  salary_expected: number | null;
  source: string | null;
  owner_email: string | null;
  relationship_owner: string | null;
  sf_contact_ids: string[];
  builder_ids: string[];
  sf_opportunity_id: string | null;
  touch_count: number;
  follow_up_date: string | null;
  target_close_date: string | null;
  airtable_id: string | null;
  num_roles: number | null;
  likelihood: "low" | "medium" | "high" | null;
  closed_lost_reason?: string | null;
  closed_lost_note?: string | null;
  priority?: number | null;
  priority_auto?: number | null;
  priority_suggested?: number | null;
  open_tasks?: number;
  segment?: string | null;
  intro_by?: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
  activity_count?: number;
  last_activity_at?: string | null;
  recent_activity_count?: number;
  /** Campaign tags — same vocabulary as contacts. Empty until the
   *  2026-08-05 migration adds the column. */
  tags?: string[];
}

export interface JobContact {
  contact_id: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

export interface ContactsSummary {
  contacts: {
    total: number;
    engaged: number;
    by_stage: { stage: string; count: number }[];
  };
  accounts: { total: number; engaged: number };
  activity: {
    outreach_total: number;
    outreach_this_week: number;
    calls_total: number;
    calls_this_week: number;
    meetings_total: number;
    outreach_this_month: number;
    active_owners: number;
  };
  active_companies: number;
}

export interface JobsOpportunityDetail extends JobsOpportunity {
  stage_history: StageHistoryEntry[];
  activity: ActivityEntry[];
  contacts: JobContact[];
}

export interface StageHistoryEntry {
  id: string;
  opportunity_id: string;
  from_stage: JobStage | null;
  to_stage: JobStage;
  changed_by: string | null;
  note: string | null;
  changed_at: string;
}

export interface ActivityEntry {
  id: string;
  type: string;
  subject: string | null;
  description: string | null;
  activity_date: string | null;
  source: string;
  logged_by: string | null;
  synced_at: string | null;
  email_from: string | null;
  email_to: string[] | null;
  email_snippet: string | null;
  email_body_text: string | null;
  meeting_duration_minutes: number | null;
  is_jobs: boolean;
  jobs_relevance?: string | null;           // AI verdict: jobs | not_jobs | unclear
  jobs_relevance_override?: string | null;  // human override: jobs | not_jobs
  deleted_at: string | null;
}

export interface PipelineStageSummary {
  stage: JobStage;
  label: string;
  group: string;
  total: number;
  by_type: Partial<Record<DealType, number>>;
  avg_salary: number | null;
}

export interface OpportunityFilters {
  stage?: JobStage;
  stage_group?: "lead" | "initial" | "active" | "closed" | "on_hold";
  owner_email?: string;
  account_id?: string;
  deal_type?: DealType;
  limit?: number;
  offset?: number;
}

// ── Labels & metadata ────────────────────────────────────────────────────────

export const STAGE_LABELS: Record<JobStage, string> = {
  lead_submitted:               "Lead Submitted",
  active_in_discussions:        "In Discussions",
  active_opportunity_confirmed: "Opportunity Confirmed",
  reviewing_builders:           "Reviewing Builders",
  closed_won:                   "Closed — Won",
  closed_lost:                  "Closed — Lost",
  // Legacy — labelled so un-migrated rows and history read as words, not slugs.
  initial_outreach:             "Initial Outreach",
  active_builder_interview:     "Builder Interview",
  on_hold_not_selected:         "Not Selected",
  on_hold_not_interested:       "Not Interested",
  on_hold_not_responsive:       "Not Responsive",
};

export const DEAL_TYPE_LABELS: Record<DealType, string> = {
  ft:          "Full time",
  pt_contract: "PT / Contract",
  capstone:    "Capstone",
  volunteer:   "Volunteer",
  workshop:    "Workshop",
  pilot:       "Pilot",
};

/** Board columns and pickers, in pipeline order. Six stages as of 2026-08-05.
 *  Legacy values are deliberately absent: a picker must not offer a stage the
 *  team has retired. Anything still stored under one renders via STAGE_LABELS
 *  and moves to a current stage on the next edit. */
export const STAGES_ORDERED: JobStage[] = [
  "lead_submitted",
  "active_in_discussions",
  "active_opportunity_confirmed",
  "reviewing_builders",
  "closed_won",
  "closed_lost",
];

/** Legacy stages that still exist in un-migrated data. Rendered, never offered. */
export const LEGACY_STAGES: JobStage[] = [
  "initial_outreach",
  "active_builder_interview",
  "on_hold_not_selected",
  "on_hold_not_interested",
  "on_hold_not_responsive",
];

export const ACTIVE_STAGES: JobStage[] = [
  "active_in_discussions",
  "active_opportunity_confirmed",
  "reviewing_builders",
];

// ── Hooks ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> { success: boolean; data: T }
interface ListResponse<T> { success: boolean; data: T[]; total: number }

export interface JobContactWithDeal extends JobContact {
  airtable_id: string | null;
  is_jobs_contact?: boolean;
  owner_email?: string | null;     // org-wide contact owner (distinct from membership_owner)
  crm_tags?: string[];             // curated tags only — system markers never reach the UI
  deal: { id: string; account_name: string; stage: JobStage; owner_email?: string | null } | null;
  connected_staff_names?: string[];
  recent_activity_count?: number;
  last_activity_at?: string | null;
  first_activity_at?: string | null;
  responded?: boolean;
  activity_actors?: string[];
  open_tasks?: number;
  // jobs activation membership + triage signals
  membership_stage?: string | null;
  membership_owner?: string | null;
  membership_stage_entered_at?: string | null;
  first_outreach_by?: string | null;
  company_industry?: string | null;
  open_roles?: number;        // roles the team sourced at this company (job_postings)
  builder_apps?: number;      // jobs builders applied to at this company (job_applications)
}

// "In the pipeline" = the jobs-prospect flag (is_jobs_contact). A membership
// carries a real funnel stage a user sets; a jobs prospect with NO membership
// has no stage yet (blank). 'assigned' is the first real stage (deliberately
// set), not an auto-applied placeholder.
// `on_hold` is the pre-2026-08-05 value, replaced by `revisit` (which carries a
// date and files a task). It stays in the union so rows written before the
// migration still type-check and render a label.
export type MembershipStage =
  | "assigned" | "initial_outreach" | "call_booked"
  | "converted_to_opportunity" | "revisit" | "not_a_fit"
  | "on_hold";
export const MEMBERSHIP_STAGES: MembershipStage[] = [
  "assigned", "initial_outreach", "call_booked", "converted_to_opportunity", "revisit", "not_a_fit",
];
export const MEMBERSHIP_STAGE_LABELS: Record<MembershipStage, string> = {
  assigned: "Assigned", initial_outreach: "Initial outreach", call_booked: "Call booked",
  converted_to_opportunity: "Converted to opportunity", revisit: "Revisit", not_a_fit: "Not a fit",
  on_hold: "On hold",
};

/** What the database will actually accept right now. The stage migration is
 *  applied by Jac out-of-band, so the writable vocabulary can change without a
 *  deploy — building pickers from this is what stops the UI offering a stage the
 *  CHECK constraint rejects (which would fail saves for everyone). */
export interface StageOption {
  value: string;
  label: string;
  /** False while the database CHECK constraint still rejects it — shown in the
   *  picker but not selectable, so a pending migration reads as "coming" rather
   *  than "missing". */
  available: boolean;
  unavailable_reason?: string | null;
}
export interface StageVocabulary {
  opportunity_stages: StageOption[];
  membership_stages: (StageOption & { value: MembershipStage })[];
  closed_lost_reasons: StageOption[];
  /** True once the 2026-08-05 stage migration has landed. */
  migrated: boolean;
}

export function useStageVocabulary() {
  return useQuery<StageVocabulary>({
    queryKey: ["jobs", "stage-vocabulary"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<StageVocabulary>>("/api/jobs/stage-vocabulary");
      return data.data;
    },
    staleTime: 300_000,
  });
}

export interface ContactFilters {
  stage?: string;
  search?: string;
  company?: string;
  limit?: number;
  flagged?: boolean;
  membership_stage?: string;
  industry?: string;
  has_open_roles?: boolean;
  /** 'jobs' (default) = jobs prospects only; 'all' = the full contact universe. */
  scope?: "jobs" | "all";
  /** Serialized Filter-menu rules — translated to SQL server-side so filters
   *  see the full 47k universe, never just the loaded page. */
  rules?: { field: string; op: string; values: string[] }[];
}

export interface ConnectedStaff {
  staff_user_id: number;
  name: string | null;
  email: string | null;
  source: string | null;
  strength: string | null;
  connected_date: string | null;
}

export interface OpenRole {
  id: number;
  job_title: string | null;
  job_url: string | null;
  status: string | null;
  source: string | null;
  salary_range: string | null;
  location: string | null;
  aligned_sector: string | null;
  builder_interest_count: number | null;
  created_at: string | null;
}
export interface CompanyBuilderRole {
  role_title: string;         // one row per unique role at the company
  applicant_count: number;    // # distinct builders who applied to it
  stages: string[] | null;    // stages across those applicants
  source_type: string | null;
  last_applied: string | null;
  team_linked: boolean;       // true if any applicant tied to a team opportunity
}
export interface ContactDetail extends JobContactWithDeal {
  activity: ActivityEntry[];
  connected_staff?: ConnectedStaff[];
  open_roles_list?: OpenRole[];   // the actual sourced roles (list carries only the count)
  builder_applications?: CompanyBuilderRole[];
}

export function useContactDetail(id: number | null) {
  return useQuery<ContactDetail>({
    queryKey: ["jobs", "contact", id],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactDetail>>(`/api/jobs/contacts/${id}`);
      return data.data;
    },
    enabled: id !== null,
    staleTime: 30_000,
  });
}

export interface ContactSearchResult {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
  source: string | null;
  airtable_id: string | null;
  contact_stage: string | null;
  in_sf: boolean;
  contact_ref: string;  // the ref to store in sf_contact_ids: airtable:XX, pub:123, or sf_id
}

export function useContactSearch(q: string) {
  return useQuery<ContactSearchResult[]>({
    queryKey: ["jobs", "contact-search", q],
    queryFn: async () => {
      if (q.length < 2) return [];
      const { data } = await api.get<ApiResponse<ContactSearchResult[]>>(
        `/api/jobs/contacts/search?q=${encodeURIComponent(q)}&limit=20`
      );
      return data.data;
    },
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
}

export function useJobsContacts(filters: ContactFilters = {}) {
  const params = new URLSearchParams();
  if (filters.stage)   params.set("stage",   filters.stage);
  if (filters.search)  params.set("search",  filters.search);
  if (filters.company) params.set("company", filters.company);
  if (filters.flagged !== undefined) params.set("flagged", String(filters.flagged));
  if (filters.membership_stage) params.set("membership_stage", filters.membership_stage);
  if (filters.industry) params.set("industry", filters.industry);
  if (filters.has_open_roles) params.set("has_open_roles", "true");
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.rules && filters.rules.length > 0) params.set("filters", JSON.stringify(filters.rules));
  params.set("limit", String(filters.limit ?? 200));

  return useQuery<{ data: JobContactWithDeal[]; total: number }>({
    queryKey: ["jobs", "contacts", filters],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await api.get<{ success: boolean; data: JobContactWithDeal[]; total: number }>(
        `/api/jobs/contacts?${params}`
      );
      return { data: data.data, total: data.total };
    },
    staleTime: 60_000,
  });
}

/** Bulk "flag for jobs activation" → creates memberships at stage 'flagged'. */
export function useFlagContactsForJobs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { contact_ids: number[]; owner_email?: string; activation_reason?: string; note?: string; stage?: string }) => {
      const { data } = await api.post<ApiResponse<{ flagged: number }>>("/api/jobs/contacts/flag-jobs", body);
      return data.data;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
      toast.success(`Flagged ${d?.flagged ?? 0} for jobs`);
    },
    onError: () => toast.error("Failed to flag contacts"),
  });
}

/** Advance the funnel / reassign owner on a contact's jobs membership. */
export function useUpdateJobsMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contact_id, ...body }: { contact_id: number; stage?: string; owner_email?: string; first_outreach_by?: string; not_a_fit_reason?: string; revisit_date?: string }) => {
      await api.patch(`/api/jobs/contacts/${contact_id}/jobs-membership`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
      // A revisit files a jobs_task, so the Jobs Home task widget is now stale.
      qc.invalidateQueries({ queryKey: ["jobs", "tasks"] });
    },
    onError: () => toast.error("Failed to update stage"),
  });
}

/** Unflag — remove the jobs membership. */
export function useBulkContactOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { contact_ids: number[]; owner_email?: string | null }) => {
      const { data } = await api.post<ApiResponse<{ updated: number }>>("/api/jobs/contacts/bulk-owner", body);
      return data.data;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success(`Owner set on ${d?.updated ?? 0} contact${(d?.updated ?? 0) === 1 ? "" : "s"}`);
    },
    onError: () => toast.error("Failed to set owner"),
  });
}

export function useUnflagJobsContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contact_id: number) => { await api.delete(`/api/jobs/contacts/${contact_id}/jobs-membership`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
      toast.success("Unflagged");
    },
    onError: () => toast.error("Failed to unflag"),
  });
}

// Prospects grouped into account rows (by company name) for the account-level
// Prospects view. Each account carries its current opportunity, if any.
export interface ProspectAccountContact {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

export interface ProspectAccount {
  account: string;
  contact_count: number;
  contacts: ProspectAccountContact[];
  deal: { id: string; stage: JobStage; deal_type: DealType | null; owner_email: string | null } | null;
}

export function useContactsByAccount(dealType?: string) {
  const params = new URLSearchParams();
  if (dealType && dealType !== "all") params.set("deal_type", dealType);
  return useQuery<ProspectAccount[]>({
    queryKey: ["jobs", "contacts-by-account", dealType ?? "all"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ProspectAccount[]>>(
        `/api/jobs/contacts/by-account?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// Account-level hub: every company (keyed by normalized name) with its
// opportunities + prospects nested and a derived status (same vocabulary as the
// portfolio Accounts tab). Backed by GET /api/jobs/accounts.
export type JobsAccountStatus = "Prospect" | "Activating" | "Pursuing" | "Stewarding" | "Re-activating" | "Dormant";

export interface JobsAccountOpp {
  id: string;
  title: string | null;
  stage: JobStage;
  deal_type: DealType | null;
  owner_email: string | null;
  priority: number | null;
  num_roles: number | null;
  likelihood: "low" | "medium" | "high" | null;
  updated_at: string | null;
}

export interface JobsAccountProspect {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

export interface JobsAccount {
  account: string;
  account_key: string;
  account_id: string | null;
  sf_account_id?: string | null;
  owner_email: string | null;
  account_status: JobsAccountStatus;
  /** Firmographics from public.companies — read-only in Bedrock; other systems
   *  own this data, so the UI displays it and never edits it. */
  industry?: string | null;
  size_bucket?: string | null;
  hq_location?: string | null;
  company_stage?: string | null;
  /** The investor/owner of this company — itself an account, so the link is
   *  navigable. Null until the 2026-08-05 migration adds the column. */
  investor_account_key?: string | null;
  investor_name?: string | null;
  /** How many companies name THIS account as their investor. */
  portfolio_count?: number;
  opportunities: JobsAccountOpp[];
  /** Prospects are NOT nested in the list payload (~38k rows) — fetch them
   *  lazily per account via useAccountProspects. Only the count ships here. */
  opp_count: number;
  prospect_count: number;
  /** Everyone on file at the company, flagged or not (PFNYC had 11 with 0 flagged). */
  contact_count?: number;
  /** Same company under another spelling that DOES hold prospects (email-domain match). */
  prospect_sibling?: { account: string; prospects: number } | null;
  job_listings?: number;    // roles sourced + open-market roles builders applied to
  roles_sourced?: number;
  roles_applied?: number;
  last_activity: string | null;
  open_tasks?: number;
  recent_activity_count?: number;
  last_activity_at?: string | null;
  first_activity_at?: string | null;
  responded?: boolean;
  /** Jobs-team members (emails) who have touched this account — for the team filter. */
  activity_actors?: string[];
  /** Builders we placed here (our DB). */
  builders_hired?: number;
  /** Historical Pursuit fellows hired here (from Salesforce); null until enriched. */
  fellows_hired?: number | null;
  /** All SF account ids this account resolves to (for joining SF fellow counts). */
  sf_account_ids?: string[];
}

export function useJobsAccounts(dealType?: string, scope: "engaged" | "all" = "engaged") {
  const params = new URLSearchParams();
  if (dealType && dealType !== "all") params.set("deal_type", dealType);
  params.set("scope", scope);
  return useQuery<JobsAccount[]>({
    queryKey: ["jobs", "accounts", dealType ?? "all", scope],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsAccount[]>>(`/api/jobs/accounts?${params}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface AccountMatch {
  key: string | null;            // local account_key, if we already have it
  label: string;                 // display name
  sf_account_id: string | null;  // carried silently for reconciliation
  record_count: number;          // contacts/opps in our pipeline (0 = none yet)
}
export interface AccountResolveResult { matches: AccountMatch[]; exact: boolean }
/** Does a matching account already exist? Returns ONE de-duplicated list merging
 *  our pipeline + Salesforce; the caller never sees the source. */
export function useResolveAccount(name: string) {
  return useQuery<AccountResolveResult>({
    queryKey: ["jobs", "account-resolve", name.trim().toLowerCase()],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<AccountResolveResult>>(
        `/api/jobs/accounts/resolve?name=${encodeURIComponent(name.trim())}`);
      return data.data;
    },
    enabled: name.trim().length >= 2,
    staleTime: 15_000,
  });
}
/** Create a net-new local jobs account (optionally linked to an existing SF id).
 *  Never creates an account in Salesforce. Returns the new account_key. */
export function useCreateJobsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; sf_account_id?: string | null }) => {
      const { data } = await api.post<ApiResponse<{ account_key: string; display: string }>>(
        "/api/jobs/accounts", body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
      qc.invalidateQueries({ queryKey: ["jobs", "account-names"] });
      toast.success("Account created");
    },
    onError: () => toast.error("Failed to create account"),
  });
}

export interface JobsAccountName { account_key: string; account: string }
/** Lightweight account names for dropdowns — avoids the full /accounts payload
 *  (which nests every prospect, ~38k rows). */
export function useJobsAccountNames() {
  return useQuery<JobsAccountName[]>({
    queryKey: ["jobs", "account-names"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsAccountName[]>>("/api/jobs/accounts/names");
      return data.data ?? [];
    },
    staleTime: 5 * 60_000,
  });
}

export interface ContactOpportunity {
  id: string;
  account_name: string;
  title: string | null;
  stage: JobStage;
  deal_type: DealType | null;
  owner_email: string | null;
  num_roles: number | null;
  priority: number | null;
  updated_at: string | null;
}

export function useContactOpportunities(id: number | null) {
  return useQuery<ContactOpportunity[]>({
    queryKey: ["jobs", "contact-opps", id],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactOpportunity[]>>(`/api/jobs/contacts/${id}/opportunities`);
      return data.data;
    },
    enabled: id !== null,
    staleTime: 60_000,
  });
}

// ── Account roll-ups (read aggregations across an account's opps + contacts) ──
type AccountScope = "opportunity" | "contact";

export interface AccountTask {
  id: string; title: string | null; status: string | null; deadline: string | null;
  scope: AccountScope; parent_id: string; scope_label: string;
}
export interface AccountComment {
  id: string; author_email: string | null; content: string; created_at: string | null;
  scope: AccountScope; scope_label: string;
}
export interface AccountBuilderRow {
  job_application_id: number; builder: string | null; company_name: string | null;
  role_title: string | null; stage: string | null; jobs_role_id: string | null; date_applied: string | null;
  opportunity_id: string | null; opp_title: string | null;
}
export interface AccountRole {
  id: string; opportunity_id: string; opp_title: string | null; title: string | null;
  status: string | null; employment_type: string | null; approx_salary: number | null;
  commitment: string | null; is_trial: boolean | null; filled_by_user_id: number | null;
}

function accountRollup<T>(kind: string, key: string | null) {
  return useQuery<T>({
    queryKey: ["jobs", "account-rollup", kind, key],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<T>>(`/api/jobs/account-${kind}?key=${encodeURIComponent(key ?? "")}`);
      return data.data;
    },
    enabled: Boolean(key),
    staleTime: 30_000,
  });
}

export const useAccountActivity = (key: string | null) => accountRollup<ActivityEntry[]>("activity", key);
export const useAccountTasks    = (key: string | null) => accountRollup<AccountTask[]>("tasks", key);
export const useAccountComments = (key: string | null) => accountRollup<AccountComment[]>("comments", key);
export const useAccountBuilders = (key: string | null) => accountRollup<{ rows: AccountBuilderRow[]; summary: Record<string, number> }>("builders", key);
export const useAccountRoles    = (key: string | null) => accountRollup<AccountRole[]>("roles", key);
/** Prospects at one account — loaded lazily on row-expand so /accounts stays
 *  lean. `scope` mirrors the account list's engaged/all toggle so the drill-in
 *  matches the row's prospect_count. */
export function useAccountProspects(key: string | null, scope: "engaged" | "all" = "engaged") {
  return useQuery<JobsAccountProspect[]>({
    queryKey: ["jobs", "account-rollup", "prospects", key, scope],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsAccountProspect[]>>(
        `/api/jobs/account-prospects?key=${encodeURIComponent(key ?? "")}&scope=${scope}`);
      return data.data;
    },
    enabled: Boolean(key),
    staleTime: 30_000,
  });
}

export interface JobsStaff { email: string; name: string }

export function useJobsStaff() {
  return useQuery<JobsStaff[]>({
    queryKey: ["jobs", "staff"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsStaff[]>>("/api/jobs/staff");
      return data.data;
    },
    staleTime: 300_000,
  });
}

/** "avni.nahar@pursuit.org" → "Avni Nahar". Fallback when staff lookup misses. */
export function titleCaseEmail(email: string): string {
  return email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a staff person's display name from an email OR org-user id (UUID).
 * Backed by /api/jobs/staff. Falls back to a title-cased email local-part, and
 * finally to the raw value — so a UUID never leaks to the UI when the person is
 * known. Use for comment authors, task owners, activity actors, etc.
 */
export function useStaffNameResolver(): (idOrEmail: string | null | undefined) => string {
  const { data } = useJobsStaff();
  return useMemo(() => {
    const byEmail = new Map<string, string>();
    (data ?? []).forEach((s) => byEmail.set(s.email.toLowerCase(), s.name || titleCaseEmail(s.email)));
    return (v: string | null | undefined) => {
      if (!v) return "Unknown";
      const hit = byEmail.get(v.toLowerCase());
      if (hit) return hit;
      if (v.includes("@")) return titleCaseEmail(v);
      return v;
    };
  }, [data]);
}

export interface JobsAccountUpdate {
  account: string;
  owner_email?: string;
  status_override?: string;
  notes?: string;
  /** account_key of the investor; "" clears it. */
  investor_account_key?: string;
}

export function useUpdateJobsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: JobsAccountUpdate) => {
      await api.patch("/api/jobs/accounts", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
    },
    onError: () => toast.error("Couldn't save account change"),
  });
}

export interface MetricDrill {
  title: string;
  columns: { key: string; label: string }[];
  rows: (Record<string, string | null> & { _children?: Record<string, string | null>[] })[];
  count: number;
  entity: "deal" | "contact" | "activity" | "company" | "placement" | "salary";
  child_columns: { key: string; label: string }[] | null;
}

export type RoleSegment =
  | "hired_ft" | "hired_contract" | "interviewing"
  | "applied" | "rejected" | "withdrawn" | "other";

export interface JobRole {
  id: string;
  builder: string;
  role_title: string;
  company_name: string;
  salary: number | null;
  stage: string;
  segment: RoleSegment;
}

export interface RolesSummary {
  committed: number;
  hired_ft: number;
  hired_contract: number;
  hired_total: number;
  avg_salary_ft: number | null;
  rows: JobRole[];
}

export interface Placement {
  id: string;
  builder: string;
  role_title: string;
  company_name: string;
  employment_type: string;
  engagement_stage: string | null;
  influenced: boolean | null;
  salary: number | null;
}

export interface PlacementsSummary {
  ft_builders: number;
  any_builders: number;
  influenced_ft: number;
  influenced_any: number;
  committed_ft_roles: number;
  committed_trial_active: number;
  ft_roles_secured: number;
  avg_salary_ft_placed: number | null;
  avg_salary_ft_secured: number | null;
  interviewing: number;
  rows: Placement[];
}

export interface BuilderSegment { value: string; label: string; count: number }
export function useBuilderSegments() {
  return useQuery<{ segments: BuilderSegment[]; total: number }>({
    queryKey: ["jobs", "builder-segments"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<{ segments: BuilderSegment[]; total: number }>>("/api/jobs/builder-segments");
      return data.data;
    },
    staleTime: 5 * 60_000,
  });
}

export interface WeekSummaryPerson {
  email: string;
  name: string | null;
  company: string | null;
  when: string | null;
}
export interface WeekSummaryProgress {
  account: string | null;
  from_stage: string;
  to_stage: string;
  when: string | null;
}
export interface ThisWeekSummary {
  emailed: WeekSummaryPerson[];
  met: WeekSummaryPerson[];
  progressed: WeekSummaryProgress[];
  counts: { emailed: number; met: number; progressed: number };
}

export function useThisWeekSummary() {
  return useQuery<ThisWeekSummary>({
    queryKey: ["jobs", "this-week-summary"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ThisWeekSummary>>("/api/jobs/this-week-summary");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function usePlacements(segment?: string) {
  const seg = segment && segment !== "all" ? segment : undefined;
  return useQuery<PlacementsSummary>({
    queryKey: ["jobs", "placements", seg ?? "all"],
    queryFn: async () => {
      const qs = seg ? `?segment=${encodeURIComponent(seg)}` : "";
      const { data } = await api.get<ApiResponse<PlacementsSummary>>(`/api/jobs/placements${qs}`);
      return data.data;
    },
    staleTime: 30_000,
  });
}

export interface OppPlacement {
  id: string;
  builder: string;
  role_title: string | null;
  company_name: string | null;
  employment_type: string;
  salary?: number | null;
}

export function useOppPlacements(oppId: string | null) {
  return useQuery<OppPlacement[]>({
    queryKey: ["jobs", "opp-placements", oppId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<OppPlacement[]>>(`/api/jobs/opportunities/${oppId}/placements`);
      return data.data;
    },
    enabled: oppId !== null,
    staleTime: 15_000,
  });
}

export function useUnlinkedPlacements(q: string) {
  return useQuery<OppPlacement[]>({
    queryKey: ["jobs", "unlinked-placements", q],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<OppPlacement[]>>(
        `/api/jobs/placements/unlinked${q ? `?q=${encodeURIComponent(q)}` : ""}`
      );
      return data.data;
    },
    staleTime: 15_000,
  });
}

export function useCreatePlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ oppId, ...body }: {
      oppId: string; builder_user_id?: number; builder_name?: string;
      role_title?: string; employment_type?: string; salary?: number;
    }) => {
      const { data } = await api.post<ApiResponse<{ id: string }>>(
        `/api/jobs/opportunities/${oppId}/placements`, body
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-placements", vars.oppId] });
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"]]);
      toast.success("Placement recorded");
    },
    onError: () => toast.error("Failed to record placement"),
  });
}

export function useDeletePlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ placementId }: { placementId: string; oppId?: string }) => {
      await api.delete(`/api/jobs/placements/${placementId}`);
    },
    onSuccess: (_d, vars) => {
      if (vars.oppId) qc.invalidateQueries({ queryKey: ["jobs", "opp-placements", vars.oppId] });
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"], ["jobs", "metric"]]);
      toast.success("Placement deleted");
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Failed to delete placement");
    },
  });
}

export function useLinkPlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ oppId, placementId }: { oppId: string; placementId: string }) => {
      await api.post(`/api/jobs/opportunities/${oppId}/placements/${placementId}/link`);
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-placements", vars.oppId] });
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"], ["jobs", "unlinked-placements"]]);
      toast.success("Placement linked");
    },
    onError: () => toast.error("Failed to link placement"),
  });
}

export function useUpdatePlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, influenced }: { id: string; influenced: boolean | null }) => {
      await api.patch(`/api/jobs/placements/${id}`, { influenced });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "placements"] });
      toast.success("Attribution updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export function useUpdatePlacementSalary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, salary }: { id: string; salary: number }) => {
      await api.patch(`/api/jobs/placements/${id}`, { salary });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "placements"] });
      qc.invalidateQueries({ queryKey: ["jobs", "metric"] });
      toast.success("Salary updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export function useSetActivityRelevance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, override }: { id: string; override: "jobs" | "not_jobs" | null }) => {
      await api.patch(`/api/jobs/activity/${id}/relevance`, { override });
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success(vars.override == null ? "Restored AI verdict" : (vars.override === "jobs" ? "Marked as jobs outreach" : "Marked not jobs"));
    },
    onError: () => toast.error("Update failed"),
  });
}

export function useUpdatePlacementTitle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, role_title }: { id: string; role_title: string }) => {
      await api.patch(`/api/jobs/placements/${id}`, { role_title });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "placements"] });
      qc.invalidateQueries({ queryKey: ["jobs", "metric"] });
      toast.success("Title updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export type FunnelType = "opportunities" | "prospects" | "builders";

export interface FunnelMovement {
  name: string;
  from_label: string;
  to_label: string;
  direction: "advanced" | "regressed";
  flow: "in" | "out";
  when: string | null;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  pct_of_max: number;
  conversion_to_next: number | null;
  /** Share of the PREVIOUS stage's arrivals that reached this one. Same number
   *  as the previous row's `conversion_to_next`, addressed to the row it
   *  describes — which is how the team reads it. */
  conversion_in: number | null;
  /** Same measures over the window of equal length immediately before, for the
   *  two trend columns. Null in snapshot mode (no prior window exists). */
  count_prev: number | null;
  conversion_in_prev: number | null;
  records: Record<string, string | null>[];
  movement: FunnelMovement[];
  advanced_in: number;
  regressed_in: number;
}

export interface FunnelData {
  type: FunnelType;
  /** `period` = counts are records that ENTERED each stage inside the window.
   *  `snapshot` = counts are records currently sitting in each stage. */
  mode: "period" | "snapshot";
  period: { from: string; to: string } | null;
  /** Set only when the selected window came back empty: the most recent movement
   *  of any kind, so the empty state can point at where the data actually is
   *  instead of leaving "nothing happened" and "wrong week" indistinguishable. */
  last_movement_at: string | null;
  stages: FunnelStage[];
  record_columns: { key: string; label: string }[];
}

/** Window for period-flow mode. Omit it to get the all-time snapshot (the Exec
 *  view, which has no period control, relies on that default). */
export interface FunnelPeriod {
  from: string;
  to: string;
}

export function useJobsFunnel(
  ftype: FunnelType,
  dealType?: string,
  segment?: string,
  period?: FunnelPeriod,
) {
  const dt = dealType && dealType !== "all" ? dealType : undefined;
  const seg = segment && segment !== "all" ? segment : undefined;
  // The builders funnel has no stage-entry stamps, so a period would silently
  // return zeros — the backend ignores it, and we keep it out of the key too.
  const p0 = ftype === "builders" ? undefined : period;
  return useQuery<FunnelData>({
    queryKey: ["jobs", "funnel", ftype, dt ?? "all", seg ?? "all", p0?.from ?? "", p0?.to ?? ""],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (dt) p.set("deal_type", dt);
      if (seg) p.set("segment", seg);
      if (p0?.from && p0?.to) {
        p.set("period_from", p0.from);
        p.set("period_to", p0.to);
      }
      const qs = p.toString() ? `?${p}` : "";
      const { data } = await api.get<ApiResponse<FunnelData>>(`/api/jobs/funnel/${ftype}${qs}`);
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useJobRoles() {
  return useQuery<RolesSummary>({
    queryKey: ["jobs", "roles"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<RolesSummary>>("/api/jobs/roles");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useMetricDrill(metricKey: string | null) {
  return useQuery<MetricDrill>({
    queryKey: ["jobs", "metric", metricKey],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<MetricDrill>>(`/api/jobs/metrics/${metricKey}`);
      return data.data;
    },
    enabled: metricKey !== null,
    staleTime: 30_000,
  });
}

export function useContactsSummary() {
  return useQuery<ContactsSummary>({
    queryKey: ["jobs", "contacts-summary"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactsSummary>>("/api/jobs/contacts/summary");
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface ActivityTrendBucket {
  period: string;
  new: number;
  existing: number;
}
export type OutreachChannel = "all" | "email" | "meeting";
export interface ActivityTrends {
  granularity: "day" | "week" | "month";
  channel: OutreachChannel;
  buckets: ActivityTrendBucket[];
  totals: { new: number; existing: number; touches: number };
  coverage_note: string | null;
}

export type OutreachScope = OutreachScopeKind;

export interface OutreachRange { from: string; to: string }

export function useActivityTrends(granularity: "day" | "week" | "month", channel: OutreachChannel, owner?: string, scope: OutreachScope = "team", range?: OutreachRange) {
  const rangeKey = range ? `${range.from}..${range.to}` : "";
  return useQuery<ActivityTrends>({
    queryKey: ["jobs", "activity-trends", granularity, channel, owner ?? scope, rangeKey],
    queryFn: async () => {
      const p = new URLSearchParams({ granularity, channel, scope });
      if (owner) p.set("owner", owner);
      if (range) { p.set("date_from", range.from); p.set("date_to", range.to); }
      const { data } = await api.get<ApiResponse<ActivityTrends>>(`/api/jobs/activity-trends?${p}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Outreach Dashboard scorecard ──────────────────────────────────────────────

export type OutreachGranularity = "day" | "week" | "month";
export type OutreachScopeKind = "pursuit" | "team" | "staff";

/** The core jobs team. Mirrors JOBS_TEAM_EMAILS in routes/jobs.py — the backend
 *  is the source of truth; this copy exists so client-side tables (the assigned
 *  queue) can honour the same scope toggle the API endpoints do. Keep in sync. */
export const JOBS_TEAM_EMAILS = [
  "avni@pursuit.org",
  "damon.kornhauser@pursuit.org",
  "devika@pursuit.org",
];

/** Does this owner belong to the selected sender scope? */
export function inScope(email: string | null | undefined, scope: OutreachScopeKind): boolean {
  if (scope === "pursuit") return true;
  const e = (email ?? "").toLowerCase();
  const isTeam = JOBS_TEAM_EMAILS.includes(e);
  return scope === "team" ? isTeam : !isTeam;
}
export interface OutreachDateRange { from: string; to: string }

export interface ScorecardCell { warm: number; cold: number; total: number }

/** One row of either scorecard table. `stage` is set for user-pipeline rows,
 *  `metric` for activity-pipeline rows. `target` is null when unconfigured. */
export interface ScorecardRow {
  stage?: string;
  metric?: string;
  tier?: number;   // activity funnel tier: 1 = sent, 2 = engaged, 3 = replied
  label: string;
  this_period: ScorecardCell;
  last_period: ScorecardCell;
  target: number | null;
}

export interface ScorecardPeriod {
  this_start: string; this_end: string; last_start: string; last_end: string;
}
export interface BySenderRow {
  staff: string;
  sent: { this: number; last: number };
  warm: number;
  cold: number;
}

export interface TouchDepthContact {
  contact_id: number;
  name: string | null;
  company: string | null;
  owner: string | null;
  touches: number;
  last_touch_at: string | null;
}
export interface TouchDepthBucket {
  key: string;
  label: string;
  count: number;
  pct: number;
  contacts: TouchDepthContact[];
  /** Members beyond the response cap, so the panel can say what it's hiding. */
  truncated: number;
}
/** Follow-up depth for the contacts that entered initial outreach this period.
 *  `undated` = contacts whose stage entry has no timestamp, so no period can
 *  claim them (the stage-history grant fills most of these in). */
export interface TouchDepth {
  /** Every contact in the cohort — the denominator for `pct`. */
  total: number;
  undated: number;
  /** Length of the touch-counting window, in weeks. */
  weeks: number;
  /** The window itself (YYYY-MM-DD), ending with the selected period. */
  touch_from: string;
  touch_to: string;
  buckets: TouchDepthBucket[];
}

export interface OutreachScorecard {
  granularity: OutreachGranularity;
  scope: OutreachScopeKind;
  period: ScorecardPeriod;
  user_pipeline: ScorecardRow[];
  activity_pipeline: ScorecardRow[];
  by_sender: BySenderRow[];
  touch_depth?: TouchDepth;
}

function outreachParams(granularity: OutreachGranularity, scope: OutreachScopeKind, owner?: string, range?: OutreachDateRange) {
  const p = new URLSearchParams({ granularity, scope });
  if (owner) p.set("owner", owner);
  if (range) { p.set("date_from", range.from); p.set("date_to", range.to); }
  return p;
}

export function useOutreachScorecard(granularity: OutreachGranularity, scope: OutreachScopeKind, owner?: string, range?: OutreachDateRange) {
  const rangeKey = range ? `${range.from}..${range.to}` : "";
  return useQuery<OutreachScorecard>({
    queryKey: ["jobs", "outreach-scorecard", granularity, scope, owner ?? "", rangeKey],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<OutreachScorecard>>(
        `/api/jobs/outreach/scorecard?${outreachParams(granularity, scope, owner, range)}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface TargetingBucket { bucket: string; sent: number; responses: number }
export interface TargetingDim { key: string; label: string; rows: TargetingBucket[] }

/** Targeting Mix — outreach volume + replies cut by lead source / industry / size / stage. */
export function useOutreachTargetingMix(granularity: OutreachGranularity, scope: OutreachScopeKind, owner?: string, range?: OutreachDateRange) {
  const rangeKey = range ? `${range.from}..${range.to}` : "";
  return useQuery<{ dims: TargetingDim[] }>({
    queryKey: ["jobs", "outreach-targeting", granularity, scope, owner ?? "", rangeKey],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<{ dims: TargetingDim[] }>>(
        `/api/jobs/outreach/targeting-mix?${outreachParams(granularity, scope, owner, range)}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface OutreachAccountComment { author: string | null; content: string; date: string | null }
export interface OutreachAccountTask { title: string; status: string; deadline: string | null; owner: string | null }
export interface OutreachAccountContact { name: string | null; title: string | null }
export interface OutreachAccount {
  account: string;
  owner: string | null;
  last_activity: string | null;
  comment_count: number;
  open_task_count: number;
  contact_count: number;
  comments: OutreachAccountComment[];
  open_tasks: OutreachAccountTask[];
  contacts: OutreachAccountContact[];
}

/** Account working list — accounts with comments/open tasks for the deep-dive discussion.
 *  With `owner`, restricts to accounts that staffer is involved with. */
export function useOutreachAccounts(owner?: string) {
  return useQuery<{ accounts: OutreachAccount[] }>({
    queryKey: ["jobs", "outreach-accounts", owner ?? ""],
    queryFn: async () => {
      const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
      const { data } = await api.get<ApiResponse<{ accounts: OutreachAccount[] }>>(`/api/jobs/outreach/accounts${qs}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface OutreachDrillTouch {
  date: string | null;
  type: string;
  subject: string | null;
  snippet: string | null;
  direction: string;
  /** Bare lowercase email of the Pursuit person behind the touch — the sender
   *  when we sent it, the recipient when the contact replied. Resolve through
   *  the staff name map. */
  actor: string | null;
}
export interface OutreachDrillContact {
  contact_id: number;
  name: string | null;
  company: string | null;
  entered_at: string | null;
  touches: OutreachDrillTouch[];
  /** Distinct actors across this contact's touches, for the collapsed row. */
  actors?: string[];
}
export interface OutreachDrill {
  kind: "user" | "activity";
  key: string;
  period: "this" | "last";
  count: number;
  contacts: OutreachDrillContact[];
}

/** Drill-down behind one scorecard row. `enabled` false until the row is expanded. */
export function useOutreachDrill(
  args: { kind: "user" | "activity"; key: string; period: "this" | "last";
          granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange } | null,
) {
  const rangeKey = args?.range ? `${args.range.from}..${args.range.to}` : "";
  return useQuery<OutreachDrill>({
    enabled: !!args,
    queryKey: ["jobs", "outreach-drill", args?.kind, args?.key, args?.period, args?.granularity, args?.scope, args?.owner ?? "", rangeKey],
    queryFn: async () => {
      const p = outreachParams(args!.granularity, args!.scope, args!.owner, args!.range);
      p.set("kind", args!.kind); p.set("key", args!.key); p.set("period", args!.period);
      const { data } = await api.get<ApiResponse<OutreachDrill>>(`/api/jobs/outreach/scorecard/detail?${p}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface OutreachTouch { activity_id: string; contact_id: number | null; contact: string | null; subject: string | null; channel: string; date: string | null }
export interface OutreachAccountDetail { account: string; touches: OutreachTouch[] }
export interface ActivityTrendDetail { period: string; accounts: OutreachAccountDetail[]; total_touches: number; total_accounts: number }

/** Drill-down for a clicked outreach bar. `period` null = disabled (no fetch). */
export function useActivityTrendDetail(period: string | null, granularity: "day" | "week" | "month", channel: OutreachChannel, owner?: string, scope: OutreachScope = "team") {
  return useQuery<ActivityTrendDetail>({
    enabled: !!period,
    queryKey: ["jobs", "activity-trend-detail", period, granularity, channel, owner ?? scope],
    queryFn: async () => {
      const p = new URLSearchParams({ period: period!, granularity, channel, scope });
      if (owner) p.set("owner", owner);
      const { data } = await api.get<ApiResponse<ActivityTrendDetail>>(`/api/jobs/activity-trends/detail?${p}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

export function useJobsPipeline() {
  return useQuery<PipelineStageSummary[]>({
    queryKey: ["jobs", "pipeline"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<PipelineStageSummary[]>>("/api/jobs/opportunities/pipeline");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useJobsOpportunities(filters: OpportunityFilters = {}) {
  const params = new URLSearchParams();
  if (filters.stage)       params.set("stage",       filters.stage);
  if (filters.stage_group) params.set("stage_group",  filters.stage_group);
  if (filters.owner_email) params.set("owner_email",  filters.owner_email);
  if (filters.account_id)  params.set("account_id",   filters.account_id);
  if (filters.deal_type)   params.set("deal_type",    filters.deal_type);
  params.set("limit",  String(filters.limit  ?? 200));
  params.set("offset", String(filters.offset ?? 0));

  return useQuery<{ data: JobsOpportunity[]; total: number }>({
    queryKey: ["jobs", "opportunities", filters],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await api.get<ListResponse<JobsOpportunity>>(`/api/jobs/opportunities?${params}`);
      return { data: data.data, total: data.total };
    },
    staleTime: 30_000,
  });
}

export function useJobsOpportunity(id: string | null) {
  return useQuery<JobsOpportunityDetail>({
    queryKey: ["jobs", "opportunity", id],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsOpportunityDetail>>(`/api/jobs/opportunities/${id}`);
      return data.data;
    },
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useUpdateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; [k: string]: unknown }) => {
      const { data } = await api.patch<ApiResponse<JobsOpportunity>>(`/api/jobs/opportunities/${id}`, body);
      return { updated: data.data, changedStage: "stage" in body };
    },
    onSuccess: ({ updated, changedStage }) => {
      // a stage/contact change ripples into placements + contacts too
      invalidateOppDependents(qc, [
        ["jobs", "placements"], ["jobs", "contacts"],
        ["jobs", "contacts-by-account"], ["jobs", "contacts-summary"],
      ]);
      // Only announce the stage when the stage was the field that changed —
      // otherwise (owner, salary, # roles, …) a plain "Updated" is honest.
      toast.success(
        changedStage ? `Stage → ${STAGE_LABELS[updated.stage] ?? updated.stage}` : "Updated",
      );
    },
    onError: () => toast.error("Update failed"),
  });
}

export function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<JobsOpportunity>) => {
      const { data } = await api.post<ApiResponse<JobsOpportunity>>("/api/jobs/opportunities", body);
      return data.data;
    },
    onSuccess: () => {
      // new opp can flip linked contacts to is_jobs_contact → refresh contacts
      invalidateOppDependents(qc, [
        ["jobs", "contacts"], ["jobs", "contacts-by-account"], ["jobs", "contacts-summary"],
      ]);
      toast.success("Deal created");
    },
    onError: () => toast.error("Failed to create deal"),
  });
}

export interface ContactCreateBody {
  full_name: string;
  email?: string;
  current_title?: string;
  current_company?: string;
  contact_stage?: string;
  linkedin_url?: string;
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ContactCreateBody) => {
      const { data } = await api.post<ApiResponse<JobContact>>("/api/jobs/contacts", body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success("Contact created");
    },
    // Surface the server's reason (e.g. the 409 duplicate naming the existing
    // contact) — a generic toast hid the cause through all of TKT-135.
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Failed to create contact");
    },
  });
}

export function useDeleteActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (activityId: string) => {
      await api.delete(`/api/jobs/activity/${activityId}`);
    },
    onSuccess: () => {
      invalidateOppDependents(qc, [["jobs", "contact"], ["jobs", "metric"]]);
      toast.success("Activity deleted");
    },
    onError: () => toast.error("Delete failed"),
  });
}

export interface Staff { email: string; name: string }

export function useStaff(q?: string) {
  return useQuery<Staff[]>({
    queryKey: ["jobs", "staff", q ?? ""],
    queryFn: async () => {
      const params = q ? `?q=${encodeURIComponent(q)}` : "";
      const { data } = await api.get<ApiResponse<Staff[]>>(`/api/jobs/staff${params}`);
      return data.data;
    },
    staleTime: 300_000,
  });
}

export interface Builder { user_id: number; email: string; name: string; cohort: string }

export function useBulkProspect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { contact_ids: number[]; value: boolean }) => {
      const { data } = await api.post<ApiResponse<{ updated: number }>>("/api/jobs/contacts/bulk-prospect", body);
      return data.data;
    },
    onSuccess: (d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success(`${vars.value ? "Added" : "Removed"} ${d?.updated ?? 0} ${(d?.updated ?? 0) === 1 ? "prospect" : "prospects"}`);
    },
    onError: () => toast.error("Failed to update prospects"),
  });
}

export interface ContactTag { slug: string; label: string; sort_order: number }

/** Curated contact-tag vocabulary (bedrock.contact_tag_catalog) — drives the
 *  tags picker and filter. sort_order is the campaign priority. */
export function useContactTagCatalog() {
  return useQuery<ContactTag[]>({
    queryKey: ["jobs", "contact-tags"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactTag[]>>("/api/jobs/contact-tags");
      return data.data;
    },
    staleTime: 300_000,
  });
}

export interface TagCampaign {
  key: string; label: string; slugs: string[]; sort_order: number;
  contacts: number; accounts: number; in_pipeline: number;
  owner_email: string | null;
  funnel: { not_yet: number; assigned: number; contacted: number; converted: number; on_hold: number };
}

/** Tags as prioritizable outreach campaigns (Performance) — counts + order. */
export function useTagCampaigns() {
  return useQuery<TagCampaign[]>({
    queryKey: ["jobs", "tag-campaigns"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<TagCampaign[]>>("/api/jobs/tag-campaigns");
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface TagCampaignContact {
  contact_id: number;
  full_name: string | null;
  company: string | null;
  stage: string | null;
  stage_entered_at: string | null;
  owner: string | null;
  touches: number;
  last_touch: string | null;
}
export interface TagCampaignAccount { company: string; contacts: number; contacted: number }

/** The contacts and accounts behind a campaign's counts. Same slug set and
 *  jobs-prospect gate as /tag-campaigns, so the drills tie to the numbers. */
export function useTagCampaignRecords(key: string | null) {
  return useQuery<{ contacts: TagCampaignContact[]; accounts: TagCampaignAccount[] }>({
    queryKey: ["jobs", "tag-campaign-records", key ?? ""],
    enabled: !!key,
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<{ contacts: TagCampaignContact[]; accounts: TagCampaignAccount[] }>>(
        `/api/jobs/tag-campaigns/${encodeURIComponent(key as string)}/records`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

export function useSetTagCampaignOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (order: string[]) => {
      const { data } = await api.put<ApiResponse<{ updated: number }>>("/api/jobs/tag-campaigns/order", { order });
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "tag-campaigns"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contact-tags"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success("Priority saved");
    },
    onError: () => toast.error("Couldn't save priority"),
  });
}

export function useSetCampaignOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { key: string; owner_email: string | null }) => {
      const { data } = await api.put<ApiResponse<{ key: string }>>("/api/jobs/tag-campaigns/owner", body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "tag-campaigns"] });
      toast.success("Campaign owner saved");
    },
    onError: () => toast.error("Couldn't save owner"),
  });
}

export function useAddContactToJobs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, add }: { id: number; add: boolean }) => {
      if (add) {
        await api.post(`/api/jobs/contacts/${id}/add-to-jobs`);
      } else {
        await api.delete(`/api/jobs/contacts/${id}/add-to-jobs`);
      }
    },
    onSuccess: (_, { add }) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success(add ? "Added to Jobs pipeline" : "Removed from Jobs pipeline");
    },
    onError: () => toast.error("Failed to update contact"),
  });
}

export function useBuilders(search?: string) {
  return useQuery<Builder[]>({
    queryKey: ["jobs", "builders", search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : "";
      const { data } = await api.get<ApiResponse<Builder[]>>(`/api/jobs/builders${params}`);
      return data.data;
    },
    staleTime: 300_000,
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: number; [k: string]: unknown }) => {
      const { data } = await api.patch<ApiResponse<JobContact>>(`/api/jobs/contacts/${id}`, body);
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contact", vars.id] });
      toast.success("Contact updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

// ── Email-review candidates (Home page queue) ─────────────────────────────────
export interface JobCandidate {
  contact_id: number;
  full_name: string | null;
  email: string;
  current_company: string | null;
  current_title: string | null;
  domain?: string | null;
  suggested_account?: string | null;
  ai_name?: string | null;
  ai_company?: string | null;
  ai_confidence?: "high" | "medium" | "low" | null;
  is_employer_contact?: boolean | null;
  dup_count?: number;
  top_dup_id?: number | null;
  top_dup_company?: string | null;
  top_dup_title?: string | null;
  dup_match_count?: number;
  account_linked?: boolean;
  enriched?: boolean;
  email_count: number;
  owners?: string[];
  channels?: string[];
  tier?: string | null;
  last_email: string | null;
  last_subject: string | null;
}
export interface DuplicateContact { contact_id: number; full_name: string | null; current_company: string | null; current_title: string | null }

export interface AccountSuggestion {
  account_key: string | null;
  account_name: string | null;
  sf_account_id: string | null;
  confidence: "high" | "medium" | "low";
  in_pipeline: boolean;
  reason: string;
}
export interface CandidateEmail {
  id: string;
  subject: string | null;
  email_from: string | null;
  email_to: string[] | null;
  snippet: string | null;
  body: string | null;
  type: string | null;
  source: string | null;
  activity_date: string | null;
}
export interface CandidateDetail {
  contact: { contact_id: number; full_name: string | null; email: string; current_company: string | null; current_title: string | null; linkedin_url: string | null };
  enrichment: CandidateEnrichment | null;
  suggested_account: AccountSuggestion | null;
  possible_duplicates: DuplicateContact[];
  emails: CandidateEmail[];
}
export interface CandidateEnrichment {
  full_name?: string | null;
  title?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
  is_employer_contact?: boolean;
  confidence?: "high" | "medium" | "low";
  reasoning?: string;
  possible_duplicates?: { contact_id: number; full_name: string | null; current_company: string | null; current_title: string | null }[];
  error?: string;
}

export function useCandidates(owner?: string, status: "candidate" | "dismissed" = "candidate") {
  return useQuery({
    queryKey: ["jobs", "candidates", owner ?? "all", status],
    queryFn: async (): Promise<JobCandidate[]> => {
      const { data } = await api.get<ApiResponse<JobCandidate[]>>("/api/jobs/candidates", {
        params: { ...(owner ? { owner } : {}), status },
      });
      return data.data ?? [];
    },
    staleTime: 30_000,
  });
}

export interface NetworkConnection {
  contact_id: number; full_name: string | null; current_title: string | null;
  current_company: string | null; email: string | null; linkedin_url: string | null;
  is_jobs_contact: boolean; relationship_strength: string | null;
  connected_date: string | null;
  activity_count: number; last_activity: string | null; last_channel: string | null;
  my_activity_count: number; my_last_activity: string | null;
  warm: boolean;      // this staff member has touched their connection
  touched: boolean;   // anyone at Pursuit has activity with them
  co_connections: number; company_hired_before: boolean; has_open_opp: boolean;
  status: string; status_reason: string | null;
}
export interface MyNetwork { mapped: boolean; total: number; connections: NetworkConnection[]; message?: string }
export function useMyNetwork(q?: string) {
  return useQuery<MyNetwork>({
    queryKey: ["jobs", "my-network", q ?? ""],
    queryFn: async () => {
      // limit=2000 (server max) — the default 500 silently hid connections for
      // anyone with a bigger network ("total 647, loaded 500").
      const { data } = await api.get<ApiResponse<MyNetwork>>("/api/jobs/my-network", { params: { limit: 2000, ...(q ? { q } : {}) } });
      return data.data;
    },
    staleTime: 60_000,
  });
}

export function useSetConnectionStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { contact_id: number; status: string; reason?: string; note?: string }) => {
      const { data } = await api.patch<ApiResponse<unknown>>("/api/jobs/my-network/status", body);
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs", "my-network"] }),
  });
}

// ── Intro requests (staff→staff asks + Sputnik builder asks surfaced) ────────
export interface IntroRequest {
  id: string;
  source: "staff" | "builder";
  contact_id: number; contact_name: string | null;
  contact_company: string | null; contact_title: string | null;
  connector_staff_id: number; connector_name: string | null; connector_email: string | null;
  requested_by: string | null; requested_by_name?: string | null;
  specific_ask: string | null; context: string | null;
  status: string; response_note: string | null;
  responded_at: string | null; created_at: string | null;
}
export function useIntroRequests(box: "inbox" | "sent" | "all" = "inbox", includeClosed = false) {
  return useQuery<IntroRequest[]>({
    queryKey: ["jobs", "intro-requests", box, includeClosed],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<IntroRequest[]>>("/api/jobs/intro-requests", {
        params: { box, include_closed: includeClosed },
      });
      return data.data ?? [];
    },
    staleTime: 30_000,
  });
}
export interface ContactConnector {
  staff_user_id: number; display_name: string | null; email: string;
  connected_date: string | null; has_pending_request: boolean;
}
export function useContactConnectors(contactId: number | null) {
  return useQuery<ContactConnector[]>({
    queryKey: ["jobs", "contact-connectors", contactId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactConnector[]>>(`/api/jobs/contacts/${contactId}/connectors`);
      return data.data ?? [];
    },
    enabled: contactId != null,
    staleTime: 60_000,
  });
}
export function useCreateIntroRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { contact_id: number; connector_staff_id: number; specific_ask?: string; context?: string }) => {
      const { data } = await api.post<ApiResponse<{ id: string }>>("/api/jobs/intro-requests", body);
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "intro-requests"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contact-connectors", vars.contact_id] });
      toast.success("Intro request sent");
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Failed to send intro request");
    },
  });
}
export function useRespondIntroRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { id: string; status: string; response_note?: string; source: "staff" | "builder" }) => {
      const { id, ...rest } = body;
      const { data } = await api.patch<ApiResponse<unknown>>(`/api/jobs/intro-requests/${id}`, rest);
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs", "intro-requests"] }),
    onError: () => toast.error("Failed to update intro request"),
  });
}

export interface CandidateOwner { owner: string; count: number }
export function useCandidateOwners() {
  return useQuery({
    queryKey: ["jobs", "candidate-owners"],
    queryFn: async (): Promise<CandidateOwner[]> => {
      const { data } = await api.get<ApiResponse<CandidateOwner[]>>("/api/jobs/candidates/owners");
      return data.data ?? [];
    },
    staleTime: 60_000,
  });
}

export function useCandidateDetail(contactId: number | null) {
  return useQuery({
    queryKey: ["jobs", "candidate", contactId],
    queryFn: async (): Promise<CandidateDetail> => {
      const { data } = await api.get<ApiResponse<CandidateDetail>>(`/api/jobs/candidates/${contactId}`);
      return data.data;
    },
    enabled: contactId != null,
  });
}

/** Force a fresh AI enrichment pass (persisted). Normally pre-computed in batch. */
export function useEnrichCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: number) => {
      const { data } = await api.post<ApiResponse<unknown>>(`/api/jobs/candidates/${contactId}/enrich`, {});
      return data.data;
    },
    onSuccess: (_d, contactId) => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidate", contactId] });
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
    },
  });
}

export interface SfContactMatch {
  sf_contact_id: string;
  name: string | null;
  title: string | null;
  account_id: string | null;
  account_name: string | null;
}

/** Look this candidate's email up in Salesforce (Email/Home/Work). */
export function useCandidateSfMatch(contactId: number | null) {
  return useQuery({
    queryKey: ["jobs", "candidate-sf", contactId],
    queryFn: async (): Promise<{ match: SfContactMatch | null; error?: string }> => {
      const { data } = await api.get<ApiResponse<{ match: SfContactMatch | null; error?: string }>>(`/api/jobs/candidates/${contactId}/sf-match`);
      return data.data;
    },
    enabled: contactId != null,
    retry: false,
  });
}

/** Approve a Salesforce match: import the SF contact to the pipeline + link. */
export function useLinkCandidateSf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, match }: { id: number; match: SfContactMatch }) => {
      const { data } = await api.post<ApiResponse<unknown>>(`/api/jobs/candidates/${id}/link-sf`, {
        sf_contact_id: match.sf_contact_id, name: match.name, account_name: match.account_name,
        account_id: match.account_id, title: match.title,
      });
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success("Linked to Salesforce contact + added to pipeline");
    },
    onError: () => toast.error("Link failed"),
  });
}

/** Approve a duplicate match: re-point this candidate's emails onto an existing
 *  contact and retire the candidate (one-click merge). */
export function useLinkCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, target }: { id: number; target: number }) => {
      const { data } = await api.post<ApiResponse<unknown>>(`/api/jobs/candidates/${id}/link`, { target_contact_id: target });
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success("Linked to existing contact");
    },
    onError: () => toast.error("Link failed"),
  });
}

export function usePromoteCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: number; full_name?: string; current_company?: string; current_title?: string; contact_stage?: string }) => {
      const { data } = await api.post<ApiResponse<unknown>>(`/api/jobs/candidates/${id}/promote`, body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success("Added to pipeline");
    },
    onError: () => toast.error("Promote failed"),
  });
}

export function useDismissCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => { await api.post(`/api/jobs/candidates/${id}/dismiss`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      toast.success("Dismissed");
    },
    onError: () => toast.error("Dismiss failed"),
  });
}

export function useBulkDismissCandidates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactIds: number[]) => {
      const { data } = await api.post<ApiResponse<{ dismissed: number }>>(
        "/api/jobs/candidates/bulk-dismiss", { contact_ids: contactIds });
      return data.data;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      qc.invalidateQueries({ queryKey: ["jobs", "candidate-owners"] });
      toast.success(`Dismissed ${d?.dismissed ?? 0}`);
    },
    onError: () => toast.error("Bulk dismiss failed"),
  });
}

export function useMergeContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ canonicalId, loserIds }: { canonicalId: number; loserIds: number[] }) => {
      const { data } = await api.post<ApiResponse<{ merged: number }>>(
        "/api/jobs/contacts/merge", { canonical_id: canonicalId, loser_ids: loserIds });
      return data.data;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success(`Merged ${d?.merged ?? 0} duplicate${(d?.merged ?? 0) === 1 ? "" : "s"}`);
    },
    onError: () => toast.error("Merge failed"),
  });
}

export function useSetCandidateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, company }: { id: number; company: string }) => {
      const { data } = await api.post<ApiResponse<{ matched: boolean }>>(
        `/api/jobs/candidates/${id}/set-account`, { company });
      return data.data;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      toast.success(d?.matched ? "Account linked" : "Company set (no existing account matched)");
    },
    onError: () => toast.error("Couldn't link account"),
  });
}

export function useBulkRestoreCandidates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactIds: number[]) => {
      const { data } = await api.post<ApiResponse<{ restored: number }>>(
        "/api/jobs/candidates/bulk-restore", { contact_ids: contactIds });
      return data.data;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      qc.invalidateQueries({ queryKey: ["jobs", "candidate-owners"] });
      toast.success(`Restored ${d?.restored ?? 0}`);
    },
    onError: () => toast.error("Restore failed"),
  });
}

export interface ActivityCreateBody {
  jobs_opportunity_id: string;
  type: "call" | "text" | "linkedin";
  description: string;
  activity_date?: string;
  subject?: string;
}

export function useLogActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ActivityCreateBody) => {
      const { data } = await api.post<ApiResponse<ActivityEntry>>("/api/jobs/activity", body);
      return data.data;
    },
    onSuccess: () => {
      invalidateOppDependents(qc, [["jobs", "contact"], ["jobs", "metric"]]);
      toast.success("Activity logged");
    },
    onError: () => toast.error("Failed to log activity"),
  });
}

export function useDeleteOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/jobs/opportunities/${id}`);
    },
    onSuccess: () => {
      invalidateOppDependents(qc, [["jobs", "placements"]]);
      toast.success("Deal removed");
    },
  });
}

// ── Builders tab ──────────────────────────────────────────────────────────────

export type BuilderStatus =
  | "not_started" | "actively_applying" | "interviewing" | "placed" | "paused";

export const BUILDER_STATUS_ORDER: BuilderStatus[] = [
  "actively_applying", "interviewing", "placed", "paused", "not_started",
];

export const BUILDER_STATUS_LABELS: Record<BuilderStatus, string> = {
  not_started: "Not Started",
  actively_applying: "Actively Applying",
  interviewing: "Interviewing",
  placed: "Placed",
  paused: "Paused",
};

export const BUILDER_STATUS_STYLES: Record<BuilderStatus, string> = {
  not_started:       "text-ink-3 bg-surface-2",
  actively_applying: "text-[var(--accent)] bg-[var(--accent-soft)]",
  interviewing:      "text-[var(--amber)] bg-[var(--amber-soft)]",
  placed:            "text-[var(--green)] bg-[var(--green-soft)]",
  paused:            "text-ink-3 bg-surface-2",
};

export interface BuilderBoardRow {
  user_id: number;
  name: string | null;
  email: string | null;
  cohort: string | null;
  cohort_completed: boolean;
  status: BuilderStatus;
  status_overridden: boolean;
  coach: string | null;
  counts: { applications: number; interviews: number; placements: number; deal_matches: number };
  readiness: { complete: number; total: number; lookbook: boolean; linkedin: boolean; github: boolean; cv: boolean; mock: boolean };
  prof_strength: string | null;
  technical_strength: string | null;
  has_profile: boolean;
}

export interface BuilderBoard {
  builders: BuilderBoardRow[];
  status_counts: Record<BuilderStatus, number>;
}

export interface BuilderApplication {
  id: number; company_name: string | null; role_title: string | null; stage: string | null;
  date_applied: string | null; salary: string | null; job_url: string | null; response_date: string | null;
}
export interface BuilderPlacement {
  id: number; role_title: string | null; company_name: string | null; employment_type: string | null;
  payment_amount: number | null; engagement_stage: string | null; influenced: boolean | null;
  opportunity_id: string | null; start_date: string | null;
}
export interface BuilderDealMatch {
  id: string; account_name: string | null; stage: JobStage; deal_type: DealType | null; owner_email: string | null;
}
export interface BuilderJobProfile {
  job_search_status: string | null; status_overridden: boolean;
  pursuit_coach: string | null; gen_notes: string | null; coach_notes: string | null;
  coach_flags: string[]; improvement_tags: string[];
  ready_lookbook: boolean; ready_linkedin: boolean; ready_github: boolean; ready_cv: boolean; ready_mock: boolean;
  technical_capability: string | null; ai_reasoning: string | null; problem_solving: string | null;
  presentation: string | null; professional_behaviors: string | null;
  prof_strength: string | null; technical_strength: string | null;
  target_industries: string[]; preferred_modes: string[]; certifications: string[];
  resume_url: string | null; lookbook_url: string | null;
  university: string | null; degree: string | null; graduation_year: number | null; languages: string[];
  applying_regularly: boolean | null; networking_regularly: boolean | null;
  intake: Record<string, unknown> | null;
}
export interface BuilderDetail {
  identity: {
    user_id: number; name: string | null; email: string | null; cohort: string | null;
    cohort_completed: boolean; linkedin_url: string | null; github_url: string | null;
  };
  status: BuilderStatus; status_overridden: boolean; derived_status: BuilderStatus;
  applications: BuilderApplication[];
  placements: BuilderPlacement[];
  deal_matches: BuilderDealMatch[];
  intake_quiz: { question_key: string; response_text: string | null; response_structured: unknown }[];
  enrollment: { current_profile: string | null; onboarding_completed_at: string | null; has_coach: boolean | null } | null;
  learning: { skill_levels: Record<string, number> | null; competencies: unknown; interview_readiness: number | null } | null;
  profile: BuilderJobProfile | null;
}

export function useBuilderBoard() {
  return useQuery<BuilderBoard>({
    queryKey: ["jobs", "builders"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<BuilderBoard>>("/api/jobs/builders/board");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useBuilderDetail(userId: number | null) {
  return useQuery<BuilderDetail>({
    queryKey: ["jobs", "builder", userId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<BuilderDetail>>(`/api/jobs/builders/${userId}`);
      return data.data;
    },
    enabled: userId !== null,
    staleTime: 30_000,
  });
}

export function useUpdateBuilderProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, ...body }: { userId: number; [k: string]: unknown }) => {
      const { data } = await api.patch<ApiResponse<BuilderJobProfile>>(`/api/jobs/builders/${userId}`, body);
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "builders"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder", vars.userId] });
    },
    onError: () => toast.error("Update failed"),
  });
}

// ── Opportunities weekly overview (Thursday pipeline meeting) ────────────────
// Read-only. High-level employer-deal pipeline health. "Time in pipeline" =
// time in the current stage. Backed by /api/jobs/opportunities/overview.

export type OppBreakdownDim = "status" | "deal_type" | "segment" | "stage" | "owner";

export interface OppBreakdownItem { key: string; label: string; count: number }
export interface OppAgingBucket { key: string; label: string; count: number; pct: number }
/** One active-set opportunity with the keys every panel groups by. The aging
 *  bars, set distribution and heatmap cells all drill by filtering this array,
 *  so a drill list can never disagree with the number above it. */
export interface OppActiveSetMember {
  opportunity_id: string;
  account: string | null;
  owner: string | null;
  stage: string;
  stage_label: string;
  priority: number | null;
  /** Index into `heatmaps.buckets` / `aging.buckets` (0 = <2 weeks … 4 = 8+). */
  age_bucket: number;
  days_in_stage: number;
  status: string;
  deal_type: string;
  segment: string;
  owner_key: string;
}

export interface OppHeatRow { key: string; label: string; cells: number[]; total: number }
export interface OppHeatmap { rows: OppHeatRow[]; col_totals: number[]; unset?: number; populated?: boolean }
export interface OppNeedsRow {
  opportunity_id: string;
  account: string | null;
  owner: string | null;
  stage: string;
  stage_label: string;
  days_in_stage: number;
  days_since_activity: number | null;
  why: string;
}

export type OppActivityType = "added" | "moved" | "won" | "lost" | "stalled";

export interface OppActivityEvent {
  type: OppActivityType;
  opportunity_id: string;
  account: string | null;
  deal_type: string | null;
  stage_label: string;
  detail: string;
  at: string | null;
  actor: string | null;
}

export interface OppDrillRow {
  opportunity_id: string;
  account: string | null;
  stage: string;
  stage_label: string;
  owner: string | null;
  at: string | null;
}

export interface OpportunitiesOverview {
  filters: { owner: string | null; deal_type: string | null; week_end: string | null };
  aging_basis: string;
  summary: {
    in_set: number; net_new: number; net_new_prev: number;
    moved_committed: number; closed_lost: number; stalled_6wk: number;
  };
  aging: { buckets: OppAgingBucket[] };
  breakdowns: Record<OppBreakdownDim, OppBreakdownItem[]>;
  heatmaps: {
    buckets: { key: string; label: string }[];
    priority: OppHeatmap;
    stage: OppHeatmap;
  };
  needs_attention: OppNeedsRow[];
  active_set: OppActiveSetMember[];
  /** Rows behind each summary card — same query as the count, so they agree. */
  drills: { in_set: OppDrillRow[]; stalled: OppDrillRow[]; net_new: OppDrillRow[]; won: OppDrillRow[]; lost: OppDrillRow[] };
  recent_activity: OppActivityEvent[];
}

/** `weekEnd`/`start` are inclusive YYYY-MM-DD bounds of the window. Omit `start`
 *  for the server default (a 7-day window back from weekEnd); pass it for any
 *  custom span — the Pipeline page runs Thursday-aligned weeks off it. */
export function useOpportunitiesOverview(owner?: string, dealType?: string, weekEnd?: string, start?: string) {
  const o = owner && owner !== "all" ? owner : undefined;
  const dt = dealType && dealType !== "all" ? dealType : undefined;
  return useQuery<OpportunitiesOverview>({
    queryKey: ["jobs", "opportunities", "overview", o ?? "all", dt ?? "all", weekEnd ?? "current", start ?? "7d"],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (o) p.set("owner", o);
      if (dt) p.set("deal_type", dt);
      if (weekEnd) p.set("week_end", weekEnd);
      if (start) p.set("start", start);
      const qs = p.toString() ? `?${p}` : "";
      const { data } = await api.get<ApiResponse<OpportunitiesOverview>>(`/api/jobs/opportunities/overview${qs}`);
      return data.data;
    },
    staleTime: 30_000,
  });
}

// ── Daily digest (the morning Slack, computed) ───────────────────────────────
export interface DailyDigest {
  date: string;
  outreach: { new_touches: number; existing_touches: number; new_accounts: number; existing_accounts: number; meetings: number };
  submissions: { company: string; builders: number; roles: number }[];
}

export function useDailyDigest(date?: string) {
  return useQuery<DailyDigest>({
    queryKey: ["jobs", "daily-digest", date ?? "yesterday"],
    queryFn: async () => {
      const qs = date ? `?date=${date}` : "";
      const { data } = await api.get<ApiResponse<DailyDigest>>(`/api/jobs/daily-digest${qs}`);
      return data.data;
    },
    staleTime: 300_000,
  });
}

// ── Stuck in initial outreach (replaces the account working list) ─────────────
export interface StuckContact {
  contact_id: number;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  owner_email: string | null;
  touches: number;
  last_touch: string | null;
  first_outreach_at: string | null;
  other_contacts_at_account: number;
}

/** Contacts with N+ touches in initial outreach and no reply — the cue to work
 *  a different contact at that account. */
export function useStuckContacts(minTouches = 3, owner?: string) {
  return useQuery<StuckContact[]>({
    queryKey: ["jobs", "stuck-contacts", minTouches, owner ?? ""],
    queryFn: async () => {
      const p = new URLSearchParams({ min_touches: String(minTouches) });
      if (owner) p.set("owner", owner);
      const { data } = await api.get<ApiResponse<StuckContact[]>>(`/api/jobs/outreach/stuck-contacts?${p}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Responded, awaiting a decision (initial outreach → converted / on hold / not a fit) ──
export interface RespondedContact {
  contact_id: number;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  owner_email: string | null;
  touches: number;
  last_reply: string | null;
  reply_count: number;
  last_reply_from: string | null;
  snippet: string | null;
}

/** Contacts who replied but are still in initial outreach — the owner decides
 *  where they go; nothing moves automatically. */
export function useRespondedContacts(owner?: string) {
  return useQuery<RespondedContact[]>({
    queryKey: ["jobs", "responded-contacts", owner ?? ""],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (owner) p.set("owner", owner);
      const qs = p.toString() ? `?${p}` : "";
      const { data } = await api.get<ApiResponse<RespondedContact[]>>(`/api/jobs/outreach/responded-contacts${qs}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Export ────────────────────────────────────────────────────────────────────

export type ExportEntity = "contacts" | "accounts" | "opportunities";

/** Download an .xlsx of the given rows. Pass ids for a selection; omit for the
 *  whole (server-capped) set. Returns the row count the server wrote.
 *
 *  Uses a blob + object URL rather than navigating: the endpoint is a POST (the
 *  id list can be thousands long, well past a URL), and axios already carries
 *  the auth cookie. */
export async function exportJobsRows(
  entity: ExportEntity,
  ids?: (string | number)[],
): Promise<void> {
  const res = await api.post(`/api/jobs/export/${entity}`,
    { ids: ids?.map(String) },
    { responseType: "blob" });
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bedrock-${entity}-${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download in
  // Safari before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
