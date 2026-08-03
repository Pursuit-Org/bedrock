/**
 * Jobs · Opportunities — Weekly Overview.
 *
 * The pipeline-meeting agenda, top to bottom: summary cards (incl. the
 * won-with-open-tasks stage-gate check, which sits left of the closed
 * won/lost outcome boxes), the period-scoped opportunities funnel,
 * time-in-stage aging + the switchable set distribution, the concentration
 * heatmap (one chart; the dropdown swaps its Y axis between stage and
 * priority), recent activity (the week's narrative), then the
 * per-owner walkthrough (P1s with next task, stalled with why — rows manage
 * inline and expand to the full DealExpandPanel).
 *
 * "Time in pipeline" = time in the CURRENT stage (from jobs_stage_history).
 * Backed by /api/jobs/opportunities/overview (+ /opportunities for the
 * managed rows). The standalone needs-attention panel was removed in the
 * 2026-07-30 exec review; the heatmaps were removed then too and restored
 * 2026-08-03 — the priority axis degrades to an empty-state card rather than
 * rendering a blank grid, which was the original objection to it.
 *
 * Every number representing a slice of the active set (aging bar, distribution
 * bar, heatmap cell) drills into the SAME `active_set` array from the
 * endpoint, so a drill list can never disagree with the count above it.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { AlertTriangle, ArrowRight, ChevronRight, Clock, Minus, Plus, TrendingDown, TrendingUp, Trophy, XCircle } from "lucide-react";

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
  type OppHeatmap,
  type OppActiveSetMember,
  type OutreachGranularity,
} from "@/services/jobs";
import { useAllJobsTasks } from "@/services/jobsTasks";
import { useSessionState } from "@/lib/useSessionState";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { Drawer } from "@/components/ui/Drawer";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { PeriodBar } from "@/components/jobs/PeriodBar";
import { CommittedRolesModal } from "@/components/jobs/CommittedRolesModal";
import { DealExpandPanel, PlacementsModal, ClosedLostModal, stageOptionsFor, displayPriority } from "./JobsTeam";
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

/** Local YYYY-MM-DD (avoids the UTC shift of toISOString). */
function fmtDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const dayOnly = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const parseDateInput = (v: string) => dayOnly(new Date(`${v}T00:00:00`));
/** Whole days from a to b (both floored to midnight). */
const dayDiff = (a: Date, b: Date) => Math.round((dayOnly(b).getTime() - dayOnly(a).getTime()) / 86400000);
/** The most recent `dow` (0=Sun) on or before `d`. */
function mostRecentDow(d: Date, dow: number): Date {
  const x = dayOnly(d);
  x.setDate(x.getDate() - ((x.getDay() - dow + 7) % 7));
  return x;
}
/** Sun–Sat week containing `d`, clamped to today (the previous default). */
function calendarWeek(today: Date): { start: Date; end: Date } {
  const t = dayOnly(today);
  const sun = mostRecentDow(t, 0);
  return { start: sun, end: t };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function JobsOpportunitiesOverview() {
  const [owner, setOwner] = useState<string>("all");
  const [dealType, setDealType] = useState<string>("all");
  const [dim, setDim] = useState<OppBreakdownDim>("status");
  // Y axis of the single concentration heatmap. Stage is the default because
  // it is always populated; priority can legitimately be empty.
  const [heatAxis, setHeatAxis] = useState<HeatAxis>("stage");
  // Bucket size travels with the period preset, same as Outreach.
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  // Free-form window: both bounds inclusive, no snapping. Defaults to the
  // calendar week (what the Weekly preset selects, matching Outreach); the
  // presets and the two date inputs set it.
  const [range, setRange] = useState<{ start: Date; end: Date }>(() => calendarWeek(new Date()));
  const weekStart = range.start;
  const weekEnd = range.end;
  const spanDays = Math.max(1, dayDiff(weekStart, weekEnd) + 1);
  const rangeLabel = weekStart.getFullYear() === weekEnd.getFullYear()
    ? `${format(weekStart, "MMM d")} – ${format(weekEnd, "MMM d")}`
    : `${format(weekStart, "MMM d, yyyy")} – ${format(weekEnd, "MMM d, yyyy")}`;

  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (staffQ.data ?? []).forEach((st) => m.set(st.email, st.name));
    return (email: string | null) => (email ? m.get(email) ?? titleCaseEmail(email) : "—");
  }, [staffQ.data]);
  const { data, isLoading } = useOpportunitiesOverview(
    owner, dealType, fmtDateInput(weekEnd), fmtDateInput(weekStart));

  const s = data?.summary;
  const netDelta = s ? s.net_new - s.net_new_prev : 0;
  // Wins first, then moves, then new arrivals (review order, not chronology).
  const ACTIVITY_ORDER: Record<string, number> = { won: 0, moved: 1, added: 2, lost: 3 };
  const orderedActivity = useMemo(() => [...(data?.recent_activity ?? [])].sort((a, b) =>
    (ACTIVITY_ORDER[a.type] ?? 9) - (ACTIVITY_ORDER[b.type] ?? 9) || (b.at ?? "").localeCompare(a.at ?? "")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data]);

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
      <h2 className="text-[18px] font-semibold tracking-tight text-ink">Opportunities Overview</h2>

      <PeriodBar
        from={fmtDateInput(weekStart)} to={fmtDateInput(weekEnd)}
        onChange={(f, t) => setRange({ start: parseDateInput(f), end: parseDateInput(t) })}
        granularity={granularity} onGranularityChange={setGranularity}
        clampToToday
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Owner</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}
            className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent">
            <option value="all">All owners</option>
            {(staffQ.data ?? []).map((st) => (
              <option key={st.email} value={st.email}>{st.name || ownerShort(st.email)}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Deal type</span>
          <select value={dealType} onChange={(e) => setDealType(e.target.value)}
            className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent">
            {DEAL_TYPE_FILTERS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
      </PeriodBar>

      {/* ── Summary cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 items-stretch gap-4 lg:grid-cols-5">
        <SummaryCard tone="ink" label="In the set" value={s?.in_set} isLoading={isLoading}
          sub="All active opportunities"
          onClick={() => setDrill({ title: "In the set", note: "All active opportunities", rows: data?.drills.in_set ?? [] })} />
        <SummaryCard tone="accent" label="Net new" value={s?.net_new} sub={rangeLabel} isLoading={isLoading}
          delta={s ? { n: netDelta, prev: s.net_new_prev, priorLabel: spanDays === 7 ? "last wk" : `prior ${spanDays}d` } : undefined}
          onClick={() => setDrill({ title: "Net new", note: `Created ${rangeLabel}`, rows: data?.drills.net_new ?? [] })} />
        <SummaryCard tone="amber" label="Stalled" value={s?.stalled_6wk} isLoading={isLoading}
          sub="Open opportunity 6+ weeks"
          onClick={() => setDrill({ title: "Stalled 6+ weeks", note: "Open, created more than 6 weeks ago", rows: data?.drills.stalled ?? [] })} />
        {/* Stage-gate check: won on the board but the follow-through (e.g. the
            signed contract task) is still open — "signed contract = closed".
            Sits left of the outcome boxes: it's an action, they're a result. */}
        <SummaryCard tone="red" label="Won, open tasks" value={wonOpenTasks.length} isLoading={isLoading}
          sub={wonOpenTasks.slice(0, 2).map((o) => o.account_name).join(" · ") || "all buttoned up"}
          onClick={() => setDrill({ title: "Won with open tasks", note: "Closed won but follow-through still open", rows: asDrillRows(wonOpenTasks) })} />
        {/* Stacked outcome boxes for the week — Closed won (the goal,
            subtly highlighted) over Closed lost (context to understand, not a red flag). */}
        <div className="flex flex-col gap-4">
          <OutcomeBox tone="green" highlight label="Closed won" value={s?.moved_committed} sub={rangeLabel} isLoading={isLoading}
            onClick={() => setDrill({ title: "Closed won", note: rangeLabel, rows: data?.drills.won ?? [] })} />
          <OutcomeBox tone="ink" label="Closed lost" value={s?.closed_lost} sub={rangeLabel} isLoading={isLoading}
            onClick={() => setDrill({ title: "Closed lost", note: rangeLabel, rows: data?.drills.lost ?? [] })} />
        </div>
      </div>

      {/* ── Pipeline funnel — period-scoped, same visual as Outreach ───── */}
      <JobsFunnels
        only="opportunities"
        period={{ from: fmtDateInput(weekStart), to: fmtDateInput(weekEnd) }}
        periodLabel={rangeLabel}
        dealType={dealType}
        onUsePeriod={(f, t) => setRange({ start: parseDateInput(f), end: parseDateInput(t) })}
      />

      {/* ── Aging + Breakdown ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Time in Pipeline">
          <AgingBars buckets={data?.aging.buckets ?? []} isLoading={isLoading}
            activeSet={data?.active_set} nameOf={nameOf} />
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
          <BreakdownBars items={data?.breakdowns[dim] ?? []} dim={dim} isLoading={isLoading}
            activeSet={data?.active_set} nameOf={nameOf} />
        </Panel>
      </div>

      {/* ── Concentration heatmap ─────────────────────────────────────────
          Where the active set sits, cross-tabbed against how long it's been
          sitting. Dark cells on the right = piling up; dark on the left =
          healthy flow. Columns are always the age buckets; the dropdown swaps
          the Y axis between Stage and Priority (one chart, was two). */}
      <Panel
        title={`${heatAxis === "stage" ? "Stage" : "Priority"} × Time in Pipeline`}
        action={
          <select
            value={heatAxis}
            onChange={(e) => setHeatAxis(e.target.value as HeatAxis)}
            title="What the rows break down by"
            className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
          >
            <option value="stage">By stage</option>
            <option value="priority">By priority</option>
          </select>
        }
      >
        {heatAxis === "priority" && data && !data.heatmaps.priority.populated ? (
          <EmptyPriorityCard unset={data.heatmaps.priority.unset ?? 0} />
        ) : (
          <Heatmap
            heatmap={heatAxis === "stage" ? data?.heatmaps.stage : data?.heatmaps.priority}
            buckets={data?.heatmaps.buckets ?? []}
            rowHeader={heatAxis === "stage" ? "Stage" : "Priority"}
            isLoading={isLoading}
            axis={heatAxis}
            activeSet={data?.active_set}
            nameOf={nameOf}
          />
        )}
      </Panel>

      {/* ── Recent activity — the week's narrative ────────────────────── */}
      <Panel
        title="Recent activity"
        desc={`Added, moved, won or lost between ${rangeLabel} — newest first`}
      >
        <RecentActivity events={orderedActivity} isLoading={isLoading} nameOf={nameOf} />
      </Panel>

      {/* ── Pipeline details (grouped by priority; owner view = the walkthrough) ── */}
      <Panel
        title="Pipeline details"
        desc="Grouped by priority (switch to owner for the walkthrough) — rows manage inline and expand to the full panel"
      >
        <div className="max-h-[520px] overflow-y-auto">
          <OwnerWalkthrough openOpps={openOpps} needsById={needsById} nextTaskByOpp={nextTaskByOpp}
            nameOf={nameOf} {...rowHandlers} />
        </div>
      </Panel>

      {/* Needs-attention panel removed 2026-07-30 — the walkthrough's stalled
          groups carry the same rows, grouped by owner and manageable. */}

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
      <div className="flex-1 overflow-auto p-4">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-strong px-4 py-10 text-center text-[12.5px] text-ink-4">
            Nothing here for this window.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border-strong">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-surface-2 text-left text-[10px] uppercase tracking-wider text-ink-4">
                  <th className="px-3 py-2 font-semibold">Account</th>
                  <th className="px-2 py-2 font-semibold">Stage</th>
                  <th className="px-2 py-2 font-semibold">Owner</th>
                  <th className="px-3 py-2 text-right font-semibold">When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.opportunity_id} className="border-t border-border-strong hover:bg-surface-2/50">
                    <td className="px-3 py-1.5">
                      <Link to={`/jobs/opportunities/${r.opportunity_id}`}
                        className="font-medium text-ink hover:text-accent hover:underline">
                        {r.account || "—"}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="whitespace-nowrap rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-2">
                        {r.stage_label}
                      </span>
                    </td>
                    <td className="truncate px-2 py-1.5 text-[11.5px] text-ink-3">{nameOf(r.owner)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[11.5px] text-ink-4">{relDay(r.at) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  const [groupBy, setGroupBy] = useSessionState<"owner" | "priority" | "">("jobsPipeline.details.groupBy", "priority");
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
          { label: "P1 · High value", cls: "bg-[var(--accent-soft)] text-[var(--accent-ink)]", rows: visible.filter((o) => displayPriority(o.priority) === 1) },
          { label: "P2", cls: "bg-[var(--sky-soft)] text-[var(--sky)]", rows: visible.filter((o) => displayPriority(o.priority) === 2) },
          { label: "P3+ / no priority", cls: "bg-surface-2 text-ink-3", rows: visible.filter((o) => (displayPriority(o.priority) ?? 9) >= 3) },
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
        const p1 = opps.filter((o) => displayPriority(o.priority) === 1);
        const p2 = opps.filter((o) => displayPriority(o.priority) === 2);
        const rest = opps.filter((o) => (displayPriority(o.priority) ?? 9) >= 3);
        // Flagged opps without a P1/P2 priority — the meeting's ask list.
        // P1/P2 flagged rows already carry their attention chip in-group, so
        // they're not repeated here.
        const stalled = opps.filter((o) => needsById.has(o.id) && displayPriority(o.priority) !== 1 && displayPriority(o.priority) !== 2)
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
  delta?: { n: number; prev: number; priorLabel: string };
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
          {delta.n === 0 ? `same as ${delta.prev} ${delta.priorLabel}` : `${delta.n > 0 ? "↑" : "↓"} vs ${delta.prev} ${delta.priorLabel}`}
        </div>
      ) : !isLoading && sub ? (
        <div className="mt-2 text-[11.5px] text-ink-4">{sub}</div>
      ) : null}
    </div>
  );
}

