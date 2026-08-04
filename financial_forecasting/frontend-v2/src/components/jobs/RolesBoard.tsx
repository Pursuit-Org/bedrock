import { useState } from "react";
import { format } from "date-fns";
import { Plus, X, Check, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBuilders, useCreateOpportunity, STAGES_ORDERED, STAGE_LABELS, type Builder, type JobStage } from "@/services/jobs";
import { NewAccountDialog } from "@/components/jobs/NewAccountDialog";
import {
  useRolesBoard,
  useSearchOpportunities,
  useCreateRole,
  useCreateRoleApplication,
  useMatchSuggestions,
  useConfirmMatch,
  APP_STAGE_OPTIONS,
  type AppStage,
  type RolesBoardRole,
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
  applied: "Applied",
  interview: "Interviewing",
  accepted: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const APP_STAGE_STYLES: Record<string, string> = {
  applied: "bg-blue-50 text-blue-700",
  interview: "bg-amber-50 text-amber-700",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-50 text-red-700",
  withdrawn: "bg-stone-100 text-stone-500",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
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

// ── Suggested matches banner (one-time backfill review — never auto-applied) ──

function SuggestedMatchesBanner() {
  const { data, isLoading } = useMatchSuggestions(30);
  const confirm = useConfirmMatch();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const suggestions = (data ?? []).filter((s) => !dismissed.has(s.job_application_id));

  if (isLoading || suggestions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/30 bg-accent-soft/40 p-3">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-accent-ink">
        <Sparkles size={13} />
        {suggestions.length} suggested application match{suggestions.length === 1 ? "" : "es"} from the last 30 days
      </div>
      <ul className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <li
            key={s.job_application_id}
            className="flex items-center justify-between gap-3 rounded bg-surface px-2.5 py-1.5"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[12px] text-ink">
                <span className="font-medium">{s.builder}</span> applied to{" "}
                <span className="text-ink-3">{s.role_title}</span> @ {s.company_name}
              </span>
              <span className="truncate text-[11px] text-ink-4">
                → matches <span className="font-medium text-ink-3">{s.suggested_match.role_title}</span> @{" "}
                {s.suggested_match.account_name} ·{" "}
                {s.suggested_match.confidence === "exact" ? "exact match" : "likely match"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  confirm.mutate({ appId: s.job_application_id, jobsRoleId: s.suggested_match.jobs_role_id })
                }
                disabled={confirm.isPending}
                className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Check size={11} /> Confirm
              </button>
              <button
                type="button"
                onClick={() => setDismissed((d) => new Set(d).add(s.job_application_id))}
                className="text-[11px] text-ink-3 hover:text-ink-2"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
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

function AddRoleModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"existing" | "new">("existing");

  const [oppSearch, setOppSearch] = useState("");
  const oppResultsQ = useSearchOpportunities(oppSearch);
  const [selectedOpp, setSelectedOpp] = useState<{ id: string; label: string } | null>(null);

  const [showAccountDialog, setShowAccountDialog] = useState(false);
  const [account, setAccount] = useState<{ account_key: string; display: string } | null>(null);
  const [newOppTitle, setNewOppTitle] = useState("");
  const [newOppStage, setNewOppStage] = useState<JobStage>("lead_submitted");
  const createOpportunity = useCreateOpportunity();

  const [title, setTitle] = useState("");
  const [salary, setSalary] = useState("");
  const [empType, setEmpType] = useState("");
  const [startDate, setStartDate] = useState("");
  const [notes, setNotes] = useState("");
  const createRole = useCreateRole();

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
      },
      { onSuccess: () => onClose() },
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

  return (
    <li className="flex flex-col px-3 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start justify-between gap-2 text-left"
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
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
                        APP_STAGE_STYLES[a.stage ?? ""] ?? "bg-stone-100 text-stone-500",
                      )}
                    >
                      {APP_STAGE_LABELS[a.stage ?? ""] ?? a.stage ?? "—"}
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-4">{fmtDate(a.date_applied)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {addingApp ? (
            <AddApplicationForm roleId={role.id} onClose={() => setAddingApp(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setAddingApp(true)}
              className="self-start text-[11.5px] text-accent hover:underline"
            >
              + Add application
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

export function RolesBoard() {
  const rolesQ = useRolesBoard();
  const roles = rolesQ.data ?? [];
  const [showAddRole, setShowAddRole] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <SuggestedMatchesBanner />

      <div className="flex items-center justify-between">
        <span className="text-[10.5px] uppercase tracking-wider text-ink-4">All Roles</span>
        <button
          type="button"
          onClick={() => setShowAddRole(true)}
          className="flex items-center gap-1 text-[12px] text-accent hover:underline"
        >
          <Plus size={12} /> Add role
        </button>
      </div>

      {rolesQ.isLoading ? (
        <span className="text-[12px] text-ink-4">Loading…</span>
      ) : roles.length === 0 ? (
        <span className="text-[12px] text-ink-4">No roles yet.</span>
      ) : (
        <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
          {roles.map((r) => (
            <RoleBoardRow key={r.id} role={r} />
          ))}
        </ul>
      )}

      {showAddRole && <AddRoleModal onClose={() => setShowAddRole(false)} />}
    </div>
  );
}
