import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import { DeltaChip } from "@/components/jobs/DeltaChip";
import { cn } from "@/lib/utils";
import {
  DEAL_TYPE_LABELS, useJobsProjection,
  type ProjectionBucket, type ProjectionGranularity,
} from "@/services/jobs";

/**
 * Jobs projection (Kwame 2026-09-29): will the pipeline close the gap?
 *
 * Per period: the target, what has closed, the gap to target, and the roles
 * in flight (confirmed + estimated) that could close it. "Pipeline vs gap"
 * is what's left over (green) or still missing (red) if everything in flight
 * lands: closed + in flight − target.
 *
 * The bar in each row is a bullet chart: closed, confirmed and estimated
 * stacked from most to least certain (three distinct hues), with
 * a tick at the target. Past quarters (toggle) carry closed and target only:
 * an open deal whose close date has passed sits in "Past close date", not in
 * its old quarter.
 */
// Three distinct hues (Kwame 2026-09-29: the one-hue ramp was too close to
// tell apart). The app's own series colours, validated as a categorical set:
// CVD and normal-vision separation pass; amber is below 3:1 on white, which
// the numbers printed beside every bar cover.
const SEG = [
  { key: "won",       label: "Closed Won",      color: "#4242ea" },
  { key: "confirmed", label: "Confirmed Roles", color: "#0ea5a4" },
  { key: "estimated", label: "Estimated Roles", color: "#f59e0b" },
] as const;

