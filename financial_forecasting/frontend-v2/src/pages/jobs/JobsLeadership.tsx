import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Users, Trophy, DollarSign } from "lucide-react";

import {
  usePlacements,
  useBuilderSegments,
  useJobsStaff,
  useJobsContacts,
  useJobsAccounts,
  useJobsOpportunities,
  useOpportunitiesOverview,
  useTagCampaigns,
} from "@/services/jobs";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { ActivityTrends } from "@/components/jobs/ActivityTrends";
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

// ── This week's pulse + coverage & hygiene ──────────────────────────────────
// Leadership roll-up of the numbers the Outreach/Pipeline tabs manage. Tiles
// LINK to the surface where the number can be acted on (management lives
// there; this view stays read-only).

const startOfWeekSunday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

function PulseTile({ label, value, sub, to, tone }: {
  label: string; value: string | number; sub?: string; to?: string; tone?: "amber" | "red" | "green";
}) {
  const body = (
    <>
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{label}{to ? " ›" : ""}</div>
      <div className={cn("mt-1 text-[24px] font-bold tabular-nums",
        tone === "amber" ? "text-amber" : tone === "red" ? "text-red" : tone === "green" ? "text-green" : "text-ink")}>{value}</div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
    </>
  );
  const cls = "rounded-lg border border-border-strong bg-surface px-4 py-3";
  return to
    ? <Link to={to} className={cn(cls, "block transition-colors hover:border-accent")}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

function ExecPulse() {
  const { data: staff = [] } = useJobsStaff();
  const [owner, setOwner] = useState<string>("all");
  const o = owner === "all" ? undefined : owner;
  const { data: overview } = useOpportunitiesOverview(o);
  const { data: campaigns = [] } = useTagCampaigns();
  const { data: accounts = [] } = useJobsAccounts(undefined, "all");
  const { data: assignedData } = useJobsContacts({ membership_stage: "assigned", limit: 1000 });
  const { data: contactedData } = useJobsContacts({ membership_stage: "initial_outreach", limit: 1000 });
  const { data: wonData } = useJobsOpportunities({ stage: "closed_won", owner_email: o, limit: 500 });

  const staffEmails = useMemo(() => new Set(staff.map((s) => s.email.toLowerCase())), [staff]);
  const ownedBySelected = (email: string | null | undefined) =>
    o ? (email ?? "").toLowerCase() === o.toLowerCase() : true;

  const contactedThisWeek = useMemo(() => {
    const weekStart = startOfWeekSunday();
    return (contactedData?.data ?? []).filter((c) =>
      ownedBySelected(c.owner_email) &&
      c.membership_stage_entered_at && new Date(c.membership_stage_entered_at) >= weekStart).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactedData, o]);
  const queueSize = useMemo(
    () => (assignedData?.data ?? []).filter((c) => ownedBySelected(c.owner_email)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assignedData, o]);
  const staleAssigned = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400000;
    return (assignedData?.data ?? []).filter((c) => ownedBySelected(c.owner_email) &&
      c.membership_stage_entered_at && new Date(c.membership_stage_entered_at).getTime() < cutoff).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedData, o]);
  const noProspect = useMemo(() => accounts.filter((a) =>
    a.owner_email && staffEmails.has(a.owner_email.toLowerCase()) &&
    ownedBySelected(a.owner_email) && a.prospect_count === 0).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, staffEmails, o]);
  // Prospects reached — from the campaign funnels (worked = contacted + converted
  // + on-hold). Campaign counts aren't owner-scoped; shown all-team always.
  const reached = useMemo(() => {
    let worked = 0, pool = 0;
    for (const c of campaigns) {
      worked += c.funnel.contacted + c.funnel.converted + c.funnel.on_hold;
      pool += c.in_pipeline;
    }
    return { worked, pool, pct: pool ? Math.round((100 * worked) / pool) : 0 };
  }, [campaigns]);
  const wonOpenTasks = useMemo(
    () => (wonData?.data ?? []).filter((op) => (op.open_tasks ?? 0) > 0).length,
    [wonData]);

  const s = overview?.summary;
  const netDelta = s ? s.net_new - s.net_new_prev : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">This week's pulse · coverage</div>
        <select value={owner} onChange={(e) => setOwner(e.target.value)}
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
          title="Scope the pulse tiles to one owner">
          <option value="all">All owners</option>
          {staff.map((st) => <option key={st.email} value={st.email}>{st.name}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PulseTile label="Contacted this week" value={contactedThisWeek}
          sub={o ? `queue: ${queueSize}` : `team target 100 · queue: ${queueSize}`}
          to="/jobs/performance?tab=outreach" tone={contactedThisWeek > 0 ? "green" : undefined} />
        <PulseTile label="Net-new opps" value={s?.net_new ?? "…"}
          sub={s ? `${netDelta >= 0 ? "▲" : "▼"} ${Math.abs(netDelta)} vs prior week` : undefined}
          to="/jobs/performance?tab=pipeline" tone={netDelta > 0 ? "green" : undefined} />
        <PulseTile label="Won this week" value={s?.moved_committed ?? "…"}
          sub={s && s.closed_lost > 0 ? `${s.closed_lost} lost` : undefined}
          to="/jobs/performance?tab=pipeline" tone={(s?.moved_committed ?? 0) > 0 ? "green" : undefined} />
        <PulseTile label="Jobs prospects reached" value={`${reached.pct}%`}
          sub={`${reached.worked.toLocaleString()} of ${reached.pool.toLocaleString()} in pipeline · all team`}
          to="/jobs/performance?tab=outreach" />
        <PulseTile label="Assigned, no prospect" value={noProspect}
          sub="owned accounts, nobody identified" to="/jobs/performance?tab=outreach"
          tone={noProspect > 0 ? "amber" : undefined} />
        <PulseTile label="Assigned > 7d, untouched" value={staleAssigned}
          sub="stale queue" to="/jobs/performance?tab=outreach" tone={staleAssigned > 0 ? "amber" : undefined} />
        <PulseTile label="Won, open tasks" value={wonOpenTasks}
          sub="e.g. contracts unsigned" to="/jobs/pipeline" tone={wonOpenTasks > 0 ? "red" : undefined} />
        <PulseTile label="Needs attention" value={overview?.needs_attention?.length ?? "…"}
          sub="3+ wks in stage or gone quiet" to="/jobs/performance?tab=pipeline"
          tone={(overview?.needs_attention?.length ?? 0) > 0 ? "amber" : undefined} />
      </div>
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

      {/* ── ZONE 2b · This week's pulse + coverage & hygiene ──────────── */}
      <ExecPulse />


      {/* ── ZONE 3 · Outreach & activation over time ──────────────────── */}
      {/* Tag campaigns moved to the Outreach tab (2026-07-30) — it's the
          Monday-meeting centerpiece, not an exec outcome. */}
      <ActivityTrends />

      <MetricDrawer metricKey={openMetric} onClose={() => setOpenMetric(null)} />
    </div>
  );
}
