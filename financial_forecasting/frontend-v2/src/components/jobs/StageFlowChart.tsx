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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";

import {
  useJobsStaff,
  useStageFlow,
  useTagCampaigns,
  type TagCampaign,
  type OutreachGranularity,
  type StageFlow,
  type StageFlowBand,
  type StageFlowRow,
} from "@/services/jobs";
import { StageFlowWorkbench, type WorkbenchRecord } from "@/components/jobs/StageFlowWorkbench";
import { CampaignPicker } from "@/components/jobs/TagCampaigns";
import { DeltaChip } from "@/components/jobs/DeltaChip";
import { PeriodBar } from "@/components/jobs/PeriodBar";
import {
  ALL_DEAL_TYPES, DEAL_TYPE_OPTIONS, dealTypeParam, dealTypeSummary,
} from "@/pages/jobs/JobsOpportunitiesOverview";
import { Trend } from "@/pages/jobs/JobsOutreach";
import { useSessionState } from "@/lib/useSessionState";
import { useCurrentUser } from "@/services/auth";
import { cn } from "@/lib/utils";

type Tab = "stage" | "owner";

type Drill = {
  /** "activity" = the contacts behind an activity row's sends or calls;
   *  "converted" = the Net New now further along. */
  kind: "now" | "moved" | "activity" | "converted" | "ever";
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

/** [today − 6, today] as local YYYY-MM-DD. */
function lastSevenDaysToToday(): [string, string] {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const end = new Date();
  const start = new Date(end); start.setDate(end.getDate() - 6);
  return [day(start), day(end)];
}

export function StageFlowChart() {
  // Opens on the 7 days ending TODAY, unlike the review pages' "ending
  // yesterday": the chart is worked day to day, so a stage move or a send
  // logged this morning shows up without touching the dates (Kwame 2026-10-13).
  const [range, setRange] = useState<[string, string]>(() => lastSevenDaysToToday());
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  // The Owner tab looks at one Jobs team member at a time; the Stage tab is the team.
  const [ownerPick, setOwnerPick] = useSessionState<string | null>("jobsOverview.stageFlow.owner", null);
  // Full time by default, as on the Pipeline tab. Applies to opportunities only.
  const [dealTypes, setDealTypes] = useState<string[]>(["ft"]);
  // Role type: every kind by default. Commitment lives on each role.
  const [roleTypes, setRoleTypes] = useState<string[]>(ALL_ROLE_TYPES);
  const roleParam = roleTypes.length === ALL_ROLE_TYPES.length ? "all" : roleTypes.join(",");
  // A campaign is a contact tag (Performance › Campaigns). Applies to both bands:
  // contacts by their tags, deals through their tagged contacts.
  // Several at once, like the Campaigns tab: any of the checked campaigns.
  const [campaignPick, setCampaignPick] = useSessionState<string[]>("jobsOverview.stageFlow.campaigns", []);
  const campaignsQ = useTagCampaigns();
  const campaigns: TagCampaign[] = useMemo(() => [...(campaignsQ.data ?? [])]
    .filter((c) => c.contacts > 0).sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)),
  [campaignsQ.data]);
  const pickedCampaigns = campaignPick.filter((k) => campaigns.some((c) => c.key === k));
  const campaignParam = pickedCampaigns.length ? [...pickedCampaigns].sort().join(",") : "all";
  const [tab, setTab] = useSessionState<Tab>("jobsOverview.stageFlow.tab", "stage");
  const [byTime, setByTime] = useSessionState<boolean>("jobsOverview.stageFlow.byTime", false);
  // Which stages have their activity (sends, calls) folded SHUT. Open by
  // default, so the all-time Pool figures show without a click.
  const [actClosed, setActClosed] = useSessionState<string[]>("jobsOverview.stageFlow.activityClosed", []);
  const actOpen = ["initial_outreach", "call_booked"].filter((k) => !actClosed.includes(k));
  const toggleAct = (stage: string) =>
    setActClosed(actClosed.includes(stage) ? actClosed.filter((k) => k !== stage) : [...actClosed, stage]);
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
  const teamQ = useStageFlow(range[0], range[1], "all", dealTypeParam(dealTypes), roleParam, campaignParam);
  // The Jobs team only (Settings › Targets › Jobs › Team), in its set order.
  const team = teamQ.data?.team ?? [];
  // Default to yourself when you're on the team, else the first member.
  const owner = tab === "owner"
    ? (ownerPick && team.includes(ownerPick) ? ownerPick : (me && team.includes(me) ? me : team[0] ?? "all"))
    : "all";
  const personQ = useStageFlow(range[0], range[1], owner, dealTypeParam(dealTypes), roleParam, campaignParam);
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
      />

      <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border-strong bg-surface-2 px-4 py-2.5">
          <span className="text-[13px] font-bold text-ink-2">Stage Flow</span>
          {tabs}
          {tab === "owner" && team.length > 0 && (
            <select value={owner} onChange={(e) => setOwnerPick(e.target.value)} aria-label="Jobs team member"
              title="Whose stage flow and targets to show"
              className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] font-medium text-ink outline-none focus:border-accent">
              {team.map((email) => <option key={email} value={email}>{nameOf(email)}</option>)}
            </select>
          )}
          <div className="ml-auto" title="Contacts tagged with a checked campaign, and deals linked to those contacts or their companies">
            <CampaignPicker all={campaigns} selected={pickedCampaigns} onChange={setCampaignPick} />
          </div>
          {(
            <select value={byTime ? "time" : "off"} onChange={(e) => setByTime(e.target.value === "time")}
              title="Split the Pool by how long it has sat in the stage"
              className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent">
              <option value="off">No breakdown</option>
              <option value="time">Pool by time in stage</option>
            </select>
          )}
        </div>
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
          <StageTable data={current} byTime={byTime} nameOf={nameOf} onDrill={setDrill}
            actOpen={actOpen} onToggleAct={toggleAct}
            pipelineFilter={<PipelineFilter dealTypes={dealTypes} onDealTypes={setDealTypes}
              roleTypes={roleTypes} onRoleTypes={setRoleTypes} />} />
        )}
        {current && (
          <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-ink-4">
            Pool is what sits in each stage today. Net New counts each contact or opportunity once per stage it entered
            during the period. Closed Won and Closed Lost count closes that stuck. Targets are weekly, prorated to the
            period; the Owner tab shows each person against their own
            {current.targets_available ? "" : "; per-stage targets arrive with the stage-targets migration, and Converted to opportunity uses the Settings outreach target until then"}.
            Sends (under Initial outreach) and Discovery calls (under Discovery call) open the activity behind those stages, counted as events, not contacts: every send or call the team logged in the period, exactly as
            Outreach › Activity Pipeline counts it, against the Settings outreach targets.
            The Pipeline band's Filter (deal type, role type) applies to opportunities only. A campaign keeps contacts with that tag, and deals linked to those contacts or at their companies.
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

/** The band's label row, carrying the band totals in the Pool and Net New
 *  columns: everything in the band now, and the unique records that moved. */
function BandHeader({ band, cols, right, pool, netNew, poolTitle, netNewTitle, onPool, onNetNew }: {
  band: StageFlow["bands"][number]; cols: number; right: React.ReactNode;
  pool: number; netNew: number; poolTitle: string; netNewTitle: string;
  onPool: () => void; onNetNew: () => void;
}) {
  return (
    <tr className="border-t-2 border-border bg-bg">
      <td className="py-2 pl-3.5 pr-4">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="h-3.5 w-1 rounded-full" style={{ background: BAND_ACCENT[band.key] }} />
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-2">{band.label}</span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-3">
            {band.unit.charAt(0).toUpperCase() + band.unit.slice(1)}
          </span>
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-4">Total</span>
        </div>
      </td>
      <td className={cn(TD, HL, "py-2 text-[14px] font-bold")} title={poolTitle}>
        <NumButton n={pool} onClick={onPool} title={`${pool} in ${band.label} now`} />
      </td>
      <td className={cn(TD, HL_ACT, "border-l-2 border-border-strong py-2 text-[14px] font-bold")} title={netNewTitle}>
        <NumButton n={netNew} onClick={onNetNew} title={`${netNew} unique ${band.unit} moved`} />
      </td>
      <td colSpan={4 + cols} className="py-2 pr-4">
        <div className="flex justify-end">{right}</div>
      </td>
    </tr>
  );
}

function StageLabel({ row, toggle }: { row: StageFlowRow; toggle?: React.ReactNode }) {
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
      {toggle}
    </td>
  );
}

/** The fold on a stage that has activity under it: a quiet grey label with
 *  an arrow ("Sends ▾"), so it reads as optional detail, not as a number. */
function ActivityToggle({ lead, open, onToggle }: { lead: StageFlowRow; open: boolean; onToggle: () => void }) {
  const label = lead.key === "outreach_sent" ? "Sends" : "Discovery calls";
  return (
    <button type="button" onClick={onToggle} aria-expanded={open}
      title={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()} logged in the period, with targets`}
      className="ml-2 inline-flex items-center gap-0.5 rounded px-1 align-[1px] text-[11.5px] font-normal text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
      {label}
      {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
    </button>
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

function StageTable({ data, byTime, nameOf, onDrill, pipelineFilter, actOpen, onToggleAct }: {
  data: StageFlow; byTime: boolean; nameOf: (e: string | null) => string; onDrill: (d: Drill) => void;
  pipelineFilter: React.ReactNode; actOpen: string[]; onToggleAct: (stage: string) => void;
}) {
  const cols = byTime ? data.buckets : [];
  // Blank for the team (the default); a person's name when the Owner filter picks one.
  const scopeLabel = data.target_scope === "team" ? "" : nameOf(data.target_scope);
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full border-collapse", byTime ? "min-w-[1080px]" : "min-w-[860px]")}>
        <colgroup>
          <col style={{ width: byTime ? "21%" : "28%" }} />
          {[0, 1, 2, 3, 4, 5].map((i) => <col key={i} style={{ width: byTime ? "7.5%" : "12%" }} />)}
          {cols.map((c) => <col key={c.key} style={{ width: "6.8%" }} />)}
        </colgroup>
        <thead>
          {/* Two groups the reader should never confuse: where things sit
              (Stage, as of today) and what happened (Activity, in the period). */}
          <tr className="bg-surface-2 text-[10px] uppercase tracking-[0.08em]">
            <th />
            <th className={cn("px-3 pt-2.5", HL)}>
              <GroupCap label="Stage" color={STAGE_ACCENT} />
            </th>
            <th colSpan={5} className="border-l-2 border-border-strong px-3 pt-2.5">
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
            <th className={TH} title="Of the Net New, the share that is further along today: a later stage, Converted to opportunity, or Closed Won">
              <span className="block">Conversion</span><span className={SUB} />
            </th>
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
            // Contacts being worked: the closed outcomes (Converted, Revisit,
            // Not a fit) sit in the table but are not the working pool.
            const poolRows = band.rows.filter((r) => (r.depth ?? 0) === 0 && !r.children && r.kind !== "activity");
            const poolStages = poolRows.flatMap(stagesOf);
            const pool = new Set(bandMembers.filter((m) => poolStages.includes(m.stage)).map((m) => m.id)).size;
            // Net New total: UNIQUE records that moved anywhere in the band this
            // period (a contact that moved twice counts once).
            const flowStages = band.rows.filter((r) => r.kind !== "activity" && !r.children).map((r) => r.key);
            const movedIds = new Set(data.moved.filter((m) => m.band === band.key && flowStages.includes(m.stage)).map((m) => m.id));
            const unit = band.key === "outreach" ? "contacts" : "opportunities";
            return (
              <Fragment key={band.key}>
                <BandHeader band={band} cols={cols.length} right={band.key === "pipeline" ? pipelineFilter : null}
                  pool={pool} netNew={movedIds.size}
                  poolTitle={band.key === "outreach"
                    ? "Every contact in a working outreach stage today (Contact closed not included). Click for the list."
                    : "Every open opportunity today, all stages. Click for the list."}
                  netNewTitle={`Unique ${unit} that moved into any stage during the period, each counted once. Click for the list.`}
                  onPool={() => onDrill({ kind: "now", band: band.key, stages: poolStages,
                    label: band.key === "outreach" ? "Outreach (all working stages)" : "Pipeline (all stages)", col: null })}
                  onNetNew={() => onDrill({ kind: "moved", band: band.key, stages: flowStages,
                    label: band.key === "outreach" ? "Outreach (any stage)" : "Pipeline (any stage)", col: null })} />
                {band.rows.map((row) => {
                  if (row.kind === "activity") {
                    if (!row.parent || !actOpen.includes(row.parent)) return null;
                    const sibs = band.rows.filter((r) => r.kind === "activity" && r.parent === row.parent);
                    return <ActivityRow key={row.key} row={row} cols={cols.length}
                      last={sibs[sibs.length - 1] === row}
                      onDrill={() => onDrill({ kind: "activity", band: band.key, stages: [row.key], label: row.label, col: null, activity: row })}
                      onEver={() => onDrill({ kind: "ever", band: band.key, stages: [row.key],
                        label: EVER_TITLE[row.key]?.label ?? row.label, col: null, activity: row })} />;
                  }
                  const acts = band.rows.filter((r) => r.kind === "activity" && r.parent === row.key);
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
                      <StageLabel row={row} toggle={acts.length > 0 && (
                        <ActivityToggle lead={acts[0]} open={actOpen.includes(row.key)} onToggle={() => onToggleAct(row.key)} />
                      )} />
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
                      <td className={TD}>
                        <ConversionCell row={row} pending={pending}
                          onDrill={() => onDrill({ kind: "converted", band: band.key, stages, label: row.label, col: null })} />
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

/** "40%"; hover gives "2 of 5", and the percentage opens the records that moved on. */
function ConversionCell({ row, pending, onDrill }: { row: StageFlowRow; pending: boolean; onDrill: () => void }) {
  const c = row.conversion;
  if (pending || !c || c.of === 0) return <span className="text-ink-4">—</span>;
  const pct = Math.round((c.on / c.of) * 100);
  return (
    <span className="inline-flex flex-col items-center leading-tight">
      {c.on === 0 ? <span className="text-ink-3" title={`0 of ${c.of} are further along now`}>0%</span> : (
        <button type="button" onClick={onDrill} title={`${c.on} of ${c.of} are further along now: click to list them`}
          className="tabular-nums text-ink underline-offset-2 hover:text-accent hover:underline">{pct}%</button>
      )}
    </span>
  );
}

/** Sends or calls logged in the period, under the stage that work moves. Same
 *  columns as a stage row so the target, gap and trend read across, but a
 *  violet bolt and a lighter weight mark it as a count of events: one contact
 *  emailed three times is 3 here and 1 on the stage row above. */
const EVER_TITLE: Record<string, { label: string; caption: string; tip: string }> = {
  outreach_sent: {
    label: "Total ever outreached", caption: "ever reached",
    tip: "Total ever outreached: unique contacts who have ever been sent at least one outreach by the Jobs team "
      + "(email, LinkedIn, text or facilitated intro), all-time. Assigned or tagged in a stage does not count. "
      + "Each contact once. Does not change with the period.",
  },
  discovery_calls_logged: {
    label: "Ever had a discovery call", caption: "ever",
    tip: "Contacts with at least one call logged as Discovery, all-time. Only tagged calls count. "
      + "Does not change with the period.",
  },
};

function ActivityRow({ row, cols, last, onDrill, onEver }: {
  row: StageFlowRow; cols: number; last: boolean; onDrill: () => void; onEver: () => void;
}) {
  const ever = row.ever;
  const everMeta = EVER_TITLE[row.key];
  const pending = !row.available;
  const unit = row.key === "outreach_sent" ? "sends" : "calls";
  const targetTitle = row.target_weekly != null
    ? `${row.target_weekly} a week, from Settings › Targets › Jobs › Outreach: ${row.target_source_label ?? ""}`
    : `No ${row.target_source_label ?? "outreach"} target set in Settings › Targets › Jobs › Outreach`;
  return (
    // A nested panel under its stage: one violet tint across the row and a
    // violet rule down the left, so it reads as that stage's detail, not as
    // another stage. Pool is blank: activity has no pool.
    <tr className={cn("text-[12.5px] transition-colors hover:bg-surface-2/40",
        last ? "border-b border-border" : "border-b border-border/60")}
      title={`Activity: ${unit} logged in the period, as Outreach › Activity Pipeline counts them`}>
      <td className={cn("py-2 pr-4 text-left", pending ? "text-ink-4" : "text-ink-2")}
        style={{ paddingLeft: "34px" }}>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="text-ink-4" aria-hidden>↳</span>
          <span className="font-medium">{row.label}</span>
          {pending && <span className="ml-1 text-[10.5px] uppercase tracking-wide text-ink-4">pending migration</span>}
        </span>
        {!pending && row.breakdown && (
          <span className="mt-0.5 block whitespace-nowrap pl-[18px] text-[11px] tabular-nums text-ink-4">
            {row.breakdown.map((b) => `${b.label} ${b.n.toLocaleString()}`).join(" · ")}
          </span>
        )}
      </td>
      <td className={cn(TD, HL, "py-2")} title={ever && everMeta ? everMeta.tip : "Activity has no pool"}>
        {ever && everMeta ? (
          <span className="inline-flex flex-col items-center leading-tight">
            <NumButton n={ever.total} onClick={onEver} title={`${ever.total} · ${everMeta.label}`} />
            <span className="text-[10px] text-ink-4">{everMeta.caption}</span>
          </span>
        ) : null}
      </td>
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
      <td className={cn(TD, "py-2 text-ink-4")}>—</td>
      <td className={cn(TD, "py-2 text-[12px]")}>
        {pending ? <span className="text-ink-4">—</span> : <Trend current={row.moved_in} prior={row.prev_moved_in} />}
      </td>
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className={cn("px-2 py-2", i === 0 && "border-l border-border-strong")} />
      ))}
    </tr>
  );
}

// ── Pipeline band filter ─────────────────────────────────────────────────────

const ROLE_TYPE_OPTIONS = [
  { value: "committed", label: "Committed" },
  { value: "open_market", label: "Open market" },
  { value: "none", label: "No roles yet" },
];
const ALL_ROLE_TYPES = ROLE_TYPE_OPTIONS.map((o) => o.value);

function FilterGroup({ title, options, selected, onFlip, allOn, onAll }: {
  title: string; options: { value: string; label: string }[]; selected: string[];
  onFlip: (v: string) => void; allOn: boolean; onAll: () => void;
}) {
  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 pb-1 pt-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-4">{title}</span>
        {!allOn && <button type="button" onClick={onAll} className="text-[11px] text-accent hover:underline">All</button>}
      </div>
      {options.map((o) => {
        const on = selected.includes(o.value);
        const last = on && selected.length === 1;
        return (
          <label key={o.value} title={last ? "At least one stays selected" : undefined}
            className={cn("flex items-center gap-2 px-3 py-1.5 text-[12px] normal-case tracking-normal text-ink hover:bg-surface-2",
              last ? "cursor-not-allowed" : "cursor-pointer")}>
            <input type="checkbox" className="accent-[var(--accent)]" checked={on} disabled={last} onChange={() => onFlip(o.value)} />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

/** One Filter button on the Pipeline band: deal type and role type. Both
 *  apply to opportunities only; contacts carry neither. At least one value
 *  stays checked in each group, so the band never filters to nothing. */
function PipelineFilter({ dealTypes, onDealTypes, roleTypes, onRoleTypes }: {
  dealTypes: string[]; onDealTypes: (v: string[]) => void;
  roleTypes: string[]; onRoleTypes: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Fixed to the viewport: the table scrolls sideways, and an absolute menu
  // inside that scroller would be clipped by it.
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    // Opens upward when the band sits low on the screen.
    if (r) setPos(window.innerHeight - r.bottom < 440
      ? { bottom: window.innerHeight - r.top + 4, right: window.innerWidth - r.right }
      : { top: r.bottom + 4, right: window.innerWidth - r.right });
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    // Page scroll moves the button, so close; scrolling the menu itself doesn't.
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  const flip = (list: string[], v: string, set: (n: string[]) => void) => {
    const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
    if (next.length > 0) set(next);
  };
  const allRoles = roleTypes.length === ALL_ROLE_TYPES.length;
  const roleSummary = allRoles ? null
    : ROLE_TYPE_OPTIONS.filter((o) => roleTypes.includes(o.value)).map((o) => o.label).join(", ");
  return (
    <div ref={ref} className="relative">
      <button ref={btnRef} type="button" onClick={toggle} aria-expanded={open} aria-haspopup="dialog"
        title="Filter the Pipeline band by deal type and role type"
        className={cn("flex h-7 items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[12px] font-medium normal-case tracking-normal text-ink-2 hover:text-ink",
          open ? "border-ink-3" : "border-border-strong")}>
        <SlidersHorizontal size={12} />
        <span>Filter</span>
        <span className="text-ink-4">·</span>
        <span className="max-w-[260px] truncate text-ink">{dealTypeSummary(dealTypes)}{roleSummary ? ` · ${roleSummary}` : ""}</span>
        <ChevronDown size={12} className="text-ink-4" />
      </button>
      {open && (
        <div style={pos ?? undefined} className="fixed z-50 max-h-[70vh] w-[230px] overflow-y-auto divide-y divide-border rounded-md border border-border-strong bg-surface shadow-lg">
          <FilterGroup title="Deal type" options={DEAL_TYPE_OPTIONS} selected={dealTypes}
            onFlip={(v) => flip(dealTypes, v, onDealTypes)}
            allOn={dealTypes.length === ALL_DEAL_TYPES.length} onAll={() => onDealTypes([...ALL_DEAL_TYPES])} />
          <FilterGroup title="Role type" options={ROLE_TYPE_OPTIONS} selected={roleTypes}
            onFlip={(v) => flip(roleTypes, v, onRoleTypes)} allOn={allRoles} onAll={() => onRoleTypes([...ALL_ROLE_TYPES])} />
          <p className="px-3 py-2 text-[10.5px] leading-snug text-ink-4">
            Opportunities only. Role type matches a deal with any live role of that kind.
          </p>
        </div>
      )}
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
  if (drill.kind === "ever" && drill.activity?.ever) {
    const ever = drill.activity.ever;
    const recs: WorkbenchRecord[] = ever.ids.map((id) => ({ id, stage: drill.activity!.key, when: "", extra: [] }));
    const unlinked = ever.unlinked_sends ? ` · ${ever.unlinked_sends} sends had no linked contact` : "";
    return (
      <StageFlowWorkbench band="outreach" title={drill.label}
        subtitle={`${ever.total.toLocaleString()} contacts · all-time, not affected by the period${unlinked}`}
        isPool={false} contextHead={[]} records={recs} stageLabel={stageLabel} nameOf={nameOf} onClose={onClose} />
    );
  }
  if (drill.kind === "activity" && drill.activity) {
    return <ActivityDrill drill={drill} row={drill.activity} data={data} nameOf={nameOf} onClose={onClose} />;
  }
  if (drill.kind === "converted") {
    const recs: WorkbenchRecord[] = data.moved
      .filter((m) => m.band === drill.band && drill.stages.includes(m.stage) && m.advanced)
      .map((m) => ({ id: m.id, stage: m.stage, when: utcDay(m.at), extra: [utcDay(m.at), stageLabel(m.now ?? null)] }));
    const k = new Set(recs.map((r) => r.id)).size;
    const unit = isContacts ? (k === 1 ? "contact" : "contacts") : (k === 1 ? "opportunity" : "opportunities");
    return (
      <StageFlowWorkbench band={drill.band} title={drill.label}
        subtitle={`${k} ${unit} · entered ${drill.label} ${shortRange(data.period.from, data.period.to)} and are further along now`}
        isPool={false} contextHead={["Net new", "Now"]} records={recs} stageLabel={stageLabel} nameOf={nameOf} onClose={onClose} />
    );
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
