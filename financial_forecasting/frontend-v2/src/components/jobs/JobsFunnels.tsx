import { useState } from "react";
import { ChevronRight, ChevronDown, ArrowUp, ArrowDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import {
  useJobsFunnel,
  DEAL_TYPE_LABELS,
  type DealType,
  type FunnelType,
  type FunnelStage,
  type FunnelPeriod,
  type FunnelMovement,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

// ── Funnel-type config ─────────────────────────────────────────────────────

// Contacts first: it's the top of the funnel, so it's where the walkthrough
// starts. The deal-type lens is bound to the Opportunities tab (a contact has
// no deal type), so it appears only once Opportunities is selected rather than
// sitting inert next to Contacts.
const FUNNEL_TABS: { type: FunnelType; label: string }[] = [
  { type: "prospects", label: "Contacts" },
  { type: "opportunities", label: "Opportunities" },
  { type: "builders", label: "Builders" },
];

const FUNNEL_TITLE: Record<FunnelType, string> = {
  opportunities: "Opportunities",
  prospects: "Contacts",
  builders: "Builders",
};

const FUNNEL_SUBTITLE: Record<FunnelType, string> = {
  opportunities: "Employer deals by stage · transitions in the last 30d",
  prospects: "Jobs-pipeline contacts by stage",
  builders: "Builder applications by stage",
};

const FUNNEL_NOUN: Record<FunnelType, string> = {
  opportunities: "companies",
  prospects: "contacts",
  builders: "builders",
};

// Final/won stage keys per funnel — these render green.
const WON_STAGE_KEYS = new Set(["closed_won", "accepted"]);
// Lost/parked terminals. Rendering these in the same purple as the active
// stages made a funnel of losses look like a funnel of progress.
const LOST_STAGE_KEYS = new Set(["closed_lost", "revisit", "not_a_fit", "on_hold"]);

const RECORD_CAP = 60;

// ── Number-column geometry ──────────────────────────────────────────────────
// The header and every stage row read these same widths. They used to be typed
// out twice with different gaps: the header laid out four cells with no gaps
// (312px) inside a 320px block, orphaning 8px on the right, while each row laid
// out five children with gap-2 (344px). Both blocks are right-aligned, so the
// counts landed 24px left of "#" and the pt-deltas 8px right of "Trend".
// Grouping the cells in both places — and letting only ONE gap exist, between
// the two groups — makes the two rows structurally identical.
const COL_COUNT = "w-[64px]";
const COL_TREND = "w-[88px]";
const COL_PCT = "w-[72px]";
/** Each group is exactly the sum of its columns: 64+88 and 72+88. */
const GROUP_VOLUME = "w-[152px]";
const GROUP_CONVERSION = "w-[160px]";


// ── Component ───────────────────────────────────────────────────────────────

const DEAL_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  ...(Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]).map(
    ([value, label]) => ({ value, label }),
  ),
];

