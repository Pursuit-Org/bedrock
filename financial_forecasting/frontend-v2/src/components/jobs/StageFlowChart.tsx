/**
 * Overview › Stage Flow: every stage from first outreach to Closed Won in one
 * table, for the weekly pipeline meeting (Kwame 2026-10-08).
 *
 * Styled as Outreach's Activity Pipeline (the same header bar, rules, indent,
 * Δ chip and Trend), so the two tables read as one system. Two bands, each in
 * its own unit: Outreach counts contacts, Pipeline counts opportunities.
 *
 * Columns: Pool (in the stage now) and Moved in (entered this period) carry the
 * meeting and are highlighted; then Target, Δ to target and Trend (Moved in vs
 * the period before). Breakdown, picked in the card header, adds plain-number
 * columns splitting the Pool by time in stage or by owner.
 *
 * A booked call ends one of three ways, so Contact closed sums Converted to
 * opportunity, Revisit and Not a fit, each indented beneath it.
 *
 * Every number opens the records behind it. The drawer filters the same
 * `members` / `moved` arrays the counts were made from, so a list can never
 * disagree with its number.
 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";

import {
  useJobsStaff,
  useStageFlow,
  type OutreachGranularity,
  type StageFlow,
  type StageFlowBand,
  type StageFlowMember,
  type StageFlowRow,
} from "@/services/jobs";
import { Drawer } from "@/components/ui/Drawer";
import { DeltaChip } from "@/components/jobs/DeltaChip";
import { PeriodBar, defaultPeriod } from "@/components/jobs/PeriodBar";
import { DealTypeFilter, dealTypeParam } from "@/pages/jobs/JobsOpportunitiesOverview";
import { Trend } from "@/pages/jobs/JobsOutreach";
import { useSessionState } from "@/lib/useSessionState";
import { cn } from "@/lib/utils";

type Cut = "off" | "time" | "owner";
const CUTS: { key: Cut; label: string }[] = [
  { key: "off", label: "No breakdown" },
  { key: "time", label: "Pool by time in stage" },
  { key: "owner", label: "Pool by owner" },
];

type Drill =
  | { kind: "now"; band: StageFlowBand; stages: string[]; label: string;
      /** A breakdown cell: its label and exactly the members it counted. */
      col: { label: string; ids: Set<string> } | null }
  | { kind: "moved"; band: StageFlowBand; stages: string[]; label: string };

const UNASSIGNED = "(unassigned)";
const OTHER = "(other)";
/** Owner columns past this many fold into "Other", so the table stays readable. */
const MAX_OWNER_COLS = 6;
type CutCol = { key: string; label: string };

