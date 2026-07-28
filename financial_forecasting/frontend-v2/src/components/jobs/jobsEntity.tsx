/**
 * Shared jobs-entity UI bits used across the Accounts/Contacts tabs, the expand
 * panels, and the detail pages — so opportunities, contacts, owners, and the
 * contact tab-set all render and link the same way everywhere.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Briefcase, ExternalLink, Linkedin, Plus } from "lucide-react";

import { withReferrer } from "@/components/detail";
import { JobsActivityList } from "@/components/jobs/JobsActivityList";
import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { initials, LogActivityForm } from "@/components/jobs/ProspectAccountExpandPanel";
import { RequestIntroDialog } from "@/components/jobs/RequestIntroDialog";
import { RowExpandPanel } from "@/components/RowExpandPanel";
import { InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";
import {
  useContactDetail,
  useContactOpportunities,
  useUpdateOpportunity,
  type OpenRole,
  type CompanyBuilderRole,
  STAGE_LABELS,
  type JobStage,
  type DealType,
  type JobsStaff,
} from "@/services/jobs";

export const DEAL_TYPE_OPTIONS = (["ft", "pt_contract", "capstone", "volunteer", "workshop", "pilot"] as DealType[])
  .map((v) => ({ value: v, label: { ft: "Full time", pt_contract: "PT / Contract", capstone: "Capstone", volunteer: "Volunteer", workshop: "Workshop", pilot: "Pilot" }[v] }));

/** Display name for an opportunity — role title, else deal-type, else generic. */
export function oppRoleLabel(opp: { title?: string | null; deal_type?: DealType | null }): string {
  const t = opp.title?.trim();
  if (t) return t;
  if (opp.deal_type) return `${DEAL_TYPE_LABELS[opp.deal_type] ?? opp.deal_type} role`;
  return "Opportunity";
}

// ── Route helpers ────────────────────────────────────────────────────────────
export const jobsOpportunityPath = (id: string) => `/jobs/opportunities/${id}`;
export const jobsContactPath = (id: number) => `/jobs/contacts/${id}`;
export const jobsAccountPath = (key: string) => `/jobs/accounts/${encodeURIComponent(key)}`;

const jobsRef = withReferrer({ pathname: "/jobs", label: "Jobs" });

// ── Shared styling ─────────────────────────────────────────────────────────────
export const DEAL_STAGE_STYLE = (stage: JobStage): string => {
  if (stage.startsWith("active")) return "bg-accent-soft text-accent-ink";
  if (stage === "closed_won")      return "bg-green-soft text-green";
  if (stage === "closed_lost")     return "bg-stone-100 text-stone-500";
  if (stage.startsWith("on_hold")) return "bg-amber-soft text-amber";
  return "bg-stone-100 text-stone-500";
};

export const DEAL_TYPE_LABELS: Record<DealType, string> = {
  ft: "Full time", pt_contract: "PT / Contract", capstone: "Capstone",
  volunteer: "Volunteer", workshop: "Workshop", pilot: "Pilot",
};

const CONTACT_STAGE_STYLES: Record<string, { label: string; className: string }> = {
  active:           { label: "Active",   className: "bg-green-50 text-green-700" },
  initial_outreach: { label: "Outreach", className: "bg-accent-soft text-accent-ink" },
  lead:             { label: "Lead",     className: "bg-stone-100 text-stone-500" },
  on_hold:          { label: "On Hold",  className: "bg-amber-50 text-amber-600" },
};

