import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";

import { OwnerExpandPanel, OWNER_PANEL_HEIGHT } from "@/components/OwnerExpandPanel";
import { PageHeader } from "@/components/PageHeader";
import { PipelineFunnel } from "@/components/dashboard/PipelineFunnel";
import { RevenueSnapshotPanel } from "@/components/dashboard/RevenueSnapshotPanel";
import { Tooltip } from "@/components/ui/Tooltip";
import { fmtMoney } from "@/lib/format";
import { isOpen, isWon } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/services/auth";
import { useOpportunities } from "@/services/opportunities";
import { useACVSummary } from "@/services/payments";
import { useOwnerGoals } from "@/services/ownerGoals";
import { useActiveUsers } from "@/services/users";
import type { SfOpportunity } from "@/types/salesforce";
import type { CashflowBucket } from "@/services/cashflow";
import { filterByBucket } from "@/lib/bucketFilter";

// ── Year helper ──────────────────────────────────────────────────────────

function yearOf(iso: string): number | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear();
}

// ── Page ────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { data: user } = useCurrentUser();
  const { data: opps = [] } = useOpportunities();
  const { data: ownerGoals = [] } = useOwnerGoals();
  const { data: activeUsers = [] } = useActiveUsers();

  const fy = new Date().getUTCFullYear();
  const [bucket, setBucket] = useState<CashflowBucket>("philanthropy");
  const filteredOpps = useMemo(() => filterByBucket(opps, bucket), [opps, bucket]);

  return (
    <div className="mx-auto max-w-[1320px] px-7 py-6 pb-20">
      <PageHeader
        title={user ? `Welcome, ${user.name?.split(" ")[0] ?? ""}` : "Dashboard"}
      />

      <div className="flex flex-col gap-6">
        {/* YTD Revenue Snapshot */}
        <RevenueSnapshotPanel year={fy} />

        {/* Record-type filter */}
        <div className="inline-flex flex-wrap gap-1.5">
          {(["all", "philanthropy", "pbc", "capital_grants", "other"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBucket(b)}
              className={
                bucket === b
                  ? "h-7 rounded-full border border-accent bg-accent/10 px-3 text-[12.5px] font-medium text-accent"
                  : "h-7 rounded-full border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:text-ink"
              }
              aria-pressed={bucket === b}
            >
              {{all:"All",philanthropy:"Philanthropy",pbc:"PBC",capital_grants:"Capital Grants",other:"Other"}[b]}
            </button>
          ))}
        </div>
        <CurrentFYOverview opps={filteredOpps} fy={fy} bucket={bucket} />
        <PipelineFunnel opps={filteredOpps} />
        <IndividualGoals
          opps={filteredOpps}
          fy={fy}
          ownerGoals={ownerGoals}
          activeUsers={activeUsers}
        />
      </div>
    </div>
  );
}

// ── Section: Current FY Overview ─────────────────────────────────────────
//
// Scenario matrix — confidence-tiered, weighted by SF Probability.
// Renewals are always included regardless of probability (they're
// inherently near-certain by definition).
//
//   Wins              full Amount of opps where isWon (terminal stages)
//   Total Pipeline    wins + open Amount (unweighted)
//   Downside          wins + Σ (open Amount × Probability) for opps where
//                     RenewalRepeat__c='Renewal' OR Probability ≥ 90%
//   Base Case         wins + Σ weighted where Renewal OR Probability ≥ 75%
//   Upside            wins + Σ weighted where Renewal OR Probability ≥ 50%
//
// "Overall" column on the weighted scenarios is intentionally — (the
// deployed dashboard only shows all-time on Total Pipeline; cumulative
// scenario projections aren't meaningful). Past quarters render — for
// every row except Wins (we only know wins for past quarters; pipeline /
// scenarios for closed quarters are meaningless).

function isRenewal(o: SfOpportunity): boolean {
  return o.RenewalRepeat__c === "Renewal";
}

function weightedValue(o: SfOpportunity): number {
  return ((o.Amount ?? 0) * (o.Probability ?? 0)) / 100;
}

interface QuarterMetrics {
  label: "Q1" | "Q2" | "Q3" | "Q4";
  isPast: boolean;
  wins: number;
  pipeline: number;
  downside: number;
  baseCase: number;
  upside: number;
}

function endOfQuarterMs(year: number, q: number): number {
  // q is 1..4 — last day at 23:59:59.999.
  const endMonthIdx = q * 3 - 1; // 2, 5, 8, 11
  // First day of the next month, minus 1ms.
  return Date.UTC(year, endMonthIdx + 1, 1) - 1;
}

