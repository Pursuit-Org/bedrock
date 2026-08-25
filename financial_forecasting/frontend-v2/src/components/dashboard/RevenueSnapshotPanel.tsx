import { useState } from "react";
import { Info, X, Loader2 } from "lucide-react";
import {
  useRevenueSnapshot,
  useRevenueSnapshotDetail,
  type SourceBreakdown,
  type BucketKey,
} from "@/services/revenueSnapshot";
import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/Tooltip";

// ── Color maps ─────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  Foundation: "bg-blue-500",
  Corporate:  "bg-violet-500",
  Individual: "bg-emerald-500",
  Government: "bg-amber-500",
  Other:      "bg-slate-300",
};

const SOURCE_LABELS = ["Foundation", "Corporate", "Individual", "Government", "Other"] as const;

function sortedSources(bySource: SourceBreakdown) {
  return [...SOURCE_LABELS]
    .map((cat) => ({ cat, v: bySource[cat] ?? 0 }))
    .filter(({ v }) => v > 0)
    .sort((a, b) => b.v - a.v);
}

// ── Source bar ─────────────────────────────────────────────────────────────
// When onSegmentClick is provided segments are interactive (taller, clickable).

function SourceBar({
  bySource,
  total,
  heightCls = "h-1.5",
  activeSource,
  onSegmentClick,
}: {
  bySource: SourceBreakdown;
  total: number;
  heightCls?: string;
  activeSource?: string | null;
  onSegmentClick?: (cat: string) => void;
}) {
  const interactive = !!onSegmentClick;

  return (
    <div
      className={cn(
        "flex w-full overflow-hidden rounded-full bg-surface-2",
        heightCls,
      )}
    >
      {sortedSources(bySource)
        .filter(({ v }) => total > 0 && (v / total) * 100 >= 0.5)
        .map(({ cat, v }) => {
          const isActive = activeSource === cat;
          const segment = (
            <div
              key={cat}
              className={cn(
                "h-full transition-[width,opacity] duration-300",
                SOURCE_COLORS[cat],
                interactive && "cursor-pointer",
                interactive && !isActive && activeSource && "opacity-40",
                interactive && isActive && "ring-2 ring-inset ring-white/40",
              )}
              style={{ width: `${(v / total) * 100}%` }}
              onClick={() => onSegmentClick?.(cat)}
            />
          );

          if (!interactive) return segment;

          return (
            <Tooltip
              key={cat}
              content={
                <span className="flex items-center gap-1.5">
                  <span className={cn("h-2 w-2 flex-none rounded-full", SOURCE_COLORS[cat])} />
                  <span>{cat}</span>
                  <span className="font-mono font-semibold">{fmtMoney(v)}</span>
                </span>
              }
            >
              {segment}
            </Tooltip>
          );
        })}
    </div>
  );
}

// ── Source rows: clickable, sorted largest → smallest ─────────────────────

