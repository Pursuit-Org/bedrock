import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useJobsOpportunities,
  useJobsOpportunity,
  useUpdateOpportunity,
  useDeleteOpportunity,
  useCreateOpportunity,
  useLogActivity,
  useDeleteActivity,
  useBuilders,
  useContactSearch,
  useContactDetail,
  useOppPlacements,
  useUnlinkedPlacements,
  useCreatePlacement,
  useLinkPlacement,
  useStaff,
  type Staff,
  STAGE_LABELS,
  DEAL_TYPE_LABELS,
  STAGES_ORDERED,
  type JobStage,
  type DealType,
  type JobsOpportunity,
  type JobsOpportunityDetail,
  type JobContact,
  type ActivityCreateBody,
  type Builder,
  type ContactSearchResult,
  type OppPlacement,
} from "@/services/jobs";
import { ActivitySourceIcon } from "@/components/ActivitySourceIcon";
import { jobsOpportunityPath } from "@/components/jobs/jobsEntity";
import { OppRolesSection } from "@/components/jobs/OppRolesSection";
import { OppBuilderActivity } from "@/components/jobs/OppBuilderActivity";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { JobsComments } from "@/components/jobs/JobsComments";
import { CommittedRolesModal } from "@/components/jobs/CommittedRolesModal";
import { RowExpandPanel, type ExpandTab } from "@/components/RowExpandPanel";
import { InlineText, InlineSelect, InlineDate } from "@/components/ui/InlineEdit";
import { useSort, sortBy, type SortState } from "@/lib/sort";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { ResizableTh } from "@/components/ui/ResizableTable";
import { Toolbar } from "@/components/ui/Toolbar";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { useColumnWidths } from "@/lib/columnWidths";
import { useSessionState } from "@/lib/useSessionState";
import {
  AddFilterButton,
  FilterChip,
  describeRule,
  ruleApplies,
  type FieldMeta,
  type FilterRule,
} from "@/pages/cleanup/Filters";
import { ChevronDown, ChevronRight, Mail, Linkedin, Trash2, X, Plus, Check, CheckSquare, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

// ── Owner config ─────────────────────────────────────────────────────────────

interface OwnerDef {
  label: string;
  email: string;
  initials: string;
  color: string;
}

const OWNERS: OwnerDef[] = [
  { label: "Avni",   email: "avni@pursuit.org",             initials: "A",  color: "bg-violet-100 text-violet-700" },
  { label: "Damon",  email: "damon.kornhauser@pursuit.org", initials: "D",  color: "bg-sky-100 text-sky-700" },
  { label: "Devika", email: "devika@pursuit.org",           initials: "De", color: "bg-rose-100 text-rose-700" },
];

// ── Calculated status (read-only roll-up of the 9-stage field) ─────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On Hold" },
  { value: "closed", label: "Closed" },
];

const STATUS_STYLES: Record<"active" | "on_hold" | "closed", { label: string; className: string }> = {
  active:  { label: "Active",  className: "bg-emerald-50 text-emerald-700" },
  on_hold: { label: "On Hold", className: "bg-amber-50 text-amber-600" },
  closed:  { label: "Closed",  className: "bg-stone-100 text-stone-500" },
};

function stageStatus(stage: JobStage): "active" | "on_hold" | "closed" {
  if (stage.startsWith("closed")) return "closed";
  if (stage.startsWith("on_hold")) return "on_hold";
  return "active";
}

function StatusChip({ stage }: { stage: JobStage }) {
  const s = STATUS_STYLES[stageStatus(stage)];
  return (
    <span className={cn("inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide leading-none", s.className)}>
      {s.label}
    </span>
  );
}

/** Row indicator: shows recent (trailing-7d) activity so the team can spot which
 *  accounts moved this week at a glance. */
function RecentActivityDot({ recent, last }: { recent: number | undefined; last: string | null | undefined }) {
  if (!recent || recent <= 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9.5px] font-semibold leading-none text-emerald-700"
      title={last ? `Last activity ${fmtRelative(last)}` : "Recent activity"}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      {recent} this wk
    </span>
  );
}

// priority stored 1–5 (5 = highest). Display as P1 (highest) … P5 (lowest).
const PRIORITY_BADGE: Record<number, { label: string; className: string }> = {
  5: { label: "P1", className: "bg-red-100 text-red-700" },
  4: { label: "P2", className: "bg-orange-100 text-orange-700" },
  3: { label: "P3", className: "bg-amber-100 text-amber-700" },
  2: { label: "P4", className: "bg-stone-100 text-stone-600" },
  1: { label: "P5", className: "bg-stone-100 text-stone-400" },
};

