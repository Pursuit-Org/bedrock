/**
 * Account expand-panel tabs (RowExpandPanel): Opportunities · Contacts ·
 * Activity · Tasks · Comments · Builders · Roles.
 *
 * Everything is manageable here, mirroring the rest of the app:
 *  - Opportunities/Contacts: inline-editable rows + add (new opp; add existing
 *    or new contact).
 *  - Builders/Roles: grouped per opportunity, each using the existing addable
 *    OppBuilderActivity / OppRolesSection so a builder/role is always linked to
 *    a specific opportunity.
 *  - Tasks/Comments: account-direct (JobsTasks/JobsComments parentType=account)
 *    plus a read rollup of items tagged to the account's opps + contacts, each
 *    chipped with what it's tagged to.
 *  - Activity: read rollup across opps+contacts + a "log activity" form.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Briefcase, CheckSquare, ExternalLink, MessageSquare, Plus, Trash2, User, X } from "lucide-react";

import { JobsActivityList } from "@/components/jobs/JobsActivityList";
import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { OppRolesSection } from "@/components/jobs/OppRolesSection";
import { RowExpandPanel } from "@/components/RowExpandPanel";
import { withReferrer } from "@/components/detail";
import { InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";
import {
  useAccountActivity,
  useAccountBuilders,
  useAccountComments,
  useAccountProspects,
  useAccountRoles,
  useAccountTasks,
  useAddContactToJobs,
  useBuilders,
  useContactSearch,
  useCreateContact,
  useCreateOpportunity,
  useDeleteOpportunity,
  useJobsStaff,
  useLogActivity,
  useUpdateOpportunity,
  STAGE_LABELS,
  type AccountBuilderRow,
  type AccountComment,
  type AccountTask,
  type DealType,
  type JobStage,
  type JobsAccount,
} from "@/services/jobs";
import {
  useCreateBuilderActivity, useUpdateBuilderActivity,
  type AppStage,
} from "@/services/jobsOpps2";

import {
  ContactsLinkTab, DealStagePill, DEAL_TYPE_OPTIONS, OwnerSelect,
  initials, jobsContactPath, jobsOpportunityPath, oppRoleLabel,
} from "./jobsEntity";

const OPP_STAGE_OPTIONS: { value: JobStage; label: string }[] = ([
  "initial_outreach", "active_in_discussions", "active_opportunity_confirmed", "active_builder_interview",
  "closed_won", "closed_lost", "on_hold_not_selected", "on_hold_not_interested", "on_hold_not_responsive",
] as JobStage[]).map((s) => ({ value: s, label: STAGE_LABELS[s] ?? s }));

const jobsRef = withReferrer({ pathname: "/jobs", label: "Jobs" });
const inputCls = "h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent";

function Loading() { return <div className="px-4 py-6 text-[12.5px] text-ink-3">Loading…</div>; }
function Empty({ children }: { children: React.ReactNode }) { return <div className="px-4 py-6 text-[12.5px] text-ink-3">{children}</div>; }

function ScopeChip({ scope, label, parentId }: { scope: "opportunity" | "contact"; label: string; parentId?: string }) {
  const to = scope === "opportunity" ? (parentId ? jobsOpportunityPath(parentId) : null) : (parentId ? jobsContactPath(Number(parentId)) : null);
  const cls = scope === "opportunity" ? "bg-accent-soft text-accent-ink" : "bg-sky-50 text-sky-700";
  const inner = (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", cls)}>
      {scope === "opportunity" ? <Briefcase size={9} /> : <User size={9} />}{label || (scope === "opportunity" ? "Opportunity" : "Contact")}
    </span>
  );
  return to ? <Link to={to} state={jobsRef} className="hover:opacity-80">{inner}</Link> : inner;
}

// ── Opportunities — table (Role / Stage / Owner / Deal type), create row on top ───────
function AccountOppsTab({ account }: { account: JobsAccount }) {
  const { data: staff = [] } = useJobsStaff();
  const create = useCreateOpportunity();
  const update = useUpdateOpportunity();
  const del = useDeleteOpportunity();
  const patch = (id: string, field: string, val: unknown) => update.mutateAsync({ id, [field]: val }).then(() => undefined);
  const removeOpp = (id: string, label: string) => { if (window.confirm(`Delete opportunity "${label}"? This removes it from the pipeline.`)) del.mutate(id); };

  // create form (role/stage/owner/deal type/likelihood/# roles all required; role can be "TBD")
  const [role, setRole] = useState("");
  const [stage, setStage] = useState<JobStage>("active_in_discussions");
  const [owner, setOwner] = useState("");
  const [dealType, setDealType] = useState<DealType | "">("");
  const [likelihood, setLikelihood] = useState<"" | "low" | "medium" | "high">("");
  const [numRoles, setNumRoles] = useState("1");
  const [adding, setAdding] = useState(false);
  const canCreate = role.trim() !== "" && owner !== "" && dealType !== "" && likelihood !== "" && numRoles.trim() !== "";
  const submit = () => {
    if (!canCreate) return;
    create.mutate(
      { account_id: account.account_id ?? "UNKNOWN", account_name: account.account, title: role.trim(), stage, owner_email: owner, deal_type: dealType as DealType, likelihood: likelihood as "low" | "medium" | "high", num_roles: Number(numRoles) || 1 },
      { onSuccess: () => { setRole(""); setOwner(""); setDealType(""); setLikelihood(""); setNumRoles("1"); setStage("active_in_discussions"); setAdding(false); } },
    );
  };

  return (
    <div className="p-3">
      <div className="overflow-hidden rounded border border-border-strong bg-surface">
        <table className="w-full table-fixed text-[12px]">
          <colgroup><col /><col style={{ width: "17%" }} /><col style={{ width: "16%" }} /><col style={{ width: "13%" }} /><col style={{ width: "12%" }} /><col style={{ width: "8%" }} /><col style={{ width: 56 }} /></colgroup>
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3"><tr>
            <th className="px-2 py-1.5 text-left font-semibold">Opportunity</th><th className="px-2 py-1.5 text-left font-semibold">Stage</th>
            <th className="px-2 py-1.5 text-left font-semibold">Owner</th><th className="px-2 py-1.5 text-left font-semibold">Deal type</th>
            <th className="px-2 py-1.5 text-left font-semibold">Likelihood</th><th className="px-2 py-1.5 text-left font-semibold"># Roles</th><th className="px-2 py-1.5" />
          </tr></thead>
          <tbody>
            {account.opportunities.length === 0 && !adding ? (
              <tr><td colSpan={7} className="px-4 py-4 text-center text-[12px] italic text-ink-3">No opportunities yet.</td></tr>
            ) : account.opportunities.map((o) => (
              <tr key={o.id} className="border-t border-border-strong/60">
                <td className="overflow-hidden px-2 py-1.5"><InlineText value={o.title ?? null} placeholder={oppRoleLabel(o)} onSave={(v) => patch(o.id, "title", v)} className="text-[12.5px] font-medium text-ink" /></td>
                <td className="overflow-hidden px-2 py-1.5"><InlineSelect<JobStage> value={o.stage} options={OPP_STAGE_OPTIONS} renderValue={(v) => <DealStagePill stage={(v ?? o.stage) as JobStage} />} onSave={(v) => patch(o.id, "stage", v)} /></td>
                <td className="overflow-hidden px-2 py-1.5"><OwnerSelect owner={o.owner_email} staff={staff} onSave={(email) => patch(o.id, "owner_email", email)} /></td>
                <td className="overflow-hidden px-2 py-1.5"><InlineSelect<string> value={o.deal_type ?? null} options={DEAL_TYPE_OPTIONS} emptyLabel="—" onSave={(v) => patch(o.id, "deal_type", v || null)} /></td>
                <td className="overflow-hidden px-2 py-1.5"><InlineSelect<string> value={o.likelihood ?? null} options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} emptyLabel="—" onSave={(v) => patch(o.id, "likelihood", v || null)} /></td>
                <td className="overflow-hidden px-2 py-1.5"><InlineText value={o.num_roles != null ? String(o.num_roles) : null} placeholder="—" onSave={(v) => patch(o.id, "num_roles", v ? Number(v) : null)} className="text-[12px] text-ink-2" /></td>
                <td className="px-1 py-1.5">
                  <div className="flex items-center justify-center gap-2">
                    <Link to={jobsOpportunityPath(o.id)} state={jobsRef} className="text-ink-4 hover:text-accent" title="Open opportunity"><ExternalLink size={12} /></Link>
                    <button type="button" onClick={() => removeOpp(o.id, oppRoleLabel(o))} title="Delete opportunity" className="text-ink-4 hover:text-red"><Trash2 size={12} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {/* add row at the bottom — collapsed trigger until you click it (tasks-style) */}
            {adding ? (
              <tr className="border-t border-border-strong bg-surface-2/40">
                <td className="px-2 py-1.5"><input autoFocus value={role} onChange={(e) => setRole(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setAdding(false); }} placeholder="Opportunity name *" className="w-full border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4" /></td>
                <td className="px-2 py-1.5"><select value={stage} onChange={(e) => setStage(e.target.value as JobStage)} className="h-6 w-full rounded border border-border-strong bg-surface px-1 text-[11.5px] outline-none focus:border-accent">{OPP_STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
                <td className="px-2 py-1.5"><select value={owner} onChange={(e) => setOwner(e.target.value)} className={cn("h-6 w-full rounded border bg-surface px-1 text-[11.5px] outline-none focus:border-accent", owner ? "border-border-strong" : "border-amber-300")}><option value="">Owner *</option>{staff.map((s) => <option key={s.email} value={s.email}>{s.name}</option>)}</select></td>
                <td className="px-2 py-1.5"><select value={dealType} onChange={(e) => setDealType(e.target.value as DealType | "")} className={cn("h-6 w-full rounded border bg-surface px-1 text-[11.5px] outline-none focus:border-accent", dealType ? "border-border-strong" : "border-amber-300")}><option value="">Type *</option>{DEAL_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
                <td className="px-2 py-1.5"><select value={likelihood} onChange={(e) => setLikelihood(e.target.value as "" | "low" | "medium" | "high")} className={cn("h-6 w-full rounded border bg-surface px-1 text-[11.5px] outline-none focus:border-accent", likelihood ? "border-border-strong" : "border-amber-300")}><option value="">— *</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></td>
                <td className="px-2 py-1.5"><input type="number" min="1" value={numRoles} onChange={(e) => setNumRoles(e.target.value)} className="h-6 w-full rounded border border-border-strong bg-surface px-1 text-[11.5px] outline-none focus:border-accent" /></td>
                <td className="px-1 py-1.5 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button type="button" disabled={!canCreate || create.isPending} onClick={submit} title="Create opportunity" className="text-ink-3 hover:text-accent disabled:opacity-30"><Plus size={15} /></button>
                    <button type="button" onClick={() => setAdding(false)} title="Cancel" className="text-ink-4 hover:text-ink"><X size={13} /></button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr className="border-t border-border-strong">
                <td colSpan={7} className="px-2 py-1.5">
                  <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-[12px] font-medium text-ink-3 hover:text-accent"><Plus size={13} /> New opportunity</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Contacts — add/search ABOVE the list ─────────────────────────────────────────────
function AccountContactsTab({ account, scope = "engaged" }: { account: JobsAccount; scope?: "engaged" | "all" }) {
  const [mode, setMode] = useState<null | "existing" | "new">(null);
  const [search, setSearch] = useState("");
  const { data: prospects = [] } = useAccountProspects(account.account_key, scope);
  const { data: results = [] } = useContactSearch(search);
  const addToJobs = useAddContactToJobs();
  const createContact = useCreateContact();
  const [form, setForm] = useState({ full_name: "", email: "", title: "", linkedin: "" });

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* actions on top */}
      <div className="rounded-md border border-border-strong bg-surface-2/40 px-3 py-2">
        {mode === null && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Add contact</span>
            <button type="button" onClick={() => setMode("existing")} className="flex items-center gap-1 rounded border border-border-strong bg-surface px-2.5 py-1 text-[12px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={12} /> Existing</button>
            <button type="button" onClick={() => setMode("new")} className="flex items-center gap-1 rounded border border-border-strong bg-surface px-2.5 py-1 text-[12px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={12} /> New</button>
          </div>
        )}
        {mode === "existing" && (
          <div>
            <div className="flex items-center gap-2">
              <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search contacts to add…" className={cn(inputCls, "flex-1 bg-surface")} />
              <button type="button" onClick={() => { setMode(null); setSearch(""); }} className="text-ink-3 hover:text-ink"><X size={14} /></button>
            </div>
            {search.trim().length >= 2 && (
              <div className="mt-2 flex flex-col gap-1">
                {results.slice(0, 8).map((r) => (
                  <div key={r.contact_id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[9px] font-bold text-accent-ink">{initials(r.full_name)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{r.full_name}</span>
                    {r.airtable_id ? <span className="text-[10px] text-ink-4">already in jobs</span> : (
                      <button type="button" onClick={() => addToJobs.mutate({ id: r.contact_id, add: true })} className="rounded border border-border-strong px-1.5 py-0.5 text-[10px] text-ink-3 hover:border-accent hover:text-accent">+ Add</button>
                    )}
                  </div>
                ))}
                {results.length === 0 && <span className="px-2 text-[11px] text-ink-4">No matches.</span>}
              </div>
            )}
          </div>
        )}
        {mode === "new" && (
          <div className="flex flex-wrap items-center gap-2">
            <input autoFocus value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Full name *" className={cn(inputCls, "w-40 bg-surface")} />
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" className={cn(inputCls, "w-44 bg-surface")} />
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" className={cn(inputCls, "w-36 bg-surface")} />
            <button type="button" disabled={!form.full_name.trim() || createContact.isPending} onClick={() => createContact.mutate({ full_name: form.full_name.trim(), email: form.email.trim() || undefined, current_title: form.title.trim() || undefined, current_company: account.account, contact_stage: "active" }, { onSuccess: () => { setForm({ full_name: "", email: "", title: "", linkedin: "" }); setMode(null); } })} className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">Create</button>
            <button type="button" onClick={() => setMode(null)} className="text-ink-3 hover:text-ink"><X size={14} /></button>
          </div>
        )}
      </div>
      <ContactsLinkTab contacts={prospects} />
    </div>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────────────
function AccountActivityTab({ account, scope = "engaged" }: { account: JobsAccount; scope?: "engaged" | "all" }) {
  const { data, isLoading } = useAccountActivity(account.account_key);
  const { data: prospects = [] } = useAccountProspects(account.account_key, scope);
  const log = useLogActivity();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"call" | "text" | "linkedin">("call");
  const [target, setTarget] = useState("");          // "opp:<id>" | "contact:<id>"
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");

  const submit = () => {
    const [kind, id] = target.split(":");
    const body = kind === "opp" ? { jobs_opportunity_id: id } : { contact_id: Number(id) };
    log.mutate({ ...body, type, description: note.trim(), activity_date: date || undefined } as Parameters<typeof log.mutate>[0], { onSuccess: () => { setNote(""); setOpen(false); } });
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Activity</span>
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={11} /> Log</button>
      </div>
      {open && (
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-strong bg-surface-2/40 px-3 py-2">
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className={inputCls}>
            <option value="call">Call</option><option value="text">Text</option><option value="linkedin">LinkedIn</option>
          </select>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={cn(inputCls, "max-w-[220px]")}>
            <option value="">Tag to…</option>
            {account.opportunities.map((o) => <option key={o.id} value={`opp:${o.id}`}>Opp · {oppRoleLabel(o)}</option>)}
            {prospects.map((c) => <option key={c.contact_id} value={`contact:${c.contact_id}`}>Contact · {c.full_name}</option>)}
          </select>
          <input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" className={cn(inputCls, "min-w-[200px] flex-1")} />
          <button type="button" disabled={!target || !note.trim() || log.isPending} onClick={submit} className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">Log</button>
        </div>
      )}
      {isLoading ? <Loading /> : <JobsActivityList entries={data ?? []} emptyMessage="No activity across this account's opportunities or contacts yet." />}
    </div>
  );
}

// ── Tasks ──────────────────────────────────────────────────────────────────────────
function TaskRollupRow({ t }: { t: AccountTask }) {
  const done = t.status === "done";
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-1.5">
      <CheckSquare size={12} className={cn("shrink-0", done ? "text-green-600" : "text-ink-4")} />
      <span className={cn("min-w-0 flex-1 truncate text-[12px]", done ? "text-ink-4 line-through" : "text-ink-2")}>{t.title || "Untitled task"}</span>
      <ScopeChip scope={t.scope} label={t.scope_label} parentId={t.parent_id} />
    </div>
  );
}

function AccountTasksTab({ accountKey }: { accountKey: string }) {
  const { data = [], isLoading } = useAccountTasks(accountKey);
  return (
    <div className="flex flex-col gap-3 p-3">
      <JobsTasks parentType="account" parentId={accountKey} />
      <div>
        <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">Tagged to opportunities &amp; contacts</div>
        {isLoading ? <Loading /> : data.length === 0 ? <Empty>None yet.</Empty> : (
          <div className="flex flex-col gap-1.5">{data.map((t) => <TaskRollupRow key={t.id} t={t} />)}</div>
        )}
      </div>
    </div>
  );
}

// ── Comments ─────────────────────────────────────────────────────────────────────────
function CommentRollupRow({ c }: { c: AccountComment }) {
  return (
    <div className="rounded-md border border-border-strong/70 bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <MessageSquare size={12} className="shrink-0 text-ink-4" />
        <span className="text-[11.5px] font-medium text-ink-2">{c.author_email ?? "—"}</span>
        <span className="ml-auto"><ScopeChip scope={c.scope} label={c.scope_label} /></span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-ink-2">{c.content}</p>
    </div>
  );
}

function AccountCommentsTab({ accountKey }: { accountKey: string }) {
  const { data = [], isLoading } = useAccountComments(accountKey);
  return (
    <div className="flex flex-col gap-3 p-3">
      <JobsComments parentType="account" parentId={accountKey} />
      <div>
        <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">On opportunities &amp; contacts</div>
        {isLoading ? <Loading /> : data.length === 0 ? <Empty>None yet.</Empty> : (
          <div className="flex flex-col gap-1.5">{data.map((c) => <CommentRollupRow key={c.id} c={c} />)}</div>
        )}
      </div>
    </div>
  );
}

// ── Roles — ONE table across the account's opps, each tagged to its opportunity ───────
function OppTag({ oppId, title }: { oppId: string; title: string | null }) {
  return (
    <Link to={jobsOpportunityPath(oppId)} state={jobsRef} className="inline-flex w-fit items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium leading-none text-accent-ink hover:opacity-80">
      <Briefcase size={9} />{title || "Opportunity"}
    </Link>
  );
}

/** Roles for the account — the SAME full editor as the opportunity detail
 *  (OppRolesSection: add/edit title, salary, commitment, trial, hire, delete),
 *  grouped per opportunity so each role stays linked to its deal. */
function AccountRolesTab({ account }: { account: JobsAccount }) {
  const opps = account.opportunities;
  if (opps.length === 0) {
    return <div className="p-3 text-[11.5px] text-ink-4">Add an opportunity first — roles link to one.</div>;
  }
  return (
    <div className="flex flex-col gap-4 p-3">
      {opps.map((o) => (
        <div key={o.id}>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-ink">
            <Briefcase size={11} className="text-ink-4" />
            <Link to={jobsOpportunityPath(o.id)} state={jobsRef} className="hover:text-accent">{oppRoleLabel(o)}</Link>
          </div>
          <OppRolesSection oppId={o.id} />
        </div>
      ))}
    </div>
  );
}

// ── Builders — ONE table across the account's opps, each tagged to its opportunity/role ─
const APP_STAGE_OPTIONS: { value: AppStage; label: string }[] = [
  { value: "applied", label: "Applied" }, { value: "interview", label: "Interview" }, { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" }, { value: "withdrawn", label: "Withdrawn" },
];
const APP_STAGE_BADGE: Record<string, string> = {
  applied: "bg-stone-100 text-stone-600", interview: "bg-accent-soft text-accent-ink",
  accepted: "bg-green-soft text-green", rejected: "bg-red-soft text-red", withdrawn: "bg-stone-100 text-stone-500",
};

/** Add-builder form — the builder attaches to a specific ROLE (which fixes the
 *  opp; builders link to roles, not opportunities). Just pick a stage + builder. */
function AddBuilderForm({ oppId, roleId, roleTitle, onDone }: { oppId: string; roleId: string; roleTitle?: string | null; onDone: () => void }) {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<AppStage>("applied");
  const { data: builders = [] } = useBuilders(search || undefined);
  const create = useCreateBuilderActivity(oppId);
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <select value={stage} onChange={(e) => setStage(e.target.value as AppStage)} className={cn(inputCls, "max-w-[150px] bg-surface")}>
        {APP_STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search builders…" className={cn(inputCls, "w-full")} />
      {search.trim().length >= 2 && (
        <div className="flex flex-col gap-0.5">
          {builders.slice(0, 6).map((b) => (
            <button key={b.user_id} type="button" onClick={() => create.mutate({ user_id: b.user_id, builder_name: b.name, stage, jobs_role_id: roleId, role_title: roleTitle ?? undefined }, { onSuccess: onDone })} className="flex items-center justify-between rounded px-2 py-1 text-left text-[12px] hover:bg-surface-2">
              <span className="truncate text-ink">{b.name}</span><span className="text-[10px] text-ink-4">{b.cohort}</span>
            </button>
          ))}
          {builders.length === 0 && <span className="px-2 text-[11px] text-ink-4">No matches.</span>}
        </div>
      )}
    </div>
  );
}

function AccountBuildersTab({ account }: { account: JobsAccount }) {
  const key = account.account_key;
  const { data, isLoading } = useAccountBuilders(key);
  const { data: accountRoles = [] } = useAccountRoles(key);
  const updateStage = useUpdateBuilderActivity("");   // PATCH by appId; invalidates ['jobs'] → refetches rollup
  const [roleId, setRoleId] = useState("");
  const activeRoles = accountRoles.filter((r) => r.status !== "cancelled");
  const selRole = activeRoles.find((r) => r.id === roleId);
  const rows = data?.rows ?? [];
  const s = data?.summary ?? {};
  return (
    <div className="flex flex-col gap-3 p-3">
      {/* add on top — pick the ROLE the builder is applying to */}
      {account.opportunities.length === 0 ? (
        <div className="rounded-md border border-border-strong bg-surface-2/40 px-3 py-2 text-[11.5px] text-ink-4">Add an opportunity first — builders apply to a role on one.</div>
      ) : activeRoles.length === 0 ? (
        <div className="rounded-md border border-border-strong bg-surface-2/40 px-3 py-2 text-[11.5px] text-ink-4">Add a role first — builders link to a specific role (see the Roles tab).</div>
      ) : (
        <div className="flex flex-col gap-1 rounded-md border border-border-strong bg-surface-2/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Add builder</span>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className={cn(inputCls, "max-w-[280px] bg-surface")}>
              <option value="">Pick a role…</option>
              {activeRoles.map((r) => <option key={r.id} value={r.id}>{r.title}{r.opp_title ? ` — ${r.opp_title}` : ""}{r.filled_by_user_id ? " (filled)" : ""}</option>)}
            </select>
          </div>
          {selRole && <AddBuilderForm oppId={selRole.opportunity_id} roleId={selRole.id} roleTitle={selRole.title} onDone={() => setRoleId("")} />}
        </div>
      )}
      {!isLoading && rows.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-ink-3"><span>{s.applied ?? 0} applied</span><span>·</span><span>{s.interview ?? 0} interviewing</span><span>·</span><span>{s.accepted ?? 0} hired</span></div>
      )}
      <div className="overflow-hidden rounded border border-border-strong bg-surface">
        <table className="w-full table-fixed text-[12px]">
          <colgroup><col style={{ width: "30%" }} /><col style={{ width: "38%" }} /><col style={{ width: "16%" }} /><col style={{ width: "16%" }} /></colgroup>
          <thead className="bg-surface-2 text-[10px] uppercase tracking-wider text-ink-4"><tr>
            <th className="px-2 py-1.5 text-left font-semibold">Builder</th><th className="px-2 py-1.5 text-left font-semibold">Opportunity / Role</th>
            <th className="px-2 py-1.5 text-left font-semibold">Stage</th><th className="px-2 py-1.5 text-left font-semibold">Applied</th>
          </tr></thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={4} className="px-4 py-4 text-center text-[12px] text-ink-3">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-4 text-center text-[12px] italic text-ink-3">No builders have applied to this account's opportunities yet.</td></tr>
            ) : rows.map((b: AccountBuilderRow) => (
              <tr key={b.job_application_id} className="border-t border-border-strong/60">
                <td className="overflow-hidden px-2 py-1.5"><span className="truncate text-[12.5px] font-medium text-ink">{b.builder || "—"}</span></td>
                <td className="overflow-hidden px-2 py-1.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {b.opportunity_id ? <OppTag oppId={b.opportunity_id} title={b.opp_title} /> : null}
                    {b.role_title && <span className="truncate text-[11px] text-ink-4">{b.role_title}</span>}
                  </span>
                </td>
                <td className="overflow-hidden px-2 py-1.5">
                  <InlineSelect<string> value={b.stage} options={APP_STAGE_OPTIONS} emptyLabel="—"
                    renderValue={(v) => <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", APP_STAGE_BADGE[v ?? ""] ?? "bg-stone-100 text-stone-500")}>{v ?? "—"}</span>}
                    onSave={(v) => updateStage.mutateAsync({ appId: b.job_application_id, stage: v as AppStage }).then(() => undefined)} />
                </td>
                <td className="overflow-hidden px-2 py-1.5 text-[11.5px] text-ink-4">{b.date_applied ? new Date(b.date_applied).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AccountExpandTabs({ account, scope = "engaged" }: { account: JobsAccount; scope?: "engaged" | "all" }) {
  const key = account.account_key;
  const tabs = useMemo(() => [
    { id: "comments", label: "Comments", render: () => <AccountCommentsTab accountKey={key} /> },
    { id: "tasks", label: "Tasks", render: () => <AccountTasksTab accountKey={key} /> },
    { id: "opps", label: "Opportunities", count: account.opp_count, render: () => <AccountOppsTab account={account} /> },
    { id: "contacts", label: "Contacts", count: account.prospect_count, render: () => <AccountContactsTab account={account} scope={scope} /> },
    { id: "activity", label: "Activity", render: () => <AccountActivityTab account={account} scope={scope} /> },
    { id: "builders", label: "Builders", render: () => <AccountBuildersTab account={account} /> },
    { id: "roles", label: "Roles", render: () => <AccountRolesTab account={account} /> },
  ], [account, key, scope]);
  return <RowExpandPanel tabs={tabs} />;
}
