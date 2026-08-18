import { useState } from "react";
import { Plus, X, Check, Trash2, UserPlus, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useBuilders, type Builder } from "@/services/jobs";
import {
  useOppRoles,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  useHireRole,
  type Role,
  type RoleStatus,
  type Commitment,
  type RatePeriod,
  type RolePatchBody,
} from "@/services/jobsOpps2";

// ── Helpers ────────────────────────────────────────────────────────────────

const ROLE_STATUS_STYLES: Record<RoleStatus, string> = {
  open:      "bg-amber-50 text-amber-700",
  filled:    "bg-green-100 text-green-800",
  cancelled: "bg-stone-100 text-stone-500",
};

const ROLE_STATUS_LABELS: Record<RoleStatus, string> = {
  open:      "Open",
  filled:    "Filled",
  cancelled: "Closed",
};

// Derived placement status (server-computed) — richer than the raw open/filled
// so a trial-active or committed-open seat reads correctly on the row.
const PLACEMENT_STATUS_STYLES: Record<string, string> = {
  ft_placed:      "bg-green-100 text-green-800",
  trial_active:   "bg-indigo-100 text-indigo-800",
  committed_open: "bg-amber-50 text-amber-700",
  open_market:    "bg-sky-50 text-sky-700",
  cancelled:      "bg-stone-100 text-stone-500",
};

// Employment-type options for the role dropdown (mirrors the placements modal).
const EMPLOYMENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "full_time",  label: "Full-Time" },
  { value: "contract",   label: "Contract" },
  { value: "freelance",  label: "Freelance" },
  { value: "internship", label: "Internship" },
  { value: "pro_bono",   label: "Pro Bono" },
];

const EMPLOYMENT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  EMPLOYMENT_TYPE_OPTIONS.map((t) => [t.value, t.label]),
);

function empTypeLabel(t: string | null): string | null {
  if (!t) return null;
  return EMPLOYMENT_TYPE_LABELS[t] ?? t;
}

function fmtSalary(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US")}`;
}

const RATE_PERIOD_OPTIONS: { value: RatePeriod; label: string }[] = [
  { value: "annual",  label: "/ yr" },
  { value: "monthly", label: "/ mo" },
  { value: "weekly",  label: "/ wk" },
  { value: "daily",   label: "/ day" },
  { value: "hourly",  label: "/ hr" },
];

const RATE_PERIOD_SHORT: Record<string, string> = Object.fromEntries(
  RATE_PERIOD_OPTIONS.map((o) => [o.value, o.label]),
);

// ── Shared extra-field state (commitment, trial, compensation) ──────────────────

interface RoleExtras {
  commitment: Commitment;
  isTrial: boolean;
  convertsTo: string;        // role id this trial converts into, or ""
  payRate: string;
  ratePeriod: string;
  endDate: string;
  payCadence: string;
  benefits: string;
  negotiation: string;
  jdUrl: string;
}

const EMPTY_EXTRAS: RoleExtras = {
  commitment: "committed", isTrial: false, convertsTo: "", payRate: "", ratePeriod: "",
  endDate: "", payCadence: "", benefits: "", negotiation: "", jdUrl: "",
};

function extrasFromRole(r: Role): RoleExtras {
  return {
    commitment: r.commitment ?? "committed",
    isTrial: Boolean(r.is_trial),
    convertsTo: r.converts_to_role_id ?? "",
    payRate: r.pay_rate != null ? String(r.pay_rate) : "",
    ratePeriod: r.rate_period ?? "",
    endDate: r.end_date ?? "",
    payCadence: r.pay_cadence ?? "",
    benefits: r.benefits ?? "",
    negotiation: r.negotiation_notes ?? "",
    jdUrl: r.jd_url ?? "",
  };
}

