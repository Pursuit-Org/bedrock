/**
 * Jobs · Opportunities — Weekly Overview.
 *
 * The Thursday-meeting agenda, top to bottom: summary cards (incl. the
 * won-with-open-tasks stage-gate check), recent activity (the week's
 * narrative), the per-owner walkthrough (P1s with next task, stalled with
 * why — rows manage inline and expand to the full DealExpandPanel), then
 * time-in-stage aging and the switchable set distribution.
 *
 * "Time in pipeline" = time in the CURRENT stage (from jobs_stage_history).
 * Backed by /api/jobs/opportunities/overview (+ /opportunities for the
 * managed rows). Heatmaps + standalone needs-attention were removed in the
 * 2026-07-30 exec review — restore from git if ever needed.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { addDays, format } from "date-fns";
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, Clock, Minus, Plus, TrendingDown, TrendingUp, Trophy, XCircle } from "lucide-react";

import {
  useOpportunitiesOverview,
  useJobsStaff,
  useJobsOpportunities,
  useUpdateOpportunity,
  DEAL_TYPE_LABELS,
  STAGE_LABELS,
  type DealType,
  type JobStage,
  type JobsOpportunity,
  type OppBreakdownDim,
  type OppDrillRow,
  type OppNeedsRow,
  type OppActivityEvent,
} from "@/services/jobs";
import { useAllJobsTasks } from "@/services/jobsTasks";
import { useSessionState } from "@/lib/useSessionState";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { Drawer } from "@/components/ui/Drawer";
import { CommittedRolesModal } from "@/components/jobs/CommittedRolesModal";
import { DealExpandPanel, PlacementsModal, ClosedLostModal, stageOptionsFor } from "./JobsTeam";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const DIMS: { key: OppBreakdownDim; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "deal_type", label: "Deal type" },
  { key: "segment", label: "Segment" },
  { key: "stage", label: "Stage" },
  { key: "owner", label: "Owner" },
];

const DEAL_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All deal types" },
  ...(Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]).map(([value, label]) => ({ value, label })),
];

const ownerShort = (e: string | null) => (e ? e.split("@")[0] : "—");
// Fallback full-ish name when staff lookup misses: "avni.nahar@…" → "Avni Nahar".
const titleCaseEmail = (e: string) =>
  e.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The most recent Saturday on or before `d` (weeks run Saturday-to-Saturday). */
function mostRecentSaturday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() - 6 + 7) % 7));
  return x;
}
/** The Saturday that CLOSES the week containing `d` (Sun–Sat weeks). A Saturday
 *  closes its own week — mapping it forward would jump a whole week ahead.
 *  weekEnd is the closing boundary, so the current in-progress week is selectable. */
