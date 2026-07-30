import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";

import { toast } from "sonner";
import {
  useOutreachScorecard,
  useOutreachDrill,
  useOutreachTargetingMix,
  useJobsStaff,
  useJobsContacts,
  useJobsAccounts,
  useDailyDigest,
  useStuckContacts,
  useUpdateJobsMembership,
  MEMBERSHIP_STAGES,
  MEMBERSHIP_STAGE_LABELS,
  type OutreachGranularity,
  type OutreachScopeKind,
  type OutreachDateRange,
  type ScorecardRow,
  type TargetingDim,
  type MembershipStage,
} from "@/services/jobs";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { TagCampaigns } from "@/components/jobs/TagCampaigns";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { ActivityTrends } from "@/components/jobs/ActivityTrends";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const DRILL_PAGE = 25;
const MEMBERSHIP_STAGE_OPTIONS = MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] }));

// ── Toggles ───────────────────────────────────────────────────────────────────
const SCOPES: { id: OutreachScopeKind; label: string }[] = [
  { id: "pursuit", label: "Pursuit" },
  { id: "team", label: "Core team" },
  { id: "staff", label: "Other staff" },
];
const PERIODS: { id: OutreachGranularity; label: string }[] = [
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
];

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
function RowDrill({
  kind, rowKey, granularity, scope, owner, range,
}: {
  kind: "user" | "activity"; rowKey: string;
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
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
              <span className="ml-auto text-[11.5px] text-ink-4">{c.touches.length} touch{c.touches.length === 1 ? "" : "es"}</span>
            </button>
            {open && (
              <div className="flex flex-col gap-1 bg-bg px-4 py-2 pl-10">
                {c.touches.length === 0 && <div className="text-[12px] text-ink-4">No jobs touches in this period.</div>}
                {c.touches.map((t, i) => (
                  <div key={i} className="flex items-baseline gap-2 text-[12.5px]">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase",
                      t.direction === "received" ? "bg-green-soft text-green" : "bg-surface-2 text-ink-3")}>
                      {t.direction === "received" ? "reply" : t.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{t.subject || t.snippet || "(no subject)"}</span>
                    <span className="shrink-0 text-ink-4">{t.date ? fmtDate(t.date) : ""}</span>
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
function ScorecardTable({
  title, rows, idPrefix, firstColHeader, drillKind, granularity, scope, owner, range,
}: {
  title: string; rows: ScorecardRow[]; idPrefix: string; firstColHeader: string;
  drillKind: "user" | "activity";
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
      <div className="border-b border-border-strong bg-surface-2 px-4 py-3 text-[13px] font-bold text-ink-2">{title}</div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="py-2.5 pl-3.5 pr-2 text-left font-bold">{firstColHeader}</th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-bold">This</th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-bold">Last</th>
            <th className="whitespace-nowrap px-2 py-2.5 text-right font-bold">Trend</th>
            <th className="whitespace-nowrap px-3.5 py-2.5 text-right font-bold">Δ Target</th>
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
            return (
              <Fragment key={id}>
                <tr
                  onClick={() => setOpen(isOpen ? null : id)}
                  className={cn("cursor-pointer text-[13.5px] hover:bg-surface-2",
                    !isLast && "border-b border-border",
                    tierStart && "border-t-2 border-border")}
                >
                  <td className="px-3.5 py-2.5 text-left font-normal text-ink">
                    <span className="mr-1 inline-block w-3.5 text-ink-4">
                      {isOpen ? <ChevronDown size={12} className="inline" /> : <ChevronRight size={12} className="inline" />}
                    </span>
                    {r.label}
                  </td>
                  <td className="px-3.5 py-2.5 text-right tabular-nums">{r.this_period.total}</td>
                  <td className="px-3.5 py-2.5 text-right tabular-nums">{r.last_period.total}</td>
                  <td className="px-3.5 py-2.5 text-right text-[12.5px]"><Trend current={r.this_period.total} prior={r.last_period.total} /></td>
                  <td className="px-3.5 py-2.5 text-right text-[12.5px]">{r.target ? <Trend current={r.this_period.total} prior={r.target} /> : <span className="text-ink-4">—</span>}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={5} className="border-b border-border bg-bg p-0">
                      <RowDrill kind={drillKind} rowKey={rowKey} granularity={granularity} scope={scope} owner={owner} range={range} />
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
// ── Targeting Mix (horizontal bar charts, 2×2) ────────────────────────────────
function TargetingChart({ dim }: { dim: TargetingDim }) {
  const rows = dim.rows.slice(0, 8);
  const totalSent = dim.rows.reduce((s, r) => s + r.sent, 0);
  const max = Math.max(1, ...rows.map((r) => r.sent));
  return (
    <div className="flex flex-col rounded-xl border border-border-strong bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[13px] font-bold text-ink-2">{dim.label}</span>
        <span className="text-[11px] text-ink-4">{totalSent} sent total</span>
      </div>
      {rows.length === 0 && <div className="py-4 text-center text-[12.5px] text-ink-4">No contact-linked outreach in this period.</div>}
      <div className="flex flex-col gap-2">
        {rows.map((r) => {
          const share = totalSent ? Math.round((r.sent / totalSent) * 100) : 0;
          // "(unknown)" = outreach with no value tagged for this dimension; render
          // grey so it reads clearly as untagged rather than a real segment.
          const isUnknown = /^\(?unknown\)?$/i.test(r.bucket.trim());
          return (
            <div key={r.bucket} className="flex items-center gap-2">
              <div className={cn("w-[130px] shrink-0 truncate text-right text-[12.5px]", isUnknown ? "italic text-ink-4" : "text-ink-2")} title={r.bucket}>{r.bucket}</div>
              <div className="h-[18px] flex-1 rounded bg-surface-2">
                <div className={cn("h-full rounded", isUnknown ? "bg-ink-4" : "bg-accent")} style={{ width: `${Math.max(2, (r.sent / max) * 100)}%`, opacity: isUnknown ? 0.55 : 0.85 }} />
              </div>
              <div className="w-[92px] shrink-0 text-[12px] tabular-nums text-ink-2">
                <b>{r.sent}</b> <span className="text-ink-4">· {share}%</span>
              </div>
            </div>
          );
        })}
      </div>
      {dim.rows.length > 8 && <div className="mt-2 text-[11px] text-ink-4">+{dim.rows.length - 8} smaller buckets not shown</div>}
    </div>
  );
}

function TargetingMix({ granularity, scope, owner, range }: {
  granularity: OutreachGranularity; scope: OutreachScopeKind; owner?: string; range?: OutreachDateRange;
}) {
  const { data, isLoading } = useOutreachTargetingMix(granularity, scope, owner, range);
  if (isLoading) return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-48 animate-pulse rounded-xl border border-border-strong bg-surface-2" />)}
    </div>
  );
  if (!data) return null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {data.dims.map((d) => <TargetingChart key={d.key} dim={d} />)}
    </div>
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
// "Builder outreach" (staff→builder emails) isn't in the activity model yet;
// that line joins the digest once staff→builder email matching exists.

const localISODate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function digestSlackText(dg: NonNullable<ReturnType<typeof useDailyDigest>["data"]>): string {
  const o = dg.outreach;
  const lines = [
    "Update on jobs team activity. Yesterday there was:",
    `• ${o.new_touches ?? 0} outreach to new accounts`,
    `• ${o.existing_touches ?? 0} outreach to existing accounts${(o.meetings ?? 0) > 0 ? `, including ${o.meetings} meeting${o.meetings === 1 ? "" : "s"}` : ""}`,
  ];
  if (dg.submissions.length > 0) {
    const totalBuilders = dg.submissions.reduce((n, s) => n + s.builders, 0);
    const totalRoles = dg.submissions.reduce((n, s) => n + s.roles, 0);
    const companies = dg.submissions.map((s) => s.company).join(", ");
    lines.push(`• ${totalBuilders} Builder${totalBuilders === 1 ? "" : "s"} submitted to ${totalRoles} role${totalRoles === 1 ? "" : "s"} at ${companies}`);
  }
  return lines.join("\n");
}

function DailyDigestBlock() {
  const yesterday = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 1); return localISODate(d); }, []);
  const [digestDate, setDigestDate] = useState<string>(yesterday);
  const { data: dg, isLoading } = useDailyDigest(digestDate);
  const o = dg?.outreach;
  const copy = () => {
    if (!dg) return;
    navigator.clipboard.writeText(digestSlackText(dg))
      .then(() => toast.success("Digest copied — paste into Slack"))
      .catch(() => toast.error("Couldn't copy"));
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-strong bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Daily digest</span>
        <input type="date" value={digestDate} max={yesterday}
          onChange={(e) => { if (e.target.value) setDigestDate(e.target.value); }}
          className="h-6 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] text-ink-2 outline-none focus:border-accent" />
        <div className="flex-1" />
        <button type="button" onClick={copy} disabled={!dg}
          className="h-7 rounded-md border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40">
          Copy for Slack
        </button>
      </div>
      {isLoading || !o ? (
        <div className="h-14 animate-pulse rounded bg-surface-2" />
      ) : (
        <div className="flex flex-col gap-0.5 text-[13px] text-ink-2">
          <span><b className={cn("tabular-nums", (o.new_touches ?? 0) > 0 ? "text-green" : "text-ink")}>{o.new_touches ?? 0}</b> outreach to new accounts{(o.new_accounts ?? 0) > 0 ? <span className="text-ink-4"> · {o.new_accounts} accounts</span> : null}</span>
          <span><b className="tabular-nums text-ink">{o.existing_touches ?? 0}</b> outreach to existing accounts{(o.meetings ?? 0) > 0 ? <>, including <b className="tabular-nums">{o.meetings}</b> meeting{o.meetings === 1 ? "" : "s"}</> : null}<span className="text-ink-4"> · {o.existing_accounts ?? 0} accounts</span></span>
          {(dg?.submissions.length ?? 0) > 0 ? (
            <span>
              <b className="tabular-nums text-green">{dg!.submissions.reduce((n, s) => n + s.builders, 0)}</b> Builder{dg!.submissions.reduce((n, s) => n + s.builders, 0) === 1 ? "" : "s"} submitted to{" "}
              <b className="tabular-nums">{dg!.submissions.reduce((n, s) => n + s.roles, 0)}</b> role{dg!.submissions.reduce((n, s) => n + s.roles, 0) === 1 ? "" : "s"} at {dg!.submissions.map((s) => s.company).join(", ")}
            </span>
          ) : (
            <span className="text-ink-4">No builder submissions</span>
          )}
          <span className="text-[11px] text-ink-4">Builder outreach isn't tracked yet — add it to the Slack post by hand.</span>
        </div>
      )}
    </div>
  );
}

// ── Monday-meeting blocks (agenda order: coverage → this week → traction → hygiene) ──

// Start of the current Sun–Sat week (local) — same convention as Jobs Home.
const startOfWeekSunday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

/** Per-owner "this week": current assigned queue + contacts moved to Initial
 *  outreach this week — the same numbers as Jobs Home's progress strip,
 *  rolled up per person for the meeting. */
function ThisWeekBlock({ nameOf, activityPipeline, granularity, scope, owner, range }: {
  nameOf: (email: string) => string;
  activityPipeline?: ScorecardRow[];
  granularity: OutreachGranularity;
  scope: OutreachScopeKind;
  owner?: string;
  range?: OutreachDateRange;
}) {
  const { data: assignedData } = useJobsContacts({ membership_stage: "assigned", limit: 1000 });
  const { data: contactedData } = useJobsContacts({ membership_stage: "initial_outreach", limit: 1000 });
  const rows = useMemo(() => {
    const weekStart = startOfWeekSunday();
    const by = new Map<string, { assigned: number; contacted: number }>();
    const bump = (email: string | null | undefined, key: "assigned" | "contacted") => {
      const k = (email ?? "").toLowerCase() || "(unowned)";
      const r = by.get(k) ?? { assigned: 0, contacted: 0 };
      r[key] += 1;
      by.set(k, r);
    };
    for (const c of assignedData?.data ?? []) bump(c.owner_email, "assigned");
    for (const c of contactedData?.data ?? []) {
      if (c.membership_stage_entered_at && new Date(c.membership_stage_entered_at) >= weekStart) bump(c.owner_email, "contacted");
    }
    return [...by.entries()]
      .filter(([, r]) => r.assigned + r.contacted > 0)
      .sort((a, b) => (b[1].assigned + b[1].contacted) - (a[1].assigned + a[1].contacted));
  }, [assignedData, contactedData]);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <SectionHead title="This week" note="assigned queue · contacted since Sunday" />
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
        <table className="w-full text-[12.5px]">
          <thead><tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
            <th className="px-3 py-1.5 font-semibold">Owner</th>
            <th className="px-2 py-1.5 text-right font-semibold">Assigned</th>
            <th className="px-2 py-1.5 text-right font-semibold">Contacted</th>
            <th className="w-[34%] px-3 py-1.5 font-semibold">Progress</th>
          </tr></thead>
          <tbody>
            {rows.map(([email, r]) => {
              const total = r.assigned + r.contacted;
              const pct = total ? Math.round((100 * r.contacted) / total) : 0;
              return (
                <tr key={email} className="border-t border-border-strong">
                  <td className="px-3 py-1.5 font-medium text-ink">{email === "(unowned)" ? <span className="text-ink-4">Unowned</span> : nameOf(email)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">{r.assigned}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-green">{r.contacted}</td>
                  <td className="px-3 py-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full border border-border-strong bg-surface-2" title={`${r.contacted} of ${total} contacted this week`}>
                      <div className="h-full rounded-full bg-green transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Activity pipeline lives here now: it answers "what did we do this
          period", the same question as the queue above. */}
      {activityPipeline && activityPipeline.length > 0 && (
        <ScorecardTable title="Activity Pipeline" firstColHeader="Activity" rows={activityPipeline}
          idPrefix="act" drillKind="activity" granularity={granularity} scope={scope}
          owner={owner} range={range} />
      )}
    </div>
  );
}

/** Hygiene: the accountability strip + the assigned-but-no-prospect table. */
function HygieneBlock({ nameOf, staffEmails }: { nameOf: (email: string) => string; staffEmails: Set<string> }) {
  const { data: accounts = [] } = useJobsAccounts(undefined, "all");
  const [showAll, setShowAll] = useState(false);

  // Accounts someone on the jobs team owns, with nobody in the prospect list.
  const noProspect = useMemo(() => accounts
    .filter((a) => a.owner_email && staffEmails.has(a.owner_email.toLowerCase()) && a.prospect_count === 0)
    .sort((a, b) => (a.owner_email ?? "").localeCompare(b.owner_email ?? "") || a.account.localeCompare(b.account)),
    [accounts, staffEmails]);

  // Two different problems: contacts exist but nobody's been flagged into the
  // pipeline (just activate one) vs genuinely nobody on file (go find someone).
  const withPeople = useMemo(() => noProspect.filter((a) => (a.contact_count ?? 0) > 0).length, [noProspect]);
  const shown = showAll ? noProspect : noProspect.slice(0, 10);
  return (
    <div className="flex flex-col gap-3">
      <SectionHead title="Target accounts awaiting activation"
        note={`${noProspect.length} owned accounts with nobody in the prospect list — ${withPeople} have contacts on file to flag, ${noProspect.length - withPeople} have nobody yet`} />
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

/** Contacts stuck in initial outreach — 3+ touches, no reply. The cue to find a
 *  different contact at that account (replaced the account working list). */
function StuckContactsPanel({ owner }: { owner?: string }) {
  const { data = [], isLoading } = useStuckContacts(3, owner);
  // Stage editable in place: the usual next move here is On hold / Not a fit,
  // or Converted if the account came good through another contact.
  const updateMembership = useUpdateJobsMembership();
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="flex items-center gap-2 px-1 py-4 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>;
  if (data.length === 0) {
    return <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
      Nobody stuck — every contact in initial outreach has replied or is under 3 touches.
    </div>;
  }
  const shown = showAll ? data : data.slice(0, 15);
  return (
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
                  options={MEMBERSHIP_STAGE_OPTIONS}
                  onSave={(v) => new Promise<void>((resolve, reject) => {
                    if (!v || v === "initial_outreach") return resolve();
                    updateMembership.mutate({ contact_id: c.contact_id, stage: v }, {
                      onSuccess: () => {
                        toast.success(`Moved ${c.full_name ?? "contact"} to ${MEMBERSHIP_STAGE_LABELS[v as MembershipStage] ?? v}`);
                        resolve();
                      },
                      onError: reject,
                    });
                  })}
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
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function JobsOutreach() {
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  const [scope, setScope] = useState<OutreachScopeKind>("team");
  const [owner, setOwner] = useState<string>("");   // "" = whole scope
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const range: OutreachDateRange | undefined = from && to ? { from, to } : undefined;

  const { data: staff = [] } = useJobsStaff();
  const nameOf = (email: string) => staff.find((s) => s.email.toLowerCase() === email.toLowerCase())?.name || email.split("@")[0];
  const { data: sc, isLoading, isError } = useOutreachScorecard(granularity, scope, owner || undefined, range);
  const rangeLabel = useMemo(() => (sc ? fmtRange(sc.period.this_start, sc.period.this_end) : ""), [sc]);

  const Seg = <T extends string>({ items, value, onChange }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) => (
    <div className="flex rounded-lg border border-border-strong bg-surface p-1">
      {items.map((it) => (
        <button key={it.id} onClick={() => onChange(it.id)}
          className={cn("rounded-md px-3 py-1.5 text-[13px] transition-colors", value === it.id ? "bg-surface-2 font-semibold text-ink" : "text-ink-3 hover:text-ink-2")}>
          {it.label}
        </button>
      ))}
    </div>
  );

  const staffEmails = useMemo(() => new Set(staff.map((s) => s.email.toLowerCase())), [staff]);

  return (
    <div className="flex flex-col gap-6 pt-3">
      {/* ── Daily digest (the morning Slack) ── */}
      <DailyDigestBlock />

      {/* ── Monday agenda: contacts funnel → this week (+ activity pipeline)
             → stuck → target accounts → campaigns → scorecard → targeting ── */}
      <div className="flex flex-col gap-3">
        <SectionHead title="Contacts funnel" note="jobs-pipeline stages with stage-to-stage conversion" />
        <JobsFunnels only="prospects" />
      </div>

      <ThisWeekBlock nameOf={nameOf} activityPipeline={sc?.activity_pipeline}
        granularity={granularity} scope={scope} owner={owner || undefined} range={range} />

      <div className="flex flex-col gap-3">
        <SectionHead title="Stuck in initial outreach"
          note="3+ touches, no reply — time to work a different contact at the account" />
        <StuckContactsPanel owner={owner || undefined} />
      </div>

      <HygieneBlock nameOf={nameOf} staffEmails={staffEmails} />

      <div className="flex flex-col gap-3">
        <SectionHead title="Campaigns · coverage" note="the warm list, by source" />
        <TagCampaigns />
      </div>

      {/* ── Scorecard (ops deep-dive) ── */}
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-surface-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Outreach</span>
        <div className={cn(owner && "opacity-40 pointer-events-none")}>
          <Seg items={SCOPES} value={scope} onChange={setScope} />
        </div>
        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
          title="Filter to one sender (overrides scope)"
        >
          <option value="">All senders</option>
          {[...staff].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
            .map((s) => <option key={s.email} value={s.email}>{s.name || s.email}</option>)}
        </select>
        <div className="flex-1" />
        <Seg items={PERIODS} value={granularity} onChange={setGranularity} />
        <div className="flex items-center gap-1 text-[12.5px] text-ink-3">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border-strong bg-surface px-2 py-1 text-[12.5px] text-ink outline-none focus:border-accent" />
          <span>→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border-strong bg-surface px-2 py-1 text-[12.5px] text-ink outline-none focus:border-accent" />
          {range && <button onClick={() => { setFrom(""); setTo(""); }} className="ml-1 text-[12px] text-ink-3 underline hover:text-ink">clear</button>}
        </div>
      </div>

      <SectionHead title="Scorecard" note={rangeLabel ? `${rangeLabel} vs. prior period` : undefined} />

      {isError && <div className="rounded-lg border border-red-soft bg-red-soft px-4 py-3 text-[13px] text-red">Couldn't load the scorecard. Try again in a moment.</div>}
      {isLoading && !sc && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1].map((i) => <div key={i} className="h-64 animate-pulse rounded-xl border border-border-strong bg-surface-2" />)}
        </div>
      )}

      {sc && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          </div>

          {/* ── Divider: everything above = high-level review; below = per-sender/account detail ── */}
          <div className="mt-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border-strong" />
            <span className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">Sender segments and accounts</span>
            <div className="h-px flex-1 bg-border-strong" />
          </div>





          <p className="text-[11px] italic text-ink-4">
            Warm = outreach to a company Bedrock already knew before the contact's first touch; Cold = the company's first appearance.
            <strong> Lead Sourced</strong> = contacts newly assigned into the pipeline; <strong>Outreached</strong> = distinct contacts who
            received a jobs outreach email this period (activity-driven). <strong>Engagements</strong> = meetings, calls, or inbound emails
            from outside Pursuit. <strong>Direct Email Responses</strong> = external addresses that replied for the first time after we
            emailed them. <strong>Facilitated Intro</strong> = a warm intro (someone introduced us). Activity is gated to jobs-classified
            touches, so counts will rise as the nightly classifier catches up. Scope/sender filter the activity side; Qualified Lead &amp;
            Committed populate once stage-entry tracking is live.
          </p>
        </>
      )}

      {/* ── Outreach & activation over time (moved from Exec view 2026-07-30) ── */}
      <ActivityTrends />

          <SectionHead title="Targeting Mix" note={`Outreach & replies by segment${owner ? ` · ${owner.split("@")[0]}` : ""} · this period`} />
          <TargetingMix granularity={granularity} scope={scope} owner={owner || undefined} range={range} />

    </div>
  );
}
