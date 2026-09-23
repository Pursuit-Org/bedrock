import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as ReTooltip } from "recharts";
import { ChevronRight, ChevronDown, Loader2, Users } from "lucide-react";

import {
  useOutreachScorecard,
  useOutreachSummary,
  useOutreachActivity,
  useOutreachDrill,
  useJobsStaff,
  useJobsContacts,
  useContactDetail,
  useContactTagCatalog,
  JOBS_TEAM_PINNED,
  type OutreachGranularity,
  type OutreachScopeKind,
  type OutreachSummary,
  type OutreachDateRange,
  type ScorecardRow,
  type OutreachDrillContact,
  scorecardCount,
  useOwnerScorecard,
  type OwnerMetric,
  useTouchDepth,
  type TouchDepthBucket,
  type JobContactWithDeal,
} from "@/services/jobs";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { Panel } from "./JobsOpportunitiesOverview";
import { ActivityTrends } from "@/components/jobs/ActivityTrends";
import { ActivityFeed } from "@/components/jobs/ActivityFeed";
import { DrillList } from "@/components/jobs/DrillList";
import { PeriodBar, ScopeButtons, defaultPeriod } from "@/components/jobs/PeriodBar";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Accounts shown in a scorecard drill before "Show more". */
const DRILL_PAGE = 25;
/** Contact names listed on a collapsed account row before "+N". */
const CONTACT_NAMES_SHOWN = 3;

/** Touches shown before "Show n older" in a contact's inline touch log. */
const TOUCH_LOG_CAP = 5;
/** Contacts shown per touch-depth bucket before "Show n more". */
const TOUCH_DRILL_PAGE = 5;
/** Fallback only — the live list comes from useStageVocabulary(), so the picker
 *  can't offer a stage the database CHECK constraint would reject. */



// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
/** "Sep 15 – Sep 20, 2026" from two INCLUSIVE YYYY-MM-DD days.
 *
 *  Parsed at local noon on purpose. The labels used to come from the scorecard
 *  response, whose bounds are UTC timestamps — west of Greenwich `new Date()`
 *  slid each one back a day, so a 9/15–9/20 pick rendered as 9/14–9/20 under
 *  "This period" (Kwame 2026-09-21). Formatting the picker's own plain dates
 *  means the card and the table cannot disagree in the first place. */
