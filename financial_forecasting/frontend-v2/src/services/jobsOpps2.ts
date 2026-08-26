import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Invalidate every query family whose data depends on an opportunity's
 * roles/builders/stage — opp list + detail, account rollups, and the pipeline
 * metrics. Replaces a blunt invalidate of the whole ["jobs"] tree (which also
 * refetched contacts, staff, and metric drawers that a role/builder change
 * can't affect). `extra` adds hire-only families (placements, builders).
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
    ["jobs", "metric"],
    ["jobs", "placements"],
    ["jobs", "interview-pipeline"],
    ...extra,
  ];
  for (const queryKey of families) qc.invalidateQueries({ queryKey });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> { success: boolean; data: T }

export type RoleStatus = "open" | "filled" | "cancelled";

export type Commitment = "committed" | "open_market";
export type RatePeriod = "annual" | "monthly" | "weekly" | "daily" | "hourly";

export interface Role {
  id: string;
  opportunity_id: string;
  title: string;
  approx_salary: number | null;
  employment_type: string | null;
  start_date: string | null;
  status: RoleStatus;
  filled_by_user_id: number | null;
  employment_record_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Phase 1 additions
  commitment: Commitment;
  is_trial: boolean;
  converts_to_role_id: string | null;
  pay_rate: number | null;
  rate_period: RatePeriod | null;
  end_date: string | null;
  pay_cadence: string | null;
  benefits: string | null;
  payment_schedule: string | null;
  negotiation_notes: string | null;
  jd_url: string | null;
  // Canonical derived status (server-computed), so every screen agrees.
  placement_status: "ft_placed" | "trial_active" | "committed_open" | "open_market" | "cancelled";
  placement_status_label: string;
  // Pathfinder publishing: is this role shown to builders, and the linked posting.
  pathfinder_visible: boolean;
  job_posting_id: number | null;
}

interface RoleFields {
  approx_salary: number | null;
  employment_type: string | null;
  start_date: string | null;
  notes: string | null;
  commitment: Commitment;
  is_trial: boolean;
  converts_to_role_id: string | null;
  pay_rate: number | null;
  rate_period: RatePeriod | null;
  end_date: string | null;
  pay_cadence: string | null;
  benefits: string | null;
  payment_schedule: string | null;
  negotiation_notes: string | null;
  jd_url: string | null;
  pathfinder_visible: boolean;
}

export type RoleCreateBody = { title: string } & Partial<RoleFields>;

export type RolePatchBody = Partial<{ title: string; status: RoleStatus } & RoleFields>;

export interface RoleHireBody {
  user_id: number;
  salary?: number;
  start_date?: string;
  employment_type?: string;
}

export interface BuilderActivityRow {
  job_application_id: number;
  builder: string;
  company_name: string | null;
  role_title: string | null;
  stage: string | null;
  jobs_role_id: string | null;
  date_applied: string | null;
}

export interface BuilderActivity {
  rows: BuilderActivityRow[];
  summary: { applied: number; interview: number; accepted: number };
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useOppRoles(oppId: string | null) {
  return useQuery<Role[]>({
    queryKey: ["jobs", "opp-roles", oppId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<Role[]>>(`/api/jobs/opportunities/${oppId}/roles`);
      return data.data;
    },
    enabled: Boolean(oppId),
    staleTime: 15_000,
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ oppId, ...body }: { oppId: string } & RoleCreateBody) => {
      const { data } = await api.post<ApiResponse<Role>>(
        `/api/jobs/opportunities/${oppId}/roles`,
        body,
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId] });
      invalidateOppDependents(qc);
      toast.success("Role added");
    },
    onError: (e: unknown) => {
      const resp = (e as { response?: { status?: number; data?: { detail?: { message?: string } | string } } })?.response;
      // 409 = the rapid-duplicate guard; show its actionable message.
      if (resp?.status === 409) {
        const d = resp.data?.detail;
        toast.error(typeof d === "object" && d?.message ? d.message : "That role was just added — set seats instead of re-adding.");
      } else {
        toast.error("Failed to add role");
      }
    },
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId, oppId: _oppId, ...body }: { roleId: string; oppId?: string } & RolePatchBody) => {
      const { data } = await api.patch<ApiResponse<Role>>(`/api/jobs/roles/${roleId}`, body);
      return data.data;
    },
    onSuccess: (updated, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId ?? updated.opportunity_id] });
      // Also used from the Roles board (e.g. closing a dead role) — its
      // status-sort depends on a fresh fetch, not just the opp-roles list.
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      invalidateOppDependents(qc);
      toast.success("Role updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId, oppId: _oppId }: { roleId: string; oppId?: string }) => {
      const { data } = await api.delete<ApiResponse<{ deleted: boolean }>>(`/api/jobs/roles/${roleId}`);
      return data.data;
    },
    onSuccess: (_d, vars) => {
      if (vars.oppId) qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId] });
      invalidateOppDependents(qc);
      toast.success("Role removed");
    },
    onError: () => toast.error("Delete failed"),
  });
}

