/**
 * Jobs · Contacts — contact-level view.
 *
 * Configurable table like the rest of the app: search, per-column filters,
 * group-by, sortable headers, column chooser, saved views. Fluid layout (no
 * horizontal scroll). Rows show connected LinkedIn staff and expand inline to
 * the contact's tabs. The cross-source "find any contact" search + Add-to-Jobs
 * preview + New Contact sit above the table.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Briefcase, CheckSquare, ChevronsDownUp, ChevronsUpDown, ExternalLink, Linkedin, MessageSquare, Plus, Search, X, Zap } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { ContactDetail, initials } from "@/components/jobs/ProspectAccountExpandPanel";
import { ContactExpandTabs, jobsAccountPath, jobsContactPath } from "@/components/jobs/jobsEntity";
import { CompanyPicker } from "@/components/jobs/CompanyPicker";
import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { ExportButton } from "@/components/jobs/ExportButton";
import { withReferrer } from "@/components/detail";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { accountStatusVariant } from "@/lib/accountStatus";
import { RECENCY_OPTIONS, recencyLabel } from "@/lib/recencyFilter";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { useContactStageChange } from "@/lib/useContactStageChange";
import { useColumnWidths } from "@/lib/columnWidths";
import { ResizableTh, ColGroup } from "@/components/ui/ResizableTable";
import { useSessionState } from "@/lib/useSessionState";
import { useSort, sortBy, type SortState } from "@/lib/sort";
import {
  AddFilterButton, FilterChip, describeRule, ruleApplies, serializeRulesForServer,
  type FieldMeta, type FilterRule,
} from "@/pages/cleanup/Filters";
import { cn } from "@/lib/utils";
import {
  useJobsContacts, useAddContactToJobs, useJobsAccounts, type JobsAccount,
  useContactDetail, useCreateContact, STAGE_LABELS,
  useFlagContactsForJobs, useUnflagJobsContact, useUpdateJobsMembership, MEMBERSHIP_STAGE_LABELS, MEMBERSHIP_STAGES,
  useContactTagCatalog, useStaff, useUpdateContact, useBulkContactOwner, useBulkProspect,
  type JobStage, type JobContactWithDeal, type ContactSearchResult, type ContactCreateBody, type MembershipStage,
  exportJobsRows,
} from "@/services/jobs";

// Humanize a tag slug so chips never flash the raw slug (e.g. "prior_commit_partner")
// while the catalog query is still loading — reads as the friendly label instantly.
function humanizeTag(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

// ── last touch: most recent jobs-relevant activity date ───────────────────────
function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── columns ──────────────────────────────────────────────────────────────────
type ColKey = "name" | "prospect" | "flag" | "title" | "company" | "tags" | "owner" | "industry" | "last_touch" | "listings" | "tasks" | "connected" | "deal" | "email" | "linkedin";
const COLUMN_ORDER: ColKey[] = ["name", "prospect", "flag", "title", "company", "tags", "owner", "industry", "last_touch", "listings", "tasks", "connected", "deal", "email", "linkedin"];
const DEFAULT_VISIBLE: ColKey[] = ["name", "prospect", "flag", "title", "company", "tags", "owner", "connected", "last_touch", "listings"];
const COL_LABELS: Record<ColKey, string> = {
  name: "Name", prospect: "Jobs prospect", flag: "Jobs stage", title: "Title", company: "Company", tags: "Tags", owner: "Owner", industry: "Industry",
  last_touch: "Last touch", listings: "Job listings", tasks: "Open tasks", connected: "Connected staff", deal: "Linked deal", email: "Email", linkedin: "LinkedIn",
};
// Default pixel widths — user-resizable via drag handles (useColumnWidths),
// same grid components as the Opportunities table.
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 190, prospect: 90, flag: 130, title: 150, company: 160, tags: 190, owner: 150, industry: 130, last_touch: 105, listings: 105, tasks: 85, connected: 155, deal: 145, email: 170, linkedin: 60,
};
const SORTABLE = new Set<ColKey>(["name", "prospect", "flag", "title", "company", "tags", "owner", "industry", "last_touch", "listings", "tasks"]);
const MEMBERSHIP_STAGE_OPTIONS = MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] }));

function extract(c: JobContactWithDeal, key: ColKey): string | number {
  switch (key) {
    case "name": return (c.full_name ?? "").toLowerCase();
    case "prospect": return c.is_jobs_contact ? 0 : 1;
    case "owner": return (c.owner_email ?? "").toLowerCase();
    case "flag": return c.membership_stage ?? "";
    case "title": return (c.current_title ?? "").toLowerCase();
    case "company": return (c.current_company ?? "").toLowerCase();
    case "industry": return (c.company_industry ?? "").toLowerCase();
    case "last_touch": return c.last_activity_at ? Date.parse(c.last_activity_at) : 0;
    case "listings": return (c.open_roles ?? 0) + (c.builder_apps ?? 0);
    case "tasks": return c.open_tasks ?? 0;
    default: return "";
  }
}

// ── filters + grouping ─────────────────────────────────────────────────────────
type Field = "name" | "title" | "company" | "industry" | "flag" | "is_jobs" | "owner" | "tags" | "listings" | "has_deal" | "connected" | "connection_count" | "last_activity" | "first_contact_date" | "last_contact_date";
const FILTERABLE: Record<Field, FieldMeta<JobContactWithDeal>> = {
  name: { label: "Name", type: "text", getValue: (c) => c.full_name ?? "" },
  title: { label: "Title", type: "text", getValue: (c) => c.current_title ?? "" },
  company: { label: "Company", type: "text", getValue: (c) => c.current_company ?? "" },
  industry: { label: "Industry", type: "text", getValue: (c) => c.company_industry ?? "" },
  flag: { label: "Jobs stage", type: "select", getValue: (c) => c.membership_stage ?? "" },
  is_jobs: { label: "Jobs prospect", type: "select", getValue: (c) => (c.is_jobs_contact ? "yes" : "no") },
  owner: { label: "Owner", type: "select", getValue: (c) => c.owner_email ?? "" },
  tags: { label: "Tags", type: "tags", getValue: (c) => (c.crm_tags ?? []).join(",") },
  listings: { label: "Job listings (sourced + applied)", type: "number", getValue: (c) => (c.open_roles ?? 0) + (c.builder_apps ?? 0) },
  has_deal: { label: "Linked deal", type: "select", getValue: (c) => (c.deal ? "yes" : "no") },
  // Text: filter "Connected staff contains <person>" (a SPECIFIC staffer), plus
  // is_empty / is_not_empty for none / any connection.
  connected: { label: "Connected staff (name)", type: "text", getValue: (c) => (c.connected_staff_names ?? []).join(", ") },
  // Number: "connected to more than N staff".
  connection_count: { label: "# staff connections", type: "number", getValue: (c) => (c.connected_staff_names ?? []).length },
  // Top-of-funnel triage: filter by activity recency (Last 7/30/90 days dropdown).
  last_activity: { label: "Last activity", type: "recency", getValue: (c) => c.last_activity_at ?? "" },
  // Exact-date windows on the touch history (before/after a calendar date).
  first_contact_date: { label: "Initial outreach date", type: "date", getValue: (c) => c.first_activity_at ?? "" },
  last_contact_date: { label: "Last contact date", type: "date", getValue: (c) => c.last_activity_at ?? "" },
};
// "company" is retained as the stored value so saved views keep resolving; the
// grouping IS by account, since an account is keyed by normalized company name
// (same key the /accounts endpoint groups on).
const GROUP_OPTIONS = [
  { value: "", label: "No grouping" },
  { value: "company", label: "Group by Account" },
  { value: "has_deal", label: "Group by Linked deal" },
];
const ACCOUNT_GROUP = "company";
const YESNO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

interface JobsContactsView {
  query?: string; rules?: FilterRule<Field>[]; visibleCols?: ColKey[]; groupBy?: string; sort?: SortState<ColKey>;
}
const EMPTY: string[] = [];

// ── Account group header ───────────────────────────────────────────────────────
/** Fixed track widths for the account header. Every group row uses the same
 *  grid, so status sits under status and owner under owner all the way down
 *  the page — the whole point of the account cut is scanning that column, and
 *  a flex-wrapped strip put every value at a different x-offset. */