function CurrentFYOverview({
  opps,
  fy,
  bucket = "all",
}: {
  opps: SfOpportunity[];
  fy: number;
  bucket?: string;
}) {
  const { data: acv } = useACVSummary(fy, bucket);
  const metrics = useMemo(() => {
    const openOpps = opps.filter(isOpen);
    const wonOpps = opps.filter(isWon);

    // Overall (all-time) — only Total Pipeline uses this; the others
    // render — for "Overall" because cumulative scenario forecasts
    // don't really mean anything.
    const overallOpenAmount = openOpps.reduce((s, o) => s + (o.Amount ?? 0), 0);
    const overallWins = wonOpps.reduce((s, o) => s + (o.Amount ?? 0), 0);
    const totalPipelineOverall = overallOpenAmount + overallWins;

    // FY scope — opps where CloseDate falls in the current calendar year.
    const inFY = (o: SfOpportunity) =>
      !!o.CloseDate && yearOf(o.CloseDate) === fy;
    const fyOpen = openOpps.filter(inFY);
    const fyWon = wonOpps.filter(inFY);
    const fyWinsAmount = fyWon.reduce((s, o) => s + (o.Amount ?? 0), 0);
    const fyOpenAmount = fyOpen.reduce((s, o) => s + (o.Amount ?? 0), 0);
    const fyPipeline = fyOpenAmount + fyWinsAmount;
    // All three weighted scenarios share the same shape: wins + Σ(open
    // Amount × Probability) for opps that EITHER are renewals OR exceed
    // a probability cutoff. Renewals are always included.
    const weightedAbove = (opps: SfOpportunity[], minProb: number) =>
      fyWinsAmount +
      opps
        .filter((o) => isRenewal(o) || (o.Probability ?? 0) >= minProb)
        .reduce((s, o) => s + weightedValue(o), 0);
    const fyDownside = weightedAbove(fyOpen, 90);
    const fyBase = weightedAbove(fyOpen, 75);
    const fyUpside = weightedAbove(fyOpen, 50);

    // Per-quarter — past quarters get wins only; current/future get the
    // full set of pipeline+scenario projections.
    const nowMs = Date.now();
    const qMetrics: QuarterMetrics[] = ([1, 2, 3, 4] as const).map((q) => {
      const qStart = Date.UTC(fy, (q - 1) * 3, 1);
      const qEnd = endOfQuarterMs(fy, q);
      const isPast = qEnd < nowMs;
      const inQ = (o: SfOpportunity) => {
        if (!o.CloseDate) return false;
        const t = new Date(o.CloseDate).getTime();
        return t >= qStart && t <= qEnd;
      };
      const qWon = wonOpps.filter(inQ);
      const qOpen = openOpps.filter(inQ);
      const wins = qWon.reduce((s, o) => s + (o.Amount ?? 0), 0);
      if (isPast) {
        return {
          label: `Q${q}` as QuarterMetrics["label"],
          isPast,
          wins,
          pipeline: 0,
          downside: 0,
          baseCase: 0,
          upside: 0,
        };
      }
      const openTotal = qOpen.reduce((s, o) => s + (o.Amount ?? 0), 0);
      const qWeightedAbove = (minProb: number) =>
        wins +
        qOpen
          .filter((o) => isRenewal(o) || (o.Probability ?? 0) >= minProb)
          .reduce((s, o) => s + weightedValue(o), 0);
      return {
        label: `Q${q}` as QuarterMetrics["label"],
        isPast,
        wins,
        pipeline: wins + openTotal,
        downside: qWeightedAbove(90),
        baseCase: qWeightedAbove(75),
        upside: qWeightedAbove(50),
      };
    });

    return {
      totalPipelineOverall,
      fy: {
        wins: fyWinsAmount,
        pipeline: fyPipeline,
        downside: fyDownside,
        baseCase: fyBase,
        upside: fyUpside,
      },
      qMetrics,
    };
  }, [opps, fy]);

  const fyLabel = `FY${String(fy).slice(-2)}`;

  return (
    <SectionCard
      title={`Current FY Overview · ${fy}`}

    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-4 py-2 text-left font-semibold">Metric</th>
              <th className="px-4 py-2 text-right font-semibold">Overall</th>
              <th className="px-4 py-2 text-right font-semibold">{fyLabel}</th>
              {metrics.qMetrics.map((q) => (
                <th
                  key={q.label}
                  className={cn(
                    "px-4 py-2 text-right font-semibold",
                    q.isPast && "text-ink-4",
                  )}
                >
                  {q.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Wins (TCV) — total contract value of won opps closing this FY */}
            <tr className="border-t border-border-strong bg-green-soft/30">
              <td className="px-4 py-2 font-semibold text-green">
                <span className="inline-flex items-center gap-1">
                  Wins (TCV)
                  <Tooltip content="Total contract value">
                    <span tabIndex={0} aria-label="Total contract value" className="cursor-help text-green/50 outline-none focus:text-green">
                      <Info size={11} />
                    </span>
                  </Tooltip>
                </span>
              </td>
              <Dash />
              <DollarCell value={metrics.fy.wins} className="font-semibold text-green" />
              {metrics.qMetrics.map((q) => (
                <DollarCell
                  key={q.label}
                  value={q.wins}
                  className="font-semibold text-green"
                />
              ))}
            </tr>

            {/* Wins (ACV) — subset of TCV: payments from won opps hitting this year */}
            <tr className="border-b border-border bg-green-soft/10">
              <td className="py-1.5 pl-7 pr-4 text-ink-3">
                <span className="inline-flex items-center gap-1 text-[12px]">
                  <span className="text-ink-4">↳</span>
                  cash this year
                  <Tooltip content="ACV: annual contract value">
                    <span tabIndex={0} aria-label="ACV: annual contract value" className="cursor-help text-ink-4 outline-none focus:text-ink-2">
                      <Info size={11} />
                    </span>
                  </Tooltip>
                </span>
              </td>
              <Dash />
              <DollarCell value={acv?.fy ?? 0} className="text-[12px] text-ink-2" />
              {metrics.qMetrics.map((q) => (
                <DollarCell
                  key={q.label}
                  value={acv?.[q.label.toLowerCase() as "q1" | "q2" | "q3" | "q4"] ?? 0}
                  className="text-[12px] text-ink-2"
                />
              ))}
            </tr>

            {/* Total Pipeline — only row that shows an "Overall" number
                (cumulative wins+open is meaningful). Past quarters
                render —. */}
            <tr className="border-t border-border-strong">
              <td className="px-4 py-2 font-semibold">Open Pipeline</td>
              <DollarCell
                value={metrics.totalPipelineOverall}
                className="font-bold text-accent-ink"
              />
              <DollarCell value={metrics.fy.pipeline} className="font-semibold" />
              {metrics.qMetrics.map((q) =>
                q.isPast ? (
                  <Dash key={q.label} />
                ) : (
                  <DollarCell
                    key={q.label}
                    value={q.pipeline}
                    className="font-semibold"
                  />
                ),
              )}
            </tr>

            <ScenarioRowEl
              label="Downside"
              tooltip="Wins (100% TCV) + open renewals or Probability ≥ 90%, weighted"
              fyValue={metrics.fy.downside}
              quarters={metrics.qMetrics.map((q) => ({ q, value: q.downside }))}
            />
            <ScenarioRowEl
              label="Base Case"
              tooltip="Wins (100% TCV) + open renewals or Probability ≥ 75%, weighted"
              fyValue={metrics.fy.baseCase}
              quarters={metrics.qMetrics.map((q) => ({ q, value: q.baseCase }))}
            />
            <ScenarioRowEl
              label="Upside"
              tooltip="Wins (100% TCV) + open renewals or Probability ≥ 50%, weighted"
              fyValue={metrics.fy.upside}
              quarters={metrics.qMetrics.map((q) => ({ q, value: q.upside }))}
            />
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function ScenarioRowEl({
  label,
  tooltip,
  fyValue,
  quarters,
}: {
  label: string;
  tooltip: string;
  fyValue: number;
  quarters: { q: QuarterMetrics; value: number }[];
}) {
  return (
    <tr className="border-t border-border-strong">
      <td className="px-4 py-2 font-medium">
        <span className="inline-flex items-center gap-1">
          {label}
          <Tooltip content={tooltip}>
            <span
              tabIndex={0}
              aria-label={tooltip}
              className="cursor-help text-ink-4 outline-none focus:text-ink-2"
            >
              <Info size={11} />
            </span>
          </Tooltip>
        </span>
      </td>
      <Dash />
      <DollarCell value={fyValue} />
      {quarters.map(({ q, value }) =>
        q.isPast ? (
          <Dash key={q.label} />
        ) : (
          <DollarCell key={q.label} value={value} />
        ),
      )}
    </tr>
  );
}

function Dash() {
  return <td className="mono px-4 py-2 text-right tabular-nums text-ink-3">—</td>;
}

function DollarCell({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "mono px-4 py-2 text-right tabular-nums",
        value === 0 && "text-ink-3",
        className,
      )}
    >
      {value > 0 ? fmtMoney(value) : "—"}
    </td>
  );
}

// ── Section: Individual Goals & Pipelines ────────────────────────────────

interface OwnerRow {
  ownerId: string;
  name: string;
  isActive: boolean;
  goalAmount: number | null;
  closedWon: number;
  openPipeline: number;
  weightedPipeline: number;
  pctToGoal: number | null;
}

function IndividualGoals({
  opps,
  fy,
  ownerGoals,
  activeUsers,
}: {
  opps: SfOpportunity[];
  fy: number;
  ownerGoals: { sf_user_id: string; fiscal_year: number; goal_amount: number }[];
  activeUsers: { Id: string; Name: string }[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo<OwnerRow[]>(() => {
    const goalsThisYear = ownerGoals.filter((g) => g.fiscal_year === fy);
    const activeIds = new Set(activeUsers.map((u) => u.Id));
    const userById = new Map(activeUsers.map((u) => [u.Id, u.Name] as const));

    const ownerIds = new Set<string>();
    goalsThisYear.forEach((g) => ownerIds.add(g.sf_user_id));
    opps.forEach((o) => {
      if (o.OwnerId && o.Owner?.Name) ownerIds.add(o.OwnerId);
    });

    const list: OwnerRow[] = Array.from(ownerIds).map((ownerId) => {
      const fallbackName =
        opps.find((o) => o.OwnerId === ownerId)?.Owner?.Name ?? null;
      const name = userById.get(ownerId) ?? fallbackName ?? ownerId;
      const goal = goalsThisYear.find((g) => g.sf_user_id === ownerId);
      const ownedOpps = opps.filter((o) => o.OwnerId === ownerId);

      const closedWon = ownedOpps
        .filter((o) => isWon(o) && o.CloseDate && yearOf(o.CloseDate) === fy)
        .reduce((s, o) => s + (o.Amount ?? 0), 0);

      // Open pipeline + weighted pipeline are scoped to the same FY as
      // the goal — opps with a CloseDate falling outside this year don't
      // count toward an owner's FY goal, so they shouldn't be in the
      // pipeline columns either. Previously these were unfiltered, which
      // made the columns inconsistent with Closed Won.
      const openOppsOwner = ownedOpps.filter(
        (o) => isOpen(o) && o.CloseDate && yearOf(o.CloseDate) === fy,
      );
      const openPipeline = openOppsOwner.reduce((s, o) => s + (o.Amount ?? 0), 0);
      const weightedPipeline = openOppsOwner.reduce(
        (s, o) => s + ((o.Amount ?? 0) * (o.Probability ?? 0)) / 100,
        0,
      );

      const goalAmount = goal?.goal_amount ?? null;
      const pctToGoal =
        goalAmount && goalAmount > 0 ? (closedWon / goalAmount) * 100 : null;

      return {
        ownerId,
        name,
        isActive: activeIds.has(ownerId),
        goalAmount,
        closedWon,
        openPipeline,
        weightedPipeline,
        pctToGoal,
      };
    });

    return list
      // Show only active SF users with at least $1 of open pipeline.
      // Inactive owners and zero-pipeline rows aren't actionable on
      // this dashboard — the legacy Wall of Progress kept them but JR
      // confirmed 2026-05-04 that they're noise.
      .filter((r) => r.isActive && r.openPipeline > 0)
      .sort((a, b) => {
        // FY goal desc, then closed-won desc.
        const goalDiff = (b.goalAmount ?? -1) - (a.goalAmount ?? -1);
        if (goalDiff !== 0) return goalDiff;
        return b.closedWon - a.closedWon;
      });
  }, [opps, fy, ownerGoals, activeUsers]);

  // "Where on the dial should we be" — fraction of the calendar year
  // that's elapsed. Used as an at-a-glance pacing marker on each progress
  // bar so users can see "is X% on track for Y elapsed?" without math.
  const yearPct = useMemo(() => {
    const start = Date.UTC(fy, 0, 1);
    const end = Date.UTC(fy + 1, 0, 1);
    const now = Date.now();
    if (now <= start) return 0;
    if (now >= end) return 100;
    return ((now - start) / (end - start)) * 100;
  }, [fy]);

  // Team total summary row.
  const team = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        goalAmount: (acc.goalAmount ?? 0) + (r.goalAmount ?? 0),
        closedWon: acc.closedWon + r.closedWon,
        openPipeline: acc.openPipeline + r.openPipeline,
        weightedPipeline: acc.weightedPipeline + r.weightedPipeline,
      }),
      { goalAmount: 0, closedWon: 0, openPipeline: 0, weightedPipeline: 0 },
    );
  }, [rows]);
  const teamPct =
    team.goalAmount > 0 ? (team.closedWon / team.goalAmount) * 100 : null;

  return (
    <SectionCard title={`Individual Goals & Pipelines · FY ${fy}`}>
      {rows.length === 0 ? (
        <Empty>No active owners with open pipeline.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-[28px] px-3 py-2"></th>
                <th className="px-3 py-2 text-left font-semibold">Owner</th>
                <th className="px-3 py-2 text-right font-semibold">FY Goal</th>
                <th className="px-3 py-2 text-right font-semibold">Closed Won</th>
                <th className="px-3 py-2 text-right font-semibold">Open Pipeline</th>
                <th className="px-3 py-2 text-right font-semibold">Weighted</th>
                <th className="px-3 py-2 text-left font-semibold">% to Goal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isExpanded = expanded === r.ownerId;
                return (
                  <Fragment key={r.ownerId}>
                    <tr
                      className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
                      onClick={() => setExpanded(isExpanded ? null : r.ownerId)}
                    >
                      <td className="px-3 py-2 align-middle text-ink-4">
                        {isExpanded ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                      </td>
                      <td className="px-3 py-2 align-middle font-medium">
                        {r.name}
                      </td>
                      <td className="mono px-3 py-2 text-right tabular-nums">
                        {r.goalAmount != null ? fmtMoney(r.goalAmount) : "—"}
                      </td>
                      <td className="mono px-3 py-2 text-right font-semibold tabular-nums">
                        {fmtMoney(r.closedWon)}
                      </td>
                      <td className="mono px-3 py-2 text-right tabular-nums">
                        {fmtMoney(r.openPipeline)}
                      </td>
                      <td className="mono px-3 py-2 text-right tabular-nums text-ink-2">
                        {fmtMoney(r.weightedPipeline)}
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <ProgressBar pct={r.pctToGoal} marker={yearPct} />
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="border-t border-border-strong">
                        <td
                          colSpan={7}
                          className="p-0"
                          style={{ height: OWNER_PANEL_HEIGHT }}
                        >
                          <OwnerExpandPanel ownerId={r.ownerId} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-surface-2 font-semibold">
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2">Team total</td>
                <td className="mono px-3 py-2 text-right tabular-nums">
                  {team.goalAmount > 0 ? fmtMoney(team.goalAmount) : "—"}
                </td>
                <td className="mono px-3 py-2 text-right tabular-nums">
                  {fmtMoney(team.closedWon)}
                </td>
                <td className="mono px-3 py-2 text-right tabular-nums">
                  {fmtMoney(team.openPipeline)}
                </td>
                <td className="mono px-3 py-2 text-right tabular-nums">
                  {fmtMoney(team.weightedPipeline)}
                </td>
                <td className="px-3 py-2 align-middle">
                  <ProgressBar pct={teamPct} marker={yearPct} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function ProgressBar({
  pct,
  marker,
}: {
  pct: number | null;
  marker: number;
}) {
  const fillWidth = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const onTrack = pct === null ? null : pct >= marker - 5;
  const color =
    pct === null
      ? "bg-surface-2"
      : pct >= 100
        ? "bg-green-500"
        : onTrack
          ? "bg-amber-400"
          : "bg-red-400";
  // Year-elapsed marker — vertical line on the same bar.
  const markerLeft = `${Math.min(100, Math.max(0, marker))}%`;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-[120px] overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn("h-full rounded-full", color)}
          style={{ width: `${fillWidth}%` }}
        />
        <div
          aria-hidden="true"
          className="absolute top-0 h-full w-px bg-ink/40"
          style={{ left: markerLeft }}
        />
      </div>
      <span className="mono w-[40px] tabular-nums text-[11.5px]">
        {pct != null ? `${Math.round(pct)}%` : "—"}
      </span>
    </div>
  );
}

// ── Shared building blocks ───────────────────────────────────────────────

export function SectionCard({
  title,
  subtitle,
  trailing,
  children,
}: {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border-strong bg-surface-2 px-5 py-2">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-0.5 truncate text-[11.5px] normal-case tracking-normal text-ink-3">
              {subtitle}
            </div>
          ) : null}
        </div>
        {trailing ? <div className="flex-shrink-0">{trailing}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}
