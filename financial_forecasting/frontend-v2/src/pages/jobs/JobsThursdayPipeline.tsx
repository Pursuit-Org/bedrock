/**
 * Jobs · Thursday Pipeline (PRO-110): what's stuck, why, and what leadership
 * can unblock (Dave). For the Thursday pipeline meeting, covering the current
 * calendar week (D8).
 *
 * Top to bottom, as in the approved mockup: active / stalled / slow but active
 * tiles, the priority opportunities to discuss, this week, the stalled and
 * slow-but-active lists, stalled accounts, conversion between milestones (D11),
 * why opportunities were lost, then every open opportunity by account (D9).
 * Full-time by default (Avni, Kwame).
 *
 * Read-only: no inline stage editing in the meeting. Every row links to the
 * opportunity, where the owner changes its stage or marks it slow but active.
 * Every number and list comes from GET /api/jobs/opportunities/thursday, one
 * set, so a tile and its list can't disagree.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  useStaffNameResolver,
  useThursdayPipeline,
  type JobStage,
  type MetricDefinition,
  type OppState,
  type ThursdayDealType,
  type ThursdayEvent,
  type ThursdayLostReason,
  type ThursdayOpportunity,
  type ThursdayPipeline,
  type ThursdayPriority,
  type ThursdayWeekKey,
} from "@/services/jobs";
import { Drawer } from "@/components/ui/Drawer";
import { Panel } from "@/components/jobs/Panel";
import { PeriodBar, defaultPeriod } from "@/components/jobs/PeriodBar";
import { MetricInfo } from "@/components/jobs/MetricInfo";
import { ListWhy } from "@/components/jobs/ListWhy";
import { MilestoneStrip } from "@/components/jobs/JobsFunnels";
import { DealStagePill } from "@/components/jobs/jobsEntity";
import { jobsAccountPath, jobsOpportunityPath } from "@/components/jobs/jobsPaths";
import {
  DEAL_TYPE_CHOICES, STATE_LABEL, byAccount, byOwner, idleText, lastActivityLine, noReasonLine,
  nyDay, opportunities, priorityLabel, slowLine,
} from "@/components/jobs/pipelineText";
import { untitledOppHeading } from "@/components/jobs/oppLabels";
import { useSessionState } from "@/lib/useSessionState";
import { cn } from "@/lib/utils";

const PRIORITY_PER_OWNER = 3;

type NameOf = (email: string | null) => string;

type Drill =
  | { kind: "opps"; title: string; note?: string; rows: ThursdayOpportunity[] }
  | { kind: "events"; title: string; note?: string; rows: ThursdayEvent[] };

export function JobsThursdayPipeline() {
  const [dealType, setDealType] = useSessionState<ThursdayDealType>("jobsThursday.dealType", "ft");
  // This week so far: the Thursday meeting covers the current week (D8).
  const [range, setRange] = useState<[string, string]>(() => defaultPeriod("thursday"));
  const { data, isLoading } = useThursdayPipeline(dealType, range[0], range[1]);
  const resolve = useStaffNameResolver();
  const nameOf: NameOf = (e) => (e ? resolve(e) : "—");
  const [drill, setDrill] = useState<Drill | null>(null);

  const typeLabel = DEAL_TYPE_CHOICES.find((c) => c.key === dealType)?.label.toLowerCase() ?? "";
  const s = data?.summary;
  const defs = data?.definitions;

  const openState = (state: OppState) => data && setDrill({
    kind: "opps", title: `${STATE_LABEL[state]} · ${typeLabel}`,
    // In the panels' order: stalled longest idle first, slow by check-again date.
    rows: state === "stalled" ? data.stalled : state === "slow" ? data.slow
      : data.opportunities.filter((o) => o.state === state),
  });

  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-semibold text-ink">What's stuck, and what can leadership unblock?</span>
        <span className="text-[12px] text-ink-3">
          For the Thursday pipeline meeting, covering the current calendar week. Read-only: open an
          opportunity to change its stage.
        </span>
      </div>

      <PeriodBar from={range[0]} to={range[1]} onChange={(f, t) => setRange([f, t])} showWeekSoFar clampToToday>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Opportunity type</span>
          <div className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
            {DEAL_TYPE_CHOICES.map((c) => (
              <button key={c.key} type="button" title={c.title} aria-pressed={dealType === c.key}
                onClick={() => setDealType(c.key)}
                className={cn("rounded px-2 py-0.5 text-[12px] font-medium transition-colors",
                  dealType === c.key ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2")}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </PeriodBar>

      {/* The rules, on the page (D3). */}
      <div className="flex flex-wrap gap-2 text-[11.5px]">
        <RuleChip strong>Stalled opportunity = no jobs-related activity and no stage move in 4+ weeks (28 days)</RuleChip>
        <RuleChip strong>Stalled account = no contact touched and no opportunity moved in 6+ weeks</RuleChip>
        <RuleChip>Activity = email, call, meeting, LinkedIn, text. Comments don't count</RuleChip>
        <RuleChip>"Slow but active" is set by the owner, with a reason and a date to check again</RuleChip>
      </div>

      {/* ── Active / stalled / slow ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(["active", "stalled", "slow"] as const).map((st) => (
          <StateTile key={st} state={st} value={s?.[st]} of={s?.open} isLoading={isLoading}
            definition={defs?.[st]} onOpen={() => openState(st)} />
        ))}
      </div>

      {/* ── Priority opportunities to discuss ───────────────────────────── */}
      <Panel title="Priority opportunities to discuss" info={<ListWhy listKey="thursday_priority" />}
        desc="Uses the Priority the team already sets on the ones to talk through. Where it stands is the latest comment.">
        <PriorityList rows={data?.priority ?? []} nameOf={nameOf} isLoading={isLoading} />
      </Panel>

      {/* ── This week ───────────────────────────────────────────────────── */}
      <Panel title="This week" info={<ListWhy listKey="thursday_week" />}
        desc={data ? `${nyLongDay(data.window.start)} – ${nyLongDay(data.window.end)}` : undefined}>
        <WeekCounts data={data} isLoading={isLoading} onOpen={setDrill} />
      </Panel>

      {/* ── Stalled, and slow but active ────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Stalled" className="h-full"
          info={<><MetricInfo definition={defs?.stalled} onViewRecords={() => openState("stalled")} />
            <ListWhy listKey="thursday_stalled" /></>}
          desc={data ? `${opportunities(data.stalled.length)}, longest idle first` : undefined}>
          <OppRows rows={data?.stalled ?? []} nameOf={nameOf} isLoading={isLoading}
            empty="Nothing stalled." />
        </Panel>
        <Panel title="Slow but active" className="h-full"
          info={<><MetricInfo definition={defs?.slow} onViewRecords={() => openState("slow")} />
            <ListWhy listKey="thursday_slow" /></>}
          desc="Set by the owner on the opportunity, with a reason and a date to check again">
          {data && !data.slow_enabled ? (
            <p className="text-[12px] text-ink-3">
              Nothing can be marked yet: this waits for the slow-but-active migration
              (2026-10-20-opportunity-slow-but-active.sql).
            </p>
          ) : (
            <OppRows rows={data?.slow ?? []} nameOf={nameOf} isLoading={isLoading}
              empty={`None marked for ${typeLabel}.`} />
          )}
        </Panel>
      </div>

      {/* ── Stalled accounts ────────────────────────────────────────────── */}
      <Panel title="Stalled accounts"
        info={<><MetricInfo definition={defs?.stalled_accounts} /><ListWhy listKey="thursday_stalled_accounts" /></>}
        desc={data ? `${data.stalled_accounts.length} of ${data.summary.accounts} accounts with an open ${typeLabel === "all" ? "" : `${typeLabel} `}opportunity. A person should confirm before calling a whole account stalled.` : undefined}>
        <StalledAccounts data={data} nameOf={nameOf} isLoading={isLoading} />
      </Panel>

      {/* ── Conversion, and why opportunities were lost ─────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Conversion between milestones" className="h-full"
          desc={data ? `Opportunities that started in the last ${data.lookback.days} days, against the ${data.lookback.days} days before (D11)` : undefined}>
          {data?.milestones?.length ? (
            <div className="-mx-5 -mb-4">
              <MilestoneStrip milestones={data.milestones} isPeriod noun="opportunities" />
            </div>
          ) : <Empty isLoading={isLoading}>No conversion to show.</Empty>}
        </Panel>
        <Panel title="Why opportunities were lost" className="h-full"
          info={<MetricInfo definition={defs?.lost_reasons} />}
          desc={data ? `${opportunities(data.lost_reasons.reduce((n, g) => n + g.count, 0))} closed lost in the last ${data.lookback.days} days` : undefined}>
          <LostReasons groups={data?.lost_reasons ?? []} isLoading={isLoading}
            onOpen={(g) => setDrill({ kind: "events", title: `Closed Lost · ${g.label}`, rows: g.rows })} />
        </Panel>
      </div>

      {/* ── All open opportunities, by account (D9) ─────────────────────── */}
      <Panel title="All open opportunities" info={<ListWhy listKey="thursday_open" />}
        desc="By account. Owner and relationship owner as recorded; credit for shared work is deferred (D13).">
        <OpenTable data={data} nameOf={nameOf} isLoading={isLoading} />
      </Panel>

      {drill ? <DrillDrawer drill={drill} nameOf={nameOf} onClose={() => setDrill(null)} /> : null}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** "Oct 19" for a YYYY-MM-DD date. */
function nyLongDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function RuleChip({ strong, children }: { strong?: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("rounded-full border px-2.5 py-0.5",
      strong ? "border-accent/40 bg-accent-soft text-accent" : "border-border-strong bg-surface text-ink-3")}>
      {children}
    </span>
  );
}

const STATE_TONE: Record<OppState, { text: string; pill: string }> = {
  active: { text: "text-[var(--green)]", pill: "bg-[var(--green-soft)] text-[var(--green)]" },
  stalled: { text: "text-[var(--red)]", pill: "bg-[var(--red-soft)] text-[var(--red)]" },
  slow: { text: "text-[var(--amber)]", pill: "bg-[var(--amber-soft)] text-[var(--amber)]" },
};

const STATE_SUB: Record<OppState, string> = {
  active: "Moved in the last 4 weeks",
  stalled: "No movement in 4+ weeks",
  slow: "Owner-set, with a reason",
};

function StatePill({ state }: { state: OppState }) {
  return (
    <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold", STATE_TONE[state].pill)}>
      {STATE_LABEL[state]}
    </span>
  );
}

function StateTile({ state, value, of, isLoading, definition, onOpen }: {
  state: OppState; value: number | undefined; of: number | undefined; isLoading: boolean;
  definition: MetricDefinition | undefined; onOpen: () => void;
}) {
  return (
    <div className="flex items-start gap-1 rounded-2xl border border-border-strong bg-surface px-5 py-4">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{STATE_LABEL[state]} ›</div>
        {isLoading ? <div className="mt-2 h-8 w-16 animate-pulse rounded bg-surface-2" /> : (
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className={cn("text-[30px] font-bold leading-none tabular-nums", STATE_TONE[state].text)}>{value ?? 0}</span>
            <span className="text-[12px] text-ink-3">of {of ?? 0} open</span>
          </div>
        )}
        <div className="mt-1.5 text-[11.5px] text-ink-4">{STATE_SUB[state]}</div>
      </button>
      <MetricInfo definition={definition} onViewRecords={onOpen} />
    </div>
  );
}