export function ContactStagePill({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-ink-4">—</span>;
  const s = CONTACT_STAGE_STYLES[stage];
  if (!s) return <span className="text-[12px] text-ink-2">{stage}</span>;
  return <span className={cn("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", s.className)}>{s.label}</span>;
}

export function DealStagePill({ stage }: { stage: JobStage }) {
  return <span className={cn("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", DEAL_STAGE_STYLE(stage))}>{STAGE_LABELS[stage] ?? stage}</span>;
}

// ── Linkable opportunity row ─────────────────────────────────────────────────────
export interface OppRowData {
  id: string;
  title: string | null;
  stage: JobStage;
  deal_type: DealType | null;
  num_roles?: number | null;
  account_name?: string | null;
}

/** Small "Jobs" / "SF" provenance badge for opportunities + contacts. */
export function SourceBadge({ source }: { source?: "jobs" | "sf" | "linkedin" | null }) {
  if (!source) return null;
  const m = {
    jobs:     { label: "Jobs", cls: "bg-accent-soft text-accent-ink" },
    sf:       { label: "SF", cls: "bg-sky-50 text-sky-700" },
    linkedin: { label: "LinkedIn", cls: "bg-indigo-50 text-indigo-600" },
  }[source];
  return <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase leading-none", m.cls)}>{m.label}</span>;
}

/** Read-only opportunity row that links to the opp detail page. */
export function JobsOppRow({ opp, source }: { opp: OppRowData; source?: "jobs" | "sf" }) {
  return (
    <Link to={jobsOpportunityPath(opp.id)} state={jobsRef} className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-2 transition-colors hover:border-accent/50 hover:bg-surface-2/40">
      <Briefcase size={13} className="shrink-0 text-ink-4" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{oppRoleLabel(opp)}</span>
      {opp.account_name && <span className="hidden max-w-[35%] truncate text-[11.5px] text-ink-4 sm:block">{opp.account_name}</span>}
      <SourceBadge source={source} />
      {opp.deal_type && <span className="shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-ink-4">{DEAL_TYPE_LABELS[opp.deal_type] ?? opp.deal_type}</span>}
      <DealStagePill stage={opp.stage} />
      <ExternalLink size={12} className="shrink-0 text-ink-4" />
    </Link>
  );
}

const STAGE_OPTIONS: { value: JobStage; label: string }[] = [
  "initial_outreach", "active_in_discussions", "active_opportunity_confirmed", "active_builder_interview",
  "closed_won", "closed_lost", "on_hold_not_selected", "on_hold_not_interested", "on_hold_not_responsive",
].map((s) => ({ value: s as JobStage, label: STAGE_LABELS[s as JobStage] ?? s }));

/** Inline-editable opportunity row (name/stage/deal-type) used in expansions. */
export function EditableOppRow({ opp }: { opp: OppRowData }) {
  const update = useUpdateOpportunity();
  const save = (field: string, val: unknown) => update.mutateAsync({ id: opp.id, [field]: val }).then(() => undefined);
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-2">
      <Briefcase size={13} className="shrink-0 text-ink-4" />
      <span className="min-w-0 flex-1">
        <InlineText value={opp.title ?? null} placeholder={oppRoleLabel(opp)} onSave={(v) => save("title", v)} className="text-[12.5px] font-medium text-ink" />
      </span>
      <span onClick={(e) => e.stopPropagation()} className="shrink-0">
        <InlineSelect<string> value={opp.deal_type ?? null} options={DEAL_TYPE_OPTIONS} emptyLabel="type" onSave={(v) => save("deal_type", v || null)} />
      </span>
      <span onClick={(e) => e.stopPropagation()} className="shrink-0">
        <InlineSelect<JobStage> value={opp.stage} options={STAGE_OPTIONS} renderValue={(v) => <DealStagePill stage={(v ?? opp.stage) as JobStage} />} onSave={(v) => save("stage", v)} />
      </span>
      <Link to={jobsOpportunityPath(opp.id)} state={jobsRef} className="shrink-0 text-ink-4 hover:text-accent" title="Open opportunity"><ExternalLink size={12} /></Link>
    </div>
  );
}

// ── Linkable contact row ─────────────────────────────────────────────────────────
export interface ContactRowData {
  contact_id: number;
  full_name: string | null;
  current_title?: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

/** Inline-editable contact row (stage) with name link to detail. */
export function JobsContactRow({ contact, source }: { contact: ContactRowData; source?: "jobs" | "sf" | "linkedin" }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-2 hover:border-accent/50">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold leading-none text-accent-ink">{initials(contact.full_name)}</span>
      <Link to={jobsContactPath(contact.contact_id)} state={jobsRef} className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink hover:text-accent">{contact.full_name || "—"}</Link>
      {contact.current_title && <span className="hidden max-w-[35%] truncate text-[12px] text-ink-3 sm:block">{contact.current_title}</span>}
      <SourceBadge source={source} />
      {contact.linkedin_url
        ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-3 hover:text-accent"><Linkedin size={13} /></a>
        : <span className="w-[13px] shrink-0" />}
      <Link to={jobsContactPath(contact.contact_id)} state={jobsRef} className="shrink-0 text-ink-4 hover:text-accent" title="Open contact"><ExternalLink size={12} /></Link>
    </div>
  );
}

