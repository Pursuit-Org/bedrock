/**
 * Jobs · Opportunities — Weekly Overview.
 *
 * High-level, read-only view of the employer-deal pipeline for the Thursday
 * pipeline meeting: summary cards, time-in-stage aging, a switchable breakdown
 * (status / deal type / segment / stage / owner), the Priority×Time and
 * Stage×Time concentration heatmaps, and the needs-attention list.
 *
 * "Time in pipeline" = time in the CURRENT stage (from jobs_stage_history).
 * Backed by /api/jobs/opportunities/overview. Priority×Time renders an empty
 * state until opps carry a priority — it lights up as the team populates it.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { addDays, format } from "date-fns";
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, Clock, Minus, Plus, TrendingDown, TrendingUp, Trophy, XCircle } from "lucide-react";

import {
  useOpportunitiesOverview,
  useJobsStaff,
  DEAL_TYPE_LABELS,
  type DealType,
  type OppBreakdownDim,
  type OppHeatmap,
  type OppNeedsRow,
  type OppActivityEvent,
} from "@/services/jobs";
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
/** The Saturday that CLOSES the week containing `d` (i.e. the upcoming Saturday).
 *  weekEnd is the closing boundary, so the current in-progress week is selectable. */
function weekEndFor(d: Date): Date {
  return addDays(mostRecentSaturday(d), 7);
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
  const weekStart = addDays(weekEnd, -7);

  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (staffQ.data ?? []).forEach((st) => m.set(st.email, st.name));
    return (email: string | null) => (email ? m.get(email) ?? titleCaseEmail(email) : "—");
  }, [staffQ.data]);
  const { data, isLoading } = useOpportunitiesOverview(owner, dealType, fmtDateInput(weekEnd));

  const s = data?.summary;
  const netDelta = s ? s.net_new - s.net_new_prev : 0;

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
          <input
            type="date"
            value={fmtDateInput(weekEnd)}
            max={fmtDateInput(maxWeekEnd)}
            onChange={(e) => { if (e.target.value) setWeekEnd(weekEndFor(new Date(`${e.target.value}T00:00:00`))); }}
            className="ml-1 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] text-ink outline-none focus:border-accent"
            title="Jump to the week containing a date"
          />
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
      <div className="grid grid-cols-2 items-stretch gap-4 lg:grid-cols-4">
        <SummaryCard tone="ink" label="In the set" value={s?.in_set} isLoading={isLoading}
          sub="All active opportunities" />
        <SummaryCard tone="accent" label="Net new" value={s?.net_new} isLoading={isLoading}
          delta={s ? { n: netDelta, prev: s.net_new_prev } : undefined} />
        <SummaryCard tone="amber" label="Stalled" value={s?.stalled_6wk} isLoading={isLoading}
          sub="Open opportunity 6+ weeks" />
        {/* 4th cell: two stacked outcome boxes for the week — Closed won (the goal,
            subtly highlighted) over Closed lost (context to understand, not a red flag). */}
        <div className="flex flex-col gap-4">
          <OutcomeBox tone="green" highlight label="Closed won" value={s?.moved_committed} isLoading={isLoading} />
          <OutcomeBox tone="ink" label="Closed lost" value={s?.closed_lost} isLoading={isLoading} />
        </div>
      </div>

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

      {/* ── Heatmaps ──────────────────────────────────────────────────── */}
      <Panel title="Priority × Time in Pipeline">
        {data && !data.heatmaps.priority.populated ? (
          <div className="rounded-lg border border-dashed border-border-strong bg-surface-2/40 px-4 py-6 text-center text-[12.5px] text-ink-3">
            No priority set on any of the {data.heatmaps.priority.unset} active opps yet.
            <div className="mt-1 text-[11.5px] text-ink-4">
              This heatmap lights up automatically as the team sets priority on opportunities.
            </div>
          </div>
        ) : (
          <Heatmap heatmap={data?.heatmaps.priority} buckets={data?.heatmaps.buckets ?? []} rowHeader="Priority" isLoading={isLoading} />
        )}
      </Panel>

      <Panel
        title="Stage × Time in Pipeline"
        desc="Real concentration today — where deals sit vs. how long they've been there"
      >
        <Heatmap heatmap={data?.heatmaps.stage} buckets={data?.heatmaps.buckets ?? []} rowHeader="Stage" isLoading={isLoading} />
      </Panel>

      {/* ── Recent activity ───────────────────────────────────────────── */}
      <Panel
        title="Recent activity"
        desc="Added, moved, won/lost, or stalled this week — newest first"
      >
        <RecentActivity events={data?.recent_activity ?? []} isLoading={isLoading} nameOf={nameOf} />
      </Panel>

      {/* ── Needs attention ───────────────────────────────────────────── */}
      <Panel
        title="Needs attention this week"
        desc="3+ weeks in the current stage, or gone quiet — pre-loaded for the meeting"
        badge={data ? `${data.needs_attention.length}` : undefined}
      >
        <NeedsTable rows={data?.needs_attention ?? []} isLoading={isLoading} nameOf={nameOf} />
      </Panel>
    </div>
  );
}