function weekEndFor(d: Date): Date {
  const sat = mostRecentSaturday(d);
  return d.getDay() === 6 ? sat : addDays(sat, 7);
}
/** Local YYYY-MM-DD (avoids the UTC shift of toISOString). */
function fmtDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function JobsOpportunitiesOverview() {
  const [owner, setOwner] = useState<string>("all");
  const [dealType, setDealType] = useState<string>("all");
  const [dim, setDim] = useState<OppBreakdownDim>("status");
  const [weekEnd, setWeekEnd] = useState<Date>(() => weekEndFor(new Date()));

  // The current (in-progress) week is the furthest forward you can go.
  const maxWeekEnd = weekEndFor(new Date());
  const canGoNext = addDays(weekEnd, 7).getTime() <= maxWeekEnd.getTime();
  // The server window is [weekEnd-6 00:00, weekEnd 24:00] — a Sun–Sat week.
  const weekStart = addDays(weekEnd, -6);

  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (staffQ.data ?? []).forEach((st) => m.set(st.email, st.name));
    return (email: string | null) => (email ? m.get(email) ?? titleCaseEmail(email) : "—");
  }, [staffQ.data]);
  const { data, isLoading } = useOpportunitiesOverview(owner, dealType, fmtDateInput(weekEnd));

  const s = data?.summary;
  const netDelta = s ? s.net_new - s.net_new_prev : 0;

  // Full opportunity objects behind the managed rows (walkthrough + needs
  // attention): stage edits inline, rows expand to the full DealExpandPanel.
  const { data: oppsData } = useJobsOpportunities({
    owner_email: owner !== "all" ? owner : undefined,
    deal_type: dealType !== "all" ? (dealType as DealType) : undefined,
    limit: 500,
  });
  const { data: allTasks = [] } = useAllJobsTasks();
  const openOpps = useMemo(() => (oppsData?.data ?? [])
    .filter((o) => !o.stage.startsWith("closed") && !o.stage.startsWith("on_hold")), [oppsData]);
  const needsById = useMemo(
    () => new Map((data?.needs_attention ?? []).map((n) => [n.opportunity_id, n])), [data]);
  const nextTaskByOpp = useMemo(() => {
    const m = new Map<string, { title: string; deadline: string | null }>();
    for (const t of allTasks) {
      if (t.parent_type !== "opportunity") continue;
      const cur = m.get(t.parent_id);
      if (!cur || (t.deadline ?? "9999") < (cur.deadline ?? "9999")) m.set(t.parent_id, { title: t.title, deadline: t.deadline });
    }
    return m;
  }, [allTasks]);
  const wonOpenTasks = useMemo(
    () => (oppsData?.data ?? []).filter((o) => o.stage === "closed_won" && (o.open_tasks ?? 0) > 0),
    [oppsData]);
  // Summary-card drill — rows come from the SAME query as the count (server
  // `drills`), so a card and its list can't disagree.
  const [drill, setDrill] = useState<{ title: string; note?: string; rows: OppDrillRow[] } | null>(null);
  const asDrillRows = (opps: JobsOpportunity[]): OppDrillRow[] => opps.map((o) => ({
    opportunity_id: o.id, account: o.account_name, stage: o.stage,
    stage_label: STAGE_LABELS[o.stage as JobStage] ?? o.stage,
    owner: o.owner_email ?? null, at: o.last_activity_at ?? null,
  }));

  // One expand at a time across all managed tables; stage-gating modals at page root.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [placementModalDeal, setPlacementModalDeal] = useState<{ id: string; account_name: string; deal_type?: DealType | null } | null>(null);
  const [committedRolesDeal, setCommittedRolesDeal] = useState<{ id: string; account_name: string } | null>(null);
  const [closedLostDeal, setClosedLostDeal] = useState<{ id: string; account_name: string } | null>(null);
  const rowHandlers = {
    expandedId, setExpandedId,
    onRecordPlacements: setPlacementModalDeal,
    onClosedLost: setClosedLostDeal,
    onCommittedRoles: setCommittedRolesDeal,
  };

  return (
    <div className="flex flex-col gap-6 pt-1">
      {/* ── Header row ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-ink">Opportunities Overview</h2>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface px-1.5 py-1 text-[12.5px]">
          <button
            type="button"
            onClick={() => setWeekEnd(addDays(weekEnd, -7))}
            className="rounded p-1 text-ink-4 hover:bg-surface-2 hover:text-ink"
            title="Previous week"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="whitespace-nowrap px-1 font-semibold text-ink">
            {format(weekStart, "MMM d")} – {format(weekEnd, "MMM d")}
          </span>
          <button
            type="button"
            onClick={() => setWeekEnd(addDays(weekEnd, 7))}
            disabled={!canGoNext}
            className="rounded p-1 text-ink-4 hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next week"
          >
            <ChevronRight size={15} />
          </button>
          <span className="ml-1 flex items-center gap-1">
            <input
              type="date"
              value={fmtDateInput(weekStart)}
              max={fmtDateInput(maxWeekEnd)}
              onChange={(e) => { if (e.target.value) setWeekEnd(weekEndFor(new Date(`${e.target.value}T00:00:00`))); }}
              className="rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] text-ink outline-none focus:border-accent"
              title="Start date — snaps to the week containing it"
            />
            <span className="text-ink-4">→</span>
            <input
              type="date"
              value={fmtDateInput(weekEnd)}
              max={fmtDateInput(maxWeekEnd)}
              onChange={(e) => { if (e.target.value) setWeekEnd(weekEndFor(new Date(`${e.target.value}T00:00:00`))); }}
              className="rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] text-ink outline-none focus:border-accent"
              title="End date — snaps to the week containing it"
            />
          </span>
        </div>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Owner</span>
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
          >
            <option value="all">All owners</option>
            {(staffQ.data ?? []).map((st) => (
              <option key={st.email} value={st.email}>{st.name || ownerShort(st.email)}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Deal type</span>
          <select
            value={dealType}
            onChange={(e) => setDealType(e.target.value)}
            className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
          >
            {DEAL_TYPE_FILTERS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Summary cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 items-stretch gap-4 lg:grid-cols-5">
        <SummaryCard tone="ink" label="In the set" value={s?.in_set} isLoading={isLoading}
          sub="All active opportunities"
          onClick={() => setDrill({ title: "In the set", note: "All active opportunities", rows: data?.drills.in_set ?? [] })} />
        <SummaryCard tone="accent" label="Net new" value={s?.net_new} isLoading={isLoading}
          delta={s ? { n: netDelta, prev: s.net_new_prev } : undefined}
          onClick={() => setDrill({ title: "Net new this week", note: `Created ${format(weekStart, "MMM d")} – ${format(weekEnd, "MMM d")}`, rows: data?.drills.net_new ?? [] })} />
        <SummaryCard tone="amber" label="Stalled" value={s?.stalled_6wk} isLoading={isLoading}
          sub="Open opportunity 6+ weeks"
          onClick={() => setDrill({ title: "Stalled 6+ weeks", note: "Open, created more than 6 weeks ago", rows: data?.drills.stalled ?? [] })} />
        {/* Stacked outcome boxes for the week — Closed won (the goal,
            subtly highlighted) over Closed lost (context to understand, not a red flag). */}
        <div className="flex flex-col gap-4">
          <OutcomeBox tone="green" highlight label="Closed won" value={s?.moved_committed} isLoading={isLoading}
            onClick={() => setDrill({ title: "Closed won this week", rows: data?.drills.won ?? [] })} />
          <OutcomeBox tone="ink" label="Closed lost" value={s?.closed_lost} isLoading={isLoading}
            onClick={() => setDrill({ title: "Closed lost this week", rows: data?.drills.lost ?? [] })} />
        </div>
        {/* Stage-gate check: won on the board but the follow-through (e.g. the
            signed contract task) is still open — "signed contract = closed". */}
        <SummaryCard tone="red" label="Won, open tasks" value={wonOpenTasks.length} isLoading={isLoading}
          sub={wonOpenTasks.slice(0, 2).map((o) => o.account_name).join(" · ") || "all buttoned up"}
          onClick={() => setDrill({ title: "Won with open tasks", note: "Closed won but follow-through still open", rows: asDrillRows(wonOpenTasks) })} />
      </div>

      {/* ── Recent activity — the week's narrative, promoted ──────────── */}
      <Panel
        title="Recent activity"
        desc="Added, moved, won/lost, or stalled this week — newest first"
      >
        <RecentActivity events={data?.recent_activity ?? []} isLoading={isLoading} nameOf={nameOf} />
      </Panel>

      {/* ── Owner walkthrough — the Thursday ritual, one shared screen ── */}
      <Panel
        title="Owner walkthrough"
        desc="Per owner: P1 / high value with the next task, then stalled with what would unblock it — rows manage inline and expand to the full panel"
      >
        <OwnerWalkthrough openOpps={openOpps} needsById={needsById} nextTaskByOpp={nextTaskByOpp}
          nameOf={nameOf} {...rowHandlers} />
      </Panel>

      {/* Needs-attention panel removed 2026-07-30 — the walkthrough's stalled
          groups carry the same rows, grouped by owner and manageable. */}

      {/* ── Aging + Breakdown ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Time in Pipeline">
          <AgingBars buckets={data?.aging.buckets ?? []} isLoading={isLoading} />
        </Panel>
        <Panel
          title="Active set distribution"
          action={
            <select
              value={dim}
              onChange={(e) => setDim(e.target.value as OppBreakdownDim)}
              className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
            >
              {DIMS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          }
        >
          <BreakdownBars items={data?.breakdowns[dim] ?? []} dim={dim} isLoading={isLoading} />
        </Panel>
      </div>

      {/* Heatmaps removed 2026-07-30 (exec review): Priority×Time rendered
          empty until priorities are tagged, and Stage×Time's column totals are
          the aging bars above. Restore from git if concentration analysis is
          ever needed again. */}

      {drill && <OppDrill title={drill.title} note={drill.note} rows={drill.rows} nameOf={nameOf} onClose={() => setDrill(null)} />}
      {placementModalDeal && <PlacementsModal deal={placementModalDeal} onClose={() => setPlacementModalDeal(null)} />}
      {committedRolesDeal && <CommittedRolesModal deal={committedRolesDeal} onClose={() => setCommittedRolesDeal(null)} />}
      {closedLostDeal && <ClosedLostModal deal={closedLostDeal} onClose={() => setClosedLostDeal(null)} />}
    </div>
  );
}

