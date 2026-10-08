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
import { ChevronLeft, ChevronRight } from "lucide-react";
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
import { PeriodBar, defaultPeriod } from "@/components/jobs/PeriodBar";
import { DealTypeFilter, Panel, dealTypeParam, heatBlue } from "@/pages/jobs/JobsOpportunitiesOverview";
import { useSessionState } from "@/lib/useSessionState";
import { cn } from "@/lib/utils";

type Drill =
  | { kind: "now"; band: StageFlowBand; stage: string; label: string;
      /** A breakdown cell: which cut and column. Null = the whole Pool. */
      col: { cut: "time" | "owner"; label: string; ids: Set<string> } | null }
  | { kind: "moved"; band: StageFlowBand; stage: string; label: string };

const titleCaseEmail = (e: string) =>
  e.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** "Oct 5" from an ISO instant, by its UTC day: the counts bucket by UTC
 *  midnights, so a local-time date could land outside the period it counted in. */
const utcDay = (iso: string) => format(new Date(`${iso.slice(0, 10)}T00:00:00`), "MMM d");

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
        <StageFlowTable data={data} nameOf={nameOf} onDrill={setDrill} />
      )}

      {drill && data && (
        <StageFlowDrill drill={drill} data={data} nameOf={nameOf} onClose={() => setDrill(null)} />
      )}
    </Panel>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────
//
// Two highlighted columns carry the meeting: Pool (what sits in the stage now)
// and Moved in (net new this period), with Target and Δ to target beside Moved
// in. The Breakdown group to the right is collapsed by default; open it to cut
// the Pool by time in stage or by owner.

type Cut = "time" | "owner";
const CUTS: { key: Cut; label: string }[] = [
  { key: "time", label: "Time in stage" },
  { key: "owner", label: "Owner" },
];
const UNASSIGNED = "(unassigned)";
/** Owner columns past this many fold into "Other", so the table stays readable. */
const MAX_OWNER_COLS = 6;

type CutCol = { key: string; label: string };

const ownerKey = (e: string | null) => (e ? e.toLowerCase() : UNASSIGNED);

const TH = "px-1.5 pb-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4";
// The two headline columns share one soft tint, header to last row.
const HL = "bg-accent-soft";

