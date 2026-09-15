/**
 * Jobs · Dashboard → Campaigns.
 *
 * A campaign is a curated contact tag from `bedrock.contact_tag_catalog`, whose
 * `sort_order` is the outreach priority and `owner_email` the accountable
 * staffer. Some campaigns span several slugs — Operation 35 is five (LT,
 * LT_Nick, Staff, Pursuit, Other) and the alumni cohorts are twelve — so the
 * picker offers the campaign, and the backend aggregates its slugs.
 *
 * Two views, one page. No campaign picked shows the portfolio: rollup stats
 * over every campaign plus the prioritised list. Picking one shows its detail:
 * activation against the whole tagged set, the stage funnel, outbound volume by
 * channel, and the outreach trend.
 *
 * Population note, because these two numbers differ and the gap matters:
 * `contacts` is every tagged contact, while every funnel and outreach number
 * counts only those flagged as jobs prospects (`in_pipeline`). The page labels
 * which is which rather than quietly picking one.
 */
import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
} from "recharts";
import { Check, ChevronDown, Loader2, Mail, Calendar, Phone, Linkedin, MessageSquare, FileText } from "lucide-react";

import { TagCampaigns } from "@/components/jobs/TagCampaigns";
import {
  useTagCampaigns, useTagCampaignStats,
  type TagCampaign, type TagCampaignStats, type CampaignGranularity, type MembershipStage,
} from "@/services/jobs";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const EMPTY_FUNNEL = { not_yet: 0, assigned: 0, contacted: 0, call_booked: 0, converted: 0, not_a_fit: 0, on_hold: 0 };
const EMAIL_COLOR = "#4242EA";
const MEETING_COLOR = "#C7C7F5";

/** Funnel order, worked-first, shared by the stage bar and its legend so the
 *  two can never drift. `on_hold` is absent by design: the backend folds it
 *  into `revisit`, matching canon_membership_stage(). */
const STAGE_ORDER: { key: MembershipStage; label: string; cls: string }[] = [
  { key: "converted_to_opportunity", label: "Converted", cls: "bg-green-500" },
  { key: "call_booked", label: "Call booked", cls: "bg-teal-500" },
  { key: "initial_outreach", label: "Contacted", cls: "bg-accent" },
  { key: "revisit", label: "Revisit", cls: "bg-amber-400" },
  { key: "not_a_fit", label: "Not a fit", cls: "bg-rose-300" },
  { key: "assigned", label: "Assigned", cls: "bg-sky-400" },
];

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((100 * n) / d) : null;
}

// ── Campaign picker ─────────────────────────────────────────────────────────
/** Single-select over campaigns, with "All campaigns" as the reset. Each row
 *  carries its in-pipeline count, so you can tell a 449-contact push from a
 *  4-contact one before committing to the click. */
