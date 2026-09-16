/**
 * Jobs · Dashboard → Overview → Campaigns.
 *
 * A campaign is a curated contact tag from `bedrock.contact_tag_catalog`, whose
 * `sort_order` is the outreach priority and `owner_email` the accountable
 * staffer. Some campaigns span several slugs — Operation 35 is five (LT,
 * LT_Nick, Staff, Pursuit, Other) and the alumni cohorts are twelve — so the
 * picker offers the campaign, and the backend aggregates its slugs.
 *
 * Two views, one page. No campaign picked shows the prioritised list of every
 * campaign. Picking one shows its detail: activation, the stage funnel,
 * outbound volume, the outreach trend, and the event feed.
 *
 * Which numbers honour the period, because mixing the two would mislead:
 *   * Activation and the stage funnel are ALL-TIME. Activation is a state — a
 *     contact reached last March is still activated today, and period-scoping
 *     it would read as contacts un-activating when you step the window back.
 *   * Outreach volume, the trend and the activity feed honour the period bar.
 *
 * Population note: `contacts` is every tagged contact, while every funnel and
 * outreach number counts only those flagged as jobs prospects (`in_pipeline`).
 * The page labels which is which rather than quietly picking one.
 */
import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
} from "recharts";
import { Calendar, Check, ChevronDown, Linkedin, Loader2, Mail, MessageSquare } from "lucide-react";

