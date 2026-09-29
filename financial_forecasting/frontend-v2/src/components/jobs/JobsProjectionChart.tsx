import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import { cn } from "@/lib/utils";
import {
  DEAL_TYPE_LABELS, useJobsProjection,
  type ProjectionBucket, type ProjectionGranularity,
} from "@/services/jobs";

/**
 * Jobs projection (Kwame 2026-09-29): per quarter or month, the jobs already
 * won, the roles confirmed on open deals, and the roles still only estimated,
 * against the jobs target. A table, not a chart (Kwame 2026-09-29): the
 * numbers are what gets read, and the bars added nothing the row totals
 * didn't already say.
 *
 * Monthly adds a quarter row above the months, so a month is always read
 * inside its quarter (and next to the quarter's target).
 */
const ROWS = [
  { key: "won",       label: "Closed Won",      note: "Roles on won deals (or the estimate, if none were logged), by close date" },
  { key: "confirmed", label: "Confirmed Roles", note: "Roles created on open deals (cancelled excluded), by target close" },
  { key: "estimated", label: "Estimated Roles", note: "Estimated jobs not yet backed by a created role, by target close" },
] as const;

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function JobsProjectionChart({ granularity, owner, dealType, nameOf }: {
  granularity: ProjectionGranularity;
  owner?: string;
  dealType?: string;
  nameOf: (e: string | null) => string;
}) {
  const { data, isLoading, isError } = useJobsProjection(granularity, owner, dealType);
  const [drill, setDrill] = useState<ProjectionBucket | null>(null);

  if (isLoading) {
    return <div className="flex h-[140px] items-center justify-center text-ink-4"><Loader2 size={16} className="animate-spin" /></div>;
  }
  if (isError || !data) {
    return <div className="flex h-[100px] items-center justify-center text-[12px] text-ink-4">Couldn't load the projection.</div>;
  }

  const buckets = data.buckets;
  const monthly = data.granularity === "month";

  // Quarter header groups for the monthly view: consecutive months that share
  // a quarter, then one cell per catch-all.
  const groups: { key: string; label: string; span: number; target: number | null; current: boolean }[] = [];
  if (monthly) {
    for (const b of buckets) {
      const last = groups[groups.length - 1];
      const key = b.quarter ?? b.key;
      if (b.quarter && last && last.key === key) {
        last.span += 1;
        if (b.target != null) last.target = (last.target ?? 0) + b.target;
        last.current ||= b.kind === "current";
      } else {
        groups.push({ key, label: b.quarter_label ?? "", span: 1, target: b.quarter ? b.target : null, current: b.kind === "current" });
      }
    }
  }

  const cellCls = (b: ProjectionBucket, first: boolean) => cn(
    "px-2 py-1.5 text-right",
    b.kind === "current" && "bg-accent-soft/40",
    // A rule where each quarter starts, and before the catch-alls.
    first && "border-l border-border-strong",
  );
  const startsGroup = (i: number) =>
    i > 0 && (monthly
      ? (buckets[i].quarter ?? buckets[i].key) !== (buckets[i - 1].quarter ?? buckets[i - 1].key)
      : buckets[i].kind === "overdue");

  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-[12.5px] tabular-nums", monthly ? "min-w-[1100px]" : "min-w-[680px]")}>
        <thead>
          {monthly && (
            <tr className="text-[11px] font-semibold text-ink-2">
              <th />
              {groups.map((g, gi) => (
                <th key={g.key} colSpan={g.span}
                  className={cn("px-2 pb-1 pt-0.5 text-center", g.current && "text-ink",
                    gi > 0 && "border-l border-border-strong")}>
                  {g.label ? (
                    <>
                      {g.label}{g.current ? " · now" : ""}
                      <span className="ml-1.5 font-normal text-ink-4">
                        {g.target != null ? `target ${Math.round(g.target)}` : "no target"}
                      </span>
                    </>
                  ) : null}
                </th>
              ))}
            </tr>
          )}
          <tr className="border-b border-border-strong text-[10.5px] uppercase tracking-wider text-ink-3">
            <th className="py-1.5 pr-3 text-left font-semibold">Jobs</th>
            {buckets.map((b, i) => (
              <th key={b.key} className={cn(cellCls(b, startsGroup(i)), "font-semibold", b.kind === "current" && "text-ink")}>
                {monthly && b.start ? b.label.split(" ")[0] : b.label}
                {!monthly && b.kind === "current" ? " · now" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <td className="py-1.5 pr-3 text-ink-2" title={r.note}>{r.label}</td>
              {buckets.map((b, i) => (
                <td key={b.key} className={cn(cellCls(b, startsGroup(i)), "text-ink-2")}>{b[r.key] || "—"}</td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-border-strong font-semibold">
            <td className="py-1.5 pr-3 text-ink">Total</td>
            {buckets.map((b, i) => (
              <td key={b.key} className={cellCls(b, startsGroup(i))}>
                <button type="button" onClick={() => setDrill(b)} disabled={b.deals.length === 0}
                  className="text-ink hover:text-accent hover:underline disabled:cursor-default disabled:text-ink-4 disabled:no-underline"
                  title={b.deals.length ? "Show the deals" : undefined}>
                  {b.total || "—"}
                </button>
              </td>
            ))}
          </tr>
          <tr className="border-t border-border">
            <td className="py-1.5 pr-3 text-ink-3">Target</td>
            {buckets.map((b, i) => (
              <td key={b.key} className={cn(cellCls(b, startsGroup(i)), "text-ink-3")}>{b.target != null ? fmt(b.target) : "—"}</td>
            ))}
          </tr>
          <tr className="border-t border-border">
            <td className="py-1.5 pr-3 text-ink-3">vs target</td>
            {buckets.map((b, i) => {
              const gap = b.target == null ? null : b.total - b.target;
              return (
                <td key={b.key} className={cn(cellCls(b, startsGroup(i)),
                  gap == null ? "text-ink-4" : gap >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                  {gap == null ? "—" : `${gap > 0 ? "+" : ""}${fmt(gap)}`}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>

      {drill && (
        <Drawer open onClose={() => setDrill(null)} title={`Jobs · ${drill.label}`} width={760}
          subtitle={`${drill.deals.length} deal${drill.deals.length === 1 ? "" : "s"} · ${drill.won} won · ${drill.confirmed} confirmed · ${drill.estimated} estimated${drill.target != null ? ` · target ${fmt(drill.target)}` : ""}`}>
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Account</th>
                <th className="px-2 py-2 text-left font-semibold">Stage</th>
                <th className="px-2 py-2 text-left font-semibold">Owner</th>
                <th className="px-2 py-2 text-left font-semibold">Close</th>
                <th className="px-2 py-2 text-right font-semibold">Won</th>
                <th className="px-2 py-2 text-right font-semibold">Confirmed</th>
                <th className="px-3 py-2 text-right font-semibold">Estimated</th>
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
        </Drawer>
      )}
    </div>
  );
}