function CampaignSelect({ campaigns, value, onChange, loading }: {
  campaigns: TagCampaign[];
  value: string | null;
  onChange: (key: string | null) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = campaigns.find((c) => c.key === value);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "flex min-w-[260px] items-center gap-2 rounded-xl border bg-surface px-4 py-2.5 text-left transition-colors",
          open ? "border-accent ring-1 ring-accent/30" : "border-border-strong hover:bg-surface-2/60",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Campaign</div>
          <div className="truncate text-[15px] font-semibold text-ink">
            {loading ? "Loading…" : current ? current.label : "All campaigns"}
          </div>
        </div>
        {current ? (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium tabular-nums text-ink-3">
            {current.in_pipeline.toLocaleString()}
          </span>
        ) : null}
        <ChevronDown size={15} className={cn("shrink-0 text-ink-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <>
          {/* Backdrop closes on any outside click, same pattern as the
              campaign filter inside TagCampaigns. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            className="absolute left-0 z-30 mt-1.5 max-h-[380px] w-[340px] overflow-y-auto rounded-xl border border-border-strong bg-surface p-1.5 shadow-xl"
          >
            <Option
              label="All campaigns"
              sub={`${campaigns.length} campaigns`}
              selected={value === null}
              onClick={() => { onChange(null); setOpen(false); }}
            />
            <div className="my-1 border-t border-border-strong" />
            {campaigns.map((c) => (
              <Option
                key={c.key}
                label={c.label}
                sub={`${c.in_pipeline.toLocaleString()} in pipeline · ${c.accounts.toLocaleString()} accounts${
                  c.slugs.length > 1 ? ` · ${c.slugs.length} tags` : ""
                }`}
                selected={value === c.key}
                onClick={() => { onChange(c.key); setOpen(false); }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Option({ label, sub, selected, onClick }: {
  label: string; sub: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-accent/10" : "hover:bg-surface-2",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-[13px]", selected ? "font-semibold text-accent" : "font-medium text-ink")}>
          {label}
        </div>
        <div className="truncate text-[11px] text-ink-4">{sub}</div>
      </div>
      {selected ? <Check size={14} className="shrink-0 text-accent" /> : null}
    </button>
  );
}

// ── Stat tile ───────────────────────────────────────────────────────────────
function Stat({ label, value, sub, tone = "ink", hint }: {
  label: string; value: string; sub?: string;
  tone?: "ink" | "accent" | "green" | "amber"; hint?: string;
}) {
  const toneCls = { ink: "text-ink", accent: "text-accent", green: "text-green", amber: "text-amber" }[tone];
  return (
    <div className="flex flex-col items-start gap-1 rounded-xl border border-border-strong bg-surface px-4 py-3" title={hint}>
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className={cn("text-[26px] font-semibold leading-none tabular-nums", toneCls)}>{value}</span>
      {sub ? <span className="text-[11px] leading-snug text-ink-3">{sub}</span> : null}
    </div>
  );
}

function Section({ title, note, action, children }: {
  title: string; note?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border-strong bg-surface px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
          {note ? <p className="mt-0.5 text-[11.5px] text-ink-3">{note}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Campaign detail ─────────────────────────────────────────────────────────
function StageBar({ stats }: { stats: TagCampaignStats }) {
  const st = stats.totals.stages;
  const parts = [
    ...STAGE_ORDER.map((s) => ({ label: s.label, cls: s.cls, n: st[s.key] ?? 0 })),
    { label: "No stage", cls: "bg-stone-300", n: stats.totals.no_stage },
  ];
  const denom = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div className="flex flex-col gap-2.5">
      <div
        className="flex h-4 w-full overflow-hidden rounded-full bg-surface-2"
        title={parts.map((p) => `${p.label}: ${p.n.toLocaleString()}`).join("  ·  ")}
      >
        {parts.map((p) => p.n > 0 && (
          <div key={p.label} className={cn("h-full", p.cls)} style={{ width: `${(100 * p.n) / denom}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", p.cls)} />
            {p.label}
            <span className="font-semibold tabular-nums text-ink-2">{p.n.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const CHANNELS: { key: keyof TagCampaignStats["outreach"]; label: string; Icon: typeof Mail }[] = [
  { key: "emails", label: "Emails sent", Icon: Mail },
  { key: "meetings", label: "Meetings", Icon: Calendar },
  { key: "calls", label: "Calls logged", Icon: Phone },
  { key: "linkedin", label: "LinkedIn", Icon: Linkedin },
  { key: "texts", label: "Texts", Icon: MessageSquare },
  { key: "notes", label: "Notes", Icon: FileText },
];

function OutreachStats({ stats }: { stats: TagCampaignStats }) {
  const o = stats.outreach;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {CHANNELS.map(({ key, label, Icon }) => (
          <div key={key} className="flex flex-col gap-1 rounded-lg border border-border-strong bg-surface-2/40 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
              <Icon size={11} />{label}
            </span>
            <span className="text-[20px] font-semibold leading-none tabular-nums text-ink">
              {(o[key] as number).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-ink-3">
        <span>
          <span className="font-semibold tabular-nums text-ink-2">{o.contacts_reached.toLocaleString()}</span> contacts reached
        </span>
        <span>
          <span className="font-semibold tabular-nums text-ink-2">{o.accounts_reached.toLocaleString()}</span> accounts reached
        </span>
        <span>Last touch {o.last_touch ? relDay(o.last_touch) : "—"}</span>
      </div>
    </div>
  );
}

const GRANULARITIES: { key: CampaignGranularity; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

function TrendChart({ stats }: { stats: TagCampaignStats }) {
  const data = useMemo(() => stats.trend.map((p) => ({
    label: p.bucket.slice(5),   // MM-DD; the year is never in question here
    Emails: p.emails,
    Meetings: p.meetings,
    total: p.total,
  })), [stats.trend]);

  const empty = stats.trend.every((p) => p.total === 0);
  if (empty) {
    return (
      <div className="grid h-[200px] place-items-center rounded-lg border border-dashed border-border-strong text-[12.5px] text-ink-3">
        No outreach to this campaign in the selected window.
      </div>
    );
  }
  return (
    <>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" />
          <YAxis tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" allowDecimals={false} />
          <ReTooltip
            cursor={{ stroke: "var(--color-border)" }}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }}
          />
          <Line type="monotone" dataKey="Emails" stroke={EMAIL_COLOR} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
          <Line type="monotone" dataKey="Meetings" stroke={MEETING_COLOR} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap items-center gap-4 pl-1">
        <Legend color={EMAIL_COLOR} label="Emails sent" />
        <Legend color={MEETING_COLOR} label="Meetings" />
      </div>
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function CampaignDetail({ campaignKey, granularity, onGranularity }: {
  campaignKey: string;
  granularity: CampaignGranularity;
  onGranularity: (g: CampaignGranularity) => void;
}) {
  const { data: stats, isLoading, isError } = useTagCampaignStats(campaignKey, { granularity });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border-strong bg-surface px-5 py-8 text-[13px] text-ink-3">
        <Loader2 size={15} className="animate-spin" /> Loading campaign…
      </div>
    );
  }
  if (isError || !stats) {
    return (
      <div className="rounded-2xl border border-border-strong bg-surface px-5 py-8 text-[13px] text-ink-3">
        Couldn't load this campaign.
      </div>
    );
  }

  const t = stats.totals;
  const contactPct = pct(t.activated_contacts, t.in_pipeline);
  const accountPct = pct(t.activated_accounts, t.accounts);
  const emailPct = pct(t.with_email, t.in_pipeline);
  const converted = t.stages.converted_to_opportunity ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Activation"
        note={`${t.in_pipeline.toLocaleString()} of ${t.contacts.toLocaleString()} tagged contacts are in the jobs pipeline. Everything below counts that set.${
          stats.slugs.length > 1 ? ` Aggregated across ${stats.slugs.length} tags.` : ""
        }`}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Contacts activated"
            value={t.activated_contacts.toLocaleString()}
            sub={contactPct === null ? "none in pipeline" : `${contactPct}% of ${t.in_pipeline.toLocaleString()} in pipeline`}
            tone="accent"
            hint="Contacts with at least one outbound touch from Pursuit — email, meeting, call, text or LinkedIn."
          />
          <Stat
            label="Accounts activated"
            value={t.activated_accounts.toLocaleString()}
            sub={accountPct === null ? "no accounts" : `${accountPct}% of ${t.accounts.toLocaleString()} accounts`}
            tone="accent"
            hint="Distinct companies where at least one campaign contact has been touched."
          />
          <Stat
            label="Converted to oppty"
            value={converted.toLocaleString()}
            sub={`${t.worked.toLocaleString()} contacts worked past assigned`}
            tone={converted > 0 ? "green" : "ink"}
          />
          <Stat
            label="Reachable by email"
            value={t.with_email.toLocaleString()}
            sub={emailPct === null ? "—" : `${emailPct}% have an email on file`}
            tone={emailPct !== null && emailPct < 50 ? "amber" : "ink"}
            hint="Contacts with an email address. The rest cannot be emailed at all until the record is enriched."
          />
        </div>
        <div className="mt-4">
          <StageBar stats={stats} />
        </div>
      </Section>

      <Section
        title="Outreach"
        note={`Outbound touches between ${stats.period.from} and ${stats.period.to}. Synced email counts only when Pursuit sent it.`}
      >
        <OutreachStats stats={stats} />
      </Section>

      <Section
        title="Outreach over time"
        note={`${stats.outreach.total.toLocaleString()} touches in the window, by ${granularity}.`}
        action={
          <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-2 p-1">
            {GRANULARITIES.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => onGranularity(g.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                  granularity === g.key ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
        }
      >
        <TrendChart stats={stats} />
      </Section>
    </div>
  );
}

// ── Portfolio (no campaign picked) ──────────────────────────────────────────
function rollup(camps: TagCampaign[]) {
  let inPipeline = 0, contacted = 0, converted = 0, unworked = 0;
  for (const c of camps) {
    const f = c.funnel ?? EMPTY_FUNNEL;
    inPipeline += c.in_pipeline ?? 0;
    contacted += (f.contacted ?? 0) + (f.call_booked ?? 0);
    converted += f.converted ?? 0;
    unworked += (f.not_yet ?? 0) + (f.assigned ?? 0);
  }
  const reached = contacted + converted;
  return {
    campaigns: camps.length, inPipeline, converted, unworked, reached,
    conversionPct: reached >= 5 ? Math.round((100 * converted) / reached) : null,
    coveragePct: pct(reached, inPipeline),
    unowned: camps.filter((c) => !c.owner_email).length,
  };
}

function Portfolio({ campaigns, loading }: { campaigns: TagCampaign[]; loading: boolean }) {
  const r = useMemo(() => rollup(campaigns), [campaigns]);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Campaigns"
          value={loading ? "—" : r.campaigns.toLocaleString()}
          sub={r.unowned > 0 ? `${r.unowned} with no owner` : "all owned"}
          tone={r.unowned > 0 ? "amber" : "ink"}
        />
        <Stat label="In pipeline" value={loading ? "—" : r.inPipeline.toLocaleString()} sub="tagged contacts flagged as jobs prospects" />
        <Stat
          label="Reached"
          value={loading ? "—" : r.reached.toLocaleString()}
          sub={r.coveragePct === null ? "no contacts in pipeline" : `${r.coveragePct}% of the pipeline · ${r.unworked.toLocaleString()} not yet contacted`}
          tone="accent"
        />
        <Stat
          label="Converted"
          value={loading ? "—" : r.converted.toLocaleString()}
          sub={r.conversionPct === null ? "too few reached to rate" : `${r.conversionPct}% of those reached`}
          tone={r.converted > 0 ? "green" : "ink"}
        />
      </div>
      <TagCampaigns />
    </div>
  );
}

export function JobsCampaigns() {
  const { data: campaigns = [], isLoading } = useTagCampaigns();
  const [selected, setSelected] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<CampaignGranularity>("week");

  return (
    <div className="flex flex-col gap-5">
      <CampaignSelect campaigns={campaigns} value={selected} onChange={setSelected} loading={isLoading} />
      {selected
        ? <CampaignDetail campaignKey={selected} granularity={granularity} onGranularity={setGranularity} />
        : <Portfolio campaigns={campaigns} loading={isLoading} />}
    </div>
  );
}
