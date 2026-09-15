/**
 * Jobs · Dashboard → Overview → Campaigns.
 *
 * A campaign is a curated contact tag from `bedrock.contact_tag_catalog`, whose
 * `sort_order` is the outreach priority and `owner_email` the accountable
 * staffer. Some campaigns span several slugs — Operation 35 is five (LT,
 * LT_Nick, Staff, Pursuit, Other) and the alumni cohorts are twelve — so the
 * picker offers the campaign, and the backend aggregates its slugs.
 *
 * Two views, one page. No campaign picked shows the portfolio: rollup stats
 * over every campaign plus the prioritised list. Picking one shows its detail:
 * activation, the stage funnel, outbound volume, the outreach trend, and the
 * event feed.
 *
 * Which numbers honour the period, because mixing the two would mislead:
 *   * Activation and the stage funnel are ALL-TIME. Activation is a state — a
 *     contact reached last March is still activated today.
 *   * Outreach volume, the trend and the activity feed honour the period bar.
 *
 * Population note: `contacts` is every tagged contact, while every funnel and
 * outreach number counts only those flagged as jobs prospects (`in_pipeline`).
 * The page labels which is which rather than quietly picking one.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
} from "recharts";
import { format } from "date-fns";
import {
  ArrowRight, Calendar, Check, ChevronDown, FileText, Linkedin, Loader2, Mail,
  MessageSquare, Phone, Plus, StickyNote,
} from "lucide-react";

import { TagCampaigns } from "@/components/jobs/TagCampaigns";
import { PeriodBar, defaultPeriod } from "@/components/jobs/PeriodBar";
import {
  useTagCampaigns, useTagCampaignStats, useTagCampaignActivity, MEMBERSHIP_STAGE_LABELS,
  type TagCampaign, type TagCampaignStats, type CampaignGranularity, type MembershipStage,
  type CampaignEvent,
} from "@/services/jobs";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const EMPTY_FUNNEL = { not_yet: 0, assigned: 0, contacted: 0, call_booked: 0, converted: 0, not_a_fit: 0, on_hold: 0 };
const EMAIL_COLOR = "#4242EA";
const MEETING_COLOR = "#C7C7F5";
const ACTIVITY_PAGE = 25;

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

/** first.last@pursuit.org → "First". Falls back to the raw value so an
 *  unrecognised actor is still identifiable rather than blank. */