export interface PlacementSfSync {
  status: "synced" | "needs_info" | "error" | "skipped";
  message?: string;
  created_contact?: boolean;
  created_account?: boolean;
  created_affiliation?: boolean;
}

export function useHireRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId, oppId: _oppId, ...body }: { roleId: string; oppId?: string } & RoleHireBody) => {
      const { data } = await api.post<ApiResponse<{ role: Role; employment_record_id: number; sf_sync?: PlacementSfSync }>>(
        `/api/jobs/roles/${roleId}/hire`,
        body,
      );
      return data.data;
    },
    onSuccess: (result, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId ?? result.role.opportunity_id] });
      // hire also creates an employment_record → refresh placements + builders
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"]]);
      const sync = result.sf_sync;
      if (sync?.status === "synced") {
        const made = [sync.created_contact && "contact", sync.created_account && "account", sync.created_affiliation && "affiliation"].filter(Boolean);
        toast.success(made.length ? `Builder hired — Salesforce ${made.join(" + ")} created` : "Builder hired — already in Salesforce");
      } else if (sync?.status === "needs_info") {
        toast.warning(`Builder hired, but Salesforce needs info: ${sync.message}`);
      } else if (sync?.status === "error" || sync?.status === "skipped") {
        toast.warning("Builder hired — Salesforce sync pending (retry from the placement)");
      } else {
        toast.success("Builder hired");
      }
    },
    onError: () => toast.error("Hire failed"),
  });
}

export function useOppBuilderActivity(oppId: string | null) {
  return useQuery<BuilderActivity>({
    queryKey: ["jobs", "opp-builder-activity", oppId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<BuilderActivity>>(
        `/api/jobs/opportunities/${oppId}/builder-activity`,
      );
      return data.data;
    },
    enabled: Boolean(oppId),
    staleTime: 15_000,
  });
}

export type AppStage = "prospect" | "applied" | "screen" | "oa" | "interview" | "offer" | "accepted" | "rejected" | "withdrawn";

export const APP_STAGE_OPTIONS: { value: AppStage; label: string }[] = [
  { value: "prospect",  label: "Prospect" },
  { value: "applied",   label: "Applied" },
  { value: "screen",    label: "Screen" },
  { value: "oa",        label: "OA" },
  { value: "interview", label: "Interviewing" },
  { value: "offer",     label: "Offer" },
  { value: "accepted",  label: "Hired" },
  { value: "rejected",  label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
];

export interface BuilderActivityCreateBody {
  user_id: number;
  builder_name?: string;
  role_title?: string;
  stage?: AppStage;
  jobs_role_id?: string;
  date_applied?: string;
}

export function useCreateBuilderActivity(oppId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: BuilderActivityCreateBody) => {
      const { data } = await api.post<ApiResponse<{ job_application_id: number }>>(
        `/api/jobs/opportunities/${oppId}/builder-activity`,
        body,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-builder-activity", oppId] });
      invalidateOppDependents(qc);
      toast.success("Builder logged");
    },
    onError: () => toast.error("Failed to log builder"),
  });
}