// ── Outcome box (half-height; stacked for won / lost) ─────────────────────────

function OutcomeBox({
  tone, label, value, sub, highlight, isLoading, onClick,
}: {
  tone: keyof typeof TONE | string;
  label: string;
  value: number | undefined;
  sub?: string;
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
        <div className="text-[10.5px] text-ink-4">{sub ?? "this week"}</div>
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

export function Panel({
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

// ── Shared inline drill ──────────────────────────────────────────────────────
// Every number on this page that represents a slice of the active set opens the
// same list, filtered from `active_set` — so the drill and the count are always
// the same rows. Capped at 5 with a show-all, since these sit inline under a
// chart rather than in a drawer.

const MINI_DRILL_CAP = 5;

function OppMiniDrill({ label, members, nameOf }: {
  label: string;
  members: OppActiveSetMember[];
  nameOf: (e: string | null) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? members : members.slice(0, MINI_DRILL_CAP);
  const extra = members.length - shown.length;

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border-strong bg-surface-2/40">
      <div className="flex items-center justify-between border-b border-border-strong px-3 py-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
        <span className="text-[11px] tabular-nums text-ink-4">{members.length}</span>
      </div>
      {members.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-ink-4">No opportunities here.</div>
      ) : (
        <>
          <ul className="divide-y divide-border-strong">
            {shown.map((m) => (
              <li key={m.opportunity_id} className="flex items-center gap-2 px-3 py-1.5">
                <Link to={`/jobs/opportunities/${m.opportunity_id}`}
                  className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink hover:text-accent hover:underline">
                  {m.account ?? "—"}
                </Link>
                <span className="w-[132px] flex-shrink-0 truncate text-[11.5px] text-ink-3">{m.stage_label}</span>
                <span className="w-[96px] flex-shrink-0 truncate text-[11.5px] text-ink-3">{nameOf(m.owner)}</span>
                <span className="w-[64px] flex-shrink-0 text-right text-[11.5px] tabular-nums text-ink-4">
                  {m.days_in_stage}d
                </span>
              </li>
            ))}
          </ul>
          {extra > 0 ? (
            <button type="button" onClick={() => setShowAll(true)}
              className="w-full border-t border-border-strong px-3 py-1.5 text-[11.5px] font-medium text-accent hover:bg-surface-2">
              Show all {members.length}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The active-set field each distribution dimension groups by. Must mirror the
 *  keys the backend counts with, or a drill would disagree with its bar. */
const BD_FIELD: Record<OppBreakdownDim, keyof OppActiveSetMember> = {
  status: "status",
  deal_type: "deal_type",
  segment: "segment",
  stage: "stage",
  owner: "owner_key",
};

// ── Aging bars ────────────────────────────────────────────────────────────────

const AGE_COLOR = ["var(--green)", "#6FBE93", "var(--amber)", "#D97A3E", "var(--red)"];

function AgingBars({ buckets, isLoading, activeSet, nameOf }: {
  buckets: { key: string; label: string; count: number; pct: number }[];
  isLoading: boolean;
  activeSet?: OppActiveSetMember[];
  nameOf?: (e: string | null) => string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (isLoading) {
    return <div className="flex flex-col gap-3 py-1">{Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="h-3 animate-pulse rounded bg-surface-2" />
    ))}</div>;
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const canDrill = !!activeSet && !!nameOf;
  return (
    <div className="flex flex-col">
      {buckets.map((b, i) => (
        <div key={b.key}>
          <div className="grid grid-cols-[92px_1fr_36px_36px] items-center gap-3 py-[7px]">
            <div className="text-[12.5px] font-semibold text-ink">{b.label}</div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.round((100 * b.count) / max)}%`, background: AGE_COLOR[i] ?? "var(--accent)" }} />
            </div>
            {canDrill && b.count > 0 ? (
              <button type="button" onClick={() => setOpen(open === i ? null : i)}
                title={`Show the ${b.count} opportunities in ${b.label}`}
                className={cn("rounded text-right text-[12.5px] font-semibold tabular-nums hover:underline",
                  open === i ? "text-accent" : "text-ink hover:text-accent")}>
                {b.count}
              </button>
            ) : (
              <div className="text-right text-[12.5px] font-semibold tabular-nums text-ink">{b.count}</div>
            )}
            <div className="text-right text-[11.5px] tabular-nums text-ink-4">{b.pct}%</div>
          </div>
          {canDrill && open === i ? (
            <OppMiniDrill label={`${b.label} in stage`} nameOf={nameOf}
              members={activeSet.filter((m) => m.age_bucket === i)} />
          ) : null}
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

export function BreakdownBars({ items, dim, isLoading, activeSet, nameOf }: {
  items: { key: string; label: string; count: number }[];
  dim: OppBreakdownDim;
  isLoading: boolean;
  /** Pass the active set to make each count drillable. Omitted on the Outreach
   *  targeting panel, which charts a different population entirely. */
  activeSet?: OppActiveSetMember[];
  nameOf?: (e: string | null) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading) {
    return <div className="flex flex-col gap-3 py-1">{Array.from({ length: 4 }).map((_, i) => (
      <div key={i} className="h-3 animate-pulse rounded bg-surface-2" />
    ))}</div>;
  }
  if (items.length === 0) return <div className="py-6 text-center text-[12px] text-ink-4">No data.</div>;
  const total = items.reduce((a, b) => a + b.count, 0) || 1;
  const max = Math.max(1, ...items.map((i) => i.count));
  const canDrill = !!activeSet && !!nameOf;
  const field = BD_FIELD[dim];
  return (
    <div className="flex flex-col">
      {items.map((it) => (
        <div key={it.key}>
          <div className="grid grid-cols-[128px_1fr_58px] items-center gap-3 py-[7px]">
            <div className="truncate text-[12.5px] font-medium text-ink" title={breakdownLabel(dim, it.key, it.label)}>
              {breakdownLabel(dim, it.key, it.label)}
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.round((100 * it.count) / max)}%`, background: "linear-gradient(90deg,#6d5efc,#8b7dff)" }} />
            </div>
            <div className="text-right text-[12px] tabular-nums text-ink-2">
              {canDrill && it.count > 0 ? (
                <button type="button" onClick={() => setOpen(open === it.key ? null : it.key)}
                  title={`Show the ${it.count} opportunities in ${breakdownLabel(dim, it.key, it.label)}`}
                  className={cn("font-semibold hover:underline", open === it.key ? "text-accent" : "text-ink hover:text-accent")}>
                  {it.count}
                </button>
              ) : (
                <span className="font-semibold text-ink">{it.count}</span>
              )}
              <span className="text-ink-4"> · {Math.round((100 * it.count) / total)}%</span>
            </div>
          </div>
          {canDrill && open === it.key ? (
            <OppMiniDrill label={breakdownLabel(dim, it.key, it.label)} nameOf={nameOf}
              members={activeSet.filter((m) => m[field] === it.key)} />
          ) : null}
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

// ── Concentration heatmaps ───────────────────────────────────────────────────
// Colour encodes VOLUME only — a blue that deepens with the count. No red
// "concern" shading: the gradient is the single signal, so a dark cell in an
// older column is the whole story without a second visual language on top.

function heatBlue(n: number, max: number): { background: string; color: string } {
  if (n <= 0) return { background: "var(--surface-2)", color: "var(--ink-4)" };
  const t = max > 0 ? n / max : 0;
  const alpha = 0.16 + 0.84 * t;
  return {
    background: `rgba(47, 127, 224, ${alpha.toFixed(2)})`,  // --sky base #2F7FE0
    color: alpha > 0.5 ? "#ffffff" : "var(--ink)",
  };
}

function EmptyPriorityCard({ unset }: { unset: number }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center">
      <p className="text-[12.5px] font-semibold text-ink">
        No priority set on any of the {unset} active opps yet.
      </p>
      <p className="mt-1 text-[11.5px] text-ink-3">
        This heatmap lights up automatically as the team sets priority on opportunities.
      </p>
    </div>
  );
}

type HeatAxis = "stage" | "priority";

function Heatmap({ heatmap, buckets, rowHeader, isLoading, axis, activeSet, nameOf }: {
  heatmap: OppHeatmap | undefined;
  buckets: { key: string; label: string }[];
  rowHeader: string;
  isLoading: boolean;
  axis: HeatAxis;
  activeSet?: OppActiveSetMember[];
  nameOf?: (e: string | null) => string;
}) {
  // `${rowKey}:${bucketIndex}` of the open cell.
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) return <div className="h-40 animate-pulse rounded-lg bg-surface-2" />;
  if (!heatmap || heatmap.rows.length === 0)
    return <div className="py-6 text-center text-[12px] text-ink-4">No opportunities to chart.</div>;

  const max = Math.max(1, ...heatmap.rows.flatMap((r) => r.cells));
  const canDrill = !!activeSet && !!nameOf;
  // Priority rows are keyed "P3" on the wire but the member carries 3.
  const rowMatches = (m: OppActiveSetMember, rowKey: string) =>
    axis === "stage" ? m.stage === rowKey : `P${m.priority ?? ""}` === rowKey;

  const openRow = open ? heatmap.rows.find((r) => `${r.key}:${open.split(":")[1]}` === open) : null;
  const openBucket = open ? Number(open.split(":")[1]) : null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse">
        <thead>
          <tr>
            <th className="px-2 pb-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{rowHeader}</th>
            {buckets.map((b) => (
              <th key={b.key} className="px-1.5 pb-2.5 text-center text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{b.label}</th>
            ))}
            <th className="px-2 pb-2.5 text-right text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Total</th>
          </tr>
        </thead>
        <tbody>
          {heatmap.rows.map((row) => (
            <tr key={row.key}>
              <td className="whitespace-nowrap py-1 pr-2 text-[12.5px] font-semibold text-ink">{row.label}</td>
              {row.cells.map((n, i) => {
                const st = heatBlue(n, max);
                const cellKey = `${row.key}:${i}`;
                const isOpen = open === cellKey;
                const clickable = canDrill && n > 0;
                return (
                  <td key={i} className="p-1">
                    <div
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? () => setOpen(isOpen ? null : cellKey) : undefined}
                      onKeyDown={clickable ? (e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(isOpen ? null : cellKey); }
                      } : undefined}
                      title={clickable ? `${n} opportunities · ${row.label} · ${buckets[i]?.label ?? ""} — click to list them` : undefined}
                      className={cn(
                        "flex h-11 items-center justify-center rounded-lg text-[14px] font-bold",
                        clickable && "cursor-pointer transition-shadow hover:ring-2 hover:ring-accent/50",
                        isOpen && "ring-2 ring-accent",
                      )}
                      style={{ background: st.background, color: st.color }}
                    >
                      {n}
                    </div>
                  </td>
                );
              })}
              <td className="py-1 pl-2 text-right text-[12px] font-semibold tabular-nums text-ink-3">{row.total}</td>
            </tr>
          ))}
          <tr>
            <td className="border-t border-border-strong pt-2.5 text-[11.5px] font-semibold text-ink-4">Column total</td>
            {heatmap.col_totals.map((n, i) => (
              <td key={i} className="border-t border-border-strong pt-2.5 text-center text-[11.5px] font-semibold tabular-nums text-ink-4">{n}</td>
            ))}
            <td className="border-t border-border-strong" />
          </tr>
        </tbody>
      </table>

      {canDrill && openRow && openBucket != null ? (
        <OppMiniDrill
          label={`${openRow.label} · ${buckets[openBucket]?.label ?? ""}`}
          nameOf={nameOf}
          members={activeSet.filter((m) => m.age_bucket === openBucket && rowMatches(m, openRow.key))}
        />
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-ink-4">
        <span className="h-2.5 w-8 rounded-sm"
          style={{ background: "linear-gradient(90deg, rgba(47,127,224,0.16), rgba(47,127,224,1))" }} />
        fewer → more opportunities
      </div>
    </div>
  );
}

function RecentActivity({ events, isLoading, nameOf }: { events: OppActivityEvent[]; isLoading: boolean; nameOf: (e: string | null) => string }) {
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="h-32 animate-pulse rounded-lg bg-surface-2" />;
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border-strong px-4 py-8 text-[12px] text-ink-4">
        No activity in the selected range.
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