// ── Inline owner editor ──────────────────────────────────────────────────────────
export function OwnerSelect({
  owner, staff, onSave, className,
}: {
  owner: string | null;
  staff: JobsStaff[];
  onSave: (email: string) => Promise<void>;
  className?: string;
}) {
  const options = useMemo(() => staff.map((s) => ({ value: s.email, label: s.name })), [staff]);
  return (
    <span onClick={(e) => e.stopPropagation()} className={className}>
      <InlineSelect<string>
        value={owner}
        options={options}
        emptyLabel="Unassigned"
        renderValue={(v) => (
          <span className="text-[12px] text-ink-2">{v ? (staff.find((s) => s.email === v)?.name ?? v.split("@")[0]) : <span className="text-ink-4">Unassigned</span>}</span>
        )}
        onSave={onSave}
      />
    </span>
  );
}

// ── Tab content blocks ───────────────────────────────────────────────────────────
export function OppsTab({ opps }: { opps: OppRowData[] }) {
  if (opps.length === 0) return <div className="px-4 py-6 text-[12.5px] text-ink-3">No opportunities.</div>;
  return <div className="flex flex-col gap-1.5 p-4">{opps.map((o) => <EditableOppRow key={o.id} opp={o} />)}</div>;
}

export function ContactsLinkTab({ contacts }: { contacts: ContactRowData[] }) {
  if (contacts.length === 0) return <div className="px-4 py-6 text-[12.5px] text-ink-3">No contacts.</div>;
  return <div className="flex flex-col gap-1.5 p-4">{contacts.map((c) => <JobsContactRow key={c.contact_id} contact={c} />)}</div>;
}

/** Contact's Opportunities tab — fetches the backlinks itself. */
export function ContactOppsTab({ contactId }: { contactId: number }) {
  const { data: opps = [], isLoading } = useContactOpportunities(contactId);
  if (isLoading) return <div className="px-4 py-6 text-[12.5px] text-ink-3">Loading…</div>;
  return <OppsTab opps={opps} />;
}

/** Contact's Activity tab — reads activity off the contact detail query, and
 * lets the user log a manual touch (call / text / LinkedIn) inline. */
export function ContactActivityTab({ contactId }: { contactId: number }) {
  const { data, isLoading } = useContactDetail(contactId);
  const [logging, setLogging] = useState(false);
  if (isLoading) return <div className="px-4 py-6 text-[12.5px] text-ink-3">Loading…</div>;
  return (
    <div className="flex flex-col">
      <div className="flex justify-end px-3 pt-2">
        {logging ? null : (
          <button type="button" onClick={() => setLogging(true)}
            className="inline-flex items-center gap-1 rounded border border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-3 hover:border-accent hover:text-accent">
            <Plus size={11} /> Log activity
          </button>
        )}
      </div>
      {logging && <div className="px-3 pt-2"><LogActivityForm contactId={contactId} onClose={() => setLogging(false)} /></div>}
      <JobsActivityList entries={data?.activity ?? []} emptyMessage="No emails, meetings, or logged touches for this contact yet." />
    </div>
  );
}

/** The full contact expand panel — Activity · Opportunities · Tasks · Comments,
 * plus the contact-level actions (open detail, request intro) so the row a
 * user is already working in covers the whole workflow. */