export function useUpdateBuilderActivity(oppId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ appId, stage }: { appId: number; stage: AppStage }) => {
      await api.patch(`/api/jobs/builder-activity/${appId}`, { stage });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-builder-activity", oppId] });
      // Also used from the Roles board (Pursuit-Supported nested applications,
      // Staff-Sourced, Builder-Sourced) — a stage change there needs those
      // three queues to refetch too, not just the opportunity's own activity log.
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      qc.invalidateQueries({ queryKey: ["jobs", "staff-sourced"] });
      // Same underlying PATCH as useAdvanceBuilderStage (the command-center
      // pipeline board) — keep its cache in sync too so a stage change made
      // from either view shows up immediately in the other.
      qc.invalidateQueries({ queryKey: ["jobs", "interview-pipeline"] });
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"]]);
      toast.success("Status updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

// ── Command-center interview pipeline (confirmed roles + builders, all opps) ───

export interface InterviewPipelineRole {
  id: string;
  title: string | null;
  status: string;
  employment_type: string | null;
  approx_salary: number | null;
  filled_by_user_id: number | null;
  commitment: Commitment | null;
  is_trial: boolean | null;
  placement_status: "ft_placed" | "trial_active" | "committed_open" | "open_market" | "cancelled";
  placement_status_label: string;
}

export interface InterviewPipelineOpp {
  opportunity_id: string;
  account_name: string | null;
  stage: string;
  owner_email: string | null;
  roles: InterviewPipelineRole[];
  builders: BuilderActivityRow[];
  summary: { applied: number; interview: number; accepted: number; open_roles: number };
}

export function useInterviewPipeline() {
  return useQuery<InterviewPipelineOpp[]>({
    queryKey: ["jobs", "interview-pipeline"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<InterviewPipelineOpp[]>>("/api/jobs/interview-pipeline");
      return data.data ?? [];
    },
    staleTime: 30_000,
  });
}

/** Advance a builder's interview stage from the command-center board. */
export function useAdvanceBuilderStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ appId, stage }: { appId: number; stage: AppStage }) => {
      await api.patch(`/api/jobs/builder-activity/${appId}`, { stage });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "interview-pipeline"] });
      // Same underlying PATCH as useUpdateBuilderActivity (Roles board) — keep
      // its caches in sync too so a stage change from either view shows up
      // immediately in the other.
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      qc.invalidateQueries({ queryKey: ["jobs", "staff-sourced"] });
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"]]);
      toast.success("Stage updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

// ── Roles board (Placement > Roles — every role, every account) ────────────────

export interface RolesBoardApplication {
  job_application_id: number;
  builder: string;
  stage: string | null;
  date_applied: string | null;
  updated_at: string | null;
}

export interface RolesBoardRole extends Role {
  account_name: string | null;
  opp_stage: string | null;
  applications: RolesBoardApplication[];
  sort_position: number | null;
}

export function useRolesBoard() {
  return useQuery<RolesBoardRole[]>({
    queryKey: ["jobs", "roles-board"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<RolesBoardRole[]>>("/api/jobs/roles/board");
      return data.data;
    },
    staleTime: 15_000,
  });
}

export interface OpportunitySearchResult {
  id: string;
  account_name: string | null;
  title: string | null;
  stage: string;
}

/** Opportunity picker for the Roles board's Add Role flow. */
export function useSearchOpportunities(q: string) {
  return useQuery<OpportunitySearchResult[]>({
    queryKey: ["jobs", "opportunity-search", q.trim().toLowerCase()],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<OpportunitySearchResult[]>>(
        `/api/jobs/opportunities/search?q=${encodeURIComponent(q.trim())}`,
      );
      return data.data;
    },
    enabled: q.trim().length >= 2,
    staleTime: 15_000,
  });
}