function fmtDayRange(fromISO: string, toISO: string) {
  const at = (iso: string) => new Date(`${iso}T12:00:00`);
  const end = at(toISO);
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day(at(fromISO))} – ${day(end)}, ${end.getFullYear()}`;
}

/** The equal-length window immediately before [from, to], inclusive — the same
 *  comparison the backend makes for a custom range, so "Last period" names the
 *  window its numbers actually came from. */
function priorDayRange(fromISO: string, toISO: string): [string, string] {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const start = new Date(`${fromISO}T12:00:00`);
  const days = Math.round((new Date(`${toISO}T12:00:00`).getTime() - start.getTime()) / 86_400_000) + 1;
  const lastEnd = new Date(start); lastEnd.setDate(start.getDate() - 1);
  const lastStart = new Date(lastEnd); lastStart.setDate(lastEnd.getDate() - (days - 1));
  return [iso(lastStart), iso(lastEnd)];
}
function Trend({ current, prior, unit = "pct" }: { current: number; prior: number; unit?: "pct" | "pt" }) {
  if (unit === "pct") {
    if (!prior) return <span className="text-ink-4">—</span>;
    const v = (current - prior) / prior;
    const up = v >= 0;
    return <span className={cn("font-semibold whitespace-nowrap", up ? "text-green" : "text-red")}>{up ? "▲" : "▼"} {(Math.abs(v) * 100).toFixed(1)}%</span>;
  }
  // percentage-point delta between two rates
  const v = (current - prior) * 100;
  const up = v >= 0;
  return <span className={cn("font-semibold whitespace-nowrap", up ? "text-green" : "text-red")}>{up ? "▲" : "▼"} {Math.abs(v).toFixed(1)}pt</span>;
}

// ── Drill-down (contacts → their touches) ─────────────────────────────────────

/** "Avni Nahar", or "Avni Nahar +2" when several people worked one contact —
 *  the full list is in the row's tooltip. */
function actorSummary(actors: string[] | undefined, nameOf: (e: string) => string): string {
  if (!actors || actors.length === 0) return "";
  const first = nameOf(actors[0]);
  return actors.length === 1 ? first : `${first} +${actors.length - 1}`;
}

/** Contacts regrouped under the account they work for.
 *
 *  The API answers this drill contact-first, which is the right shape for the
 *  query and the wrong one for the question. "Blackstone, four people, eleven
 *  touches" is one line of judgement; four separate rows that all say Blackstone
 *  is four lines you have to reassemble yourself (Kwame 2026-09-21).
 *
 *  Grouped on the client on purpose: the endpoint already returns every contact
 *  behind the number, so a second shape is a `reduce`, not a round trip. */
interface DrillAccount {
  account: string;
  contacts: OutreachDrillContact[];
  touches: number;
  actors: string[];
}

function groupByAccount(contacts: OutreachDrillContact[]): DrillAccount[] {
  const byAccount = new Map<string, DrillAccount>();
  for (const c of contacts) {
    // Everything without a company shares one bucket rather than each becoming
    // its own single-contact "account", which read as noise at the top of the list.
    const key = c.company?.trim() || "No account on file";
    let g = byAccount.get(key);
    if (!g) { g = { account: key, contacts: [], touches: 0, actors: [] }; byAccount.set(key, g); }
    g.contacts.push(c);
    g.touches += c.touches.length;
  }
  for (const g of byAccount.values()) {
    g.actors = [...new Set(g.contacts.flatMap((c) => c.actors ?? []))];
    g.contacts.sort((a, b) => b.touches.length - a.touches.length);
  }
  // Busiest account first: the drill is opened to see where the volume went.
  return [...byAccount.values()].sort((a, b) => b.touches - a.touches || a.account.localeCompare(b.account));
}

/** "David Drew, Jane Roe, Sam Lee +2" — enough names to recognise the account's
 *  relationships without the row wrapping. */
function contactSummary(contacts: OutreachDrillContact[]): string {
  const names = contacts.map((c) => c.name || "Unknown contact");
  const shown = names.slice(0, CONTACT_NAMES_SHOWN).join(", ");
  const hidden = names.length - CONTACT_NAMES_SHOWN;
  return hidden > 0 ? `${shown} +${hidden}` : shown;
}

function RowDrill({
  kind, rowKey, granularity, scope, owner, range, nameOf,
}: {
  kind: "user" | "activity"; rowKey: string;
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
  nameOf: (email: string) => string;
}) {
  const [openAccount, setOpenAccount] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError } = useOutreachDrill({ kind, key: rowKey, period: "this", granularity, scope, owner, range });
  const accounts = useMemo(() => groupByAccount(data?.contacts ?? []), [data]);

  if (isLoading) return <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>;
  if (isError) return <div className="px-4 py-3 text-[12.5px] text-red">Couldn't load the detail.</div>;
  if (accounts.length === 0) return <div className="px-4 py-3 text-[12.5px] text-ink-4">No records in this period.</div>;

  const shown = showAll ? accounts : accounts.slice(0, DRILL_PAGE);
  return (
    <div className="flex flex-col divide-y divide-border">
      {shown.map((g) => {
        const open = openAccount.has(g.account);
        return (
          <div key={g.account}>
            <button
              onClick={() => setOpenAccount((prev) => { const n = new Set(prev); n.has(g.account) ? n.delete(g.account) : n.add(g.account); return n; })}
              className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-surface-2"
            >
              <span className="w-3.5 shrink-0 text-ink-4">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
              {/* Fixed width so the account column reads as a column down the
                  list rather than a ragged left edge. */}
              <span className="w-[180px] shrink-0 truncate text-[13px] font-semibold text-ink">{g.account}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3"
                title={g.contacts.map((c) => c.name || "Unknown contact").join(", ")}>
                {contactSummary(g.contacts)}
              </span>
              <span className="shrink-0 text-[11.5px] text-ink-3" title={g.actors.map(nameOf).join(", ")}>
                {actorSummary(g.actors, nameOf)}
              </span>
              <span className="w-[74px] shrink-0 text-right text-[11.5px] text-ink-4">{g.touches} touch{g.touches === 1 ? "" : "es"}</span>
            </button>
            {open && (
              <div className="flex flex-col gap-3 bg-bg px-4 py-2 pl-10">
                {g.contacts.map((c) => (
                  <div key={c.contact_id} className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-medium text-ink">{c.name || "Unknown contact"}</span>
                      <span className="text-[11px] text-ink-4">{c.touches.length} touch{c.touches.length === 1 ? "" : "es"}</span>
                    </div>
                    {c.touches.length === 0 ? (
                      <div className="text-[12px] text-ink-4">No jobs touches in this period.</div>
                    ) : (
                      <div className="flex items-baseline gap-2 text-[9.5px] font-bold uppercase tracking-wider text-ink-4">
                        <span className="w-[52px]">Type</span>
                        <span className="min-w-0 flex-1">Subject</span>
                        <span className="w-[124px] shrink-0">Owner</span>
                        <span className="w-[70px] shrink-0 text-right">Date</span>
                      </div>
                    )}
                    {c.touches.map((t, i) => (
                      <div key={i} className="flex items-baseline gap-2 text-[12.5px]">
                        <span className={cn("w-[52px] shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[10.5px] font-semibold uppercase",
                          t.direction === "received" ? "bg-green-soft text-green" : "bg-surface-2 text-ink-3")}>
                          {t.direction === "received" ? "reply" : t.type}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-ink-2">{t.subject || t.snippet || "(no subject)"}</span>
                        {/* Owner: who sent it, or on a reply who earned it. */}
                        <span className="w-[124px] shrink-0 truncate text-[11.5px] text-ink-3"
                          title={t.actor
                            ? `${t.direction === "received" ? "Replied to" : "By"} ${nameOf(t.actor)} · ${t.actor}`
                            : "No Pursuit sender recorded on this touch"}>
                          {t.actor ? nameOf(t.actor) : "—"}
                        </span>
                        <span className="w-[70px] shrink-0 text-right text-ink-4">{t.date ? fmtDate(t.date) : ""}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!showAll && accounts.length > DRILL_PAGE && (
        <button onClick={() => setShowAll(true)} className="px-4 py-2 text-left text-[12.5px] font-medium text-accent-ink hover:underline">
          Show more ({accounts.length - DRILL_PAGE} more)
        </button>
      )}
    </div>
  );
}

// ── A scorecard table (User Pipeline / Activity Pipeline) ─────────────────────
/** The title bar both cuts of the Activity Pipeline share, so switching tabs
 *  changes the table and nothing else. */
function CardHead({ title, leading, action }: {
  title: string; leading?: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2 px-4 py-2.5">
      <span className="text-[13px] font-bold text-ink-2">{title}</span>
      {leading}
      <span className="ml-auto">{action}</span>
    </div>
  );
}

/** A period column heading: the label, with its window stacked underneath in
 *  grey. Side by side the dates pushed the heading off-centre and stretched the
 *  column; stacked, every number sits directly under the window it covers. */
function PeriodHead({ label, range }: { label: string; range?: string }) {
  return (
    <th className="whitespace-nowrap px-2 py-2 text-center font-bold align-bottom">
      <span className="block">{label}</span>
      <span className="mt-0.5 block h-3.5 text-[10px] font-normal normal-case tracking-normal text-ink-4">
        {range ?? ""}
      </span>
    </th>
  );
}

function ScorecardTable({
  title, rows, idPrefix, firstColHeader, drillKind, granularity, scope, owner, range, nameOf,
  rangeLabel, lastRangeLabel, action, leading,
}: {
  title: string; rows: ScorecardRow[]; idPrefix: string; firstColHeader: string;
  drillKind: "user" | "activity";
  /** Shown in grey under "This Period" so the window is never implicit. */
  rangeLabel?: string;
  /** Same, for the comparison period. */
  lastRangeLabel?: string;
  /** Optional control rendered at the right of the title bar. */
  action?: React.ReactNode;
  /** Optional control rendered immediately after the title. */
  leading?: React.ReactNode;
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
  nameOf: (email: string) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
      <CardHead title={title} leading={leading} action={action} />
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            {/* Goal, then gap, then the numbers behind them (Kwame 2026-09-21).
                You read this table to answer "are we on track", and the two
                columns that answer it used to be the last two — past three
                columns of raw counts you only need once the answer is no. */}
            <th className="py-2 pl-3.5 pr-2 text-left font-bold align-bottom">{firstColHeader}</th>
            <th className="whitespace-nowrap px-3.5 py-2 text-center font-bold align-bottom">Target</th>
            <th className="whitespace-nowrap px-2 py-2 text-center font-bold align-bottom">Δ to Target</th>
            <PeriodHead label="This Period" range={rangeLabel} />
            <PeriodHead label="Last Period" range={lastRangeLabel} />
            <th className="whitespace-nowrap px-2 py-2 text-center font-bold align-bottom">Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const rowKey = r.stage ?? r.metric ?? String(idx);
            const id = `${idPrefix}-${rowKey}`;
            const isOpen = open === id;
            const isLast = idx === rows.length - 1;
            // Funnel tiers (activity table): a new tier just gets a stronger top
            // rule so the three sends read as one level, then Engaged, then Replied.
            const prevTier = idx > 0 ? rows[idx - 1].tier : undefined;
            const tierStart = r.tier != null && r.tier !== prevTier && idx > 0;
            // Hierarchy: a roll-up is bold, its components step in, and a
            // component's own breakdown steps in again. Indentation is read off
            // `depth` rather than a list of metric names this table would
            // otherwise have to keep in sync with the API.
            const depth = r.depth ?? 0;
            const pending = r.available === false;
            // Read through scorecardCount, never straight off the row: these
            // were `{warm, cold, total}` before 2026-09-21, and a cached row or
            // an un-restarted backend still hands one over.
            const thisN = scorecardCount(r.this_period);
            const lastN = scorecardCount(r.last_period);
            return (
              <Fragment key={id}>
                <tr
                  onClick={() => { if (!pending) setOpen(isOpen ? null : id); }}
                  title={pending ? r.unavailable_reason ?? undefined : undefined}
                  className={cn("text-[13.5px]",
                    pending ? "cursor-default" : "cursor-pointer hover:bg-surface-2",
                    !isLast && "border-b border-border",
                    tierStart && "border-t-2 border-border")}
                >
                  <td className={cn("py-2.5 pr-3.5 text-left",
                    depth === 0 ? "font-semibold text-ink" : "font-normal",
                    pending ? "text-ink-4" : depth === 0 ? "text-ink" : "text-ink-2")}
                    style={{ paddingLeft: `${14 + depth * 18}px` }}>
                    <span className="mr-1 inline-block w-3.5 text-ink-4">
                      {pending ? null : isOpen
                        ? <ChevronDown size={12} className="inline" />
                        : <ChevronRight size={12} className="inline" />}
                    </span>
                    {r.label}
                    {pending && <span className="ml-2 text-[10.5px] uppercase tracking-wide text-ink-4">pending migration</span>}
                  </td>
                  {/* A dash, never 0 (Kwame 2026-09-21): the individual outreach
                      channels carry no target, and printing 0 claimed one — every
                      send then read as beating a goal nobody set. */}
                  <td className="px-3.5 py-2.5 text-center tabular-nums text-ink-3">{pending ? "—" : r.target ?? "—"}</td>
                  <td className="px-3.5 py-2.5 text-center">
                    {pending ? <span className="text-ink-4">—</span>
                      : <DeltaChip actual={thisN} target={r.target} />}
                  </td>
                  {/* Centred, not right-aligned: the headings carry a second
                      line of dates, and a right-aligned number drifts away from
                      the window it belongs to. */}
                  <td className={cn("px-3.5 py-2.5 text-center tabular-nums", depth === 0 && "font-semibold", pending && "font-normal text-ink-4")}>
                    {pending ? "—" : thisN}
                  </td>
                  <td className={cn("px-3.5 py-2.5 text-center tabular-nums", pending && "text-ink-4")}>
                    {pending ? "—" : lastN}
                  </td>
                  <td className="px-3.5 py-2.5 text-center text-[12.5px]">
                    {pending ? <span className="text-ink-4">—</span>
                      : <Trend current={thisN} prior={lastN} />}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={6} className="border-b border-border bg-bg p-0">
                      <RowDrill kind={drillKind} rowKey={rowKey} granularity={granularity} scope={scope} owner={owner} range={range} nameOf={nameOf} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
/** The contacts behind one touch-depth bucket: name, touches, owner. Opens at
 *  five — enough to see who's in there without the panel swallowing the page —
 *  with the rest a click away. */
function TouchDepthDrill({ bucket, nameOf }: {
  bucket: TouchDepthBucket;
  nameOf: (email: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? bucket.contacts : bucket.contacts.slice(0, TOUCH_DRILL_PAGE);
  const hidden = bucket.contacts.length - shown.length;
  return (
    <div className="mb-1 overflow-hidden rounded-lg border border-border-strong">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
            <th className="px-3 py-1.5 font-semibold">Contact</th>
            <th className="px-2 py-1.5 font-semibold">Company</th>
            <th className="px-2 py-1.5 text-right font-semibold">Touches</th>
            <th className="px-2 py-1.5 font-semibold">Owner</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.contact_id} className="border-t border-border-strong">
              <td className="px-3 py-1.5">
                <Link to={`/jobs/contacts/${c.contact_id}`}
                  className="font-medium text-ink hover:text-accent hover:underline">
                  {c.name ?? "—"}
                </Link>
              </td>
              <td className="max-w-[220px] truncate px-2 py-1.5 text-ink-2">{c.company ?? "—"}</td>
              <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-ink">{c.touches}</td>
              <td className="px-2 py-1.5 text-ink-3">{c.owner ? nameOf(c.owner) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <button type="button" onClick={() => setShowAll(true)}
          className="w-full border-t border-border-strong px-3 py-1.5 text-left text-[11.5px] font-medium text-accent hover:bg-surface-2">
          Show {hidden} more
        </button>
      ) : null}
      {/* The server caps each bucket, so say what isn't here rather than
          implying the list is complete. */}
      {showAll && bucket.truncated > 0 ? (
        <div className="border-t border-border-strong px-3 py-1.5 text-[11px] text-ink-4">
          {bucket.truncated} beyond the first {bucket.contacts.length} not loaded
        </div>
      ) : null}
    </div>
  );
}

// ── Follow-up depth ───────────────────────────────────────────────────────────
// "Are we actually following up, or touching once and moving on." Cohort is the
// contacts that entered initial outreach this period; the bars are how many
// logged touches each has. Server-computed off the same activity filters as the
// drills, so it can't disagree with the rest of the tab.
/** Slice colour per bucket. Zero touches is the red one on purpose — it is the
 *  follow-up gap this panel exists to surface — and the rest run pale to strong
 *  as the depth climbs, so a well-worked queue reads as a ring that darkens. */
const TOUCH_COLORS: Record<string, string> = {
  "0": "#a8364b",
  "1": "#c9c4fb",
  "2": "#a79dfa",
  "3": "#8271f8",
  "4plus": "#5b45f0",
  fallback: "#c7c7f5",
};

function TouchDepthPanel({ scope, owner, nameOf, className }: {
  scope: OutreachScopeKind;
  owner?: string;
  nameOf: (email: string) => string;
  /** "h-full" when it shares a grid row with Outreach Trends. */
  className?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { data: depth, isLoading } = useTouchDepth(scope, owner);
  const buckets = depth?.buckets ?? [];
  // Recharts drops a zero-value slice anyway, and an empty bucket is still
  // worth reading ("nobody has had 3 touches" is a finding), so the numbers
  // list every bucket and only the ring is filtered.
  const slices = useMemo(() => buckets.filter((b) => b.count > 0), [buckets]);
  const openBucket = buckets.find((b) => b.key === open) ?? null;
  return (
    <Panel
      title="Touch Depth"
      // Spells out both halves of the measure, because "3 touches" is
      // meaningless without knowing over what window and for whom. "Right now"
      // is load-bearing: this panel does not follow the period bar.
      desc={depth
        ? `All ${depth.total} contacts sitting in initial outreach right now, by touches received in the last ${depth.weeks} weeks`
        : "Loading…"}
      className={className}
    >
      {isLoading || !depth ? (
        <div className="h-28 animate-pulse rounded bg-surface-2" />
      ) : depth.total === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
          Nobody is sitting in initial outreach.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Numbers left, ring right (Kwame 2026-09-21). The bars that used to
              sit between the label and the counts are gone: they encoded share,
              which is what the ring now says, and they pushed the two numbers
              people actually read out to the far edge of the card. */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-[210px] flex-1 flex-col">
              {/* A header, because "50% · 41" is ambiguous without one and this
                  panel has no column headings anywhere else to borrow. */}
              <div className="grid grid-cols-[14px_1fr_46px_52px] items-center gap-2 px-1.5 pb-1">
                <span /><span />
                <span className="text-right text-[9px] font-semibold uppercase tracking-wider text-ink-4">Share</span>
                <span className="text-right text-[9px] font-semibold uppercase tracking-wider text-ink-4">Contacts</span>
              </div>
              {buckets.map((b) => {
                const isOpen = open === b.key;
                const zero = b.key === "0";
                // The whole row is the control, as it was when it was a bar.
                // Clicking a row and having nothing happen is the kind of dead
                // affordance that makes people stop trying.
                const toggle = () => b.count > 0 && setOpen(isOpen ? null : b.key);
                return (
                  <div
                    key={b.key}
                    role={b.count > 0 ? "button" : undefined}
                    tabIndex={b.count > 0 ? 0 : undefined}
                    onClick={toggle}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                    title={b.count > 0 ? `Show the ${b.count} contacts with ${b.label.toLowerCase()}` : undefined}
                    className={cn("grid grid-cols-[14px_1fr_46px_52px] items-center gap-2 rounded-md px-1.5 py-[6px]",
                      b.count > 0 && "cursor-pointer hover:bg-surface-2/50",
                      isOpen && "bg-surface-2/50")}
                  >
                    <span className="h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: TOUCH_COLORS[b.key] ?? TOUCH_COLORS.fallback,
                               opacity: b.count === 0 ? 0.3 : 1 }} />
                    <span className={cn("truncate text-[12.5px] font-medium",
                      b.count === 0 ? "text-ink-4" : zero ? "text-[#8f2f3f]" : "text-ink")}>
                      {b.label}
                    </span>
                    <span className={cn("text-right text-[12.5px] font-semibold tabular-nums",
                      b.count === 0 ? "text-ink-4" : isOpen ? "text-accent" : zero ? "text-[#8f2f3f]" : "text-ink")}>
                      {b.pct}%
                    </span>
                    <span className={cn("text-right text-[12px] tabular-nums",
                      b.count === 0 ? "text-ink-4" : "text-ink-2")}>
                      {b.count}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="relative h-[170px] w-[170px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices} dataKey="count" nameKey="label"
                    cx="50%" cy="50%" innerRadius={53} outerRadius={80}
                    paddingAngle={1.5} stroke="var(--color-surface)" strokeWidth={2}
                    // By index, not by the datum: TouchDepthBucket has its own
                    // `key` field and recharts types the one it hands back as
                    // React's Key. The index is unambiguous.
                    onClick={(_d, i: number) => {
                      const k = slices[i]?.key;
                      if (k) setOpen(open === k ? null : k);
                    }}
                    className="cursor-pointer"
                  >
                    {slices.map((b) => (
                      <Cell key={b.key} fill={TOUCH_COLORS[b.key] ?? TOUCH_COLORS.fallback}
                        opacity={open && open !== b.key ? 0.35 : 1} />
                    ))}
                  </Pie>
                  <ReTooltip
                    formatter={(v, _n, item) => {
                      const b = (item as { payload?: TouchDepthBucket })?.payload;
                      return [`${v} contacts · ${b?.pct ?? 0}%`, b?.label ?? ""];
                    }}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* The hole carries the queue total, which the bars had nowhere to
                  put. pointer-events-none so it never eats a click meant for the
                  slice underneath it. */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[19px] font-semibold tabular-nums leading-none text-ink">{depth.total}</span>
                <span className="mt-0.5 text-[9px] uppercase tracking-wider text-ink-4">in queue</span>
              </div>
            </div>
          </div>
          {/* Below the whole row, not inside the list: the drill is a four-column
              table, and it was unreadable squeezed into half the card. */}
          {openBucket ? <TouchDepthDrill bucket={openBucket} nameOf={nameOf} /> : null}
        </div>
      )}
    </Panel>
  );
}


// ── Daily digest — Avni's morning Slack, computed ────────────────────────────
const startOfWeekSunday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

/** Per-owner "this week": current assigned queue + contacts moved to Initial
 *  outreach this week — the same numbers as Jobs Home's progress strip,
 *  rolled up per person for the meeting. */
const CELL_DRILL_CAP = 10;

/** The contacts behind an Assigned-set / Contacted number: who, when they hit
 *  the stage, and how much outreach they've had. All of it is already on the
 *  contact rows the table counts, so this needs no extra fetch. */
/** Connected staff as a count you hover rather than a list of names — five
 *  names inline pushed the table into a horizontal scroll, and the question is
 *  usually "does anyone here know them?" not "who exactly". */
/** Connected staff, named on the row rather than hidden behind a tooltip.
 *
 *  This used to be a count with the names only in a `title`. Two problems: a
 *  native tooltip takes about a second and is easy to miss entirely, and
 *  `cursor-help` renders as a question-mark cursor — so hovering "3" gave you a
 *  question mark and nothing else. A popover wouldn't help either: the drill
 *  card clips with overflow-hidden, so an absolutely positioned one gets cut
 *  off mid-table. First names fit the column and need no interaction at all. */
function StaffBadge({ names }: { names?: string[] }) {
  const list = names ?? [];
  if (list.length === 0) return <span className="text-[11px] text-ink-4">—</span>;
  const head = list.slice(0, STAFF_INLINE_CAP);
  const rest = list.slice(STAFF_INLINE_CAP);
  return (
    <span
      title={`Connected staff: ${list.join(", ")}`}
      className="inline-flex max-w-[190px] items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2">
      <Users size={10} className="shrink-0 text-ink-3" />
      <span className="truncate">
        {head.map(firstNameOf).join(", ")}
        {rest.length > 0 ? ` +${rest.length}` : ""}
      </span>
    </span>
  );
}

/** Names shown before falling back to "+n". Three first names fit the column;
 *  the title still carries the full list. */
const STAFF_INLINE_CAP = 3;

/** First name only — "Avni Nahar" → "Avni". Keeps several connections legible
 *  in a narrow cell; the full names are in the title. */
function firstNameOf(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

/** Campaign tags. Two inline, the rest behind a +n whose tooltip names them.
 *  `labelOf` turns the stored slug into the catalog label — the API returns
 *  "other_hiring_partner" and nobody should have to read that. */
function TagChips({ tags, labelOf }: { tags?: string[]; labelOf: (slug: string) => string }) {
  const list = (tags ?? []).map(labelOf);
  if (list.length === 0) return <span className="text-[11px] text-ink-4">—</span>;
  const head = list.slice(0, 2);
  const rest = list.slice(2);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {head.map((t) => (
        <span key={t} title={t}
          className="max-w-[136px] truncate rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent">
          {t}
        </span>
      ))}
      {rest.length > 0 && (
        <span title={rest.join(", ")} className="cursor-help text-[10.5px] font-medium text-ink-3">
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** slug → catalog label, falling back to a de-slugged version so an
 *  uncatalogued tag still reads as words rather than snake_case. */
function useTagLabels() {
  const { data: catalog = [] } = useContactTagCatalog();
  return useMemo(() => {
    const m = new Map(catalog.map((t) => [t.slug, t.label]));
    return (slug: string) =>
      m.get(slug) ?? slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }, [catalog]);
}

/** What the touches actually were — the last conversation, in the row. Reads
 *  the contact-detail endpoint, which already returns subject + snippet per
 *  activity, so this needed no new API. */
function TouchLog({ contactId }: { contactId: number }) {
  const { data, isLoading, isError } = useContactDetail(contactId);
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 size={12} className="animate-spin" /> Loading the touches…</div>;
  if (isError) return <div className="text-[12px] text-red">Couldn't load the touches.</div>;
  const jobs = (data?.activity ?? []).filter((a) => a.is_jobs);
  // Fall back to everything logged rather than claiming there are no touches:
  // the count on the row comes from a different relevance rule than is_jobs.
  const acts = jobs.length > 0 ? jobs : (data?.activity ?? []);
  if (acts.length === 0) return <div className="text-[12px] text-ink-4">Nothing logged against this contact yet.</div>;
  const shown = showAll ? acts : acts.slice(0, TOUCH_LOG_CAP);
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((a) => {
        const inbound = a.email_from ? !a.email_from.toLowerCase().includes("@pursuit.org") : false;
        return (
          <div key={a.id} className="flex items-start gap-2 text-[12px]">
            <span className={cn("mt-[1px] w-[52px] shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold uppercase",
              inbound ? "bg-green-soft text-green" : "bg-surface-2 text-ink-3")}>
              {inbound ? "reply" : a.type}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-ink">{a.subject || "(no subject)"}</span>
              {a.email_snippet || a.description ? (
                <span className="mt-0.5 block line-clamp-2 text-[11.5px] leading-snug text-ink-3">
                  {a.email_snippet || a.description}
                </span>
              ) : null}
            </span>
            <span className="w-[112px] shrink-0 truncate text-right text-[11px] text-ink-4"
              title={a.email_from || a.logged_by || undefined}>
              {a.email_from || a.logged_by || "—"}
            </span>
            <span className="w-[54px] shrink-0 text-right text-[11px] tabular-nums text-ink-4">
              {relDay(a.activity_date) ?? "—"}
            </span>
          </div>
        );
      })}
      {!showAll && acts.length > TOUCH_LOG_CAP ? (
        <button type="button" onClick={() => setShowAll(true)}
          className="self-start text-[11.5px] font-medium text-accent hover:underline">
          Show {acts.length - TOUCH_LOG_CAP} older
        </button>
      ) : null}
    </div>
  );
}

function ContactCellDrill({ label, contacts, whenLabel }: {
  label: string;
  contacts: JobContactWithDeal[];
  whenLabel: string;
}) {
  const [showAll, setShowAll] = useState(false);
  /** Which contact's touch log is expanded — one at a time. */
  const [openTouches, setOpenTouches] = useState<number | null>(null);
  const tagLabel = useTagLabels();
  const sorted = useMemo(() => [...contacts].sort((a, b) =>
    (b.membership_stage_entered_at ?? "").localeCompare(a.membership_stage_entered_at ?? "")),
    [contacts]);
  const shown = showAll ? sorted : sorted.slice(0, CELL_DRILL_CAP);
  const extra = sorted.length - shown.length;

  if (contacts.length === 0) return <div className="text-[12px] text-ink-4">No contacts.</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      <div className="flex items-center justify-between border-b border-border-strong px-3 py-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
        <span className="text-[11px] tabular-nums text-ink-4">{sorted.length}</span>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
            <th className="px-3 py-1.5 font-semibold">Contact</th>
            <th className="px-2 py-1.5 font-semibold">Company</th>
            <th className="px-2 py-1.5 font-semibold" title="Pursuit staff with a relationship to this contact">Staff</th>
            <th className="px-2 py-1.5 font-semibold" title="Campaign tags on this contact">Tags</th>
            <th className="px-2 py-1.5 font-semibold">{whenLabel}</th>
            <th className="px-2 py-1.5 text-right font-semibold" title="Logged jobs touches — click a count to read them">Touches</th>
            <th className="px-2 py-1.5 text-right font-semibold">Last touch</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => {
            const touches = c.recent_activity_count ?? 0;
            const isOpen = openTouches === c.contact_id;
            return (
              <Fragment key={c.contact_id}>
                <tr className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link to={`/jobs/contacts/${c.contact_id}`} className="font-medium text-ink hover:text-accent hover:underline">
                      {c.full_name ?? "—"}
                    </Link>
                  </td>
                  <td className="max-w-[160px] truncate px-2 py-1.5 text-ink-2" title={c.current_company ?? undefined}>
                    {c.current_company ?? "—"}
                  </td>
                  <td className="px-2 py-1.5"><StaffBadge names={c.connected_staff_names} /></td>
                  <td className="px-2 py-1.5"><TagChips tags={c.crm_tags} labelOf={tagLabel} /></td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-3">{relDay(c.membership_stage_entered_at) ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {touches > 0 ? (
                      <button type="button"
                        onClick={() => setOpenTouches(isOpen ? null : c.contact_id)}
                        title={`Read the ${touches} logged touch${touches === 1 ? "" : "es"} on ${c.full_name ?? "this contact"}`}
                        className={cn("font-semibold hover:underline", isOpen ? "text-accent" : "text-ink-2 hover:text-accent")}>
                        {touches}
                      </button>
                    ) : <span className="text-ink-4">0</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-ink-4">{relDay(c.last_activity_at) ?? "—"}</td>
                </tr>
                {isOpen ? (
                  <tr className="border-t border-border-strong bg-bg">
                    <td colSpan={7} className="px-3 py-2"><TouchLog contactId={c.contact_id} /></td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {extra > 0 ? (
        <button type="button" onClick={() => setShowAll(true)}
          className="w-full border-t border-border-strong px-3 py-1.5 text-[11.5px] font-medium text-accent hover:bg-surface-2">
          Show all {sorted.length}
        </button>
      ) : null}
    </div>
  );
}

/** Contacts that entered `assigned` or `initial_outreach` during the period,
 *  bucketed by owner.
 *
 *  Lifted out of the old Outreach Detail table on 2026-09-21 so the Owner cut of
 *  the Activity Pipeline can carry the same numbers in a column (Kwame: fold the
 *  two together). Keeps the contact objects, not just tallies — the drill lists
 *  them, and deriving both from one pass means the number and the list can never
 *  disagree. */
type AssignedContacted = { assigned: JobContactWithDeal[]; contacted: JobContactWithDeal[] };
const EMPTY_AC: AssignedContacted = { assigned: [], contacted: [] };

function useAssignedContacted(range?: OutreachDateRange) {
  const { data: assignedData } = useJobsContacts({ membership_stage: "assigned", limit: 1000 });
  const { data: contactedData } = useJobsContacts({ membership_stage: "initial_outreach", limit: 1000 });
  return useMemo(() => {
    // Contacted is a period event, so it follows the page's Period picker (it
    // used to hardcode the current Sun-week and ignore the selector entirely).
    const pStart = range?.from ? new Date(`${range.from}T00:00:00`) : startOfWeekSunday();
    const pEnd = range?.to ? new Date(`${range.to}T23:59:59.999`) : new Date();
    const by = new Map<string, AssignedContacted>();
    const bucket = (email: string | null | undefined) => {
      const k = (email ?? "").toLowerCase() || "(unowned)";
      const r = by.get(k) ?? { assigned: [], contacted: [] };
      by.set(k, r);
      return r;
    };
    // BOTH sides are period-scoped, so the ratio compares like with like: of the
    // contacts that entered this window, what share got reached. Assigned used
    // to be the whole standing queue against a period-scoped numerator, which
    // made the % drift down as the backlog grew rather than describing the week.
    //
    // `undated` is contacts whose stage entry has no timestamp, so no period can
    // place them. Production currently has zero of these across every stage, but
    // the count stays because nothing guarantees that stays true — a membership
    // written without a stamp would otherwise vanish from the totals silently.
    let undated = 0;
    const inWindow = (c: JobContactWithDeal) => {
      if (!c.membership_stage_entered_at) { undated++; return false; }
      const t = new Date(c.membership_stage_entered_at);
      return t >= pStart && t <= pEnd;
    };
    for (const c of assignedData?.data ?? []) if (inWindow(c)) bucket(c.owner_email).assigned.push(c);
    for (const c of contactedData?.data ?? []) if (inWindow(c)) bucket(c.owner_email).contacted.push(c);
    return { by, undated };
  }, [assignedData, contactedData, range]);
}

/** Sum several owners' buckets into one, for the team line. Summed from the
 *  rows on screen rather than counted separately, so the total can never
 *  disagree with what is under it. */
function sumAC(parts: AssignedContacted[]): AssignedContacted {
  return {
    assigned: parts.flatMap((p) => p.assigned),
    contacted: parts.flatMap((p) => p.contacted),
  };
}

/** The Activity Pipeline table, lifted out of ThisWeekBlock on 2026-09-16 so it
 *  can live on the Outbound Detail sub-tab. Overview shows the summary card in
 *  the space it used to occupy. */
function ActivityPipelineBlock({ activityPipeline, granularity, scope, owner, range, nameOf, rangeLabel, lastRangeLabel, ownerLabel, ownerIsPerson }: {
  activityPipeline?: ScorecardRow[];
  granularity: OutreachGranularity;
  scope: OutreachScopeKind;
  owner?: string;
  range?: OutreachDateRange;
  nameOf: (email: string) => string;
  rangeLabel?: string;
  lastRangeLabel?: string;
  /** Who the table is counting. The control that sets it is the sender picker
   *  up in the period card, several sections away by the time you are reading
   *  this table — so the table states it rather than leaving you to scroll up
   *  and check whose targets you are looking at. */
  ownerLabel?: string;
  /** True when one person is selected, which is what earns the stronger chip. */
  ownerIsPerson?: boolean;
}) {
  // Two cuts of one table: by activity type, or by person. The tab lives in the
  // card header rather than above the card, so it reads as "this table, viewed
  // two ways" instead of two sections that happen to sit together.
  const [cut, setCut] = useState<"activity" | "owner">("activity");
  const tabs = (
    <div className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
      {([["activity", "Activity"], ["owner", "Owner"]] as const).map(([k, label]) => (
        <button key={k} type="button" onClick={() => setCut(k)}
          title={k === "activity" ? "What the team did, by type of touch"
                                  : "Who carried their number, by person"}
          className={cn("rounded px-2 py-0.5 text-[12px] font-medium transition-colors",
            cut === k ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2")}>
          {label}
        </button>
      ))}
    </div>
  );

  if (cut === "owner") {
    // No Viewing chip here: this cut shows every owner at once, so the page's
    // sender filter has nothing to say about it.
    return <OwnerScorecardTable granularity={granularity} range={range}
      rangeLabel={rangeLabel} nameOf={nameOf} leading={tabs} />;
  }
  if (!activityPipeline || activityPipeline.length === 0) return null;
  return (
    <ScorecardTable title="Activity Pipeline" firstColHeader="Activity" rows={activityPipeline}
      idPrefix="act" drillKind="activity" granularity={granularity} scope={scope}
      owner={owner} range={range} nameOf={nameOf} rangeLabel={rangeLabel}
      lastRangeLabel={lastRangeLabel} leading={tabs}
      action={ownerLabel ? <ViewingChip label={ownerLabel} strong={ownerIsPerson} /> : undefined} />
  );
}

// ── Activity Pipeline · the owner cut ────────────────────────────────────────

/** The gap to a target, as a signed number.
 *
 *  One component for both cuts of the Activity Pipeline (Kwame 2026-09-21). The
 *  Activity tab used to show this as a percentage, which asked you to do
 *  arithmetic to answer "how many more do I owe" — the only question the column
 *  is there for. Three states, deliberately distinct: no target is a dash,
 *  exactly on target is a green 0 with no sign, and anything else is signed. */
function DeltaChip({ actual, target }: { actual: number; target: number | null | undefined }) {
  if (target == null) return <span className="text-ink-4">—</span>;
  const d = actual - target;
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[12.5px] font-semibold tabular-nums",
      // Hitting the number exactly is a pass, so 0 is green (Kwame 2026-09-21,
      // reversing the grey we briefly shipped). Red is reserved for a shortfall
      // — the only state that asks someone to do something.
      d >= 0 ? "bg-green-soft text-green" : "bg-red-soft text-red")}>
      {d > 0 ? "+" : ""}{d}
    </span>
  );
}

/** A column-group cap: centred, ruled underneath. Mirrors Volume / Conversion
 *  on Contact Pipeline so the two tables read as one system. */
const GROUP_CAP =
  "block border-b border-border-strong pb-0.5 text-center text-[9.5px] font-bold uppercase tracking-[.1em] text-ink-3";

/** Target, actual and gap for one metric — three cells, used six times. */
/** A metric the backend has not sent yet reads as an empty one rather than
 *  crashing the page. The Owner table grew an Opportunities section on
 *  2026-09-21; against a backend that predates it, `totals.opportunities` is
 *  undefined, and reading `.target` off that blanked the whole Outreach tab the
 *  last time this happened. Normalise where the value is USED, not where it is
 *  fetched — a cached row from React Query never passes through the queryFn. */
const NO_METRIC: OwnerMetric = { target: null, this_period: 0, last_period: 0, delta: null };

function OwnerCells({ m: raw, muted, onOpen, open }: {
  m: OwnerMetric | undefined; muted?: boolean;
  /** Set to make the actual clickable — it opens the same account-grouped
   *  drill the Activity tab uses, filtered to this owner and metric. */
  onOpen?: () => void;
  open?: boolean;
}) {
  const m = raw ?? NO_METRIC;
  const n = scorecardCount(m.this_period);
  return (
    <>
      <td className="px-3 py-2.5 text-center tabular-nums text-ink-3">{m.target ?? "—"}</td>
      <td className="px-3 py-2.5 text-center">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            title="Show the accounts and contacts behind this"
            className={cn("rounded px-1.5 py-0.5 font-semibold tabular-nums transition-colors hover:bg-surface-2",
              open ? "bg-accent-soft text-accent" : muted ? "text-ink-3" : "text-ink")}
          >
            {n}
          </button>
        ) : (
          <span className={cn("font-semibold tabular-nums", muted ? "text-ink-3" : "text-ink")}>{n}</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-center"><DeltaChip actual={n} target={m.target} /></td>
    </>
  );
}

/** Contacted out of assigned, with a short bar under it — the fourth Outreach
 *  column (Kwame 2026-09-21).
 *
 *  Reaching the contacts you were handed is the other half of outreach volume,
 *  and it used to sit in its own table below this one saying the same thing
 *  about the same people. Both numbers stay clickable, so the assigned list and
 *  the contacted list are exactly where they were, one row closer. The bar is
 *  deliberately short: it is a glance at the ratio, not a second reading of it. */
function ContactedCell({ r, muted, onOpen, openWhich }: {
  r: AssignedContacted;
  muted?: boolean;
  onOpen?: (which: "assigned" | "contacted") => void;
  openWhich?: "assigned" | "contacted" | null;
}) {
  const total = r.assigned.length + r.contacted.length;
  const pct = total ? Math.round((100 * r.contacted.length) / total) : 0;
  const num = (which: "assigned" | "contacted", n: number, cls: string, title: string) =>
    onOpen && n > 0 ? (
      <button type="button" onClick={() => onOpen(which)} title={title}
        className={cn("rounded px-0.5 tabular-nums hover:underline",
          openWhich === which ? "text-accent" : cls)}>
        {n}
      </button>
    ) : <span className={cn("tabular-nums", cls)}>{n}</span>;
  return (
    <td className="px-3 py-2.5 text-center">
      <div className="inline-flex flex-col items-center gap-1">
        <span className="text-[13px] font-semibold">
          {num("contacted", r.contacted.length, muted || !r.contacted.length ? "text-ink-3" : "text-green",
            `List the ${r.contacted.length} of ${total} reached in this period`)}
          <span className="font-normal text-ink-4"> / </span>
          {num("assigned", total, muted ? "text-ink-3" : "text-ink-2",
            `List the ${total} contacts that entered this period`)}
          <span className="ml-1 text-[10.5px] font-normal text-ink-4">({pct}%)</span>
        </span>
        <div className="h-1 w-16 overflow-hidden rounded-full border border-border-strong bg-surface-2"
          title={`${r.contacted.length} of ${total} contacted in this period`}>
          <div className="h-full rounded-full bg-green transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </td>
  );
}

/** The Activity Pipeline, cut by person instead of by activity type.
 *
 *  Every owner who carries a target gets a row, whether or not they sent
 *  anything: a quiet week from someone with a goal is precisely what this table
 *  is for, and a list built from activity would leave them out. Rows arrive
 *  sorted by shortfall, so the conversation you need to have is at the top.
 *
 *  Not clickable. The Activity tab already drills every number behind these,
 *  and per-owner drilling is one sender-filter click away in the period bar. */
function OwnerScorecardTable({ granularity, range, rangeLabel, nameOf, leading, action }: {
  granularity: OutreachGranularity;
  range?: OutreachDateRange;
  rangeLabel?: string;
  nameOf: (email: string) => string;
  leading?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const { data, isLoading } = useOwnerScorecard(granularity, range);
  // "<owner>:<metric>", where metric is an activity key or one of the two
  // pseudo-keys the Contacted / assigned column opens.
  const [open, setOpen] = useState<string | null>(null);
  const rows = data?.rows ?? [];
  // Contacts handed over and reached in the same window, for the fourth
  // Outreach column. Keyed lowercase; a row with no entries reads as 0 / 0.
  const { by: acByOwner, undated } = useAssignedContacted(range);
  const acOf = (email: string) => acByOwner.get(email.toLowerCase()) ?? EMPTY_AC;
  // The team line sums the rows on screen, never the whole map: a contact owned
  // by somebody who carries no target has no row to sit in, so counting it in
  // the total would make the column not add up.
  const acTotal = useMemo(() => sumAC(rows.map((r) => acOf(r.owner))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, acByOwner]);
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
      <CardHead title="Activity Pipeline" leading={leading} action={action} />
      <table className="w-full border-collapse">
        <thead>
          {/* Two header rows: the group spans say which three columns belong to
              which metric, so "Target" appearing twice is never ambiguous. */}
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="py-2 pl-3.5 pr-2 text-left font-bold align-bottom" rowSpan={2}>Owner</th>
            {/* Same treatment as Volume / Conversion on Contact Pipeline: a
                centred cap with a rule under it, so the three columns beneath
                read as belonging to it. */}
            <th className="border-l border-border px-2 pt-2 pb-1" colSpan={4}>
              <span className={GROUP_CAP}>Outreach</span>
            </th>
            <th className="border-l border-border px-2 pt-2 pb-1" colSpan={3}>
              <span className={GROUP_CAP}>Discovery Calls</span>
            </th>
            {/* Converting is a team outcome, so this group carries a target on
                the team line only — every owner cell reads a dash by design
                (Kwame 2026-09-21). */}
            <th className="border-l border-border px-2 pt-2 pb-1" colSpan={3}>
              <span className={GROUP_CAP}>Opportunities</span>
            </th>
          </tr>
          <tr className="bg-surface-2 text-[10px] uppercase tracking-wide text-ink-4">
            {/* The window sits under "This period", the only column it qualifies.
                It was under Owner, where it read as a property of the person. */}
            {[0, 1, 2].map((i) => (
              <Fragment key={i}>
                <th className="border-l border-border px-3 pb-2 text-center font-semibold align-bottom">Target</th>
                <th className="px-3 pb-2 text-center font-semibold align-bottom">
                  <span className="block">This period</span>
                  <span className="mt-0.5 block h-3.5 text-[9.5px] font-normal normal-case tracking-normal text-ink-4">
                    {rangeLabel ?? ""}
                  </span>
                </th>
                <th className="px-3 pb-2 text-center font-semibold align-bottom">Δ to target</th>
                {/* Outreach carries a fourth: contacts reached out of contacts
                    handed over, for the same window. Calls has no equivalent. */}
                {i === 0 && (
                  <th className="px-3 pb-2 text-center font-semibold align-bottom"
                    title="Of the contacts that entered this owner's queue in this period, how many reached initial outreach. Click either number for the list.">
                    Contacted / assigned
                  </th>
                )}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr><td colSpan={11} className="px-4 py-6 text-center text-[12.5px] text-ink-3">
              <Loader2 size={13} className="mr-1.5 inline animate-spin" />Loading…
            </td></tr>
          )}
          {!isLoading && rows.length === 0 && (
            <tr><td colSpan={11} className="px-4 py-6 text-center text-[12.5px] text-ink-4">
              Nobody carries a target yet.
            </td></tr>
          )}
          {/* The team line leads (Kwame 2026-09-21): you read the group result
              first, then who made it up. Greyed and ruled off so it reads as a
              total rather than a fourth person. It is summed from the rows
              below, never counted separately, so it cannot disagree with them. */}
          {!isLoading && rows.length > 0 && data && (
            <tr className="border-b-2 border-border-strong bg-surface-2/60 text-[13.5px] font-semibold">
              <td className="px-3.5 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-ink-3">
                All jobs team
              </td>
              <OwnerCells m={data.totals.outreach} muted />
              <ContactedCell r={acTotal} muted />
              <OwnerCells m={data.totals.calls} muted />
              <OwnerCells m={data.totals.opportunities} muted />
            </tr>
          )}
          {rows.map((r) => {
            const openKey = (metric: string) => `${r.owner}:${metric}`;
            const isOpen = (metric: string) => open === openKey(metric);
            const toggle = (metric: string) => setOpen(isOpen(metric) ? null : openKey(metric));
            const openMetric = open?.startsWith(`${r.owner}:`) ? open.split(":").pop()! : null;
            return (
              <Fragment key={r.owner}>
                <tr className={cn("text-[13.5px]", !openMetric && "border-b border-border")}>
                  <td className="px-3.5 py-2.5 text-left font-medium text-ink" title={r.owner}>{nameOf(r.owner)}</td>
                  <OwnerCells m={r.outreach} open={isOpen("total_outreach_activity")}
                    onOpen={() => toggle("total_outreach_activity")} />
                  <ContactedCell r={acOf(r.owner)} onOpen={toggle}
                    openWhich={openMetric === "assigned" || openMetric === "contacted" ? openMetric : null} />
                  <OwnerCells m={r.calls} open={isOpen("call_discovery")}
                    onOpen={() => toggle("call_discovery")} />
                  <OwnerCells m={r.opportunities} open={isOpen("converted_opportunities")}
                    onOpen={() => toggle("converted_opportunities")} />
                </tr>
                {openMetric && (
                  <tr>
                    <td colSpan={11} className="border-b border-border bg-bg p-0">
                      {openMetric === "assigned" || openMetric === "contacted" ? (
                        // The contact list the Outreach Detail table used to
                        // open, unchanged — same rows, same columns, now under
                        // the number it belongs to.
                        <div className="px-3 py-2">
                          <ContactCellDrill
                            label={openMetric === "assigned"
                              ? `${nameOf(r.owner)} · entered this period`
                              : `${nameOf(r.owner)} · contacted this period`}
                            // "Assigned" is the queue PLUS those already
                            // contacted, so its drill lists both — otherwise
                            // clicking 26 shows 23.
                            contacts={openMetric === "assigned"
                              ? [...acOf(r.owner).assigned, ...acOf(r.owner).contacted]
                              : acOf(r.owner).contacted}
                            whenLabel={openMetric === "assigned" ? "Entered stage" : "Contacted"}
                          />
                        </div>
                      ) : (
                        // Same drill as the Activity tab: account first, its
                        // contacts under it, five at a time, each expanding to
                        // the actual touches. Scoped to this person by `owner`.
                        <RowDrill kind="activity" rowKey={openMetric} granularity={granularity}
                          scope="pursuit" owner={r.owner} range={range} nameOf={nameOf} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {/* Contacted / assigned counts entries INTO a stage during the period.
          Contacts with no stage stamp can't be placed in time, so they're named
          here rather than quietly missing from the column. */}
      {/* The opportunities column does not add up, on purpose. Saying so beats a
          reader discovering it (Kwame's team line counts every conversion; only
          about a quarter of them resolve to a person at all). */}
      {(data?.unattributed?.opportunities ?? 0) > 0 && (
        <div className="border-t border-border-strong bg-surface-2 px-4 py-2 text-[11px] text-ink-4"
          title="A conversion is attributed through the membership owner, the account owner, then whoever did the first outreach. Most carry none of the three.">
          {data!.unattributed!.opportunities} of the {scorecardCount(data!.totals.opportunities?.this_period)} opportunities
          {" "}this period carry no owner, so they sit in the team line only
        </div>
      )}
      {undated > 0 && (
        <div className="border-t border-border-strong bg-surface-2 px-4 py-2 text-[11px] text-ink-4"
          title="These contacts have no stage timestamp, so no period can claim them. The stage-history grant fills most of them in.">
          {undated} contact{undated === 1 ? "" : "s"} without a stage date, not counted under Contacted / assigned
        </div>
      )}
    </div>
  );
}

/** Whose numbers are on screen, as a chip rather than a sentence.
 *
 *  Filled accent when one person is selected and quiet grey for a whole group:
 *  a filter narrowed to an individual is the state you can forget you are in
 *  and then misread a target by, so that is the one that should catch the eye. */
function ViewingChip({ label, strong }: { label: string; strong?: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium",
      strong ? "bg-accent-soft text-accent" : "border border-border-strong bg-surface text-ink-3",
    )}>
      <Users size={11} className={strong ? "text-accent" : "text-ink-4"} />
      <span className="uppercase tracking-wide text-[10px] font-semibold opacity-70">Viewing</span>
      <span className="font-semibold">{label}</span>
    </span>
  );
}

/** The send feed, same component the campaign view uses. No owner control of
 *  its own: the page's sender filter already scopes it, and two owner controls
 *  over one list would just fight. */
function OutboundActivityFeed({ granularity, scope, owner, range }: {
  granularity: OutreachGranularity;
  scope: OutreachScopeKind;
  owner?: string;
  range?: OutreachDateRange;
}) {
  const { data, isLoading } = useOutreachActivity(granularity, scope, owner, range);
  return (
    <ActivityFeed
      events={data?.events ?? []}
      owners={[]}
      isLoading={isLoading}
      title="Activity"
      note="Every email, LinkedIn message and text sent in this period. Owner is who the contact belongs to; Editor is who sent it. Click a row for the contacts behind it."
      showSegments={false}
    />
  );
}

/** Accounts activated · outreach activity · calls booked · conversions, over
 *  the page's own window and sender scope. Shown on both sub-tabs: Overview
 *  needs the headline, Outbound Detail needs it as the footing for the tables
 *  below it. Each card opens the list behind its number. */
const SUMMARY_CARDS: {
  key: keyof OutreachSummary["drills"];
  label: string;
  tone: "ink" | "green";
  empty: string;
}[] = [
  { key: "accounts_activated", label: "Accounts activated", tone: "ink", empty: "No accounts came back from quiet in this period." },
  { key: "outreach_activity", label: "Outreach Activity", tone: "ink", empty: "Nothing sent in this period." },
  { key: "calls_booked", label: "Calls booked", tone: "ink", empty: "No calls or meetings in this period." },
  { key: "converted", label: "Converted to oppty", tone: "green", empty: "No conversions in this period." },
];

function OutreachSummaryCards({ granularity, scope, owner, range }: {
  granularity: OutreachGranularity;
  scope: OutreachScopeKind;
  owner?: string;
  range?: OutreachDateRange;
}) {
  const { data, isLoading } = useOutreachSummary(granularity, scope, owner, range);
  const [open, setOpen] = useState<keyof OutreachSummary["drills"] | null>(null);
  const openCard = SUMMARY_CARDS.find((c) => c.key === open);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 items-stretch gap-4 lg:grid-cols-4">
        {SUMMARY_CARDS.map((c) => {
          const active = open === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setOpen(active ? null : c.key)}
              aria-expanded={active}
              className={cn(
                "rounded-2xl border bg-surface px-5 py-4 text-left transition-colors",
                active ? "border-accent ring-1 ring-accent/30" : "border-border-strong hover:border-accent",
              )}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{c.label} ›</div>
              {isLoading ? (
                <div className="mt-2 h-8 w-16 animate-pulse rounded bg-surface-2" />
              ) : (
                <div className={cn("mt-1.5 text-[30px] font-bold leading-none tabular-nums",
                  c.tone === "green" ? "text-green" : "text-ink")}>
                  {data?.[c.key] ?? 0}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {openCard ? (
        <section className="rounded-2xl border border-border-strong bg-surface px-5 py-4">
          <h3 className="mb-3 text-[13px] font-semibold text-ink">{openCard.label}</h3>
          <DrillList rows={data?.drills?.[openCard.key] ?? []} emptyLabel={openCard.empty} />
        </section>
      ) : null}
    </div>
  );
}

/** Hygiene: the accountability strip + the assigned-but-no-prospect table. */
/** Accounts a jobs-team member owns with nobody flagged into the prospect list.
 *  Shared by the Requiring Attention card (count) and its detail table, so the
 *  headline number and the rows can never disagree. */

export function JobsOutreach() {
  // Bucket size follows the period preset; scope is the three-way sender filter.
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  const [scope, setScope] = useState<OutreachScopeKind>("team");
  const [owner, setOwner] = useState<string>("");   // "" = whole scope
  // Defaults to the completed week (see defaultPeriod) rather than the one in
  // progress — on a Monday the current week is two days of nothing.
  const [from, setFrom] = useState(() => defaultPeriod()[0]);
  const [to, setTo] = useState(() => defaultPeriod()[1]);
  const range: OutreachDateRange | undefined = from && to ? { from, to } : undefined;

  const { data: staff = [] } = useJobsStaff();
  const nameOf = (email: string) => staff.find((s) => s.email.toLowerCase() === email.toLowerCase())?.name || email.split("@")[0];
  const { data: sc, isLoading, isError } = useOutreachScorecard(granularity, scope, owner || undefined, range);
  // Both labels derive from the period card's own dates, never from the
  // response — see fmtDayRange. Whatever the card says is what "This period"
  // says, and "Last period" is the equal-length window before it.
  const rangeLabel = useMemo(() => (from && to ? fmtDayRange(from, to) : ""), [from, to]);
  const lastRangeLabel = useMemo(() => {
    if (!from || !to) return "";
    const [lf, lt] = priorDayRange(from, to);
    return fmtDayRange(lf, lt);
  }, [from, to]);



  // The picker splits into pinned and everyone else. Pinned keeps JOBS_TEAM_PINNED's
  // order (it is a priority list, not an alphabet); the rest sorts by name.
  const [pinnedStaff, otherStaff] = useMemo(() => {
    const pins = JOBS_TEAM_PINNED.map((e) => e.toLowerCase());
    const byEmail = new Map(staff.map((st) => [st.email.toLowerCase(), st]));
    const pinned = pins.map((e) => byEmail.get(e)).filter((st): st is typeof staff[number] => !!st);
    const rest = staff.filter((st) => !pins.includes(st.email.toLowerCase()))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    return [pinned, rest];
  }, [staff]);

  // Whose numbers the pipeline table is showing. With nobody selected it is the
  // scope, not "all jobs team": Other Staff with no owner is a real state, and
  // labelling it as the jobs team would be a lie on the face of the table.
  const senderLabel = owner
    ? nameOf(owner)
    : { team: "All jobs team", staff: "Other staff", pursuit: "Everyone at Pursuit" }[scope];

  // One page. The Outbound Detail sub-tab is gone (Kwame 2026-09-21): Targeting
  // Mix was cut, Requiring attention moved to Jobs Home, and a tab strip with
  // one tab left in it is chrome that costs a row and answers nothing.

  return (
    <div className="flex flex-col gap-6 pt-3">
      {/* ── ZONE 1 · the selected period ──────────────────────────────────
             This bar governs everything down to the Current state boundary,
             and nothing below it. It used to float above the whole page, which
             is what made it look like it filtered Requiring Attention too. ── */}
      <section
        aria-label="In period"
        // Deliberately unfilled: the border + radius carry the zone boundary on
        // their own. The pale blue fill (bg-accent-soft) that used to sit here
        // read as a highlight on half the page rather than as a container.
        className="flex flex-col gap-6 rounded-2xl border border-border-strong p-3 sm:p-4"
      >
        <PeriodBar
          from={from} to={to}
          onChange={(f, t) => { setFrom(f); setTo(t); }}
          granularity={granularity} onGranularityChange={setGranularity}
        >
          <ScopeButtons value={scope} onChange={(v) => { setScope(v); setOwner(""); }} />
          {/* One row, as it was. The jobs team is grouped to the top of the list
              rather than broken out into buttons: four names you reach without
              scrolling is the whole benefit, and a button strip spent a row of
              the card to save the same click (Kwame 2026-09-21). */}
          <select value={owner} onChange={(e) => setOwner(e.target.value)}
            className="h-7 max-w-[190px] rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent"
            title="Filter every section to one person">
            <option value="">All senders</option>
            {pinnedStaff.length > 0 && (
              <optgroup label="Jobs Team">
                {pinnedStaff.map((st) => (
                  <option key={st.email} value={st.email}>{st.name || st.email}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Other Pursuit staff">
              {otherStaff.map((st) => (
                <option key={st.email} value={st.email}>{st.name || st.email}</option>
              ))}
            </optgroup>
          </select>
        </PeriodBar>



      {/* Contact Pipeline opens the review again — it is the top of the
              funnel everything below is downstream of (Kwame 2026-09-21). */}
          <JobsFunnels only="prospects" period={range} periodLabel={rangeLabel || undefined} />

          <OutreachSummaryCards granularity={granularity} scope={scope}
            owner={owner || undefined} range={range} />

          {isError && <div className="rounded-lg border border-red-soft bg-red-soft px-4 py-3 text-[13px] text-red">Couldn't load the scorecard. Try again in a moment.</div>}
          {isLoading && !sc && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {[0, 1].map((i) => <div key={i} className="h-64 animate-pulse rounded-xl border border-border-strong bg-surface-2" />)}
            </div>
          )}

          <ActivityPipelineBlock activityPipeline={sc?.activity_pipeline}
            granularity={granularity} scope={scope} owner={owner || undefined}
            range={range} nameOf={nameOf} rangeLabel={rangeLabel || undefined}
            lastRangeLabel={lastRangeLabel || undefined}
            ownerLabel={senderLabel} ownerIsPerson={!!owner} />
          {/* Outreach Detail is gone (Kwame 2026-09-21): its two numbers and its
              two contact lists are now the Contacted / assigned column on the
              Activity Pipeline's Owner cut, next to the outreach volume they
              qualify, instead of repeating the same owners in a second table. */}

          {/* Volume over time, and whether that volume is follow-up or one-and-
              done. They answer the same question from two sides, so they read
              better side by side than a screen apart. Stacks below lg, where
              half width would squeeze the trend line into noise.
              Note the asymmetry, which is deliberate and stated in Touch
              Depth's own subtitle: the trend follows the period bar, Touch
              Depth is always "right now". */}
          <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
            <ActivityTrends scope={scope} owner={owner || undefined} range={range} />
            <TouchDepthPanel scope={scope} owner={owner || undefined} nameOf={nameOf} className="h-full" />
          </div>

          <OutboundActivityFeed granularity={granularity} scope={scope}
            owner={owner || undefined} range={range} />
      </section>

    </div>
  );
}


