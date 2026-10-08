/**
 * Overview › Stage Flow: every stage from first outreach to Closed Won in one
 * table, for the weekly pipeline meeting (Kwame 2026-10-08).
 *
 * Two bands, each in its own unit: Outreach counts contacts (the membership
 * stage), Pipeline counts deals (the opportunity stage). Each working row shows
 * what sits in it now, split by time in the current stage (the same buckets as
 * Stage × Time in Pipeline), and what moved into it during the period against
 * the stage's weekly target. Closed Won and the off-ramps show movement only.
 *
 * Every number opens the records behind it. The drawer filters the same
 * `members` / `moved` arrays the counts were made from, so a list can never
 * disagree with its number.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";

import {
  useJobsStaff,
  useStageFlow,
  type OutreachGranularity,
  type StageFlow,
  type StageFlowBand,
  type StageFlowRow,
} from "@/services/jobs";
import { Drawer } from "@/components/ui/Drawer";
import { PeriodBar, defaultPeriod } from "@/components/jobs/PeriodBar";
import { DealTypeFilter, Panel, dealTypeParam, heatBlue } from "@/pages/jobs/JobsOpportunitiesOverview";
import { cn } from "@/lib/utils";

type Drill =
  | { kind: "now"; band: StageFlowBand; stage: string; label: string; bucket: number | null }
  | { kind: "moved"; band: StageFlowBand; stage: string; label: string };

const titleCaseEmail = (e: string) =>
  e.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** "5" for whole numbers, "2.9" otherwise: a prorated target can be fractional. */