function ContactOpenRolesTab({ roles }: { roles: OpenRole[] }) {
  if (!roles.length) return <div className="p-4 text-[12px] italic text-ink-3">No roles sourced at this company yet.</div>;
  return (
    <div className="flex flex-col divide-y divide-border">
      {roles.map((r) => (
        <div key={r.id} className="flex items-center gap-3 px-4 py-2">
          <Briefcase size={13} className="shrink-0 text-ink-4" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink">{r.job_title || "—"}</div>
            <div className="truncate text-[11.5px] text-ink-3">{[r.location, r.salary_range, r.aligned_sector].filter(Boolean).join(" · ") || "—"}</div>
          </div>
          {r.status && <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">{r.status}</span>}
          {r.job_url && <a href={r.job_url} target="_blank" rel="noreferrer" className="shrink-0 text-ink-4 hover:text-accent" title="Open posting"><ExternalLink size={13} /></a>}
        </div>
      ))}
    </div>
  );
}

function ContactBuilderAppsTab({ apps }: { apps: CompanyBuilderRole[] }) {
  if (!apps.length) return <div className="p-4 text-[12px] italic text-ink-3">No builder applications at this company yet.</div>;
  return (
    <div className="flex flex-col divide-y divide-border">
      {apps.map((a) => (
        <div key={a.role_title} className="flex items-center gap-3 px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink">{a.role_title}</div>
            <div className="truncate text-[11.5px] text-ink-3">{[`${a.applicant_count} builder${a.applicant_count === 1 ? "" : "s"}`, a.source_type].filter(Boolean).join(" · ")}</div>
          </div>
          {!a.team_linked && <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">self-applied</span>}
          {(a.stages ?? []).slice(0, 3).map((s) => <span key={s} className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">{s}</span>)}
        </div>
      ))}
    </div>
  );
}

// Job-listings activity at the company — team-sourced roles + jobs builders
// applied to on their own. Both are "there are jobs here worth a warm intro."
function ContactJobListingsTab({ roles, apps }: { roles: OpenRole[]; apps: CompanyBuilderRole[] }) {
  if (!roles.length && !apps.length) return <div className="p-4 text-[12px] italic text-ink-3">No job-listings activity at this company yet.</div>;
  const hdr = "bg-surface-2/40 px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4";
  return (
    <div className="flex flex-col">
      {roles.length > 0 && <><div className={hdr}>Team-sourced ({roles.length})</div><ContactOpenRolesTab roles={roles} /></>}
      {apps.length > 0 && <><div className={hdr}>Builders applied ({apps.length})</div><ContactBuilderAppsTab apps={apps} /></>}
    </div>
  );
}

export function ContactExpandTabs({ contactId }: { contactId: number }) {
  const { data } = useContactOpportunities(contactId);
  const detail = useContactDetail(contactId);
  const roles = detail.data?.open_roles_list ?? [];
  const apps = detail.data?.builder_applications ?? [];
  const [introOpen, setIntroOpen] = useState(false);
  const id = String(contactId);
  return (
    <div className="relative">
      <div className="absolute right-3 top-1.5 z-10 flex items-center gap-2">
        <button type="button" onClick={() => setIntroOpen(true)}
          className="rounded border border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-3 hover:border-accent hover:text-accent">
          Request intro
        </button>
        <Link to={jobsContactPath(contactId)} state={jobsRef} className="rounded border border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-3 hover:border-accent hover:text-accent">
          Open ↗
        </Link>
      </div>
      <RowExpandPanel
        tabs={[
          { id: "activity", label: "Activity", render: () => <ContactActivityTab contactId={contactId} /> },
          { id: "opps", label: "Opportunities", count: data?.length ?? null, render: () => <ContactOppsTab contactId={contactId} /> },
          { id: "listings", label: "Job listings", count: (roles.length + apps.length) || null, render: () => <ContactJobListingsTab roles={roles} apps={apps} /> },
          { id: "tasks", label: "Tasks", render: () => <div className="p-3"><JobsTasks parentType="prospect" parentId={id} /></div> },
          { id: "comments", label: "Comments", render: () => <div className="p-3"><JobsComments parentType="prospect" parentId={id} /></div> },
        ]}
      />
      {introOpen && <RequestIntroDialog contactId={contactId} contactName="this contact" onClose={() => setIntroOpen(false)} />}
    </div>
  );
}

// re-export so callers can grab initials from one place
export { initials };

// ── Warmth — recency + responsiveness (not just our outbound volume).
//   Hot  = they RESPONDED recently (two-way ≤14d, or ≤30d with real volume)
//   Warm = responded within 90d (cooling)
//   Cool = activity within 90d but NO response yet (outbound-only / awaiting)
//   Cold = nothing in 90 days (dormant) — or never touched
// "responded" = a meeting, a call, or an inbound email (computed server-side).
export interface WarmthInput { recent?: number; last_activity_at?: string | null; responded?: boolean }

function daysSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// Numeric rank for sorting: Hot 3 → Cold 0.
export function warmthRank(w: WarmthInput): number {
  const l = warmthTier(w).label;
  return l === "Hot" ? 3 : l === "Warm" ? 2 : l === "Cool" ? 1 : 0;
}

export function warmthTier(w: WarmthInput): { label: string; dot: string; txt: string; hint: string } {
  const d = daysSince(w.last_activity_at);
  const recent = w.recent ?? 0;
  const responded = !!w.responded;
  if (d > 90 || recent === 0) return { label: "Cold", dot: "bg-stone-300", txt: "text-ink-4", hint: "no activity in 90+ days" };
  if (responded && (d <= 14 || (d <= 30 && recent >= 8)))
    return { label: "Hot", dot: "bg-red", txt: "text-red", hint: `responded · last activity ${d}d ago` };
  if (responded) return { label: "Warm", dot: "bg-amber", txt: "text-amber", hint: `responded · last activity ${d}d ago` };
  return { label: "Cool", dot: "bg-sky-400", txt: "text-sky-600", hint: `${recent} touch${recent === 1 ? "" : "es"}, no response yet` };
}

export function AccountWarmth(w: WarmthInput) {
  const t = warmthTier(w);
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium", t.txt)} title={t.hint}>
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", t.dot)} />{t.label}
    </span>
  );
}
