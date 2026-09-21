import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BarChart3, ChevronRight, ChevronDown, Loader2, Send, Users } from "lucide-react";

import { toast } from "sonner";
import {
  useOutreachScorecard,
  useOutreachSummary,
  useOutreachActivity,
  useOutreachDrill,
  useOutreachTargetingMix,
  useJobsStaff,
  useJobsContacts,
  useContactDetail,
  useContactTagCatalog,
  useJobsAccounts,
  useStuckContacts,
  useRespondedContacts,
  useUpdateJobsMembership,
  inScope,
  JOBS_TEAM_PINNED,
  MEMBERSHIP_STAGE_LABELS,
  type OutreachGranularity,
  type OutreachScopeKind,
  type OutreachSummary,
  type OutreachDateRange,
  type ScorecardRow,
  useTouchDepth,
  type TouchDepthBucket,
  type JobContactWithDeal,
  type MembershipStage,
} from "@/services/jobs";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { useContactStageChange } from "@/lib/useContactStageChange";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { Panel, BreakdownBars } from "./JobsOpportunitiesOverview";
import { ActivityTrends } from "@/components/jobs/ActivityTrends";
import { ActivityFeed } from "@/components/jobs/ActivityFeed";
import { DrillList } from "@/components/jobs/DrillList";
import { PeriodBar, ScopeButtons, defaultPeriod } from "@/components/jobs/PeriodBar";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const DRILL_PAGE = 25;

