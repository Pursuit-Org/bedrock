import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import { cn } from "@/lib/utils";
import { DeltaChip } from "@/components/jobs/DeltaChip";
import {
  DEAL_TYPE_LABELS, useJobsProjection,
  type ProjectionBucket, type ProjectionGranularity,
} from "@/services/jobs";

/**
 * Jobs projection (Kwame 2026-09-29): one row per period, starting with the
 * current quarter, and the columns Target, Closed Won Jobs, Delta to Target,
 * Confirmed Roles, Estimated Jobs. Delta sits beside Closed Won because it is
 * the gap on what has actually landed: Closed Won minus Target, in the same
 * chip the Outreach Activity Pipeline uses.
 *
 * Monthly nests each quarter's months under a quarter row, so a month is
 * always read inside its quarter.
 */
type Row = {
  key: string; label: string; target: number | null; won: number; confirmed: number;
  estimated: number; current: boolean; level: "quarter" | "month" | "catchall";
  bucket: ProjectionBucket;
};

const COLS = ["Target", "Closed Won Jobs", "Delta to Target", "Confirmed Roles", "Estimated Jobs"];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** One quarter's months rolled into a single bucket (for the quarter row and its drill). */
function rollUp(label: string, key: string, months: ProjectionBucket[]): ProjectionBucket {
  const sum = (k: "won" | "confirmed" | "estimated") => months.reduce((n, m) => n + m[k], 0);
  const targets = months.map((m) => m.target).filter((t): t is number => t != null);
  return {
    ...months[0], key, label, kind: months.some((m) => m.kind === "current") ? "current" : months[0].kind,
    won: sum("won"), confirmed: sum("confirmed"), estimated: sum("estimated"),
    total: sum("won") + sum("confirmed") + sum("estimated"),
    target: targets.length ? Math.round(targets.reduce((a, b) => a + b, 0)) : null,
    deals: months.flatMap((m) => m.deals),
  };
}

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

  const toRow = (b: ProjectionBucket, level: Row["level"]): Row => ({
    key: b.key, label: b.label, target: b.target, won: b.won, confirmed: b.confirmed,
    estimated: b.estimated, current: b.kind === "current", level, bucket: b,
  });
  const periods = data.buckets.filter((b) => b.start);
  const catchalls = data.buckets.filter((b) => !b.start);
  const rows: Row[] = [];
  if (data.granularity === "month") {
    const byQ = new Map<string, ProjectionBucket[]>();
    for (const b of periods) (byQ.get(b.quarter!) ?? byQ.set(b.quarter!, []).get(b.quarter!)!).push(b);
    for (const [q, months] of byQ) {
      rows.push(toRow(rollUp(months[0].quarter_label ?? q, `q-${q}`, months), "quarter"));
      for (const m of months) rows.push(toRow(m, "month"));
    }
  } else {
    for (const b of periods) rows.push(toRow(b, "quarter"));
  }
  for (const b of catchalls) rows.push(toRow(b, "catchall"));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[12.5px] tabular-nums">
        <thead>
          <tr className="border-b border-border-strong text-[10.5px] uppercase tracking-wider text-ink-3">
            <th className="py-1.5 pr-3 text-left font-semibold">Period</th>
            {COLS.map((c) => <th key={c} className="px-3 py-1.5 text-right font-semibold">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const firstCatchall = r.level === "catchall" && rows[i - 1]?.level !== "catchall";
            const isQuarterInMonthly = data.granularity === "month" && r.level === "quarter";
            return (
              <tr key={r.key}
                onClick={() => r.bucket.deals.length && setDrill(r.bucket)}
                title={r.bucket.deals.length ? "Show the deals" : undefined}
                className={cn("border-t", r.bucket.deals.length && "cursor-pointer hover:bg-surface-2/60",
                  firstCatchall ? "border-t-2 border-border-strong" : isQuarterInMonthly && i > 0 ? "border-border-strong" : "border-border",
                  isQuarterInMonthly && "bg-surface-2/50",
                  r.current && r.level !== "month" && "bg-accent-soft/40")}>
                <td className={cn("py-2 pr-3",
                  r.level === "month" ? "pl-5 text-ink-2" : r.level === "catchall" ? "text-ink-3" : "font-semibold text-ink")}>
                  {r.label}
                  {r.current && r.level !== "month" && <span className="ml-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-accent-ink">now</span>}
                </td>
                <td className="px-3 py-2 text-right text-ink-2">{r.target != null ? fmt(r.target) : "—"}</td>
                <td className={cn("px-3 py-2 text-right", r.level === "month" ? "text-ink-2" : "font-semibold text-ink")}>{r.won || "—"}</td>
                <td className="px-3 py-2 text-right"><DeltaChip actual={r.won} target={r.target} /></td>
                <td className="px-3 py-2 text-right text-ink-2">{r.confirmed || "—"}</td>
                <td className="px-3 py-2 text-right text-ink-2">{r.estimated || "—"}</td>
              </tr>
            );
          })}
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