// ── Summary-card drill-down ──────────────────────────────────────────────────

function OppDrill({ title, note, rows, nameOf, onClose }: {
  title: string; note?: string; rows: OppDrillRow[];
  nameOf: (e: string | null) => string; onClose: () => void;
}) {
  return (
    <Drawer open onClose={onClose} title={title}
      subtitle={`${rows.length} opportunit${rows.length === 1 ? "y" : "ies"}${note ? ` · ${note}` : ""}`}
      width={720}>
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12.5px] text-ink-4">Nothing here for this window.</div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead><tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
              <th className="px-4 py-1.5 font-semibold">Account</th>
              <th className="px-2 py-1.5 font-semibold">Stage</th>
              <th className="px-2 py-1.5 font-semibold">Owner</th>
              <th className="px-2 py-1.5 text-right font-semibold">When</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.opportunity_id} className="border-t border-border-strong">
                  <td className="px-4 py-1.5">
                    <Link to={`/jobs/opportunities/${r.opportunity_id}`} className="font-medium text-ink hover:text-accent">
                      {r.account || "—"}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5 text-ink-2">{r.stage_label}</td>
                  <td className="px-2 py-1.5 text-ink-3">{nameOf(r.owner)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[11.5px] text-ink-4">{relDay(r.at) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Drawer>
  );
}

