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
import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, ChevronUp, Columns3, Clock, Minus, Plus, TrendingDown, TrendingUp, Trophy, X, XCircle } from "lucide-react";

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
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { parseEstimatedJobs } from "@/lib/estimatedJobs";
import { Drawer } from "@/components/ui/Drawer";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { JobsProjectionChart } from "@/components/jobs/JobsProjectionChart";
import { PeriodBar, defaultPeriod } from "@/components/jobs/PeriodBar";
import { CommittedRolesModal } from "@/components/jobs/CommittedRolesModal";
import { DealExpandPanel, PlacementsModal, ClosedLostModal, useOppStageOptions, displayPriority } from "./JobsTeam";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const DIMS: { key: OppBreakdownDim; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "deal_type", label: "Deal type" },
  { key: "segment", label: "Segment" },
  { key: "stage", label: "Stage" },
  { key: "owner", label: "Owner" },
];

// Deal-type filter options. "unset" is the API token for opportunities with no
// deal type, shown as Untagged so they can be pulled into (or kept out of) a view.
const DEAL_TYPE_UNSET = "unset";
const DEAL_TYPE_OPTIONS: { value: string; label: string }[] = [
  ...(Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]).map(([value, label]) => ({ value, label })),
  { value: DEAL_TYPE_UNSET, label: "Untagged" },
];
const ALL_DEAL_TYPES = DEAL_TYPE_OPTIONS.map((o) => o.value);

/** Selection → the `deal_type` query value: "all" when every box is ticked,
 *  otherwise a comma-separated list the API reads as OR. */
function dealTypeParam(selected: string[]): string {
  return selected.length === ALL_DEAL_TYPES.length
    ? "all"
    : ALL_DEAL_TYPES.filter((v) => selected.includes(v)).join(",");
}

function dealTypeSummary(selected: string[]): string {
  if (selected.length === ALL_DEAL_TYPES.length) return "All deal types";
  const labels = DEAL_TYPE_OPTIONS.filter((o) => selected.includes(o.value)).map((o) => o.label);
  return labels.length <= 2 ? labels.join(" + ") : `${labels[0]} + ${labels.length - 1} more`;
}

/** Checkbox popover for deal type. At least one box stays ticked: an empty
 *  selection would either show nothing or quietly mean "all", and both read
 *  as a bug. "All" ticks every box, Untagged included. */