function StageFlowTable({ data, nameOf, onDrill }: {
  data: StageFlow; nameOf: (e: string | null) => string; onDrill: (d: Drill) => void;
}) {
  const [open, setOpen] = useSessionState<boolean>("jobsOverview.stageFlow.breakdownOpen", false);
  const [cut, setCut] = useSessionState<Cut>("jobsOverview.stageFlow.cut", "time");

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
  const shown = useMemo(() => new Set(ownerCols.map((c) => c.key)), [ownerCols]);

  const cols: CutCol[] = cut === "time" ? data.buckets : ownerCols;
  /** Which breakdown column a member falls in. */
  const colOf = (m: StageFlowMember): string =>
    cut === "time" ? data.buckets[m.bucket]?.key ?? "" : shown.has(ownerKey(m.owner)) ? ownerKey(m.owner) : OTHER;

  const scopeLabel = data.target_scope === "team" ? "Team" : nameOf(data.target_scope);
  const colCount = 5 + (open ? cols.length : 0);

  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full border-collapse", open ? "min-w-[960px]" : "min-w-[640px]")}>
        <thead>
          <tr>
            <th className={cn(TH, "text-left")}>Stage</th>
            <th className={cn(TH, HL, "rounded-tl-lg pt-2 text-right")} title="Sitting in this stage today">
              Pool<div className="text-[9.5px] font-medium normal-case tracking-normal text-ink-4">in stage now</div>
            </th>
            <th className={cn(TH, HL, "rounded-tr-lg pt-2 text-right")}
              title="Contacts or deals that entered this stage during the period">
              Moved in<div className="text-[9.5px] font-medium normal-case tracking-normal text-ink-4">net new this period</div>
            </th>
            <th className={cn(TH, "pl-3 text-right")}>
              Target
              <div className="text-[9.5px] font-medium normal-case tracking-normal text-ink-4">
                {data.targets_available ? (
                  <span title="Weekly target, prorated to the period">{scopeLabel}</span>
                ) : (
                  <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-ink-3"
                    title="Stage targets arrive with the stage-targets migration">pending migration</span>
                )}
              </div>
            </th>
            <th className={cn(TH, "text-right")} title="Moved in minus target. Positive is ahead.">
              Δ to target<div className="text-[9.5px] font-medium normal-case tracking-normal text-ink-4">&nbsp;</div>
            </th>
            <th className={cn(TH, "border-l border-border-strong pl-3 text-left align-top")} colSpan={open ? cols.length : 1}>
              <div className="flex items-center gap-2 normal-case tracking-normal">
                <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
                  className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:border-ink-3">
                  {open ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
                  Breakdown
                </button>
                {open && (
                  <select value={cut} onChange={(e) => setCut(e.target.value as Cut)} title="Cut the Pool by"
                    className="h-6 rounded-md border border-border-strong bg-surface px-1.5 text-[11px] text-ink outline-none focus:border-accent">
                    {CUTS.map((c) => <option key={c.key} value={c.key}>Pool by {c.label.toLowerCase()}</option>)}
                  </select>
                )}
              </div>
            </th>
          </tr>
          {open && (
            <tr>
              <th colSpan={5} />
              {cols.map((c, i) => (
                <th key={c.key} className={cn(TH, "truncate text-center", i === 0 && "border-l border-border-strong")}
                  title={cut === "owner" && c.key !== OTHER && c.key !== UNASSIGNED ? nameOf(c.key) : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {data.bands.map((band, bi) => {
            const bandMembers = data.members.filter((m) => m.band === band.key);
            const cellsFor = (stage: string) => {
              const counts = new Map<string, number>();
              bandMembers.forEach((m) => { if (m.stage === stage) counts.set(colOf(m), (counts.get(colOf(m)) ?? 0) + 1); });
              return cols.map((c) => counts.get(c.key) ?? 0);
            };
            const rowCells = band.rows.map((r) => (r.in_now ? cellsFor(r.key) : null));
            // Shade per band: 700+ contacts would wash every deal cell out.
            const max = Math.max(1, ...rowCells.flatMap((c) => c ?? []));
            return [
              <tr key={`${band.key}-head`}>
                <td colSpan={colCount} className={cn("pb-1.5", bi > 0 && "pt-4")}>
                  <div className="flex items-center gap-2 border-b border-border-strong pb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-ink-2">{band.label}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-3">{band.unit}</span>
                  </div>
                </td>
              </tr>,
              ...band.rows.map((row, ri) => (
                <StageRow key={`${band.key}-${row.key}`} band={band.key} row={row}
                  open={open} cols={cols} cells={rowCells[ri]} max={max}
                  targetsOn={data.targets_available} onDrill={onDrill}
                  // The cell's own members, picked by the same colOf that counted
                  // them, so the drawer always lists exactly the cell's number.
                  onCellDrill={(c) => onDrill({ kind: "now", band: band.key, stage: row.key, label: row.label,
                    col: { cut, label: c.label, ids: new Set(bandMembers
                      .filter((m) => m.stage === row.key && colOf(m) === c.key).map((m) => m.id)) } })} />
              )),
            ];
          })}
        </tbody>
      </table>
      <p className="mt-2.5 text-[11px] leading-relaxed text-ink-4">
        Pool is what sits in each stage today. Moved in counts each contact or deal once per stage it entered during the
        period, so a deal that went from In Discussions to Opportunity Confirmed counts in both rows. Closed Won and
        Closed Lost count closes that stuck. Targets are weekly, prorated to the period, and follow the Owner filter.
        Deal type filters the Pipeline band only.
      </p>
    </div>
  );
}

const OTHER = "(other)";

function fmtDelta(n: number): string {
  const v = Number.isInteger(n) ? String(Math.abs(n)) : Math.abs(n).toFixed(1);
  return n > 0 ? `+${v}` : n < 0 ? `\u2212${v}` : "0";
}

function StageRow({ band, row, open, cols, cells, max, targetsOn, onDrill, onCellDrill }: {
  band: StageFlowBand; row: StageFlowRow; open: boolean; cols: CutCol[];
  cells: number[] | null; max: number; targetsOn: boolean; onDrill: (d: Drill) => void;
  onCellDrill: (c: CutCol) => void;
}) {
  const movementOnly = row.in_now == null;
  const delta = row.delta;
  return (
    <tr className={cn(movementOnly && "text-ink-3")}>
      <td className={cn("whitespace-nowrap py-1 pr-2 text-[12.5px]", movementOnly ? "font-medium" : "font-semibold text-ink")}>
        {row.label}
      </td>
      <td className={cn(HL, "px-3 py-1.5 text-right")}>
        {row.in_now ? (
          <NumButton n={row.in_now.total} title={`${row.in_now.total} in ${row.label} now`}
            onClick={() => onDrill({ kind: "now", band, stage: row.key, label: row.label, col: null })}
            className="text-[14px] font-bold text-ink" />
        ) : <span className="text-[12px] text-ink-4">—</span>}
      </td>
      <td className={cn(HL, "px-3 py-1.5 text-right")}>
        <NumButton n={row.moved_in} title={`${row.moved_in} moved into ${row.label} this period`}
          onClick={() => onDrill({ kind: "moved", band, stage: row.key, label: row.label })}
          className="text-[14px] font-bold text-ink" />
      </td>
      <td className="py-1.5 pl-3 pr-1.5 text-right text-[12px] tabular-nums text-ink-3"
        title={row.target_weekly != null ? `${row.target_weekly} a week` : undefined}>
        {!targetsOn || !row.targetable ? "—" : row.target != null ? fmtTarget(row.target) : (
          <span className="text-ink-4" title="No target set in Settings › Targets › Jobs">not set</span>
        )}
      </td>
      <td className={cn("px-1.5 py-1.5 text-right text-[12.5px] font-semibold tabular-nums",
        delta == null ? "text-ink-4" : delta > 0 ? "text-[var(--green)]" : delta < 0 ? "text-[var(--amber)]" : "text-ink-2")}>
        {delta == null ? "—" : fmtDelta(delta)}
      </td>
      {open ? cols.map((c, i) => {
        const n = cells?.[i] ?? 0;
        const st = heatBlue(n, max);
        return (
          <td key={c.key} className={cn("p-1", i === 0 && "border-l border-border-strong pl-2")}>
            {cells ? (
              <button type="button" disabled={n === 0}
                onClick={() => onCellDrill(c)}
                title={n > 0 ? `${n} in ${row.label} · ${c.label}: click to list them` : undefined}
                className={cn("flex h-8 w-full min-w-[52px] items-center justify-center rounded-lg text-[12.5px] font-bold",
                  n > 0 && "cursor-pointer transition-shadow hover:ring-2 hover:ring-accent/50")}
                style={{ background: st.background, color: st.color }}>
                {n}
              </button>
            ) : null}
          </td>
        );
      }) : <td className="border-l border-border-strong" />}
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
        .filter((m) => m.band === drill.band && m.stage === drill.stage && (drill.col == null || drill.col.ids.has(m.id)))
        .map((m) => ({ id: m.id, name: m.name, detail: m.detail, owner: m.owner, when: `${m.days}d` }))
    : data.moved
        .filter((m) => m.band === drill.band && m.stage === drill.stage)
        .map((m) => ({ id: m.id, name: m.name, detail: m.detail, owner: m.owner, when: utcDay(m.at) }));

  const cutNote = drill.kind === "now" && drill.col
    ? drill.col.cut === "time" ? `${drill.col.label} in stage` : `owner: ${drill.col.label}` : null;
  const periodLabel = `${format(new Date(`${data.period.from}T00:00:00`), "MMM d")} – ${format(new Date(`${data.period.to}T00:00:00`), "MMM d")}`;
  const note = drill.kind === "now"
    ? `In ${drill.label} now${cutNote ? ` · ${cutNote}` : ""}`
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