const fmtTarget = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function StageFlowChart() {
  const [range, setRange] = useState<[string, string]>(() => defaultPeriod());
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  const [owner, setOwner] = useState("all");
  // Full time by default, as on the Pipeline tab. Applies to the deal band only.
  const [dealTypes, setDealTypes] = useState<string[]>(["ft"]);
  const [drill, setDrill] = useState<Drill | null>(null);

  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (staffQ.data ?? []).forEach((st) => { if (st.name) m.set(st.email.toLowerCase(), st.name); });
    return (email: string | null) => (email ? m.get(email.toLowerCase()) ?? titleCaseEmail(email) : "—");
  }, [staffQ.data]);

  const { data, isLoading, isError } = useStageFlow(range[0], range[1], owner, dealTypeParam(dealTypes));

  return (
    <Panel
      title="Stage Flow"
      desc="Every stage from first outreach to Closed Won: what sits there now, by time in stage, and what moved in during the period. Click any number for the list."
    >
      <div className="mb-3">
        <PeriodBar
          from={range[0]} to={range[1]}
          onChange={(f, t) => setRange([f, t])}
          granularity={granularity} onGranularityChange={setGranularity}
          clampToToday
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}
              className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent">
              <option value="all">All owners</option>
              {(staffQ.data ?? []).map((st) => (
                <option key={st.email} value={st.email}>{st.name || st.email.split("@")[0]}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2" title="Filters the Pipeline band only: contacts carry no deal type">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Deal type</span>
            <DealTypeFilter selected={dealTypes} onChange={setDealTypes} />
          </div>
        </PeriodBar>
      </div>

      {isLoading && !data ? (
        <div className="h-72 animate-pulse rounded-lg bg-surface-2" />
      ) : isError || !data ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[12.5px] text-ink-4">
          Couldn't load the stage flow. Refresh to try again.
        </div>
      ) : (
        <StageFlowTable data={data} onDrill={setDrill} />
      )}

      {drill && data && (
        <StageFlowDrill drill={drill} data={data} nameOf={nameOf} onClose={() => setDrill(null)} />
      )}
    </Panel>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

const TH = "px-1.5 pb-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4";

function StageFlowTable({ data, onDrill }: { data: StageFlow; onDrill: (d: Drill) => void }) {
  const cols = data.buckets.length + 4; // stage, in now, buckets, moved in, target
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[780px] border-collapse">
        <thead>
          <tr>
            <th className={cn(TH, "text-left")}>Stage</th>
            <th className={cn(TH, "text-right")} title="Sitting in this stage today">In now</th>
            {data.buckets.map((b) => (
              <th key={b.key} className={cn(TH, "text-center")} title="Time in the current stage">{b.label}</th>
            ))}
            <th className={cn(TH, "border-l border-border-strong pl-3 text-right")}
              title="Contacts or deals that entered this stage during the period">Moved in</th>
            <th className={cn(TH, "text-right")}>
              {data.targets_available ? (
                <span title="Weekly team target, prorated to the period">Target</span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  Target
                  <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-medium normal-case tracking-normal text-ink-3"
                    title="Stage targets arrive with the 2026-10-08 stage-targets migration">
                    pending migration
                  </span>
                </span>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.bands.map((band) => {
            // Shade per band: 700+ contacts would wash every deal cell out.
            const max = Math.max(1, ...band.rows.flatMap((r) => r.in_now?.cells ?? []));
            return [
              <tr key={`${band.key}-head`}>
                <td colSpan={cols} className="pb-1.5 pt-3 first:pt-0">
                  <div className="flex items-center gap-2 border-b border-border-strong pb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-ink-2">{band.label}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-3">{band.unit}</span>
                  </div>
                </td>
              </tr>,
              ...band.rows.map((row) => (
                <StageRow key={`${band.key}-${row.key}`} band={band.key} row={row} max={max}
                  bucketLabels={data.buckets.map((b) => b.label)} targetsOn={data.targets_available} onDrill={onDrill} />
              )),
            ];
          })}
        </tbody>
      </table>
      <p className="mt-2.5 text-[11px] leading-relaxed text-ink-4">
        Moved in counts each contact or deal once per stage it entered, so a deal that went from In Discussions to
        Opportunity Confirmed this period counts in both rows. Closed Won and Closed Lost count closes that stuck.
        Deal type filters the Pipeline band only.
      </p>
    </div>
  );
}

function StageRow({ band, row, max, bucketLabels, targetsOn, onDrill }: {
  band: StageFlowBand; row: StageFlowRow; max: number; bucketLabels: string[];
  targetsOn: boolean; onDrill: (d: Drill) => void;
}) {
  const movementOnly = row.in_now == null;
  const hit = row.target != null ? row.moved_in >= row.target : null;
  return (
    <tr className={cn(movementOnly && "text-ink-3")}>
      <td className={cn("whitespace-nowrap py-1 pr-2 text-[12.5px]", movementOnly ? "font-medium" : "font-semibold text-ink")}>
        {row.label}
      </td>
      <td className="px-1.5 py-1 text-right">
        {row.in_now ? (
          <NumButton n={row.in_now.total} title={`${row.in_now.total} in ${row.label} now`}
            onClick={() => onDrill({ kind: "now", band, stage: row.key, label: row.label, bucket: null })}
            className="text-[13px] font-bold text-ink" />
        ) : <span className="text-[12px] text-ink-4">—</span>}
      </td>
      {bucketLabels.map((lbl, i) => {
        if (!row.in_now) return <td key={i} className="p-1" />;
        const n = row.in_now.cells[i] ?? 0;
        const st = heatBlue(n, max);
        return (
          <td key={i} className="p-1">
            <button type="button" disabled={n === 0}
              onClick={() => onDrill({ kind: "now", band, stage: row.key, label: row.label, bucket: i })}
              title={n > 0 ? `${n} in ${row.label} for ${lbl}: click to list them` : undefined}
              className={cn("flex h-9 w-full items-center justify-center rounded-lg text-[13px] font-bold",
                n > 0 && "cursor-pointer transition-shadow hover:ring-2 hover:ring-accent/50")}
              style={{ background: st.background, color: st.color }}>
              {n}
            </button>
          </td>
        );
      })}
      <td className="border-l border-border-strong py-1 pl-3 pr-1.5 text-right">
        <NumButton n={row.moved_in} title={`${row.moved_in} moved into ${row.label} this period`}
          onClick={() => onDrill({ kind: "moved", band, stage: row.key, label: row.label })}
          className={cn("text-[13px] font-bold",
            hit === true ? "text-[var(--green)]" : hit === false ? "text-[var(--amber)]" : "text-ink")} />
      </td>
      <td className="py-1 pl-1.5 text-right text-[12px] tabular-nums text-ink-3"
        title={row.target_weekly != null ? `${row.target_weekly} a week` : undefined}>
        {!targetsOn || !row.targetable ? "—" : row.target != null ? fmtTarget(row.target) : (
          <span className="text-ink-4" title="No target set in Settings › Targets › Jobs">not set</span>
        )}
      </td>
    </tr>
  );
}

function NumButton({ n, onClick, title, className }: { n: number; onClick: () => void; title: string; className?: string }) {
  if (n === 0) return <span className="text-[13px] tabular-nums text-ink-4">0</span>;
  return (
    <button type="button" onClick={onClick} title={`${title}: click to list them`}
      className={cn("tabular-nums underline-offset-2 hover:text-accent hover:underline", className)}>
      {n}
    </button>
  );
}

// ── Drill drawer ─────────────────────────────────────────────────────────────

function StageFlowDrill({ drill, data, nameOf, onClose }: {
  drill: Drill; data: StageFlow; nameOf: (e: string | null) => string; onClose: () => void;
}) {
  const isContacts = drill.band === "outreach";
  const href = (id: string) => (isContacts ? `/jobs/contacts/${id}` : `/jobs/opportunities/${id}`);
  const noun = isContacts ? "contact" : "deal";

  const rows = drill.kind === "now"
    ? data.members
        .filter((m) => m.band === drill.band && m.stage === drill.stage && (drill.bucket == null || m.bucket === drill.bucket))
        .map((m) => ({ id: m.id, name: m.name, detail: m.detail, owner: m.owner, when: `${m.days}d` }))
    : data.moved
        .filter((m) => m.band === drill.band && m.stage === drill.stage)
        .map((m) => ({ id: m.id, name: m.name, detail: m.detail, owner: m.owner, when: format(new Date(m.at), "MMM d") }));

  const bucketLabel = drill.kind === "now" && drill.bucket != null ? data.buckets[drill.bucket]?.label : null;
  const periodLabel = `${format(new Date(`${data.period.from}T00:00:00`), "MMM d")} – ${format(new Date(`${data.period.to}T00:00:00`), "MMM d")}`;
  const note = drill.kind === "now"
    ? `In ${drill.label} now${bucketLabel ? ` · ${bucketLabel} in stage` : ""}`
    : `Moved into ${drill.label} · ${periodLabel}`;

  return (
    <Drawer open onClose={onClose} title={drill.label}
      subtitle={`${rows.length} ${noun}${rows.length === 1 ? "" : "s"} · ${note}`} width={720}>
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
                  <th className="px-3 py-2 font-semibold">{isContacts ? "Contact" : "Account"}</th>
                  <th className="px-2 py-2 font-semibold">{isContacts ? "Company" : "Opportunity"}</th>
                  <th className="px-2 py-2 font-semibold">Owner</th>
                  <th className="px-3 py-2 text-right font-semibold">{drill.kind === "now" ? "In stage" : "Moved"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border-strong hover:bg-surface-2/50">
                    <td className="px-3 py-1.5">
                      <Link to={href(r.id)} className="font-medium text-ink hover:text-accent hover:underline">{r.name || "—"}</Link>
                    </td>
                    <td className="truncate px-2 py-1.5 text-ink-3">{r.detail || "—"}</td>
                    <td className="truncate px-2 py-1.5 text-[11.5px] text-ink-3">{nameOf(r.owner)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[11.5px] text-ink-4">{r.when}</td>
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
