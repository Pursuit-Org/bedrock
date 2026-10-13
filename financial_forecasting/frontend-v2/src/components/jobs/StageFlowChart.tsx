/**
 * Overview › Stage Flow: every stage from first outreach to Closed Won in one
 * table, for the weekly pipeline meeting (Kwame 2026-10-08).
 *
 * Styled as Outreach's Activity Pipeline (the same header bar, rules, indent,
 * Δ chip, Trend and Activity / Owner tabs), so the two read as one system. Two
 * bands, each in its own unit: Outreach counts contacts, Pipeline counts
 * opportunities.
 *
 * Stage tab: Pool (in the stage now) and Net New (entered this period) carry
 * the meeting and are highlighted; then Target, Δ to Target and Trend (Net New
 * vs the period before). "Pool by time in stage" adds the Pool split by how
 * long it has sat there.
 *
 * Owner tab: the same stages, with Pool and Net New per Jobs team member, and
 * Others (anyone off the team, or nobody) so each row still adds up.
 *
 * A booked call ends one of three ways, so Contact closed sums Converted to
 * opportunity, Revisit and Not a fit, each indented beneath it. Closed does the
 * same for Closed Won and Closed Lost.
 *
 * Every number opens the records behind it. The drawer filters the same
 * `members` / `moved` arrays the counts were made from, so a list can never
 * disagree with its number.
 */
import { Fragment, useMemo, useState } from "react";
import { format } from "date-fns";
import { Zap } from "lucide-react";

import {
  useJobsStaff,
  useStageFlow,
  type OutreachGranularity,
  type StageFlow,
  type StageFlowBand,
  type StageFlowRow,
} from "@/services/jobs";
import { StageFlowWorkbench, type WorkbenchRecord } from "@/components/jobs/StageFlowWorkbench";
import { DeltaChip } from "@/components/jobs/DeltaChip";
import { PeriodBar, defaultPeriod } from "@/components/jobs/PeriodBar";
import { DealTypeFilter, dealTypeParam } from "@/pages/jobs/JobsOpportunitiesOverview";
import { Trend } from "@/pages/jobs/JobsOutreach";
import { useSessionState } from "@/lib/useSessionState";
import { useCurrentUser } from "@/services/auth";
import { cn } from "@/lib/utils";

type Tab = "stage" | "owner";

type Drill = {
  /** "activity" = the contacts behind an activity row's sends or calls. */
  kind: "now" | "moved" | "activity";
  band: StageFlowBand;
  stages: string[];
  label: string;
  /** A narrower cell (a time bucket or an owner): its label and exactly the
   *  `${id}:${stage}` records it counted. Null = the whole row. */
  col: { label: string; keys: Set<string> } | null;
  /** Activity drills: the row clicked (its key, unit and unlinked count). */
  activity?: StageFlowRow;
};

/** Band accents: a thin rule on the band header, so the two units read apart. */
const BAND_ACCENT: Record<StageFlowBand, string> = { outreach: "#2F7FE0", pipeline: "#6d5efc" };

const recKey = (r: { id: string; stage: string }) => `${r.id}:${r.stage}`;
const titleCaseEmail = (e: string) =>
  e.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
/** "Oct 5" from an ISO instant, by its UTC day: the counts bucket by UTC
 *  midnights, so a local-time date could land outside the period it counted in. */