export interface RoleApplicationCreateBody {
  user_id: number;
  builder_name?: string;
  stage?: AppStage;
  date_applied?: string;
}

/** Log a builder application directly against a role from the Roles board
 *  (rather than needing to open the parent opportunity first). */
export function useCreateRoleApplication(roleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RoleApplicationCreateBody) => {
      const { data } = await api.post<ApiResponse<{ job_application_id: number }>>(
        `/api/jobs/roles/${roleId}/applications`,
        body,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      // Also used from the Builder-Sourced column (a role flagged builder-sourced
      // isn't on roles-board at all) — without this, a newly-logged application
      // against a builder-sourced role never shows up until an unrelated refetch.
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      invalidateOppDependents(qc);
      toast.success("Application logged");
    },
    onError: () => toast.error("Failed to log application"),
  });
}

export interface UnmatchedApplication {
  /** Null for a builder-sourced role flagged before anyone has applied to it —
   *  the row still needs to render (with just an Unmark action), it just has
   *  no application to link a key/dismiss/confirm action to. */
  job_application_id: number | null;
  builder: string | null;
  company_name: string | null;
  role_title: string | null;
  date_applied: string | null;
  updated_at: string | null;
  stage: string | null;
  /** Set only for Builder-Sourced rows backed by a role explicitly flagged
   *  via useMarkRoleBuilderSourced — lets the row offer "Unmark" instead of
   *  "Create opportunity" (there's already a role, just misclassified). */
  jobs_role_id?: string | null;
  /** Set when this application's company already has an open Bedrock role —
   *  lets the row offer "Confirm match" instead of "Create opportunity",
   *  avoiding a duplicate opportunity for a company Pursuit already has. */
  suggested_match?: {
    jobs_role_id: string;
    role_title: string | null;
    account_name: string | null;
    confidence: "exact" | "normalized";
  } | null;
}

/** Builder-Sourced column: recent applications not linked to a Bedrock role
 *  AND not staff/Pursuit-logged (source_type), plus roles explicitly flagged
 *  via useMarkRoleBuilderSourced. Interview-or-further rows come back first
 *  (see backend ordering). Replaces the old separate match-suggestions
 *  banners — matching is now folded directly into this endpoint. */
export function useBuilderSourcedApplications(days = 30) {
  return useQuery<UnmatchedApplication[]>({
    queryKey: ["jobs", "builder-sourced", days],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<UnmatchedApplication[]>>(
        `/api/jobs/job-applications/builder-sourced?days=${days}`,
      );
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useConfirmMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ appId, jobsRoleId }: { appId: number; jobsRoleId: string }) => {
      const { data } = await api.post<ApiResponse<{ job_application_id: number; jobs_role_id: string }>>(
        `/api/jobs/job-applications/${appId}/confirm-match`,
        { jobs_role_id: jobsRoleId },
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      // Also used to resolve Staff-Sourced rows (confirm match or create-then-
      // link a role) — without this a resolved row lingers in that queue too.
      qc.invalidateQueries({ queryKey: ["jobs", "staff-sourced"] });
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      invalidateOppDependents(qc);
      toast.success("Match confirmed");
    },
    onError: () => toast.error("Failed to confirm match"),
  });
}

export interface StaffSourcedApplicant {
  job_application_id: number;
  builder: string | null;
  stage: string | null;
  date_applied: string | null;
  updated_at: string | null;
  /** True if this builder already has a different application linked to the
   *  group's suggested_match role — confirming them again would create a
   *  second linked row for the same builder+role, so exclude from bulk-confirm. */
  already_linked: boolean;
}

export interface StaffSourcedGroup {
  company_name: string | null;
  role_title: string | null;
  suggested_match: {
    jobs_role_id: string;
    role_title: string | null;
    account_name: string | null;
    confidence: "exact" | "normalized";
  } | null;
  applications: StaffSourcedApplicant[];
}

