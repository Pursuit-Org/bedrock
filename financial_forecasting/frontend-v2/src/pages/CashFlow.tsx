import { useState, useRef, useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, X } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as ReTooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";

import { PageHeader } from "@/components/PageHeader";
import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCashflow, useCashflowDetail, type CashflowBucket, type CashflowType } from "@/services/cashflow";
import { fmtDate } from "@/lib/format";
import { BUCKET_OPTIONS } from "@/lib/recordTypes";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const COLORS = {
  actuals:     "#16a34a", // green-600
  outstanding: "#d97706", // amber-600
  scheduled:   "#2563eb", // blue-600
  projected:   "#94a3b8", // slate-400
};

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
      {children}
    </div>
  );
}

function fmtK(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
}

function HeaderCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn(
      "border-r border-border px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3 last:border-r-0",
      className,
    )}>
      {children}
    </th>
  );
}

export function CashFlowPage() {
  const navigate = useNavigate();
  const currentYear = new Date().getFullYear();
  const [fy, setFy] = useState(currentYear);
  const [bucket, setBucket] = useState<CashflowBucket>("philanthropy");
  const { data, isLoading } = useCashflow(fy, bucket);

  const currentMonth = new Date().getMonth() + 1;
  const isPastMonth  = (m: number) => fy < currentYear || (fy === currentYear && m < currentMonth);
  const isCurrent    = (m: number) => m === currentMonth && fy === currentYear;

  const [selected, setSelected] = useState<{ month: number; type: CashflowType } | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const { data: detail, isLoading: detailLoading } = useCashflowDetail(
    fy, selected?.month ?? null, selected?.type ?? null, bucket,
  );

  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected]);

  function handleCellClick(month: number, rowKey: "actuals" | "scheduled" | "projected") {
    const type: CashflowType =
      rowKey === "scheduled" && isPastMonth(month) ? "outstanding"
      : rowKey;
    setSelected((prev) =>
      prev?.month === month && prev?.type === type ? null : { month, type },
    );
  }

  const rows = {
    actuals:   data?.map((m) => m.actuals)   ?? Array(12).fill(0),
    scheduled: data?.map((m) => m.scheduled) ?? Array(12).fill(0),
    // Projected is hidden (zeroed) for past months
    projected: data?.map((m, i) => isPastMonth(i + 1) ? 0 : m.projected) ?? Array(12).fill(0),
  };

  // Column totals exclude past projected
  const colTotals = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    total: (rows.actuals[i] ?? 0) + (rows.scheduled[i] ?? 0) + (rows.projected[i] ?? 0),
  }));

  const rowTotals = {
    actuals:   rows.actuals.reduce((s, v) => s + v, 0),
    scheduled: rows.scheduled.reduce((s, v) => s + v, 0),
    projected: rows.projected.reduce((s, v) => s + v, 0),
  };

  const chartData = Array.from({ length: 12 }, (_, i) => ({
    name: MONTH_NAMES[i],
    Actuals:     rows.actuals[i]   ?? 0,
    Outstanding: isPastMonth(i + 1) ? (rows.scheduled[i] ?? 0) : 0,
    Scheduled:   isPastMonth(i + 1) ? 0 : (rows.scheduled[i] ?? 0),
    Projected:   rows.projected[i] ?? 0,
  }));

  return (
    <div className="flex h-full flex-col px-7 py-6">
      <PageHeader
        title="Cash Flow"
        actions={
          <div className="inline-flex overflow-hidden rounded border border-border-strong bg-surface">
            {[currentYear - 1, currentYear, currentYear + 1].map((y, i) => (
              <button
                key={y}
                onClick={() => setFy(y)}
                className={cn(
                  "h-7 px-3 text-[12.5px] font-medium text-ink-2 transition-colors",
                  i > 0 && "border-l border-border-strong",
                  fy === y && "bg-surface-2 text-ink",
                )}
              >
                {y}
              </button>
            ))}
          </div>
        }
      />

      <div className="flex flex-col gap-4">
        {/* Record-type filter pills */}
        <div className="inline-flex flex-wrap gap-1.5">
          {BUCKET_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setBucket(opt.value)}
              className={cn(
                "h-7 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
                bucket === opt.value
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border-strong bg-surface text-ink-2 hover:text-ink",
              )}
              aria-pressed={bucket === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Chart */}
        <Card>
          <div className="px-4 pb-4 pt-5">
            {isLoading ? (
              <div className="flex h-48 items-center justify-center text-[13px] text-ink-3">Loading…</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} barSize={18} barGap={2}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: "var(--color-ink-3)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={fmtK}
                    tick={{ fontSize: 11, fill: "var(--color-ink-3)" }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <ReTooltip
                    formatter={(v) => fmtMoney(Number(v))}
                    contentStyle={{
                      fontSize: 12,
                      border: "1px solid var(--color-border-strong)",
                      borderRadius: 6,
                      background: "var(--color-surface)",
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Actuals"     stackId="a" fill={COLORS.actuals}     radius={[0,0,0,0]} />
                  <Bar dataKey="Outstanding" stackId="a" fill={COLORS.outstanding} radius={[0,0,0,0]} />
                  <Bar dataKey="Scheduled"   stackId="a" fill={COLORS.scheduled}   radius={[0,0,0,0]} />
                  <Bar dataKey="Projected"   stackId="a" fill={COLORS.projected}   radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Table — rows = Actuals / Scheduled / Projected / Total, columns = months */}
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border-strong">
                  <th className="sticky left-0 z-10 border-r border-border-strong bg-surface px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                    &nbsp;
                  </th>
                  {MONTH_NAMES.map((m, i) => (
                    <HeaderCell
                      key={m}
                      className={cn(isCurrent(i + 1) && "bg-surface-2 text-ink")}
                    >
                      {m}
                    </HeaderCell>
                  ))}
                  <th className="border-l border-border-strong px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* Actuals */}
                <tr className="border-t border-border">
                  <td className="sticky left-0 z-10 border-r border-border-strong bg-surface px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                    Actuals
                  </td>
                  {rows.actuals.map((v, i) => {
                    const sel = selected?.month === i + 1 && selected?.type === "actuals";
                    return (
                      <td
                        key={i}
                        onClick={() => v && handleCellClick(i + 1, "actuals")}
                        className={cn(
                          "border-r border-border px-3 py-2 text-right tabular-nums text-[12px] last:border-r-0",
                          v ? "cursor-pointer font-semibold text-ink hover:bg-surface-2" : "text-ink-4",
                          sel && "bg-ink/[0.06] ring-1 ring-inset ring-ink/20",
                        )}
                      >
                        {v ? fmtK(v) : "—"}
                      </td>
                    );
                  })}
                  <td className="border-l border-border-strong px-3 py-2 text-right tabular-nums text-[12px] font-semibold text-ink">
                    {rowTotals.actuals ? fmtK(rowTotals.actuals) : "—"}
                  </td>
                </tr>

                {/* Scheduled / Outstanding */}
                <tr className="border-t border-border">
                  <td className="sticky left-0 z-10 border-r border-border-strong bg-surface px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                    Scheduled
                    <span className="ml-1 font-normal normal-case text-ink-4"> · past = outstanding</span>
                  </td>
                  {rows.scheduled.map((v, i) => {
                    const past = isPastMonth(i + 1);
                    const type: CashflowType = past ? "outstanding" : "scheduled";
                    const sel = selected?.month === i + 1 && selected?.type === type;
                    return (
                      <td
                        key={i}
                        onClick={() => v && handleCellClick(i + 1, "scheduled")}
                        className={cn(
                          "border-r border-border px-3 py-2 text-right tabular-nums text-[12px] last:border-r-0",
                          !v && "text-ink-4",
                          v && !past && "cursor-pointer text-blue-600 hover:bg-surface-2",
                          v && past  && "cursor-pointer font-medium text-amber-600 hover:bg-surface-2",
                          sel && "bg-ink/[0.06] ring-1 ring-inset ring-ink/20",
                        )}
                      >
                        {v ? fmtK(v) : "—"}
                      </td>
                    );
                  })}
                  <td className="border-l border-border-strong px-3 py-2 text-right tabular-nums text-[12px] font-semibold text-ink">
                    {rowTotals.scheduled ? fmtK(rowTotals.scheduled) : "—"}
                  </td>
                </tr>

                {/* Projected — hidden for past months */}
                <tr className="border-t border-border">
                  <td className="sticky left-0 z-10 border-r border-border-strong bg-surface px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                    Projected
                    <span className="ml-1 font-normal normal-case text-ink-4"> · future only</span>
                  </td>
                  {data?.map((m, i) => {
                    const past = isPastMonth(i + 1);
                    const sel = selected?.month === i + 1 && selected?.type === "projected";
                    return (
                      <td
                        key={i}
                        onClick={() => !past && m.projected && handleCellClick(i + 1, "projected")}
                        className={cn(
                          "border-r border-border px-3 py-2 text-right tabular-nums text-[12px] last:border-r-0",
                          past && "text-ink-4",
                          !past && m.projected && "cursor-pointer text-ink-3 hover:bg-surface-2",
                          !past && !m.projected && "text-ink-4",
                          sel && "bg-ink/[0.06] ring-1 ring-inset ring-ink/20",
                        )}
                      >
                        {!past && m.projected ? fmtK(m.projected) : "—"}
                      </td>
                    );
                  }) ?? Array(12).fill(0).map((_, i) => (
                    <td key={i} className="border-r border-border px-3 py-2 text-right text-[12px] text-ink-4 last:border-r-0">—</td>
                  ))}
                  <td className="border-l border-border-strong px-3 py-2 text-right tabular-nums text-[12px] font-semibold text-ink">
                    {rowTotals.projected ? fmtK(rowTotals.projected) : "—"}
                  </td>
                </tr>
                {/* Column totals row */}
                <tr className="border-t-2 border-border-strong bg-surface-2">
                  <td className="sticky left-0 z-10 border-r border-border-strong bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                    Total
                  </td>
                  {colTotals.map(({ month, total }) => (
                    <td
                      key={month}
                      className={cn(
                        "border-r border-border px-3 py-2 text-right tabular-nums text-[12px] font-semibold last:border-r-0",
                        total ? "text-ink" : "text-ink-4",
                        isCurrent(month) && "bg-surface",
                      )}
                    >
                      {total ? fmtK(total) : "—"}
                    </td>
                  ))}
                  <td className="border-l border-border-strong px-3 py-2 text-right tabular-nums text-[12px] font-bold text-ink">
                    {fmtK(rowTotals.actuals + rowTotals.scheduled + rowTotals.projected)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {/* Detail panel */}
        {selected && (
          <Card>
            <div ref={detailRef}>
              <div className="flex items-center justify-between border-b border-border-strong px-4 py-3">
                <span className="text-[13px] font-semibold text-ink">
                  {MONTH_NAMES[selected.month - 1]} {fy} ·{" "}
                  <span className={cn(
                    selected.type === "actuals"     && "text-green-600",
                    selected.type === "outstanding" && "text-amber-600",
                    selected.type === "scheduled"   && "text-blue-600",
                    selected.type === "projected"   && "text-ink-3",
                  )}>
                    {selected.type.charAt(0).toUpperCase() + selected.type.slice(1)}
                  </span>
                </span>
                <button
                  onClick={() => setSelected(null)}
                  className="text-ink-4 hover:text-ink"
                >
                  <X size={14} />
                </button>
              </div>

              {detailLoading ? (
                <div className="px-4 py-6 text-center text-[13px] text-ink-3">Loading…</div>
              ) : !detail?.length ? (
                <div className="px-4 py-6 text-center text-[13px] text-ink-3">No payments found</div>
              ) : (
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">Opportunity</th>
                      <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">Account</th>
                      <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">Stage</th>
                      <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3">Date</th>
                      <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3">Amount</th>
                      {selected.type === "projected" && (
                        <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3">Weighted</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.map((r, i) => (
                      <tr
                        key={i}
                        onClick={() => r.opp_id && navigate(`/opportunities/${r.opp_id}`)}
                        className={cn(
                          "border-t border-border",
                          r.opp_id ? "cursor-pointer hover:bg-surface-2" : "",
                        )}
                      >
                        <td className="px-4 py-2 font-medium text-ink">
                          <span className="inline-flex items-center gap-1.5">
                            {r.opp_name ?? "—"}
                            {r.opp_id && <ExternalLink size={11} className="text-ink-4" />}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-ink-2">{r.account_name ?? "—"}</td>
                        <td className="px-4 py-2 text-ink-3">{r.stage ?? "—"}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-3">
                          {r.date ? fmtDate(r.date) : "—"}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium text-ink">
                          {fmtMoney(r.amount)}
                        </td>
                        {selected.type === "projected" && (
                          <td className="px-4 py-2 text-right tabular-nums text-ink-3">
                            {r.weighted_amount != null
                              ? `${fmtMoney(r.weighted_amount)} (${r.probability}%)`
                              : "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border-strong">
                      <td colSpan={selected.type === "projected" ? 4 : 4} className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                        Total
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-semibold text-ink">
                        {fmtMoney(detail.reduce((s, r) => s + r.amount, 0))}
                      </td>
                      {selected.type === "projected" && (
                        <td className="px-4 py-2 text-right tabular-nums font-semibold text-ink-3">
                          {fmtMoney(detail.reduce((s, r) => s + (r.weighted_amount ?? 0), 0))}
                        </td>
                      )}
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