// ── Summary card ────────────────────────────────────────────────────────────

const TONE: Record<string, string> = {
  ink: "text-ink", accent: "text-[var(--accent)]", sky: "text-[var(--sky)]",
  green: "text-[var(--green)]", amber: "text-[var(--amber)]",
};

function SummaryCard({
  tone, label, value, sub, delta, isLoading,
}: {
  tone: keyof typeof TONE | string;
  label: string;
  value: number | undefined;
  sub?: string;
  delta?: { n: number; prev: number };
  isLoading: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border-strong bg-surface px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
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
  tone, label, value, highlight, isLoading,
}: {
  tone: keyof typeof TONE | string;
  label: string;
  value: number | undefined;
  highlight?: boolean;
  isLoading: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-between rounded-xl border border-border-strong px-4 py-2.5",
        highlight ? "bg-[var(--green-soft)]" : "bg-surface",
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

// ── Heatmap ───────────────────────────────────────────────────────────────────

// Colour encodes VOLUME only — a blue that deepens with the count in the cell.
// No concern-shading or flags; the gradient is the only signal.
function heatBlue(n: number, max: number): { background: string; color: string } {
  if (n <= 0) return { background: "var(--surface-2)", color: "var(--ink-4)" };
  const t = max > 0 ? n / max : 0;
  const alpha = 0.16 + 0.84 * t; // light → deep blue as volume grows
  return {
    background: `rgba(47, 127, 224, ${alpha.toFixed(2)})`, // --sky base (#2F7FE0)
    color: alpha > 0.5 ? "#ffffff" : "var(--ink)",
  };
}

function Heatmap({
  heatmap, buckets, rowHeader, isLoading,
}: {
  heatmap: OppHeatmap | undefined;
  buckets: { key: string; label: string }[];
  rowHeader: string;
  isLoading: boolean;
}) {
  if (isLoading) return <div className="h-40 animate-pulse rounded-lg bg-surface-2" />;
  if (!heatmap || heatmap.rows.length === 0) {
    return <div className="py-6 text-center text-[12px] text-ink-4">No opportunities to chart.</div>;
  }
  const max = Math.max(1, ...heatmap.rows.flatMap((r) => r.cells));
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
                return (
                  <td key={i} className="p-1">
                    <div
                      className="flex h-11 items-center justify-center rounded-lg text-[14px] font-bold"
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
      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-ink-4">
        <span className="h-2.5 w-8 rounded-sm" style={{ background: "linear-gradient(90deg, rgba(47,127,224,0.16), rgba(47,127,224,1))" }} />
        fewer → more opportunities
      </div>
    </div>
  );
}

// ── Needs-attention table ─────────────────────────────────────────────────────

function NeedsTable({ rows, isLoading, nameOf }: { rows: OppNeedsRow[]; isLoading: boolean; nameOf: (e: string | null) => string }) {
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="h-32 animate-pulse rounded-lg bg-surface-2" />;
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-8 text-[12px] text-ink-4">
        <Clock size={14} /> Nothing flagged — the board is moving.
      </div>
    );
  }
  const shown = showAll ? rows : rows.slice(0, 5);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border-strong">
            {["Account", "Owner", "Stage", "In stage", "Why it's flagged"].map((h) => (
              <th key={h} className="px-2.5 pb-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.opportunity_id} className="border-b border-border-strong last:border-b-0">
              <td className="px-2.5 py-2.5 font-semibold text-ink">
                <Link to={`/jobs/opportunities/${r.opportunity_id}`} className="hover:text-accent">
                  {r.account || "—"}
                </Link>
              </td>
              <td className="px-2.5 py-2.5 text-ink-2">{nameOf(r.owner)}</td>
              <td className="px-2.5 py-2.5">
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">{r.stage_label}</span>
              </td>
              <td className="px-2.5 py-2.5 tabular-nums text-ink-2">{r.days_in_stage}d</td>
              <td className="px-2.5 py-2.5">
                <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
                  <AlertTriangle size={12} className="flex-shrink-0 text-[var(--amber)]" />
                  {r.why}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 5 ? (
        <button type="button" onClick={() => setShowAll((v) => !v)}
          className="mt-2 text-[12px] font-medium text-accent hover:underline">
          {showAll ? "Show less" : `Show ${rows.length - 5} more`}
        </button>
      ) : null}
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
