import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as ReTooltip, XAxis, YAxis,
} from "recharts";
import { Loader2 } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import { cn } from "@/lib/utils";
import {
  DEAL_TYPE_LABELS, useJobsProjection,
  type ProjectionBucket, type ProjectionGranularity,
} from "@/services/jobs";

/**
 * Jobs projection (Kwame 2026-09-29): per quarter or month, the jobs already
 * won, the jobs confirmed on open deals (roles created), and the jobs still
 * only estimated, stacked from most to least certain, against the jobs target.
 *
 * One hue in three steps (validated as an ordinal ramp): the darker the
 * segment, the more certain the jobs. Won sits on the baseline because it is
 * banked; estimated is on top because it is the part that can still move.
 */
const SERIES = [
  { key: "won",       label: "Closed Won", color: "#104281", note: "roles on won deals (or the estimate, if none logged)" },
  { key: "confirmed", label: "Confirmed",  color: "#256abf", note: "roles created on open deals" },
  { key: "estimated", label: "Estimated",  color: "#86b6ef", note: "estimate not yet backed by a role" },
] as const;
const TARGET_COLOR = "var(--color-ink, #1f1f1f)";

type SeriesKey = (typeof SERIES)[number]["key"];

export function JobsProjectionChart({ granularity, owner, dealType, nameOf }: {
  granularity: ProjectionGranularity;
  owner?: string;
  dealType?: string;
  nameOf: (e: string | null) => string;
}) {
  const { data, isLoading, isError } = useJobsProjection(granularity, owner, dealType);
  const [drill, setDrill] = useState<ProjectionBucket | null>(null);

  if (isLoading) {
    return <div className="flex h-[260px] items-center justify-center text-ink-4"><Loader2 size={16} className="animate-spin" /></div>;
  }
  if (isError || !data) {
    return <div className="flex h-[120px] items-center justify-center text-[12px] text-ink-4">Couldn't load the projection.</div>;
  }

  const buckets = data.buckets;
  const hasTarget = buckets.some((b) => b.target != null);
  const plotted = buckets.map((b) => ({ ...b, targetPoint: b.target ?? undefined }));
  const undated = buckets.find((b) => b.kind === "undated");
  const notes: string[] = [];
  if (!data.estimated_available) notes.push("Estimated jobs are pending the 2026-09-29 migration, so every deal reads 0 estimated.");
  if (!data.targets_available) notes.push("Jobs targets are pending the 2026-09-29 migration.");
  else if (!hasTarget) notes.push("No jobs target set for these periods yet: Settings › Targets › Jobs.");
  if (undated && undated.deals.length > 0) {
    notes.push(`${undated.deals.length} open deal${undated.deals.length === 1 ? " has" : "s have"} no target close date, shown under "No close date".`);
  }
  if (data.won_undated > 0) {
    notes.push(`${data.won_undated} won deal${data.won_undated === 1 ? " has" : "s have"} no close date on record and ${data.won_undated === 1 ? "isn't" : "aren't"} plotted.`);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Legend: identity is never colour alone — every swatch is labelled. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5" title={s.note}>
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}
          </span>
        ))}
        {hasTarget && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: TARGET_COLOR }} />Jobs target
          </span>
        )}
      </div>

      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={plotted} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" tickLine={false} interval={0} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" tickLine={false} axisLine={false} />
            <ReTooltip cursor={{ fill: "var(--color-surface-2)", opacity: 0.6 }} content={<ProjectionTooltip />} />
            {SERIES.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId="jobs" fill={s.color} maxBarSize={44}
                // 2px surface gap between stacked segments
                stroke="var(--color-surface, #fff)" strokeWidth={2}
                radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                cursor="pointer" onClick={(d) => setDrill((d as unknown as { payload: ProjectionBucket }).payload)} />
            ))}
            {/* The target is a per-period number, so it's drawn as a marker
                across each bar rather than a line between periods: a slope
                from 12 to 15 would claim the target changes mid-quarter. */}
            {hasTarget && (
              <Line dataKey="targetPoint" name="Jobs target" stroke="none" isAnimationActive={false}
                activeDot={false} dot={<TargetMarker />} legendType="none" />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Table view: the same numbers, readable without the chart, and each
          column opens its deals. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12px] tabular-nums">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-wider text-ink-3">
              <th className="py-1 pr-3 text-left font-semibold">Jobs</th>
              {buckets.map((b) => (
                <th key={b.key} className={cn("px-2 py-1 text-right font-semibold", b.kind === "current" && "text-ink")}>
                  {b.label}{b.kind === "current" ? " ·now" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SERIES.map((s) => (
              <tr key={s.key} className="border-t border-border">
                <td className="py-1 pr-3 text-ink-2">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: s.color }} />{s.label}
                </td>
                {buckets.map((b) => <td key={b.key} className="px-2 py-1 text-right text-ink-2">{b[s.key as SeriesKey] || "—"}</td>)}
              </tr>
            ))}
            <tr className="border-t border-border-strong font-semibold">
              <td className="py-1 pr-3 text-ink">Total</td>
              {buckets.map((b) => (
                <td key={b.key} className="px-2 py-1 text-right">
                  <button type="button" onClick={() => setDrill(b)} disabled={b.deals.length === 0}
                    className="text-ink hover:text-accent disabled:cursor-default disabled:text-ink-4" title="Show the deals">
                    {b.total || "—"}
                  </button>
                </td>
              ))}
            </tr>
            <tr className="border-t border-border">
              <td className="py-1 pr-3 text-ink-3">Target</td>
              {buckets.map((b) => <td key={b.key} className="px-2 py-1 text-right text-ink-3">{b.target ?? "—"}</td>)}
            </tr>
            <tr className="border-t border-border">
              <td className="py-1 pr-3 text-ink-3">vs target</td>
              {buckets.map((b) => {
                const gap = b.target == null ? null : b.total - b.target;
                return (
                  <td key={b.key} className={cn("px-2 py-1 text-right",
                    gap == null ? "text-ink-4" : gap >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                    {gap == null ? "—" : `${gap > 0 ? "+" : ""}${Number.isInteger(gap) ? gap : gap.toFixed(1)}`}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {notes.length > 0 && (
        <ul className="list-disc pl-4 text-[11.5px] text-ink-3">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      {drill && (
        <Drawer open onClose={() => setDrill(null)} title={`Jobs · ${drill.label}`} width={760}
          subtitle={`${drill.deals.length} deal${drill.deals.length === 1 ? "" : "s"} · ${drill.won} won · ${drill.confirmed} confirmed · ${drill.estimated} estimated${drill.target != null ? ` · target ${drill.target}` : ""}`}>
          {drill.deals.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-ink-4">No deals in this period.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Account</th>
                  <th className="px-2 py-2 text-left font-semibold">Stage</th>
                  <th className="px-2 py-2 text-left font-semibold">Owner</th>
                  <th className="px-2 py-2 text-left font-semibold">Close</th>
                  <th className="px-2 py-2 text-right font-semibold">Won</th>
                  <th className="px-2 py-2 text-right font-semibold">Conf.</th>
                  <th className="px-3 py-2 text-right font-semibold">Est.</th>
                </tr>
              </thead>
              <tbody>
                {drill.deals.map((d) => (
                  <tr key={d.opportunity_id} className="border-t border-border tabular-nums">
                    <td className="px-3 py-1.5">
                      <Link to={`/jobs/opportunities/${d.opportunity_id}`} className="font-medium text-ink hover:text-accent">{d.account}</Link>
                      <div className="text-[11px] text-ink-4">
                        {[d.title, d.deal_type ? DEAL_TYPE_LABELS[d.deal_type] : null].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-ink-2">{d.stage_label}</td>
                    <td className="px-2 py-1.5 text-ink-2">{d.owner ? nameOf(d.owner) : "—"}</td>
                    <td className="px-2 py-1.5 text-ink-3">{d.target_close_date ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right">{d.won || "—"}</td>
                    <td className="px-2 py-1.5 text-right">{d.confirmed || "—"}</td>
                    <td className="px-3 py-1.5 text-right">{d.estimated || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Drawer>
      )}
    </div>
  );
}

/** A short horizontal bar across the column at the target value. */
function TargetMarker({ cx, cy }: { cx?: number; cy?: number }) {
  if (cx == null || cy == null || Number.isNaN(cy)) return null;
  const half = 30;
  return (
    <g>
      {/* surface halo so the marker reads on top of a filled segment */}
      <line x1={cx - half} x2={cx + half} y1={cy} y2={cy} stroke="var(--color-surface, #fff)" strokeWidth={5} strokeLinecap="round" />
      <line x1={cx - half} x2={cx + half} y1={cy} y2={cy} stroke={TARGET_COLOR} strokeWidth={2} strokeLinecap="round" />
    </g>
  );
}

function ProjectionTooltip({ active, payload }: { active?: boolean; payload?: { payload: ProjectionBucket }[] }) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  const gap = b.target == null ? null : b.total - b.target;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] shadow-md">
      <div className="mb-1 font-semibold text-ink">{b.label}</div>
      {SERIES.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}
          </span>
          <span className="tabular-nums">{b[s.key]}</span>
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-4 border-t border-border pt-1 font-semibold text-ink">
        <span>Total</span><span className="tabular-nums">{b.total}</span>
      </div>
      {b.target != null && (
        <div className="flex justify-between gap-4 text-ink-3">
          <span>Target</span>
          <span className="tabular-nums">{b.target}{gap != null ? ` (${gap >= 0 ? "+" : ""}${Number.isInteger(gap) ? gap : gap.toFixed(1)})` : ""}</span>
        </div>
      )}
      <div className="mt-1 text-[10.5px] text-ink-4">Click for the deals</div>
    </div>
  );
}