// ── Managed opp rows (walkthrough + needs attention) ─────────────────────────

interface RowHandlers {
  expandedId: string | null;
  setExpandedId: (fn: (p: string | null) => string | null) => void;
  onRecordPlacements: (d: { id: string; account_name: string; deal_type?: DealType | null }) => void;
  onClosedLost: (d: { id: string; account_name: string }) => void;
  onCommittedRoles: (d: { id: string; account_name: string }) => void;
}

function ManagedOppRow({ o, sub, detail, right, nextTask, expandedId, setExpandedId, onRecordPlacements, onClosedLost, onCommittedRoles }: {
  o: JobsOpportunity;
  sub?: string | null;
  detail?: React.ReactNode;
  right?: React.ReactNode;
  nextTask?: { title: string; deadline: string | null };
} & RowHandlers) {
  const updateOpp = useUpdateOpportunity();
  const expanded = expandedId === o.id;
  // Keep in sync with DealRow.saveStage (JobsTeam.tsx) — same modal gating.
  function saveStage(stage: JobStage) {
    if (stage === o.stage) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      updateOpp.mutate({ id: o.id, stage }, {
        onSuccess: () => {
          const isPlacementType = o.deal_type === "ft" || o.deal_type === "pt_contract";
          if (stage === "closed_won" && isPlacementType) onRecordPlacements({ id: o.id, account_name: o.account_name, deal_type: o.deal_type });
          else if (stage === "closed_lost") onClosedLost({ id: o.id, account_name: o.account_name });
          else if (stage === "active_opportunity_confirmed" && (o.num_roles ?? 0) === 0) onCommittedRoles({ id: o.id, account_name: o.account_name });
          resolve();
        },
        onError: reject,
      });
    });
  }
  return (
    <>
      <div
        onClick={() => setExpandedId((p) => (p === o.id ? null : o.id))}
        className={cn(
          "grid cursor-pointer grid-cols-[1fr_150px_minmax(0,220px)_70px] items-center gap-2 border-t border-border-strong px-2.5 py-2 hover:bg-surface-2/40",
          expanded && "bg-surface-2/40",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
          <span className="min-w-0">
            <Link to={`/jobs/opportunities/${o.id}`} onClick={(e) => e.stopPropagation()}
              className="block truncate text-[13px] font-semibold text-ink hover:text-accent">{o.account_name}</Link>
            {sub && <span className="block truncate text-[11px] text-ink-4">{sub}</span>}
          </span>
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <InlineSelect<JobStage>
            value={o.stage}
            options={stageOptionsFor(o.stage)}
            onSave={saveStage}
            renderValue={(v) => (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">{v ? STAGE_LABELS[v] : "—"}</span>
            )}
          />
        </span>
        <span className="truncate text-[11.5px] text-ink-3">
          {detail ?? (nextTask
            ? <>Next: <b className="font-semibold text-ink-2">{nextTask.title}</b>{nextTask.deadline ? ` · ${nextTask.deadline.slice(5)}` : ""}</>
            : <span className="text-ink-4">no open task</span>)}
        </span>
        <span className="text-right text-[11.5px] tabular-nums text-ink-4"
          title={o.last_activity_at ? `Last activity ${new Date(o.last_activity_at).toLocaleDateString()}` : "No activity"}>
          {right ?? (relDay(o.last_activity_at) ?? "—")}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/20">
          <DealExpandPanel deal={o} />
        </div>
      )}
    </>
  );
}

