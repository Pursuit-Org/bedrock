/**
 * Jobs command center — the home tab Damon & Avni manage the pipeline from.
 * Styled to match the Performance tab: full-width (inherits the page's px-7),
 * gap-7 zones, lightweight uppercase section labels, bordered surface panels.
 *
 *   1. Tasks       — every open task across opps/prospects/accounts, with a
 *                    My / per-person filter, inline edit/assign/complete, and a
 *                    quick-add tied to an account.
 *   2. Interviews  — confirmed roles and the builders progressing through them,
 *                    advanceable inline (applied → interview → accepted/hired).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Circle, Plus, Briefcase, ChevronRight, Linkedin } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { InlineDate } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";
import { useActiveUsers } from "@/services/projects";
import { useCurrentUser } from "@/services/auth";
import { useJobsAccountNames, STAGE_LABELS, type JobStage } from "@/services/jobs";
import { ContactExpandTabs } from "@/components/jobs/jobsEntity";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { useSort, compare } from "@/lib/sort";
import {
  useIntroRequests, useRespondIntroRequest, type IntroRequest,
} from "@/services/jobs";
import { useMyNetwork, useSetConnectionStatus, type NetworkConnection } from "@/services/jobs";
import {
  useAllJobsTasks, useUpdateTaskById, useCreateTaskForParent, useDeleteTaskById,
  type JobsTaskEnriched,
} from "@/services/jobsTasks";
import {
  useInterviewPipeline, useAdvanceBuilderStage,
  type InterviewPipelineOpp, type AppStage,
} from "@/services/jobsOpps2";

const todayIso = () => new Date().toISOString().slice(0, 10);

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

// ── Tasks zone ────────────────────────────────────────────────────────────────
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

function TasksZone() {
  const { data: tasks = [], isLoading } = useAllJobsTasks();
  const { data: users = [] } = useActiveUsers();
  const { data: me } = useCurrentUser();
  const { data: accounts = [] } = useJobsAccountNames();
  const update = useUpdateTaskById();
  const create = useCreateTaskForParent();
  const del = useDeleteTaskById();

  const ownerOptions = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.display_name || u.email })),
    [users],
  );
  const myId = useMemo(
    () => users.find((u) => u.email?.toLowerCase() === me?.email?.toLowerCase())?.id ?? null,
    [users, me],
  );
  // Filter dropdown lists only people who actually have tasks (names come from
  // the enriched owner_ids/owner_names parallel arrays).
  const taskAssignees = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) t.owner_ids.forEach((id, i) => m.set(id, t.owner_names[i] ?? id));
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [tasks]);

  const [assignee, setAssignee] = useState<string>("all"); // all | me | <ownerId>
  const filtered = useMemo(() => {
    if (assignee === "all") return tasks;
    const target = assignee === "me" ? myId : assignee;
    if (!target) return assignee === "me" ? [] : tasks;
    return tasks.filter((t) => t.owner_ids.includes(target));
  }, [tasks, assignee, myId]);

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

  // Quick-add (tied to an account).
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAccount, setNewAccount] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newDue, setNewDue] = useState("");
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
      <div className="flex items-center gap-2">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
          <option value="all">Everyone</option>
          <option value="me" disabled={!myId}>My tasks</option>
          {taskAssignees.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" onClick={() => setAdding((v) => !v)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 hover:bg-surface-2">
          <Plus size={12} /> Add
        </button>
      </div>
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

// ── Interview tracker zone ─────────────────────────────────────────────────────
const STAGE_COLS: { stage: AppStage; label: string }[] = [
  { stage: "applied", label: "Applied" },
  { stage: "interview", label: "Interviewing" },
  { stage: "accepted", label: "Accepted" },
];
const NEXT_STAGE: Partial<Record<AppStage, AppStage>> = { applied: "interview", interview: "accepted" };
const PREV_STAGE: Partial<Record<AppStage, AppStage>> = { interview: "applied", accepted: "interview" };

// Per-stage tint so the interview columns read with color (like Performance).
const STAGE_COL_STYLE: Record<AppStage, { col: string; head: string }> = {
  applied:   { col: "border-border-strong/60 bg-surface-2/40", head: "text-ink-4" },
  interview: { col: "border-accent/30 bg-accent-soft/50", head: "text-accent-ink" },
  accepted:  { col: "border-green/30 bg-green-soft/50", head: "text-green" },
  rejected:  { col: "border-border-strong/60 bg-surface-2/40", head: "text-ink-4" },
  withdrawn: { col: "border-border-strong/60 bg-surface-2/40", head: "text-ink-4" },
};

function InterviewCard({ opp }: { opp: InterviewPipelineOpp }) {
  const advance = useAdvanceBuilderStage();
  const byStage = (s: AppStage) => opp.builders.filter((b) => b.stage === s);
  return (
    <div className="rounded-lg border border-border-strong bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link to={`/jobs?view=team`} className="truncate text-[13px] font-semibold text-ink hover:text-accent">
          {opp.account_name}
        </Link>
        <Tag variant="accent">{STAGE_LABELS[opp.stage as JobStage] ?? opp.stage}</Tag>
      </div>
      {opp.roles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {opp.roles.map((r) => (
            <span key={r.id} className="inline-flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-ink-2" title={r.placement_status_label}>
              <Briefcase size={10} className="text-ink-4" />{r.title ?? "Role"}
              {r.placement_status === "ft_placed" && <span className="text-green">✓</span>}
              {r.placement_status === "trial_active" && <span className="font-medium text-indigo-600">· trial</span>}
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {STAGE_COLS.map((col) => {
          const rows = byStage(col.stage);
          const c = STAGE_COL_STYLE[col.stage];
          return (
            <div key={col.stage} className={cn("rounded border p-1.5", c.col)}>
              <div className={cn("mb-1 text-[10px] font-semibold uppercase tracking-wider", c.head)}>{col.label} · {rows.length}</div>
              <div className="flex flex-col gap-1">
                {rows.map((b) => {
                  const next = NEXT_STAGE[b.stage as AppStage];
                  const prev = PREV_STAGE[b.stage as AppStage];
                  return (
                    <div key={b.job_application_id} className="group flex items-center justify-between gap-1 rounded bg-surface px-1.5 py-1 text-[11.5px] text-ink-2">
                      {prev ? (
                        <button type="button" title={`Move back to ${prev}`}
                          onClick={() => advance.mutate({ appId: b.job_application_id, stage: prev })}
                          className="shrink-0 rounded px-1 text-ink-4 opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink group-hover:opacity-100">←</button>
                      ) : (
                        <span className="shrink-0 px-1 opacity-0">←</span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{b.builder || "—"}</span>
                      {next && (
                        <button type="button" title={`Move to ${next}`}
                          onClick={() => advance.mutate({ appId: b.job_application_id, stage: next })}
                          className="shrink-0 rounded px-1 text-ink-4 opacity-0 transition-opacity hover:bg-accent-soft hover:text-accent group-hover:opacity-100">→</button>
                      )}
                    </div>
                  );
                })}
                {rows.length === 0 && <div className="px-1 py-0.5 text-[11px] text-ink-4">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InterviewsZone() {
  const { data: opps = [], isLoading } = useInterviewPipeline();
  return (
    <Section title="Builders in interviews" count={opps.length}>
      {isLoading ? (
        <div className="rounded-lg border border-border-strong bg-surface px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
      ) : opps.length === 0 ? (
        <div className="rounded-lg border border-border-strong bg-surface px-3 py-8 text-center text-[12.5px] text-ink-3">No confirmed roles with builders yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {opps.map((o) => <InterviewCard key={o.opportunity_id} opp={o} />)}
        </div>
      )}
    </Section>
  );
}

// ── My Network (staff LinkedIn connections) ─────────────────────────────────
// Fixed grid so columns line up: name | company | last touch | connected | staff | signals | status.
const NET_GRID = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_72px_52px_minmax(0,1.2fr)_120px] items-center gap-2";
type NetSortKey = "name" | "company" | "touch" | "connected" | "staff" | "status";
const NET_SORT_VALUE: Record<NetSortKey, (c: NetworkConnection) => unknown> = {
  name: (c) => c.full_name,
  company: (c) => c.current_company,
  touch: (c) => (c.my_activity_count > 0 ? c.my_last_activity : c.last_activity),
  connected: (c) => c.connected_date,
  staff: (c) => c.co_connections,
  status: (c) => c.status,
};
const NET_STATUS = [
  { value: "new", label: "New" },
  { value: "will_reach_out", label: "Will reach out" },
  { value: "declined", label: "Not a fit" },
];
const relDay = (iso: string | null) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1d" : d < 30 ? `${d}d` : d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};

function NetworkRow({ c, expanded, onToggle }: { c: NetworkConnection; expanded: boolean; onToggle: () => void }) {
  const setStatus = useSetConnectionStatus();
  // Last touch: prefer MY touch (warm), fall back to team touch.
  const mine = c.my_activity_count > 0;
  const touchIso = mine ? c.my_last_activity : c.last_activity;
  const chIcon = c.last_channel === "meeting" ? "📅" : c.last_channel === "email" ? "✉️" : "";
  return (
    <>
      <div
        onClick={onToggle}
        className={cn(NET_GRID, "cursor-pointer border-t border-border-strong px-3 py-1.5 text-[12.5px] hover:bg-surface-2/40", expanded && "bg-surface-2/40")}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
          {c.warm ? <span title={`You've been in touch (${c.my_activity_count})`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                  : c.touched ? <span title="Pursuit has activity, but not you" className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" />
                  : <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-border-strong" />}
          <Link to={`/jobs/contacts/${c.contact_id}`} onClick={(e) => e.stopPropagation()} className="min-w-0 truncate font-medium text-ink hover:text-accent">
            {c.full_name || "—"}
          </Link>
          {c.linkedin_url && (
            <a href={c.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
              title="Open LinkedIn profile" className="shrink-0 text-ink-4 hover:text-accent">
              <Linkedin size={12} />
            </a>
          )}
          {c.current_title ? <span className="hidden truncate text-[11px] text-ink-4 lg:inline"> · {c.current_title}</span> : null}
        </div>
        <div className="min-w-0 truncate text-[11.5px] text-ink-3">{c.current_company || "—"}</div>
        <div className="min-w-0 truncate text-[11px] tabular-nums" title={touchIso ? new Date(touchIso).toLocaleString() : "No activity"}>
          {touchIso ? (
            <span className={mine ? "text-amber-600" : "text-ink-4"}>
              {chIcon} {relDay(touchIso)}{mine ? ` · you (${c.my_activity_count})` : c.touched ? ` · team (${c.activity_count})` : ""}
            </span>
          ) : <span className="text-ink-4">—</span>}
        </div>
        <div className="truncate text-[11px] tabular-nums text-ink-4" title={c.connected_date ? `Connected ${c.connected_date}` : "Connection date unknown"}>
          {c.connected_date ? relDay(c.connected_date) : "—"}
        </div>
        <div className="text-center text-[11.5px] tabular-nums text-ink-4" title="Other staff also connected">
          {c.co_connections > 0 ? `+${c.co_connections}` : "—"}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {c.is_jobs_contact && <Tag variant="default">pipeline</Tag>}
          {c.has_open_opp && <Tag variant="green">open opp</Tag>}
          {c.company_hired_before && <Tag variant="default">hired before</Tag>}
        </div>
        <select
          value={c.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setStatus.mutate({ contact_id: c.contact_id, status: e.target.value })}
          className={cn("h-7 w-full rounded border bg-surface px-1 text-[11.5px] outline-none focus:border-accent",
            c.status === "declined" ? "border-red/40 text-red" : c.status === "will_reach_out" ? "border-green/40 text-green" : "border-border-strong text-ink-3")}
        >
          {NET_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/20">
          <ContactExpandTabs contactId={c.contact_id} />
        </div>
      )}
    </>
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
          {" "}<Link to="/jobs?view=contacts" className="text-accent hover:underline">Browse contacts →</Link>
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

function MyNetworkZone() {
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [warmOnly, setWarmOnly] = useState(false);
  const [byCompany, setByCompany] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { sort, toggle: toggleSort } = useSort<NetSortKey>();
  const { data, isLoading } = useMyNetwork(q || undefined);
  let conns = data?.connections ?? [];
  if (warmOnly) conns = conns.filter((c) => c.warm);
  if (sort.key) {
    const val = NET_SORT_VALUE[sort.key];
    conns = [...conns].sort((a, b) => compare(val(a), val(b), sort.direction));
  }
  const shown = showAll ? conns : conns.slice(0, 25);
  // Group the shown rows by company (largest group first, no-company last).
  const groups = useMemo(() => {
    if (!byCompany) return null;
    const m = new Map<string, NetworkConnection[]>();
    for (const c of shown) {
      const k = c.current_company?.trim() || "No company";
      (m.get(k) ?? m.set(k, []).get(k)!).push(c);
    }
    return [...m.entries()].sort((a, b) =>
      a[0] === "No company" ? 1 : b[0] === "No company" ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [byCompany, shown]);
  const toggle = (id: number) => setExpandedId((p) => (p === id ? null : id));
  const controls = (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1 text-[11px] text-ink-4">
        <input type="checkbox" checked={warmOnly} onChange={(e) => { setWarmOnly(e.target.checked); setShowAll(false); }} className="accent-accent" /> warm only
      </label>
      <label className="flex items-center gap-1 text-[11px] text-ink-4">
        <input type="checkbox" checked={byCompany} onChange={(e) => setByCompany(e.target.checked)} className="accent-accent" /> by company
      </label>
      <input value={q} onChange={(e) => { setQ(e.target.value); setShowAll(false); }}
        placeholder="Search name / company / title"
        className="h-7 w-48 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
    </div>
  );
  return (
    <Section title="My Network" count={data?.total} action={controls}>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : !data?.mapped ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">{data?.message || "No LinkedIn connections mapped to your account yet."}</div>
        ) : conns.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">{q || warmOnly ? "No connections match the filters." : "No connections."}</div>
        ) : (
          <>
            <div className={cn(NET_GRID, "bg-surface-2/60 px-3 py-1.5")}>
              <SortableHeader label="Connection" sortKey="name" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Company" sortKey="company" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Last touch" sortKey="touch" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Connected" sortKey="connected" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Staff" sortKey="staff" sort={sort} onToggle={toggleSort} />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Signals</span>
              <SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggleSort} />
            </div>
            {groups ? groups.map(([company, rows]) => (
              <div key={company}>
                <div className="flex items-baseline gap-2 border-t border-border-strong bg-surface-2/50 px-3 py-1 text-[11px] font-semibold text-ink-2">
                  {company} <span className="font-normal tabular-nums text-ink-4">{rows.length}</span>
                </div>
                {rows.map((c) => <NetworkRow key={c.contact_id} c={c} expanded={expandedId === c.contact_id} onToggle={() => toggle(c.contact_id)} />)}
              </div>
            )) : shown.map((c) => <NetworkRow key={c.contact_id} c={c} expanded={expandedId === c.contact_id} onToggle={() => toggle(c.contact_id)} />)}
            {conns.length > shown.length && (
              <button type="button" onClick={() => setShowAll(true)}
                className="border-t border-border-strong px-3 py-2 text-[12px] text-accent hover:bg-surface-2/50">Show all {conns.length} loaded</button>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export function JobsHome() {
  const { data: me } = useCurrentUser();
  const { data: tasks = [] } = useAllJobsTasks();
  const { data: pipeline = [] } = useInterviewPipeline();

  const overdue = tasks.filter((t) => dueBucket(t.deadline) === "overdue").length;
  const dueToday = tasks.filter((t) => dueBucket(t.deadline) === "today").length;
  const interviewing = pipeline.reduce((n, o) => n + o.summary.interview, 0);

  const greeting = (() => {
    const h = new Date().getHours();
    const tod = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const first = me?.name?.split(" ")[0];
    return `Good ${tod}${first ? `, ${first}` : ""}`;
  })();

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[15px] font-semibold text-ink">{greeting}</h1>
        <span className="flex flex-wrap items-baseline gap-x-2.5 text-[11.5px]">
          <span className="text-ink-4">{tasks.length} open task{tasks.length === 1 ? "" : "s"}</span>
          {overdue > 0 && <span className="font-semibold text-red">· {overdue} overdue</span>}
          {dueToday > 0 && <span className="font-semibold text-amber">· {dueToday} due today</span>}
          {interviewing > 0 && <span className="font-semibold text-green">· {interviewing} interviewing</span>}
        </span>
      </div>

      <IntroRequestsZone />
      <TasksZone />
      <MyNetworkZone />
      <InterviewsZone />
    </div>
  );
}