function DealTypeFilter({ selected, onChange }: { selected: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const allOn = selected.length === ALL_DEAL_TYPES.length;
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    if (next.length > 0) onChange(next);
  };
  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="flex h-7 min-w-[140px] items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none hover:border-ink-3 focus:border-accent">
        <span className="truncate">{dealTypeSummary(selected)}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[200px] rounded-md border border-border-strong bg-surface py-1 shadow-lg">
          <label className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-2">
            <input type="checkbox" className="accent-[var(--accent)]" checked={allOn}
              onChange={() => onChange(allOn ? ["ft"] : [...ALL_DEAL_TYPES])} />
            All deal types
          </label>
          {DEAL_TYPE_OPTIONS.map((o) => {
            const on = selected.includes(o.value);
            const last = on && selected.length === 1;
            return (
              <label key={o.value}
                className={cn("flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-2",
                  last ? "cursor-not-allowed" : "cursor-pointer",
                  o.value === DEAL_TYPE_UNSET && "border-t border-border text-ink-2")}
                title={last ? "At least one deal type stays selected" : undefined}>
                <input type="checkbox" className="accent-[var(--accent)]" checked={on} disabled={last}
                  onChange={() => toggle(o.value)} />
                {o.label}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

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

// ── Main ──────────────────────────────────────────────────────────────────────

export function JobsOpportunitiesOverview() {
  const [owner, setOwner] = useState<string>("all");
  // Full-time by default (Kwame 2026-09-29): the pipeline review is about
  // full-time placements, and "all" rolled capstones, part-time and contracts
  // into Closed won beside them. Multi-select; `dealType` is the one query value
  // every panel on the page reads.
  const [dealTypes, setDealTypes] = useState<string[]>(["ft"]);
  const [projGranularity, setProjGranularity] = useSessionState<"quarter" | "month">("jobsPipeline.projection.granularity", "quarter");
  const [projPast, setProjPast] = useSessionState<boolean>("jobsPipeline.projection.past", false);
  const dealType = dealTypeParam(dealTypes);
  const [dim, setDim] = useState<OppBreakdownDim>("status");
  // Y axis of the single concentration heatmap. Stage is the default because
  // it is always populated; priority can legitimately be empty.
  const [heatAxis, setHeatAxis] = useState<HeatAxis>("stage");
  // Bucket size travels with the period preset, same as Outreach.
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  // Free-form window: both bounds inclusive, no snapping. The presets and the
  // two date inputs set it.
  // The current week so far: Pipeline is the Thursday meeting's view (D8).
  const [range, setRange] = useState<{ start: Date; end: Date }>(() => {
    const [f, t] = defaultPeriod("thursday");
    return { start: parseDateInput(f), end: parseDateInput(t) };
  });
  const weekStart = range.start;
  const weekEnd = range.end;
  const spanDays = Math.max(1, dayDiff(weekStart, weekEnd) + 1);
  const rangeLabel = weekStart.getFullYear() === weekEnd.getFullYear()
    ? `${format(weekStart, "MMM d")} – ${format(weekEnd, "MMM d")}`
    : `${format(weekStart, "MMM d, yyyy")} – ${format(weekEnd, "MMM d, yyyy")}`;

  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (staffQ.data ?? []).forEach((st) => { if (st.name) m.set(st.email.toLowerCase(), st.name); });
    // Keyed lowercase: the API returns owner emails lowercased while one staff
    // record is "joanna@Pursuit.org", so an exact-case map missed and fell
    // through to the email's local part — "avni" instead of "Avni Nahar".
    return (email: string | null) => (email ? m.get(email.toLowerCase()) ?? titleCaseEmail(email) : "—");
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
    deal_type: dealType !== "all" ? dealType : undefined,
    // Every deal, not the 500 most recently updated: owner counts and the
    // "Won, open tasks" card are built from these rows (PRO-96).
    all: true,
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
    <div className="flex flex-col gap-4 pt-1">
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
          <DealTypeFilter selected={dealTypes} onChange={setDealTypes} />
        </div>
      </PeriodBar>

      {/* ── Summary cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 items-stretch gap-4 lg:grid-cols-5">
        <SummaryCard tone="ink" label="In the set" value={s?.in_set} isLoading={isLoading}
          sub="All active opportunities"
          onClick={() => setDrill({ title: "In the set", note: "All active opportunities", rows: data?.drills?.in_set ?? [] })} />
        {/* Net new and Stalled read black like In the set (Kwame 2026-09-21).
            Colouring a headline count implies a verdict on it, and neither is
            one: net new is neither good nor bad without a target, and stalled
            already carries its own amber treatment on the board below. The
            delta chip under Net new still colours, which is where the judgement
            actually belongs. */}
        <SummaryCard tone="ink" label="Net new" value={s?.net_new} sub={rangeLabel} isLoading={isLoading}
          delta={s ? { n: netDelta, prev: s.net_new_prev, priorLabel: spanDays === 7 ? "last wk" : `prior ${spanDays}d` } : undefined}
          onClick={() => setDrill({ title: "Net new", note: `Created ${rangeLabel}`, rows: data?.drills?.net_new ?? [] })} />
        <SummaryCard tone="ink" label="Stalled" value={s?.stalled} isLoading={isLoading}
          sub={s?.stalled_label ?? "No activity in 4+ weeks"}
          onClick={() => setDrill({ title: "Stalled", note: `Open, no stage change and no activity (comments don't count) on the deal or anyone at its account · ${s?.stalled_label ?? ""} · date is last movement`, rows: data?.drills?.stalled ?? [] })} />
        {/* Stage-gate check: won on the board but the follow-through (e.g. the
            signed contract task) is still open — "signed contract = closed".
            Sits left of the outcome boxes: it's an action, they're a result. */}
        <SummaryCard tone="red" label="Won, open tasks" value={wonOpenTasks.length} isLoading={isLoading}
          sub={wonOpenTasks.slice(0, 2).map((o) => o.account_name).join(" · ") || "all buttoned up"}
          onClick={() => setDrill({ title: "Won with open tasks", note: "Closed won but follow-through still open", rows: asDrillRows(wonOpenTasks) })} />
        {/* Stacked outcome boxes for the week — Closed won (the goal,
            subtly highlighted) over Closed lost (context to understand, not a red flag). */}
        <div className="flex flex-col gap-4">
          <OutcomeBox tone="green" highlight label="Closed won" value={s?.moved_committed} isLoading={isLoading}
            onClick={() => setDrill({ title: "Closed won", note: rangeLabel, rows: data?.drills?.won ?? [] })} />
          <OutcomeBox tone="ink" label="Closed lost" value={s?.closed_lost} isLoading={isLoading}
            onClick={() => setDrill({ title: "Closed lost", note: rangeLabel, rows: data?.drills?.lost ?? [] })} />
        </div>
      </div>

      {/* ── Pipeline funnel — period-scoped, same visual as Outreach ───── */}
      <JobsFunnels
        only="opportunities"
        period={{ from: fmtDateInput(weekStart), to: fmtDateInput(weekEnd) }}
        periodLabel={rangeLabel}
        dealType={dealType}
        owner={owner}
      />

      {/* ── Aging + Breakdown ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Time in Pipeline">
          <AgingBars buckets={data?.aging?.buckets ?? []} isLoading={isLoading}
            activeSet={data?.active_set} nameOf={nameOf} />
        </Panel>
        <Panel
          title="Active Set Distribution"
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
            heatmap={heatAxis === "stage" ? data?.heatmaps?.stage : data?.heatmaps?.priority}
            buckets={data?.heatmaps?.buckets ?? []}
            rowHeader={heatAxis === "stage" ? "Stage" : "Priority"}
            isLoading={isLoading}
            axis={heatAxis}
            activeSet={data?.active_set}
            nameOf={nameOf}
          />
        )}
      </Panel>

      {/* ── Jobs projection: closed vs target, and whether the pipeline closes
          the gap. Sits right above the Opportunities Set (Kwame 2026-09-29):
          the projection says how short the quarter is, the set below is
          where you work the deals that close it. */}
      <Panel
        title="Jobs Projection"
        desc="Closed against target, and whether the roles in flight close the gap. Click a row for its deals."
        action={
          <div className="flex items-center gap-2">
          <button type="button" onClick={() => setProjPast(!projPast)} aria-pressed={projPast}
            className={cn("h-7 rounded-md border px-2 text-[11.5px] font-medium",
              projPast ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-border-strong text-ink-3 hover:text-ink-2")}>
            {projPast ? "Hide past quarters" : "Show past quarters"}
          </button>
          <div className="flex rounded-md border border-border-strong p-0.5 text-[11.5px]">
            {(["quarter", "month"] as const).map((g) => (
              <button key={g} type="button" onClick={() => setProjGranularity(g)}
                className={cn("rounded px-2 py-0.5 font-medium capitalize",
                  projGranularity === g ? "bg-accent-soft text-accent-ink" : "text-ink-3 hover:text-ink-2")}>
                {g === "quarter" ? "Quarterly" : "Monthly"}
              </button>
            ))}
          </div>
          </div>
        }
      >
        <JobsProjectionChart granularity={projGranularity} showPast={projPast} owner={owner} dealType={dealType} nameOf={nameOf} />
      </Panel>

      {/* ── Opportunities Set (grouped by priority; owner view = the walkthrough) ──
          Sits directly under the heatmap and above Recent Activity (Kwame
          2026-09-21): the heatmap says where deals are piling up, and this is
          the list you work them from. The activity feed is the narrative you
          read afterwards, not the thing you act on. */}
      <Panel title="Opportunities Set">
        {/* Scrolls both ways: the header is sticky within this box, and the
            nine columns keep their width on narrow screens instead of squashing. */}
        <div className="max-h-[520px] overflow-auto">
          <OwnerWalkthrough openOpps={openOpps} needsById={needsById} nextTaskByOpp={nextTaskByOpp}
            nameOf={nameOf} {...rowHandlers} />
        </div>
      </Panel>

      {/* ── Recent activity — the week's narrative ────────────────────── */}
      <Panel
        title="Recent Activity"
        desc={`Added, moved, won or lost between ${rangeLabel} — newest first`}
      >
        <RecentActivity events={orderedActivity} isLoading={isLoading} nameOf={nameOf} />
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

// Opportunities Set columns (Kwame 2026-09-29): who owns it, which account,
// which deal, where it stands, when it should close and how many jobs it
// should yield, then the follow-through (tasks) and the latest word (comment).
// The order is the viewer's to change (Columns menu), remembered per browser:
// e.g. Est. jobs beside Open tasks reads as two counts of the same thing.
// Header and rows build their grid from the same ordered list, so the
// columns always line up.
type OppSetCol = "owner" | "account" | "opportunity" | "stage" | "target_close"
  | "est_jobs" | "tasks" | "comment" | "activity";

const OPP_SET_COLS: { key: OppSetCol; label: string; track: string; right?: boolean; title?: string }[] = [
  { key: "owner",        label: "Owner",          track: "112px" },
  { key: "account",      label: "Account",        track: "minmax(120px,1fr)" },
  { key: "opportunity",  label: "Opportunity",    track: "minmax(120px,1fr)" },
  { key: "stage",        label: "Stage",          track: "138px" },
  { key: "target_close", label: "Target close",   track: "92px" },
  { key: "est_jobs",     label: "Est. jobs",      track: "56px", right: true, title: "Estimated jobs" },
  { key: "tasks",        label: "Open tasks",     track: "minmax(110px,0.9fr)" },
  { key: "comment",      label: "Recent comment", track: "minmax(150px,1.3fr)" },
  { key: "activity",     label: "Activity",       track: "52px", right: true, title: "Last activity" },
];
const OPP_SET_COL_BY_KEY = new Map(OPP_SET_COLS.map((c) => [c.key, c]));
const OPP_SET_DEFAULT_ORDER = OPP_SET_COLS.map((c) => c.key);
const OPP_SET_ORDER_KEY = "bedrock-v2:order:jobs-opp-set";
const OPP_SET_MIN_W = "min-w-[1080px]";

/** Column order, persisted per browser. A stored order missing a column (or
 *  naming one that no longer exists) is repaired, never trusted blindly. */
function useOppSetOrder() {
  const [order, setOrderState] = useState<OppSetCol[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(OPP_SET_ORDER_KEY) ?? "null") as string[] | null;
      if (Array.isArray(raw)) {
        const known = raw.filter((k): k is OppSetCol => OPP_SET_COL_BY_KEY.has(k as OppSetCol));
        return [...new Set([...known, ...OPP_SET_DEFAULT_ORDER])];
      }
    } catch { /* storage blocked or bad JSON: use the default */ }
    return OPP_SET_DEFAULT_ORDER;
  });
  const setOrder = (next: OppSetCol[]) => {
    setOrderState(next);
    try { localStorage.setItem(OPP_SET_ORDER_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  };
  return [order, setOrder] as const;
}

const OppSetOrderContext = createContext<OppSetCol[]>(OPP_SET_DEFAULT_ORDER);

/** 18px for the expand chevron, then the columns in the viewer's order. */
function oppSetGridStyle(order: OppSetCol[]): React.CSSProperties {
  return { gridTemplateColumns: ["18px", ...order.map((k) => OPP_SET_COL_BY_KEY.get(k)!.track)].join(" ") };
}
const OPP_SET_GRID = "grid items-center gap-2";

function OppSetHeader() {
  const order = useContext(OppSetOrderContext);
  return (
    <div style={oppSetGridStyle(order)}
      className={cn(OPP_SET_GRID, "sticky top-0 z-10 border-y border-border-strong bg-surface px-2.5 py-1.5",
        "whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-wider text-ink-3")}>
      <span />
      {order.map((k) => {
        const c = OPP_SET_COL_BY_KEY.get(k)!;
        return <span key={k} className={cn(c.right && "text-right")} title={c.title}>{c.label}</span>;
      })}
    </div>
  );
}

/** Columns menu: move a column up or down the order, or reset it. */
function OppSetColumnsMenu({ order, setOrder }: { order: OppSetCol[]; setOrder: (o: OppSetCol[]) => void }) {
  const [open, setOpen] = useState(false);
  // Fixed to the viewport: the Opportunities Set scrolls inside its panel,
  // which would otherwise clip the menu when the set has only a few rows.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    // Follow the button while the page or the panel scrolls.
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left });
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: r.left });
    setOpen((v) => !v);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  const isDefault = order.join() === OPP_SET_DEFAULT_ORDER.join();
  return (
    <div ref={ref} className="relative">
      <button ref={btnRef} type="button" onClick={toggle} aria-expanded={open}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 hover:text-ink">
        <Columns3 size={12} />Columns
      </button>
      {open && (
        <div style={pos ?? undefined} className="fixed z-50 w-[220px] rounded-md border border-border-strong bg-surface py-1 shadow-lg">
          <div className="px-3 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Column order</div>
          {order.map((k, i) => (
            <div key={k} className="flex items-center justify-between gap-2 px-3 py-1 text-[12px] text-ink hover:bg-surface-2">
              <span>{OPP_SET_COL_BY_KEY.get(k)!.label}</span>
              <span className="flex gap-0.5">
                <button type="button" aria-label={`Move ${OPP_SET_COL_BY_KEY.get(k)!.label} left`} disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className="grid h-5 w-5 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink disabled:opacity-25">
                  <ChevronUp size={12} />
                </button>
                <button type="button" aria-label={`Move ${OPP_SET_COL_BY_KEY.get(k)!.label} right`} disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                  className="grid h-5 w-5 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink disabled:opacity-25">
                  <ChevronDown size={12} />
                </button>
              </span>
            </div>
          ))}
          <div className="mt-1 border-t border-border px-3 pt-1">
            <button type="button" disabled={isDefault} onClick={() => setOrder(OPP_SET_DEFAULT_ORDER)}
              className="text-[11.5px] text-ink-3 hover:text-ink disabled:opacity-40">Reset to default</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ManagedOppRow({ o, nameOf, detail, right, nextTask, expandedId, setExpandedId, onRecordPlacements, onClosedLost, onCommittedRoles }: {
  o: JobsOpportunity;
  nameOf: (e: string | null) => string;
  detail?: React.ReactNode;
  right?: React.ReactNode;
  nextTask?: { title: string; deadline: string | null };
} & RowHandlers) {
  const updateOpp = useUpdateOpportunity();
  const expanded = expandedId === o.id;
  // Gated on what the database accepts: Reviewing Builders is rejected
  // until the 2026-08-05 migration lands, so it shows disabled here
  // rather than failing the save.
  const oppStageOptions = useOppStageOptions(o.stage);
  const overdue = !!o.target_close_date && !o.stage.startsWith("closed")
    // Local calendar date: toISOString() is UTC, which flagged a deal due
    // today as late from 8pm in New York.
    && o.target_close_date.slice(0, 10) < format(new Date(), "yyyy-MM-dd");
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
  const order = useContext(OppSetOrderContext);
  const cells: Record<OppSetCol, React.ReactNode> = {
    owner: (
      <span className="flex min-w-0 items-center">
          
          <span className={cn("truncate text-[12px]", o.owner_email ? "font-medium text-ink-2" : "italic text-ink-4")}>
            {o.owner_email ? nameOf(o.owner_email) : "Unassigned"}
          </span>
        </span>
    ),
    account: (
      <Link to={`/jobs/opportunities/${o.id}`} onClick={(e) => e.stopPropagation()}
          className="truncate text-[13px] font-semibold text-ink hover:text-accent" title={o.account_name}>
          {o.account_name}
        </Link>
    ),
    opportunity: (
      <span className="min-w-0">
          <span className={cn("block truncate text-[12px]", o.title ? "text-ink-2" : "text-ink-4")} title={o.title ?? undefined}>
            {o.title || "—"}
          </span>
          {detail && <span className="block truncate text-[11px] text-ink-3">{detail}</span>}
        </span>
    ),
    stage: (
      <span onClick={(e) => e.stopPropagation()}>
          <InlineSelect<JobStage>
            value={o.stage}
            options={oppStageOptions}
            onSave={saveStage}
            renderValue={(v) => (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">{v ? STAGE_LABELS[v] : "—"}</span>
            )}
          />
        </span>
    ),
    target_close: (
      <span onClick={(e) => e.stopPropagation()} title={overdue ? "Target close date has passed" : undefined}>
          <InlineDate value={o.target_close_date} variant="short" placeholder="Set date"
            className={cn("text-[12px]", overdue && "font-semibold text-[var(--red)]")}
            onSave={(v) => v
              ? updateOpp.mutateAsync({ id: o.id, target_close_date: v }).then(() => undefined)
              : Promise.reject(new Error("Target close date is required"))} />
        </span>
    ),
    est_jobs: (
      <span onClick={(e) => e.stopPropagation()} className="text-right tabular-nums">
          <InlineText value={o.estimated_jobs != null ? String(o.estimated_jobs) : null} placeholder="—"
            className="justify-end text-right text-[12px]"
            onSave={(v) => {
              const n = parseEstimatedJobs(v);
              return n === undefined
                ? Promise.reject(new Error("Whole number, 0–999"))
                : updateOpp.mutateAsync({ id: o.id, estimated_jobs: n }).then(() => undefined);
            }} />
        </span>
    ),
    tasks: (
      <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
          {(o.open_tasks ?? 0) > 0 ? (
            <>
              <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[10.5px] font-semibold tabular-nums text-ink-2">{o.open_tasks}</span>
              {nextTask && (
                <span className="truncate text-ink-3" title={nextTask.title}>
                  {nextTask.title}{nextTask.deadline ? ` · ${nextTask.deadline.slice(5)}` : ""}
                </span>
              )}
            </>
          ) : <span className="text-ink-4">—</span>}
        </span>
    ),
    comment: (
      <span className="min-w-0 text-[11.5px]"
          title={o.last_comment ? `${o.last_comment}\n— ${nameOf(o.last_comment_by ?? null)}` : undefined}>
          {o.last_comment ? (
            <>
              <span className="block truncate text-ink-2">{o.last_comment}</span>
              <span className="block truncate text-[10.5px] text-ink-4">
                {nameOf(o.last_comment_by ?? null)} · {relDay(o.last_comment_at ?? null) ?? ""}
                {(o.comment_count ?? 0) > 1 ? ` · ${o.comment_count} comments` : ""}
              </span>
            </>
          ) : <span className="text-ink-4">—</span>}
        </span>
    ),
    activity: (
      <span className="text-right text-[11.5px] tabular-nums text-ink-4"
          title={o.last_activity_at ? `Last activity ${new Date(o.last_activity_at).toLocaleDateString()}` : "No activity"}>
          {right ?? (relDay(o.last_activity_at) ?? "—")}
        </span>
    ),
  };
  return (
    <>
      <div
        onClick={() => setExpandedId((p) => (p === o.id ? null : o.id))}
        style={oppSetGridStyle(order)}
        className={cn(OPP_SET_GRID, "cursor-pointer border-t border-border-strong px-2.5 py-2 hover:bg-surface-2/40",
          expanded && "bg-surface-2/40")}
      >
        <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
        {order.map((k) => <Fragment key={k}>{cells[k]}</Fragment>)}
      </div>
      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/20">
          <DealExpandPanel deal={o} />
        </div>
      )}
    </>
  );
}

// ── Opportunities Set filters ───────────────────────────────────────────────
// One declarative spec drives the whole control: each field maps an
// opportunity to the bucket label it belongs in, so categorical fields (deal
// type, stage) and continuous ones (salary, last activity) filter through the
// same path and the value list is always derived from what's actually in the
// set — no dropdown option that matches zero rows. Adding a field here is the
// only edit needed to make it filterable; the columns stay as they are.

type OppFilterField = {
  key: string;
  label: string;
  /** The bucket this opportunity falls in, or null to exclude it from the field. */
  bucket: (o: JobsOpportunity) => string | null;
  /** Fixed display order; anything unlisted sorts alphabetically after these. */
  order?: string[];
};

const DAYS_SINCE = (iso: string | null | undefined) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

const ACTIVITY_ORDER_LABELS = ["Last 7 days", "8–30 days", "31–90 days", "Over 90 days", "No activity"];
const SALARY_ORDER_LABELS = ["Under $80k", "$80k–100k", "$100k–120k", "$120k+", "Not set"];

const OPP_FILTER_FIELDS: OppFilterField[] = [
  { key: "deal_type", label: "Deal type",
    bucket: (o) => (o.deal_type ? DEAL_TYPE_LABELS[o.deal_type] ?? o.deal_type : "Untagged") },
  { key: "stage", label: "Stage",
    bucket: (o) => STAGE_LABELS[o.stage] ?? o.stage },
  { key: "segment", label: "Segment",
    bucket: (o) => o.segment || "Not set" },
  { key: "priority", label: "Priority", order: ["P1", "P2", "P3+", "Not set"],
    bucket: (o) => {
      const p = displayPriority(o.priority);
      return p == null ? "Not set" : p === 1 ? "P1" : p === 2 ? "P2" : "P3+";
    } },
  { key: "owner", label: "Owner",
    // Lowercased to match the rest of the page — one staff record is
    // "joanna@Pursuit.org", which would otherwise bucket separately.
    bucket: (o) => (o.owner_email || "(unassigned)").toLowerCase() },
  { key: "activity", label: "Last activity", order: ACTIVITY_ORDER_LABELS,
    bucket: (o) => {
      const d = DAYS_SINCE(o.last_activity_at);
      if (d == null) return "No activity";
      return d <= 7 ? "Last 7 days" : d <= 30 ? "8–30 days" : d <= 90 ? "31–90 days" : "Over 90 days";
    } },
  { key: "salary", label: "Salary", order: SALARY_ORDER_LABELS,
    bucket: (o) => {
      const v = o.salary_expected;
      if (v == null) return "Not set";
      return v < 80_000 ? "Under $80k" : v < 100_000 ? "$80k–100k" : v < 120_000 ? "$100k–120k" : "$120k+";
    } },
  { key: "likelihood", label: "Likelihood", order: ["High", "Medium", "Low", "Not set"],
    bucket: (o) => (o.likelihood ? o.likelihood[0].toUpperCase() + o.likelihood.slice(1) : "Not set") },
  { key: "open_tasks", label: "Open tasks", order: ["Has open tasks", "None open"],
    bucket: (o) => ((o.open_tasks ?? 0) > 0 ? "Has open tasks" : "None open") },
  { key: "roles", label: "Roles", order: ["Has roles", "No roles"],
    bucket: (o) => ((o.num_roles ?? 0) > 0 ? "Has roles" : "No roles") },
  { key: "source", label: "Source",
    bucket: (o) => o.source || "Not set" },
];

const FILTER_BY_KEY = new Map(OPP_FILTER_FIELDS.map((f) => [f.key, f]));

/** Distinct buckets present in `opps`, counted, in the field's declared order. */
function filterOptions(field: OppFilterField, opps: JobsOpportunity[]) {
  const counts = new Map<string, number>();
  for (const o of opps) {
    const b = field.bucket(o);
    if (b != null) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const rank = (v: string) => {
    const i = field.order?.indexOf(v) ?? -1;
    return i === -1 ? field.order?.length ?? 0 : i;
  };
  return [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

function OppSetFilters({ filters, setFilters, opps, nameOf }: {
  filters: Record<string, string>;
  setFilters: (f: Record<string, string>) => void;
  /** Pre-filter set, so each value list shows what's available to select. */
  opps: JobsOpportunity[];
  nameOf: (e: string | null) => string;
}) {
  const active = Object.keys(filters).filter((k) => FILTER_BY_KEY.has(k));
  const unused = OPP_FILTER_FIELDS.filter((f) => !(f.key in filters));
  const show = (fieldKey: string, v: string) =>
    fieldKey === "owner" && v !== "(unassigned)" ? nameOf(v) : v;

  return (
    <>
      {active.map((key) => {
        const field = FILTER_BY_KEY.get(key)!;
        // Options come from the set with THIS field's own filter lifted, so
        // narrowing one field never empties its own dropdown.
        const others = Object.entries(filters).filter(([k]) => k !== key);
        const pool = opps.filter((o) => others.every(([k, v]) => FILTER_BY_KEY.get(k)?.bucket(o) === v));
        return (
          <span key={key}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/40 bg-accent-soft pl-2 pr-1 text-[11.5px]">
            <span className="font-semibold text-accent">{field.label}</span>
            <select value={filters[key]}
              onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
              className="h-6 max-w-[136px] rounded border-none bg-transparent text-[11.5px] text-accent outline-none">
              {filterOptions(field, pool).map((o) => (
                <option key={o.value} value={o.value}>{show(key, o.value)} ({o.count})</option>
              ))}
            </select>
            <button type="button" title={`Remove the ${field.label} filter`}
              onClick={() => { const next = { ...filters }; delete next[key]; setFilters(next); }}
              className="grid h-4 w-4 place-items-center rounded text-accent/70 hover:bg-accent/10 hover:text-accent">
              <X size={11} />
            </button>
          </span>
        );
      })}

      {unused.length > 0 && (
        <select value="" title="Filter the set by any field"
          onChange={(e) => {
            const field = FILTER_BY_KEY.get(e.target.value);
            if (!field) return;
            // Seed with the field's first bucket. Every option is derived from
            // the set, so whichever one lands is guaranteed non-empty — picking
            // a filter should never blank the table.
            const first = filterOptions(field, opps)[0];
            if (first) setFilters({ ...filters, [field.key]: first.value });
          }}
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
          <option value="">{active.length ? "+ Filter" : "Filter by…"}</option>
          {unused.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      )}

      {active.length > 1 && (
        <button type="button" onClick={() => setFilters({})}
          className="h-7 rounded-md px-1.5 text-[11.5px] font-medium text-ink-3 hover:text-ink">
          Clear all
        </button>
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
  // Field → selected bucket. Every field in OPP_FILTER_FIELDS is filterable
  // without being a column: the ask was to slice the set, not widen the table.
  const [filters, setFilters] = useSessionState<Record<string, string>>("jobsPipeline.details.filters", {});
  const [colOrder, setColOrder] = useOppSetOrder();

  const owners = useMemo(() => [...new Set(openOpps.map((o) => (o.owner_email ?? "").toLowerCase()))]
    .filter(Boolean).sort(), [openOpps]);
  const filterEntries = useMemo(
    () => Object.entries(filters).filter(([k]) => FILTER_BY_KEY.has(k))
      // The untagged deal-type bucket was renamed "Not set" -> "Untagged"
      // (2026-09-29); a filter saved in this tab before that still applies.
      .map(([k, v]): [string, string] => (k === "deal_type" && v === "Not set" ? [k, "Untagged"] : [k, v])),
    [filters]);
  const visible = useMemo(() => openOpps.filter((o) =>
    (!ownerFilter || (o.owner_email ?? "").toLowerCase() === ownerFilter) &&
    (!flaggedOnly || needsById.has(o.id)) &&
    filterEntries.every(([k, v]) => FILTER_BY_KEY.get(k)!.bucket(o) === v)),
    [openOpps, ownerFilter, flaggedOnly, needsById, filterEntries]);

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
      <OppSetFilters filters={filters} setFilters={setFilters} opps={openOpps} nameOf={nameOf} />
      <OppSetColumnsMenu order={colOrder} setOrder={setColOrder} />
      <button type="button" onClick={() => setFlaggedOnly(!flaggedOnly)}
        className={cn("h-7 rounded-md border px-2 text-[11.5px] font-medium",
          flaggedOnly ? "border-[var(--amber)]/40 bg-[var(--amber-soft)] text-[var(--amber)]"
                      : "border-border-strong bg-surface text-ink-3 hover:text-ink-2")}>
        Needs attention only
      </button>
      <span className="text-[11.5px] text-ink-4">
        {visible.length} shown{visible.length !== openOpps.length ? ` of ${openOpps.length}` : ""}
      </span>
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
      <OppSetOrderContext.Provider value={colOrder}>
      <div className={cn("flex flex-col", OPP_SET_MIN_W)}>
        {controls}
        <OppSetHeader />
        {bands.map((b) => (
          <div key={b.label}>
            {b.label && <div className={cn("px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", b.cls)}>{b.label} · {b.rows.length}</div>}
            {b.rows.map((o) => (
              <ManagedOppRow key={o.id} o={o} nameOf={nameOf} {...flagged(o)}
                nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
            ))}
          </div>
        ))}
        {visible.length === 0 && (
          <div className="border-t border-border-strong px-2.5 py-3 text-[12px] text-ink-4">Nothing matches the filters.</div>
        )}
      </div>
      </OppSetOrderContext.Provider>
    );
  }


  if (groups.length === 0) {
    return <div className="flex flex-col">{controls}
      <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[12px] text-ink-4">Nothing matches the filters.</div>
    </div>;
  }
  return (
    <OppSetOrderContext.Provider value={colOrder}>
    <div className={cn("flex flex-col", OPP_SET_MIN_W)}>
      {controls}
      <OppSetHeader />
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
              <ManagedOppRow key={o.id} o={o} nameOf={nameOf} {...flaggedRow(o)}
                nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
            ))}
            {p2.length > 0 && (
              <div className="bg-[var(--sky-soft)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--sky)]">P2</div>
            )}
            {p2.map((o) => (
              <ManagedOppRow key={o.id} o={o} nameOf={nameOf} {...flaggedRow(o)}
                nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
            ))}
            {stalled.length > 0 && (
              <div className="bg-[var(--amber-soft)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--amber)]">Stalled — needs unblock</div>
            )}
            {stalled.map((o) => (
              <ManagedOppRow key={o.id} o={o} nameOf={nameOf} {...flaggedRow(o)}
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
                  <ManagedOppRow key={o.id} o={o} nameOf={nameOf} {...flaggedRow(o)}
                    nextTask={nextTaskByOpp.get(o.id)} {...handlers} />
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
    </OppSetOrderContext.Provider>
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
        {/* No "this week" fallback: it was a lie under any preset but Weekly,
            and the period row above already states the window. */}
        {sub ? <div className="text-[10.5px] text-ink-4">{sub}</div> : null}
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
  title, desc, action, badge, className, children,
}: {
  title: string; desc?: string; action?: React.ReactNode; badge?: string;
  /** For a panel that has to fill its grid row — pass "h-full". */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border border-border-strong bg-surface px-5 py-4", className)}>
      {/* flex-wrap: when the title block and the controls don't fit on one
          line, the controls drop to their own line, right-aligned. The title
          block used to be shrink-0, which kept a long `desc` on one line and
          pushed the controls past the card's right edge, under the panel
          beside it (Outreach Trends' Data points buttons, ~100px at laptop
          widths). Only the title itself refuses to wrap now; `desc` may. */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="whitespace-nowrap text-[14px] font-semibold text-ink">{title}</h3>
            {badge ? (
              <span className="rounded-full bg-[var(--red-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--red)]">{badge}</span>
            ) : null}
          </div>
          {desc ? <p className="mt-0.5 text-[11.5px] text-ink-4">{desc}</p> : null}
        </div>
        {action ? <div className="ml-auto">{action}</div> : null}
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

/** Owner bars read as a person, not a mailbox: "Avni Nahar", not "avni".
 *  Abbreviated to "Damon K." past 16 characters, which is where the full name
 *  starts truncating in the 128px label column. */
function ownerLabel(key: string, nameOf?: (e: string | null) => string): string {
  const full = nameOf ? nameOf(key) : titleCaseEmail(key);
  if (full.length <= 16) return full;
  const parts = full.split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : full;
}

function breakdownLabel(dim: OppBreakdownDim, key: string, label: string,
                        nameOf?: (e: string | null) => string): string {
  if (dim === "deal_type") return key === "(unset)" ? "Untagged" : DEAL_TYPE_LABELS[key as DealType] ?? label;
  if (dim === "owner") return ownerLabel(key, nameOf);
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
            <div className="truncate text-[12.5px] font-medium text-ink" title={breakdownLabel(dim, it.key, it.label, nameOf)}>
              {breakdownLabel(dim, it.key, it.label, nameOf)}
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.round((100 * it.count) / max)}%`, background: "linear-gradient(90deg,#6d5efc,#8b7dff)" }} />
            </div>
            <div className="text-right text-[12px] tabular-nums text-ink-2">
              {canDrill && it.count > 0 ? (
                <button type="button" onClick={() => setOpen(open === it.key ? null : it.key)}
                  title={`Show the ${it.count} opportunities in ${breakdownLabel(dim, it.key, it.label, nameOf)}`}
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
            <OppMiniDrill label={breakdownLabel(dim, it.key, it.label, nameOf)} nameOf={nameOf}
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
  // Priority rows are keyed by display priority ("P1" = highest) but the member
  // carries the stored value (5 = highest).
  const rowMatches = (m: OppActiveSetMember, rowKey: string) =>
    axis === "stage" ? m.stage === rowKey : `P${displayPriority(m.priority) ?? ""}` === rowKey;

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

/** The week's narrative opens at five rows — enough to read the shape of the
 *  week without the panel dominating the scroll. */
const RECENT_ACTIVITY_PAGE = 5;

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
  const shown = showAll ? events : events.slice(0, RECENT_ACTIVITY_PAGE);
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
      {events.length > RECENT_ACTIVITY_PAGE ? (
        <button type="button" onClick={() => setShowAll((v) => !v)}
          className="mt-2 self-start text-[12px] font-medium text-accent hover:underline">
          {showAll ? "Show less" : `Show ${events.length - RECENT_ACTIVITY_PAGE} more`}
        </button>
      ) : null}
    </div>
  );
}
