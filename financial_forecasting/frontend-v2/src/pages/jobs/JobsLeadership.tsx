import { useState } from "react";
import { Users, Trophy, DollarSign } from "lucide-react";

import { usePlacements, useBuilderSegments } from "@/services/jobs";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { MetricDrawer } from "@/components/jobs/MetricDrawer";
import { JobsStatBubble } from "@/components/jobs/JobsStatBubble";
import {
  FULL_TIME, placedLabel, placedBreakdown, inRoleLine, ofJobReady, pctOf, ringPct,
  committedLine, expectedSalaryLine, salaryBasis,
} from "@/components/jobs/outcomeCards";


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

const selectClass =
  "h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent";

/** A line inside a card that opens its own drill, not the card's. */
function LineLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      // The card is a role="button" that opens its own drill on Enter/Space.
      onKeyDown={(e) => e.stopPropagation()}
      className="w-fit text-left text-[11.5px] font-medium text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function JobsLeadership() {
  const [openMetric, setOpenMetric] = useState<string | null>(null);
  const [segment, setSegment] = useState<string>("all");
  // Full-time is the core number; every other type, and all paid work, can be
  // viewed (D4). It scopes the Placed card, its drill and the funnel's last stage.
  const [jobType, setJobType] = useState<string>(FULL_TIME);
  const placementsQ = usePlacements(segment, jobType);
  const segmentsQ = useBuilderSegments();

  const p = placementsQ.data;
  // The job types come from the cohort's own work, so a type picked under one
  // cohort may not exist under another: keep it listed (at 0) rather than let
  // the select show a value the cards aren't using.
  const jobTypes = p?.job_types ?? [];
  const jobTypeOptions = jobTypes.some((t) => t.value === jobType)
    ? jobTypes
    : [...jobTypes, { value: jobType, label: placedLabel(jobType).replace(/^Placed · /, ""), count: 0 }];
  const pLoading = placementsQ.isLoading;
  const scoped = segment !== "all";
  const jobReady = p?.job_ready ?? 0;
  const paidRate = pctOf(p?.paid_work ?? 0, jobReady);
  const breakdown = p ? placedBreakdown(p, jobType) : null;
  const expected = p ? expectedSalaryLine(p.committed_expected_salary, p.committed_roles, scoped) : null;

  return (
    <div className="flex flex-col gap-7">
      {/* ── Filters: cohort (incl. Current L3, D12) and job type (D4) ──── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Cohort</span>
          <select value={segment} onChange={(e) => setSegment(e.target.value)} className={selectClass}>
            <option value="all">All L3+ ({segmentsQ.data?.total ?? "…"})</option>
            {(segmentsQ.data?.segments ?? []).map((s) => (
              <option key={s.value} value={s.value}>{s.label} ({s.count})</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Job type</span>
          <select value={jobType} onChange={(e) => setJobType(e.target.value)} className={selectClass}>
            {jobTypeOptions.map((t) => (
              <option key={t.value} value={t.value}>{t.label}{p ? ` (${t.count})` : ""}</option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-ink-4">Job-ready (L3+) builders · scopes the outcomes &amp; the builders funnel</span>
      </div>

      {/* ── ZONE 1 · North Star (outcomes) ────────────────────────────── */}
      <SectionWrap title="North Star · Outcomes">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <JobsStatBubble
            big
            label={placedLabel(jobType, p?.job_types)}
            value={p?.placed ?? 0}
            tone="violet"
            icon={<Trophy size={14} />}
            isLoading={pLoading}
            celebrate={!pLoading && (p?.placed ?? 0) > 0}
            subLead={pLoading || !p ? undefined : (
              <span className="flex flex-col gap-0.5">
                {breakdown ? <span>{breakdown}</span> : null}
                <span>{inRoleLine(p)}</span>
                {jobType === FULL_TIME ? (
                  <LineLink onClick={() => setOpenMetric("committed_roles")}>
                    {committedLine(p.committed_roles, scoped)}
                  </LineLink>
                ) : null}
              </span>
            )}
            sub={pLoading ? undefined : ofJobReady(p?.placed_rate, jobReady)}
            progressPct={ringPct(p?.placed_rate)}
            progressLabel={`${ringPct(p?.placed_rate)}%`}
            onClick={() => setOpenMetric("placements")}
          />
          <JobsStatBubble
            big
            label="Builders with Paid Work"
            value={p?.paid_work ?? 0}
            tone="sky"
            icon={<Users size={14} />}
            isLoading={pLoading}
            subLead="any paid work, full-time and trials included · not pro bono"
            sub={pLoading ? undefined : ofJobReady(paidRate, jobReady)}
            progressPct={ringPct(paidRate)}
            progressLabel={`${ringPct(paidRate)}%`}
            onClick={() => setOpenMetric("any_paid")}
          />
          <JobsStatBubble
            big
            label="Avg FT Salary"
            value={p?.avg_ft_salary_placed ?? 0}
            tone="emerald"
            icon={<DollarSign size={14} />}
            format="salary"
            isLoading={pLoading}
            subLead={pLoading || !p ? undefined : (
              <span className="flex flex-col gap-0.5">
                <span>{salaryBasis(p.ft_salaried)}</span>
                {expected ? (
                  <LineLink onClick={() => setOpenMetric("committed_roles")}>{expected}</LineLink>
                ) : null}
              </span>
            )}
            onClick={() => setOpenMetric("ft_salaries")}
          />
        </div>
      </SectionWrap>

      {/* ── ZONE 2 · The Funnel (the engine) ──────────────────────────── */}
      {/* Open on Overview: here the funnel is the content, not context. */}
      <JobsFunnels builderSegment={segment} builderJobType={jobType} defaultOpen />

      {/* Hygiene line removed 2026-08-04. "Won, open tasks" is a summary card on
          the Pipeline page and the no-prospect accounts surface in Outreach's
          Requiring Attention, so the strip only restated numbers one click away.
          Tag campaigns + activity trends likewise live on Outreach (2026-07-30)
          — Monday-meeting material, not exec outcomes. */}

      <MetricDrawer
        metricKey={openMetric}
        segment={segment}
        // Only the Placed drill follows the job type; the other two are fixed.
        jobType={openMetric === "placements" ? jobType : undefined}
        onClose={() => setOpenMetric(null)}
      />
    </div>
  );
}