/** Staff-Sourced queue: applications staff logged (source_type
 *  'Pursuit_referred' or 'staff_sourced') with no Bedrock role linked yet,
 *  grouped by normalized (company, role_title) — several applicants often
 *  share the same not-yet-formalized role. Same 30-day working-queue window
 *  as Builder-Sourced. */
export function useStaffSourcedApplications(days = 30) {
  return useQuery<StaffSourcedGroup[]>({
    queryKey: ["jobs", "staff-sourced", days],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<StaffSourcedGroup[]>>(
        `/api/jobs/job-applications/staff-sourced?days=${days}`,
      );
      return data.data;
    },
    staleTime: 30_000,
  });
}

/** Reclassify a Staff-Sourced application as builder-sourced (staff assumed
 *  they'd sourced it, but the builder had actually already applied on their
 *  own) — moves it into the Builder-Sourced queue. One-way; no unmark. */
export function useMarkApplicationSelfSourced() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appId: number) => {
      const { data } = await api.post<ApiResponse<{ job_application_id: number }>>(
        `/api/jobs/job-applications/${appId}/mark-self-sourced`,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "staff-sourced"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      toast.success("Moved to Builder-Sourced");
    },
    onError: () => toast.error("Failed to reclassify"),
  });
}

/** Reclassify a Builder-Sourced application as staff-sourced — the mirror of
 *  useMarkApplicationSelfSourced. For manually-logged applications that never
 *  got a source_type set at creation (so they defaulted to Builder-Sourced)
 *  even though staff actually sourced them. One-way; no unmark. */
export function useMarkApplicationStaffSourced() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appId: number) => {
      const { data } = await api.post<ApiResponse<{ job_application_id: number }>>(
        `/api/jobs/job-applications/${appId}/mark-staff-sourced`,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "staff-sourced"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      toast.success("Moved to Staff-Sourced");
    },
    onError: () => toast.error("Failed to reclassify"),
  });
}

/** Persist a manual drag-order for the Roles board (full visible order, top
 *  to bottom) — mirrors useSetTagCampaignOrder's pattern. */
export function useReorderRolesBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (roleIds: string[]) => {
      const { data } = await api.put<ApiResponse<{ updated: number }>>(
        "/api/jobs/roles/board/order",
        { role_ids: roleIds },
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      toast.success("Order saved");
    },
    onError: () => toast.error("Couldn't save order"),
  });
}

/** Flag a role as builder-sourced (jobs_analytics.role_origin) — for a role
 *  that only exists because staff logged a self-found builder's progress
 *  through the app's own UI, with no real Pursuit-company relationship.
 *  Moves it off the Pursuit-Supported board and into Builder-Sourced. */
export function useMarkRoleBuilderSourced() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (roleId: string) => {
      const { data } = await api.post<ApiResponse<{ jobs_role_id: string; origin: string }>>(
        `/api/jobs/roles/${roleId}/mark-builder-sourced`,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      toast.success("Marked as builder-sourced");
    },
    onError: () => toast.error("Failed to mark as builder-sourced"),
  });
}

/** Reverse useMarkRoleBuilderSourced — back to the Pursuit-Supported default. */
export function useUnmarkRoleBuilderSourced() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (roleId: string) => {
      const { data } = await api.delete<ApiResponse<{ jobs_role_id: string; origin: string }>>(
        `/api/jobs/roles/${roleId}/mark-builder-sourced`,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder-sourced"] });
      toast.success("Marked as Pursuit-supported");
    },
    onError: () => toast.error("Failed to unmark"),
  });
}

/** Remove an application from whatever role/opportunity it's linked to —
 *  doesn't delete the row (no DELETE grant on job_applications), just clears
 *  the link. Use to clean up a duplicate application on a role. */
export function useUnlinkApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appId: number) => {
      const { data } = await api.post<ApiResponse<{ job_application_id: number; unlinked: boolean }>>(
        `/api/jobs/job-applications/${appId}/unlink-role`,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "roles-board"] });
      toast.success("Removed from role");
    },
    onError: () => toast.error("Couldn't remove"),
  });
}