/** Map the form's extras to the API patch/create body shape. */
function extrasToBody(x: RoleExtras): Partial<RolePatchBody> {
  const rate = x.payRate.trim() ? Number(x.payRate.replace(/[^0-9.]/g, "")) : null;
  return {
    commitment: x.commitment,
    is_trial: x.isTrial,
    // Only a trial role carries a conversion link; clearing the trial drops it.
    converts_to_role_id: x.isTrial && x.convertsTo ? x.convertsTo : null,
    pay_rate: rate != null && !isNaN(rate) ? rate : null,
    rate_period: (x.ratePeriod || null) as RatePeriod | null,
    end_date: x.endDate || null,
    pay_cadence: x.payCadence.trim() || null,
    benefits: x.benefits.trim() || null,
    negotiation_notes: x.negotiation.trim() || null,
    jd_url: x.jdUrl.trim() || null,
  };
}

const INPUT_CLS =
  "w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40";

/** Commitment + trial + compensation fields, shared by the add and edit forms.
 *  `candidates` are sibling roles a trial can convert into (self excluded). */
function RoleExtraFields({
  value,
  onChange,
  candidates = [],
}: {
  value: RoleExtras;
  onChange: (x: RoleExtras) => void;
  candidates?: Role[];
}) {
  const set = <K extends keyof RoleExtras>(k: K, v: RoleExtras[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-col gap-2 rounded border border-dashed border-border-strong p-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-ink-4">Commitment</span>
          <select
            value={value.commitment}
            onChange={(e) => set("commitment", e.target.value as Commitment)}
            className="rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          >
            <option value="committed">Committed</option>
            <option value="open_market">Open-market</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <input type="checkbox" checked={value.isTrial} onChange={(e) => set("isTrial", e.target.checked)} />
          Trial / work-trial
        </label>
        {value.isTrial ? (
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium text-ink-4">Converts to</span>
            <select
              value={value.convertsTo}
              onChange={(e) => set("convertsTo", e.target.value)}
              className="rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              <option value="">— full-time role —</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}{r.employment_type ? ` (${empTypeLabel(r.employment_type)})` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Rate</span>
          <div className="flex gap-1">
            <input type="number" min={0} value={value.payRate} onChange={(e) => set("payRate", e.target.value)} placeholder="e.g. 60" className={INPUT_CLS} />
            <select value={value.ratePeriod} onChange={(e) => set("ratePeriod", e.target.value)} className="rounded border border-border-strong bg-surface px-1 py-1 text-[11px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40">
              <option value="">—</option>
              {RATE_PERIOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">End date</span>
          <input type="date" value={value.endDate} onChange={(e) => set("endDate", e.target.value)} className={INPUT_CLS} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Pay cadence</span>
          <input type="text" value={value.payCadence} onChange={(e) => set("payCadence", e.target.value)} placeholder="biweekly" className={INPUT_CLS} />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Benefits</span>
          <input type="text" value={value.benefits} onChange={(e) => set("benefits", e.target.value)} placeholder="e.g. after conversion" className={INPUT_CLS} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Negotiation</span>
          <input type="text" value={value.negotiation} onChange={(e) => set("negotiation", e.target.value)} placeholder="notes" className={INPUT_CLS} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">JD link</span>
          <input type="text" value={value.jdUrl} onChange={(e) => set("jdUrl", e.target.value)} placeholder="https://…" className={INPUT_CLS} />
        </label>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin text-ink-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Hire inline form ─────────────────────────────────────────────────────────

function HireForm({ role, oppId, onClose }: { role: Role; oppId: string; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [builder, setBuilder] = useState<{ user_id: number; name: string } | null>(null);
  const [salary, setSalary] = useState(role.approx_salary != null ? String(role.approx_salary) : "");
  const [startDate, setStartDate] = useState(role.start_date ?? "");

  const buildersQ = useBuilders(search || undefined);
  const builders = buildersQ.data ?? [];
  const hire = useHireRole();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!builder) return;
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : undefined;
    hire.mutate(
      {
        roleId: role.id,
        oppId,
        user_id: builder.user_id,
        salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
        start_date: startDate || undefined,
        employment_type: role.employment_type ?? undefined,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mt-2 flex flex-col gap-2 rounded-md border border-border-strong bg-surface-2/40 p-2.5"
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
        Hire a builder
      </span>

      {/* Builder picker */}
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
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
            placeholder="Search builders…"
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          {open && builders.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-[140px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
              {builders.slice(0, 12).map((b: Builder) => (
                <li key={b.user_id}>
                  <button
                    type="button"
                    onMouseDown={() => {
                      setBuilder({ user_id: b.user_id, name: b.name });
                      setOpen(false);
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

      {/* Salary + start override */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px] font-medium text-ink-4">Salary</label>
          <input
            type="number"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            placeholder="85000"
            min={0}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px] font-medium text-ink-4">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!builder || hire.isPending}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {hire.isPending ? <Spinner /> : <Check size={12} />}
          {hire.isPending ? "Hiring…" : "Confirm hire"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-[11.5px] text-ink-3 hover:text-ink-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Single role row ───────────────────────────────────────────────────────────

function RoleRow({ role, oppId, roles }: { role: Role; oppId: string; roles: Role[] }) {
  const convertsToRole = role.converts_to_role_id
    ? roles.find((r) => r.id === role.converts_to_role_id)
    : undefined;
  const [editing, setEditing] = useState(false);
  const [hiring, setHiring] = useState(false);
  const [title, setTitle] = useState(role.title);
  const [salary, setSalary] = useState(role.approx_salary != null ? String(role.approx_salary) : "");
  const [empType, setEmpType] = useState(role.employment_type ?? "");
  const [startDate, setStartDate] = useState(role.start_date ?? "");
  const [notes, setNotes] = useState(role.notes ?? "");
  const [extras, setExtras] = useState<RoleExtras>(extrasFromRole(role));

  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();

  function saveEdit() {
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : null;
    updateRole.mutate(
      {
        roleId: role.id,
        oppId,
        title: title.trim() || role.title,
        approx_salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : null,
        employment_type: empType.trim() || null,
        start_date: startDate || null,
        notes: notes.trim() || null,
        ...extrasToBody(extras),
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-2 px-3 py-2.5">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Role title"
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-ink-4">Salary</span>
            <input
              type="number"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="85000"
              min={0}
              className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-ink-4">Type</span>
            <select
              value={empType}
              onChange={(e) => setEmpType(e.target.value)}
              className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
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
              className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </label>
        </div>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Role details / notes…"
          className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <RoleExtraFields value={extras} onChange={setExtras} candidates={roles.filter((r) => r.id !== role.id)} />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveEdit}
            disabled={updateRole.isPending}
            className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {updateRole.isPending ? <Spinner /> : <Check size={12} />}
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-[11.5px] text-ink-3 hover:text-ink-2"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-col px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-ink">{role.title || "Untitled role"}</span>
            {role.commitment === "open_market" ? (
              <span className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide leading-none text-stone-500">Open-market</span>
            ) : null}
            {role.is_trial ? (
              <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide leading-none text-amber-700">Trial</span>
            ) : null}
          </div>
          <span className="truncate text-[11.5px] text-ink-3">
            {[
              fmtSalary(role.approx_salary),
              role.pay_rate != null ? `$${role.pay_rate.toLocaleString("en-US")} ${RATE_PERIOD_SHORT[role.rate_period ?? ""] ?? ""}`.trim() : null,
              empTypeLabel(role.employment_type),
              role.start_date ? fmtDate(role.start_date) : null,
              role.end_date ? `→ ${fmtDate(role.end_date)}` : null,
            ]
              .filter((x) => x && x !== "—")
              .join(" · ") || "—"}
          </span>
          {role.is_trial && convertsToRole ? (
            <span className="mt-0.5 text-[10.5px] text-ink-4">→ converts to <span className="text-ink-3">{convertsToRole.title}</span></span>
          ) : null}
          {role.notes ? (
            <span className="mt-0.5 whitespace-pre-wrap text-[11px] text-ink-3">{role.notes}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
              PLACEMENT_STATUS_STYLES[role.placement_status] ?? ROLE_STATUS_STYLES[role.status],
            )}
          >
            {role.placement_status_label ?? ROLE_STATUS_LABELS[role.status]}
          </span>
          <button
            type="button"
            onClick={() => updateRole.mutate({ roleId: role.id, oppId, pathfinder_visible: !role.pathfinder_visible })}
            disabled={updateRole.isPending}
            title={role.pathfinder_visible ? "Visible to builders in Pathfinder — click to hide" : "Publish this role to builders in Pathfinder"}
            className={cn(
              "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-50",
              role.pathfinder_visible
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border-strong bg-surface text-ink-3 hover:border-accent hover:text-accent",
            )}
          >
            {role.pathfinder_visible ? <Eye size={11} /> : <EyeOff size={11} />}
            Pathfinder
          </button>
          {role.status === "open" && (
            <button
              type="button"
              onClick={() => setHiring((v) => !v)}
              title="Hire a builder"
              className="flex items-center gap-1 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
            >
              <UserPlus size={11} />
              Hire
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[10.5px] text-ink-3 hover:text-accent"
          >
            Edit
          </button>
          <button
            type="button"
            title="Delete role"
            onClick={() => {
              if (window.confirm(`Delete the "${role.title ?? "untitled"}" role? This can't be undone.`)) {
                deleteRole.mutate({ roleId: role.id, oppId });
              }
            }}
            className="text-ink-4 hover:text-red-500 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {hiring && role.status === "open" && (
        <HireForm role={role} oppId={oppId} onClose={() => setHiring(false)} />
      )}
    </li>
  );
}

// ── Add-role inline form ───────────────────────────────────────────────────────

function AddRoleForm({ oppId, roles }: { oppId: string; roles: Role[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [salary, setSalary] = useState("");
  const [empType, setEmpType] = useState("");
  const [startDate, setStartDate] = useState("");
  const [notes, setNotes] = useState("");
  const [extras, setExtras] = useState<RoleExtras>(EMPTY_EXTRAS);
  const createRole = useCreateRole();

  function reset() {
    setTitle("");
    setSalary("");
    setEmpType("");
    setStartDate("");
    setNotes("");
    setExtras(EMPTY_EXTRAS);
    setOpen(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : undefined;
    createRole.mutate(
      {
        oppId,
        title: title.trim(),
        approx_salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
        employment_type: empType.trim() || undefined,
        start_date: startDate || undefined,
        notes: notes.trim() || undefined,
        ...extrasToBody(extras),
      },
      { onSuccess: () => reset() },
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-[12px] text-accent hover:underline"
      >
        + Add role
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-border-strong p-2.5">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Role title"
        autoFocus
        className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Salary</span>
          <input
            type="number"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            placeholder="85000"
            min={0}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Type</span>
          <select
            value={empType}
            onChange={(e) => setEmpType(e.target.value)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
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
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </label>
      </div>
      <textarea
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Role details / notes…"
        className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
      <RoleExtraFields value={extras} onChange={setExtras} candidates={roles} />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!title.trim() || createRole.isPending}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {createRole.isPending ? <Spinner /> : <Plus size={12} />}
          Add role
        </button>
        <button type="button" onClick={reset} className="text-[11.5px] text-ink-3 hover:text-ink-2">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Section ────────────────────────────────────────────────────────────────────

export function OppRolesSection({ oppId }: { oppId: string }) {
  const rolesQ = useOppRoles(oppId);
  const roles = rolesQ.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">Committed Roles</span>
      {rolesQ.isLoading ? (
        <span className="text-[12px] text-ink-4">Loading…</span>
      ) : roles.length === 0 ? (
        <span className="text-[12px] text-ink-4">No roles committed yet.</span>
      ) : (
        <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
          {roles.map((r) => (
            <RoleRow key={r.id} role={r} oppId={oppId} roles={roles} />
          ))}
        </ul>
      )}
      <AddRoleForm oppId={oppId} roles={roles} />
    </div>
  );
}