function PriorityBadge({ priority }: { priority: number | null | undefined }) {
  if (priority == null) return null;
  const p = PRIORITY_BADGE[priority];
  if (!p) return null;
  return (
    <span className={cn("inline-flex items-center rounded px-1 py-0.5 text-[9.5px] font-bold leading-none", p.className)} title={`Priority ${p.label}`}>
      {p.label}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

// Synced email bodies arrive with raw HTML entities (e.g. "you&#39;re").
// Decode them for display via a detached textarea (no DOM injection).
let _entityDecoder: HTMLTextAreaElement | null = null;
function decodeEntities(s: string | null | undefined): string {
  if (!s) return "";
  if (typeof document === "undefined") return s;
  _entityDecoder = _entityDecoder ?? document.createElement("textarea");
  _entityDecoder.innerHTML = s;
  return _entityDecoder.value;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin text-ink-3"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Builder picker ────────────────────────────────────────────────────────────

function BuilderPicker({
  dealId,
  builderIds,
}: {
  dealId: string;
  builderIds: string[];
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const updateOpp = useUpdateOpportunity();
  const buildersQ = useBuilders(search || undefined);
  const builders = buildersQ.data ?? [];

  function removeBuilder(email: string) {
    updateOpp.mutate({ id: dealId, builder_ids: builderIds.filter((b) => b !== email) });
  }

  function addBuilder(builder: Builder) {
    if (builderIds.includes(builder.email)) return;
    updateOpp.mutate({ id: dealId, builder_ids: [...builderIds, builder.email] });
    setSearch("");
    setOpen(false);
  }

  const filtered = builders.filter(
    (b) => !builderIds.includes(b.email)
  );

  return (
    <div className="flex flex-col gap-1.5">
      {builderIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {builderIds.map((email) => (
            <span
              key={email}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2 border border-border-strong"
            >
              {email}
              <button
                type="button"
                onClick={() => removeBuilder(email)}
                className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
                title="Remove builder"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
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
        {open && filtered.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-[140px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
            {filtered.slice(0, 12).map((b) => (
              <li key={b.email}>
                <button
                  type="button"
                  onMouseDown={() => addBuilder(b)}
                  className="w-full px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-surface-2"
                >
                  <span className="font-medium">{b.name}</span>
                  <span className="ml-1.5 text-ink-3">{b.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Contact picker ────────────────────────────────────────────────────────────

/** Derive source badge label + style from a sf_contact_ids ref string */
function contactRefSource(ref: string): { label: string; className: string } {
  if (ref.startsWith("airtable:")) return { label: "Jobs", className: "bg-accent-soft text-accent-ink" };
  if (ref.startsWith("pub:"))      return { label: "LinkedIn", className: "bg-indigo-50 text-indigo-600" };
  return { label: "SF", className: "bg-sky-50 text-sky-600" };
}

/** Derive source badge label + style from a ContactSearchResult */
function searchResultSource(c: ContactSearchResult): { label: string; className: string } {
  if (c.airtable_id)                   return { label: "Jobs",     className: "bg-accent-soft text-accent-ink" };
  if (c.in_sf)                          return { label: "SF",       className: "bg-sky-50 text-sky-600" };
  if (c.source === "linkedin_import")   return { label: "LinkedIn", className: "bg-indigo-50 text-indigo-600" };
  return { label: "Jobs", className: "bg-accent-soft text-accent-ink" };
}

function ContactSourceBadge({ className, label }: { className: string; label: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1 py-0.5 text-[9.5px] font-semibold leading-none", className)}>
      {label}
    </span>
  );
}

function ContactPicker({
  dealId,
  sfContactIds,
  linkedContacts,
}: {
  dealId: string;
  sfContactIds: string[];
  linkedContacts: JobContact[];
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const updateOpp = useUpdateOpportunity();
  const searchQ = useContactSearch(search);
  const results: ContactSearchResult[] = search.length >= 2 ? (searchQ.data ?? []) : [];

  function contactDisplayName(c: JobContact): string {
    return c.full_name ?? (`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || `#${c.contact_id}`);
  }

  /** Find the ref stored in sfContactIds that corresponds to this linked contact */
  function findRef(c: JobContact): string {
    return (
      sfContactIds.find(
        (id) =>
          id === `airtable:${c.contact_id}` ||
          id === `pub:${c.contact_id}` ||
          id.endsWith(`:${c.contact_id}`)
      ) ?? String(c.contact_id)
    );
  }

  function removeContact(ref: string) {
    updateOpp.mutate({ id: dealId, sf_contact_ids: sfContactIds.filter((x) => x !== ref) });
  }

  function addContact(result: ContactSearchResult) {
    if (sfContactIds.includes(result.contact_ref)) return;
    updateOpp.mutate({ id: dealId, sf_contact_ids: [...sfContactIds, result.contact_ref] });
    setSearch("");
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* Current linked contacts as pills */}
      {linkedContacts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {linkedContacts.map((c) => {
            const ref = findRef(c);
            const badge = contactRefSource(ref);
            return (
              <span
                key={c.contact_id}
                className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2 border border-border-strong"
                title={c.email ?? undefined}
              >
                {contactDisplayName(c)}
                <ContactSourceBadge label={badge.label} className={badge.className} />
                <button
                  type="button"
                  onClick={() => removeContact(ref)}
                  className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
                  title="Remove contact"
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={search}
          onFocus={() => { if (search.length >= 2) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          placeholder="Search all 32k+ contacts…"
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        {open && search.length >= 2 && (
          <ul className="absolute z-20 mt-1 max-h-[160px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
            {searchQ.isLoading ? (
              <li className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-ink-3">
                <Spinner /> Searching…
              </li>
            ) : results.length === 0 ? (
              <li className="px-3 py-2 text-[11.5px] text-ink-4">No contacts found.</li>
            ) : (
              results.slice(0, 12).map((r) => {
                const badge = searchResultSource(r);
                const titleLine = [r.current_title, r.current_company].filter(Boolean).join(" @ ");
                return (
                  <li key={r.contact_id}>
                    <button
                      type="button"
                      onMouseDown={() => addContact(r)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{r.full_name ?? `#${r.contact_id}`}</span>
                        {titleLine ? (
                          <span className="ml-1.5 text-ink-3">{titleLine}</span>
                        ) : null}
                      </span>
                      <ContactSourceBadge label={badge.label} className={badge.className} />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      {/* Footer hints */}
      <p className="text-[10.5px] text-ink-4">
        Contacts from SF, LinkedIn, and Jobs pipeline — all 32k+ contacts searchable
      </p>
      <p className="text-[10.5px] text-ink-4">
        Can't find them? Use the Contacts tab to create a new one.
      </p>
    </div>
  );
}

// ── Staff (owner) picker ──────────────────────────────────────────────────────

function StaffPicker({
  value,
  onChange,
}: {
  value: string | null;
  /** Returns a promise that resolves once the save has persisted. */
  onChange: (email: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  // Fixed-position dropdown anchored to the trigger: inside the table the
  // wrapper scrolls/clips, so an absolutely-positioned menu gets cut off or
  // overlaps neighbouring cells in narrow windows.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; up: boolean } | null>(null);

  // useStaff() with no arg returns up to 50 active staff; filter client-side for snappiness.
  const staffQ = useStaff();
  const staff = staffQ.data ?? [];

  const q = search.trim().toLowerCase();
  const filtered: Staff[] = q
    ? staff.filter(
        (s) =>
          s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q),
      )
    : staff;

  // Display label for the current owner: staff name if resolvable, else raw email, else Unassigned.
  const current = value ? staff.find((s) => s.email === value) : undefined;
  const displayLabel = current?.name ?? (value || "Unassigned");

  async function select(email: string | null) {
    setSaving(true);
    try {
      await onChange(email);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1200);
    } finally {
      setSaving(false);
      setOpen(false);
      setSearch("");
    }
  }

  return (
    <div
      className="relative"
      // Close only when focus leaves the whole picker. The dropdown's autofocus
      // search input would otherwise blur the toggle button and snap it shut.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        onClick={() => {
          // Refetch on open: a staff fetch that failed earlier (e.g. fired
          // pre-login and 401'd) would otherwise stay cached as an empty
          // list and the picker reads "No staff found" forever (TKT-128).
          if (!open && (staffQ.isError || staff.length === 0)) void staffQ.refetch();
          if (!open && triggerRef.current) {
            const r = triggerRef.current.getBoundingClientRect();
            const up = window.innerHeight - r.bottom < 300; // flip when near the bottom
            setMenuPos({ top: up ? r.top - 4 : r.bottom + 4, left: Math.min(r.left, window.innerWidth - 244), up });
          }
          setOpen((v) => !v);
        }}
        className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] text-ink-2 hover:bg-surface-2"
      >
        <span className={cn(value ? "text-ink-2" : "text-ink-4")}>{displayLabel}</span>
        {saving ? (
          <Spinner />
        ) : savedTick ? (
          <Check size={12} className="text-emerald-600" />
        ) : (
          <ChevronDown size={12} className="text-ink-4 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>

      {open && menuPos && (
        <div
          className="fixed z-50 max-h-64 w-60 overflow-auto rounded border border-border-strong bg-surface shadow-lg"
          style={menuPos.up
            ? { left: menuPos.left, bottom: window.innerHeight - menuPos.top }
            : { left: menuPos.left, top: menuPos.top }}
        >
          <div className="sticky top-0 bg-surface px-2 pt-2 pb-1">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder="Search staff…"
              className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
          <div
            onMouseDown={(e) => e.preventDefault()}
            className="px-3 py-1.5 text-[12px] italic text-ink-4 hover:bg-surface-2 cursor-pointer"
            onClick={() => void select(null)}
          >
            Unassign
          </div>
          {staffQ.isLoading || staffQ.isRefetching ? (
            <div className="px-3 py-1.5 text-[12px] text-ink-4">Loading…</div>
          ) : staffQ.isError ? (
            <div className="px-3 py-1.5 text-[12px]">
              <span className="text-red">Couldn't load staff.</span>{" "}
              <button type="button" className="text-accent underline underline-offset-2" onMouseDown={(e) => e.preventDefault()} onClick={() => void staffQ.refetch()}>Retry</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-ink-4">No staff found.</div>
          ) : (
            filtered.map((s) => (
              <div
                key={s.email}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void select(s.email)}
                className={cn(
                  "px-3 py-1.5 text-[12px] hover:bg-surface-2 cursor-pointer",
                  s.email === value ? "font-medium text-ink" : "text-ink-2",
                )}
              >
                <span>{s.name}</span>
                <span className="ml-1.5 text-ink-4">{s.email}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Expanded detail panel (tabbed via RowExpandPanel) ─────────────────────────

type Likelihood = "low" | "medium" | "high";

const LIKELIHOOD_OPTIONS: { value: Likelihood; label: string }[] = [
  { value: "low",    label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high",   label: "High" },
];

const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: "5", label: "P1 — Highest" },
  { value: "4", label: "P2 — High" },
  { value: "3", label: "P3 — Medium" },
  { value: "2", label: "P4 — Low" },
  { value: "1", label: "P5 — Lowest" },
];

const SEGMENT_OPTIONS: { value: string; label: string }[] = [
  { value: "vc_pe",      label: "VC / PE" },
  { value: "enterprise", label: "Enterprise" },
  { value: "startup",    label: "Startup" },
  { value: "smb",        label: "SMB" },
  { value: "nonprofit",  label: "Nonprofit" },
  { value: "government", label: "Government" },
  { value: "other",      label: "Other" },
];

const SEGMENT_LABELS: Record<string, string> = Object.fromEntries(SEGMENT_OPTIONS.map((s) => [s.value, s.label]));
const CLOSED_LOST_LABELS: Record<string, string> = {
  budget: "No budget", timing: "Timing / not now", hired_elsewhere: "Hired elsewhere",
  not_a_fit: "Not a fit", no_response: "Went cold", role_cancelled: "Role cancelled", other: "Other",
};

/** Compact editable context strip at the top of an expanded deal: priority,
 *  segment, warm-intro attribution, and the closed-lost reason when applicable. */
function DealContextStrip({ deal }: { deal: JobsOpportunity }) {
  const updateOpp = useUpdateOpportunity();
  const deleteOpp = useDeleteOpportunity();
  const patch = (fields: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) =>
      updateOpp.mutate({ id: deal.id, ...fields }, { onSuccess: () => resolve(), onError: reject }),
    );
  const removeOpp = () => {
    if (window.confirm(`Delete the "${deal.account_name}" opportunity? This removes it from the pipeline.`)) {
      deleteOpp.mutate(deal.id);
    }
  };
  const isClosedLost = deal.stage === "closed_lost";
  // Priority + Segment are edited inline in the row now; the strip keeps the
  // overridable priority suggestion, warm-intro attribution, and closed-lost reason.
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-border-strong bg-surface-2/30 px-4 py-2">
      {deal.priority == null && deal.priority_suggested != null ? (
        <Field label="Suggested priority">
          <button
            type="button"
            onClick={() => void patch({ priority: deal.priority_suggested })}
            className="text-[12px] text-accent hover:underline"
            title="Apply the suggested priority to the row (you can change it)"
          >
            {PRIORITY_BADGE[deal.priority_suggested]?.label ?? deal.priority_suggested} · use
          </button>
        </Field>
      ) : null}
      <Field label="Owner">
        <div className="min-w-[160px]">
          <StaffPicker value={deal.owner_email} onChange={(email) => patch({ owner_email: email })} />
        </div>
      </Field>
      <Field label="Target close">
        <InlineDate value={deal.target_close_date} onSave={(v) => patch({ target_close_date: v || null })} />
      </Field>
      <Field label="Warm intro by">
        <InlineText value={deal.intro_by} placeholder="—" onSave={(v) => patch({ intro_by: v || null })} />
      </Field>
      {isClosedLost ? (
        <Field label="Closed-lost reason">
          <span className="text-[12px] text-ink-2">
            {deal.closed_lost_reason ? (CLOSED_LOST_LABELS[deal.closed_lost_reason] ?? deal.closed_lost_reason) : "—"}
            {deal.closed_lost_note ? <span className="text-ink-3"> — {deal.closed_lost_note}</span> : null}
          </span>
        </Field>
      ) : null}
      <button
        type="button"
        onClick={removeOpp}
        disabled={deleteOpp.isPending}
        className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-red-soft hover:text-red disabled:opacity-50"
        title="Delete this opportunity"
      >
        <Trash2 size={12} /> Delete
      </button>
    </div>
  );
}

/**
 * Tabbed expand panel matching PortfolioOpportunities. Drops below an
 * expanded deal row. Reuses the shared {@link RowExpandPanel} shell so the
 * jobs Opportunities tab feels identical to portfolio. All round-2
 * functionality (roles, builder activity, activity log, tasks, comments,
 * stage history, contacts) lives in dedicated tabs; tabs lazy-render so
 * hidden tabs don't fire their queries.
 */
function DealExpandPanel({
  deal,
}: {
  deal: JobsOpportunity;
}) {
  const detailQ = useJobsOpportunity(deal.id);
  const detail = detailQ.data;

  const tabs: ExpandTab[] = [
    {
      id: "activity",
      label: "Activity",
      count: detail?.activity?.length ?? null,
      render: () =>
        detailQ.isLoading ? (
          <TabLoading />
        ) : (
          <div className="flex flex-col">
            <ActivityTab entries={detail?.activity ?? []} />
            <LogActivityForm dealId={deal.id} />
          </div>
        ),
    },
    {
      id: "roles",
      label: "Roles",
      render: () => (
        <div className="px-4 py-3">
          <OppRolesSection oppId={deal.id} />
        </div>
      ),
    },
    {
      id: "builders",
      label: "Builders",
      render: () => (
        <div className="px-4 py-3">
          <BuildersTab deal={deal} />
        </div>
      ),
    },
    {
      id: "contacts",
      label: "Contacts",
      count: detail?.contacts?.length ?? null,
      render: () => (
        <div className="px-4 py-3">
          <ContactsTab deal={deal} detail={detail} loading={detailQ.isLoading} />
        </div>
      ),
    },
    {
      id: "tasks",
      label: "Tasks",
      render: () => (
        <div className="p-3">
          <JobsTasks parentType="opportunity" parentId={deal.id} />
        </div>
      ),
    },
    {
      id: "comments",
      label: "Comments",
      render: () => (
        <div className="p-3">
          <JobsComments parentType="opportunity" parentId={deal.id} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col">
      <DealContextStrip deal={deal} />
      <RowExpandPanel tabs={tabs} defaultTab="activity" />
    </div>
  );
}

function TabLoading() {
  return (
    <div className="flex items-center justify-center py-8 text-[12px] text-ink-3">Loading…</div>
  );
}

/**
 * Builders tab — link builders to the deal (builder_ids) and log/track their
 * applications + interviews against the opportunity. The linked-builder picker
 * moved here from the old Details tab.
 */
function BuildersTab({ deal }: { deal: JobsOpportunity }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Linked Builders">
        <BuilderPicker dealId={deal.id} builderIds={deal.builder_ids ?? []} />
      </Field>
      <OppBuilderActivity oppId={deal.id} />
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">{label}</span>
      <div>{children}</div>
    </div>
  );
}

// ── Log Activity inline form ──────────────────────────────────────────────────

type ActivityType = "call" | "text" | "linkedin";

const ACTIVITY_TYPES: { value: ActivityType; label: string }[] = [
  { value: "call",     label: "Call" },
  { value: "text",     label: "Text" },
  { value: "linkedin", label: "LinkedIn" },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function LogActivityForm({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType]   = useState<ActivityType>("call");
  const [date, setDate]   = useState(todayIso);
  const [desc, setDesc]   = useState("");

  const logActivity = useLogActivity();

  function reset() {
    setType("call");
    setDate(todayIso());
    setDesc("");
    setOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!desc.trim()) return;
    await logActivity.mutateAsync({
      jobs_opportunity_id: dealId,
      // Server accepts call/text/linkedin; ActivityCreateBody type is narrower.
      type: type as ActivityCreateBody["type"],
      description: desc.trim(),
      activity_date: date || todayIso(),
    });
    reset();
  }

  if (!open) {
    return (
      <div className="border-t border-border-strong px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[12px] text-accent hover:underline"
        >
          + Log Activity
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="border-t border-border-strong px-4 py-3 flex flex-col gap-2"
    >
      {/* Type selector — button group */}
      <div className="flex gap-1">
        {ACTIVITY_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setType(t.value)}
            className={cn(
              "rounded border px-2 py-0.5 text-[11px] font-medium transition-colors",
              type === t.value
                ? "border-accent bg-accent/5 text-accent"
                : "border-border-strong bg-surface text-ink-3 hover:text-ink-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Date */}
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />

      {/* Description */}
      <textarea
        rows={3}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="What happened?"
        className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={logActivity.isPending || !desc.trim()}
          className="rounded bg-accent px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {logActivity.isPending ? "Logging…" : "Log"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="text-[12px] text-ink-3 hover:text-ink-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Map a jobs activity row to the source/type the shared icon understands. */
function activityIconProps(e: import("@/services/jobs").ActivityEntry): { source: string; type: string } {
  if (e.source === "gmail-sync") return { source: "gmail", type: "email" };
  if (e.source === "calendar-sync") return { source: "calendar", type: "meeting" };
  if (e.source === "salesforce") return { source: "salesforce", type: e.type ?? "" };
  return { source: e.source ?? "", type: e.type ?? "" };
}

function ActivityRow({
  e,
  isExpanded,
  onToggle,
  onDelete,
}: {
  e: import("@/services/jobs").ActivityEntry;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const icon = activityIconProps(e);
  const preview = decodeEntities(e.description || e.email_snippet);
  const body = decodeEntities(e.email_body_text || e.description || e.email_snippet);
  return (
    <li
      className="cursor-pointer px-4 py-2.5 hover:bg-surface-2/40 transition-colors"
      onClick={onToggle}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          <ActivitySourceIcon source={icon.source} type={icon.type} size={15} />
        </span>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[12px] font-medium text-ink">
            {decodeEntities(e.subject) || e.type || "Activity"}
          </span>
          {!isExpanded && preview ? (
            <span className="text-[11.5px] text-ink-3 line-clamp-2">{preview}</span>
          ) : null}
          {e.logged_by ? (
            <span className="text-[10.5px] text-ink-4">by {e.logged_by}</span>
          ) : null}
          {isExpanded && (
            <div className="mt-1.5 flex flex-col gap-1">
              {e.email_from ? (
                <span className="text-[11px] text-ink-3">
                  <span className="font-medium">From:</span> {e.email_from}
                </span>
              ) : null}
              {e.email_to && e.email_to.length > 0 ? (
                <span className="text-[11px] text-ink-3">
                  <span className="font-medium">To:</span> {e.email_to.join(", ")}
                </span>
              ) : null}
              {e.meeting_duration_minutes != null ? (
                <span className="text-[11px] text-ink-3">
                  <span className="font-medium">Duration:</span> {e.meeting_duration_minutes} min
                </span>
              ) : null}
              {body ? (
                <p className="mt-0.5 max-h-72 overflow-y-auto whitespace-pre-wrap rounded bg-surface-2/40 p-2 text-[11.5px] leading-relaxed text-ink-2">
                  {body}
                </p>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10.5px] text-ink-4">
            {e.activity_date ? format(new Date(e.activity_date), "MMM d") : "—"}
          </span>
          {e.is_jobs ? (
            <button
              type="button"
              title="Delete activity"
              onClick={(ev) => {
                ev.stopPropagation();
                onDelete();
              }}
              className="text-ink-4 hover:text-red-500 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ActivitySection({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 bg-surface-2/50 px-4 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
        <span className="font-mono text-[10px] text-ink-4">{count}</span>
      </div>
      <ul className="divide-y divide-border-strong">{children}</ul>
    </div>
  );
}

/**
 * Activity tab — jobs-team logs separated from synced email/calendar so the
 * team can see what they did vs. what flowed in automatically. All activity for
 * the company (deal-tagged + account-level) is pulled in by the detail endpoint.
 */
function ActivityTab({
  entries,
}: {
  entries: import("@/services/jobs").ActivityEntry[];
}) {
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deleteActivity = useDeleteActivity();

  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No activity recorded yet.
      </div>
    );
  }

  // Search by participant (from/to/logged-by) and content (subject/body/snippet).
  // Fields may be null, strings, or arrays (email_to is text[]) — coerce safely.
  const q = query.trim().toLowerCase();
  const fieldText = (f: unknown): string =>
    Array.isArray(f) ? f.join(" ") : f == null ? "" : String(f);
  const matches = q
    ? entries.filter((e) =>
        [e.email_from, e.email_to, e.logged_by, e.subject, e.description, e.email_snippet, e.email_body_text]
          .some((f) => fieldText(f).toLowerCase().includes(q)),
      )
    : entries;

  const jobsEntries = matches.filter((e) => e.is_jobs);
  const syncedEntries = matches.filter((e) => !e.is_jobs);

  const renderRow = (e: import("@/services/jobs").ActivityEntry) => (
    <ActivityRow
      key={e.id}
      e={e}
      isExpanded={expandedActivityId === e.id}
      onToggle={() => setExpandedActivityId(expandedActivityId === e.id ? null : e.id)}
      onDelete={() => deleteActivity.mutate(e.id)}
    />
  );

  return (
    <div className="flex flex-col">
      {/* Participant / content search */}
      <div className="flex items-center gap-2 border-b border-border-strong px-4 py-2">
        <div className="relative flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by participant or content…"
            className="h-7 w-full rounded border border-border-strong bg-surface pl-7 pr-6 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
              title="Clear"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {matches.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-ink-3">No activity matches “{query}”.</div>
      ) : (
        <>
          {jobsEntries.length > 0 && (
            <ActivitySection label="Jobs activity" count={jobsEntries.length}>
              {jobsEntries.map(renderRow)}
            </ActivitySection>
          )}
          {syncedEntries.length > 0 && (
            <ActivitySection label="Email & calendar" count={syncedEntries.length}>
              {syncedEntries.map(renderRow)}
            </ActivitySection>
          )}
        </>
      )}
    </div>
  );
}



function contactInitials(contact: JobContact): string {
  if (contact.first_name && contact.last_name) {
    return (contact.first_name[0] + contact.last_name[0]).toUpperCase();
  }
  if (contact.full_name) {
    const parts = contact.full_name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
    }
    return contact.full_name.slice(0, 2).toUpperCase();
  }
  return "??";
}

/** A single linked contact: inline stage editor + expandable per-contact activity. */
function ContactRow({ contact }: { contact: JobContact }) {
  const [expanded, setExpanded] = useState(false);
  const detailQ = useContactDetail(expanded ? contact.contact_id : null);
  const activity = detailQ.data?.activity ?? [];

  const name =
    contact.full_name ?? (`${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "—");

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold leading-none text-accent-ink">
          {contactInitials(contact)}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold text-ink">{name}</span>
          {(contact.current_title || contact.current_company) ? (
            <span className="truncate text-[12px] text-ink-3">
              {[contact.current_title, contact.current_company].filter(Boolean).join(" @ ")}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {contact.email ? (
            <a href={`mailto:${contact.email}`} title={contact.email} className="text-ink-3 hover:text-accent">
              <Mail size={14} />
            </a>
          ) : null}
          {contact.linkedin_url ? (
            <a href={contact.linkedin_url} target="_blank" rel="noreferrer" title="LinkedIn" className="text-ink-3 hover:text-accent">
              <Linkedin size={14} />
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-ink-4 hover:text-ink-2"
            title="Show activity"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/30 px-4 py-2">
          {detailQ.isLoading ? (
            <span className="text-[11.5px] text-ink-4">Loading activity…</span>
          ) : activity.length === 0 ? (
            <span className="text-[11.5px] text-ink-4">No activity for this contact.</span>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {activity.slice(0, 12).map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 text-[11.5px] text-ink-2">
                    <span className="font-medium">{a.subject ?? a.type}</span>
                    {a.description ? <span className="text-ink-3"> — {a.description}</span> : null}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-4">
                    {a.activity_date ? format(new Date(a.activity_date), "MMM d") : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function ContactsTab({
  deal,
  detail,
  loading,
}: {
  deal: JobsOpportunity;
  detail: JobsOpportunityDetail | undefined;
  loading: boolean;
}) {
  const contacts = detail?.contacts ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Field label="Link a contact">
        {loading ? (
          <span className="text-[12px] text-ink-4">Loading…</span>
        ) : (
          <ContactPicker
            dealId={deal.id}
            sfContactIds={deal.sf_contact_ids ?? []}
            linkedContacts={contacts}
          />
        )}
      </Field>

      {contacts.length === 0 ? (
        <div className="py-4 text-center text-[12px] text-ink-3">No contacts linked to this deal.</div>
      ) : (
        <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
          {contacts.map((c) => (
            <ContactRow key={c.contact_id} contact={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Deal row ──────────────────────────────────────────────────────────────────

const STAGE_OPTIONS: { value: JobStage; label: string }[] = STAGES_ORDERED.map((s) => ({
  value: s,
  label: STAGE_LABELS[s],
}));

// Lead Submitted + Initial Outreach happen at the prospect/contact level — a deal
// becomes an Opportunity once it's active. So the opp stage picker drops them, but
// still shows a legacy value if a deal somehow already sits there.
const HIDDEN_OPP_STAGES = new Set<JobStage>(["lead_submitted"]);
const OPP_STAGE_OPTIONS = STAGE_OPTIONS.filter((o) => !HIDDEN_OPP_STAGES.has(o.value));
function stageOptionsFor(stage: JobStage): { value: JobStage; label: string }[] {
  return HIDDEN_OPP_STAGES.has(stage)
    ? [{ value: stage, label: STAGE_LABELS[stage] }, ...OPP_STAGE_OPTIONS]
    : OPP_STAGE_OPTIONS;
}

// Structured closed-lost reasons (drives the "why deals die" analysis).
const CLOSED_LOST_REASONS: { value: string; label: string }[] = [
  { value: "budget",          label: "No budget" },
  { value: "timing",          label: "Timing / not now" },
  { value: "hired_elsewhere", label: "Hired elsewhere" },
  { value: "not_a_fit",       label: "Not a fit" },
  { value: "no_response",     label: "Went cold / no response" },
  { value: "role_cancelled",  label: "Role cancelled" },
  { value: "other",           label: "Other" },
];

const DEAL_TYPE_OPTIONS: { value: DealType; label: string }[] = (
  Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]
).map(([value, label]) => ({ value, label }));

// ── Column model (mirrors the portfolio Accounts table) ───────────────────────

type OppColKey =
  | "company" | "role" | "salary" | "stage" | "status" | "deal_type"
  | "priority" | "segment" | "likelihood" | "num_roles" | "owner" | "target_close" | "tasks" | "recent" | "updated";

const OPP_COLUMN_ORDER: OppColKey[] = [
  "company", "role", "salary", "stage", "status", "deal_type",
  "priority", "segment", "likelihood", "num_roles", "owner", "target_close", "tasks", "recent", "updated",
];

const OPP_DEFAULT_VISIBLE: OppColKey[] = [
  "company", "role", "salary", "stage", "status", "deal_type", "priority", "segment", "owner", "target_close", "tasks",
];

const OPP_COL_LABELS: Record<OppColKey, string> = {
  company: "Company", role: "Role", salary: "Salary", stage: "Stage", status: "Status",
  deal_type: "Deal Type", priority: "Priority", segment: "Segment", likelihood: "Likelihood",
  num_roles: "# Roles", owner: "Owner", target_close: "Target close", tasks: "Open tasks", recent: "Recent activity", updated: "Updated",
};

const OPP_DEFAULT_WIDTHS: Record<OppColKey, number> = {
  company: 280, role: 210, salary: 120, stage: 210, status: 104, deal_type: 140,
  priority: 96, segment: 150, likelihood: 116, num_roles: 84, owner: 190, target_close: 118, tasks: 96, recent: 120, updated: 120,
};

const LIKELIHOOD_RANK: Record<Likelihood, number> = { low: 1, medium: 2, high: 3 };

/** Sort accessor per column. */
function extractOpp(d: JobsOpportunity, key: OppColKey): string | number {
  switch (key) {
    case "company":    return d.account_name ?? "";
    case "role":       return d.title ?? "";
    case "salary":     return d.salary_expected ?? 0;
    case "stage":      return STAGE_LABELS[d.stage] ?? "";
    case "status":     return stageStatus(d.stage);
    case "deal_type":  return d.deal_type ? DEAL_TYPE_LABELS[d.deal_type] : "";
    case "priority":   return d.priority ?? 0;
    case "segment":    return d.segment ? (SEGMENT_LABELS[d.segment] ?? d.segment) : "";
    case "likelihood": return d.likelihood ? LIKELIHOOD_RANK[d.likelihood] : 0;
    case "num_roles":  return d.num_roles ?? 0;
    case "owner":      return d.owner_email ?? "";
    case "target_close": return d.target_close_date ?? "";
    case "tasks":      return d.open_tasks ?? 0;
    case "recent":     return d.recent_activity_count ?? 0;
    case "updated":    return d.updated_at ?? "";
  }
}

// ── Filter rules + group-by metadata (reuses the Cleanup/Accounts rules rig) ──

type OppField =
  | "company" | "role" | "stage" | "status" | "deal_type" | "segment"
  | "priority" | "likelihood" | "owner" | "salary" | "num_roles" | "target_close" | "recent" | "updated";

const OPP_FILTERABLE: Record<OppField, FieldMeta<JobsOpportunity>> = {
  company:    { label: "Company",    type: "text",   getValue: (d) => d.account_name ?? "" },
  role:       { label: "Role",       type: "text",   getValue: (d) => d.title ?? "" },
  stage:      { label: "Stage",      type: "select", getValue: (d) => d.stage },
  status:     { label: "Status",     type: "select", getValue: (d) => stageStatus(d.stage) },
  deal_type:  { label: "Deal type",  type: "select", getValue: (d) => d.deal_type ?? "" },
  segment:    { label: "Segment",    type: "select", getValue: (d) => d.segment ?? "" },
  priority:   { label: "Priority",   type: "select", getValue: (d) => (d.priority != null ? String(d.priority) : "") },
  likelihood: { label: "Likelihood", type: "select", getValue: (d) => d.likelihood ?? "" },
  owner:      { label: "Owner",      type: "select", getValue: (d) => d.owner_email ?? "" },
  target_close: { label: "Target close date", type: "date", getValue: (d) => d.target_close_date ?? "" },
  salary:     { label: "Salary",     type: "number", getValue: (d) => d.salary_expected ?? null },
  num_roles:  { label: "# Roles",    type: "number", getValue: (d) => d.num_roles ?? null },
  recent:     { label: "Recent activity (7d)", type: "number", getValue: (d) => d.recent_activity_count ?? 0 },
  updated:    { label: "Updated",    type: "date",   getValue: (d) => d.updated_at ?? null },
};

const OPP_GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: "",          label: "No grouping" },
  { value: "segment",   label: "Group by Segment" },
  { value: "owner",     label: "Group by Owner" },
  { value: "deal_type", label: "Group by Deal type" },
  { value: "stage",     label: "Group by Stage" },
  { value: "status",    label: "Group by Status" },
];

// Columns whose <td> should swallow clicks (inline editors) so editing
// doesn't toggle the row's expand.
const OPP_EDITABLE_COLS = new Set<OppColKey>([
  "role", "salary", "stage", "deal_type", "likelihood", "priority", "segment", "num_roles", "owner", "target_close",
]);

function DealRow({
  deal,
  isExpanded,
  onToggle,
  onRecordPlacements,
  onCommittedRoles,
  onClosedLost,
  visibleCols,
}: {
  deal: JobsOpportunity;
  isExpanded: boolean;
  onToggle: () => void;
  onRecordPlacements: (deal: { id: string; account_name: string }) => void;
  onCommittedRoles: (deal: { id: string; account_name: string }) => void;
  onClosedLost: (deal: { id: string; account_name: string }) => void;
  visibleCols: OppColKey[];
}) {
  const updateOpp = useUpdateOpportunity();

  // Only full-time / part-time-contract wins produce job placements.
  // Capstone, volunteer, workshop, pilot wins are outcomes but not secured jobs.
  const isPlacementType = deal.deal_type === "ft" || deal.deal_type === "pt_contract";

  function patch(fields: Record<string, unknown>) {
    return new Promise<void>((resolve, reject) => {
      updateOpp.mutate({ id: deal.id, ...fields }, { onSuccess: () => resolve(), onError: reject });
    });
  }

  /** Stage change fires the committed-roles / placements / closed-lost modals. */
  function saveStage(stage: JobStage) {
    if (stage === deal.stage) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      updateOpp.mutate(
        { id: deal.id, stage },
        {
          onSuccess: () => {
            if (stage === "closed_won" && isPlacementType) {
              onRecordPlacements({ id: deal.id, account_name: deal.account_name });
            } else if (stage === "closed_lost") {
              onClosedLost({ id: deal.id, account_name: deal.account_name });
            } else if (stage === "active_opportunity_confirmed" && (deal.num_roles ?? 0) === 0) {
              onCommittedRoles({ id: deal.id, account_name: deal.account_name });
            }
            resolve();
          },
          onError: reject,
        },
      );
    });
  }

  const cells: Record<OppColKey, React.ReactNode> = {
    company: (
      <div className="flex min-w-0 items-center gap-2">
        {isExpanded ? (
          <ChevronDown size={13} className="shrink-0 text-ink-4" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-ink-4" />
        )}
        <span className="truncate text-[13px] font-semibold text-ink">{deal.account_name}</span>
        <RecentActivityDot recent={deal.recent_activity_count} last={deal.last_activity_at} />
      </div>
    ),
    role: (
      <InlineText value={deal.title} placeholder="Add role title…" onSave={(v) => patch({ title: v || null })} />
    ),
    salary: (
      <InlineText
        value={deal.salary_expected != null ? String(deal.salary_expected) : ""}
        placeholder="—"
        formatDisplay={(raw) => {
          const n = Number(raw.replace(/[^0-9.]/g, ""));
          return isNaN(n) ? raw : `$${n.toLocaleString("en-US")}`;
        }}
        onSave={(v) => {
          const n = v === "" ? null : Number(v.replace(/[^0-9.]/g, ""));
          return patch({ salary_expected: n === null || isNaN(n) ? null : n });
        }}
      />
    ),
    stage: (
      <InlineSelect<JobStage>
        value={deal.stage}
        options={stageOptionsFor(deal.stage)}
        onSave={saveStage}
        renderValue={(v) => (
          <span className="flex items-center gap-1 text-[12.5px] text-ink-2">
            <span className="truncate">{v ? STAGE_LABELS[v] : "—"}</span>
            <ChevronDown size={12} className="shrink-0 text-ink-4" />
          </span>
        )}
      />
    ),
    status: <StatusChip stage={deal.stage} />,
    deal_type: (
      <InlineSelect<DealType>
        value={deal.deal_type}
        options={DEAL_TYPE_OPTIONS}
        emptyLabel="—"
        onSave={(v) => patch({ deal_type: v })}
      />
    ),
    likelihood: (
      <InlineSelect<Likelihood>
        value={deal.likelihood}
        options={LIKELIHOOD_OPTIONS}
        emptyLabel="—"
        onSave={(v) => patch({ likelihood: v })}
      />
    ),
    priority: (
      <InlineSelect<string>
        value={deal.priority != null ? String(deal.priority) : null}
        options={PRIORITY_OPTIONS}
        emptyLabel="—"
        renderValue={(v) => (v ? <PriorityBadge priority={Number(v)} /> : <span className="text-ink-4">—</span>)}
        onSave={(v) => patch({ priority: v ? Number(v) : null })}
      />
    ),
    segment: (
      <InlineSelect<string>
        value={deal.segment ?? null}
        options={SEGMENT_OPTIONS}
        emptyLabel="—"
        renderValue={(v) =>
          v ? <span className="text-[12px] text-ink-2">{SEGMENT_LABELS[v] ?? v}</span> : <span className="text-ink-4">—</span>
        }
        onSave={(v) => patch({ segment: v || null })}
      />
    ),
    num_roles: (
      <InlineText
        value={deal.num_roles != null ? String(deal.num_roles) : ""}
        placeholder="—"
        className="justify-end text-right"
        onSave={(v) => {
          if (v.trim() === "") return patch({ num_roles: null });
          const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
          return patch({ num_roles: isNaN(n) ? null : n });
        }}
      />
    ),
    owner: <StaffPicker value={deal.owner_email} onChange={(email) => patch({ owner_email: email })} />,
    target_close: <InlineDate value={deal.target_close_date} onSave={(v) => patch({ target_close_date: v || null })} />,
    tasks: (deal.open_tasks ?? 0) > 0
      ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><CheckSquare size={11} className="text-ink-4" />{deal.open_tasks}</span>
      : <span className="text-ink-4">—</span>,
    recent: deal.recent_activity_count
      ? <RecentActivityDot recent={deal.recent_activity_count} last={deal.last_activity_at} />
      : <span className="text-ink-4">—</span>,
    updated: (
      <span className="font-mono text-[11px] text-ink-4" title={fmtShortDate(deal.updated_at)}>
        {fmtRelative(deal.updated_at)}
      </span>
    ),
  };

  return (
    <Fragment>
      <tr
        className={cn(
          "cursor-pointer border-t border-border-strong transition-colors",
          isExpanded ? "bg-surface-2/60" : "hover:bg-surface-2/40",
        )}
        onClick={onToggle}
      >
        {visibleCols.map((key, i) => (
          <td
            key={key}
            className={cn(
              "overflow-hidden px-3 py-1.5 align-middle",
              key === "num_roles" && "text-right tabular-nums",
              // Pinned identity column — keeps the company visible while the
              // grid scrolls horizontally. Opaque bg so rows slide under it.
              i === 0 && "sticky left-0 z-10 bg-surface",
            )}
            onClick={OPP_EDITABLE_COLS.has(key) ? (e) => e.stopPropagation() : undefined}
          >
            {cells[key]}
          </td>
        ))}
      </tr>

      {isExpanded ? (
        <tr>
          <td colSpan={visibleCols.length} className="p-0">
            <DealExpandPanel deal={deal} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

// ── New Deal modal ────────────────────────────────────────────────────────────

interface NewDealForm {
  companyName: string;
  stage: JobStage;
  dealType: DealType | "";
  name: string;          // freeform opportunity name (opp = the ongoing conversation, not one role)
  owner: string;
  expectedSalary: string;
  notes: string;
}

const DEFAULT_NEW_DEAL_FORM: NewDealForm = {
  companyName: "",
  stage: "lead_submitted",
  dealType: "",
  name: "",
  owner: "",
  expectedSalary: "",
  notes: "",
};

function NewDealModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [form, setForm] = useState<NewDealForm>(DEFAULT_NEW_DEAL_FORM);
  const createOpportunity = useCreateOpportunity();

  function set<K extends keyof NewDealForm>(key: K, value: NewDealForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.companyName.trim()) return;

    const salary = form.expectedSalary.trim()
      ? Number(form.expectedSalary.replace(/[^0-9.]/g, ""))
      : undefined;

    const created = await createOpportunity.mutateAsync({
      account_id: "UNKNOWN",
      account_name: form.companyName.trim(),
      stage: form.stage,
      deal_type: form.dealType || null,
      title: form.name.trim() || undefined,
      owner_email: form.owner.trim() || undefined,
      salary_expected: salary != null && !isNaN(salary) ? salary : undefined,
      description: form.notes.trim() || undefined,
    } as Partial<JobsOpportunity>);

    onClose();
    if (created?.id) nav(jobsOpportunityPath(created.id));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">New Opportunity</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 px-5 py-4">
          {/* Company Name */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Company Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.companyName}
              onChange={(e) => set("companyName", e.target.value)}
              placeholder="Acme Corp"
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          {/* Stage */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Stage <span className="text-red-500">*</span>
            </label>
            <select
              value={form.stage}
              onChange={(e) => set("stage", e.target.value as JobStage)}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {STAGES_ORDERED.map((s) => (
                <option key={s} value={s}>{STAGE_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {/* Deal Type + Role Title (two columns) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Deal Type</label>
              <select
                value={form.dealType}
                onChange={(e) => set("dealType", e.target.value as DealType | "")}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                <option value="">— none —</option>
                {(Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Opportunity Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Spring 2026 hiring conversation"
                title="Name the opportunity freely — it can hold several roles. Add roles once it's confirmed."
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
          </div>

          {/* Owner + Expected Salary (two columns) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Owner</label>
              <input
                type="text"
                value={form.owner}
                onChange={(e) => set("owner", e.target.value)}
                placeholder="avni@pursuit.org"
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Expected Salary</label>
              <input
                type="number"
                value={form.expectedSalary}
                onChange={(e) => set("expectedSalary", e.target.value)}
                placeholder="85000"
                min={0}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
          </div>

          {/* Notes */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Add any initial notes…"
              className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] font-medium text-ink-3 hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createOpportunity.isPending || !form.companyName.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {createOpportunity.isPending ? (
                <Spinner />
              ) : (
                <Plus size={13} />
              )}
              {createOpportunity.isPending ? "Creating…" : "Create Opportunity"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Record Placements modal ───────────────────────────────────────────────────

const EMPLOYMENT_TYPES: { value: string; label: string }[] = [
  { value: "full_time", label: "Full-Time" },
  { value: "contract",  label: "Contract" },
  { value: "freelance", label: "Freelance" },
  { value: "pro_bono",  label: "Pro Bono" },
];

const EMPLOYMENT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  EMPLOYMENT_TYPES.map((t) => [t.value, t.label]),
);

function PlacementsModal({
  deal,
  onClose,
}: {
  deal: { id: string; account_name: string };
  onClose: () => void;
}) {
  const placementsQ = useOppPlacements(deal.id);
  const placements = placementsQ.data ?? [];
  const createPlacement = useCreatePlacement();

  // New placement sub-form
  const [builderSearch, setBuilderSearch] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builder, setBuilder] = useState<{ user_id: number; name: string } | null>(null);
  const [roleTitle, setRoleTitle] = useState("");
  const [employmentType, setEmploymentType] = useState("full_time");
  const [salary, setSalary] = useState("");

  const buildersQ = useBuilders(builderSearch || undefined);
  const builderResults = buildersQ.data ?? [];

  // Link-existing section
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkSearch, setLinkSearch] = useState("");
  const unlinkedQ = useUnlinkedPlacements(linkOpen ? linkSearch : "");
  const unlinked = linkOpen ? (unlinkedQ.data ?? []) : [];
  const linkPlacement = useLinkPlacement();

  const linkedIds = new Set(placements.map((p) => p.id));

  function resetSubForm() {
    setBuilder(null);
    setBuilderSearch("");
    setRoleTitle("");
    setEmploymentType("full_time");
    setSalary("");
  }

  function handleAddPlacement(e: React.FormEvent) {
    e.preventDefault();
    if (!builder) return;
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : undefined;
    createPlacement.mutate(
      {
        oppId: deal.id,
        builder_user_id: builder.user_id,
        builder_name: builder.name,
        role_title: roleTitle.trim() || undefined,
        employment_type: employmentType,
        salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
      },
      { onSuccess: () => resetSubForm() },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border-strong bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">
            Record Placements for {deal.account_name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
          {/* Currently linked placements */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Linked Placements
            </span>
            {placementsQ.isLoading ? (
              <span className="text-[12px] text-ink-3">Loading…</span>
            ) : placements.length === 0 ? (
              <span className="text-[12px] text-ink-3">No placements recorded yet.</span>
            ) : (
              <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
                {placements.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium text-ink">{p.builder}</span>
                      <span className="truncate text-[11.5px] text-ink-3">
                        {[p.role_title, EMPLOYMENT_TYPE_LABELS[p.employment_type] ?? p.employment_type]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    {p.salary != null ? (
                      <span className="shrink-0 font-mono text-[11.5px] text-ink-3">
                        ${p.salary.toLocaleString("en-US")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add a new placement */}
          <form onSubmit={handleAddPlacement} className="flex flex-col gap-3 rounded-md border border-border-strong p-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Add a Placement
            </span>

            {/* Builder picker */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-ink-3">Builder</label>
              {builder ? (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2">
                    {builder.name}
                    <button
                      type="button"
                      onClick={() => { setBuilder(null); setBuilderSearch(""); }}
                      className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
                      title="Clear builder"
                    >
                      <X size={11} />
                    </button>
                  </span>
                </div>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={builderSearch}
                    onFocus={() => setBuilderOpen(true)}
                    onBlur={() => setTimeout(() => setBuilderOpen(false), 150)}
                    onChange={(e) => { setBuilderSearch(e.target.value); setBuilderOpen(true); }}
                    placeholder="Search builders…"
                    className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                  />
                  {builderOpen && builderResults.length > 0 && (
                    <ul className="absolute z-20 mt-1 max-h-[160px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
                      {builderResults.slice(0, 12).map((b) => (
                        <li key={b.user_id}>
                          <button
                            type="button"
                            onMouseDown={() => {
                              setBuilder({ user_id: b.user_id, name: b.name });
                              setBuilderOpen(false);
                              setBuilderSearch("");
                            }}
                            className="w-full px-3 py-1.5 text-left text-[12px] text-ink hover:bg-surface-2"
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
            </div>

            {/* Role title */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-ink-3">Role Title</label>
              <input
                type="text"
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                placeholder="Software Engineer"
                className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>

            {/* Employment type + Salary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-ink-3">Employment Type</label>
                <select
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value)}
                  className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
                >
                  {EMPLOYMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-ink-3">Salary</label>
                <input
                  type="number"
                  value={salary}
                  onChange={(e) => setSalary(e.target.value)}
                  placeholder="85000"
                  min={0}
                  className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={!builder || createPlacement.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {createPlacement.isPending ? <Spinner /> : <Plus size={12} />}
                {createPlacement.isPending ? "Adding…" : "Add Placement"}
              </button>
            </div>
          </form>

          {/* Link an existing placement */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setLinkOpen((v) => !v)}
              className="flex items-center gap-1.5 self-start text-[12px] font-medium text-accent hover:underline"
            >
              {linkOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Link existing
            </button>
            {linkOpen && (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  placeholder="Search unlinked placements…"
                  className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                {unlinkedQ.isLoading ? (
                  <span className="text-[12px] text-ink-3">Searching…</span>
                ) : unlinked.length === 0 ? (
                  <span className="text-[12px] text-ink-4">No unlinked placements found.</span>
                ) : (
                  <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
                    {unlinked.map((row: OppPlacement) => (
                      <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-[12.5px] font-medium text-ink">{row.builder}</span>
                          <span className="truncate text-[11px] text-ink-3">
                            {[row.role_title, row.company_name].filter(Boolean).join(" @ ")}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={linkedIds.has(row.id) || linkPlacement.isPending}
                          onClick={() => linkPlacement.mutate({ oppId: deal.id, placementId: row.id })}
                          className="shrink-0 rounded border border-border-strong bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {linkedIds.has(row.id) ? "Linked" : "Link"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-border-strong px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Closed-lost reason modal ──────────────────────────────────────────────────

function ClosedLostModal({
  deal,
  onClose,
}: {
  deal: { id: string; account_name: string };
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const updateOpp = useUpdateOpportunity();

  function save() {
    updateOpp.mutate(
      { id: deal.id, closed_lost_reason: reason || null, closed_lost_note: note.trim() || null },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">Why did {deal.account_name} fall through?</h2>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              <option value="">— select —</option>
              {CLOSED_LOST_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Note (optional)</label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Context — what happened, who said what…"
              className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border-strong px-5 py-3">
          <button type="button" onClick={onClose} className="text-[13px] font-medium text-ink-3 hover:text-ink">
            Skip
          </button>
          <button
            type="button"
            onClick={save}
            disabled={updateOpp.isPending}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {updateOpp.isPending ? "Saving…" : "Save reason"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type DealTypeFilter = "all" | DealType;

// Persisted shape for Saved Views (personal + global) on the Opportunities tab —
// mirrors the Accounts payload: quick filter, search, chip rules, columns, widths,
// group-by, and sort.
interface JobsOppView {
  dealTypeFilter?: DealTypeFilter;
  query?: string;
  rules?: FilterRule<OppField>[];
  visibleCols?: OppColKey[];
  widths?: Partial<Record<OppColKey, number>>;
  groupBy?: string;
  sort?: SortState<OppColKey>;
}

// Stable empty array so useSessionState's setter identity stays stable.
const EMPTY_COLLAPSED: string[] = [];

export function JobsTeam() {
  // Deal-type pills were removed (filter via the Filter rules instead); default
  // to all deals. The state stays for saved-view back-compat + the FT-via-rule path.
  const [dealTypeFilter, setDealTypeFilter] = useState<DealTypeFilter>("all");
  const [query, setQuery] = useState("");
  const [rules, setRules] = useState<FilterRule<OppField>[]>([]);
  const [groupBy, setGroupBy] = useSessionState<string>("jobs-opps:groupBy", "");
  const [collapsedGroups, setCollapsedGroups] = useSessionState<string[]>("jobs-opps:groupCollapsed", EMPTY_COLLAPSED);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [placementModalDeal, setPlacementModalDeal] = useState<{ id: string; account_name: string } | null>(null);
  const [committedRolesDeal, setCommittedRolesDeal] = useState<{ id: string; account_name: string } | null>(null);
  const [closedLostDeal, setClosedLostDeal] = useState<{ id: string; account_name: string } | null>(null);

  const { sort, toggle, setSort } = useSort<OppColKey>({ key: "priority", direction: "desc" });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<OppColKey>("bedrock-v2:vis:jobs-opportunities", OPP_COLUMN_ORDER, OPP_DEFAULT_VISIBLE);
  const { widths, startResize, replaceAll: replaceWidths } =
    useColumnWidths<OppColKey>("bedrock-v2:cols:jobs-opportunities:v2", OPP_DEFAULT_WIDTHS);

  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsedGroups((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])),
    [setCollapsedGroups],
  );

  // Small dataset — load all opps and filter/sort/group client-side (mirrors Accounts).
  const { data: rawData, isLoading } = useJobsOpportunities({ limit: 500 });
  const allDeals: JobsOpportunity[] = (rawData as { data: JobsOpportunity[]; total: number } | undefined)?.data ?? [];

  // Owner facet for the chip-filter + group labels.
  const ownerOptions = useMemo(() => {
    const m = new Map<string, string>(OWNERS.map((o) => [o.email, o.label]));
    for (const d of allDeals) if (d.owner_email && !m.has(d.owner_email)) m.set(d.owner_email, d.owner_email);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [allDeals]);
  const ownerLabel = useCallback(
    (email: string) => OWNERS.find((o) => o.email === email)?.label ?? email,
    [],
  );

  const selectOptions: Partial<Record<OppField, { value: string; label: string }[]>> = useMemo(
    () => ({
      stage: OPP_STAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      status: STATUS_OPTIONS,
      deal_type: DEAL_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      segment: SEGMENT_OPTIONS,
      priority: PRIORITY_OPTIONS,
      likelihood: LIKELIHOOD_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      owner: ownerOptions,
    }),
    [ownerOptions],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const f = allDeals.filter((d) => {
      if (dealTypeFilter !== "all" && d.deal_type !== dealTypeFilter) return false;
      if (
        q &&
        !(
          d.account_name.toLowerCase().includes(q) ||
          (d.title ?? "").toLowerCase().includes(q) ||
          (d.owner_email ?? "").toLowerCase().includes(q)
        )
      )
        return false;
      for (const r of rules) if (!ruleApplies(d, r, OPP_FILTERABLE)) return false;
      return true;
    });
    return sort.key == null ? f : sortBy(f, sort, (d, key) => extractOpp(d, key));
  }, [allDeals, dealTypeFilter, q, rules, sort]);

  const groupLabelFor = useCallback(
    (k: string) => {
      if (k === "") return "—";
      if (groupBy === "owner") return ownerLabel(k);
      if (groupBy === "segment") return SEGMENT_LABELS[k] ?? k;
      if (groupBy === "deal_type") return DEAL_TYPE_LABELS[k as DealType] ?? k;
      if (groupBy === "stage") return STAGE_LABELS[k as JobStage] ?? k;
      if (groupBy === "status") return STATUS_OPTIONS.find((s) => s.value === k)?.label ?? k;
      if (groupBy === "likelihood") return LIKELIHOOD_OPTIONS.find((l) => l.value === k)?.label ?? k;
      return k;
    },
    [groupBy, ownerLabel],
  );

  type DisplayRow =
    | { kind: "row"; deal: JobsOpportunity }
    | { kind: "header"; key: string; label: string; count: number; collapsed: boolean };
  const groupedRows: DisplayRow[] | null = useMemo(() => {
    if (!groupBy) return null;
    const field = OPP_FILTERABLE[groupBy as OppField];
    if (!field) return null;
    const buckets = new Map<string, JobsOpportunity[]>();
    for (const d of filtered) {
      const raw = field.getValue(d);
      const k = raw == null || raw === "" ? "" : String(raw);
      const list = buckets.get(k);
      if (list) list.push(d);
      else buckets.set(k, [d]);
    }
    const keys = [...buckets.keys()].sort((a, b) => groupLabelFor(a).localeCompare(groupLabelFor(b)));
    const out: DisplayRow[] = [];
    for (const k of keys) {
      const list = buckets.get(k) ?? [];
      const collapsed = collapsedSet.has(k);
      out.push({ kind: "header", key: k, label: groupLabelFor(k), count: list.length, collapsed });
      if (!collapsed) for (const d of list) out.push({ kind: "row", deal: d });
    }
    return out;
  }, [filtered, groupBy, collapsedSet, groupLabelFor]);

  const tableMinWidth = visibleCols.reduce((s, k) => s + widths[k], 0);

  const renderDealRow = (deal: JobsOpportunity) => (
    <DealRow
      key={deal.id}
      deal={deal}
      isExpanded={expandedId === deal.id}
      onToggle={() => setExpandedId(expandedId === deal.id ? null : deal.id)}
      onRecordPlacements={setPlacementModalDeal}
      onCommittedRoles={setCommittedRolesDeal}
      onClosedLost={setClosedLostDeal}
      visibleCols={visibleCols}
    />
  );

  return (
    <div className="flex flex-col px-5 py-2">
      <Toolbar>
        <div className="relative">
          <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            placeholder="Search company, role, owner…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-56 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
        <AddFilterButton<OppField>
          filterable={OPP_FILTERABLE as Record<OppField, FieldMeta<unknown>>}
          selectOptions={selectOptions}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <select
          value={groupBy}
          onChange={(e) => {
            setGroupBy(e.target.value);
            setCollapsedGroups([]);
          }}
          title="Group rows by a field"
          className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent"
        >
          {OPP_GROUP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="font-mono text-[12px] text-ink-4">
          {isLoading ? "…" : `${filtered.length} deal${filtered.length === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser
            allColumns={OPP_COLUMN_ORDER}
            labels={OPP_COL_LABELS}
            visible={visibleCols}
            required={["company"]}
            onToggle={toggleCol}
          />
          <SavedViewsPicker<JobsOppView>
            scopeKey="jobs-opportunities"
            currentFilters={{ dealTypeFilter, query, rules, visibleCols, widths, groupBy, sort }}
            onLoad={(v) => {
              setDealTypeFilter(v.dealTypeFilter ?? "all");
              setQuery(v.query ?? "");
              setRules(v.rules ?? []);
              setGroupBy(v.groupBy ?? "");
              setCollapsedGroups([]);
              if (v.visibleCols && v.visibleCols.length > 0) replaceVisibleCols(v.visibleCols);
              if (v.widths && Object.keys(v.widths).length > 0) replaceWidths(v.widths);
              if (v.sort) setSort(v.sort);
            }}
          />
          <button
            type="button"
            onClick={() => setShowNewDeal(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"
          >
            <Plus size={13} /> New Opportunity
          </button>
        </div>
      </Toolbar>

      {/* Active filter chips */}
      {rules.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, OPP_FILTERABLE, (field, v) => {
                if (field === "owner") return ownerLabel(v);
                if (field === "segment") return SEGMENT_LABELS[v] ?? v;
                if (field === "deal_type") return DEAL_TYPE_LABELS[v as DealType] ?? v;
                if (field === "stage") return STAGE_LABELS[v as JobStage] ?? v;
                if (field === "status") return STATUS_OPTIONS.find((s) => s.value === v)?.label ?? v;
                if (field === "priority") return PRIORITY_OPTIONS.find((p) => p.value === v)?.label ?? v;
                return v;
              })}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules([])}
            className="ml-1 whitespace-nowrap text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {showNewDeal && <NewDealModal onClose={() => setShowNewDeal(false)} />}
      {placementModalDeal && <PlacementsModal deal={placementModalDeal} onClose={() => setPlacementModalDeal(null)} />}
      {committedRolesDeal && <CommittedRolesModal deal={committedRolesDeal} onClose={() => setCommittedRolesDeal(null)} />}
      {closedLostDeal && <ClosedLostModal deal={closedLostDeal} onClose={() => setClosedLostDeal(null)} />}

      <div
        className="overflow-auto rounded-b-lg border border-border-strong bg-surface"
        style={{ maxHeight: "calc(100vh - 220px)" }}
      >
        {/* Bounded data-grid viewport: the table scrolls BOTH axes inside this
            container (header stays put on the long scroll down; identity
            column pins during horizontal scroll). Columns keep their real
            pixel widths — squeezing them proportionally made narrow windows
            unreadable. */}
        <table className="w-full border-collapse" style={{ tableLayout: "fixed", minWidth: tableMinWidth }}>
          <colgroup>{visibleCols.map((key) => <col key={key} style={{ width: widths[key] }} />)}</colgroup>
          <thead className="sticky top-0 z-20">
            <tr>
              {visibleCols.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align={key === "num_roles" || key === "salary" ? "right" : "left"}
                  isLast={idx === visibleCols.length - 1}
                  className={idx === 0 ? "sticky left-0 z-30" : undefined}
                >
                  <SortableHeader label={OPP_COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">
                  Loading deals…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">
                  No deals match your filters.{" "}
                  <button
                    type="button"
                    className="text-accent underline underline-offset-2"
                    onClick={() => { setDealTypeFilter("all"); setQuery(""); setRules([]); }}
                  >
                    Clear filters
                  </button>
                </td>
              </tr>
            ) : groupedRows ? (
              groupedRows.map((item) =>
                item.kind === "header" ? (
                  <tr
                    key={`grp-${item.key}`}
                    className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2"
                    onClick={() => toggleGroup(item.key)}
                  >
                    <td colSpan={visibleCols.length} className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2">
                      <span className="inline-block w-3 text-ink-3">{item.collapsed ? "▸" : "▾"}</span>
                      {item.label}
                      <span className="ml-2 normal-case tracking-normal text-ink-3">{item.count}</span>
                    </td>
                  </tr>
                ) : (
                  renderDealRow(item.deal)
                ),
              )
            ) : (
              filtered.map((deal) => renderDealRow(deal))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
