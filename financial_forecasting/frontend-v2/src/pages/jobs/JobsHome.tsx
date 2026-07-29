/**
 * Jobs Home — personal command center (PBD-Home-style, per-person scope).
 *
 * A person picker (Me / staff / Everyone) scopes every zone:
 *   1. Assigned contacts — the working queue: contacts in the 'assigned'
 *      membership stage, grouped This week / Earlier by real stage-entry time
 *      (membership_stage_entered_at). ✓ moves a contact to Initial outreach.
 *   2. Opportunities — the person's open deals, with server-computed
 *      needs-attention flags (same list as Performance › Pipeline).
 *   3. Tasks — every open jobs task for the scope, inline edit + quick-add.
 *   4. Intro requests — asks addressed to me, and mine (unscoped).
 * Rows in 1–2 expand to a comments thread (JobsComments) so outreach notes
 * land on the contact/opportunity without leaving the page.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronRight, Circle, Plus } from "lucide-react";
import { toast } from "sonner";

import { Tag } from "@/components/ui/Tag";
import { InlineDate } from "@/components/ui/InlineEdit";
import { JobsComments } from "@/components/jobs/JobsComments";
import { cn } from "@/lib/utils";
import { relDay } from "@/lib/format";
import { useActiveUsers } from "@/services/projects";
import { useCurrentUser } from "@/services/auth";
import {
  useJobsAccountNames, useJobsContacts, useJobsOpportunities, useJobsStaff,
  useOpportunitiesOverview, useStaffNameResolver, useUpdateJobsMembership,
  useIntroRequests, useRespondIntroRequest,
  STAGE_LABELS,
  type ContactFilters, type IntroRequest, type JobStage, type JobsOpportunity,
  type OppNeedsRow,
} from "@/services/jobs";
import {
  useAllJobsTasks, useUpdateTaskById, useCreateTaskForParent, useDeleteTaskById,
  type JobsTaskEnriched,
} from "@/services/jobsTasks";

const todayIso = () => new Date().toISOString().slice(0, 10);

// Shared filter shape so the page-level count and the zone hit the same
// React Query cache entry.
const assignedFilters = (owner: string | null): ContactFilters => ({
  membership_stage: "assigned",
  limit: 1000,
  rules: owner ? [{ field: "owner", op: "equals", values: [owner] }] : undefined,
});

// Start of the current Sun–Sat week (local) — matches the overview/scorecard's
// Saturday week_end convention.
const startOfWeekSunday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

const isOpenOpp = (o: JobsOpportunity) =>
  !o.stage.startsWith("closed") && !o.stage.startsWith("on_hold");

// ── Section label + bordered panel (mirrors the Performance tab's SectionWrap) ──
function Section({ title, count, action, children }: {
  title: string; count?: number; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
          {count != null && <span className="text-[11px] tabular-nums text-ink-4">{count}</span>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// ── Assigned contacts zone ────────────────────────────────────────────────────
function AssignedRow({ c, showOwner, resolveName }: {
  c: { contact_id: number; full_name: string | null; current_title: string | null;
       current_company: string | null; owner_email?: string | null;
       membership_stage_entered_at?: string | null };
  showOwner: boolean;
  resolveName: (v: string | null | undefined) => string;
}) {
  const update = useUpdateJobsMembership();
  const [expanded, setExpanded] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const markContacted = () => {
    setInFlight(true);
    update.mutate(
      { contact_id: c.contact_id, stage: "initial_outreach" },
      {
        onSuccess: () => toast.success(`Moved ${c.full_name ?? "contact"} to Initial outreach`),
        onSettled: () => setInFlight(false),
      },
    );
  };
  return (
    <>
      <div
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex cursor-pointer items-center gap-2 border-t border-border-strong px-3 py-1.5 hover:bg-surface-2/40",
          expanded && "bg-surface-2/40",
          inFlight && "pointer-events-none opacity-40",
        )}
      >
        <button type="button" title="Mark contacted → Initial outreach" disabled={inFlight}
          onClick={(e) => { e.stopPropagation(); markContacted(); }}
          className="shrink-0 text-ink-4 hover:text-green">
          <Circle size={15} />
        </button>
        <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <Link to={`/jobs/contacts/${c.contact_id}`} onClick={(e) => e.stopPropagation()}
            className="truncate text-[13px] font-medium text-ink hover:text-accent">
            {c.full_name || "—"}
          </Link>
          <div className="truncate text-[11px] text-ink-4">
            {[c.current_title, c.current_company].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        {showOwner && (
          <span className="shrink-0 text-[11.5px] text-ink-3">{c.owner_email ? resolveName(c.owner_email) : "Unowned"}</span>
        )}
        <span className="w-[60px] shrink-0 text-right text-[11.5px] tabular-nums text-ink-4"
          title={c.membership_stage_entered_at ? `Assigned ${new Date(c.membership_stage_entered_at).toLocaleDateString()}` : "Assignment date unknown"}>
          {relDay(c.membership_stage_entered_at) ?? "—"}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/20 px-4 py-3">
          <JobsComments parentType="prospect" parentId={String(c.contact_id)} />
        </div>
      )}
    </>
  );
}

function AssignedContactsZone({ owner }: { owner: string | null }) {
  const { data, isLoading } = useJobsContacts(assignedFilters(owner));
  const resolveName = useStaffNameResolver();
  const contacts = data?.data ?? [];
  const weekStart = startOfWeekSunday();
  const thisWeek = contacts.filter((c) =>
    c.membership_stage_entered_at && new Date(c.membership_stage_entered_at) >= weekStart);
  const earlier = contacts.filter((c) =>
    !c.membership_stage_entered_at || new Date(c.membership_stage_entered_at) < weekStart);
  const groups = [
    { key: "week", label: "This week", items: thisWeek, cls: "bg-surface-2/60 text-ink-4" },
    { key: "earlier", label: "Earlier — still waiting on first outreach", items: earlier, cls: "bg-amber-soft text-amber" },
  ].filter((g) => g.items.length > 0);
  return (
    <Section title="Assigned contacts" count={contacts.length}>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : contacts.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">
            No assigned contacts. Flag prospects from{" "}
            <Link to="/jobs/contacts" className="text-accent hover:underline">Contacts</Link> to build the week's queue.
          </div>
        ) : groups.map((g) => (
          <div key={g.key}>
            <div className={cn("px-3 py-1 text-[10px] font-semibold uppercase tracking-wider", g.cls)}>
              {g.label} · {g.items.length}
            </div>
            {g.items.map((c) => (
              <AssignedRow key={c.contact_id} c={c} showOwner={owner === null} resolveName={resolveName} />
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Opportunities zone ────────────────────────────────────────────────────────
function OppRow({ o, needs }: { o: JobsOpportunity; needs: OppNeedsRow | undefined }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex cursor-pointer items-center gap-2 border-t border-border-strong px-3 py-1.5 hover:bg-surface-2/40",
          expanded && "bg-surface-2/40",
        )}
      >
        <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <Link to={`/jobs/opportunities/${o.id}`} onClick={(e) => e.stopPropagation()}
            className="truncate text-[13px] font-medium text-ink hover:text-accent">
            {o.account_name}
          </Link>
          {o.title && <div className="truncate text-[11px] text-ink-4">{o.title}</div>}
        </div>
        {needs && (
          <span className="flex min-w-0 shrink items-center gap-1" title={needs.why}>
            <Tag variant={needs.days_in_stage >= 30 ? "red" : "amber"}>
              <AlertTriangle size={10} className="mr-0.5 inline-block" />
              {needs.why}
            </Tag>
          </span>
        )}
        <Tag variant="accent">{STAGE_LABELS[o.stage as JobStage] ?? o.stage}</Tag>
        {(o.open_tasks ?? 0) > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-4" title="Open tasks">
            {o.open_tasks} task{o.open_tasks === 1 ? "" : "s"}
          </span>
        )}
        <span className="w-[60px] shrink-0 text-right text-[11.5px] tabular-nums text-ink-4"
          title={o.last_activity_at ? `Last activity ${new Date(o.last_activity_at).toLocaleDateString()}` : "No activity"}>
          {relDay(o.last_activity_at) ?? "—"}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/20 px-4 py-3">
          <JobsComments parentType="opportunity" parentId={o.id} />
        </div>
      )}
    </>
  );
}

function OpportunitiesZone({ owner }: { owner: string | null }) {
  const { data } = useJobsOpportunities({ owner_email: owner ?? undefined, limit: 500 });
  const { data: overview } = useOpportunitiesOverview(owner ?? undefined);
  const open = (data?.data ?? []).filter(isOpenOpp);
  const needsById = useMemo(
    () => new Map((overview?.needs_attention ?? []).map((n) => [n.opportunity_id, n])),
    [overview],
  );
  const sorted = useMemo(() => [...open].sort((a, b) => {
    const na = needsById.get(a.id); const nb = needsById.get(b.id);
    if (Boolean(na) !== Boolean(nb)) return na ? -1 : 1;
    if (na && nb && na.days_in_stage !== nb.days_in_stage) return nb.days_in_stage - na.days_in_stage;
    return (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");
  }), [open, needsById]);
  const flagged = sorted.filter((o) => needsById.has(o.id)).length;
  return (
    <Section title="Opportunities" count={open.length}
      action={flagged > 0 ? (
        <span className="text-[11.5px] font-semibold text-red">{flagged} need{flagged === 1 ? "s" : ""} attention</span>
      ) : undefined}>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {sorted.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">
            No open opportunities.{" "}
            <Link to="/jobs/pipeline" className="text-accent hover:underline">See the pipeline →</Link>
          </div>
        ) : sorted.map((o) => <OppRow key={o.id} o={o} needs={needsById.get(o.id)} />)}
      </div>
    </Section>
  );
}

// ── Tasks zone ────────────────────────────────────────────────────────────────
// NOTE: intentionally diverges from lib/risk.ts — this UI has a distinct
// "Due today" bucket, which riskForTask folds into its 7-day due-soon window.
function dueBucket(deadline: string | null): "overdue" | "today" | "upcoming" | "none" {
  if (!deadline) return "none";
  const t = todayIso();
  if (deadline < t) return "overdue";
  if (deadline === t) return "today";
  return "upcoming";
}

function TaskRow({
  task, ownerOptions, onPatch, onDelete,
}: {
  task: JobsTaskEnriched;
  ownerOptions: { value: string; label: string }[];
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const bucket = dueBucket(task.deadline);
  return (
    <div className="flex items-center gap-2 border-t border-border-strong px-3 py-1.5 hover:bg-surface-2/40">
      <button type="button" onClick={() => onPatch({ status: "Completed" })} title="Mark complete"
        className="shrink-0 text-ink-4 hover:text-green">
        <Circle size={15} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ink">{task.title}</div>
        <div className="truncate text-[11px] text-ink-4">
          {task.parent_label}{task.parent_sublabel ? ` · ${task.parent_sublabel}` : ""}
        </div>
      </div>
      <select
        value={task.owner_ids[0] ?? ""}
        onChange={(e) => onPatch({ owner_ids: e.target.value ? [e.target.value] : [] })}
        className="h-6 max-w-[130px] rounded border border-border-strong bg-surface px-1 text-[11.5px] text-ink-2 outline-none focus:border-accent"
        title="Assignee"
      >
        <option value="">Unassigned</option>
        {ownerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div className={cn(
        "w-[92px] shrink-0 text-right text-[11.5px]",
        bucket === "overdue" ? "font-semibold text-red" : bucket === "today" ? "font-semibold text-amber" : "text-ink-3",
      )}>
        <InlineDate value={task.deadline} variant="short" align="right"
          onSave={async (v) => onPatch({ deadline: v || null })} />
      </div>
      <button type="button" onClick={onDelete} title="Delete" className="shrink-0 text-ink-4 hover:text-red">×</button>
    </div>
  );
}

function TasksZone({ owner }: { owner: string | null }) {
  const { data: tasks = [], isLoading } = useAllJobsTasks();
  const { data: users = [] } = useActiveUsers();
  const { data: accounts = [] } = useJobsAccountNames();
  const update = useUpdateTaskById();
  const create = useCreateTaskForParent();
  const del = useDeleteTaskById();

  const ownerOptions = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.display_name || u.email })),
    [users],
  );
  // The page-level person picker is email-based; tasks are owned by org_users id.
  const ownerId = useMemo(
    () => owner ? users.find((u) => u.email?.toLowerCase() === owner.toLowerCase())?.id ?? null : null,
    [users, owner],
  );
  const filtered = useMemo(() => {
    if (owner === null) return tasks;
    if (!ownerId) return [];  // selected person has no org_users match → nothing to show
    return tasks.filter((t) => t.owner_ids.includes(ownerId));
  }, [tasks, owner, ownerId]);

  const groups: { key: string; label: string; items: JobsTaskEnriched[] }[] = useMemo(() => {
    const by: Record<string, JobsTaskEnriched[]> = { overdue: [], today: [], upcoming: [], none: [] };
    for (const t of filtered) by[dueBucket(t.deadline)].push(t);
    return [
      { key: "overdue", label: "Overdue", items: by.overdue },
      { key: "today", label: "Due today", items: by.today },
      { key: "upcoming", label: "Upcoming", items: by.upcoming },
      { key: "none", label: "No due date", items: by.none },
    ].filter((g) => g.items.length > 0);
  }, [filtered]);

  // Quick-add (tied to an account). Assignee defaults to the picked person.
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAccount, setNewAccount] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newDue, setNewDue] = useState("");
  const openAdd = () => {
    setNewOwner(ownerId ?? "");
    setAdding((v) => !v);
  };
  const submitNew = async () => {
    if (!newTitle.trim() || !newAccount) return;
    await create.mutateAsync({
      parent_type: "account", parent_id: newAccount, title: newTitle.trim(),
      owner_ids: newOwner ? [newOwner] : [], deadline: newDue || null,
    });
    setNewTitle(""); setNewDue(""); setAdding(false);
  };

  return (
    <Section title="Tasks" count={filtered.length} action={
      <button type="button" onClick={openAdd}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 hover:bg-surface-2">
        <Plus size={12} /> Add
      </button>
    }>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {adding && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2/40 px-3 py-2">
            <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Task title…"
              onKeyDown={(e) => { if (e.key === "Enter") void submitNew(); }}
              className="h-7 min-w-[180px] flex-1 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent" />
            <select value={newAccount} onChange={(e) => setNewAccount(e.target.value)}
              className="h-7 max-w-[180px] rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent">
              <option value="">Account…</option>
              {accounts.map((a) => <option key={a.account_key} value={a.account_key}>{a.account}</option>)}
            </select>
            <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)}
              className="h-7 rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent">
              <option value="">Assignee…</option>
              {ownerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)}
              className="h-7 rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent" />
            <button type="button" onClick={() => void submitNew()} disabled={!newTitle.trim() || !newAccount}
              className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-40">Save</button>
          </div>
        )}
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">No open tasks. 🎉</div>
        ) : groups.map((g) => (
          <div key={g.key}>
            <div className={cn(
              "px-3 py-1 text-[10px] font-semibold uppercase tracking-wider",
              g.key === "overdue" ? "bg-red-soft text-red"
                : g.key === "today" ? "bg-amber-soft text-amber"
                : "bg-surface-2/60 text-ink-4",
            )}>
              {g.label} · {g.items.length}
            </div>
            {g.items.map((t) => (
              <TaskRow key={t.id} task={t} ownerOptions={ownerOptions}
                onPatch={(patch) => update.mutate({ taskId: t.id, patch })}
                onDelete={() => del.mutate(t.id)} />
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Intro requests — asks addressed to me (staff + Sputnik builder), and mine ─
const ASK_LABELS: Record<string, string> = {
  hiring_intro: "Hiring intro", industry_advice: "Industry advice",
  job_referral: "Job referral", mock_interview: "Mock interview",
};
const askLabel = (a: string | null) => (a ? ASK_LABELS[a] ?? a.replace(/_/g, " ") : "Intro");

function IntroRequestCard({ r, mine }: { r: IntroRequest; mine: boolean }) {
  const respond = useRespondIntroRequest();
  const [note, setNote] = useState("");
  const act = (status: string) =>
    respond.mutate({ id: r.id, status, response_note: note.trim() || undefined, source: r.source });
  const isPending = r.status === "pending";
  const isAccepted = r.status === "accepted" || r.status === "approved";
  return (
    <div className="flex flex-col gap-1.5 border-t border-border-strong px-3 py-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Link to={`/jobs/contacts/${r.contact_id}`} className="font-medium text-ink hover:text-accent">{r.contact_name || "—"}</Link>
        {r.contact_company && <span className="text-[11.5px] text-ink-3">{r.contact_company}</span>}
        <Tag variant={r.source === "builder" ? "default" : "accent"}>{askLabel(r.specific_ask)}</Tag>
        <span className="text-[11px] text-ink-4">
          {mine ? `via ${r.connector_name || r.connector_email || "—"}` : `from ${r.requested_by_name || r.requested_by || "—"}${r.source === "builder" ? " (builder)" : ""}`}
          {r.created_at ? ` · ${relDay(r.created_at)}` : ""}
        </span>
        {!isPending && (
          <Tag variant={isAccepted ? "green" : r.status === "completed" ? "green" : "default"}>{r.status}</Tag>
        )}
      </div>
      {r.context && <div className="text-[11.5px] text-ink-3">{r.context}</div>}
      {r.response_note && <div className="text-[11.5px] italic text-ink-4">↳ {r.response_note}</div>}
      {!mine && isPending && (
        <div className="flex items-center gap-1.5">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note…"
            className="h-6 w-56 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] outline-none focus:border-accent" />
          <button type="button" disabled={respond.isPending} onClick={() => act("accepted")}
            className="rounded border border-green/40 px-2 py-0.5 text-[11px] font-medium text-green hover:bg-green/10">Accept</button>
          <button type="button" disabled={respond.isPending} onClick={() => act("declined")}
            className="rounded border border-red/40 px-2 py-0.5 text-[11px] font-medium text-red hover:bg-red/10">Decline</button>
        </div>
      )}
      {!mine && isAccepted && r.source === "staff" && (
        <div>
          <button type="button" disabled={respond.isPending} onClick={() => act("completed")}
            className="rounded border border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-3 hover:border-accent hover:text-accent">Mark intro made</button>
        </div>
      )}
      {mine && isPending && (
        <div>
          <button type="button" disabled={respond.isPending} onClick={() => act("withdrawn")}
            className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-4 hover:text-red">Withdraw</button>
        </div>
      )}
    </div>
  );
}

function IntroRequestsZone() {
  const { data: me } = useCurrentUser();
  const [showClosed, setShowClosed] = useState(false);
  const { data: reqs = [], isLoading } = useIntroRequests("all", showClosed);
  const myEmail = me?.email?.toLowerCase();
  const inbox = reqs.filter((r) => (r.requested_by || "").toLowerCase() !== myEmail);
  const sent = reqs.filter((r) => (r.requested_by || "").toLowerCase() === myEmail);
  if (isLoading) return null;
  if (reqs.length === 0 && !showClosed) {
    // Always visible so the flow is discoverable — a one-line how-to when empty.
    return (
      <Section title="Intro requests" count={0}>
        <div className="rounded-lg border border-border-strong bg-surface px-3 py-3 text-[12px] text-ink-4">
          None yet. Open any contact and hit <span className="font-medium text-ink-2">Request intro</span> next
          to their connected staff — the request lands here for that staff member to accept, decline, or mark the intro made.
          {" "}<Link to="/jobs/contacts" className="text-accent hover:underline">Browse contacts →</Link>
        </div>
      </Section>
    );
  }
  return (
    <Section title="Intro requests" count={reqs.length}
      action={
        <label className="flex items-center gap-1 text-[11px] text-ink-4">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-accent" /> show closed
        </label>
      }>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
          <div className="bg-surface-2/60 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">For you {inbox.length ? `(${inbox.length})` : ""}</div>
          {inbox.length === 0 ? <div className="px-3 py-4 text-center text-[12px] text-ink-4">No requests for you.</div>
            : inbox.map((r) => <IntroRequestCard key={`${r.source}-${r.id}`} r={r} mine={false} />)}
        </div>
        <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
          <div className="bg-surface-2/60 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Your requests {sent.length ? `(${sent.length})` : ""}</div>
          {sent.length === 0 ? <div className="px-3 py-4 text-center text-[12px] text-ink-4">You haven't requested any intros.</div>
            : sent.map((r) => <IntroRequestCard key={`${r.source}-${r.id}`} r={r} mine={true} />)}
        </div>
      </div>
    </Section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export function JobsHome() {
  const { data: me } = useCurrentUser();
  const { data: staff = [] } = useJobsStaff();
  // "me" | "all" | a staff email. Resolved owner: null = Everyone.
  const [sel, setSel] = useState<string>("me");
  const owner: string | null = sel === "all" ? null : sel === "me" ? (me?.email ?? "") : sel;

  // Same query keys as the zones — React Query dedupes, so the chips are free.
  const { data: assigned } = useJobsContacts(assignedFilters(owner || null));
  const { data: overview } = useOpportunitiesOverview(owner || undefined);
  const { data: tasks = [] } = useAllJobsTasks();
  const { data: users = [] } = useActiveUsers();
  const ownerId = owner ? users.find((u) => u.email?.toLowerCase() === owner.toLowerCase())?.id ?? null : null;
  const myTasks = owner === null ? tasks : ownerId ? tasks.filter((t) => t.owner_ids.includes(ownerId)) : [];
  const overdue = myTasks.filter((t) => dueBucket(t.deadline) === "overdue").length;
  const attention = overview?.needs_attention?.length ?? 0;

  const greeting = (() => {
    const h = new Date().getHours();
    const tod = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const first = me?.name?.split(" ")[0];
    return `Good ${tod}${first ? `, ${first}` : ""}`;
  })();

  if (sel === "me" && !me) {
    return <div className="px-1 py-8 text-[12.5px] text-ink-3">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[15px] font-semibold text-ink">{greeting}</h1>
          <span className="flex flex-wrap items-baseline gap-x-2.5 text-[11.5px]">
            <span className="text-ink-4">{assigned?.total ?? 0} assigned</span>
            {attention > 0 && <span className="font-semibold text-amber">· {attention} need{attention === 1 ? "s" : ""} attention</span>}
            {overdue > 0 && <span className="font-semibold text-red">· {overdue} overdue task{overdue === 1 ? "" : "s"}</span>}
          </span>
        </div>
        <select value={sel} onChange={(e) => setSel(e.target.value)} title="Whose week to show"
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
          <option value="me">Me</option>
          {staff.filter((s) => s.email.toLowerCase() !== me?.email?.toLowerCase()).map((s) => (
            <option key={s.email} value={s.email}>{s.name}</option>
          ))}
          <option value="all">Everyone</option>
        </select>
      </div>

      <AssignedContactsZone owner={owner || null} />
      <OpportunitiesZone owner={owner || null} />
      <TasksZone owner={owner || null} />
      <IntroRequestsZone />
    </div>
  );
}