function SourceRows({
  bySource,
  activeSource,
  onSourceClick,
}: {
  bySource: SourceBreakdown;
  activeSource?: string | null;
  onSourceClick: (source: string) => void;
}) {
  const items = sortedSources(bySource);
  if (!items.length) return <p className="text-[11px] text-ink-4">No data</p>;

  return (
    <div className="mt-2 space-y-0.5">
      {items.map(({ cat, v }) => {
        const isActive = activeSource === cat;
        return (
          <button
            key={cat}
            onClick={() => onSourceClick(cat)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left transition-colors",
              isActive
                ? "bg-accent/10 ring-1 ring-inset ring-accent/30"
                : "hover:bg-surface-2",
            )}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn("h-2 w-2 flex-none rounded-full", SOURCE_COLORS[cat])} />
              <span className="truncate text-[11px] text-ink-3">{cat}</span>
            </div>
            <span
              className={cn(
                "shrink-0 font-mono text-[11px]",
                isActive ? "font-semibold text-accent" : "text-ink-2",
              )}
            >
              {fmtMoney(v)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Stat tile ─────────────────────────────────────────────────────────────

function StatTile({
  label,
  tooltip,
  value,
  bySource,
  accent,
  bucket,
  activeSource,
  onSourceClick,
}: {
  label: string;
  tooltip: string;
  value: number;
  bySource: SourceBreakdown;
  accent?: boolean;
  bucket: BucketKey;
  activeSource: string | null;
  onSourceClick: (bucket: BucketKey, source: string) => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border p-5 transition-colors",
        accent
          ? "border-accent/30 bg-accent/5"
          : activeSource
          ? "border-accent/40 bg-surface shadow-sm"
          : "border-border bg-surface shadow-sm",
      )}
    >
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          {label}
        </span>
        <Tooltip content={tooltip}>
          <Info className="h-3 w-3 cursor-help text-ink-4" />
        </Tooltip>
      </div>
      <p className={cn("text-2xl font-bold tabular-nums", accent ? "text-accent" : "text-ink")}>
        {fmtMoney(value)}
      </p>
      <div className="mt-3">
        <SourceBar bySource={bySource} total={value} heightCls="h-4" />
        <SourceRows
          bySource={bySource}
          activeSource={activeSource}
          onSourceClick={(source) => onSourceClick(bucket, source)}
        />
      </div>
    </div>
  );
}

// ── Drilldown detail panel ────────────────────────────────────────────────

const BUCKET_LABELS: Record<BucketKey, string> = {
  revenue_closed: "Revenue Closed",
  cash_secured: "Revenue Secured",
  projected_total: "Total Projected",
};

function OppLink({
  name,
  oppId,
}: {
  name: string | null;
  oppId: string | null;
}) {
  const label = name ?? "—";
  if (!oppId) return <span>{label}</span>;
  return (
    <a
      href={`/opportunities/${oppId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-ink hover:text-accent hover:underline"
    >
      {label}
    </a>
  );
}

function DetailPanel({
  year,
  bucket,
  source,
  currentYear,
  onClose,
}: {
  year: number;
  bucket: BucketKey;
  source: string;
  currentYear: number;
  onClose: () => void;
}) {
  const { data, isLoading } = useRevenueSnapshotDetail(year, bucket, source);
  const isProjected = bucket === "projected_total";

  return (
    <div className="rounded-lg border border-accent/30 bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          {source !== "__all__" && (
            <span className={cn("h-2.5 w-2.5 rounded-full", SOURCE_COLORS[source])} />
          )}
          <span className="text-[13px] font-semibold text-ink">
            {BUCKET_LABELS[bucket]}
            <span className="mx-1.5 text-ink-4">·</span>
            {source === "__all__" ? "All Sources" : source}
            {year !== currentYear && (
              <span className="ml-1 text-ink-3"> ({year})</span>
            )}
          </span>
          {data && (
            <span className="font-mono text-[13px] text-ink-3">{fmtMoney(data.total)}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-ink-4 hover:bg-surface-2 hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-ink-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-[13px]">Loading records…</span>
        </div>
      ) : !data?.records.length ? (
        <p className="py-6 text-center text-[13px] text-ink-4">No records found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-2 font-semibold text-ink-3">Grant / Opportunity</th>
                <th className="px-4 py-2 font-semibold text-ink-3">Account</th>
                {isProjected && (
                  <th className="px-4 py-2 text-right font-semibold text-ink-3">Prob</th>
                )}
                <th className="px-4 py-2 text-right font-semibold text-ink-3">
                  {isProjected ? "Weighted" : "Amount"}
                </th>
                {isProjected && (
                  <th className="px-4 py-2 text-right font-semibold text-ink-3">Full Amt</th>
                )}
                <th className="px-4 py-2 text-right font-semibold text-ink-3">
                  {bucket === "revenue_closed" ? "Close Date" : "Sched. Date"}
                </th>
                {isProjected && (
                  <th className="px-4 py-2 font-semibold text-ink-3">Type</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.records.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2">
                  <td className="max-w-[220px] truncate px-4 py-2">
                    <OppLink name={r.name} oppId={r.opp_id} />
                  </td>
                  <td className="max-w-[180px] truncate px-4 py-2 text-ink-3">{r.account ?? "—"}</td>
                  {isProjected && (
                    <td className="px-4 py-2 text-right tabular-nums text-ink-3">
                      {r.probability != null ? `${r.probability}%` : "—"}
                    </td>
                  )}
                  <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-ink">
                    {fmtMoney(isProjected ? (r.weighted_amount ?? 0) : r.amount)}
                  </td>
                  {isProjected && (
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-3">
                      {fmtMoney(r.amount)}
                    </td>
                  )}
                  <td className="px-4 py-2 text-right tabular-nums text-ink-3">
                    {(bucket === "revenue_closed" ? r.close_date : r.scheduled_date) ?? "—"}
                  </td>
                  {isProjected && (
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                          r.kind === "secured"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                        )}
                      >
                        {r.kind}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Multi-year secured tracker — bar segments are the click targets ─────────

function FutureYearsTable({
  futureYears,
  activeDetail,
  onSegmentClick,
  onTotalClick,
}: {
  futureYears: Record<string, { total: number; by_source: SourceBreakdown }>;
  activeDetail: { year: number; bucket: BucketKey; source: string; origin: "headline" | "tiles" | "table" } | null;
  onSegmentClick: (rowYear: number, source: string) => void;
  onTotalClick: (rowYear: number) => void;
}) {
  const years = Object.entries(futureYears)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([yr, data]) => ({ label: Number(yr), data }));

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Revenue Secured by Future Year
        </h3>
        <Tooltip content="Won-deal payments already scheduled for future years — shows committed revenue from multi-year grants. Click a color segment to see the underlying records.">
          <Info className="h-3 w-3 cursor-help text-ink-4" />
        </Tooltip>
      </div>
      <div className="divide-y divide-border">
        {years.map(({ label, data }) => {
          const activeSource =
            activeDetail?.year === label && activeDetail.bucket === "cash_secured"
              ? activeDetail.source
              : null;
          return (
            <div key={label} className="flex items-center gap-6 px-4 py-4">
              <div className="w-20 shrink-0">
                <p className="text-[18px] font-semibold uppercase tracking-wide text-ink-4">{label}</p>
                <button
                  onClick={() => onTotalClick(label)}
                  className={cn(
                    "font-mono text-2xl font-bold tabular-nums transition-colors",
                    activeDetail?.year === label && activeDetail.bucket === "cash_secured" && activeDetail.source === "__all__"
                      ? "text-accent"
                      : "text-ink hover:text-accent",
                  )}
                >
                  {fmtMoney(data.total)}
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <SourceBar
                  bySource={data.by_source}
                  total={data.total}
                  heightCls="h-4"
                  activeSource={activeSource}
                  onSegmentClick={(source) => onSegmentClick(label, source)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────

export function RevenueSnapshotPanel({ year }: { year: number }) {
  const { data, isLoading, isError } = useRevenueSnapshot(year);
  const [activeDetail, setActiveDetail] = useState<{
    year: number;
    bucket: BucketKey;
    source: string;
    origin: "headline" | "tiles" | "table";
  } | null>(null);

  function toggle(
    detailYear: number,
    bucket: BucketKey,
    source: string,
    origin: "headline" | "tiles" | "table",
  ) {
    setActiveDetail((prev) =>
      prev?.year === detailYear && prev.bucket === bucket && prev.source === source
        ? null
        : { year: detailYear, bucket, source, origin },
    );
  }

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-28 w-full rounded-lg bg-surface-2" />
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 rounded-lg bg-surface-2" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-border bg-surface px-5 py-3 text-[13px] text-ink-3">
        Revenue snapshot unavailable — connect Salesforce in Settings to view YTD metrics.
      </div>
    );
  }

  const { annual_target, revenue_closed, cash_secured, projected_total, future_years } = data;
  const pct = Math.min((revenue_closed.total / annual_target) * 100, 100);

  return (
    <div className="space-y-3">
      {/* ── Headline ──────────────────────────────────────────────────── */}
      <div className={cn(
        "rounded-lg border bg-surface px-5 py-4 shadow-sm transition-colors",
        activeDetail?.origin === "headline" ? "border-accent/40" : "border-border",
      )}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[32px] font-bold tabular-nums leading-none text-ink">
            {fmtMoney(revenue_closed.total)}
          </span>
          <span className="text-[15px] font-medium text-ink-2">raised in {year}</span>
          <Tooltip
            content={`Full value of grants and deals won in ${year} — counted at close, not when cash arrives. A multi-year grant appears here in full even if payments are spread across future years.`}
          >
            <Info className="h-3.5 w-3.5 cursor-help text-ink-4 self-center" />
          </Tooltip>
        </div>

        {/* Segmented progress bar — each color = a source */}
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-3">
            <span>{pct.toFixed(0)}% toward {fmtMoney(annual_target)} goal</span>
            <span className="font-mono">{fmtMoney(annual_target - revenue_closed.total)} remaining</span>
          </div>
          <div
            className="flex h-4 w-full overflow-hidden rounded-full bg-surface-2"
            style={{
              backgroundImage:
                "repeating-linear-gradient(-45deg, rgba(148,163,184,0.45) 0, rgba(148,163,184,0.45) 1.5px, transparent 0, transparent 50%)",
              backgroundSize: "7px 7px",
            }}
          >
            {sortedSources(revenue_closed.by_source).map(({ cat, v }) => (
              <div
                key={cat}
                className={cn("h-full transition-[width] duration-500", SOURCE_COLORS[cat])}
                style={{ width: `${(v / annual_target) * 100}%` }}
                title={`${cat}: ${fmtMoney(v)}`}
              />
            ))}
          </div>
        </div>

        {/* Clickable source breakdown — same as tile rows */}
        <div className="mt-3">
          <SourceRows
            bySource={revenue_closed.by_source}
            activeSource={
              activeDetail?.origin === "headline" && activeDetail.bucket === "revenue_closed"
                ? activeDetail.source
                : null
            }
            onSourceClick={(source) => toggle(year, "revenue_closed", source, "headline")}
          />
        </div>
      </div>

      {/* ── Detail panel for headline clicks (renders below headline) ── */}
      {activeDetail?.origin === "headline" && (
        <DetailPanel
          year={activeDetail.year}
          bucket={activeDetail.bucket}
          source={activeDetail.source}
          currentYear={year}
          onClose={() => setActiveDetail(null)}
        />
      )}

      {/* ── Three-column panel: two stat tiles + future years ───────── */}
      <div className="grid grid-cols-3 gap-3 items-stretch">
        <StatTile
          label="Revenue Secured for Year"
          tooltip={`Payment tranches from Won deals scheduled to land in ${year} — confirmed revenue arriving this year.`}
          value={cash_secured.total}
          bySource={cash_secured.by_source}
          bucket="cash_secured"
          activeSource={
            activeDetail?.origin === "tiles" && activeDetail.year === year && activeDetail.bucket === "cash_secured"
              ? activeDetail.source
              : null
          }
          onSourceClick={(bucket, source) => toggle(year, bucket, source, "tiles")}
        />
        <StatTile
          label="Total Projected for Year"
          tooltip={`Revenue secured for ${year} plus probability-weighted open pipeline payments scheduled in ${year}.`}
          value={projected_total.total}
          bySource={projected_total.by_source}
          accent
          bucket="projected_total"
          activeSource={
            activeDetail?.origin === "tiles" && activeDetail.year === year && activeDetail.bucket === "projected_total"
              ? activeDetail.source
              : null
          }
          onSourceClick={(bucket, source) => toggle(year, bucket, source, "tiles")}
        />
        <FutureYearsTable
          futureYears={future_years}
          activeDetail={activeDetail}
          onSegmentClick={(rowYear, source) => toggle(rowYear, "cash_secured", source, "table")}
          onTotalClick={(rowYear) => toggle(rowYear, "cash_secured", "__all__", "table")}
        />
      </div>

      {/* ── Drilldown from tiles or future-year table (below the 3-col grid) */}
      {activeDetail && activeDetail.origin !== "headline" && (
        <DetailPanel
          year={activeDetail.year}
          bucket={activeDetail.bucket}
          source={activeDetail.source}
          currentYear={year}
          onClose={() => setActiveDetail(null)}
        />
      )}
    </div>
  );
}