import { TagCampaigns } from "@/components/jobs/TagCampaigns";
import { PeriodBar, PERIOD_PRESETS } from "@/components/jobs/PeriodBar";
import { ActivityFeed } from "@/components/jobs/ActivityFeed";
import {
  useTagCampaigns, useTagCampaignStats, useTagCampaignActivity,
  type TagCampaign, type TagCampaignStats, type CampaignGranularity, type MembershipStage,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

const EMAIL_COLOR = "#4242EA";
const CALL_COLOR = "#14b8a6";

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
/** Single-select over campaigns, with "All campaigns" as the reset. The list
 *  rows still carry their counts — sizing a push before you open it is worth a
 *  line there — but the closed control shows the name alone, so it stays one
 *  line tall and matches the period bar beside it. */
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
        // h-full + the parent's items-stretch is what keeps this the same
        // height as the period bar beside it. One line of content, so it never
        // drives the row taller than the bar does.
        className={cn(
          "flex h-full min-w-[260px] items-center gap-2 rounded-xl border bg-surface-2 px-3 py-2 text-left transition-colors",
          open ? "border-accent ring-1 ring-accent/30" : "border-border-strong hover:bg-surface-2/60",
        )}
      >
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Campaign</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {loading ? "Loading…" : current ? current.label : "All campaigns"}
        </span>
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

// ── Shared chrome ───────────────────────────────────────────────────────────
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

/** One activation figure: accounts over contacts, separated by a rule and each
 *  with its own share bar. The two numbers used to sit flush on top of each
 *  other, which read as one broken number rather than two related ones. */
function ActivationGroup({ label, hint, tone, rows }: {
  label: string;
  hint?: string;
  tone: "accent" | "green";
  rows: { n: number; of?: number; unit: string }[];
}) {
  const bar = { accent: "bg-accent", green: "bg-green" }[tone];
  const ink = { accent: "text-accent", green: "text-green" }[tone];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-strong bg-surface px-5 py-4" title={hint}>
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <div className="flex flex-col gap-3.5">
        {rows.map((r, i) => {
          const p = r.of !== undefined ? pct(r.n, r.of) : null;
          return (
            <div key={r.unit} className={cn("flex flex-col gap-1.5", i > 0 && "border-t border-border-strong/70 pt-3.5")}>
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{r.unit}</span>
              {p !== null ? (
                <div className="flex items-center gap-2.5">
                  {/* Bar is deliberately capped rather than flex-1: the counts
                      beside it are the reading, and a full-width bar pushed
                      them off the card at this width. */}
                  <div className="h-1.5 w-[84px] shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <div className={cn("h-full rounded-full", bar)} style={{ width: `${p}%` }} />
                  </div>
                  <span className="w-9 shrink-0 text-[12px] font-medium tabular-nums text-ink-3">{p}%</span>
                  <span className="flex items-baseline gap-1 whitespace-nowrap">
                    <span className={cn("text-[20px] font-semibold leading-none tabular-nums", ink)}>
                      {r.n.toLocaleString()}
                    </span>
                    <span className="text-[12px] tabular-nums text-ink-4">/ {(r.of as number).toLocaleString()}</span>
                  </span>
                </div>
              ) : (
                <span className={cn("text-[22px] font-semibold leading-none tabular-nums", ink)}>
                  {r.n.toLocaleString()}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Stage funnel bar ────────────────────────────────────────────────────────
/** Half again as tall as it was, with the count rendered inside each band and
 *  the labels moved to a legend below. Labels used to sit beside the numbers in
 *  the legend row and wrapped into each other at this width. */
function StageBar({ stats }: { stats: TagCampaignStats }) {
  const st = stats.totals.stages;
  const parts = [
    ...STAGE_ORDER.map((s) => ({ label: s.label, cls: s.cls, n: st[s.key] ?? 0 })),
    { label: "No stage", cls: "bg-stone-300", n: stats.totals.no_stage },
  ];
  const denom = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex h-6 w-full overflow-hidden rounded-lg bg-surface-2"
        title={parts.map((p) => `${p.label}: ${p.n.toLocaleString()}`).join("  ·  ")}
      >
        {parts.map((p) => {
          const share = (100 * p.n) / denom;
          return p.n > 0 && (
            <div
              key={p.label}
              className={cn("flex h-full items-center justify-center", p.cls)}
              style={{ width: `${share}%` }}
            >
              {/* Below ~4% the band is narrower than two digits, so the number
                  would clip rather than inform. The legend still carries it. */}
              {share >= 4 ? (
                <span className="px-1 text-[11px] font-semibold tabular-nums text-white drop-shadow-sm">
                  {p.n.toLocaleString()}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-sm", p.cls)} />
            <span className="whitespace-nowrap">{p.label}</span>
            <span className="font-semibold tabular-nums text-ink-2">{p.n.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Outreach volume ─────────────────────────────────────────────────────────
const CHANNELS: { key: keyof TagCampaignStats["outreach"]; label: string; Icon: typeof Mail }[] = [
  { key: "emails", label: "Emails sent", Icon: Mail },
  { key: "calls_booked", label: "Calls booked", Icon: Calendar },
  { key: "linkedin", label: "LinkedIn", Icon: Linkedin },
  { key: "texts", label: "Texts", Icon: MessageSquare },
];

function OutreachStats({ stats }: { stats: TagCampaignStats }) {
  const o = stats.outreach;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
    </div>
  );
}

function TrendChart({ stats }: { stats: TagCampaignStats }) {
  const data = useMemo(() => stats.trend.map((p) => ({
    label: p.bucket.slice(5),   // MM-DD; the year is never in question here
    Emails: p.emails,
    "Calls booked": p.calls_booked,
  })), [stats.trend]);

  if (stats.trend.every((p) => p.total === 0)) {
    return (
      <div className="grid h-[200px] place-items-center rounded-lg border border-dashed border-border-strong text-[12.5px] text-ink-3">
        No outreach to this campaign in the selected period.
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
          <Line type="monotone" dataKey="Calls booked" stroke={CALL_COLOR} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap items-center gap-4 pl-1">
        <Legend color={EMAIL_COLOR} label="Emails sent" />
        <Legend color={CALL_COLOR} label="Calls booked" />
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

/** The campaign's own feed: tag-scoped, with its owner filter wired to the
 *  endpoint so filtering reaches past the row cap rather than just the page. */
function CampaignActivity({ campaignKey, from, to }: {
  campaignKey: string; from: string; to: string;
}) {
  const [owner, setOwner] = useState<string | null>(null);
  const { data, isLoading } = useTagCampaignActivity(campaignKey, { from, to, owner: owner ?? undefined });
  return (
    <ActivityFeed
      events={data?.events ?? []}
      owners={data?.owners ?? []}
      isLoading={isLoading}
      owner={owner}
      onOwner={setOwner}
    />
  );
}

// ── Campaign detail ─────────────────────────────────────────────────────────
function CampaignDetail({ campaignKey, from, to, granularity }: {
  campaignKey: string;
  from: string;
  to: string;
  granularity: CampaignGranularity;
}) {
  const { data: stats, isLoading, isError } = useTagCampaignStats(campaignKey, { granularity, from, to });

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
  const converted = t.stages.converted_to_opportunity ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Section title="Activation">
        <div className="grid gap-3 md:grid-cols-2">
          <ActivationGroup
            label="Activated"
            tone="accent"
            hint="At least one outbound touch from Pursuit — email, call booked, text or LinkedIn."
            rows={[
              { n: t.activated_accounts, of: t.accounts, unit: "accounts" },
              { n: t.activated_contacts, of: t.in_pipeline, unit: "contacts" },
            ]}
          />
          <ActivationGroup
            label="Converted to oppty"
            tone="green"
            hint="Contacts whose membership reached converted_to_opportunity."
            rows={[{ n: converted, unit: "converted" }]}
          />
        </div>
        <div className="mt-5">
          <StageBar stats={stats} />
        </div>
      </Section>

      <Section title="Outreach">
        <OutreachStats stats={stats} />
      </Section>

      <Section title="Outreach trends">
        <TrendChart stats={stats} />
      </Section>

      <CampaignActivity campaignKey={campaignKey} from={from} to={to} />
    </div>
  );
}

// ── Portfolio (no campaign picked) ──────────────────────────────────────────
/** Just the prioritised list. The rollup cards that used to sit above it
 *  (campaigns · in pipeline · reached · converted) were removed on 2026-09-16:
 *  they averaged over campaigns with nothing in common, so the one number that
 *  matters — how a given push is doing — was always a click away anyway. */
function Portfolio() {
  return <TagCampaigns />;
}

/** A month of dates in daily buckets — roughly 30 points, which is what makes
 *  the trend readable as a trend. The Daily preset (yesterday alone) would draw
 *  a single dot, and Weekly buckets over a month draws four. */
function campaignDefaultPeriod(): [string, string] {
  return PERIOD_PRESETS[2].get();
}

export function JobsCampaigns() {
  const { data: campaigns = [], isLoading } = useTagCampaigns();
  const [selected, setSelected] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<CampaignGranularity>("day");
  const [[from, to], setRange] = useState<[string, string]>(campaignDefaultPeriod);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-stretch gap-3">
        <CampaignSelect campaigns={campaigns} value={selected} onChange={setSelected} loading={isLoading} />
        {/* The period only drives the detail view — the portfolio rollup is an
            all-time snapshot, so showing a date range over it would lie. */}
        {selected ? (
          <div className="min-w-0 flex-1">
            <PeriodBar
              from={from}
              to={to}
              onChange={(f, t) => setRange([f, t])}
              granularity={granularity}
              onGranularityChange={setGranularity}
              clampToToday
            />
          </div>
        ) : null}
      </div>
      {selected
        ? <CampaignDetail campaignKey={selected} from={from} to={to} granularity={granularity} />
        : <Portfolio />}
    </div>
  );
}
