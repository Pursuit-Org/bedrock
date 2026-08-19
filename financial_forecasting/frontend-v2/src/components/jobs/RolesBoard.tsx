import { useEffect, useState } from "react";
import { Plus, X, Check, ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { useBuilders, useCreateOpportunity, STAGES_ORDERED, STAGE_LABELS, type Builder, type JobStage } from "@/services/jobs";
import { NewAccountDialog } from "@/components/jobs/NewAccountDialog";
import {
  useRolesBoard,
  useSearchOpportunities,
  useCreateRole,
  useCreateRoleApplication,
  useBuilderSourcedApplications,
  useStaffSourcedApplications,
  useConfirmMatch,
  useReorderRolesBoard,
  useMarkRoleBuilderSourced,
  useUnmarkRoleBuilderSourced,
  useUnlinkApplication,
  useUpdateBuilderActivity,
  useUpdateRole,
  APP_STAGE_OPTIONS,
  type AppStage,
  type RolesBoardRole,
  type Commitment,
  type UnmatchedApplication,
  type StaffSourcedGroup,
} from "@/services/jobsOpps2";

// ── Shared display helpers (small lookup tables kept local to this board,
//    mirroring the existing convention in OppBuilderActivity.tsx of
//    duplicating *_LABELS locally while importing shared *_OPTIONS) ───────────

const EMPLOYMENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "full_time", label: "Full-Time" },
  { value: "contract", label: "Contract" },
  { value: "freelance", label: "Freelance" },
  { value: "internship", label: "Internship" },
  { value: "pro_bono", label: "Pro Bono" },
];
const EMPLOYMENT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  EMPLOYMENT_TYPE_OPTIONS.map((t) => [t.value, t.label]),
);
function empTypeLabel(t: string | null): string | null {
  if (!t) return null;
  return EMPLOYMENT_TYPE_LABELS[t] ?? t;
}

const PLACEMENT_STATUS_STYLES: Record<string, string> = {
  ft_placed: "bg-green-100 text-green-800",
  trial_active: "bg-indigo-100 text-indigo-800",
  committed_open: "bg-amber-50 text-amber-700",
  open_market: "bg-sky-50 text-sky-700",
  cancelled: "bg-stone-100 text-stone-500",
};