const ACCOUNT_HEADER_GRID =
  "14px minmax(0, 2fr) 108px 104px minmax(0, 1.3fr) minmax(0, 1.4fr) minmax(0, 1.1fr) 52px auto";

/** One cell in that grid: a muted label above nothing, value below — kept on
 *  one line so row height doesn't change between accounts. */
function Meta({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 text-[11.5px]" title={title}>
      <span className="flex-shrink-0 text-ink-4">{label}</span>
      <span className="truncate font-medium text-ink-2">{children}</span>
    </span>
  );
}

/**
 * The group header when contacts are grouped by account.
 *
 * Collapsed, this row IS the view: it has to answer "who owns this account,
 * where does it stand, and how many of our contacts sit here" without the
 * reader expanding anything. `shown`/`total` are the contacts in THIS filtered
 * view vs. everyone flagged at the account, so a filtered subset reads as
 * "3 of 11" instead of silently under-reporting.
 */
function AccountGroupHeader({
  label, account, shown, collapsed, colSpan, onToggle, notesOpen, onToggleNotes,
}: {
  label: string;
  account?: JobsAccount;
  shown: number;
  collapsed: boolean;
  colSpan: number;
  onToggle: () => void;
  notesOpen: boolean;
  onToggleNotes: () => void;
}) {
  const total = account?.prospect_count ?? 0;
  const opps = account?.opportunities ?? [];
  const portfolioCount = account?.portfolio_count ?? 0;
  const openTasks = account?.open_tasks ?? 0;
  return (
    <>
      <tr className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2" onClick={onToggle}>
        <td colSpan={colSpan} className="px-3 py-2">
          <div className="grid items-center gap-x-3" style={{ gridTemplateColumns: ACCOUNT_HEADER_GRID }}>
            <span className="text-ink-3">{collapsed ? "▸" : "▾"}</span>

            <span className="min-w-0">
              {account ? (
                <Link to={jobsAccountPath(account.account_key)} onClick={(e) => e.stopPropagation()}
                  className="block truncate text-[12.5px] font-semibold text-ink hover:text-accent hover:underline"
                  title={`Open ${account.account}`}>
                  {label}
                </Link>
              ) : (
                <span className="block truncate text-[12.5px] font-semibold text-ink" title={label}>{label}</span>
              )}
            </span>

            {/* The contact count is the reason this page groups at all — keep it
                adjacent to the name rather than buried in the meta strip. */}
            <span className="justify-self-start rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink"
              title={total > shown ? `${shown} shown by the current filters · ${total} flagged at this account` : undefined}>
              {total > shown ? `${shown} of ${total}` : shown} contact{shown === 1 ? "" : "s"}
            </span>

            <span className="min-w-0">
              {account ? <Tag variant={accountStatusVariant(account.account_status)}>{account.account_status}</Tag> : null}
            </span>

            {/* Investor is a relationship, not a flag: an account either HAS one
                (portfolio company) or IS one (other accounts point at it). */}
            <span className="min-w-0 truncate">
              {account?.investor_name ? (
                <span title={`Backed by ${account.investor_name}`}>
                  <Tag variant="default">Investor: {account.investor_name}</Tag>
                </span>
              ) : portfolioCount > 0 ? (
                <span title={`${portfolioCount} portfolio compan${portfolioCount === 1 ? "y" : "ies"}`}>
                  <Tag variant="sky">Investor · {portfolioCount} portfolio</Tag>
                </span>
              ) : null}
            </span>

            <Meta label="Owner">{account?.owner_email || <span className="text-ink-4">—</span>}</Meta>
            <Meta label="Industry">{account?.industry || <span className="text-ink-4">—</span>}</Meta>
            <Meta
              label="Opps"
              title={opps.length ? opps.map((o) => `${o.title || "Untitled"} — ${o.stage}`).join("\n") : "No opportunities at this account"}
            >
              {account && account.opp_count > 0 ? account.opp_count : <span className="text-ink-4">—</span>}
            </Meta>

            {/* Notes/tasks hang off the ACCOUNT record, so they're only offered
                where the company resolved to one. An unlinked company has
                nothing to attach them to. */}
            {account ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleNotes(); }}
                title={`Tasks & comments for ${account.account}`}
                className={cn(
                  "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded border px-2 text-[11.5px]",
                  notesOpen
                    ? "border-accent bg-accent-soft text-accent-ink"
                    : "border-border-strong bg-surface text-ink-3 hover:text-ink",
                )}
              >
                <MessageSquare size={11} />
                Notes
                {openTasks > 0 && (
                  <span className="rounded-full bg-amber-soft px-1 text-[10px] font-semibold text-amber">{openTasks}</span>
                )}
              </button>
            ) : (
              <span className="text-[11px] text-ink-4" title="This company isn't linked to an account yet, so it has nothing to attach tasks or comments to.">
                No account link
              </span>
            )}
          </div>
        </td>
      </tr>

      {/* Mounted only while open — each panel fetches its own tasks/comments,
          so rendering them for every group would be a request per account. */}
      {account && notesOpen && (
        <tr className="border-b border-border-strong bg-surface">
          <td colSpan={colSpan} className="px-3 py-3">
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <JobsTasks parentType="account" parentId={account.account_key} />
              <JobsComments parentType="account" parentId={account.account_key} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── New Contact modal (unchanged) ────────────────────────────────────────────────
interface NewContactForm { fullName: string; email: string; title: string; company: string; linkedIn: string; }
const DEFAULT_NEW_CONTACT_FORM: NewContactForm = { fullName: "", email: "", title: "", company: "", linkedIn: "" };
function Spinner() {
  return <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>;
}
function NewContactModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [form, setForm] = useState<NewContactForm>(DEFAULT_NEW_CONTACT_FORM);
  const createContact = useCreateContact();
  const set = <K extends keyof NewContactForm>(k: K, v: NewContactForm[K]) => setForm((p) => ({ ...p, [k]: v }));
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fullName.trim()) return;
    const body: ContactCreateBody = {
      full_name: form.fullName.trim(), email: form.email.trim() || undefined, current_title: form.title.trim() || undefined,
      current_company: form.company.trim() || undefined, linkedin_url: form.linkedIn.trim() || undefined,
      contact_stage: "active",
    };
    const created = await createContact.mutateAsync(body);
    onClose();
    if (created?.contact_id) nav(jobsContactPath(created.contact_id));
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4"><h2 className="text-[15px] font-semibold text-ink">New Contact</h2><button type="button" onClick={onClose} className="text-ink-3 hover:text-ink"><X size={16} /></button></div>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Full Name *</label><input required value={form.fullName} onChange={(e) => set("fullName", e.target.value)} placeholder="Jane Smith" className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
          <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Email</label><input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Title</label><input value={form.title} onChange={(e) => set("title", e.target.value)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
            <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Company</label><CompanyPicker value={form.company} onChange={(v) => set("company", v)} /></div>
          </div>
          <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">LinkedIn URL</label><input type="url" value={form.linkedIn} onChange={(e) => set("linkedIn", e.target.value)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
          <div className="flex items-center justify-end gap-3 pt-1"><button type="button" onClick={onClose} className="px-4 py-2 text-[13px] font-medium text-ink-3 hover:text-ink">Cancel</button><button type="submit" disabled={createContact.isPending || !form.fullName.trim()} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">{createContact.isPending ? <Spinner /> : <Plus size={13} />}{createContact.isPending ? "Creating…" : "Create Contact"}</button></div>
        </form>
      </div>
    </div>
  );
}