function OwnerWalkthrough({ openOpps, needsById, nextTaskByOpp, nameOf, ...handlers }: {
  openOpps: JobsOpportunity[];
  needsById: Map<string, OppNeedsRow>;
  nextTaskByOpp: Map<string, { title: string; deadline: string | null }>;
  nameOf: (e: string | null) => string;
} & RowHandlers) {
  const [expandedRest, setExpandedRest] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useSessionState<"owner" | "priority" | "">("jobsPipeline.walkthrough.groupBy", "owner");
  const [ownerFilter, setOwnerFilter] = useSessionState<string>("jobsPipeline.walkthrough.owner", "");
  const [flaggedOnly, setFlaggedOnly] = useSessionState<boolean>("jobsPipeline.walkthrough.flagged", false);

  const owners = useMemo(() => [...new Set(openOpps.map((o) => (o.owner_email ?? "").toLowerCase()))]
    .filter(Boolean).sort(), [openOpps]);
  const visible = useMemo(() => openOpps.filter((o) =>
    (!ownerFilter || (o.owner_email ?? "").toLowerCase() === ownerFilter) &&
    (!flaggedOnly || needsById.has(o.id))), [openOpps, ownerFilter, flaggedOnly, needsById]);

  const controls = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
        className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
        <option value="">All owners</option>
        {owners.map((o) => <option key={o} value={o}>{nameOf(o)}</option>)}
      </select>
      <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as "owner" | "priority" | "")}
        className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
        <option value="owner">Group by owner</option>
        <option value="priority">Group by priority</option>
        <option value="">No grouping</option>
      </select>
      <button type="button" onClick={() => setFlaggedOnly(!flaggedOnly)}
        className={cn("h-7 rounded-md border px-2 text-[11.5px] font-medium",
          flaggedOnly ? "border-[var(--amber)]/40 bg-[var(--amber-soft)] text-[var(--amber)]"
                      : "border-border-strong bg-surface text-ink-3 hover:text-ink-2")}>
        Needs attention only
      </button>
      <span className="text-[11.5px] text-ink-4">{visible.length} shown</span>
    </div>
  );

  const groups = useMemo(() => {
    const by = new Map<string, JobsOpportunity[]>();
    for (const o of visible) {
      const k = (o.owner_email ?? "(unassigned)").toLowerCase();
      (by.get(k) ?? by.set(k, []).get(k)!).push(o);
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [visible]);

  // Flat table (no grouping) or grouped by priority — the by-owner walkthrough
  // below stays the meeting default.
  if (groupBy !== "owner") {
    const flagged = (o: JobsOpportunity) => {
      const n = needsById.get(o.id);
      return n ? {
        detail: <span className="flex items-center gap-1.5"><AlertTriangle size={11} className="shrink-0 text-[var(--amber)]" />{n.why}</span>,
        right: <span className="text-[var(--amber)]">{n.days_in_stage}d</span>,
      } : {};
    };
    const bands = groupBy === "priority"
      ? [
          { label: "P1 · High value", cls: "bg-[var(--accent-soft)] text-[var(--accent-ink)]", rows: visible.filter((o) => o.priority === 1) },
          { label: "P2", cls: "bg-[var(--sky-soft)] text-[var(--sky)]", rows: visible.filter((o) => o.priority === 2) },
          { label: "P3+ / no priority", cls: "bg-surface-2 text-ink-3", rows: visible.filter((o) => (o.priority ?? 9) >= 3) },
        ].filter((b) => b.rows.length > 0)
      : [{ label: "", cls: "", rows: visible }];
    return (
      <div className="flex flex-col">
        {controls}
        {bands.map((b) => (
          <div key={b.label}>
            {b.label && <div className={cn("px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", b.cls)}>{b.label} · {b.rows.length}</div>}
            {b.rows.map((o) => (
              <ManagedOppRow key={o.id} o={o} sub={o.title ?? nameOf(o.owner_email)} {...flagged(o)}
                nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
            ))}
          </div>
        ))}
        {visible.length === 0 && (
          <div className="border-t border-border-strong px-2.5 py-3 text-[12px] text-ink-4">Nothing matches the filters.</div>
        )}
      </div>
    );
  }


  if (groups.length === 0) {
    return <div className="flex flex-col">{controls}
      <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[12px] text-ink-4">Nothing matches the filters.</div>
    </div>;
  }
  return (
    <div className="flex flex-col">
      {controls}
      {groups.map(([email, opps]) => {
        const p1 = opps.filter((o) => o.priority === 1);
        const p2 = opps.filter((o) => o.priority === 2);
        const rest = opps.filter((o) => (o.priority ?? 9) >= 3);
        // Flagged opps without a P1/P2 priority — the meeting's ask list.
        // P1/P2 flagged rows already carry their attention chip in-group, so
        // they're not repeated here.
        const stalled = opps.filter((o) => needsById.has(o.id) && o.priority !== 1 && o.priority !== 2)
          .sort((a, b) => (needsById.get(b.id)?.days_in_stage ?? 0) - (needsById.get(a.id)?.days_in_stage ?? 0));
        const restOpen = expandedRest.has(email);
        const flaggedRow = (o: JobsOpportunity) => {
          const n = needsById.get(o.id);
          return n ? {
            detail: <span className="flex items-center gap-1.5"><AlertTriangle size={11} className="shrink-0 text-[var(--amber)]" />{n.why}</span>,
            right: <span className="text-[var(--amber)]">{n.days_in_stage}d</span>,
          } : {};
        };
        return (
          <div key={email} className="first:-mt-px">
            <div className="flex items-baseline gap-2 border-t border-border-strong bg-surface-2 px-2.5 py-1.5">
              <span className="text-[12.5px] font-bold text-ink">{email === "(unassigned)" ? "Unassigned" : nameOf(email)}</span>
              <span className="text-[11px] text-ink-3">
                {opps.length} open · {p1.length} P1 · {p2.length} P2 · {opps.filter((o) => needsById.has(o.id)).length} flagged
              </span>
            </div>
            {p1.length > 0 && (
              <div className="bg-[var(--accent-soft)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--accent-ink)]">P1 · High value</div>
            )}
            {p1.map((o) => (
              <ManagedOppRow key={o.id} o={o} sub={o.title} {...flaggedRow(o)}
                nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
            ))}
            {p2.length > 0 && (
              <div className="bg-[var(--sky-soft)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--sky)]">P2</div>
            )}
            {p2.map((o) => (
              <ManagedOppRow key={o.id} o={o} sub={o.title} {...flaggedRow(o)}
                nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
            ))}
            {stalled.length > 0 && (
              <div className="bg-[var(--amber-soft)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--amber)]">Stalled — needs unblock</div>
            )}
            {stalled.map((o) => (
              <ManagedOppRow key={o.id} o={o} sub={o.title} {...flaggedRow(o)}
                nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
            ))}
            {rest.length > 0 && (
              <>
                <button type="button"
                  onClick={() => setExpandedRest((prev) => {
                    const n = new Set(prev);
                    n.has(email) ? n.delete(email) : n.add(email);
                    return n;
                  })}
                  className="flex w-full items-center gap-1.5 border-t border-border-strong bg-surface-2/50 px-2.5 py-1 text-left text-[10px] font-bold uppercase tracking-wider text-ink-3 hover:text-ink-2">
                  <ChevronRight size={11} className={cn("transition-transform", restOpen && "rotate-90")} />
                  P3+ / no priority · {rest.length}
                </button>
                {restOpen && rest.map((o) => (
                  <ManagedOppRow key={o.id} o={o} sub={o.title} {...flaggedRow(o)}
                    nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Summary card ────────────────────────────────────────────────────────────

const TONE: Record<string, string> = {
  ink: "text-ink", accent: "text-[var(--accent)]", sky: "text-[var(--sky)]",
  green: "text-[var(--green)]", amber: "text-[var(--amber)]", red: "text-[var(--red)]",
};

function SummaryCard({
  tone, label, value, sub, delta, isLoading, onClick,
}: {
  tone: keyof typeof TONE | string;
  label: string;
  value: number | undefined;
  sub?: string;
  delta?: { n: number; prev: number };
  isLoading: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className={cn("rounded-2xl border border-border-strong bg-surface px-5 py-4",
        onClick && "cursor-pointer transition-colors hover:border-accent focus:outline-none focus-visible:border-accent")}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{label}{onClick ? " ›" : ""}</div>
      {isLoading ? (
        <div className="mt-2 h-8 w-16 animate-pulse rounded bg-surface-2" />
      ) : (
        <div className={cn("mt-1.5 text-[30px] font-bold leading-none tabular-nums", TONE[tone] ?? "text-ink")}>
          {value ?? 0}
        </div>
      )}
      {!isLoading && delta ? (
        <div className={cn(
          "mt-2.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold",
          delta.n > 0 ? "bg-[var(--green-soft)] text-[var(--green)]"
            : delta.n < 0 ? "bg-[var(--red-soft)] text-[var(--red)]"
              : "bg-surface-2 text-ink-3",
        )}>
          {delta.n > 0 ? <TrendingUp size={11} /> : delta.n < 0 ? <TrendingDown size={11} /> : <Minus size={11} />}
          {delta.n === 0 ? `same as ${delta.prev} last wk` : `${delta.n > 0 ? "↑" : "↓"} vs ${delta.prev} last wk`}
        </div>
      ) : !isLoading && sub ? (
        <div className="mt-2 text-[11.5px] text-ink-4">{sub}</div>
      ) : null}
    </div>
  );
}

// ── Outcome box (half-height; stacked for won / lost) ─────────────────────────

function OutcomeBox({
  tone, label, value, highlight, isLoading, onClick,
}: {
  tone: keyof typeof TONE | string;
  label: string;
  value: number | undefined;
  highlight?: boolean;
  isLoading: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className={cn(
        "flex flex-1 items-center justify-between rounded-xl border border-border-strong px-4 py-2.5",
        highlight ? "bg-[var(--green-soft)]" : "bg-surface",
        onClick && "cursor-pointer transition-colors hover:border-accent focus:outline-none focus-visible:border-accent",
      )}
    >
      <div>
        <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          {highlight ? <Trophy size={11} className="text-[var(--green)]" /> : null}
          {label}
        </div>
        <div className="text-[10.5px] text-ink-4">this week</div>
      </div>
      {isLoading ? (
        <div className="h-6 w-8 animate-pulse rounded bg-surface-2" />
      ) : (
        <div className={cn("text-[22px] font-bold leading-none tabular-nums", TONE[tone] ?? "text-ink")}>
          {value ?? 0}
        </div>
      )}
    </div>
  );
}

// ── Panel wrapper ─────────────────────────────────────────────────────────────

function Panel({
  title, desc, action, badge, children,
}: {
  title: string; desc?: string; action?: React.ReactNode; badge?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border-strong bg-surface px-5 py-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
            {badge ? (
              <span className="rounded-full bg-[var(--red-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--red)]">{badge}</span>
            ) : null}
          </div>
          {desc ? <p className="mt-0.5 text-[11.5px] text-ink-4">{desc}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Aging bars ────────────────────────────────────────────────────────────────

const AGE_COLOR = ["var(--green)", "#6FBE93", "var(--amber)", "#D97A3E", "var(--red)"];

function AgingBars({ buckets, isLoading }: { buckets: { key: string; label: string; count: number; pct: number }[]; isLoading: boolean }) {
  if (isLoading) {
    return <div className="flex flex-col gap-3 py-1">{Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="h-3 animate-pulse rounded bg-surface-2" />
    ))}</div>;
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="flex flex-col">
      {buckets.map((b, i) => (
        <div key={b.key} className="grid grid-cols-[92px_1fr_36px_36px] items-center gap-3 py-[7px]">
          <div className="text-[12.5px] font-semibold text-ink">{b.label}</div>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${Math.round((100 * b.count) / max)}%`, background: AGE_COLOR[i] ?? "var(--accent)" }} />
          </div>
          <div className="text-right text-[12.5px] font-semibold tabular-nums text-ink">{b.count}</div>
          <div className="text-right text-[11.5px] tabular-nums text-ink-4">{b.pct}%</div>
        </div>
      ))}
      <div className="mt-3 flex flex-wrap gap-4 border-t border-border-strong pt-3 text-[11.5px] text-ink-3">
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--green)" }} />Healthy</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--amber)" }} />Worth a check</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--red)" }} />Review at meeting</span>
      </div>
    </div>
  );
}

// ── Breakdown bars ──────────────────────────────────────────────────────────

function breakdownLabel(dim: OppBreakdownDim, key: string, label: string): string {
  if (dim === "deal_type") return DEAL_TYPE_LABELS[key as DealType] ?? label;
  if (dim === "owner") return ownerShort(key);
  return label;
}

function BreakdownBars({ items, dim, isLoading }: { items: { key: string; label: string; count: number }[]; dim: OppBreakdownDim; isLoading: boolean }) {
  if (isLoading) {
    return <div className="flex flex-col gap-3 py-1">{Array.from({ length: 4 }).map((_, i) => (
      <div key={i} className="h-3 animate-pulse rounded bg-surface-2" />
    ))}</div>;
  }
  if (items.length === 0) return <div className="py-6 text-center text-[12px] text-ink-4">No data.</div>;
  const total = items.reduce((a, b) => a + b.count, 0) || 1;
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="flex flex-col">
      {items.map((it) => (
        <div key={it.key} className="grid grid-cols-[128px_1fr_58px] items-center gap-3 py-[7px]">
          <div className="truncate text-[12.5px] font-medium text-ink" title={breakdownLabel(dim, it.key, it.label)}>
            {breakdownLabel(dim, it.key, it.label)}
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${Math.round((100 * it.count) / max)}%`, background: "linear-gradient(90deg,#6d5efc,#8b7dff)" }} />
          </div>
          <div className="text-right text-[12px] tabular-nums text-ink-2">
            <span className="font-semibold text-ink">{it.count}</span>
            <span className="text-ink-4"> · {Math.round((100 * it.count) / total)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Recent activity feed ──────────────────────────────────────────────────────

const ACTIVITY_META: Record<OppActivityEvent["type"], { label: string; color: string; icon: React.ReactNode }> = {
  added:   { label: "Added",   color: "var(--accent)", icon: <Plus size={11} /> },
  moved:   { label: "Moved",   color: "var(--sky)",    icon: <ArrowRight size={11} /> },
  won:     { label: "Won",     color: "var(--green)",  icon: <Trophy size={11} /> },
  lost:    { label: "Lost",    color: "var(--ink-3)",  icon: <XCircle size={11} /> },
  stalled: { label: "Stalled", color: "var(--amber)",  icon: <Clock size={11} /> },
};

function RecentActivity({ events, isLoading, nameOf }: { events: OppActivityEvent[]; isLoading: boolean; nameOf: (e: string | null) => string }) {
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="h-32 animate-pulse rounded-lg bg-surface-2" />;
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border-strong px-4 py-8 text-[12px] text-ink-4">
        No activity in this week.
      </div>
    );
  }
  const shown = showAll ? events : events.slice(0, 10);
  return (
    <div className="flex flex-col">
      {shown.map((e, i) => {
        const m = ACTIVITY_META[e.type];
        return (
          <div key={`${e.opportunity_id}-${i}`} className="flex items-center gap-3 border-b border-border-strong py-2 last:border-b-0">
            <span
              className="inline-flex w-[76px] flex-shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold"
              style={{ color: m.color }}
            >
              {m.icon}{m.label}
            </span>
            <div className="min-w-0 flex-1 truncate">
              <Link to={`/jobs/opportunities/${e.opportunity_id}`} className="text-[13px] font-semibold text-ink hover:text-accent">
                {e.account || "—"}
              </Link>
              <span className="ml-2 text-[12px] text-ink-3">{e.detail}</span>
            </div>
            <span className="flex-shrink-0 text-[11px] text-ink-4">{nameOf(e.actor)}</span>
            <span className="w-[56px] flex-shrink-0 text-right text-[11px] text-ink-4">
              {e.at ? format(new Date(e.at), "MMM d") : "—"}
            </span>
          </div>
        );
      })}
      {events.length > 10 ? (
        <button type="button" onClick={() => setShowAll((v) => !v)}
          className="mt-2 self-start text-[12px] font-medium text-accent hover:underline">
          {showAll ? "Show less" : `Show ${events.length - 10} more`}
        </button>
      ) : null}
    </div>
  );
}
