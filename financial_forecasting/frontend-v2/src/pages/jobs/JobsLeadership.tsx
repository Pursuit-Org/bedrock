import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Users, Trophy, DollarSign } from "lucide-react";

import {
  usePlacements,
  useBuilderSegments,
  useJobsStaff,
  useJobsAccounts,
  useJobsOpportunities,
} from "@/services/jobs";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { MetricDrawer } from "@/components/jobs/MetricDrawer";
import { JobsStatBubble } from "@/components/jobs/JobsStatBubble";
import { cn } from "@/lib/utils";


// ── Section wrapper ───────────────────────────────────────────────────────

function SectionWrap({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Hygiene line ─────────────────────────────────────────────────────────────
// The two numbers no other band carries (2026-07-30 exec review pared the
// 8-tile pulse band down to these — everything else restated Outreach/Pipeline
// numbers one click away). Each links to the surface where it's fixed.

function HygieneLine() {
  const { data: staff = [] } = useJobsStaff();
  const { data: accounts = [] } = useJobsAccounts(undefined, "all");
  const { data: wonData } = useJobsOpportunities({ stage: "closed_won", limit: 500 });
  const staffEmails = useMemo(() => new Set(staff.map((s) => s.email.toLowerCase())), [staff]);
  const noProspect = useMemo(() => accounts.filter((a) =>
    a.owner_email && staffEmails.has(a.owner_email.toLowerCase()) && a.prospect_count === 0).length,
    [accounts, staffEmails]);
  const wonOpenTasks = useMemo(
    () => (wonData?.data ?? []).filter((op) => (op.open_tasks ?? 0) > 0).length,
    [wonData]);
  if (noProspect === 0 && wonOpenTasks === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border-strong bg-surface-2/60 px-3 py-2 text-[12px] text-ink-3">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Hygiene</span>
      {noProspect > 0 && (
        <Link to="/jobs/performance?tab=outreach" className="hover:text-ink">
          <span className={cn("font-semibold tabular-nums", "text-amber")}>{noProspect}</span> accounts assigned with no prospect →
        </Link>
      )}
      {wonOpenTasks > 0 && (
        <Link to="/jobs/pipeline" className="hover:text-ink">
          <span className="font-semibold tabular-nums text-red">{wonOpenTasks}</span> won with open tasks →
        </Link>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function JobsLeadership() {
  const [openMetric, setOpenMetric] = useState<string | null>(null);
  const [segment, setSegment] = useState<string>("all");
  const placementsQ = usePlacements(segment);
  const segmentsQ = useBuilderSegments();

  const p = placementsQ.data;
  const pLoading = placementsQ.isLoading;

  // Denominator for the "% of total" cards = the job-ready pool size for the
  // selected segment (or all L3+).
  const poolTotal =
    segment === "all"
      ? segmentsQ.data?.total ?? 0
      : segmentsQ.data?.segments.find((s) => s.value === segment)?.count ?? 0;
  const pctOfPool = (n: number) => (poolTotal ? Math.round((100 * n) / poolTotal) : 0);

  return (
    <div className="flex flex-col gap-7">
      {/* ── Segment filter (scopes builder outcomes to an L3 cohort) ──── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Segment</span>
        <select
          value={segment}
          onChange={(e) => setSegment(e.target.value)}
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
        >
          <option value="all">All L3+ ({segmentsQ.data?.total ?? "…"})</option>
          {(segmentsQ.data?.segments ?? []).map((s) => (
            <option key={s.value} value={s.value}>{s.label} ({s.count})</option>
          ))}
        </select>
        <span className="text-[11px] text-ink-4">L3 cohort that fed the job-ready pool · scopes builder outcomes &amp; funnel</span>
      </div>

      {/* ── ZONE 1 · North Star (outcomes) ────────────────────────────── */}
      <SectionWrap title="North Star · Outcomes">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <JobsStatBubble
            big
            label="FT Roles Secured"
            value={p?.ft_roles_secured ?? 0}
            tone="violet"
            icon={<Trophy size={14} />}
            isLoading={pLoading}
            celebrate={!pLoading && (p?.ft_roles_secured ?? 0) > 0}
            subLead={pLoading ? undefined : [
              `${p?.ft_builders ?? 0} placed`,
              // Committed roles have no builder → no cohort; under a segment
              // they're informational, never added into the cohort's number
              // (they'd otherwise repeat under every cohort — TKT-127).
              segment === "all"
                ? `${p?.committed_ft_roles ?? 0} committed`
                : `+${p?.committed_ft_roles ?? 0} committed (all cohorts, not added)`,
              ...((p?.committed_trial_active ?? 0) > 0 ? [`${p?.committed_trial_active} in trial`] : []),
            ].join(" · ")}
            sub={pLoading ? undefined : `${pctOfPool(p?.ft_roles_secured ?? 0)}% of ${poolTotal} job-ready`}
            progressPct={pctOfPool(p?.ft_roles_secured ?? 0)}
            progressLabel={`${pctOfPool(p?.ft_roles_secured ?? 0)}%`}
            onClick={() => setOpenMetric("placements")}
          />
          <JobsStatBubble
            big
            label="Builders w/ Paid Work"
            value={p?.any_builders ?? 0}
            tone="sky"
            icon={<Users size={14} />}
            isLoading={pLoading}
            subLead="any paid work · incl. full-time"
            sub={pLoading ? undefined : `${pctOfPool(p?.any_builders ?? 0)}% of ${poolTotal} job-ready`}
            progressPct={pctOfPool(p?.any_builders ?? 0)}
            progressLabel={`${pctOfPool(p?.any_builders ?? 0)}%`}
            onClick={() => setOpenMetric("any_paid")}
          />
          <JobsStatBubble
            big
            label="Avg FT Salary"
            value={p?.avg_salary_ft_secured ?? 0}
            tone="emerald"
            icon={<DollarSign size={14} />}
            format="salary"
            isLoading={pLoading}
            subLead="secured (placed + committed)"
            sub={p?.avg_salary_ft_placed != null ? `Placed: $${p.avg_salary_ft_placed.toLocaleString()} · click to edit` : "click to edit"}
            onClick={() => setOpenMetric("ft_salaries")}
          />
        </div>
      </SectionWrap>

      {/* ── ZONE 2 · The Funnel (the engine) ──────────────────────────── */}
      <JobsFunnels builderSegment={segment} />

      {/* ── ZONE 2b · Hygiene (the two numbers nothing else carries) ──── */}
      <HygieneLine />

      {/* Tag campaigns + activity trends live on the Outreach tab (2026-07-30)
          — Monday-meeting material, not exec outcomes. */}

      <MetricDrawer metricKey={openMetric} onClose={() => setOpenMetric(null)} />
    </div>
  );
}