type OutreachSub = "overview" | "detail";
const OUTREACH_SUBS: { key: OutreachSub; label: string; icon: typeof BarChart3; title: string }[] = [
  { key: "overview", label: "Overview", icon: BarChart3, title: "The Monday review — volume against target, who did what, and the trend" },
  // Still called Outbound Detail. It now holds the supporting cuts rather than
  // the volume table, so the name is due a rethink — Kwame's call, not mine.
  { key: "detail", label: "Outbound Detail", icon: Send, title: "Supporting detail — segment mix, touch depth and the live queues" },
];
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
function fmtRange(startISO: string, endISO: string) {
  // end is exclusive (start-of-next-day) — show the last included day.
  const end = new Date(new Date(endISO).getTime() - 1);
  const y = end.getFullYear();
  return `${fmtDate(startISO)} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${y}`;
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

function RowDrill({
  kind, rowKey, granularity, scope, owner, range, nameOf,
}: {
  kind: "user" | "activity"; rowKey: string;
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
  /** Resolves an actor email to a staff name for the Owner column. */
  nameOf: (email: string) => string;
}) {
  const [openContact, setOpenContact] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError } = useOutreachDrill({ kind, key: rowKey, period: "this", granularity, scope, owner, range });

  if (isLoading) return <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>;
  if (isError) return <div className="px-4 py-3 text-[12.5px] text-red">Couldn't load the detail.</div>;
  if (!data || data.contacts.length === 0) return <div className="px-4 py-3 text-[12.5px] text-ink-4">No records in this period.</div>;

  const shown = showAll ? data.contacts : data.contacts.slice(0, DRILL_PAGE);
  return (
    <div className="flex flex-col divide-y divide-border">
      {shown.map((c) => {
        const open = openContact.has(c.contact_id);
        return (
          <div key={c.contact_id}>
            <button
              onClick={() => setOpenContact((prev) => { const n = new Set(prev); n.has(c.contact_id) ? n.delete(c.contact_id) : n.add(c.contact_id); return n; })}
              className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-surface-2"
            >
              <span className="w-3.5 text-ink-4">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
              <span className="text-[13px] font-medium text-ink">{c.name || "Unknown contact"}</span>
              <span className="text-[12px] text-ink-3">{c.company || "—"}</span>
              {/* Who worked this contact, without having to expand the row. */}
              <span className="ml-auto shrink-0 text-[11.5px] text-ink-3" title={(c.actors ?? []).map(nameOf).join(", ")}>
                {actorSummary(c.actors, nameOf)}
              </span>
              <span className="w-[74px] shrink-0 text-right text-[11.5px] text-ink-4">{c.touches.length} touch{c.touches.length === 1 ? "" : "es"}</span>
            </button>
            {open && (
              <div className="flex flex-col gap-1 bg-bg px-4 py-2 pl-10">
                {c.touches.length === 0 && <div className="text-[12px] text-ink-4">No jobs touches in this period.</div>}
                {c.touches.length > 0 && (
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
            )}
          </div>
        );
      })}
      {!showAll && data.contacts.length > DRILL_PAGE && (
        <button onClick={() => setShowAll(true)} className="px-4 py-2 text-left text-[12.5px] font-medium text-accent-ink hover:underline">
          Show more ({data.contacts.length - DRILL_PAGE} more)
        </button>
      )}
    </div>
  );
}

// ── A scorecard table (User Pipeline / Activity Pipeline) ─────────────────────
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
  rangeLabel, lastRangeLabel, action,
}: {
  title: string; rows: ScorecardRow[]; idPrefix: string; firstColHeader: string;
  drillKind: "user" | "activity";
  /** Shown in grey under "This Period" so the window is never implicit. */
  rangeLabel?: string;
  /** Same, for the comparison period. */
  lastRangeLabel?: string;
  /** Optional control rendered at the right of the title bar. */
  action?: React.ReactNode;
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
  nameOf: (email: string) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-strong bg-surface-2 px-4 py-2.5">
        <span className="text-[13px] font-bold text-ink-2">{title}</span>
        {action}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="py-2 pl-3.5 pr-2 text-left font-bold align-bottom">{firstColHeader}</th>
            <PeriodHead label="This Period" range={rangeLabel} />
            <PeriodHead label="Last Period" range={lastRangeLabel} />
            <th className="whitespace-nowrap px-2 py-2 text-center font-bold align-bottom">Trend</th>
            <th className="whitespace-nowrap px-2 py-2 text-center font-bold align-bottom">Δ to Target</th>
            <th className="whitespace-nowrap px-3.5 py-2 text-center font-bold align-bottom">Target</th>
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
                  {/* Centred, not right-aligned: the headings carry a second
                      line of dates, and a right-aligned number drifts away from
                      the window it belongs to. */}
                  <td className={cn("px-3.5 py-2.5 text-center tabular-nums", depth === 0 && "font-semibold", pending && "font-normal text-ink-4")}>
                    {pending ? "—" : r.this_period.total}
                  </td>
                  <td className={cn("px-3.5 py-2.5 text-center tabular-nums", pending && "text-ink-4")}>
                    {pending ? "—" : r.last_period.total}
                  </td>
                  <td className="px-3.5 py-2.5 text-center text-[12.5px]">
                    {pending ? <span className="text-ink-4">—</span>
                      : <Trend current={r.this_period.total} prior={r.last_period.total} />}
                  </td>
                  <td className="px-3.5 py-2.5 text-center text-[12.5px]">
                    {!pending && r.target ? <Trend current={r.this_period.total} prior={r.target} /> : <span className="text-ink-4">—</span>}
                  </td>
                  {/* Target renders 0 rather than a dash when unset: the column
                      is a standing prompt that a target is owed, and an em-dash
                      reads as "not applicable". */}
                  <td className="px-3.5 py-2.5 text-center tabular-nums text-ink-3">{pending ? "—" : r.target ?? 0}</td>
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
// ── Targeting mix (Pipeline page's "Active set distribution" idiom) ──────────
function TargetingPanel({ granularity, scope, owner, range }: {
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
}) {
  const { data, isLoading } = useOutreachTargetingMix(granularity, scope, owner, range);
  const dims = data?.dims ?? [];
  const [dimKey, setDimKey] = useState<string>("tag");
  const dim = dims.find((d) => d.key === dimKey) ?? dims[0];
  const items = (dim?.rows ?? []).map((r) => ({ key: r.bucket, label: r.bucket, count: r.sent }));
  return (
    <Panel
      title="Targeting Mix"
      desc="Outreach across segments"
      // Fills the grid row so its bottom edge lines up with Outreach Trends
      // beside it — a few segment bars left a short card next to a tall chart.
      className="h-full"
      action={
        <select value={dimKey} onChange={(e) => setDimKey(e.target.value)}
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent">
          {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
      }
    >
      <BreakdownBars items={items} dim="segment" isLoading={isLoading} />
    </Panel>
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
function TouchDepthPanel({ scope, owner, nameOf }: {
  scope: OutreachScopeKind;
  owner?: string;
  nameOf: (email: string) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { data: depth, isLoading } = useTouchDepth(scope, owner);
  const buckets = depth?.buckets ?? [];
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <Panel
      title="Touch Depth"
      // Spells out both halves of the measure, because "3 touches" is
      // meaningless without knowing over what window and for whom. "Right now"
      // is load-bearing: this panel does not follow the period bar.
      desc={depth
        ? `All ${depth.total} contacts sitting in initial outreach right now, by touches received in the last ${depth.weeks} weeks`
        : "Loading…"}
    >
      {isLoading || !depth ? (
        <div className="h-28 animate-pulse rounded bg-surface-2" />
      ) : depth.total === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
          Nobody is sitting in initial outreach.
        </div>
      ) : (
        <div className="flex flex-col">
          {buckets.map((b) => {
            const isOpen = open === b.key;
            const zero = b.key === "0";
            // The whole row is the control — label, bar and count all open the
            // same list. Clicking a bar and having nothing happen is the kind of
            // dead affordance that makes people stop trying.
            const toggle = () => b.count > 0 && setOpen(isOpen ? null : b.key);
            return (
              <div key={b.key}>
                <div
                  role={b.count > 0 ? "button" : undefined}
                  tabIndex={b.count > 0 ? 0 : undefined}
                  onClick={toggle}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                  title={b.count > 0 ? `Show the ${b.count} contacts with ${b.label.toLowerCase()}` : undefined}
                  className={cn("grid grid-cols-[150px_1fr_74px] items-center gap-3 rounded-md px-1 py-[7px]",
                    b.count > 0 && "cursor-pointer hover:bg-surface-2/50",
                    isOpen && "bg-surface-2/50")}
                >
                  <span className={cn("text-[12.5px] font-medium",
                    zero ? "text-[#8f2f3f]" : "text-ink")}>{b.label}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-surface-2">
                    <span className="block h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${Math.round((100 * b.count) / max)}%`,
                               background: zero
                                 ? "linear-gradient(90deg,#7a2233,#b8556a)"
                                 : "linear-gradient(90deg,#6d5efc,#8b7dff)" }} />
                  </span>
                  <span className="text-right text-[12px] tabular-nums text-ink-2">
                    <span className={cn("font-semibold",
                      b.count === 0 ? "text-ink-4" : isOpen ? "text-accent" : zero ? "text-[#8f2f3f]" : "text-ink")}>
                      {b.count}
                    </span>
                    <span className="text-ink-4"> · {b.pct}%</span>
                  </span>
                </div>
                {isOpen ? <TouchDepthDrill bucket={b} nameOf={nameOf} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ── Section header ────────────────────────────────────────────────────────────
function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-[13px] font-bold uppercase tracking-wider text-ink-3">{title}</h2>
      {note && <span className="text-[12.5px] text-ink-4">{note}</span>}
    </div>
  );
}

// ── Daily digest — Avni's morning Slack, computed ────────────────────────────
// The daily-digest card (digestSlackText + DailyDigestBlock) lived here until
// 2026-09-21, when Kwame removed it from Outbound Detail. Nothing else rendered
// it, so it went with the card rather than sitting unreachable. `useDailyDigest`
// and GET /jobs/daily-digest both remain, so restoring it is a revert of this
// commit, not a rebuild.

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

function ThisWeekBlock({ nameOf, scope, owner, range, onSelectOwner }: {
  nameOf: (email: string) => string;
  scope: OutreachScopeKind;
  owner?: string;
  range?: OutreachDateRange;
  /** Clicking an owner scopes the whole page to them (same state as the
   *  sender dropdown), so the row acts as a filter rather than a dead label. */
  onSelectOwner?: (email: string) => void;
}) {
  const { data: assignedData } = useJobsContacts({ membership_stage: "assigned", limit: 1000 });
  const { data: contactedData } = useJobsContacts({ membership_stage: "initial_outreach", limit: 1000 });
  // Which owner's which column is expanded, e.g. "avni@pursuit.org:contacted".
  const [openCell, setOpenCell] = useState<string | null>(null);

  // Keep the contact objects, not just tallies — the drill lists them, and
  // deriving both from one pass means the number and the list always agree.
  const { rows, undated, hidden } = useMemo(() => {
    // Contacted is a period event, so it follows the page's Period picker (it
    // used to hardcode the current Sun-week and ignore the selector entirely).
    const pStart = range?.from ? new Date(`${range.from}T00:00:00`) : startOfWeekSunday();
    const pEnd = range?.to ? new Date(`${range.to}T23:59:59.999`) : new Date();
    const by = new Map<string, { assigned: JobContactWithDeal[]; contacted: JobContactWithDeal[] }>();
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
    let undated = 0;
    const inWindow = (c: JobContactWithDeal) => {
      if (!c.membership_stage_entered_at) { undated++; return false; }
      const t = new Date(c.membership_stage_entered_at);
      return t >= pStart && t <= pEnd;
    };
    for (const c of assignedData?.data ?? []) {
      if (inWindow(c)) bucket(c.owner_email).assigned.push(c);
    }
    for (const c of contactedData?.data ?? []) {
      if (inWindow(c)) bucket(c.owner_email).contacted.push(c);
    }
    const withEntries = [...by.entries()]
      .filter(([, r]) => r.assigned.length + r.contacted.length > 0);
    const visible = withEntries
      // Honour the page's sender scope: "(unowned)" is nobody's, so it only
      // shows under Everyone.
      .filter(([email]) => (email === "(unowned)" ? scope === "pursuit" : inScope(email, scope)))
      .sort((a, b) => (b[1].assigned.length + b[1].contacted.length) - (a[1].assigned.length + a[1].contacted.length));

    // How many entries the SCOPE hid, as opposed to none existing. Without this
    // the empty state said "no contacts entered this period" while contacts had
    // in fact entered — they were just unowned, or owned by someone outside the
    // selected scope. Reported on 2026-08-12 against Jul 29–Aug 4, where one
    // contact entered `assigned` and carried no owner.
    const hidden = withEntries
      .filter(([email]) => !(email === "(unowned)" ? scope === "pursuit" : inScope(email, scope)))
      .reduce((n, [, r]) => n + r.assigned.length + r.contacted.length, 0);

    // `undated` is contacts whose stage entry has no timestamp, so no period can
    // place them. Production currently has zero of these across every stage, but
    // the count stays because nothing guarantees that stays true — a membership
    // written without a stamp would otherwise vanish from the totals silently.
    return { rows: visible, undated, hidden };
  }, [assignedData, contactedData, range, scope]);
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <SectionHead title="Outreach Detail" />
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
          {hidden > 0 ? (
            <>
              {hidden} contact{hidden === 1 ? "" : "s"} entered a stage in this period, but
              {" "}none are in the current scope. Switch to Everyone to see {hidden === 1 ? "it" : "them"}.
            </>
          ) : (
            <>No contacts entered the assigned or contacted stage in this period.</>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SectionHead title="Outreach Detail" />
      <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
        <div className="flex flex-wrap items-baseline gap-2 border-b border-border-strong bg-surface-2 px-4 py-3">
          <span className="text-[13px] font-bold text-ink-2">Assigned &amp; Contacted</span>
          {/* Both columns count entries INTO a stage during the period. Contacts
              with no stage stamp can't be placed in time, so they're named here
              rather than quietly missing from the totals. */}
          {undated > 0 ? (
            <span className="text-[11px] text-ink-4"
              title="These contacts have no stage timestamp, so no period can claim them. The stage-history grant fills most of them in.">
              {undated} without a stage date, not counted
            </span>
          ) : null}
        </div>
        <table className="w-full text-[12.5px]">
          <thead><tr className="bg-surface-2 text-left text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="py-2.5 pl-3.5 pr-2 text-left font-bold">Owner</th>
            <th className="px-2 py-2.5 text-right font-bold" title="Contacts that entered this owner's queue inside the selected period — click to list them">Assigned</th>
            <th className="px-2 py-2.5 text-right font-bold" title="Of the contacts that entered in this period, how many reached initial outreach — click to list them">Contacted / assigned</th>
            <th className="w-[34%] px-3 py-2.5 text-left font-bold">Progress</th>
          </tr></thead>
          <tbody>
            {rows.map(([email, r]) => {
              const total = r.assigned.length + r.contacted.length;
              const pct = total ? Math.round((100 * r.contacted.length) / total) : 0;
              const cell = (which: "assigned" | "contacted") => `${email}:${which}`;
              const toggle = (which: "assigned" | "contacted") =>
                setOpenCell(openCell === cell(which) ? null : cell(which));
              const openWhich = openCell?.startsWith(`${email}:`)
                ? (openCell.split(":")[1] as "assigned" | "contacted")
                : null;
              return (
                <Fragment key={email}>
                  <tr className={cn("border-t border-border-strong",
                    owner && owner.toLowerCase() === email && "bg-accent-soft/40")}>
                    <td className="px-3 py-1.5 font-medium text-ink">
                      {email === "(unowned)" ? (
                        <span className="text-ink-4">Unowned</span>
                      ) : onSelectOwner ? (
                        <button type="button" onClick={() => onSelectOwner(email)}
                          title={`Filter this page to ${nameOf(email)}`}
                          className={cn("text-left hover:text-accent hover:underline",
                            owner && owner.toLowerCase() === email ? "text-accent" : "text-ink")}>
                          {nameOf(email)}
                        </button>
                      ) : nameOf(email)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {total > 0 ? (
                        <button type="button" onClick={() => toggle("assigned")}
                          title={`List the ${total} contacts that entered this period`}
                          className={cn("hover:underline", openWhich === "assigned" ? "text-accent" : "text-ink-2 hover:text-accent")}>
                          {total}
                        </button>
                      ) : <span className="text-ink-2">{total}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {r.contacted.length > 0 ? (
                        <button type="button" onClick={() => toggle("contacted")}
                          title={`List the ${r.contacted.length} of ${total} reached in this period`}
                          className={cn("font-semibold hover:underline", openWhich === "contacted" ? "text-accent" : "text-green hover:text-accent")}>
                          {r.contacted.length}
                        </button>
                      ) : <span className="font-semibold text-ink-4">0</span>}
                      <span className="text-ink-4"> / {total}</span>
                      <span className="ml-1 text-[11px] text-ink-4">({pct}%)</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="h-1.5 overflow-hidden rounded-full border border-border-strong bg-surface-2" title={`${r.contacted.length} of ${total} contacted in this period`}>
                        <div className="h-full rounded-full bg-green transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                  </tr>
                  {openWhich ? (
                    <tr className="border-t border-border-strong bg-surface-2/40">
                      <td colSpan={4} className="px-3 py-2">
                        <ContactCellDrill
                          label={openWhich === "assigned"
                            ? `${nameOf(email)} · entered this period`
                            : `${nameOf(email)} · contacted this period`}
                          // "Assigned set" is the queue PLUS those already
                          // contacted, so its drill must list both — otherwise
                          // clicking 26 shows 23.
                          contacts={openWhich === "assigned" ? [...r.assigned, ...r.contacted] : r.contacted}
                          whenLabel={openWhich === "assigned" ? "Entered stage" : "Contacted"}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}

/** The four names worth one click, pinned under the scope buttons.
 *
 *  This lives in the period card rather than on any one panel because it is a
 *  page filter: it drives the same `owner` state the sender dropdown does, so
 *  the two can never disagree, and every section below moves together. It sat
 *  on the right of the Activity Pipeline title for a day, which made it look
 *  like it filtered that table alone (Kwame 2026-09-21).
 *
 *  "All jobs team" also resets the scope. A pinned name can be someone outside
 *  the core three, and clearing the owner while the scope is still `staff`
 *  would leave the page filtered to a group the button does not name. */
function SenderPins({ owner, onSelect, nameOf }: {
  owner?: string;
  onSelect: (email: string) => void;
  nameOf: (email: string) => string;
}) {
  const current = (owner ?? "").toLowerCase();
  const pins = [{ email: "", label: "All jobs team" },
                ...JOBS_TEAM_PINNED.map((e) => ({ email: e, label: nameOf(e) }))];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Sender</span>
      <div className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
        {pins.map((t) => {
          const active = current === t.email.toLowerCase();
          return (
            <button
              key={t.email || "all"}
              type="button"
              onClick={() => onSelect(t.email)}
              title={t.email || "Every member of the jobs team"}
              className={cn(
                "rounded px-2 py-0.5 text-[12px] font-medium transition-colors",
                active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {/* Named so the row reads as "these four, or anyone" rather than as two
          unrelated controls that happen to share a line. */}
      <span className="text-[11.5px] text-ink-4">or</span>
    </div>
  );
}

/** The Activity Pipeline table, lifted out of ThisWeekBlock on 2026-09-16 so it
 *  can live on the Outbound Detail sub-tab. Overview shows the summary card in
 *  the space it used to occupy. */
function ActivityPipelineBlock({ activityPipeline, granularity, scope, owner, range, nameOf, rangeLabel, lastRangeLabel, ownerLabel }: {
  activityPipeline?: ScorecardRow[];
  granularity: OutreachGranularity;
  scope: OutreachScopeKind;
  owner?: string;
  range?: OutreachDateRange;
  nameOf: (email: string) => string;
  rangeLabel?: string;
  lastRangeLabel?: string;
  /** Who the table is counting, echoed in the title bar. The control that sets
   *  it lives in the period card, so the table says whose numbers these are. */
  ownerLabel?: string;
}) {
  if (!activityPipeline || activityPipeline.length === 0) return null;
  return (
    <ScorecardTable title="Activity Pipeline" firstColHeader="Activity" rows={activityPipeline}
      idPrefix="act" drillKind="activity" granularity={granularity} scope={scope}
      owner={owner} range={range} nameOf={nameOf} rangeLabel={rangeLabel}
      lastRangeLabel={lastRangeLabel}
      action={ownerLabel
        ? <span className="text-[12px] font-medium text-ink-3">{ownerLabel}</span>
        : undefined} />
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
      title="Outreach activity"
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
  { key: "outreach_activity", label: "Outreach activity", tone: "ink", empty: "Nothing sent in this period." },
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
function useAwaitingActivation(staffEmails: Set<string>) {
  const { data: accounts = [] } = useJobsAccounts(undefined, "all");
  return useMemo(() => accounts
    .filter((a) => a.owner_email && staffEmails.has(a.owner_email.toLowerCase()) && a.prospect_count === 0)
    .sort((a, b) => (a.owner_email ?? "").localeCompare(b.owner_email ?? "") || a.account.localeCompare(b.account)),
    [accounts, staffEmails]);
}

function HygieneBlock({ nameOf, staffEmails }: { nameOf: (email: string) => string; staffEmails: Set<string> }) {
  const all = useAwaitingActivation(staffEmails);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState("onfile");
  const [ownerF, setOwnerF] = useState("");
  const owners = useMemo(() => ownerOptions(all, (a) => a.owner_email), [all]);
  // 60+ accounts is too many to scan raw — "which of mine have people I could
  // flag today" is the actual question, so that's the default sort.
  const noProspect = useMemo(() => {
    const rows = ownerF
      ? all.filter((a) => ((a.owner_email ?? "").toLowerCase() || "(unowned)") === ownerF)
      : [...all];
    if (sort === "name") return rows.sort((a, b) => a.account.localeCompare(b.account));
    if (sort === "recent") return rows.sort((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""));
    if (sort === "stalest") return rows.sort((a, b) => (a.last_activity_at ?? "").localeCompare(b.last_activity_at ?? ""));
    return rows.sort((a, b) => (b.contact_count ?? 0) - (a.contact_count ?? 0));
  }, [all, sort, ownerF]);

  // Two different problems: contacts exist but nobody's been flagged into the
  // pipeline (just activate one) vs genuinely nobody on file (go find someone).
  const withPeople = useMemo(() => noProspect.filter((a) => (a.contact_count ?? 0) > 0).length, [noProspect]);
  const shown = showAll ? noProspect : noProspect.slice(0, 10);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-ink-3">
          {noProspect.length} owned accounts with nobody in the prospect list — {withPeople} have contacts on file to flag,{" "}
          {noProspect.length - withPeople} have nobody yet
        </p>
        <ListControls sort={sort} setSort={setSort} owner={ownerF} setOwner={setOwnerF}
          owners={owners} nameOf={nameOf}
          sortOpts={[
            { value: "onfile", label: "Most contacts on file" },
            { value: "stalest", label: "Stalest activity" },
            { value: "recent", label: "Most recent activity" },
            { value: "name", label: "Account name" },
          ]} />
      </div>
      {noProspect.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
          <div className="bg-amber-soft px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber">
            Assigned, no contact identified · {noProspect.length}
          </div>
          <table className="w-full text-[12.5px]">
            <thead><tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
              <th className="px-3 py-1.5 font-semibold">Account</th>
              <th className="px-2 py-1.5 font-semibold">Owner</th>
              <th className="px-2 py-1.5 font-semibold">Status</th>
              <th className="px-2 py-1.5 text-right font-semibold" title="Contacts on file at this company, flagged or not">On file</th>
              <th className="px-2 py-1.5 text-right font-semibold">Last activity</th>
              <th className="px-2 py-1.5"></th>
            </tr></thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.account_key} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <span className="font-medium text-ink">{a.account}</span>
                    {a.prospect_sibling && (
                      <Link to={`/jobs/accounts?q=${encodeURIComponent(a.prospect_sibling.account)}`}
                        className="block truncate text-[10.5px] text-amber hover:underline"
                        title="Same company filed under another name — the prospects are over there">
                        ⤳ {a.prospect_sibling.prospects} prospects under “{a.prospect_sibling.account}” — likely the same company
                      </Link>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-ink-2">{a.owner_email ? nameOf(a.owner_email) : "—"}</td>
                  <td className="px-2 py-1.5 text-[11.5px] text-ink-3">{a.account_status}</td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums text-[11.5px]", (a.contact_count ?? 0) > 0 ? "text-ink-2" : "text-ink-4")}>
                    {a.contact_count ?? 0}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[11.5px] text-ink-4">{relDay(a.last_activity_at) ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Link to={`/jobs/contacts?q=${encodeURIComponent(a.account)}`}
                      className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-semibold hover:underline",
                        (a.contact_count ?? 0) > 0 ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-ink-3")}>
                      {(a.contact_count ?? 0) > 0 ? `Flag one of ${a.contact_count} →` : "Find contacts →"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {noProspect.length > shown.length && (
            <button type="button" onClick={() => setShowAll(true)}
              className="w-full border-t border-border-strong px-3 py-1.5 text-[12px] text-accent hover:bg-surface-2/50">
              Show all {noProspect.length}
            </button>
          )}
        </div>
      )}

    </div>
  );
}

/** Replied but still in initial outreach — the owner decides where each goes.
 *  Deliberately never auto-advances: a positive reply belongs in Converted, a
 *  neutral/negative one in On hold / Not a fit, and only a human can tell. */
function RespondedPanel({ owner, nameOf }: { owner?: string; nameOf: (e: string) => string }) {
  const { data: raw = [], isLoading } = useRespondedContacts(owner);
  const [sort, setSort] = useState("oldest");
  const [ownerF, setOwnerF] = useState("");
  const owners = useMemo(() => ownerOptions(raw, (r) => r.owner_email), [raw]);
  const data = useMemo(() => {
    const rows = ownerF
      ? raw.filter((r) => ((r.owner_email ?? "").toLowerCase() || "(unowned)") === ownerF)
      : [...raw];
    const key = (r: typeof rows[number]) => r.last_reply ?? "";
    if (sort === "recent") return rows.sort((a, b) => key(b).localeCompare(key(a)));
    if (sort === "touches") return rows.sort((a, b) => (b.touches ?? 0) - (a.touches ?? 0));
    return rows.sort((a, b) => key(a).localeCompare(key(b)));  // oldest reply first
  }, [raw, sort, ownerF]);
  const update = useUpdateJobsMembership();
  const stageChange = useContactStageChange();
  const [showAll, setShowAll] = useState(false);
  const move = (c: { contact_id: number; full_name: string | null }, stage: MembershipStage) => {
    // Revisit goes through the shared handler so it asks for a date and files
    // the follow-up task; the other decisions are one-click.
    if (stage === "revisit") {
      // change() now rejects when the dialog is cancelled, and this path
      // has no InlineSelect to roll back — swallow it rather than emit an
      // unhandled rejection every time someone changes their mind.
      stageChange.change(c.contact_id, c.full_name ?? "Contact", stage).catch(() => {});
      return;
    }
    update.mutate({ contact_id: c.contact_id, stage }, {
      onSuccess: () => toast.success(`${c.full_name ?? "Contact"} → ${MEMBERSHIP_STAGE_LABELS[stage]}`),
    });
  };
  const shown = showAll ? data : data.slice(0, 8);
  return (
    <Panel
      action={
        <ListControls sort={sort} setSort={setSort} owner={ownerF} setOwner={setOwnerF}
          owners={owners} nameOf={nameOf}
          sortOpts={[
            { value: "oldest", label: "Longest un-actioned" },
            { value: "recent", label: "Most recent reply" },
            { value: "touches", label: "Most touches" },
          ]} />
      }
      title="Replied — needs a decision"
      badge={data.length ? String(data.length) : undefined}
      desc="They came back to us and are still in initial outreach. Read the reply, then move them — nothing advances on its own.">
      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>
      ) : data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
          No replies waiting on a decision.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border-strong">
          {shown.map((c) => (
            <div key={c.contact_id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <Link to={`/jobs/contacts/${c.contact_id}`} className="text-[13px] font-semibold text-ink hover:text-accent">
                    {c.full_name || "—"}
                  </Link>
                  <span className="text-[11.5px] text-ink-3">{c.current_company || "—"}</span>
                  <span className="text-[11px] text-ink-4">
                    replied {relDay(c.last_reply) ?? "—"} ago · {c.touches} touch{c.touches === 1 ? "" : "es"}
                  </span>
                </div>
                {c.snippet && <p className="mt-0.5 line-clamp-2 text-[11.5px] italic text-ink-3">“{c.snippet}”</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => move(c, "converted_to_opportunity")}
                  className="rounded-full border border-[var(--green)]/40 bg-[var(--green-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--green)] hover:brightness-95">
                  Converted
                </button>
                <button type="button" onClick={() => move(c, "revisit")}
                  title="Park with a date — files a task for the owner"
                  className="rounded-full border border-[var(--amber)]/40 bg-[var(--amber-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--amber)] hover:brightness-95">
                  Revisit
                </button>
                <button type="button" onClick={() => move(c, "not_a_fit")}
                  className="rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-3 hover:text-ink-2">
                  Not a fit
                </button>
              </div>
            </div>
          ))}
          {data.length > shown.length && (
            <button type="button" onClick={() => setShowAll(true)}
              className="py-2 text-left text-[12px] text-accent hover:underline">Show all {data.length}</button>
          )}
        </div>
      )}
      {stageChange.dialog}
    </Panel>
  );
}

/** Contacts stuck in initial outreach — 3+ touches, no reply. The cue to find a
 *  different contact at that account (replaced the account working list). */
function StuckContactsPanel({ owner, nameOf }: { owner?: string; nameOf: (e: string) => string }) {
  const { data: raw = [], isLoading } = useStuckContacts(3, owner);
  const [sort, setSort] = useState("touches");
  const [ownerF, setOwnerF] = useState("");
  // One shared handler: it builds the options from what the database accepts
  // (greying out anything the migration hasn't enabled) and routes Revisit
  // through its date dialog.
  const stageChange = useContactStageChange();
  const owners = useMemo(() => ownerOptions(raw, (r) => r.owner_email), [raw]);
  const data = useMemo(() => {
    const rows = ownerF
      ? raw.filter((r) => ((r.owner_email ?? "").toLowerCase() || "(unowned)") === ownerF)
      : [...raw];
    if (sort === "stalest") return rows.sort((a, b) => (a.last_touch ?? "").localeCompare(b.last_touch ?? ""));
    if (sort === "recent") return rows.sort((a, b) => (b.last_touch ?? "").localeCompare(a.last_touch ?? ""));
    return rows.sort((a, b) => (b.touches ?? 0) - (a.touches ?? 0));
  }, [raw, sort, ownerF]);
  // Stage editable in place: the usual next move here is On hold / Not a fit,
  // or Converted if the account came good through another contact.
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="flex items-center gap-2 px-1 py-4 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>;
  if (data.length === 0) {
    return <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
      Nobody stuck — every contact in initial outreach has replied or is under 3 touches.
    </div>;
  }
  const shown = showAll ? data : data.slice(0, 15);
  return (
    <div className="flex flex-col gap-2">
      <ListControls sort={sort} setSort={setSort} owner={ownerF} setOwner={setOwnerF}
        owners={owners} nameOf={nameOf}
        sortOpts={[
          { value: "touches", label: "Most touches" },
          { value: "stalest", label: "Stalest (oldest touch)" },
          { value: "recent", label: "Most recent touch" },
        ]} />
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      <table className="w-full text-[12.5px]">
        <thead><tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
          <th className="px-3 py-1.5 font-semibold">Contact</th>
          <th className="px-2 py-1.5 font-semibold">Company</th>
          <th className="px-2 py-1.5 text-right font-semibold">Touches</th>
          <th className="px-2 py-1.5 text-right font-semibold">Last touch</th>
          <th className="px-2 py-1.5 font-semibold">Stage</th>
          <th className="px-2 py-1.5 text-right font-semibold" title="Other jobs prospects already identified at this company">Others at account</th>
        </tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.contact_id} className="border-t border-border-strong">
              <td className="px-3 py-1.5">
                <Link to={`/jobs/contacts/${c.contact_id}`} className="font-medium text-ink hover:text-accent">{c.full_name || "—"}</Link>
                {c.current_title && <span className="block truncate text-[11px] text-ink-4">{c.current_title}</span>}
              </td>
              <td className="px-2 py-1.5 text-ink-2">{c.current_company || "—"}</td>
              <td className={cn("px-2 py-1.5 text-right tabular-nums font-semibold", c.touches >= 5 ? "text-red" : "text-amber")}>{c.touches}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[11.5px] text-ink-4">{relDay(c.last_touch) ?? "—"}</td>
              <td className="px-2 py-1.5">
                <InlineSelect<string>
                  value="initial_outreach"
                  options={stageChange.options}
                  onSave={(v) => {
                    if (!v || v === "initial_outreach") return Promise.resolve();
                    return stageChange.change(c.contact_id, c.full_name ?? "this contact", v);
                  }}
                  renderValue={() => (
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3">Initial outreach</span>
                  )}
                />
              </td>
              <td className="px-2 py-1.5 text-right">
                {c.other_contacts_at_account > 0 ? (
                  <Link to={`/jobs/contacts?q=${encodeURIComponent(c.current_company ?? "")}`}
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent-ink hover:underline">
                    {c.other_contacts_at_account} other{c.other_contacts_at_account === 1 ? "" : "s"} →
                  </Link>
                ) : (
                  <Link to={`/jobs/accounts?q=${encodeURIComponent(c.current_company ?? "")}`}
                    className="text-[10.5px] font-semibold text-amber hover:underline">find a contact →</Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > shown.length && (
        <button type="button" onClick={() => setShowAll(true)}
          className="w-full border-t border-border-strong px-3 py-1.5 text-[12px] text-accent hover:bg-surface-2/50">
          Show all {data.length}
        </button>
      )}
    </div>
    {stageChange.dialog}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
// ── Requiring attention ─────────────────────────────────────────────────────
// One place for the three queues that need a human: replies awaiting a
// decision, contacts stuck in outreach, accounts with nobody flagged. Each card
// is the headline; clicking it opens the same detail table that used to sit in
// its own full-width section.

type AttentionKey = "replied" | "stuck" | "activation";

/** Sort + owner filter strip shared by the three Requiring Attention details —
 *  each list is long enough that scanning it unsorted is the actual work. */
function ListControls({ sort, setSort, sortOpts, owner, setOwner, owners, nameOf }: {
  sort: string;
  setSort: (v: string) => void;
  sortOpts: { value: string; label: string }[];
  owner: string;
  setOwner: (v: string) => void;
  owners: string[];
  nameOf: (email: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Sort</span>
      <select value={sort} onChange={(e) => setSort(e.target.value)}
        className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
        {sortOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="ml-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Owner</span>
      <select value={owner} onChange={(e) => setOwner(e.target.value)}
        className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
        <option value="">All owners</option>
        {owners.map((o) => <option key={o} value={o}>{o === "(unowned)" ? "Unowned" : nameOf(o)}</option>)}
      </select>
    </div>
  );
}

/** Distinct owner keys present in a list, for its filter dropdown. */
function ownerOptions<T>(rows: T[], pick: (r: T) => string | null | undefined): string[] {
  const set = new Set<string>();
  for (const r of rows) set.add((pick(r) ?? "").toLowerCase() || "(unowned)");
  return [...set].sort();
}

const DAY_MS = 86_400_000;

function AttentionCard({ label, value, sub, tone, active, onClick }: {
  label: string;
  value: number | undefined;
  sub: React.ReactNode;
  tone: "ink" | "red" | "amber" | "accent";
  active: boolean;
  onClick: () => void;
}) {
  const toneCls = {
    ink: "text-ink",
    red: "text-red",
    amber: "text-amber",
    accent: "text-accent",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={cn(
        "flex flex-col items-start gap-1 rounded-xl border bg-surface px-4 py-3 text-left transition-colors",
        active
          ? "border-accent ring-1 ring-accent/30"
          : "border-border-strong hover:bg-surface-2/50",
      )}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className={cn("text-[26px] font-semibold leading-none tabular-nums", toneCls)}>
        {value ?? "—"}
      </span>
      <span className="text-[11px] leading-snug text-ink-3">{sub}</span>
      <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10.5px] font-semibold text-accent">
        {active ? "Hide detail" : "See detail"}
        {active ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </span>
    </button>
  );
}

function RequiringAttention({ owner, nameOf, staffEmails }: {
  owner?: string;
  nameOf: (email: string) => string;
  staffEmails: Set<string>;
}) {
  const [open, setOpen] = useState<AttentionKey | null>(null);
  const { data: replied = [] } = useRespondedContacts(owner);
  const { data: stuck = [] } = useStuckContacts(3, owner);
  const awaiting = useAwaitingActivation(staffEmails);

  // Trend on replies: last 7 days vs the 7 before, off each row's last_reply.
  // There's no prior-period endpoint, so this is derived from the same payload
  // rather than being a second fetch that could disagree with the count.
  const replyTrend = useMemo(() => {
    const now = Date.now();
    let recent = 0;
    let prior = 0;
    for (const r of replied) {
      if (!r.last_reply) continue;
      const age = now - new Date(r.last_reply).getTime();
      if (age < 7 * DAY_MS) recent += 1;
      else if (age < 14 * DAY_MS) prior += 1;
    }
    return { recent, prior };
  }, [replied]);

  const stuckStats = useMemo(() => {
    if (stuck.length === 0) return null;
    const touches = stuck.reduce((n, s) => n + (s.touches ?? 0), 0) / stuck.length;
    const withTouch = stuck.filter((s) => s.last_touch);
    const days = withTouch.length
      ? withTouch.reduce((n, s) => n + (Date.now() - new Date(s.last_touch as string).getTime()), 0)
        / withTouch.length / DAY_MS
      : null;
    return { touches, days };
  }, [stuck]);

  const withPeople = awaiting.filter((a) => (a.contact_count ?? 0) > 0).length;

  return (
    <div className="flex flex-col gap-3">
      <SectionHead title="Requiring attention" />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <AttentionCard
          label="Replies needing a decision"
          value={replied.length}
          // Black, not red: a reply is a good outcome waiting on a decision, not
          // a failure. The 7-day trend below still colours when it's climbing.
          tone="ink"
          active={open === "replied"}
          onClick={() => setOpen(open === "replied" ? null : "replied")}
          sub={
            <>
              {replyTrend.recent} in the last 7d
              {replyTrend.prior > 0 ? (
                <>
                  {" · "}
                  <span className={replyTrend.recent >= replyTrend.prior ? "text-red" : "text-[var(--green)]"}>
                    {replyTrend.recent >= replyTrend.prior ? "▲" : "▼"}{" "}
                    {Math.abs(replyTrend.recent - replyTrend.prior)}
                  </span>{" "}
                  vs prior 7d
                </>
              ) : null}
            </>
          }
        />
        <AttentionCard
          label="Stuck in initial outreach"
          value={stuck.length}
          tone="amber"
          active={open === "stuck"}
          onClick={() => setOpen(open === "stuck" ? null : "stuck")}
          sub={
            stuckStats
              ? `avg ${stuckStats.touches.toFixed(1)} touches${
                  stuckStats.days != null ? ` · last touch ${Math.round(stuckStats.days)}d ago` : ""
                }`
              : "nobody stuck — 3+ touches, no reply"
          }
        />
        <AttentionCard
          label="Accounts awaiting activation"
          value={awaiting.length}
          tone="accent"
          active={open === "activation"}
          onClick={() => setOpen(open === "activation" ? null : "activation")}
          sub={`${withPeople} have contacts on file to flag`}
        />
      </div>

      {open === "replied" ? <RespondedPanel owner={owner} nameOf={nameOf} /> : null}
      {open === "stuck" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11.5px] text-ink-3">
            3+ touches, no reply — time to work a different contact at the account
          </p>
          <StuckContactsPanel owner={owner} nameOf={nameOf} />
        </div>
      ) : null}
      {open === "activation" ? <HygieneBlock nameOf={nameOf} staffEmails={staffEmails} /> : null}
    </div>
  );
}

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
  const rangeLabel = useMemo(() => (sc ? fmtRange(sc.period.this_start, sc.period.this_end) : ""), [sc]);
  const lastRangeLabel = useMemo(() => (sc ? fmtRange(sc.period.last_start, sc.period.last_end) : ""), [sc]);


  const staffEmails = useMemo(() => new Set(staff.map((s) => s.email.toLowerCase())), [staff]);

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

  // Two views over one period bar. Overview is the Monday review; Outbound
  // Detail is the activity table that used to sit mid-scroll on it. The period,
  // scope and sender controls govern both, so they stay above the sub-tabs.
  const [sub, setSub] = useState<OutreachSub>("overview");
  const onDetail = sub === "detail";

  return (
    <div className="flex flex-col gap-6 pt-3">
      {/* Above the period bar on purpose: you pick the view first, then the
          window you want to see it over. Same chrome as Overview → Campaigns. */}
      <div className="-mt-1 flex items-center gap-1 border-b border-border-strong">
        {OUTREACH_SUBS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              title={t.title}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
                sub === t.key ? "border-accent text-accent" : "border-transparent text-ink-3 hover:text-ink-2",
              )}
            >
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>
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
          secondary={
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <SenderPins owner={owner} nameOf={nameOf} onSelect={(email) => {
                if (!email) { setScope("team"); setOwner(""); return; }
                setOwner(email);
              }} />
              {/* Anyone at all, with the four pinned names repeated at the top
                  so the dropdown agrees with the buttons beside it. A flat
                  forty-name list made reaching the people you actually filter by
                  a scroll (Kwame 2026-09-21). */}
              <select value={owner} onChange={(e) => setOwner(e.target.value)}
                className="h-7 max-w-[200px] rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent"
                title="Filter every section to one person">
                <option value="">All senders</option>
                {pinnedStaff.length > 0 && (
                  <optgroup label="Jobs Team">
                    {pinnedStaff.map((st) => (
                      <option key={st.email} value={st.email}>{st.name || st.email}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Everyone else">
                  {otherStaff.map((st) => (
                    <option key={st.email} value={st.email}>{st.name || st.email}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          }
        >
          <ScopeButtons value={scope} onChange={(v) => { setScope(v); setOwner(""); }} />
        </PeriodBar>



      {/* The window these numbers cover, right-aligned just above the first
          chart that uses it. At the top of the zone it read as a heading for
          the whole page; here it reads as the footing for the charts below,
          which is what it actually is. */}
      {sc && (
        <div className="-mb-3 flex justify-end">
          <span className="text-[11.5px] text-ink-3">
            {rangeLabel}
            {" · trends compare with "}
            {fmtRange(sc.period.last_start, sc.period.last_end)}
          </span>
        </div>
      )}

      {/* ── The two tabs swapped contents on 2026-09-21 (Kwame) ───────────
             Overview is now the weekly review itself: the headline numbers, the
             pipeline table, who did what, and the trend. Outbound Detail holds
             the supporting cuts — how the book is segmented, and the live
             queues that ignore the period bar entirely.
             The old split had the review's own numbers a tab away from the
             review. ── */}
      {!onDetail ? (
        <>
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
            lastRangeLabel={lastRangeLabel || undefined} ownerLabel={senderLabel} />
          {/* Outreach Detail sits directly under the table it breaks down. */}
          <ThisWeekBlock nameOf={nameOf}
            scope={scope} owner={owner || undefined} range={range}
            onSelectOwner={(email) => {
              // The table keys owners lowercased; resolve back to the canonical
              // staff email so exact-match server filters still hit (one staff
              // record is "joanna@Pursuit.org").
              const canonical = staff.find((st) => st.email.toLowerCase() === email)?.email ?? email;
              setOwner(owner.toLowerCase() === email ? "" : canonical);
            }} />
          <ActivityTrends scope={scope} owner={owner || undefined} range={range} />
          <JobsFunnels only="prospects" period={range} periodLabel={rangeLabel || undefined} />
          <OutboundActivityFeed granularity={granularity} scope={scope}
            owner={owner || undefined} range={range} />
        </>
      ) : (
      <>
      {/* ── One band ──────────────────────────────────────────────────────
             Targeting Mix is the "who are we choosing to work" cut, which is
             detail on the review rather than part of it. ── */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border-strong" />
        <span className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">Segments</span>
        <div className="h-px flex-1 bg-border-strong" />
      </div>
      <TargetingPanel granularity={granularity} scope={scope} owner={owner || undefined} range={range} />
      </>
      )}
      </section>

      {/* ── ZONE 2 · current state ────────────────────────────────────────
             Everything below this line ignores the period bar, and that is
             correct: these are live queues and rollups, not history. Making the
             boundary explicit was the fix for the period control appearing to
             govern the whole page when it governs only the half above it.
             The divider is deliberately heavier than the "Segments" rule
             above, which heads a period-scoped panel — this one
             separates two different notions of time. ── */}
      {onDetail && (
        <>
      <ZoneBoundary />

      <TouchDepthPanel scope={scope} owner={owner || undefined} nameOf={nameOf} />

      {/* Requiring attention closes the page (moved below the trend band
          2026-08-04): it's the action list you leave the review with, so it
          reads better as the last thing than wedged mid-scroll. */}
      {/* "Campaigns · coverage" lived here until 2026-09-15. Campaigns is now
          its own view under Dashboard → Overview → Campaigns, with a picker,
          period bar and activity feed this strip never had. One home. */}
      <RequiringAttention owner={owner || undefined} nameOf={nameOf} staffEmails={staffEmails} />
        </>
      )}
    </div>
  );
}

/** The line between "the period you picked" and "right now".
 *
 *  Reads as a statement rather than a label because the whole point is to
 *  correct an expectation the period bar sets. Note the precision: scope and
 *  sender DO still apply below this line — only the period stops. Saying "the
 *  filters above don't apply" would trade one wrong belief for another. */
/** The divider between the period-scoped zone above and the live zone below.
 *  The rule and label carry the boundary on their own — the explanatory caption
 *  that used to sit under it was permanent chrome for a one-time explanation. */
function ZoneBoundary() {
  return (
    <div className="mt-8 flex items-center gap-3">
      <div className="h-px flex-1 bg-ink-4/40" />
      <span className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-2">Current state</span>
      <div className="h-px flex-1 bg-ink-4/40" />
    </div>
  );
}
