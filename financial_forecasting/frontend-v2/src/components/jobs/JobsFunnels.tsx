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

const FUNNEL_TABS: { type: FunnelType; label: string }[] = [
  { type: "opportunities", label: "Opportunities" },
  { type: "prospects", label: "Contacts" },
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

const RECORD_CAP = 60;

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
  const [funnel, setFunnel] = useState<FunnelType>(only ?? "opportunities");
  // Deal-type lens. Defaults to ALL: defaulting to Full-Time silently scoped the
  // Contacts funnel to people at companies that happen to hold an FT
  // opportunity, so "Assigned" read 18 when 267 contacts are assigned.
  const [dealTypeOwn, setDealTypeOwn] = useState<string>("all");
  const controlled = dealTypeProp != null;
  const dealType = controlled ? dealTypeProp : dealTypeOwn;
  const setDealType = setDealTypeOwn;
  // The builders funnel is the L3+ job-ready pool — scope it by the dashboard's
  // L3-cohort segment instead of deal type.
  const { data, isLoading } = useJobsFunnel(
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
      />

      {/* Muted note for funnels without stage-change history */}
      {funnel !== "opportunities" && !isPeriod ? (
        <p className="text-[11.5px] text-ink-3">
          Stage-change history isn't tracked for this funnel yet.
        </p>
      ) : null}
    </div>
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
}: {
  funnel: FunnelType;
  stages: FunnelStage[];
  recordColumns: { key: string; label: string }[];
  isLoading: boolean;
  isPeriod: boolean;
  periodLabel?: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

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
      {/* Header bar — soft gradient band */}
      <div
        className="border-b border-border-strong px-5 py-2.5"
        style={{ background: "linear-gradient(135deg, #f4f3ff 0%, #fbfaff 70%)" }}
      >
        <div className="text-[12px] font-semibold uppercase tracking-wider text-[#4f3fe0]">
          {FUNNEL_TITLE[funnel]} Pipeline
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-3">
          {subtitle}
        </div>
      </div>

      {/* Stage rows */}
      {isLoading ? (
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
          <p className="mt-1 text-[11.5px] text-ink-3">
            Widen the period above to see the pipeline move.
          </p>
        </div>
      ) : (
        <div className="flex flex-col px-4 py-3">
          {stages.map((stage) => {
            const isExpanded = expanded === stage.key;
            const isWon = WON_STAGE_KEYS.has(stage.key);
            const barGradient = isWon
              ? "linear-gradient(90deg, #15b87f 0%, #3ad29a 100%)"
              : "linear-gradient(90deg, #6d5efc 0%, #8b7dff 100%)";
            // Taper: the band narrows down the funnel with volume. Floored at 6%
            // so a near-empty stage is still visible rather than vanishing.
            const width = Math.max(6, stage.pct_of_max);

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

                  {/* Numbers, right: volume, then conversion, then movement */}
                  <span className="flex w-[230px] flex-shrink-0 items-center justify-end gap-2 text-[11.5px]">
                    {stage.advanced_in > 0 ? (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-[var(--green-soft)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--green)]"
                        title={`${stage.advanced_in} advanced into this stage in the last 30d`}
                      >
                        <ArrowUp size={10} />
                        {stage.advanced_in}
                      </span>
                    ) : null}
                    {stage.regressed_in > 0 ? (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-[var(--amber-soft)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--amber)]"
                        title={`${stage.regressed_in} regressed into this stage in the last 30d`}
                      >
                        <ArrowDown size={10} />
                        {stage.regressed_in}
                      </span>
                    ) : null}
                    <span className="font-mono text-[14px] font-bold tabular-nums text-ink">
                      {stage.count}
                    </span>
                    {stage.conversion_to_next != null ? (
                      <span
                        className={cn(
                          "w-[104px] text-right tabular-nums",
                          stage.conversion_to_next >= 100 ? "text-[var(--green)]" : "text-ink-3",
                        )}
                        title={
                          isPeriod
                            ? `Of what entered ${stage.label} in this period, the next stage took ${stage.conversion_to_next}%. Over 100% means more moved forward than arrived — a backlog clearing, since they entered ${stage.label} earlier.`
                            : `Conversion from ${stage.label} to the next stage`
                        }
                      >
                        → {stage.conversion_to_next}% to next
                      </span>
                    ) : (
                      <span className="w-[104px]" />
                    )}
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