export function JobsFunnels({ builderSegment, only, period, periodLabel, dealType: dealTypeProp }: {
  builderSegment?: string;
  only?: FunnelType;
  /** Pass a window to get period-flow counts (records that ENTERED each stage).
   *  Omit it for the all-time snapshot — the Exec view has no period control. */
  period?: FunnelPeriod;
  periodLabel?: string;
  /** Let the host page own the deal-type lens. When set, the funnel's own pill
   *  row is hidden — otherwise the Pipeline page shows two deal-type controls
   *  that can disagree with each other. */
  dealType?: string;
} = {}) {
  const [funnel, setFunnel] = useState<FunnelType>(only ?? FUNNEL_TABS[0].type);
  // Deal-type lens. Defaults to ALL: defaulting to Full-Time silently scoped the
  // Contacts funnel to people at companies that happen to hold an FT
  // opportunity, so "Assigned" read 18 when 267 contacts are assigned.
  const [dealTypeOwn, setDealTypeOwn] = useState<string>("all");
  const controlled = dealTypeProp != null;
  const dealType = controlled ? dealTypeProp : dealTypeOwn;
  const setDealType = setDealTypeOwn;
  // The builders funnel is the L3+ job-ready pool — scope it by the dashboard's
  // L3-cohort segment instead of deal type.
  const { data, isLoading, isError, error, refetch } = useJobsFunnel(
    funnel,
    funnel === "builders" ? undefined : dealType,
    funnel === "builders" ? builderSegment : undefined,
    period,
  );
  const isPeriod = data?.mode === "period";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Funnel-type switcher — bubbly pill toggle. Hidden when the page
            pinned a single funnel (`only`). */}
        <div className={cn("inline-flex w-fit rounded-full border border-border-strong bg-surface-2 p-1", only && "hidden")}>
          {FUNNEL_TABS.map((tab) => {
            const active = tab.type === funnel;
            return (
              <button
                key={tab.type}
                type="button"
                onClick={() => setFunnel(tab.type)}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-all duration-200",
                  active
                    ? "text-white shadow-sm"
                    : "text-ink-3 hover:text-ink-2",
                )}
                style={
                  active
                    ? { background: "linear-gradient(135deg, #6d5efc 0%, #8b7dff 100%)" }
                    : undefined
                }
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Deal-type lens. Hidden on Contacts (a contact has no deal type — it
            was silently scoping to people at companies with an FT opp) and on the
            Builders
            funnel: that funnel is the L3+ pool scoped by cohort segment, and
            the lens never applied to it — showing selected-but-inert pills
            read as "PT shows full-time hires too" (TKT-129). */}
        {funnel !== "builders" && funnel !== "prospects" && !controlled && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Deal type</span>
          <div className="inline-flex flex-wrap rounded-full border border-border-strong bg-surface-2 p-0.5">
            {DEAL_TYPE_FILTERS.map((d) => {
              const active = d.value === dealType;
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => setDealType(d.value)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    active ? "bg-[var(--accent)] text-white shadow-sm" : "text-ink-3 hover:text-ink-2",
                  )}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
        )}
      </div>

      {/* Funnel card */}
      <FunnelCard
        funnel={funnel}
        stages={data?.stages ?? []}
        recordColumns={data?.record_columns ?? []}
        isLoading={isLoading}
        isPeriod={isPeriod}
        periodLabel={periodLabel}
        lastMovementAt={data?.last_movement_at ?? null}
        isError={isError}
        errorText={(error as { message?: string } | null)?.message ?? null}
        onRetry={() => refetch()}
      />

    </div>
  );
}

// ── Trend cells ─────────────────────────────────────────────────────────────

/** Relative change in a volume, vs the prior window of equal length. */
function PctTrend({ current, prior, noun }: { current: number; prior: number | null; noun: string }) {
  if (prior == null) return <span className="text-ink-4" title="No prior period to compare">—</span>;
  if (prior === 0) {
    // Growth from nothing has no meaningful percentage — say "new" instead of ∞.
    return current > 0
      ? <span className="font-semibold text-[var(--green)]" title={`${current} ${noun} vs none last period`}>new</span>
      : <span className="text-ink-4" title="None either period">—</span>;
  }
  const v = (100 * (current - prior)) / prior;
  const up = v >= 0;
  return (
    <span className={cn("font-semibold tabular-nums whitespace-nowrap", up ? "text-[var(--green)]" : "text-red")}
      title={`${current} vs ${prior} in the prior period`}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(v))}%
    </span>
  );
}

/** Percentage-POINT change in a rate — a conversion going 40%→50% is +10pt,
 *  not +25%, and conflating the two is how conversion trends get misread. */
function PtTrend({ current, prior }: { current: number | null; prior: number | null }) {
  if (current == null || prior == null)
    return <span className="text-ink-4" title="No prior period to compare">—</span>;
  const v = current - prior;
  if (v === 0) return <span className="text-ink-4" title="Unchanged">0pt</span>;
  const up = v > 0;
  return (
    <span className={cn("font-semibold tabular-nums whitespace-nowrap", up ? "text-[var(--green)]" : "text-red")}
      title={`${current}% this period vs ${prior}% in the prior period`}>
      {up ? "▲" : "▼"} {Math.abs(v)}pt
    </span>
  );
}

// ── Funnel card ───────────────────────────────────────────────────────────