const utcDay = (iso: string) => format(new Date(`${iso.slice(0, 10)}T00:00:00`), "MMM d");
const shortRange = (from: string, to: string) => `${utcDay(from)} – ${utcDay(to)}`;
/** "5" for whole numbers, "2.9" otherwise: a prorated target can be fractional. */
const fmtTarget = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function StageFlowChart() {
  const [range, setRange] = useState<[string, string]>(() => defaultPeriod());
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  // The Owner tab looks at one Jobs team member at a time; the Stage tab is the team.
  const [ownerPick, setOwnerPick] = useSessionState<string | null>("jobsOverview.stageFlow.owner", null);
  // Full time by default, as on the Pipeline tab. Applies to opportunities only.
  const [dealTypes, setDealTypes] = useState<string[]>(["ft"]);
  const [tab, setTab] = useSessionState<Tab>("jobsOverview.stageFlow.tab", "stage");
  const [byTime, setByTime] = useSessionState<boolean>("jobsOverview.stageFlow.byTime", false);
  const [drill, setDrill] = useState<Drill | null>(null);

  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (staffQ.data ?? []).forEach((st) => { if (st.name) m.set(st.email.toLowerCase(), st.name); });
    return (email: string | null) => (email ? m.get(email.toLowerCase()) ?? titleCaseEmail(email) : "—");
  }, [staffQ.data]);

  const me = useCurrentUser().data?.email?.toLowerCase() ?? null;
  // The team list rides on the team-scoped response, so it is there before a
  // person is picked; keepPreviousData holds it while a person's data loads.
  const teamQ = useStageFlow(range[0], range[1], "all", dealTypeParam(dealTypes));
  // The Jobs team only (Settings › Targets › Jobs › Team), in its set order.
  const team = teamQ.data?.team ?? [];
  // Default to yourself when you're on the team, else the first member.
  const owner = tab === "owner"
    ? (ownerPick && team.includes(ownerPick) ? ownerPick : (me && team.includes(me) ? me : team[0] ?? "all"))
    : "all";
  const personQ = useStageFlow(range[0], range[1], owner, dealTypeParam(dealTypes));
  const { data, isLoading, isError } = owner === "all" ? teamQ : personQ;
  const current = data && data.prev_period && data.stage_labels ? data : null;

  const tabs = (
    <div className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
      {([["stage", "Stage"], ["owner", "Owner"]] as const).map(([k, label]) => (
        <button key={k} type="button" onClick={() => setTab(k)}
          title={k === "stage" ? "The whole team: pool, activity, target and trend" : "One Jobs team member at a time, against their own targets"}
          className={cn("rounded px-2.5 py-0.5 text-[12px] font-medium transition-colors",
            tab === k ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2")}>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <PeriodBar
        from={range[0]} to={range[1]}
        onChange={(f, t) => setRange([f, t])}
        granularity={granularity} onGranularityChange={setGranularity}
        clampToToday
      >
        <div className="flex items-center gap-2" title="Filters the Pipeline band only: contacts carry no deal type">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Deal type</span>
          <DealTypeFilter selected={dealTypes} onChange={setDealTypes} />
        </div>
      </PeriodBar>

      <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border-strong bg-surface-2 px-4 py-2.5">
          <span className="text-[13px] font-bold text-ink-2">Stage Flow</span>
          {tabs}
          <span className="hidden text-[11.5px] text-ink-4 md:inline">Outreach to Closed Won · click any number for the list</span>
          {(
            <select value={byTime ? "time" : "off"} onChange={(e) => setByTime(e.target.value === "time")}
              title="Split the Pool by how long it has sat in the stage"
              className="ml-auto h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent">
              <option value="off">No breakdown</option>
              <option value="time">Pool by time in stage</option>
            </select>
          )}
        </div>
        {tab === "owner" && team.length > 0 && (
          <OwnerPicker team={team} selected={owner} nameOf={nameOf} onPick={setOwnerPick} />
        )}
        {isLoading && !data ? (
          <div className="m-4 h-72 animate-pulse rounded-lg bg-surface-2" />
        ) : isError || !data ? (
          <div className="m-4 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[12.5px] text-ink-4">
            Couldn't load the stage flow. Refresh to try again.
          </div>
        ) : !current ? (
          // An API older than this page (the backend doesn't hot-reload after
          // a pull) returns the earlier shape. Say so instead of crashing.
          <div className="m-4 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[12.5px] text-ink-3">
            The backend is older than this page. Restart it (Ctrl+C, then <code>python main.py</code>) and refresh.
          </div>
        ) : (
          <StageTable data={current} byTime={byTime} nameOf={nameOf} onDrill={setDrill} />
        )}
        {current && (
          <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-ink-4">
            Pool is what sits in each stage today. Net New counts each contact or opportunity once per stage it entered
            during the period. Closed Won and Closed Lost count closes that stuck. Targets are weekly, prorated to the
            period; the Owner tab shows each person against their own
            {current.targets_available ? "" : "; per-stage targets arrive with the stage-targets migration, and Converted to opportunity uses the Settings outreach target until then"}.
            Rows marked ⚡ count activity, not contacts: every send or call the team logged in the period, exactly as
            Outreach › Activity Pipeline counts it, against the Settings outreach targets.
            Deal type filters the Pipeline band only.
          </p>
        )}
      </div>

      {drill && current && (
        <StageFlowDrill drill={drill} data={current} nameOf={nameOf} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

// ── Shared pieces ────────────────────────────────────────────────────────────

// Stage (Pool) and Activity (Net New) each carry their own soft tint, header to
// last row, so the two kinds of number read apart at a glance.
const STAGE_ACCENT = "#2F7FE0";
const ACTIVITY_ACCENT = "#6d5efc";
const HL = "bg-accent-soft";
const HL_ACT = "bg-[#6d5efc]/[0.07]";

/** A column-group heading: a coloured rule, the label, and an optional sub-label. */
function GroupCap({ label, sub, color }: { label: string; sub?: string; color: string }) {
  return (
    <div className="flex flex-col items-center gap-1 pb-1">
      <span className="h-[3px] w-full rounded-full" style={{ background: color, opacity: 0.85 }} />
      <span className="flex items-baseline gap-1.5">
        <span className="font-bold" style={{ color }}>{label}</span>
        {sub && <span className="font-medium normal-case tracking-normal text-ink-4">{sub}</span>}
      </span>
    </div>
  );
}
const TH = "whitespace-nowrap px-4 py-2 text-center font-bold align-bottom";
const SUB = "mt-0.5 block h-3.5 text-[10px] font-normal normal-case tracking-normal text-ink-4";
const TD = "px-4 py-2.5 text-center tabular-nums";

/** Records in a row (summary rows span their children's stages). */
const stagesOf = (row: StageFlowRow) => row.children ?? [row.key];

function BandHeader({ band, colSpan, pool }: {
  band: StageFlow["bands"][number]; colSpan: number; pool: number;
}) {
  return (
    <tr className="border-t-2 border-border bg-bg">
      <td colSpan={colSpan} className="py-2 pl-3.5 pr-4">
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-1 rounded-full" style={{ background: BAND_ACCENT[band.key] }} />
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-2">{band.label}</span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-3">
            {band.unit.charAt(0).toUpperCase() + band.unit.slice(1)}
          </span>
          <span className="ml-auto text-[11px] tabular-nums text-ink-4">{pool.toLocaleString()} in the pool</span>
        </div>
      </td>
    </tr>
  );
}

function StageLabel({ row }: { row: StageFlowRow }) {
  const depth = row.depth ?? 0;
  const pending = !row.available;
  return (
    <td className={cn("whitespace-nowrap py-2.5 pr-4 text-left",
      depth === 0 ? "font-semibold" : "font-normal",
      pending ? "text-ink-4" : "text-ink")}
      style={{ paddingLeft: `${14 + depth * 20}px` }}>
      {depth > 0 && <span className="mr-1.5 text-ink-4">↳</span>}
      {row.label}
      {pending && <span className="ml-2 text-[10.5px] uppercase tracking-wide text-ink-4">pending migration</span>}
    </td>
  );
}

function NumButton({ n, onClick, title, className }: { n: number; onClick: () => void; title: string; className?: string }) {
  if (n === 0) return <span className="font-normal text-ink-4">0</span>;
  return (
    <button type="button" onClick={onClick} title={`${title}: click to list them`}
      className={cn("tabular-nums underline-offset-2 hover:text-accent hover:underline", className)}>
      {n.toLocaleString()}
    </button>
  );
}

// ── Stage tab ────────────────────────────────────────────────────────────────

function StageTable({ data, byTime, nameOf, onDrill }: {
  data: StageFlow; byTime: boolean; nameOf: (e: string | null) => string; onDrill: (d: Drill) => void;
}) {
  const cols = byTime ? data.buckets : [];
  // Blank for the team (the default); a person's name when the Owner filter picks one.
  const scopeLabel = data.target_scope === "team" ? "" : nameOf(data.target_scope);
  const colCount = 6 + cols.length;
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full border-collapse", byTime ? "min-w-[1080px]" : "min-w-[860px]")}>
        <colgroup>
          <col style={{ width: byTime ? "21%" : "28%" }} />
          {[0, 1, 2, 3, 4].map((i) => <col key={i} style={{ width: byTime ? "9%" : "14.4%" }} />)}
          {cols.map((c) => <col key={c.key} style={{ width: "6.8%" }} />)}
        </colgroup>
        <thead>
          {/* Two groups the reader should never confuse: where things sit
              (Stage, as of today) and what happened (Activity, in the period). */}
          <tr className="bg-surface-2 text-[10px] uppercase tracking-[0.08em]">
            <th />
            <th className={cn("px-3 pt-2.5", HL)}>
              <GroupCap label="Stage" sub="as of today" color={STAGE_ACCENT} />
            </th>
            <th colSpan={4} className="border-l-2 border-border-strong px-3 pt-2.5">
              <GroupCap label="Activity" sub={shortRange(data.period.from, data.period.to)} color={ACTIVITY_ACCENT} />
            </th>
            {cols.length > 0 && (
              <th colSpan={cols.length} className="border-l border-border-strong px-3 pt-2.5">
                <GroupCap label="Pool by time in stage" color={STAGE_ACCENT} />
              </th>
            )}
          </tr>
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="py-2 pl-3.5 pr-2 text-left font-bold align-bottom">Stage</th>
            <th className={cn(TH, HL)} title="Sitting in this stage today">
              <span className="block">Pool</span><span className={SUB} />
            </th>
            <th className={cn(TH, HL_ACT, "border-l-2 border-border-strong")} title="Entered this stage during the period">
              <span className="block">Net New</span><span className={SUB} />
            </th>
            <th className={TH} title="Weekly target, prorated to the period; follows the Owner filter">
              <span className="block">Target</span><span className={SUB}>{scopeLabel}</span>
            </th>
            <th className={TH}><span className="block">Δ to Target</span><span className={SUB} /></th>
            <th className={TH} title="Net New against the period before, same length">
              <span className="block">Trend</span>
              <span className={SUB}>vs {shortRange(data.prev_period.from, data.prev_period.to)}</span>
            </th>
            {cols.map((c, i) => (
              <th key={c.key} className={cn("whitespace-nowrap px-2 py-2 text-center font-semibold align-bottom text-ink-4",
                i === 0 && "border-l border-border-strong")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.bands.map((band) => {
            const bandMembers = data.members.filter((m) => m.band === band.key);
            const pool = band.rows.filter((r) => (r.depth ?? 0) === 0).reduce((s, r) => s + (r.in_now?.total ?? 0), 0);
            return (
              <Fragment key={band.key}>
                <BandHeader band={band} colSpan={colCount} pool={pool} />
                {band.rows.map((row) => {
                  if (row.kind === "activity") {
                    return <ActivityRow key={row.key} row={row} cols={cols.length}
                      onDrill={() => onDrill({ kind: "activity", band: band.key, stages: [row.key], label: row.label, col: null, activity: row })} />;
                  }
                  const stages = stagesOf(row);
                  const inRow = bandMembers.filter((m) => stages.includes(m.stage));
                  const pending = !row.available;
                  const drillRow = (kind: "now" | "moved") =>
                    onDrill({ kind, band: band.key, stages, label: row.label, col: null });
                  const targetTitle = row.target_source === "outreach"
                    ? `From Settings › Targets › Jobs › Outreach: ${row.target_source_label ?? "outreach target"}, until a stage target is set`
                    : row.target_weekly != null ? `${row.target_weekly} a week` : undefined;
                  return (
                    <tr key={row.key}
                      className={cn("border-b border-border text-[13.5px] transition-colors hover:bg-surface-2/40",
                        row.children && "border-t border-border-strong")}>
                      <StageLabel row={row} />
                      <td className={cn(TD, HL)}>
                        {pending || !row.in_now ? <span className="text-ink-4">—</span> : (
                          <span className={cn((row.depth ?? 0) === 0 && "font-semibold")}>
                            <NumButton n={row.in_now.total} onClick={() => drillRow("now")}
                              title={`${row.in_now.total} in ${row.label} now`} />
                          </span>
                        )}
                      </td>
                      <td className={cn(TD, HL_ACT, "border-l-2 border-border-strong", (row.depth ?? 0) === 0 && "font-semibold")}>
                        {pending ? <span className="text-ink-4">—</span>
                          : <NumButton n={row.moved_in} onClick={() => drillRow("moved")} title={`${row.moved_in} net new in ${row.label}`} />}
                      </td>
                      <td className={cn(TD, "text-ink-3")} title={targetTitle}>
                        {pending || !row.targetable ? "—" : row.target != null ? fmtTarget(row.target) : (
                          <span className="text-[12px] text-ink-4"
                            title={data.targets_available ? "No target set in Settings › Targets › Jobs" : "Stage targets arrive with the stage-targets migration"}>
                            {data.targets_available ? "not set" : "—"}
                          </span>
                        )}
                      </td>
                      <td className={TD}>
                        {pending || row.target == null ? <span className="text-ink-4">—</span>
                          : <DeltaChip actual={row.moved_in} target={row.target} />}
                      </td>
                      <td className={cn(TD, "text-[12.5px]")}>
                        {pending ? <span className="text-ink-4">—</span> : <Trend current={row.moved_in} prior={row.prev_moved_in} />}
                      </td>
                      {cols.map((c, i) => {
                        const recs = inRow.filter((m) => data.buckets[m.bucket]?.key === c.key);
                        return (
                          <td key={c.key} className={cn("px-2 py-2.5 text-center text-[12.5px] tabular-nums text-ink-2",
                            i === 0 && "border-l border-border-strong")}>
                            {!row.in_now || pending ? null : recs.length === 0 ? <span className="text-ink-4">·</span> : (
                              <NumButton n={recs.length} title={`${recs.length} in ${row.label} · ${c.label}`}
                                onClick={() => onDrill({ kind: "now", band: band.key, stages, label: row.label,
                                  col: { label: `${c.label} in stage`, keys: new Set(recs.map(recKey)) } })} />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Sends or calls logged in the period, under the stage that work moves. Same
 *  columns as a stage row so the target, gap and trend read across, but a
 *  violet bolt and a lighter weight mark it as a count of events: one contact
 *  emailed three times is 3 here and 1 on the stage row above. */
function ActivityRow({ row, cols, onDrill }: { row: StageFlowRow; cols: number; onDrill: () => void }) {
  const pending = !row.available;
  const unit = row.key === "outreach_sent" ? "sends" : "calls";
  const targetTitle = row.target_weekly != null
    ? `${row.target_weekly} a week, from Settings › Targets › Jobs › Outreach: ${row.target_source_label ?? ""}`
    : `No ${row.target_source_label ?? "outreach"} target set in Settings › Targets › Jobs › Outreach`;
  return (
    <tr className="border-b border-border text-[12.5px] transition-colors hover:bg-surface-2/40"
      title={`Activity: ${unit} logged in the period, as Outreach › Activity Pipeline counts them`}>
      <td className={cn("py-2 pr-4 text-left", pending ? "text-ink-4" : "text-ink-2")} style={{ paddingLeft: "34px" }}>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <Zap size={12} className="shrink-0" style={{ color: ACTIVITY_ACCENT }} aria-hidden />
          <span className="font-medium">{row.label}</span>
          {pending && <span className="ml-1 text-[10.5px] uppercase tracking-wide text-ink-4">pending migration</span>}
        </span>
        {!pending && row.breakdown && (
          <span className="mt-0.5 block whitespace-nowrap pl-[18px] text-[11px] tabular-nums text-ink-4">
            {row.breakdown.map((b) => `${b.label} ${b.n.toLocaleString()}`).join(" · ")}
          </span>
        )}
      </td>
      <td className={cn(TD, HL, "py-2 text-ink-4")} title="Activity has no pool">·</td>
      <td className={cn(TD, HL_ACT, "border-l-2 border-border-strong py-2")}>
        {pending ? <span className="text-ink-4">—</span>
          : <NumButton n={row.moved_in} onClick={onDrill} title={`${row.moved_in} ${unit} logged`} />}
      </td>
      <td className={cn(TD, "py-2 text-ink-3")} title={targetTitle}>
        {pending || row.target == null ? <span className="text-ink-4">—</span> : fmtTarget(row.target)}
      </td>
      <td className={cn(TD, "py-2")}>
        {pending || row.target == null ? <span className="text-ink-4">—</span>
          : <DeltaChip actual={row.moved_in} target={row.target} />}
      </td>
      <td className={cn(TD, "py-2 text-[12px]")}>
        {pending ? <span className="text-ink-4">—</span> : <Trend current={row.moved_in} prior={row.prev_moved_in} />}
      </td>
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className={cn("px-2 py-2", i === 0 && "border-l border-border-strong")} />
      ))}
    </tr>
  );
}

// ── Owner tab: pick one person ───────────────────────────────────────────────

/** One button per Jobs team member, styled as the Stage / Owner tabs so the
 *  two read as one control; the table below shows whoever is picked. */
function OwnerPicker({ team, selected, nameOf, onPick }: {
  team: string[]; selected: string; nameOf: (e: string | null) => string; onPick: (e: string) => void;
}) {
  return (
    <div className="border-b border-border-strong px-4 py-2">
      <div className="inline-flex flex-wrap items-center rounded-md border border-border-strong bg-surface p-0.5"
        role="tablist" aria-label="Jobs team member">
        {team.map((email) => {
          const on = email === selected;
          return (
            <button key={email} type="button" role="tab" aria-selected={on} onClick={() => onPick(email)}
              className={cn("rounded px-2.5 py-0.5 text-[12px] font-medium transition-colors",
                on ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2")}>
              {nameOf(email)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Drill: the records behind a number, as a working list ──────────────────

function StageFlowDrill({ drill, data, nameOf, onClose }: {
  drill: Drill; data: StageFlow; nameOf: (e: string | null) => string; onClose: () => void;
}) {
  const isContacts = drill.band === "outreach";
  const stageLabel = (s: string | null) => (s ? data.stage_labels[s] ?? s : "—");
  const inCell = (r: { id: string; stage: string }) => drill.col == null || drill.col.keys.has(recKey(r));

  // Exactly the records the clicked number counted; the workbench fetches
  // their full rows and keeps this as context (time in stage, when they moved).
  if (drill.kind === "activity" && drill.activity) {
    return <ActivityDrill drill={drill} row={drill.activity} data={data} nameOf={nameOf} onClose={onClose} />;
  }
  const records: WorkbenchRecord[] = drill.kind === "now"
    ? data.members
        .filter((m) => m.band === drill.band && drill.stages.includes(m.stage) && inCell(m))
        .map((m) => ({ id: m.id, stage: m.stage, when: `${m.days}d` }))
    : data.moved
        .filter((m) => m.band === drill.band && drill.stages.includes(m.stage) && inCell(m))
        .map((m) => ({ id: m.id, stage: m.stage, when: utcDay(m.at), from: m.from }));
  const n = new Set(records.map((r) => r.id)).size;

  const noun = isContacts ? (n === 1 ? "contact" : "contacts") : (n === 1 ? "opportunity" : "opportunities");
  const where = drill.col ? ` · ${drill.col.label}` : "";
  const note = drill.kind === "now"
    ? `In ${drill.label} now${where}`
    : `Net new in ${drill.label} · ${shortRange(data.period.from, data.period.to)}${where}`;

  return (
    <StageFlowWorkbench band={drill.band} title={drill.label} subtitle={`${n} ${noun} · ${note}`}
      isPool={drill.kind === "now"} records={records} stageLabel={stageLabel} nameOf={nameOf} onClose={onClose} />
  );
}

/** The contacts behind an activity number, in the same working list, with how
 *  many sends or calls each got and when the last one was. */
function ActivityDrill({ drill, row, data, nameOf, onClose }: {
  drill: Drill; row: StageFlowRow; data: StageFlow; nameOf: (e: string | null) => string; onClose: () => void;
}) {
  const unit = row.key === "outreach_sent" ? "send" : "call";
  const entries = (data.activity ?? []).filter((a) => a.row === row.key).sort((a, b) => b.n - a.n);
  const records: WorkbenchRecord[] = entries.map((a) => ({
    id: a.id, stage: row.key, when: a.at ? utcDay(a.at) : "—",
    extra: [a.n.toLocaleString(), a.at ? utcDay(a.at) : "—"],
  }));
  const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
  const unlinked = row.unlinked ? ` · ${plural(row.unlinked, unit)} with no linked contact` : "";
  const stageLabel = (s: string | null) => (s ? data.stage_labels[s] ?? s : "—");
  return (
    <StageFlowWorkbench band="outreach" title={drill.label}
      subtitle={`${plural(row.moved_in, unit)} to ${plural(records.length, "contact")} · ${shortRange(data.period.from, data.period.to)}${unlinked}`}
      isPool={false} contextHead={[unit === "send" ? "Sends" : "Calls", "Last"]}
      records={records} stageLabel={stageLabel} nameOf={nameOf} onClose={onClose} />
  );
}