const APP_STAGE_LABELS: Record<string, string> = {
  prospect: "Prospect",
  applied: "Applied",
  screen: "Screen",
  oa: "OA",
  interview: "Interviewing",
  offer: "Offer",
  accepted: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const APP_STAGE_STYLES: Record<string, string> = {
  prospect: "bg-stone-100 text-stone-600",
  applied: "bg-blue-50 text-blue-700",
  screen: "bg-indigo-50 text-indigo-700",
  oa: "bg-purple-50 text-purple-700",
  interview: "bg-amber-50 text-amber-700",
  offer: "bg-teal-50 text-teal-700",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-50 text-red-700",
  withdrawn: "bg-stone-100 text-stone-500",
};

/** Inline stage editor — used anywhere an application's stage badge shows up
 *  on the Roles board (Pursuit-Supported nested applications, Staff-Sourced,
 *  Builder-Sourced), so a status change is a straight select instead of
 *  needing to open the opportunity/activity log first. Colored per stage to
 *  keep the same at-a-glance read as the static badges elsewhere. */
function StageSelect({ appId, stage }: { appId: number; stage: string | null }) {
  const update = useUpdateBuilderActivity("");
  return (
    <select
      value={stage ?? "applied"}
      onChange={(e) => update.mutate({ appId, stage: e.target.value as AppStage })}
      disabled={update.isPending}
      className={cn(
        "rounded-full border-0 px-2 py-0.5 text-[10px] font-medium leading-none focus:outline-none focus:ring-1 focus:ring-accent/40",
        APP_STAGE_STYLES[stage ?? ""] ?? "bg-stone-100 text-stone-500",
      )}
      title="Update status"
    >
      {APP_STAGE_OPTIONS.map((s) => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  );
}

function fmtSalary(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US")}`;
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin text-ink-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Dismissal persistence — banners re-derive their list from server data on
//    every load, so an in-memory-only dismiss reappeared after a refresh ────

const DISMISS_STORAGE_PREFIX = "bedrock-v2:roles-board:dismissed:";

function loadDismissed(key: string): Set<number> {
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_PREFIX + key);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch {
    return new Set();
  }
}

function saveDismissed(key: string, ids: Set<number>) {
  try {
    localStorage.setItem(DISMISS_STORAGE_PREFIX + key, JSON.stringify(Array.from(ids)));
  } catch {}
}

function usePersistedDismissed(key: string) {
  const [dismissed, setDismissed] = useState<Set<number>>(() => loadDismissed(key));
  const dismiss = (id: number) => {
    setDismissed((d) => {
      const next = new Set(d).add(id);
      saveDismissed(key, next);
      return next;
    });
  };
  return [dismissed, dismiss] as const;
}

// ── Builder-sourced column — persistent mirror of segundo-db self-sourced
//    applications, plus any role explicitly flagged via mark-builder-sourced.
//    Each row offers Confirm match (company already has an open role),
//    Create opportunity (it doesn't), or Unmark (already role-linked). ─────

function BuilderSourcedRow({
  a,
  onCreateOpportunity,
  onDismiss,
}: {
  a: UnmatchedApplication;
  onCreateOpportunity: (a: UnmatchedApplication) => void;
  onDismiss: (id: number) => void;
}) {
  const confirm = useConfirmMatch();
  const [expanded, setExpanded] = useState(false);
  const [addingApp, setAddingApp] = useState(false);
  return (
    <li className="flex flex-col px-3 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 items-start justify-between gap-2 text-left"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown size={13} className="shrink-0 text-ink-4" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-ink-4" />
            )}
            <span className="truncate text-[13px] font-medium text-ink">
              {a.builder ?? (a.job_application_id === null ? "No applicants yet" : "Unknown builder")}
            </span>
          </div>
          <span className="truncate pl-[19px] text-[11.5px] text-ink-3">
            {a.role_title} @ {a.company_name}
          </span>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
            APP_STAGE_STYLES[a.stage ?? ""] ?? "bg-stone-100 text-stone-500",
          )}
        >
          {APP_STAGE_LABELS[a.stage ?? ""] ?? a.stage ?? "—"}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 flex flex-col gap-2 pl-[19px]">
          <span className="text-[11.5px] text-ink-4">
            {a.suggested_match ? (
              <>
                → matches <span className="font-medium text-ink-3">{a.suggested_match.role_title}</span> @{" "}
                {a.suggested_match.account_name} ·{" "}
                {a.suggested_match.confidence === "exact" ? "exact match" : "likely match"}
              </>
            ) : (
              fmtDate(a.date_applied)
            )}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {a.job_application_id !== null && <StageSelect appId={a.job_application_id} stage={a.stage} />}
            {a.jobs_role_id ? (
              <>
                <button
                  type="button"
                  onClick={() => setAddingApp(true)}
                  className="text-[11.5px] text-accent hover:underline"
                >
                  + Add application
                </button>
                <UnmarkBuilderSourcedButton roleId={a.jobs_role_id} />
              </>
            ) : a.suggested_match ? (
              <button
                type="button"
                onClick={() => confirm.mutate({ appId: a.job_application_id!, jobsRoleId: a.suggested_match!.jobs_role_id })}
                disabled={confirm.isPending}
                className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Check size={11} /> Confirm match
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onCreateOpportunity(a)}
                className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
              >
                <Plus size={11} /> Create opportunity
              </button>
            )}
            {/* Rows without a jobs_role_id always come from the job_applications-driven
                branch of the backend union, so job_application_id is guaranteed set here —
                only role-linked rows (which never show Dismiss) can have it be null. */}
            {!a.jobs_role_id && a.job_application_id !== null && (
              <button
                type="button"
                onClick={() => onDismiss(a.job_application_id!)}
                className="text-[11.5px] text-ink-3 hover:text-ink-2"
              >
                Dismiss
              </button>
            )}
          </div>
          {addingApp && a.jobs_role_id && (
            <AddApplicationForm roleId={a.jobs_role_id} onClose={() => setAddingApp(false)} />
          )}
        </div>
      )}
    </li>
  );
}