// ── tags cell (chips + fixed-position popover editor) ────────────────────────
function TagsCell({ contact }: { contact: JobContactWithDeal }) {
  const { data: catalog = [] } = useContactTagCatalog();
  const update = useUpdateContact();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [draft, setDraft] = useState<string[]>([]);
  const labels = useMemo(() => Object.fromEntries(catalog.map((t) => [t.slug, t.label])), [catalog]);
  const tags = contact.crm_tags ?? [];
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="Edit tags"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ top: r.bottom + 4, left: r.left });
          setDraft(tags);
          setOpen((v) => !v);
        }}
        className="flex min-h-[20px] w-full flex-wrap items-center gap-1 text-left"
      >
        {tags.length > 0
          ? tags.map((t) => <span key={t} className="truncate rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">{labels[t] ?? humanizeTag(t)}</span>)
          : <span className="text-[12px] text-ink-4">—</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div style={{ position: "fixed", top: pos.top, left: pos.left }} className="z-50 max-h-72 w-60 overflow-auto rounded-md border border-border-strong bg-surface p-2 shadow-xl">
            {catalog.map((t) => (
              <label key={t.slug} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
                <input type="checkbox" checked={draft.includes(t.slug)} onChange={() => setDraft((d) => d.includes(t.slug) ? d.filter((x) => x !== t.slug) : [...d, t.slug])} className="h-3.5 w-3.5 accent-[color:var(--accent,#4242EA)]" />
                {t.label}
              </label>
            ))}
            <div className="mt-1 flex items-center justify-end gap-2 border-t border-border-strong pt-1.5">
              <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-3 hover:text-ink">Cancel</button>
              <button type="button" disabled={update.isPending}
                onClick={() => update.mutate({ id: contact.contact_id, tags: draft }, { onSuccess: () => setOpen(false) })}
                className="rounded bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">
                {update.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── row ──────────────────────────────────────────────────────────────────────
function ContactRow({ contact, expanded, onOpen, visibleCols, selected, onToggleSelect }: { contact: JobContactWithDeal; expanded: boolean; onOpen: () => void; visibleCols: ColKey[]; selected: boolean; onToggleSelect: () => void }) {
  const updateMembership = useUpdateJobsMembership();
  const stageChange = useContactStageChange();
  const flagOne = useFlagContactsForJobs();
  const addToJobs = useAddContactToJobs();
  const updateContact = useUpdateContact();
  const { data: staffList = [] } = useStaff();
  const staffOptions = useMemo(
    () => [{ value: "", label: "—" }, ...staffList.map((s) => ({ value: s.email, label: s.name }))],
    [staffList],
  );
  const staffName = (email: string | null | undefined) =>
    staffList.find((s) => s.email === email)?.name ?? email ?? "—";
  const staff = contact.connected_staff_names ?? [];
  const cells: Record<ColKey, React.ReactNode> = {
    name: (
      <span className="flex min-w-0 items-center gap-2">
        <input type="checkbox" checked={selected} onClick={(e) => e.stopPropagation()} onChange={onToggleSelect} className="h-3.5 w-3.5 shrink-0 accent-[color:var(--accent,#4242EA)]" aria-label="Select contact" />
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold leading-none text-accent-ink">{initials(contact.full_name)}</span>
        <span className="truncate text-[13px] font-medium text-ink">{contact.full_name || "—"}</span>
        <Link to={jobsContactPath(contact.contact_id)} state={withReferrer({ pathname: "/jobs", label: "Jobs" })} onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-4 hover:text-accent" title="Open contact detail"><ExternalLink size={12} /></Link>
      </span>
    ),
    prospect: (
      <span className="flex items-center justify-center" title={contact.is_jobs_contact ? "Jobs prospect — click to remove" : "Mark as jobs prospect"}>
        <input
          type="checkbox"
          checked={!!contact.is_jobs_contact}
          disabled={addToJobs.isPending}
          onClick={(e) => e.stopPropagation()}
          onChange={() => addToJobs.mutate({ id: contact.contact_id, add: !contact.is_jobs_contact })}
          className="h-4 w-4 cursor-pointer accent-[color:var(--accent,#4242EA)]"
          aria-label="Jobs prospect"
        />
      </span>
    ),
    owner: (
      <InlineSelect<string>
        value={contact.owner_email ?? ""}
        options={staffOptions}
        renderValue={(v) => { const email = (v || contact.owner_email) || null; return <span className={cn("truncate text-[12.5px]", email ? "text-ink-2" : "text-ink-4")}>{email ? staffName(email) : "—"}</span>; }}
        onSave={(v) => new Promise<void>((res, rej) => updateContact.mutate({ id: contact.contact_id, owner_email: v || null }, { onSuccess: () => res(), onError: rej }))}
      />
    ),
    tags: <TagsCell contact={contact} />,
    title: <span className="truncate text-[12.5px] text-ink-2">{contact.current_title || "—"}</span>,
    company: <span className="truncate text-[12.5px] text-ink-2">{contact.current_company || "—"}</span>,
    // Jobs stage = a real funnel stage. A jobs prospect with no stage yet shows
    // a muted "—" (in pipeline via the prospect checkbox); the picker sets a
    // real stage, creating the membership.
    flag: contact.membership_stage
      ? <InlineSelect<string> value={contact.membership_stage} options={stageChange.options}
          renderValue={(v) => <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent-ink">{MEMBERSHIP_STAGE_LABELS[(v ?? contact.membership_stage) as MembershipStage] ?? v}</span>}
          onSave={(v) => {
            if (!v) return Promise.resolve();
            // Revisit asks for a date first (shared handler); anything else
            // writes straight through.
            if (v === "revisit") return stageChange.change(contact.contact_id, contact.full_name ?? "contact", v);
            return new Promise<void>((res, rej) => updateMembership.mutate(
              { contact_id: contact.contact_id, stage: v }, { onSuccess: () => res(), onError: rej }));
          }} />
      : <InlineSelect<string> value="" options={stageChange.options} emptyLabel="—"
          renderValue={(v) => v ? <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent-ink">{MEMBERSHIP_STAGE_LABELS[v as MembershipStage] ?? v}</span> : <span className="text-[11px] text-ink-4">—</span>}
          onSave={(v) => {
            if (!v) return Promise.resolve();
            // Same rule as the picker above: Revisit asks for a date first.
            // This branch was writing the stage straight through, so a contact
            // with no stage yet could be parked in Revisit with no date and no
            // task — the exact problem Revisit replaced On Hold to fix.
            // `flagOne` creates the membership because PATCH /jobs-membership
            // is UPDATE-only and 404s without one.
            if (v === "revisit") {
              return stageChange.change(
                contact.contact_id, contact.full_name ?? "contact", v,
                () => flagOne.mutateAsync({ contact_ids: [contact.contact_id], stage: v }),
              );
            }
            return new Promise<void>((res, rej) => {
              flagOne.mutate({ contact_ids: [contact.contact_id], stage: v },
                { onSuccess: () => res(), onError: rej });
            });
          }} />,
    industry: <span className="truncate text-[12px] text-ink-3">{contact.company_industry || "—"}</span>,
    listings: (() => {
      const src = contact.open_roles ?? 0, app = contact.builder_apps ?? 0, tot = src + app;
      return tot > 0
        ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2" title={`${src} team-sourced · ${app} builder-applied`}><Briefcase size={11} className="text-ink-4" />{tot}</span>
        : <span className="text-ink-4">—</span>;
    })(),
    last_touch: (
      <span className="whitespace-nowrap text-[11.5px] text-ink-4" title={contact.last_activity_at ? new Date(contact.last_activity_at).toLocaleDateString() : undefined}>
        {relativeDays(contact.last_activity_at)}
      </span>
    ),
    tasks: (contact.open_tasks ?? 0) > 0
      ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><CheckSquare size={11} className="text-ink-4" />{contact.open_tasks}</span>
      : <span className="text-ink-4">—</span>,
    connected: staff.length > 0
      ? <span className="flex min-w-0 flex-wrap items-center gap-1"><Linkedin size={11} className="shrink-0 text-indigo-500" />{staff.slice(0, 2).map((n) => <span key={n} className="truncate rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">{n}</span>)}{staff.length > 2 && <span className="text-[10px] text-ink-4">+{staff.length - 2}</span>}</span>
      : <span className="text-ink-4">—</span>,
    deal: contact.deal
      ? <span className="truncate text-[12px] text-ink-2">{contact.deal.account_name}<span className="ml-1 text-[10.5px] text-ink-4">{STAGE_LABELS[contact.deal.stage as JobStage] ?? contact.deal.stage}</span></span>
      : <span className="text-ink-4">—</span>,
    email: contact.email
      ? <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()} className="truncate text-[12.5px] text-ink-2 hover:text-accent hover:underline">{contact.email}</a>
      : <span className="text-ink-4">—</span>,
    linkedin: contact.linkedin_url
      ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-accent"><Linkedin size={14} /></a>
      : <span className="text-ink-4">—</span>,
  };
  return (
    <Fragment>
      <tr id={`contact-${contact.contact_id}`} className={cn("cursor-pointer border-t border-border-strong hover:bg-surface-2/40", expanded && "bg-surface-2/40")} onClick={onOpen}>
        {visibleCols.map((key, i) => (
          <td key={key} className={cn("overflow-hidden px-3 py-1.5 align-middle", i === 0 && "sticky left-0 z-10 bg-surface")} onClick={["flag", "prospect", "owner", "tags"].includes(key) ? (e) => e.stopPropagation() : undefined}>{cells[key]}</td>
        ))}
      </tr>
      {expanded && <tr className="bg-surface-2/20"><td colSpan={visibleCols.length} className="p-0"><ContactExpandTabs contactId={contact.contact_id} /></td></tr>}
      {/* Rendered outside the cells: a modal can't live inside a <td> in a
          ternary, and only the row you clicked has a pending revisit. */}
      {stageChange.dialog}
    </Fragment>
  );
}

export function JobsContacts({ initialQuery, initialContactId, initialConnectedOnly }: { initialQuery?: string; initialContactId?: number; initialConnectedOnly?: boolean } = {}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  // TKT-140: the intro flow arrives with ?connected=1 — pre-seed the
  // connected-to-staff rule (runs SQL-side over the full universe, so the
  // page cap doesn't hide staff-network contacts). Shows as a removable chip.
  const [rules, setRules] = useState<FilterRule<Field>[]>(() => initialConnectedOnly
    ? [{ id: "seed-connected", field: "connected", op: "is_not_empty", values: [] }]
    : []);
  const [groupBy, setGroupBy] = useSessionState<string>("jobs-contacts:groupBy", "");
  // Collapse state is a MODE plus a list of exceptions to it, not a list of
  // collapsed keys. That makes "collapse all" a single flip that also covers
  // groups scrolled out of view or created by a later filter change — an
  // enumerate-every-key approach goes stale the moment the buckets change.
  // Which account's tasks/comments panel is open (account_key). One at a time:
  // the panel is a working surface, not something to read across accounts.
  const [notesKey, setNotesKey] = useState<string | null>(null);
  const [groupMode, setGroupMode] = useSessionState<"expanded" | "collapsed">("jobs-contacts:groupMode", "expanded");
  const [groupExceptions, setGroupExceptions] = useSessionState<string[]>("jobs-contacts:groupToggles", EMPTY);
  const [showNewContact, setShowNewContact] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [pendingStage, setPendingStage] = useState("");   // "" = leave unchanged
  const [pendingOwner, setPendingOwner] = useState("");   // "" = leave, "__clear__" = clear owner
  // Default = today's working view (jobs prospects only). "All contacts" opens
  // the full universe so anyone can be promoted via the prospect checkmark.
  const [scope, setScope] = useSessionState<"jobs" | "all">("jobs-contacts:scope", "jobs");
  const [flagView, setFlagView] = useState<"all" | "flagged" | "unflagged">("all");
  const flagContacts = useFlagContactsForJobs();
  const bulkOwner = useBulkContactOwner();
  const bulkProspect = useBulkProspect();
  const unflag = useUnflagJobsContact();
  const toggleSelect = useCallback((id: number) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const { sort, toggle, setSort } = useSort<ColKey>({ key: "name", direction: "asc" });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols, move: moveCol } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:jobs-contacts-v2", COLUMN_ORDER, DEFAULT_VISIBLE);
  // Column drag-reorder (spreadsheet-style: grab a header, drop it where you
  // want it). `dragCol` is what's moving, `dropCol` is what it's hovering.
  const [dragCol, setDragCol] = useState<ColKey | null>(null);
  const [dropCol, setDropCol] = useState<ColKey | null>(null);
  const { widths, startResize } = useColumnWidths<ColKey>("bedrock-v2:cols:jobs-contacts", DEFAULT_WIDTHS);
  const [showAllRows, setShowAllRows] = useState(false);

  const [previewContact, setPreviewContact] = useState<ContactSearchResult | null>(null);
  const [bannerAddedToJobs, setBannerAddedToJobs] = useState(false);
  const { mutate: addContactToJobs } = useAddContactToJobs();

  // Server-side search: the table only loads the first 500 pipeline contacts,
  // so the search box must query the SERVER (all contacts), not just filter
  // the loaded page — otherwise anyone past row 500 is unfindable. Debounced
  // so we don't refetch per keystroke; client-side filtering still applies on
  // top for instant narrowing.
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery ?? "");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  // Filter rules are translated to SQL server-side (see list_contacts) so a
  // rule like "connected staff contains jac" scans all 47k contacts — the old
  // client-only filtering silently sifted just the loaded page. Client-side
  // ruleApplies still runs on top for instant feedback while typing.
  // Clear any selection when the visible set changes — otherwise a bulk action
  // would apply to rows the user can no longer see (scope/filter/search change).
  useEffect(() => { setSelected(new Set()); }, [scope, flagView, debouncedQuery]);

  const serverRules = useMemo(() => serializeRulesForServer(rules), [rules]);
  const filteringActive = serverRules.length > 0 || !!debouncedQuery;
  const { data: rawData, isLoading, isError, refetch } = useJobsContacts({
    limit: filteringActive ? 5000 : 1200,
    search: debouncedQuery || undefined,
    flagged: flagView === "all" ? undefined : flagView === "flagged",
    scope,
    rules: serverRules.length > 0 ? serverRules : undefined,
  });
  const allContacts: JobContactWithDeal[] = useMemo(() => rawData?.data ?? [], [rawData]);
  const serverTotal = rawData?.total ?? 0;
  const universeTruncated = filteringActive && serverTotal > allContacts.length;

  const openContact = useCallback((result: ContactSearchResult) => {
    if (allContacts.some((c) => c.contact_id === result.contact_id)) {
      setExpandedId(result.contact_id); setPreviewContact(null);
      requestAnimationFrame(() => document.getElementById(`contact-${result.contact_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } else { setPreviewContact(result); setBannerAddedToJobs(false); }
  }, [allContacts]);

  const deepLinkDetail = useContactDetail(initialContactId ?? null);
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (openedDeepLink.current || !deepLinkDetail.data) return;
    const d = deepLinkDetail.data; openedDeepLink.current = true;
    openContact({ contact_id: d.contact_id, full_name: d.full_name, email: d.email, current_title: d.current_title, current_company: d.current_company, source: null, airtable_id: d.airtable_id, contact_stage: d.contact_stage, in_sf: false, contact_ref: d.airtable_id ? `airtable:${d.airtable_id}` : `pub:${d.contact_id}` });
  }, [deepLinkDetail.data, openContact]);

  const { data: tagCatalog = [] } = useContactTagCatalog();
  const { data: staffForFilter = [] } = useStaff();
  // slug → campaign priority (lower = higher priority); a contact's priority is
  // its best (lowest) tag order. Untagged contacts sort last.
  const tagOrder = useMemo(() => Object.fromEntries(tagCatalog.map((t) => [t.slug, t.sort_order])), [tagCatalog]);
  const contactPriority = useCallback((c: JobContactWithDeal) => {
    const orders = (c.crm_tags ?? []).map((t) => tagOrder[t] ?? Infinity);
    return orders.length ? Math.min(...orders) : Infinity;
  }, [tagOrder]);
  const selectOptions: Partial<Record<Field, { value: string; label: string }[]>> = useMemo(() => ({
    has_deal: YESNO, is_jobs: YESNO, last_activity: RECENCY_OPTIONS,
    flag: MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] })),
    tags: tagCatalog.map((t) => ({ value: t.slug, label: t.label })),
    owner: staffForFilter.map((s) => ({ value: s.email, label: s.name })),
  }), [tagCatalog, staffForFilter]);

  const exceptionSet = useMemo(() => new Set(groupExceptions), [groupExceptions]);
  const isCollapsed = useCallback(
    (k: string) => (groupMode === "collapsed" ? !exceptionSet.has(k) : exceptionSet.has(k)),
    [groupMode, exceptionSet],
  );
  const toggleGroup = useCallback(
    (k: string) => setGroupExceptions((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k])),
    [setGroupExceptions],
  );
  const toggleAllGroups = useCallback(() => {
    setGroupMode((m) => (m === "collapsed" ? "expanded" : "collapsed"));
    setGroupExceptions(EMPTY);
  }, [setGroupMode, setGroupExceptions]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const f = allContacts.filter((c) => {
      for (const r of rules) if (!ruleApplies(c, r, FILTERABLE)) return false;
      if (!q) return true;
      return (c.full_name ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q)
        || (c.current_company ?? "").toLowerCase().includes(q) || (c.current_title ?? "").toLowerCase().includes(q);
    });
    if (sort.key === "tags") {
      // Sort by campaign priority (best tag), not the raw tag string.
      const dir = sort.direction === "desc" ? -1 : 1;
      return [...f].sort((a, b) => (contactPriority(a) - contactPriority(b)) * dir);
    }
    return sort.key == null ? f : sortBy(f, sort, (c, k) => extract(c, k));
  }, [allContacts, q, rules, sort, contactPriority]);

  // Select-all operates on the full filtered set (every loaded row that matches
  // the current filters), not just the 300 shown.
  const filteredIds = useMemo(() => filtered.map((c) => c.contact_id), [filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const everySelected = filteredIds.length > 0 && filteredIds.every((id) => prev.has(id));
      return everySelected ? new Set() : new Set(filteredIds);
    });
  }, [filteredIds]);

  const groupLabel = useCallback((k: string) => {
    if (k === "") return "—";
    if (groupBy === "has_deal") return k === "yes" ? "Has linked deal" : "No linked deal";
    return k;
  }, [groupBy]);

  // Account context for the group headers. Only fetched while actually grouping
  // by account — /api/jobs/accounts is a ~15-query fan-out, too expensive to
  // pull on every Contacts load for a header that may never render.
  const groupingByAccount = groupBy === ACCOUNT_GROUP;
  const { data: accountsData } = useJobsAccounts(undefined, "engaged", { enabled: groupingByAccount });
  // Keyed by account_key, which the backend derives as lower(trim(name)) — the
  // same normalization applied to the contact's company below.
  const accountByKey = useMemo(() => {
    const m = new Map<string, JobsAccount>();
    for (const a of accountsData ?? []) m.set(a.account_key, a);
    return m;
  }, [accountsData]);

  // Bucketing is independent of collapse state so toggling a group doesn't
  // re-partition every contact.
  //
  // Account grouping buckets on lower(trim(company)) — the same key the
  // /accounts endpoint groups on. Bucketing on the raw string instead would
  // split one account into a group per spelling ("Acme" / "acme " / "ACME"),
  // each with its own partial contact count. The label keeps the first raw
  // spelling seen, or the account's canonical name once it resolves.
  type Bucket = { key: string; label: string; list: JobContactWithDeal[]; account?: JobsAccount };
  const buckets: Bucket[] | null = useMemo(() => {
    if (!groupBy) return null;
    const field = FILTERABLE[groupBy as Field]; if (!field) return null;
    const m = new Map<string, Bucket>();
    for (const c of filtered) {
      const raw = String(field.getValue(c) ?? "");
      const key = groupingByAccount ? raw.trim().toLowerCase() : raw;
      const b = m.get(key);
      if (b) b.list.push(c);
      else m.set(key, { key, label: groupingByAccount ? (raw.trim() || "—") : groupLabel(raw), list: [c] });
    }
    if (groupingByAccount) {
      for (const b of m.values()) {
        b.account = accountByKey.get(b.key);
        if (b.account) b.label = b.account.account;
      }
    }
    return [...m.values()].sort((x, y) => x.label.localeCompare(y.label));
  }, [filtered, groupBy, groupLabel, groupingByAccount, accountByKey]);

  type DisplayRow =
    | { kind: "row"; c: JobContactWithDeal }
    | { kind: "header"; key: string; label: string; count: number; collapsed: boolean; account?: JobsAccount };
  const grouped: DisplayRow[] | null = useMemo(() => {
    if (!buckets) return null;
    const out: DisplayRow[] = [];
    for (const b of buckets) {
      const collapsed = isCollapsed(b.key);
      out.push({ kind: "header", key: b.key, label: b.label, count: b.list.length, collapsed, account: b.account });
      if (!collapsed) for (const c of b.list) out.push({ kind: "row", c });
    }
    return out;
  }, [buckets, isCollapsed]);

  const tableMinWidth = visibleCols.reduce((s, k) => s + widths[k], 0);
  const renderRow = (c: JobContactWithDeal) => (
    <ContactRow key={c.contact_id} contact={c} expanded={expandedId === c.contact_id} onOpen={() => setExpandedId((p) => p === c.contact_id ? null : c.contact_id)} visibleCols={visibleCols}
      selected={selected.has(c.contact_id)} onToggleSelect={() => toggleSelect(c.contact_id)} />
  );

  return (
    <div className="flex flex-col px-5 py-2">
      {showNewContact && <NewContactModal onClose={() => setShowNewContact(false)} />}

      {/* Preview */}
      {previewContact && (
        <div className="mb-2 overflow-hidden rounded-xl border border-border-strong bg-surface">
          <div className="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-4 py-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">{initials(previewContact.full_name)}</div>
            <div className="min-w-0 flex-1"><span className="mr-2 text-[14px] font-semibold text-ink">{previewContact.full_name || "—"}</span>{(previewContact.current_title || previewContact.current_company) && <span className="mr-2 text-[12px] text-ink-3">{[previewContact.current_title, previewContact.current_company].filter(Boolean).join(" @ ")}</span>}<span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">Preview · not in pipeline</span></div>
            <div className="flex flex-shrink-0 items-center gap-2">{bannerAddedToJobs ? <span className="text-[12px] font-medium text-accent">✓ In Jobs Pipeline</span> : <button type="button" onClick={() => addContactToJobs({ id: previewContact.contact_id, add: true }, { onSuccess: () => setBannerAddedToJobs(true) })} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"><Plus size={13} /> Add to Jobs Pipeline</button>}<button type="button" onClick={() => setPreviewContact(null)} className="flex items-center gap-1 text-[12px] font-medium text-ink-3 hover:text-ink"><X size={13} /> Close</button></div>
          </div>
          <ContactDetail contactId={previewContact.contact_id} />
        </div>
      )}

      {/* Toolbar */}
      <Toolbar>
        <div className="relative">
          <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input placeholder="Search name, company, title, email…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 w-60 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink" />
        </div>
        <AddFilterButton<Field> filterable={FILTERABLE as Record<Field, FieldMeta<unknown>>} selectOptions={selectOptions} onAdd={(r) => setRules((p) => [...p, r])} buttonLabel="Filter" />
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} title="Which contacts to show — jobs prospects only, or the entire contact universe" className={cn("h-7 rounded border px-2 text-[12.5px] outline-none focus:border-accent", scope === "all" ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-border-strong bg-surface text-ink-2")}>
          <option value="jobs">Jobs prospects</option>
          <option value="all">All contacts</option>
        </select>
        <select value={flagView} onChange={(e) => setFlagView(e.target.value as typeof flagView)} title="Filter by jobs-activation stage flag" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          <option value="all">Any jobs stage</option>
          <option value="flagged">Has jobs stage</option>
          <option value="unflagged">No jobs stage</option>
        </select>
        <select
          value={groupBy}
          onChange={(e) => {
            const next = e.target.value;
            setGroupBy(next);
            setGroupExceptions(EMPTY);
            // Account grouping opens collapsed: the point of that view is the
            // account roll-up, and 100+ expanded groups bury it. Other
            // groupings keep the original expanded default.
            setGroupMode(next === ACCOUNT_GROUP ? "collapsed" : "expanded");
          }}
          title="Group rows by a field"
          className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent"
        >
          {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {groupBy && (
          <button
            type="button"
            onClick={toggleAllGroups}
            title={groupMode === "collapsed" ? "Expand every group" : "Collapse every group"}
            className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 hover:bg-surface-2"
          >
            {groupMode === "collapsed" ? <><ChevronsUpDown size={13} /> Expand all</> : <><ChevronsDownUp size={13} /> Collapse all</>}
          </button>
        )}
        <span className="whitespace-nowrap font-mono text-[12px] text-ink-4">{isLoading ? "…" : `${filtered.length} contact${filtered.length === 1 ? "" : "s"}`}</span>
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visibleCols} required={["name"]} onToggle={toggleCol} />
          <SavedViewsPicker<JobsContactsView> scopeKey="jobs-contacts" currentFilters={{ query, rules, visibleCols, groupBy, sort }} onLoad={(v) => { setQuery(v.query ?? ""); setRules(v.rules ?? []); const g = v.groupBy ?? ""; setGroupBy(g); setGroupExceptions(EMPTY); setGroupMode(g === ACCOUNT_GROUP ? "collapsed" : "expanded"); if (v.visibleCols?.length) replaceVisibleCols(v.visibleCols); if (v.sort) setSort(v.sort); }} />
          <button type="button" onClick={() => setShowNewContact(true)} className="inline-flex h-7 items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"><Plus size={13} /> New Contact</button>
        </div>
      </Toolbar>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-x border-t border-accent bg-accent-soft px-3 py-2 text-[12.5px]">
          <span className="font-semibold text-accent-ink">{selected.size} selected{allFilteredSelected && filteredIds.length > 1 ? " (all)" : ""}</span>
          {!allFilteredSelected && filteredIds.length > selected.size && (
            <button type="button" onClick={() => setSelected(new Set(filteredIds))} className="text-[11.5px] font-medium text-accent underline-offset-4 hover:underline">Select all {filteredIds.length}</button>
          )}
          {universeTruncated && allFilteredSelected && (
            <span className="text-[11px] text-amber-700">of {allContacts.length.toLocaleString()} loaded — {serverTotal.toLocaleString()} match; refine to act on all</span>
          )}
          <span className="mx-1 h-4 w-px bg-accent/30" />
          {/* Set values, then apply once with Bulk update — no auto-fire. */}
          <select value={pendingStage} disabled={bulkBusy} onChange={(e) => setPendingStage(e.target.value)} className="h-7 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent disabled:opacity-50">
            <option value="">Stage: no change</option>
            {/* Revisit is deliberately absent. It is only meaningful with a
                date — that date is the whole reason it replaced On Hold — and
                this bar has nowhere to ask for one, so offering it here would
                write a batch of dateless revisits that never come back to
                anyone. Set it per row, where the dialog asks. */}
            {MEMBERSHIP_STAGE_OPTIONS.filter((o) => o.value !== "revisit")
              .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={pendingOwner} disabled={bulkBusy} onChange={(e) => setPendingOwner(e.target.value)} className="h-7 max-w-[220px] rounded border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent disabled:opacity-50">
            <option value="">Owner: no change</option>
            {staffForFilter.map((s) => <option key={s.email} value={s.email}>{s.name}</option>)}
            <option value="__clear__">(clear owner)</option>
          </select>
          <button type="button" disabled={bulkBusy || (!pendingStage && !pendingOwner)}
            onClick={async () => {
              const ids = [...selected];
              const parts = [
                pendingStage ? `stage → ${MEMBERSHIP_STAGE_LABELS[pendingStage as MembershipStage] ?? pendingStage}` : null,
                pendingOwner ? `owner → ${pendingOwner === "__clear__" ? "none" : (staffForFilter.find((s) => s.email === pendingOwner)?.name ?? pendingOwner)}` : null,
              ].filter(Boolean);
              if (!window.confirm(`Update ${ids.length} contact${ids.length === 1 ? "" : "s"}: ${parts.join(", ")}?`)) return;
              setBulkBusy(true);
              try {
                if (pendingStage) await flagContacts.mutateAsync({ contact_ids: ids, stage: pendingStage });
                if (pendingOwner) await bulkOwner.mutateAsync({ contact_ids: ids, owner_email: pendingOwner === "__clear__" ? null : pendingOwner });
                setSelected(new Set()); setPendingStage(""); setPendingOwner("");
              } finally { setBulkBusy(false); }
            }}
            className="inline-flex h-7 items-center gap-1 rounded bg-accent px-3 font-medium text-white hover:opacity-90 disabled:opacity-50"><Zap size={12} /> {bulkBusy ? "Updating…" : "Bulk update"}</button>
          <span className="mx-1 h-4 w-px bg-accent/30" />
          <button type="button" disabled={bulkBusy || bulkProspect.isPending} onClick={() => bulkProspect.mutate({ contact_ids: [...selected], value: true }, { onSuccess: () => setSelected(new Set()) })} className="inline-flex h-7 items-center gap-1 rounded border border-accent bg-surface px-3 font-medium text-accent hover:bg-accent-soft disabled:opacity-50" title="Mark as jobs prospects (no pipeline stage)"><Plus size={12} /> Add as prospect</button>
          <button type="button" disabled={bulkBusy} onClick={async () => { const ids = [...selected]; if (!window.confirm(`Clear the jobs stage from ${ids.length} contact${ids.length === 1 ? "" : "s"}?`)) return; setBulkBusy(true); const r = await Promise.allSettled(ids.map((id) => unflag.mutateAsync(id))); setBulkBusy(false); const failed = r.filter((x) => x.status === "rejected").length; if (failed) toast.error(`${failed} of ${ids.length} could not be cleared`); setSelected(new Set()); }} className="h-7 rounded border border-border-strong bg-surface px-3 text-ink-2 hover:text-ink disabled:opacity-50" title="Remove the jobs stage (membership) from the selected contacts">Clear stage</button>
          {/* Export the selection as .xlsx. Read-only, so it sits after the
              mutating actions and never clears the selection — you may well want
              to act on the same rows next. */}
          <ExportButton
            count={selected.size}
            busy={exporting}
            onExport={async (columns) => {
              setExporting(true);
              try {
                await exportJobsRows("contacts", [...selected], columns);
                toast.success(`Exported ${selected.size} contact${selected.size === 1 ? "" : "s"}`);
              } catch (e: unknown) {
                // The server explains refusals in plain language (nothing
                // selected, too many rows); "Export failed" sent people hunting
                // for a bug instead of reading the reason.
                const detail = (e as { response?: { data?: { detail?: string } } })
                  ?.response?.data?.detail;
                toast.error(detail || "Export failed");
              } finally {
                setExporting(false);
              }
            }} />
          <button type="button" onClick={() => setSelected(new Set())} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear selection</button>
        </div>
      )}

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => <FilterChip key={r.id} label={describeRule(r, FILTERABLE, (f, v) => f === "flag" ? (MEMBERSHIP_STAGE_LABELS[v as MembershipStage] ?? v) : f === "tags" ? (tagCatalog.find((t) => t.slug === v)?.label ?? v) : f === "owner" ? (staffForFilter.find((s) => s.email === v)?.name ?? v) : f === "last_activity" ? recencyLabel(v) : v)} onRemove={() => setRules((p) => p.filter((x) => x.id !== r.id))} />)}
          <button type="button" onClick={() => setRules([])} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      )}

      {universeTruncated && (
        <div className="border-x border-t border-amber-300 bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-900">
          Filters matched {serverTotal.toLocaleString()} contacts — showing the first {allContacts.length.toLocaleString()}. Refine to narrow further.
        </div>
      )}

      <div
        className="overflow-auto rounded-b-lg border border-border-strong bg-surface"
        style={{ maxHeight: "calc(100vh - 220px)" }}
      >
        {/* Bounded data-grid viewport: scrolls both axes internally with a
            sticky header and pinned first column (same shell as
            Opportunities); columns keep real, user-resizable pixel widths. */}
        <table className="w-full table-fixed border-collapse" style={{ minWidth: tableMinWidth }}>
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-20 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>{visibleCols.map((key, idx) => (
              <ResizableTh
                key={key}
                width={widths[key]}
                onStartResize={(e) => startResize(key, e)}
                isLast={idx === visibleCols.length - 1}
                drag={{
                  onDragStart: () => setDragCol(key),
                  onDragEnter: () => setDropCol(key),
                  onDrop: () => { if (dragCol) moveCol(dragCol, key); setDragCol(null); setDropCol(null); },
                  onDragEnd: () => { setDragCol(null); setDropCol(null); },
                  dragging: dragCol === key,
                  // The line marks where the column will land: to the right of
                  // the target when dragging rightwards, left when leftwards.
                  dropEdge: dragCol && dropCol === key && dragCol !== key
                    ? (visibleCols.indexOf(dragCol) < idx ? "right" : "left")
                    : null,
                }}
                className={cn("py-1.5 font-semibold", idx === 0 && "sticky left-0 z-30")}
              >
                {key === "name" ? (
                  <span className="flex items-center gap-2">
                    <input type="checkbox" checked={allFilteredSelected} ref={(el) => { if (el) el.indeterminate = !allFilteredSelected && selected.size > 0; }} onChange={toggleSelectAll} className="h-3.5 w-3.5 shrink-0 accent-[color:var(--accent,#4242EA)]" title={allFilteredSelected ? "Clear selection" : `Select all ${filteredIds.length}`} aria-label="Select all filtered contacts" />
                    <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} />
                  </span>
                ) : SORTABLE.has(key) ? <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} /> : COL_LABELS[key]}
              </ResizableTh>
            ))}</tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading contacts…</td></tr>
            ) : isError ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-red">Couldn't load contacts.{" "}<button type="button" className="text-accent underline underline-offset-2" onClick={() => refetch()}>Retry</button></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">No contacts match.{" "}<button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setRules([]); }}>Clear filters</button></td></tr>
            ) : grouped ? (
              grouped.map((item) => item.kind !== "header" ? renderRow(item.c) : groupingByAccount ? (
                <AccountGroupHeader
                  key={`g-${item.key}`}
                  label={item.label}
                  account={item.account}
                  shown={item.count}
                  collapsed={item.collapsed}
                  colSpan={visibleCols.length}
                  onToggle={() => toggleGroup(item.key)}
                  notesOpen={notesKey === item.key}
                  onToggleNotes={() => setNotesKey((p) => (p === item.key ? null : item.key))}
                />
              ) : (
                <tr key={`g-${item.key}`} className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2" onClick={() => toggleGroup(item.key)}>
                  <td colSpan={visibleCols.length} className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2"><span className="inline-block w-3 text-ink-3">{item.collapsed ? "▸" : "▾"}</span>{item.label}<span className="ml-2 normal-case tracking-normal text-ink-3">{item.count}</span></td>
                </tr>
              ))
            ) : (
              <>
                {(showAllRows ? filtered : filtered.slice(0, 300)).map(renderRow)}
                {!showAllRows && filtered.length > 300 && (
                  <tr>
                    <td colSpan={visibleCols.length} className="border-t border-border-strong px-6 py-2.5 text-center text-[12px] text-ink-3">
                      Showing 300 of {filtered.length.toLocaleString()} —{" "}
                      <button type="button" className="text-accent underline underline-offset-2" onClick={() => setShowAllRows(true)}>show all</button>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * /jobs/contacts — Contacts as its own routed page (2026-07 nav restructure).
 * Deep-link params: ?q=<text> seeds the find-any search; ?contact=<id> opens
 * that contact's detail drawer.
 */
export function JobsContactsPage() {
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? undefined;
  const contactParam = searchParams.get("contact");
  const initialContactId = contactParam && /^\d+$/.test(contactParam) ? Number(contactParam) : undefined;
  const initialConnectedOnly = searchParams.get("connected") === "1";
  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader title="Contacts" subtitle="All employer contacts." />
      <JobsContacts initialQuery={initialQuery} initialContactId={initialContactId} initialConnectedOnly={initialConnectedOnly} />
    </div>
  );
}