function shortName(email: string | null | undefined): string {
  if (!email) return "—";
  const local = email.split("@")[0] ?? email;
  const first = local.split(/[._]/)[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1);
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

// ── Shared chrome ───────────────────────────────────────────────────────────
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

function TrendChart({ stats }: { stats: TagCampaignStats }) {
  const data = useMemo(() => stats.trend.map((p) => ({
    label: p.bucket.slice(5),   // MM-DD; the year is never in question here
    Emails: p.emails,
    Meetings: p.meetings,
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

// ── Activity feed ───────────────────────────────────────────────────────────
const TOUCH_META: Record<string, { label: string; icon: React.ReactNode }> = {
  email: { label: "Email", icon: <Mail size={11} /> },
  meeting: { label: "Meeting", icon: <Calendar size={11} /> },
  call: { label: "Call", icon: <Phone size={11} /> },
  text: { label: "Text", icon: <MessageSquare size={11} /> },
  linkedin: { label: "LinkedIn", icon: <Linkedin size={11} /> },
  note: { label: "Note", icon: <StickyNote size={11} /> },
};

/** Bulk work arrives as many identical rows — one staffer marking eight Red
 *  Canary contacts Not a fit in a sitting. Collapsing them on
 *  (day, kind, stage, actor, owner) turns a wall into one legible line, and the
 *  owner stays in the key so a collapsed row never has to show two owners. */
interface EventGroup {
  key: string;
  at: string | null;
  kind: CampaignEvent["kind"];
  subkind: string | null;
  to_stage: MembershipStage | null;
  actor: string | null;
  owner: string | null;
  owner_is_explicit: boolean;
  events: CampaignEvent[];
}

function groupEvents(events: CampaignEvent[]): EventGroup[] {
  const out: EventGroup[] = [];
  const index = new Map<string, EventGroup>();
  for (const e of events) {
    const day = e.at ? e.at.slice(0, 10) : "";
    const key = [day, e.kind, e.subkind ?? "", e.to_stage ?? "", e.actor ?? "", e.owner ?? ""].join("|");
    const existing = index.get(key);
    if (existing) { existing.events.push(e); continue; }
    const g: EventGroup = {
      key, at: e.at, kind: e.kind, subkind: e.subkind, to_stage: e.to_stage,
      actor: e.actor, owner: e.owner, owner_is_explicit: e.owner_is_explicit, events: [e],
    };
    index.set(key, g);
    out.push(g);
  }
  return out;
}

function groupLabel(g: EventGroup): { label: string; icon: React.ReactNode; color: string } {
  if (g.kind === "added") return { label: "Added", icon: <Plus size={11} />, color: "var(--accent)" };
  if (g.kind === "stage") {
    return {
      label: g.to_stage ? MEMBERSHIP_STAGE_LABELS[g.to_stage] ?? "Moved" : "Moved",
      icon: <ArrowRight size={11} />,
      color: g.to_stage === "converted_to_opportunity" ? "var(--green)"
        : g.to_stage === "not_a_fit" ? "var(--ink-3)"
        : g.to_stage === "revisit" ? "var(--amber)" : "var(--sky)",
    };
  }
  const m = TOUCH_META[g.subkind ?? ""] ?? { label: "Touch", icon: <Mail size={11} /> };
  return { ...m, color: "var(--accent)" };
}

function OwnerFilter({ owners, value, onChange }: {
  owners: { email: string; contacts: number }[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
          value ? "border-accent text-accent" : "border-border-strong text-ink-2 hover:bg-surface-2",
        )}
      >
        Owner: {value ? shortName(value) : "All"}
        <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-30 mt-1 max-h-[300px] w-[260px] overflow-y-auto rounded-lg border border-border-strong bg-surface p-1 shadow-lg">
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className={cn("flex w-full items-center rounded px-2 py-1.5 text-[12.5px] hover:bg-surface-2",
                value === null ? "font-semibold text-accent" : "text-ink")}
            >
              All owners
            </button>
            {owners.map((o) => (
              <button
                key={o.email}
                type="button"
                onClick={() => { onChange(o.email); setOpen(false); }}
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-surface-2",
                  value === o.email ? "font-semibold text-accent" : "text-ink")}
              >
                <span className="min-w-0 flex-1 truncate" title={o.email}>{o.email}</span>
                <span className="shrink-0 tabular-nums text-[11px] text-ink-4">{o.contacts}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ActivityFeed({ campaignKey, from, to }: { campaignKey: string; from: string; to: string }) {
  const [owner, setOwner] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useTagCampaignActivity(campaignKey, { from, to, owner: owner ?? undefined });
  const groups = useMemo(() => groupEvents(data?.events ?? []), [data?.events]);
  const shown = showAll ? groups : groups.slice(0, ACTIVITY_PAGE);

  return (
    <Section
      title="Activity"
      note="Every touch, stage change and addition for this campaign's contacts, newest first. Owner is who the contact belongs to; Changed by is who did it."
      action={<OwnerFilter owners={data?.owners ?? []} value={owner} onChange={setOwner} />}
    >
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-ink-3">
          <Loader2 size={14} className="animate-spin" /> Loading activity…
        </div>
      ) : groups.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border-strong px-4 py-8 text-[12px] text-ink-4">
          No activity in this period{owner ? ` for ${shortName(owner)}` : ""}.
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-border-strong pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
            <span className="w-[92px] shrink-0">Event</span>
            <span className="min-w-0 flex-1">Contact</span>
            <span className="w-[86px] shrink-0">Owner</span>
            <span className="w-[86px] shrink-0">Changed by</span>
            <span className="w-[52px] shrink-0 text-right">When</span>
          </div>
          {shown.map((g) => {
            const m = groupLabel(g);
            const n = g.events.length;
            const names = g.events.map((e) => e.contact_name ?? "—");
            const companies = Array.from(new Set(g.events.map((e) => e.company).filter(Boolean)));
            const first = g.events[0];
            return (
              <div key={g.key} className="flex items-center gap-3 border-b border-border-strong py-2 last:border-b-0">
                <span
                  className="inline-flex w-[92px] shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold"
                  style={{ color: m.color }}
                >
                  {m.icon}<span className="truncate">{m.label}</span>
                </span>
                <div className="min-w-0 flex-1 truncate" title={n > 1 ? names.join(", ") : undefined}>
                  {n === 1 ? (
                    <Link to={`/jobs/contacts/${first.contact_id}`} className="text-[13px] font-semibold text-ink hover:text-accent">
                      {first.contact_name ?? "—"}
                    </Link>
                  ) : (
                    <span className="text-[13px] font-semibold text-ink">{n} contacts</span>
                  )}
                  <span className="ml-2 text-[12px] text-ink-3">
                    {companies.slice(0, 2).join(", ") || "—"}
                    {companies.length > 2 ? ` +${companies.length - 2}` : ""}
                  </span>
                </div>
                <span
                  className="w-[86px] shrink-0 truncate text-[11px] text-ink-4"
                  title={g.owner
                    ? `${g.owner}${g.owner_is_explicit ? "" : " (inferred — no owner set on the membership)"}`
                    : "No owner"}
                >
                  {shortName(g.owner)}{g.owner && !g.owner_is_explicit ? "*" : ""}
                </span>
                <span className="w-[86px] shrink-0 truncate text-[11px] text-ink-4" title={g.actor ?? undefined}>
                  {shortName(g.actor)}
                </span>
                <span className="w-[52px] shrink-0 text-right text-[11px] text-ink-4">
                  {g.at ? format(new Date(g.at), "MMM d") : "—"}
                </span>
              </div>
            );
          })}
          <div className="mt-2 flex items-center justify-between gap-3">
            {groups.length > ACTIVITY_PAGE ? (
              <button type="button" onClick={() => setShowAll((v) => !v)}
                className="text-[12px] font-medium text-accent hover:underline">
                {showAll ? "Show less" : `Show ${groups.length - ACTIVITY_PAGE} more`}
              </button>
            ) : <span />}
            <span className="text-[11px] text-ink-4">
              * owner inferred from who first reached out or who added the contact
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}

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
  const contactPct = pct(t.activated_contacts, t.in_pipeline);
  const accountPct = pct(t.activated_accounts, t.accounts);
  const emailPct = pct(t.with_email, t.in_pipeline);
  const converted = t.stages.converted_to_opportunity ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Activation"
        note={`All-time, not period-scoped. ${t.in_pipeline.toLocaleString()} of ${t.contacts.toLocaleString()} tagged contacts are in the jobs pipeline, and everything here counts that set.${
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
        note="Outbound touches in the selected period. Synced email counts only when Pursuit sent it."
      >
        <OutreachStats stats={stats} />
      </Section>

      <Section
        title="Outreach over time"
        note={`${stats.outreach.total.toLocaleString()} touches in the period, bucketed by ${granularity}.`}
      >
        <TrendChart stats={stats} />
      </Section>

      <ActivityFeed campaignKey={campaignKey} from={from} to={to} />
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
  const [[from, to], setRange] = useState<[string, string]>(defaultPeriod);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
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
        : <Portfolio campaigns={campaigns} loading={isLoading} />}
    </div>
  );
}