function UnmarkBuilderSourcedButton({ roleId }: { roleId: string }) {
  const unmark = useUnmarkRoleBuilderSourced();
  return (
    <button
      type="button"
      title="This already has a Bedrock role — send it back to Pursuit-Supported"
      onClick={() => unmark.mutate(roleId)}
      disabled={unmark.isPending}
      className="shrink-0 text-[11px] text-ink-3 hover:text-ink-2 disabled:opacity-50"
    >
      Unmark
    </button>
  );
}

function BuilderSourcedColumn({
  onCreateOpportunity,
}: {
  onCreateOpportunity: (a: UnmatchedApplication) => void;
}) {
  const { data, isLoading } = useBuilderSourcedApplications();
  const [dismissed, dismiss] = usePersistedDismissed("builder-sourced");
  const all = (data ?? []).filter((a) => a.job_application_id === null || !dismissed.has(a.job_application_id));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] uppercase tracking-wider text-ink-4">
          Builder-Sourced
          <span className="ml-2 font-normal normal-case text-ink-4">
            · last 30 days
          </span>
        </span>
        <span className="text-[11px] text-ink-4">{all.length}</span>
      </div>

      {isLoading ? (
        <span className="text-[12px] text-ink-4">Loading…</span>
      ) : all.length === 0 ? (
        <span className="text-[12px] text-ink-4">No self-sourced applications in the last 30 days.</span>
      ) : (
        <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
          {all.map((a) => (
            <BuilderSourcedRow
              key={a.job_application_id ?? `role-${a.jobs_role_id}`}
              a={a}
              onCreateOpportunity={onCreateOpportunity}
              onDismiss={dismiss}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Staff-Sourced queue — grouped by (company, role_title): several
//    applicants often share the same not-yet-formalized role, so it reads
//    like Pursuit-Supported — role/company header, nested applicants —
//    instead of one disconnected row per application. The group-level
//    action (Confirm match / Create opportunity) links every applicant in
//    the group to the role at once; nested rows keep per-applicant stage
//    and Dismiss. ──────────────────────────────────────────────────────

function StaffSourcedGroupRow({
  g,
  onCreateOpportunity,
  onDismiss,
}: {
  g: StaffSourcedGroup;
  onCreateOpportunity: (g: StaffSourcedGroup) => void;
  onDismiss: (id: number) => void;
}) {
  const confirm = useConfirmMatch();
  const [expanded, setExpanded] = useState(false);

  // Excludes applicants already linked to the match elsewhere — confirming
  // them again would create a second linked row for the same builder+role.
  const confirmable = g.applications.filter((a) => !a.already_linked);

  function confirmAll() {
    if (!g.suggested_match) return;
    for (const a of confirmable) {
      confirm.mutate({ appId: a.job_application_id, jobsRoleId: g.suggested_match!.jobs_role_id });
    }
  }

  return (
    <li className="flex flex-col px-3 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 items-start justify-between gap-2 text-left"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown size={13} className="shrink-0 text-ink-4" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-ink-4" />
            )}
            <span className="truncate text-[13px] font-medium text-ink">{g.role_title || "Untitled role"}</span>
            <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
              {g.applications.length}
            </span>
          </div>
          <span className="truncate pl-[19px] text-[11.5px] text-ink-3">{g.company_name}</span>
        </div>
        {g.suggested_match && (
          <span className="inline-flex shrink-0 items-center rounded-full bg-accent-soft/60 px-2 py-0.5 text-[10px] font-medium leading-none text-accent-ink">
            match found
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 flex flex-col gap-2 pl-[19px]">
          {g.suggested_match ? (
            <span className="text-[11.5px] text-ink-4">
              → matches <span className="font-medium text-ink-3">{g.suggested_match.role_title}</span> @{" "}
              {g.suggested_match.account_name} ·{" "}
              {g.suggested_match.confidence === "exact" ? "exact match" : "likely match"}
            </span>
          ) : null}
          {g.suggested_match && confirmable.length > 0 ? (
            <button
              type="button"
              onClick={confirmAll}
              disabled={confirm.isPending}
              className="flex w-fit items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Check size={11} /> Confirm match ({confirmable.length})
            </button>
          ) : g.suggested_match ? (
            <span className="text-[11px] text-ink-4">Everyone here is already linked to that role.</span>
          ) : (
            <button
              type="button"
              onClick={() => onCreateOpportunity(g)}
              className="flex w-fit items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
            >
              <Plus size={11} /> Create opportunity
            </button>
          )}
          <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
            {g.applications.map((a) => (
              <li key={a.job_application_id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="truncate text-[12px] text-ink">
                  {a.builder}
                  {a.already_linked && (
                    <span
                      className="ml-1.5 text-[10px] text-ink-4"
                      title="Already linked to the suggested role via a different application — excluded from Confirm match"
                    >
                      (already linked)
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <StageSelect appId={a.job_application_id} stage={a.stage} />
                  <span className="font-mono text-[10.5px] text-ink-4">{fmtDate(a.date_applied)}</span>
                  <button
                    type="button"
                    onClick={() => onDismiss(a.job_application_id)}
                    className="text-[11px] text-ink-3 hover:text-ink-2"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function StaffSourcedColumn({
  onCreateOpportunity,
}: {
  onCreateOpportunity: (g: StaffSourcedGroup) => void;
}) {
  const { data, isLoading } = useStaffSourcedApplications();
  const [dismissed, dismiss] = usePersistedDismissed("staff-sourced");
  const groups = (data ?? [])
    .map((g) => ({ ...g, applications: g.applications.filter((a) => !dismissed.has(a.job_application_id)) }))
    .filter((g) => g.applications.length > 0);
  const totalApplicants = groups.reduce((n, g) => n + g.applications.length, 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] uppercase tracking-wider text-ink-4">
          Staff-Sourced
          <span className="ml-2 font-normal normal-case text-ink-4">· last 30 days</span>
        </span>
        <span className="text-[11px] text-ink-4">{totalApplicants}</span>
      </div>

      {isLoading ? (
        <span className="text-[12px] text-ink-4">Loading…</span>
      ) : groups.length === 0 ? (
        <span className="text-[12px] text-ink-4">No staff-sourced applications waiting on a role in the last 30 days.</span>
      ) : (
        <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
          {groups.map((g) => (
            <StaffSourcedGroupRow
              key={`${g.company_name}::${g.role_title}`}
              g={g}
              onCreateOpportunity={onCreateOpportunity}
              onDismiss={dismiss}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Add-application inline form (per role row) ─────────────────────────────────

function AddApplicationForm({ roleId, onClose }: { roleId: string; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [builder, setBuilder] = useState<{ user_id: number; name: string } | null>(null);
  const [stage, setStage] = useState<AppStage>("applied");
  const [dateApplied, setDateApplied] = useState(() => new Date().toISOString().slice(0, 10));

  const buildersQ = useBuilders(search || undefined);
  const builders = buildersQ.data ?? [];
  const create = useCreateRoleApplication(roleId);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!builder) return;
    create.mutate(
      {
        user_id: builder.user_id,
        builder_name: builder.name,
        stage,
        date_applied: dateApplied || undefined,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mt-2 flex flex-col gap-2 rounded-md border border-border-strong bg-surface-2/40 p-2.5"
    >
      {builder ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-ink-2">
          {builder.name}
          <button
            type="button"
            onClick={() => { setBuilder(null); setSearch(""); }}
            className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
            title="Clear builder"
          >
            <X size={11} />
          </button>
        </span>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={search}
            onFocus={() => setPickerOpen(true)}
            onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
            onChange={(e) => { setSearch(e.target.value); setPickerOpen(true); }}
            placeholder="Search builders…"
            autoFocus
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          {pickerOpen && builders.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-[140px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
              {builders.slice(0, 12).map((b: Builder) => (
                <li key={b.user_id}>
                  <button
                    type="button"
                    onMouseDown={() => {
                      setBuilder({ user_id: b.user_id, name: b.name });
                      setPickerOpen(false);
                      setSearch("");
                    }}
                    className="w-full px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-surface-2"
                  >
                    <span className="font-medium">{b.name}</span>
                    <span className="ml-1.5 text-ink-3">{b.email}</span>
                    {b.cohort ? <span className="ml-1.5 text-ink-4">· {b.cohort}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Status</span>
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value as AppStage)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          >
            {APP_STAGE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Date applied</span>
          <input
            type="date"
            value={dateApplied}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDateApplied(e.target.value)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!builder || create.isPending}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {create.isPending ? <Spinner /> : <Plus size={12} />}
          Log
        </button>
        <button type="button" onClick={onClose} className="text-[11.5px] text-ink-3 hover:text-ink-2">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Add-role modal (existing opportunity, or spin up a new one inline) ────────

interface AddRolePrefill {
  companyName: string;
  roleTitle?: string;
  /** When set, the newly-created role is auto-linked to every application id
   *  here on success — closes the loop for unmatched application(s) that had
   *  no opportunity to attach to until now, no separate confirm step needed.
   *  Usually one id (Builder-Sourced); can be several when a Staff-Sourced
   *  candidate role has multiple applicants sharing the same company+title. */
  linkApplicationIds?: number[];
}

function AddRoleModal({ onClose, prefill }: { onClose: () => void; prefill?: AddRolePrefill }) {
  const [mode, setMode] = useState<"existing" | "new">(prefill ? "new" : "existing");

  const [oppSearch, setOppSearch] = useState("");
  const [oppSearchDebounced, setOppSearchDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setOppSearchDebounced(oppSearch), 250);
    return () => clearTimeout(t);
  }, [oppSearch]);
  const oppResultsQ = useSearchOpportunities(oppSearchDebounced);
  const [selectedOpp, setSelectedOpp] = useState<{ id: string; label: string } | null>(null);

  const [showAccountDialog, setShowAccountDialog] = useState(Boolean(prefill));
  const [account, setAccount] = useState<{ account_key: string; display: string } | null>(null);
  const [newOppTitle, setNewOppTitle] = useState(prefill?.roleTitle ?? "");
  const [newOppStage, setNewOppStage] = useState<JobStage>("lead_submitted");
  const createOpportunity = useCreateOpportunity();

  const [title, setTitle] = useState(prefill?.roleTitle ?? "");
  const [salary, setSalary] = useState("");
  const [empType, setEmpType] = useState("");
  const [startDate, setStartDate] = useState("");
  const [notes, setNotes] = useState("");
  const [commitment, setCommitment] = useState<Commitment>("committed");
  const createRole = useCreateRole();
  const confirmMatch = useConfirmMatch();

  const oppId = selectedOpp?.id ?? null;

  async function handleCreateOpportunity() {
    if (!account) return;
    const created = await createOpportunity.mutateAsync({
      account_id: account.account_key,
      account_name: account.display,
      stage: newOppStage,
      title: newOppTitle.trim() || undefined,
    });
    if (created?.id) {
      setSelectedOpp({
        id: created.id,
        label: newOppTitle.trim() ? `${account.display} — ${newOppTitle.trim()}` : account.display,
      });
    }
  }

  function submitRole(e: React.FormEvent) {
    e.preventDefault();
    if (!oppId || !title.trim()) return;
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : undefined;
    createRole.mutate(
      {
        oppId,
        title: title.trim(),
        approx_salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
        employment_type: empType.trim() || undefined,
        start_date: startDate || undefined,
        notes: notes.trim() || undefined,
        commitment,
      },
      {
        onSuccess: (createdRole) => {
          if (prefill?.linkApplicationIds?.length && createdRole?.id) {
            for (const appId of prefill.linkApplicationIds) {
              confirmMatch.mutate({ appId, jobsRoleId: createdRole.id });
            }
          }
          onClose();
        },
      },
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="w-full max-w-lg rounded-xl border border-border-strong bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink">Add Role</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-ink-3 hover:text-ink transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex flex-col gap-4 px-5 py-4">
            {!oppId ? (
              <>
                <div className="flex items-center gap-1 self-start rounded-lg border border-border-strong bg-surface-2 p-1">
                  <button
                    type="button"
                    onClick={() => setMode("existing")}
                    className={cn(
                      "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                      mode === "existing" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                    )}
                  >
                    Existing opportunity
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("new")}
                    className={cn(
                      "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                      mode === "new" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                    )}
                  >
                    New opportunity
                  </button>
                </div>

                {mode === "existing" ? (
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                      Search opportunities
                    </label>
                    <input
                      type="text"
                      value={oppSearch}
                      onChange={(e) => setOppSearch(e.target.value)}
                      placeholder="Employer or deal name…"
                      autoFocus
                      className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                    {oppSearch.trim().length >= 2 && (
                      <div className="mt-1 flex flex-col">
                        {(oppResultsQ.data ?? []).map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() =>
                              setSelectedOpp({
                                id: o.id,
                                label: o.title ? `${o.account_name ?? "Unknown"} — ${o.title}` : (o.account_name ?? "Unknown"),
                              })
                            }
                            className="rounded-md px-2 py-2 text-left text-[13px] text-ink hover:bg-surface-2"
                          >
                            {o.account_name}
                            {o.title ? <span className="text-ink-3"> — {o.title}</span> : null}
                          </button>
                        ))}
                        {oppResultsQ.isFetching && (
                          <div className="px-2 py-1 text-[11px] text-ink-4">Searching…</div>
                        )}
                        {!oppResultsQ.isFetching && (oppResultsQ.data ?? []).length === 0 && (
                          <div className="px-2 py-1 text-[11px] text-ink-4">
                            No matching opportunities — try "New opportunity" instead.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                        Employer
                      </label>
                      {account ? (
                        <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2 py-1 text-[12px] text-ink-2">
                          {account.display}
                          <button
                            type="button"
                            onClick={() => setAccount(null)}
                            className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowAccountDialog(true)}
                          className="self-start rounded-md border border-dashed border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90"
                        >
                          Pick or create employer…
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Stage</label>
                      <select
                        value={newOppStage}
                        onChange={(e) => setNewOppStage(e.target.value as JobStage)}
                        className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
                      >
                        {STAGES_ORDERED.map((s) => (
                          <option key={s} value={s}>{STAGE_LABELS[s]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                        Deal name (optional)
                      </label>
                      <input
                        type="text"
                        value={newOppTitle}
                        onChange={(e) => setNewOppTitle(e.target.value)}
                        placeholder="e.g. Summer 2026 hiring"
                        className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!account || createOpportunity.isPending}
                      onClick={() => void handleCreateOpportunity()}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {createOpportunity.isPending ? <Spinner /> : <Plus size={13} />}
                      Create opportunity &amp; continue
                    </button>
                  </div>
                )}
              </>
            ) : (
              <form onSubmit={submitRole} className="flex flex-col gap-3">
                <div className="text-[12px] text-ink-3">
                  Adding a role to <span className="font-medium text-ink">{selectedOpp?.label}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                    Role title <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. AI Deployment Lead"
                    className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                    Commitment
                  </label>
                  <div className="flex items-center gap-1 self-start rounded-lg border border-border-strong bg-surface-2 p-1">
                    <button
                      type="button"
                      onClick={() => setCommitment("committed")}
                      className={cn(
                        "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                        commitment === "committed" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                      )}
                    >
                      Committed
                    </button>
                    <button
                      type="button"
                      onClick={() => setCommitment("open_market")}
                      className={cn(
                        "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                        commitment === "open_market" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                      )}
                    >
                      Open-market
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium text-ink-4">Salary</span>
                    <input
                      type="number"
                      min={0}
                      value={salary}
                      onChange={(e) => setSalary(e.target.value)}
                      placeholder="85000"
                      className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium text-ink-4">Type</span>
                    <select
                      value={empType}
                      onChange={(e) => setEmpType(e.target.value)}
                      className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    >
                      <option value="">—</option>
                      {EMPLOYMENT_TYPE_OPTIONS.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium text-ink-4">Expected start</span>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </label>
                </div>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Role details / notes…"
                  className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={!title.trim() || createRole.isPending}
                    className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {createRole.isPending ? <Spinner /> : <Plus size={13} />}
                    Add role
                  </button>
                  <button type="button" onClick={onClose} className="text-[12.5px] text-ink-3 hover:text-ink-2">
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      {showAccountDialog && (
        <NewAccountDialog
          initialName={prefill?.companyName ?? ""}
          onClose={() => setShowAccountDialog(false)}
          onPicked={(a) => { setAccount(a); setShowAccountDialog(false); }}
        />
      )}
    </>
  );
}

// ── Single role row (expandable to show matched applications) ─────────────────

function RoleBoardRow({ role }: { role: RolesBoardRole }) {
  const [expanded, setExpanded] = useState(false);
  const [addingApp, setAddingApp] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: role.id });
  const unlinkApplication = useUnlinkApplication();
  const markBuilderSourced = useMarkRoleBuilderSourced();
  const updateRole = useUpdateRole();
  const isClosed = role.status === "cancelled";

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex flex-col px-3 py-2.5",
        isDragging && "relative z-10 rounded bg-surface shadow-lg ring-1 ring-accent",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="mt-0.5 shrink-0 cursor-grab touch-none text-ink-4 hover:text-ink-2 active:cursor-grabbing"
          aria-label={`Reorder ${role.title}`}
        >
          <GripVertical size={13} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-start justify-between gap-2 text-left"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              {expanded ? (
                <ChevronDown size={13} className="shrink-0 text-ink-4" />
              ) : (
                <ChevronRight size={13} className="shrink-0 text-ink-4" />
              )}
              <span className="truncate text-[13px] font-medium text-ink">{role.title || "Untitled role"}</span>
              {role.applications.length > 0 && (
                <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
                  {role.applications.length}
                </span>
              )}
            </div>
            <span className="truncate pl-[19px] text-[11.5px] text-ink-3">
              {[role.account_name, fmtSalary(role.approx_salary), empTypeLabel(role.employment_type)]
                .filter((x) => x && x !== "—")
                .join(" · ") || "—"}
            </span>
          </div>
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
              PLACEMENT_STATUS_STYLES[role.placement_status] ?? "bg-stone-100 text-stone-500",
            )}
          >
            {role.placement_status_label}
          </span>
        </button>
      </div>

      {expanded && (
        <div className="mt-2 flex flex-col gap-2 pl-[19px]">
          {role.applications.length === 0 ? (
            <span className="text-[11.5px] text-ink-4">No builder applications matched to this role yet.</span>
          ) : (
            <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
              {role.applications.map((a) => (
                <li key={a.job_application_id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="truncate text-[12px] text-ink">{a.builder}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <StageSelect appId={a.job_application_id} stage={a.stage} />
                    <span className="font-mono text-[10.5px] text-ink-4">{fmtDate(a.date_applied)}</span>
                    <button
                      type="button"
                      title="Remove from this role (doesn't delete the application, just unlinks it)"
                      onClick={() => {
                        if (window.confirm(`Remove ${a.builder} from this role?`)) {
                          unlinkApplication.mutate(a.job_application_id);
                        }
                      }}
                      disabled={unlinkApplication.isPending}
                      className="text-ink-4 hover:text-red-500 transition-colors disabled:opacity-50"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {addingApp ? (
            <AddApplicationForm roleId={role.id} onClose={() => setAddingApp(false)} />
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setAddingApp(true)}
                className="self-start text-[11.5px] text-accent hover:underline"
              >
                + Add application
              </button>
              <button
                type="button"
                title="This role only exists to track a self-found builder's progress — Pursuit has no real relationship with the company"
                onClick={() => {
                  if (window.confirm(`Mark "${role.title || "this role"}" as builder-sourced? It'll move to the Builder-Sourced column.`)) {
                    markBuilderSourced.mutate(role.id);
                  }
                }}
                disabled={markBuilderSourced.isPending}
                className="self-start text-[11.5px] text-ink-3 hover:text-ink-2 disabled:opacity-50"
              >
                Mark as builder-sourced
              </button>
              {/* Someone's already placed here (incl. an active trial) — "everyone
                  fell through" doesn't apply, and closing would clobber the
                  filled/trial signal that placement_status derives from. */}
              {(isClosed || !role.filled_by_user_id) && (
                <button
                  type="button"
                  title={isClosed
                    ? "Reopen — moves it back up with the active roles"
                    : "Every candidate fell through — keep the history but stop it competing with active roles"}
                  onClick={() => {
                    const next = isClosed ? "open" : "cancelled";
                    if (isClosed || window.confirm(`Close "${role.title || "this role"}"? It'll sink to the bottom of the list — nothing is deleted.`)) {
                      updateRole.mutate({ roleId: role.id, status: next });
                    }
                  }}
                  disabled={updateRole.isPending}
                  className="self-start text-[11.5px] text-ink-3 hover:text-ink-2 disabled:opacity-50"
                >
                  {isClosed ? "Reopen role" : "Close role"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

export function RolesBoard() {
  const rolesQ = useRolesBoard();
  const [showAddRole, setShowAddRole] = useState(false);
  const [addRolePrefill, setAddRolePrefill] = useState<AddRolePrefill | undefined>(undefined);
  const [items, setItems] = useState<RolesBoardRole[]>([]);
  const reorder = useReorderRolesBoard();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function openAddRole(prefill?: AddRolePrefill) {
    setAddRolePrefill(prefill);
    setShowAddRole(true);
  }
  function closeAddRole() {
    setShowAddRole(false);
    setAddRolePrefill(undefined);
  }

  // Same "don't clobber an in-progress drag" sync as TagCampaigns: adopt the
  // server order on first load or when the set of roles changes (added,
  // removed, or a filter like ft_placed drops one off the board); otherwise
  // keep the current order and just refresh each row's own data.
  useEffect(() => {
    if (!rolesQ.data) return;
    setItems((prev) => {
      const prevIds = new Set(prev.map((r) => r.id));
      const sameSet = prev.length === rolesQ.data!.length && rolesQ.data!.every((r) => prevIds.has(r.id));
      if (prev.length && sameSet) {
        const byId = Object.fromEntries(rolesQ.data!.map((r) => [r.id, r]));
        return prev.map((r) => byId[r.id] ?? r);
      }
      return rolesQ.data!;
    });
  }, [rolesQ.data]);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((r) => r.id === active.id);
    const to = items.findIndex((r) => r.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(items, from, to);
    setItems(next);
    reorder.mutate(next.map((r) => r.id));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] uppercase tracking-wider text-ink-4">
              Pursuit-Supported
              <span className="ml-2 font-normal normal-case text-ink-4">· drag the grip to reorder</span>
            </span>
            <button
              type="button"
              onClick={() => openAddRole()}
              className="flex items-center gap-1 text-[12px] text-accent hover:underline"
            >
              <Plus size={12} /> Add role
            </button>
          </div>

          {rolesQ.isLoading ? (
            <span className="text-[12px] text-ink-4">Loading…</span>
          ) : items.length === 0 ? (
            <span className="text-[12px] text-ink-4">No roles yet.</span>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={items.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
                  {items.map((r) => (
                    <RoleBoardRow key={r.id} role={r} />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>

        <StaffSourcedColumn
          onCreateOpportunity={(g: StaffSourcedGroup) =>
            openAddRole({
              companyName: g.company_name ?? "",
              roleTitle: g.role_title ?? undefined,
              linkApplicationIds: g.applications.map((a) => a.job_application_id),
            })
          }
        />

        <BuilderSourcedColumn
          onCreateOpportunity={(a) =>
            openAddRole({
              companyName: a.company_name ?? "",
              roleTitle: a.role_title ?? undefined,
              linkApplicationIds: a.job_application_id !== null ? [a.job_application_id] : undefined,
            })
          }
        />
      </div>

      {showAddRole && <AddRoleModal onClose={closeAddRole} prefill={addRolePrefill} />}
    </div>
  );
}
