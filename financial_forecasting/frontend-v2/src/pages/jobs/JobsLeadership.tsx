import { useState } from "react";
import { Users, Trophy, DollarSign } from "lucide-react";

import {
  usePlacements,
  useBuilderSegments,
} from "@/services/jobs";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { ActivityTrends } from "@/components/jobs/ActivityTrends";
import { MetricDrawer } from "@/components/jobs/MetricDrawer";
import { JobsStatBubble } from "@/components/jobs/JobsStatBubble";


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


      {/* ── ZONE 3 · Outreach & activation over time ──────────────────── */}
      {/* Tag campaigns moved to the Outreach tab (2026-07-30) — it's the
          Monday-meeting centerpiece, not an exec outcome. */}
      <ActivityTrends />

      <MetricDrawer metricKey={openMetric} onClose={() => setOpenMetric(null)} />
    </div>
  );
}