type Row = {
  key: string; label: string; target: number | null; won: number; confirmed: number;
  estimated: number; kind: ProjectionBucket["kind"]; level: "quarter" | "month" | "catchall";
  bucket: ProjectionBucket;
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** One quarter's months rolled into a single bucket (quarter row + its drill). */
function rollUp(label: string, key: string, months: ProjectionBucket[]): ProjectionBucket {
  const sum = (k: "won" | "confirmed" | "estimated") => months.reduce((n, m) => n + m[k], 0);
  const targets = months.map((m) => m.target).filter((t): t is number => t != null);
  const kind = months.some((m) => m.kind === "current") ? "current" : months[0].kind;
  return {
    ...months[0], key, label, kind,
    won: sum("won"), confirmed: sum("confirmed"), estimated: sum("estimated"),
    total: sum("won") + sum("confirmed") + sum("estimated"),
    target: targets.length ? Math.round(targets.reduce((a, b) => a + b, 0)) : null,
    deals: months.flatMap((m) => m.deals),
  };
}

export function JobsProjectionChart({ granularity, showPast, owner, dealType, nameOf }: {
  granularity: ProjectionGranularity;
  showPast: boolean;
  owner?: string;
  dealType?: string;
  nameOf: (e: string | null) => string;
}) {
  const { data, isLoading, isError } = useJobsProjection(granularity, owner, dealType, showPast ? 4 : 0);
  const [drill, setDrill] = useState<ProjectionBucket | null>(null);

  if (isLoading) {
    return <div className="flex h-[140px] items-center justify-center text-ink-4"><Loader2 size={16} className="animate-spin" /></div>;
  }
  if (isError || !data) {
    return <div className="flex h-[100px] items-center justify-center text-[12px] text-ink-4">Couldn't load the projection.</div>;
  }

  const toRow = (b: ProjectionBucket, level: Row["level"]): Row => ({
    key: b.key, label: b.label, target: b.target, won: b.won, confirmed: b.confirmed,
    estimated: b.estimated, kind: b.kind, level, bucket: b,
  });
  const periods = data.buckets.filter((b) => b.start);
  const catchalls = data.buckets.filter((b) => !b.start);
  const rows: Row[] = [];
  let currentQuarter: ProjectionBucket | undefined;
  if (data.granularity === "month") {
    const byQ = new Map<string, ProjectionBucket[]>();
    for (const b of periods) (byQ.get(b.quarter!) ?? byQ.set(b.quarter!, []).get(b.quarter!)!).push(b);
    for (const [q, months] of byQ) {
      const qb = rollUp(months[0].quarter_label ?? q, `q-${q}`, months);
      if (qb.kind === "current") currentQuarter = qb;
      rows.push(toRow(qb, "quarter"));
      for (const m of months) rows.push(toRow(m, "month"));
    }
  } else {
    for (const b of periods) rows.push(toRow(b, "quarter"));
    currentQuarter = periods.find((b) => b.kind === "current");
  }
  for (const b of catchalls) rows.push(toRow(b, "catchall"));

  // One scale for every bar, so bars compare across rows. Month rows are
  // scaled against the largest month, quarters against the largest quarter,
  // or a month would always look tiny beside its own quarter.
  const scaleOf = (level: Row["level"]) => Math.max(1, ...rows.filter((r) => r.level === level)
    .map((r) => Math.max(r.target ?? 0, r.won + r.confirmed + r.estimated)));
  const scale = { quarter: scaleOf("quarter"), month: scaleOf("month"), catchall: scaleOf("catchall") };

  return (
    <div className="flex flex-col gap-3">
      {currentQuarter && <Headline b={currentQuarter} />}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-[12.5px] tabular-nums">
          <thead>
            <tr className="text-[9.5px] font-bold uppercase tracking-[.1em] text-ink-3">
              <th />
              <th colSpan={3} className="px-3 pb-0.5"><span className="block border-b border-border-strong pb-0.5 text-center">Closed</span></th>
              <th colSpan={4} className="px-3 pb-0.5"><span className="block border-b border-border-strong pb-0.5 text-center">In flight</span></th>
              <th />
            </tr>
            <tr className="border-b border-border-strong text-[10.5px] uppercase tracking-wider text-ink-3">
              <th className="py-1.5 pl-2 pr-3 text-left font-semibold">Period</th>
              <th className="px-3 py-1.5 text-right font-semibold">Target</th>
              <th className="px-3 py-1.5 text-right font-semibold">Closed Won</th>
              <th className="px-3 py-1.5 text-right font-semibold" title="Closed Won minus Target">Delta to Target</th>
              <th className="px-3 py-1.5 text-right font-semibold">Confirmed</th>
              <th className="px-3 py-1.5 text-right font-semibold">Estimated</th>
              <th className="px-3 py-1.5 text-right font-semibold" title="Confirmed + Estimated roles">In-flight</th>
              <th className="px-3 py-1.5 text-right font-semibold"
                title="Closed + in-flight − target: what's left over (green) or still missing (red) if everything in flight closes">
                Pipeline vs Gap
              </th>
              <th className="w-[240px] px-3 py-1.5 text-left font-semibold">Progress to target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const inflight = r.confirmed + r.estimated;
              const past = r.kind === "past";
              const firstCatchall = r.level === "catchall" && rows[i - 1]?.level !== "catchall";
              const quarterInMonthly = data.granularity === "month" && r.level === "quarter";
              const current = r.kind === "current" && r.level !== "month";
              return (
                <tr key={r.key}
                  onClick={() => r.bucket.deals.length && setDrill(r.bucket)}
                  title={r.bucket.deals.length ? "Show the deals" : undefined}
                  className={cn("border-t", r.bucket.deals.length && "cursor-pointer hover:bg-surface-2/60",
                    firstCatchall ? "border-t-2 border-border-strong" : quarterInMonthly && i > 0 ? "border-border-strong" : "border-border",
                    quarterInMonthly && "bg-surface-2/50",
                    current && "bg-accent-soft/40",
                    past && "text-ink-3")}>
                  <td className={cn("whitespace-nowrap py-2 pl-2 pr-3",
                    // The quarter we're in: an accent bar down its left edge
                    // on top of the row tint, instead of a label.
                    current && "shadow-[inset_3px_0_0_var(--accent)]",
                    r.level === "month" ? "pl-5 text-ink-2" : r.level === "catchall" ? "text-ink-3" : "font-semibold text-ink",
                    past && "text-ink-3")}>
                    {r.label}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-2">{r.target != null ? fmt(r.target) : "—"}</td>
                  <td className={cn("px-3 py-2 text-right", r.level === "month" ? "text-ink-2" : "font-semibold text-ink")}>{r.won || "—"}</td>
                  <td className="px-3 py-2 text-right"><DeltaChip actual={r.won} target={r.target} /></td>
                  <td className="px-3 py-2 text-right text-ink-2">{past ? "—" : r.confirmed || "—"}</td>
                  <td className="px-3 py-2 text-right text-ink-2">{past ? "—" : r.estimated || "—"}</td>
                  <td className={cn("px-3 py-2 text-right", r.level === "month" ? "text-ink-2" : "font-semibold text-ink")}>
                    {past ? "—" : inflight || "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {past ? <span className="text-ink-4">—</span> : <DeltaChip actual={r.won + inflight} target={r.target} />}
                  </td>
                  <td className="px-3 py-2">
                    <Bullet won={r.won} confirmed={past ? 0 : r.confirmed} estimated={past ? 0 : r.estimated}
                      target={r.target} scale={scale[r.level]} thin={r.level === "month"} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        {SEG.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-0.5 rounded bg-ink" />Target
        </span>
      </div>

      {drill && (
        <Drawer open onClose={() => setDrill(null)} title={`Jobs · ${drill.label}`} width={760}
          subtitle={`${drill.deals.length} deal${drill.deals.length === 1 ? "" : "s"} · ${drill.won} closed · ${drill.confirmed} confirmed · ${drill.estimated} estimated${drill.target != null ? ` · target ${fmt(drill.target)}` : ""}`}>
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Account</th>
                <th className="px-2 py-2 text-left font-semibold">Stage</th>
                <th className="px-2 py-2 text-left font-semibold">Owner</th>
                <th className="px-2 py-2 text-left font-semibold">Close</th>
                <th className="px-2 py-2 text-right font-semibold">Closed</th>
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

/** The current quarter at a glance: four figures, no sentence. Figures that
 *  need a target are left out until one is set. */
function Headline({ b }: { b: ProjectionBucket }) {
  const inflight = b.confirmed + b.estimated;
  const hasTarget = b.target != null;
  const toGo = hasTarget ? Math.max(0, b.target! - b.won) : null;
  const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-0.5 border-l border-border-strong pl-4 first:border-l-0 first:pl-0">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
      <span className="text-[17px] font-semibold leading-tight tabular-nums text-ink">{children}</span>
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border-strong border-l-[3px] border-l-accent bg-accent-soft/30 px-4 py-2.5">
      <span className="text-[13px] font-semibold text-ink">{b.label}</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Stat label="Closed">{b.won}{hasTarget && <span className="text-[13px] font-normal text-ink-3"> / {fmt(b.target!)}</span>}</Stat>
        {hasTarget && <Stat label="To go">{fmt(toGo!)}</Stat>}
        <Stat label="In flight">{inflight}</Stat>
        {hasTarget && <Stat label="Pipeline vs gap"><DeltaChip actual={b.won + inflight} target={b.target} /></Stat>}
      </div>
    </div>
  );
}

/** Bullet bar: closed, confirmed and estimated stacked, with a target tick. */
function Bullet({ won, confirmed, estimated, target, scale, thin }: {
  won: number; confirmed: number; estimated: number; target: number | null; scale: number; thin?: boolean;
}) {
  const pct = (n: number) => `${(100 * n) / scale}%`;
  const parts = [
    { n: won, c: SEG[0].color, label: "closed" },
    { n: confirmed, c: SEG[1].color, label: "confirmed" },
    { n: estimated, c: SEG[2].color, label: "estimated" },
  ].filter((p) => p.n > 0);
  const summary = `${won} closed, ${confirmed} confirmed, ${estimated} estimated${target != null ? `, target ${fmt(target)}` : ""}`;
  return (
    <div className="relative w-full" role="img" aria-label={summary} title={summary}>
      <div className={cn("flex w-full overflow-hidden rounded bg-surface-2", thin ? "h-2" : "h-3")}>
        {parts.map((p, i) => (
          <span key={p.label} style={{ width: pct(p.n), background: p.c }}
            // 2px surface gap between segments
            className={cn("h-full", i > 0 && "border-l-2 border-surface")} />
        ))}
      </div>
      {target != null && target > 0 && (
        <span className="absolute -top-1 bottom-[-4px] w-0.5 -translate-x-1/2 rounded bg-ink ring-2 ring-surface"
          style={{ left: pct(Math.min(target, scale)) }} />
      )}
    </div>
  );
}