function Empty({ isLoading, children }: { isLoading?: boolean; children: React.ReactNode }) {
  if (isLoading) return <div className="h-16 animate-pulse rounded-lg bg-surface-2" />;
  return (
    <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
      {children}
    </div>
  );
}

function OppName({ o }: { o: ThursdayOpportunity }) {
  return (
    <Link to={jobsOpportunityPath(o.opportunity_id)} className="font-medium text-ink hover:text-accent hover:underline">
      {o.account || "No account"}{o.title ? <span className="font-normal text-ink-3"> · {o.title}</span> : null}
    </Link>
  );
}

function OwnerLine({ o, nameOf }: { o: ThursdayOpportunity; nameOf: NameOf }) {
  return (
    <div className="text-[11.5px] text-ink-3">
      {nameOf(o.owner)}
      {o.relationship_owner ? <span className="text-ink-4"> · with {nameOf(o.relationship_owner)}</span> : null}
    </div>
  );
}

function PriorityList({ rows, nameOf, isLoading }: { rows: ThursdayPriority[]; nameOf: NameOf; isLoading: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = useMemo(() => byOwner(rows, nameOf), [rows, nameOf]);
  if (!rows.length) return <Empty isLoading={isLoading}>No open opportunity of this type has a priority.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => {
        const key = (g.owner ?? "").toLowerCase();
        const all = expanded.has(key);
        const shown = all ? g.rows : g.rows.slice(0, PRIORITY_PER_OWNER);
        return (
          <div key={key}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              {nameOf(g.owner)} · {g.rows.length}
            </div>
            <div className="divide-y divide-border-strong rounded-lg border border-border-strong">
              {shown.map((o) => (
                <div key={o.opportunity_id} className="grid gap-x-4 gap-y-1 px-3 py-2.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <OppName o={o} />
                      <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                        o.priority === 5 ? "bg-[var(--red-soft)] text-[var(--red)]"
                          : o.priority === 4 ? "bg-[var(--amber-soft)] text-[var(--amber)]" : "bg-surface-2 text-ink-3")}>
                        {priorityLabel(o.priority!)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
                      <DealStagePill stage={o.stage as JobStage} />
                      <span>{o.days_in_stage}d {o.stage_from_created ? "since created" : "in stage"}</span>
                      <StatePill state={o.state} />
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-4">
                      {o.relationship_owner ? `Relationship: ${nameOf(o.relationship_owner)}` : "No relationship owner"}
                    </div>
                  </div>
                  <div className="min-w-0 text-[12px]">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Where it stands</div>
                    {o.latest_note ? (
                      <>
                        <p className="line-clamp-3 whitespace-pre-line text-ink-2">{o.latest_note.text}</p>
                        <div className="text-[11px] text-ink-4">
                          {nameOf(o.latest_note.by)}{o.latest_note.at ? `, ${nyDay(o.latest_note.at)}` : ""}
                        </div>
                      </>
                    ) : <span className="text-ink-4">No comment yet</span>}
                  </div>
                  <div className="min-w-0 text-[12px]">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Last activity</div>
                    <div className="text-ink-2">{lastActivityLine(o.last_activity, nameOf)}</div>
                    <div className="text-[11px] text-ink-4">{idleText(o.idle_days)}</div>
                  </div>
                </div>
              ))}
            </div>
            {g.rows.length > PRIORITY_PER_OWNER ? (
              <button type="button" className="mt-1 text-[11.5px] font-medium text-accent hover:underline"
                onClick={() => setExpanded((p) => {
                  const n = new Set(p);
                  if (n.has(key)) n.delete(key); else n.add(key);
                  return n;
                })}>
                {all ? "Show fewer" : `Show all ${g.rows.length}`}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const WEEK_TILES: { key: ThursdayWeekKey; label: string }[] = [
  { key: "new", label: "New opportunities" },
  { key: "moves", label: "Stage moves" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  { key: "asks", label: "Asks sent" },
];

function WeekCounts({ data, isLoading, onOpen }: {
  data: ThursdayPipeline | undefined; isLoading: boolean; onOpen: (d: Drill) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {WEEK_TILES.map((t) => {
        const rows = data?.week[t.key] ?? [];
        const open = () => onOpen({ kind: "events", title: `${t.label} this week`, rows });
        return (
          <div key={t.key} className="flex items-start gap-1 rounded-lg border border-border-strong px-3 py-2.5">
            <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
              <div className="text-[11px] font-semibold text-ink-3">{t.label} ›</div>
              {isLoading ? <div className="mt-1 h-6 w-8 animate-pulse rounded bg-surface-2" /> : (
                <div className={cn("mt-0.5 text-[22px] font-bold tabular-nums",
                  t.key === "won" && rows.length ? "text-[var(--green)]" : "text-ink")}>{rows.length}</div>
              )}
            </button>
            <MetricInfo definition={data?.definitions[t.key]} onViewRecords={open} />
          </div>
        );
      })}
    </div>
  );
}

function OppRows({ rows, nameOf, isLoading, empty }: {
  rows: ThursdayOpportunity[]; nameOf: NameOf; isLoading: boolean; empty: string;
}) {
  if (!rows.length) return <Empty isLoading={isLoading}>{empty}</Empty>;
  return (
    <div className="divide-y divide-border-strong rounded-lg border border-border-strong">
      {rows.map((o) => (
        <div key={o.opportunity_id} className="flex items-start justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <OppName o={o} />
            <OwnerLine o={o} nameOf={nameOf} />
            <div className="mt-0.5 text-[11.5px] text-ink-3">
              {o.stage_label} · last: {lastActivityLine(o.last_activity, nameOf)}
            </div>
            {o.slow ? (
              <div className={cn("mt-0.5 text-[11.5px]", o.slow.lapsed ? "text-[var(--red)]" : "text-ink-2")}>
                {o.slow.lapsed ? slowLine(o.slow) : <><b className="font-medium">Reason:</b> {o.slow.reason} · {slowLine(o.slow)}</>}
              </div>
            ) : null}
          </div>
          <span className="whitespace-nowrap text-[11.5px] tabular-nums text-ink-4">{idleText(o.idle_days)}</span>
        </div>
      ))}
    </div>
  );
}

function StalledAccounts({ data, nameOf, isLoading }: {
  data: ThursdayPipeline | undefined; nameOf: NameOf; isLoading: boolean;
}) {
  const byId = useMemo(() => new Map((data?.opportunities ?? []).map((o) => [o.opportunity_id, o])), [data]);
  const rows = data?.stalled_accounts ?? [];
  if (!rows.length) return <Empty isLoading={isLoading}>No stalled accounts.</Empty>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border-strong">
      <table className="w-full min-w-[640px] text-[12.5px]">
        <thead>
          <tr className="bg-surface-2 text-left text-[10px] uppercase tracking-wider text-ink-4">
            <th className="px-3 py-2 font-semibold">Account</th>
            <th className="px-2 py-2 font-semibold">Open opportunities</th>
            <th className="px-2 py-2 font-semibold">Last contact touched</th>
            <th className="px-2 py-2 font-semibold">Last opportunity move</th>
            <th className="px-3 py-2 text-right font-semibold">Idle</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.account_key} className="border-t border-border-strong align-top">
              <td className="px-3 py-1.5">
                <Link to={jobsAccountPath(a.account_key)} className="font-medium text-ink hover:text-accent hover:underline">
                  {a.account || a.account_key}
                </Link>
              </td>
              <td className="px-2 py-1.5">
                {a.opportunity_ids.map((id) => byId.get(id)).filter(Boolean).map((o) => (
                  <div key={o!.opportunity_id} className="text-[11.5px]">
                    <Link to={jobsOpportunityPath(o!.opportunity_id)} className="text-ink-2 hover:text-accent hover:underline">
                      {o!.title || untitledOppHeading(o!.account)}
                    </Link>
                    <span className="text-ink-4"> · {nameOf(o!.owner)}</span>
                  </div>
                ))}
              </td>
              <td className="px-2 py-1.5 text-[11.5px] text-ink-3">{a.last_contact_touch ? nyDay(a.last_contact_touch) : "Never"}</td>
              <td className="px-2 py-1.5 text-[11.5px] text-ink-3">{a.last_opportunity_move ? nyDay(a.last_opportunity_move) : "Never"}</td>
              <td className="px-3 py-1.5 text-right text-[11.5px] tabular-nums text-ink-4">
                {a.idle_days == null ? "—" : `${a.idle_days}d`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LostReasons({ groups, isLoading, onOpen }: {
  groups: ThursdayLostReason[]; isLoading: boolean; onOpen: (g: ThursdayLostReason) => void;
}) {
  if (!groups.length) return <Empty isLoading={isLoading}>Nothing closed lost in this window.</Empty>;
  const max = Math.max(...groups.map((g) => g.count));
  const line = noReasonLine(groups);
  return (
    <div className="flex flex-col gap-1">
      {groups.map((g) => (
        <button key={g.key ?? "none"} type="button" onClick={() => onOpen(g)}
          className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_36px] items-center gap-3 rounded px-1 py-1 text-left hover:bg-surface-2/60">
          <span className={cn("truncate text-[12.5px]", g.key ? "text-ink-2" : "font-medium text-[var(--red)]")}>{g.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-surface-2">
            <span className={cn("block h-full rounded-full", g.key ? "bg-accent" : "bg-[var(--red)]")}
              style={{ width: `${(100 * g.count) / max}%` }} />
          </span>
          <span className="text-right text-[12px] tabular-nums text-ink-2">{g.count}</span>
        </button>
      ))}
      {line ? <p className="mt-1 text-[11.5px] text-ink-4">{line}</p> : null}
    </div>
  );
}

function OpenTable({ data, nameOf, isLoading }: {
  data: ThursdayPipeline | undefined; nameOf: NameOf; isLoading: boolean;
}) {
  const groups = useMemo(() => byAccount(data?.opportunities ?? [], data?.accounts ?? []), [data]);
  if (!groups.length) return <Empty isLoading={isLoading}>No open opportunities of this type.</Empty>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border-strong">
      <table className="w-full min-w-[900px] text-[12.5px]">
        <thead>
          <tr className="bg-surface-2 text-left text-[10px] uppercase tracking-wider text-ink-4">
            <th className="px-3 py-2 font-semibold">Opportunity</th>
            <th className="px-2 py-2 font-semibold">Stage</th>
            <th className="px-2 py-2 font-semibold">Owner</th>
            <th className="px-2 py-2 font-semibold">Relationship owner</th>
            <th className="px-2 py-2 text-right font-semibold">Days in stage</th>
            <th className="px-2 py-2 font-semibold">Last activity</th>
            <th className="px-3 py-2 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <AccountRows key={g.key} group={g} nameOf={nameOf} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountRows({ group, nameOf }: { group: ReturnType<typeof byAccount>[number]; nameOf: NameOf }) {
  return (
    <>
      <tr className="border-t border-border-strong bg-surface-2/40">
        <td colSpan={7} className="px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {group.key ? (
              <Link to={jobsAccountPath(group.key)} className="font-semibold text-ink hover:text-accent hover:underline">{group.name}</Link>
            ) : <span className="font-semibold text-ink">{group.name}</span>}
            <span className="text-[11px] text-ink-4">{opportunities(group.rows.length)}</span>
            {group.account?.state === "stalled" ? (
              <span className="rounded-full bg-[var(--red-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--red)]">
                Account stalled{group.account.idle_days != null ? ` · ${group.account.idle_days}d` : ""}
              </span>
            ) : null}
          </div>
        </td>
      </tr>
      {group.rows.map((o) => (
        <tr key={o.opportunity_id} className="border-t border-border-strong align-top">
          <td className="px-3 py-1.5 pl-6">
            <Link to={jobsOpportunityPath(o.opportunity_id)} className="text-ink hover:text-accent hover:underline">
              {o.title || untitledOppHeading(o.account)}
            </Link>
          </td>
          <td className="px-2 py-1.5"><DealStagePill stage={o.stage as JobStage} /></td>
          <td className="px-2 py-1.5 text-ink-2">{nameOf(o.owner)}</td>
          <td className="px-2 py-1.5 text-ink-2">{o.relationship_owner ? nameOf(o.relationship_owner) : <span className="text-ink-4">—</span>}</td>
          <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">
            {o.days_in_stage}{o.stage_from_created ? <span className="text-ink-4" title="No stage change logged: days since created"> *</span> : null}
          </td>
          <td className="px-2 py-1.5">
            <div className="text-ink-2">{lastActivityLine(o.last_activity, nameOf)}</div>
            <div className="text-[11px] text-ink-4">{idleText(o.idle_days)}</div>
          </td>
          <td className="px-3 py-1.5">
            <StatePill state={o.state} />
            {o.slow ? <div className="mt-0.5 max-w-[220px] text-[11px] text-ink-4">{o.slow.lapsed ? slowLine(o.slow) : o.slow.reason}</div> : null}
          </td>
        </tr>
      ))}
    </>
  );
}

function DrillDrawer({ drill, nameOf, onClose }: { drill: Drill; nameOf: NameOf; onClose: () => void }) {
  return (
    <Drawer open onClose={onClose} title={drill.title}
      subtitle={`${drill.rows.length} ${drill.kind === "opps" ? (drill.rows.length === 1 ? "opportunity" : "opportunities") : drill.rows.length === 1 ? "record" : "records"}${drill.note ? ` · ${drill.note}` : ""}`}
      width={760}>
      <div className="flex-1 overflow-auto p-4">
        {drill.rows.length === 0 ? <Empty>Nothing here for this window.</Empty>
          : drill.kind === "opps" ? <OppRows rows={drill.rows} nameOf={nameOf} isLoading={false} empty="" />
            : (
              <div className="overflow-hidden rounded-lg border border-border-strong">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-surface-2 text-left text-[10px] uppercase tracking-wider text-ink-4">
                      <th className="px-3 py-2 font-semibold">Account</th>
                      <th className="px-2 py-2 font-semibold">What</th>
                      <th className="px-2 py-2 font-semibold">Who</th>
                      <th className="px-3 py-2 text-right font-semibold">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.rows.map((r, i) => (
                      <tr key={`${r.opportunity_id}-${i}`} className="border-t border-border-strong">
                        <td className="px-3 py-1.5">
                          <Link to={jobsOpportunityPath(r.opportunity_id)} className="font-medium text-ink hover:text-accent hover:underline">
                            {r.account || "—"}
                          </Link>
                        </td>
                        <td className="px-2 py-1.5 text-ink-2">{r.detail}</td>
                        <td className="px-2 py-1.5 text-[11.5px] text-ink-3">{nameOf(r.actor)}</td>
                        <td className="px-3 py-1.5 text-right text-[11.5px] tabular-nums text-ink-4">{r.at ? nyDay(r.at) : "—"}</td>
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