const ownerKey = (e: string | null) => (e ? e.toLowerCase() : UNASSIGNED);
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
  const [owner, setOwner] = useState("all");
  // Full time by default, as on the Pipeline tab. Applies to opportunities only.
  const [dealTypes, setDealTypes] = useState<string[]>(["ft"]);
  const [cut, setCut] = useSessionState<Cut>("jobsOverview.stageFlow.cut", "off");
  const [drill, setDrill] = useState<Drill | null>(null);

  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (staffQ.data ?? []).forEach((st) => { if (st.name) m.set(st.email.toLowerCase(), st.name); });
    return (email: string | null) => (email ? m.get(email.toLowerCase()) ?? titleCaseEmail(email) : "—");
  }, [staffQ.data]);

  const { data, isLoading, isError } = useStageFlow(range[0], range[1], owner, dealTypeParam(dealTypes));

  return (
    <div className="flex flex-col gap-3">
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

      <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2 px-4 py-2.5">
          <span className="text-[13px] font-bold text-ink-2">Stage Flow</span>
          <span className="text-[11.5px] text-ink-4">Outreach to Closed Won · click any number for the list</span>
          <select value={cut} onChange={(e) => setCut(e.target.value as Cut)} title="Add breakdown columns"
            className="ml-auto h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent">
            {CUTS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </div>
        {isLoading && !data ? (
          <div className="m-4 h-72 animate-pulse rounded-lg bg-surface-2" />
        ) : isError || !data ? (
          <div className="m-4 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[12.5px] text-ink-4">
            Couldn't load the stage flow. Refresh to try again.
          </div>
        ) : !data.prev_period || !data.stage_labels ? (
          // An API older than this page (the backend doesn't hot-reload after
          // a pull) returns the earlier shape. Say so instead of crashing.
          <div className="m-4 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[12.5px] text-ink-3">
            The backend is older than this page. Restart it (Ctrl+C, then <code>python main.py</code>) and refresh.
          </div>
        ) : (
          <StageFlowTable data={data} cut={cut} nameOf={nameOf} onDrill={setDrill} />
        )}
      </div>

      {drill && data?.stage_labels && (
        <StageFlowDrill drill={drill} data={data} nameOf={nameOf} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

// The two headline columns share one soft tint, header to last row.
const HL = "bg-accent-soft";

function StageFlowTable({ data, cut, nameOf, onDrill }: {
  data: StageFlow; cut: Cut; nameOf: (e: string | null) => string; onDrill: (d: Drill) => void;
}) {
  // Owner columns: whoever holds the most of the Pool, the long tail as Other.
  const ownerCols = useMemo<CutCol[]>(() => {
    const counts = new Map<string, number>();
    data.members.forEach((m) => counts.set(ownerKey(m.owner), (counts.get(ownerKey(m.owner)) ?? 0) + 1));
    const ranked = [...counts.entries()].filter(([k]) => k !== UNASSIGNED).sort((a, b) => b[1] - a[1]);
    const cols: CutCol[] = ranked.slice(0, MAX_OWNER_COLS).map(([k]) => ({ key: k, label: nameOf(k).split(" ")[0] }));
    if (ranked.length > MAX_OWNER_COLS) cols.push({ key: OTHER, label: "Other" });
    if (counts.has(UNASSIGNED)) cols.push({ key: UNASSIGNED, label: "Unassigned" });
    return cols;
  }, [data.members, nameOf]);
  const shownOwners = useMemo(() => new Set(ownerCols.map((c) => c.key)), [ownerCols]);

  const cols: CutCol[] = cut === "time" ? data.buckets : cut === "owner" ? ownerCols : [];
  /** Which breakdown column a member falls in. */
  const colOf = (m: StageFlowMember): string =>
    cut === "time" ? data.buckets[m.bucket]?.key ?? ""
      : shownOwners.has(ownerKey(m.owner)) ? ownerKey(m.owner) : OTHER;

  const scopeLabel = data.target_scope === "team" ? "Team" : nameOf(data.target_scope);
  const colCount = 6 + cols.length;
  const thBase = "whitespace-nowrap px-3 py-2 text-center font-bold align-bottom";
  const sub = "mt-0.5 block h-3.5 text-[10px] font-normal normal-case tracking-normal text-ink-4";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="w-full py-2 pl-3.5 pr-2 text-left font-bold align-bottom">Stage</th>
            <th className={cn(thBase, HL)} title="Sitting in this stage today">
              <span className="block">Pool</span><span className={sub}>in stage now</span>
            </th>
            <th className={cn(thBase, HL)} title="Entered this stage during the period">
              <span className="block">Moved in</span>
              <span className={sub}>{shortRange(data.period.from, data.period.to)}</span>
            </th>
            <th className={thBase} title="Weekly target, prorated to the period; follows the Owner filter">
              <span className="block">Target</span><span className={sub}>{scopeLabel}</span>
            </th>
            <th className={thBase}>
              <span className="block">Δ to Target</span><span className={sub} />
            </th>
            <th className={thBase} title="Moved in against the period before, same length">
              <span className="block">Trend</span>
              <span className={sub}>vs {shortRange(data.prev_period.from, data.prev_period.to)}</span>
            </th>
            {cols.map((c, i) => (
              <th key={c.key}
                className={cn("whitespace-nowrap px-2 py-2 text-center font-semibold align-bottom text-ink-4",
                  i === 0 && "border-l border-border-strong")}
                title={cut === "owner" && c.key !== OTHER && c.key !== UNASSIGNED ? nameOf(c.key) : undefined}>
                {i === 0 && <span className="mb-0.5 block text-left text-[9.5px] text-ink-3">Pool by {cut === "time" ? "time in stage" : "owner"}</span>}
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.bands.map((band) => {
            const bandMembers = data.members.filter((m) => m.band === band.key);
            return (
              <Fragment key={band.key}>
                <tr className="border-t-2 border-border bg-bg">
                  <td colSpan={colCount} className="py-1.5 pl-3.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-ink-2">{band.label}</span>
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-3">{band.unit}</span>
                  </td>
                </tr>
                {band.rows.map((row) => {
                  const stages = row.children ?? [row.key];
                  const inRow = bandMembers.filter((m) => stages.includes(m.stage));
                  const cells = cols.map((c) => inRow.filter((m) => colOf(m) === c.key));
                  return (
                    <StageRow key={row.key} row={row} targetsOn={data.targets_available}
                      cells={row.in_now ? cells : null} cols={cols}
                      onPool={() => onDrill({ kind: "now", band: band.key, stages, label: row.label, col: null })}
                      onMoved={() => onDrill({ kind: "moved", band: band.key, stages, label: row.label })}
                      onCell={(i) => onDrill({ kind: "now", band: band.key, stages, label: row.label,
                        col: { label: cut === "time" ? `${cols[i].label} in stage` : `owner: ${cols[i].label}`,
                               ids: new Set(cells[i].map((m) => m.id)) } })} />
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-ink-4">
        Pool is what sits in each stage today. Moved in counts each contact or opportunity once per stage it entered
        during the period. Closed Won and Closed Lost count closes that stuck. Targets are weekly, prorated to the
        period, and follow the Owner filter
        {data.targets_available ? "" : "; per-stage targets arrive with the stage-targets migration, and Converted to opportunity uses the Settings outreach target until then"}.
        Deal type filters the Pipeline band only.
      </p>
    </div>
  );
}

function StageRow({ row, targetsOn, cells, cols, onPool, onMoved, onCell }: {
  row: StageFlowRow; targetsOn: boolean; cells: StageFlowMember[][] | null; cols: CutCol[];
  onPool: () => void; onMoved: () => void; onCell: (i: number) => void;
}) {
  const pending = !row.available;
  const isGroup = !!row.children;
  const depth = row.depth ?? 0;
  const td = "px-3 py-2.5 text-center tabular-nums";
  const targetTitle = row.target_source === "outreach"
    ? "From Settings › Targets › Jobs › Outreach: Opportunities converted"
    : row.target_weekly != null ? `${row.target_weekly} a week` : undefined;
  return (
    <tr className={cn("border-b border-border text-[13.5px] last:border-b-0", isGroup && "border-t border-border-strong")}>
      <td className={cn("py-2.5 pr-3.5 text-left",
        depth === 0 ? "font-semibold" : "font-normal",
        pending ? "text-ink-4" : depth === 0 ? "text-ink" : "text-ink-2")}
        style={{ paddingLeft: `${14 + depth * 18}px` }}>
        {row.label}
        {pending && <span className="ml-2 text-[10.5px] uppercase tracking-wide text-ink-4">pending migration</span>}
      </td>
      <td className={cn(td, HL, depth === 0 && "font-semibold")}>
        {pending || !row.in_now ? <span className="font-normal text-ink-4">—</span>
          : <NumButton n={row.in_now.total} onClick={onPool} title={`${row.in_now.total} in ${row.label} now`} />}
      </td>
      <td className={cn(td, HL, depth === 0 && "font-semibold")}>
        {pending ? <span className="font-normal text-ink-4">—</span>
          : <NumButton n={row.moved_in} onClick={onMoved} title={`${row.moved_in} moved into ${row.label}`} />}
      </td>
      <td className={cn(td, "text-ink-3")} title={targetTitle}>
        {pending || !row.targetable ? "—" : row.target != null ? fmtTarget(row.target) : (
          <span className="text-[12px] text-ink-4"
            title={targetsOn ? "No target set in Settings › Targets › Jobs" : "Stage targets arrive with the stage-targets migration"}>
            {targetsOn ? "not set" : "—"}
          </span>
        )}
      </td>
      <td className={td}>
        {pending || row.target == null ? <span className="text-ink-4">—</span>
          : <DeltaChip actual={row.moved_in} target={row.target} />}
      </td>
      <td className={cn(td, "text-[12.5px]")}>
        {pending ? <span className="text-ink-4">—</span> : <Trend current={row.moved_in} prior={row.prev_moved_in} />}
      </td>
      {cols.map((c, i) => {
        const n = cells?.[i]?.length ?? 0;
        return (
          <td key={c.key} className={cn("px-2 py-2.5 text-center text-[12.5px] tabular-nums text-ink-2",
            i === 0 && "border-l border-border-strong")}>
            {!cells || pending ? null : n === 0 ? <span className="text-ink-4">·</span> : (
              <button type="button" onClick={() => onCell(i)} title={`${n} in ${row.label} · ${c.label}: click to list them`}
                className="underline-offset-2 hover:text-accent hover:underline">{n}</button>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function NumButton({ n, onClick, title }: { n: number; onClick: () => void; title: string }) {
  if (n === 0) return <span className="font-normal text-ink-4">0</span>;
  return (
    <button type="button" onClick={onClick} title={`${title}: click to list them`}
      className="tabular-nums underline-offset-2 hover:text-accent hover:underline">
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
  const stageLabel = (s: string | null) => (s ? data.stage_labels[s] ?? s : "—");
  // Contact closed spans three stages, so its list says which one each landed in.
  const multi = drill.stages.length > 1;

  const rows = drill.kind === "now"
    ? data.members
        .filter((m) => m.band === drill.band && drill.stages.includes(m.stage) && (drill.col == null || drill.col.ids.has(m.id)))
        .map((m) => ({ key: `${m.id}:${m.stage}`, id: m.id, name: m.name, detail: m.detail, owner: m.owner,
                       stage: m.stage, from: null as string | null, when: `${m.days}d` }))
    : data.moved
        .filter((m) => m.band === drill.band && drill.stages.includes(m.stage))
        .map((m) => ({ key: `${m.id}:${m.stage}`, id: m.id, name: m.name, detail: m.detail, owner: m.owner,
                       stage: m.stage, from: m.from, when: utcDay(m.at) }));

  const noun = isContacts ? (rows.length === 1 ? "contact" : "contacts") : (rows.length === 1 ? "opportunity" : "opportunities");
  const note = drill.kind === "now"
    ? `In ${drill.label} now${drill.col ? ` · ${drill.col.label}` : ""}`
    : `Moved into ${drill.label} · ${shortRange(data.period.from, data.period.to)}`;

  return (
    <Drawer open onClose={onClose} title={drill.label} subtitle={`${rows.length} ${noun} · ${note}`} width={760}>
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
                  {multi && <th className="px-2 py-2 font-semibold">Stage</th>}
                  {drill.kind === "moved" && <th className="px-2 py-2 font-semibold">From</th>}
                  <th className="px-2 py-2 font-semibold">Owner</th>
                  <th className="px-3 py-2 text-right font-semibold">{drill.kind === "now" ? "In stage" : "Moved"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-border-strong hover:bg-surface-2/50">
                    <td className="px-3 py-1.5">
                      <Link to={href(r.id)} className="font-medium text-ink hover:text-accent hover:underline">{r.name || "—"}</Link>
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-1.5 text-ink-3">{r.detail || "—"}</td>
                    {multi && <td className="px-2 py-1.5 text-ink-2">{stageLabel(r.stage)}</td>}
                    {drill.kind === "moved" && <td className="px-2 py-1.5 text-ink-3">{stageLabel(r.from)}</td>}
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