function FunnelCard({
  funnel,
  stages,
  recordColumns,
  isLoading,
  isPeriod,
  periodLabel,
  lastMovementAt,
  isError,
  errorText,
  onRetry,
}: {
  funnel: FunnelType;
  stages: FunnelStage[];
  recordColumns: { key: string; label: string }[];
  isLoading: boolean;
  isPeriod: boolean;
  periodLabel?: string;
  lastMovementAt: string | null;
  isError: boolean;
  errorText: string | null;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const subtitle = isPeriod
    ? `${FUNNEL_NOUN[funnel]} that entered each stage${periodLabel ? ` · ${periodLabel}` : ""}`
    : FUNNEL_SUBTITLE[funnel];
  // An all-zero period is the normal state early in a week, and four empty bars
  // read as a broken render — say so in words instead.
  const allZero = stages.length > 0 && stages.every((s) => s.count === 0);

  return (
    <section
      className="overflow-hidden rounded-2xl border border-white/60 shadow-[0_1px_2px_rgba(20,18,14,0.04),0_8px_24px_-16px_rgba(20,18,14,0.3)]"
      style={{ background: "var(--surface)" }}
    >
      {/* Header bar — soft gradient band. Clicking it collapses the stage rows,
          so a week with no movement can be folded away. */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? "Show the stages" : "Hide the stages"}
        className="flex w-full items-center gap-2 border-b border-border-strong px-5 py-2.5 text-left"
        style={{ background: "linear-gradient(135deg, #f4f3ff 0%, #fbfaff 70%)" }}
      >
        <span className="text-[#4f3fe0]">
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold uppercase tracking-wider text-[#4f3fe0]">
            {FUNNEL_TITLE[funnel]} Pipeline
          </span>
          <span className="mt-0.5 block text-[11.5px] text-ink-3">{subtitle}</span>
        </span>
        {/* Collapsed, the totals still need to be legible at a glance. */}
        {collapsed ? (
          <span className="flex-shrink-0 text-[11.5px] text-ink-3">
            {stages.reduce((n, s) => n + s.count, 0)} total
          </span>
        ) : null}
      </button>

      {/* Column headers — two groups over four numbers. Only meaningful next to
          the rows, so they collapse with them. */}
      {!collapsed && !isLoading && stages.length > 0 && !allZero ? (
        <div className="flex items-end gap-3 border-b border-border-strong bg-surface-2/40 px-5 py-1.5">
          <span className="w-[190px] flex-shrink-0" />
          <span className="min-w-0 flex-1" />
          <span className="flex flex-shrink-0 flex-col">
            <span className="flex gap-2">
              <span className={cn(GROUP_VOLUME, "border-b border-border-strong pb-0.5 text-center text-[9.5px] font-bold uppercase tracking-[.1em] text-ink-3")}>Volume</span>
              <span className={cn(GROUP_CONVERSION, "border-b border-border-strong pb-0.5 text-center text-[9.5px] font-bold uppercase tracking-[.1em] text-ink-3")}>Conversion</span>
            </span>
            <span className="mt-1 flex gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
              <span className={cn(GROUP_VOLUME, "flex")}>
                <span className={cn(COL_COUNT, "flex-shrink-0 text-right")}>#</span>
                <span className={cn(COL_TREND, "flex-shrink-0 text-right")}>Trend</span>
              </span>
              <span className={cn(GROUP_CONVERSION, "flex")}>
                <span className={cn(COL_PCT, "flex-shrink-0 text-right")}>%</span>
                <span className={cn(COL_TREND, "flex-shrink-0 text-right")}>Trend</span>
              </span>
            </span>
          </span>
        </div>
      ) : null}

      {/* Stage rows */}
      {collapsed ? null : isError ? (
        <div className="px-4 py-8 text-center">
          <p className="text-[12.5px] font-semibold text-red">Couldn't load this funnel.</p>
          {errorText ? <p className="mt-1 text-[11.5px] text-ink-3">{errorText}</p> : null}
          <button type="button" onClick={onRetry}
            className="mt-2.5 rounded-md border border-border-strong bg-surface px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-surface-2">
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <div className="flex flex-col">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-t border-border-strong px-4 py-2 first:border-t-0"
            >
              <div className="h-3 w-3 flex-shrink-0 animate-pulse rounded bg-surface-2" />
              <div className="h-3 w-[180px] flex-shrink-0 animate-pulse rounded bg-surface-2" />
              <div className="h-2.5 w-[30%] animate-pulse rounded-full bg-surface-2" />
              <div className="ml-auto h-3 w-24 animate-pulse rounded bg-surface-2" />
            </div>
          ))}
        </div>
      ) : stages.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-ink-4">
          No stages to display.
        </div>
      ) : allZero ? (
        <div className="px-4 py-8 text-center">
          <p className="text-[12.5px] font-semibold text-ink">
            No {FUNNEL_NOUN[funnel]} entered any stage {periodLabel ? `between ${periodLabel}` : "in this period"}.
          </p>
          {/* Without this, "nothing happened" and "you're looking at the wrong
              week" are indistinguishable — which is exactly how an empty funnel
              gets read as broken. */}
          {lastMovementAt ? (
            <>
              <p className="mt-1 text-[11.5px] text-ink-3">
                Most recent movement was {new Date(lastMovementAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.
              </p>
            </>
          ) : (
            <p className="mt-1 text-[11.5px] text-ink-3">
              Widen the period above to see the pipeline move.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col px-4 py-3">
          {stages.map((stage, i) => {
            const isExpanded = expanded === stage.key;
            const isWon = WON_STAGE_KEYS.has(stage.key);
            const isLost = LOST_STAGE_KEYS.has(stage.key);
            const barGradient = isWon
              ? "linear-gradient(90deg, #15b87f 0%, #3ad29a 100%)"
              : isLost
                ? "linear-gradient(90deg, #8f2f3f 0%, #b8556a 100%)"
                : "linear-gradient(90deg, #6d5efc 0%, #8b7dff 100%)";
            // Taper: the band narrows down the funnel with volume. Floored at 6%
            // so a near-empty stage is still visible rather than vanishing.
            const width = Math.max(6, stage.pct_of_max);
            // The stage this row converts FROM, for the conversion tooltip.
            const prevLabel = i > 0 ? stages[i - 1].label : null;

            return (
              <div key={stage.key}>
                <button
                  type="button"
                  onClick={() => setExpanded(isExpanded ? null : stage.key)}
                  className="group flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-2/40"
                  title={
                    isPeriod
                      ? `${stage.count} ${FUNNEL_NOUN[funnel]} entered ${stage.label} in this period — click for who, when and owner`
                      : `${stage.count} ${FUNNEL_NOUN[funnel]} currently in ${stage.label}`
                  }
                >
                  {/* Stage name, left, fixed column so the bars share a baseline */}
                  <span className="flex w-[190px] flex-shrink-0 items-center gap-1 text-[12.5px] font-semibold text-ink">
                    <span className="text-ink-4">
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                    <span className="truncate" title={stage.label}>{stage.label}</span>
                  </span>

                  {/* The bar itself — tapers with volume. A zero stage gets a
                      hairline rule, not a stub of colour that reads as volume. */}
                  <span className="flex min-w-0 flex-1 items-center">
                    {stage.count === 0 ? (
                      <span className="h-px w-8 bg-border-strong" />
                    ) : (
                      <span
                        className="h-10 rounded-lg transition-[width] duration-500"
                        style={{ width: `${width}%`, background: barGradient }}
                      />
                    )}
                  </span>

                  {/* Four numbers: volume, volume trend, conversion in,
                      conversion trend. Widths match the header grid above. */}
                  <span className="flex flex-shrink-0 items-center gap-2 text-[11.5px]">
                    <span className={cn(GROUP_VOLUME, "flex items-center")}>
                      <span className={cn(COL_COUNT, "flex-shrink-0 text-right font-mono text-[14px] font-bold tabular-nums text-ink")}
                        title={isPeriod
                          ? `${stage.count} ${FUNNEL_NOUN[funnel]} entered ${stage.label} in this period`
                          : `${stage.count} ${FUNNEL_NOUN[funnel]} currently in ${stage.label}`}>
                        {stage.count}
                      </span>
                      <span className={cn(COL_TREND, "flex-shrink-0 text-right")}>
                        <PctTrend current={stage.count} prior={stage.count_prev} noun={FUNNEL_NOUN[funnel]} />
                      </span>
                    </span>
                    <span className={cn(GROUP_CONVERSION, "flex items-center")}>
                      <span className={cn(COL_PCT, "flex-shrink-0 text-right tabular-nums")}
                        title={prevLabel && stage.conversion_in != null
                          ? `${stage.conversion_in}% of what entered ${prevLabel} in this period reached ${stage.label}. Over 100% means more moved forward than arrived — a backlog clearing, since they entered ${prevLabel} earlier.`
                          : "No prior stage to convert from"}>
                        {stage.conversion_in != null ? (
                          <span className="font-mono text-[13px] font-semibold text-ink">{stage.conversion_in}%</span>
                        ) : <span className="text-ink-4">—</span>}
                      </span>
                      <span className={cn(COL_TREND, "flex-shrink-0 text-right")}>
                        <PtTrend current={stage.conversion_in} prior={stage.conversion_in_prev} />
                      </span>
                    </span>
                  </span>
                </button>

                {isExpanded ? (
                  <div className="mb-1 mt-1 overflow-hidden rounded-lg border border-border-strong">
                    <StageDetail stage={stage} recordColumns={recordColumns} isPeriod={isPeriod} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Stage expand panel ──────────────────────────────────────────────────────

function StageDetail({
  stage,
  recordColumns,
  isPeriod,
}: {
  stage: FunnelStage;
  recordColumns: { key: string; label: string }[];
  isPeriod: boolean;
}) {
  // Only show movement that flowed INTO this stage, to keep it focused.
  const inboundMovement = (stage.movement ?? []).filter((m) => m.flow === "in");

  return (
    <div className="flex flex-col gap-3 bg-surface-2/30 px-5 py-3">
      {/* In period mode the records ARE the movement — every row entered this
          stage inside the window — so a separate rolling-30d list would
          contradict the counts above it. */}
      {isPeriod ? null : <StageMovement movement={inboundMovement} />}
      {isPeriod ? (
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          Entered this stage in the period
        </div>
      ) : null}
      <StageRecordsTable stage={stage} recordColumns={recordColumns} />
    </div>
  );
}

// ── Recent movement mini-section ────────────────────────────────────────────

function StageMovement({ movement }: { movement: FunnelMovement[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        Recent Movement (30d)
      </div>
      {movement.length === 0 ? (
        <div className="text-[11.5px] text-ink-3">No recent movement.</div>
      ) : (
        <div className="flex flex-col gap-1">
          {movement.map((m, i) => {
            const advanced = m.direction === "advanced";
            const rel = relativeTime(m.when);
            return (
              <div
                key={i}
                className="flex items-center gap-2 text-[12px]"
              >
                <span
                  className={cn(
                    "flex-shrink-0",
                    advanced
                      ? "text-[var(--green)]"
                      : "text-[var(--amber)]",
                  )}
                >
                  {advanced ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                </span>
                <span className="min-w-[120px] flex-shrink-0 truncate font-medium text-ink">
                  {m.name}
                </span>
                <span className="flex flex-1 items-center gap-1.5 truncate text-ink-3">
                  <span className="truncate">{m.from_label}</span>
                  <span className="text-ink-4">→</span>
                  <span className="truncate text-ink-2">{m.to_label}</span>
                </span>
                {rel ? (
                  <span className="w-[80px] flex-shrink-0 text-right text-[11px] text-ink-4">
                    {rel}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Records table ───────────────────────────────────────────────────────────

function StageRecordsTable({
  stage,
  recordColumns,
}: {
  stage: FunnelStage;
  recordColumns: { key: string; label: string }[];
}) {
  const records = stage.records ?? [];
  const shown = records.slice(0, RECORD_CAP);
  const extra = records.length - shown.length;

  if (records.length === 0) {
    return <div className="text-[12px] text-ink-3">No records.</div>;
  }

  if (recordColumns.length === 0) {
    // Fallback: render whatever name field exists.
    return (
      <div className="flex flex-col gap-1">
        {shown.map((r, i) => (
          <div key={i} className="truncate text-[12px] font-medium text-ink">
            {r.name ?? "—"}
          </div>
        ))}
        {extra > 0 ? (
          <div className="mt-1 text-[11px] text-ink-4">+{extra} more</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-border-strong bg-surface">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border-strong bg-surface-2">
            {recordColumns.map((col) => (
              <th
                key={col.key}
                className="px-3 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-3"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr
              key={i}
              className="border-t border-border-strong first:border-t-0"
            >
              {recordColumns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    "px-3 py-1.5",
                    col.key === recordColumns[0].key
                      ? "font-medium text-ink"
                      : "text-ink-2",
                  )}
                >
                  {formatCell(col.key, r[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {extra > 0 ? (
        <div className="border-t border-border-strong px-3 py-1.5 text-[11px] text-ink-4">
          +{extra} more
        </div>
      ) : null}
    </div>
  );
}

function formatCell(key: string, value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  if (key === "deal_type") {
    return DEAL_TYPE_LABELS[value as DealType] ?? value;
  }
  // Stage-entry stamp: the date is what the team scans for, with the relative
  // age after it so "when" reads without doing arithmetic.
  if (key === "entered_at") {
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) return value;
    const d = new Date(t);
    const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${day} · ${formatDistanceToNow(t, { addSuffix: true })}`;
  }
  // Owner / assigned-by are emails; the local part is enough at this density.
  if ((key === "owner" || key === "assigned_by") && value.includes("@")) {
    return value.split("@")[0];
  }
  return value;
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return formatDistanceToNow(t, { addSuffix: true });
}
