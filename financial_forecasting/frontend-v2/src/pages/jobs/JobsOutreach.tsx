import { Fragment, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Loader2, Search, Users } from "lucide-react";

import {
  useOutreachScorecard,
  useOutreachDrill,
  useOutreachTargetingMix,
  useOutreachAccounts,
  useJobsStaff,
  type OutreachGranularity,
  type OutreachScopeKind,
  type OutreachDateRange,
  type OutreachScorecard,
  type ScorecardRow,
  type ScorecardCell,
  type TargetingDim,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

const DRILL_PAGE = 25;
const ACCOUNTS_PAGE = 10;

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

// ── Conversion Figures + Origin Comparison (computed from the scorecard) ──────
function byKey(rows: ScorecardRow[], k: "stage" | "metric") {
  const m: Record<string, ScorecardRow> = {};
  for (const r of rows) { const key = r[k]; if (key) m[key] = r; }
  return m;
}
const EMPTY: ScorecardCell = { warm: 0, cold: 0, total: 0 };

function ConversionTables({ sc }: { sc: OutreachScorecard }) {
  const u = byKey(sc.user_pipeline, "stage");
  const a = byKey(sc.activity_pipeline, "metric");
  const leads = u.assigned ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  const out = u.initial_outreach ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  const comm = u.converted_to_opportunity ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  const email = a.direct_email_sent ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  const resp = a.direct_email_response ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  const eng = a.engagement ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  const li = a.linkedin_message_sent ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  const intro = a.facilitated_intro_sent ?? { this_period: EMPTY, last_period: EMPTY } as ScorecardRow;
  // All outreach sent (level 1 of the funnel) = email + linkedin + facilitated intro.
  const sentTotal = (w: "this_period" | "last_period") => email[w].total + li[w].total + intro[w].total;
  const engRate = (w: "this_period" | "last_period") => { const d = sentTotal(w); return d ? eng[w].total / d : null; };

  const ratio = (numRow: ScorecardRow, denRow: ScorecardRow, when: "this_period" | "last_period") => {
    const d = denRow[when].total; return d ? numRow[when].total / d : null;
  };
  const convRows = [
    { label: "Leads → Outreached", n: out, d: leads },
    { label: "Outreached → Converted", n: comm, d: out },
    { label: "Leads → Converted (Overall)", n: comm, d: leads, overall: true },
  ];

  const RatioTable = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
      <div className="border-b border-border-strong bg-surface-2 px-4 py-2.5 text-[12.5px] font-bold text-ink-2">{title}</div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="px-3.5 py-2 text-left font-bold">Ratio</th>
            <th className="px-3.5 py-2 text-right font-bold">This</th>
            <th className="px-3.5 py-2 text-right font-bold">Last</th>
            <th className="px-3.5 py-2 text-right font-bold">Trend</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
  const fmt = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <RatioTable title="User Pipeline">
        {convRows.map((r, i) => {
          const t = ratio(r.n, r.d, "this_period"), l = ratio(r.n, r.d, "last_period");
          return (
            <tr key={i} className={cn("text-[13px] border-t border-border", r.overall && "font-bold bg-surface-2")}>
              <td className="px-3.5 py-2 text-left">{r.label}</td>
              <td className="px-3.5 py-2 text-right tabular-nums">{fmt(t)}</td>
              <td className="px-3.5 py-2 text-right tabular-nums">{fmt(l)}</td>
              <td className="px-3.5 py-2 text-right text-[12px]">{t != null && l != null ? <Trend current={t} prior={l} unit="pt" /> : <span className="text-ink-4">—</span>}</td>
            </tr>
          );
        })}
      </RatioTable>
      <RatioTable title="Activity">
        {(() => {
          const rows = [
            { label: "Engagements / Touches Sent", t: engRate("this_period"), l: engRate("last_period") },
            { label: "Direct Email Responses / Emails Sent", t: ratio(resp, email, "this_period"), l: ratio(resp, email, "last_period") },
          ];
          return rows.map((r, i) => (
            <tr key={i} className="text-[13px] border-t border-border">
              <td className="px-3.5 py-2 text-left">{r.label}</td>
              <td className="px-3.5 py-2 text-right tabular-nums">{fmt(r.t)}</td>
              <td className="px-3.5 py-2 text-right tabular-nums">{fmt(r.l)}</td>
              <td className="px-3.5 py-2 text-right text-[12px]">{r.t != null && r.l != null ? <Trend current={r.t} prior={r.l} unit="pt" /> : <span className="text-ink-4">—</span>}</td>
            </tr>
          ));
        })()}
      </RatioTable>
    </div>
  );
}

function OriginComparison({ sc }: { sc: OutreachScorecard }) {
  const u = byKey(sc.user_pipeline, "stage");
  const a = byKey(sc.activity_pipeline, "metric");
  const assigned = (u.assigned ?? { this_period: EMPTY } as ScorecardRow).this_period;
  const email = (a.direct_email_sent ?? { this_period: EMPTY } as ScorecardRow).this_period;
  const resp = (a.direct_email_response ?? { this_period: EMPTY } as ScorecardRow).this_period;
  const conv = (u.converted_to_opportunity ?? { this_period: EMPTY } as ScorecardRow).this_period;

  const rate = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : "—");
  const rows: { l: string; warm: string; cold: string }[] = [
    { l: "Sourced", warm: String(assigned.warm), cold: String(assigned.cold) },
    { l: "Sent", warm: String(email.warm), cold: String(email.cold) },
    { l: "Response rate", warm: rate(resp.warm, email.warm), cold: rate(resp.cold, email.cold) },
    { l: "Conv. rate", warm: rate(conv.warm, assigned.warm), cold: rate(conv.cold, assigned.cold) },
  ];

  // One stacked bar: share of sends that are warm vs cold.
  const totalSent = email.warm + email.cold;
  const warmShare = totalSent ? (email.warm / totalSent) * 100 : 0;
  const coldShare = 100 - warmShare;

  return (
    <div className="rounded-xl border border-border-strong bg-surface p-4">
      {/* Single stacked warm/cold bar */}
      <div className="mx-auto flex h-8 w-[72%] overflow-hidden rounded-lg bg-surface-2">
        {warmShare > 0 && (
          <div className="flex h-full items-center justify-center overflow-hidden whitespace-nowrap bg-amber text-[12px] font-bold text-white" style={{ width: `${warmShare}%` }}>
            {warmShare >= 8 && `${Math.round(warmShare)}%`}
          </div>
        )}
        {coldShare > 0 && (
          <div className="flex h-full items-center justify-center overflow-hidden whitespace-nowrap bg-ink-3 text-[12px] font-bold text-white" style={{ width: `${coldShare}%` }}>
            {coldShare >= 8 && `${Math.round(coldShare)}%`}
          </div>
        )}
      </div>

      {/* Origin details table */}
      <div className="mt-4">
        <div className="grid grid-cols-[1fr_11rem_11rem_1fr] items-center gap-x-6 border-b border-border pb-2">
          <span className="text-[13px] font-bold text-ink">Origin Details</span>
          <span className="flex items-center justify-center gap-1.5 text-center text-[12px] text-ink-2"><span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm bg-amber" />Existing Relationship</span>
          <span className="flex items-center justify-center gap-1.5 text-center text-[12px] text-ink-2"><span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm bg-ink-3" />No Relationship</span>
          <span />
        </div>
        {rows.map((r) => (
          <div key={r.l} className="grid grid-cols-[1fr_11rem_11rem_1fr] items-center gap-x-6 border-b border-border py-2 last:border-b-0">
            <span className="text-[13px] text-ink-2">{r.l}</span>
            <span className="text-center text-[13.5px] font-semibold tabular-nums text-ink">{r.warm}</span>
            <span className="text-center text-[13.5px] font-semibold tabular-nums text-ink">{r.cold}</span>
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

function BySenderTable({ sc, selectedOwner, onPick, nameOf }: {
  sc: OutreachScorecard;
  selectedOwner: string;
  onPick: (email: string) => void;
  nameOf: (email: string) => string;
}) {
  if (sc.by_sender.length === 0) return <div className="rounded-xl border border-border-strong bg-surface px-4 py-6 text-center text-[13px] text-ink-4">No sends by this group in the period.</div>;
  return (
    <div className="overflow-hidden rounded-xl border border-border-strong bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="px-3.5 py-2.5 text-left font-bold">Staff</th>
            <th className="px-3.5 py-2.5 text-right font-bold">Sent</th>
            <th className="px-3.5 py-2.5 text-right font-bold">Trend</th>
            <th className="px-3.5 py-2.5 text-left font-bold">Warm / Cold split</th>
          </tr>
        </thead>
        <tbody>
          {sc.by_sender.map((s) => {
            const total = s.warm + s.cold;
            const wp = total ? (s.warm / total) * 100 : 0;
            const active = selectedOwner === s.staff;
            return (
              <tr
                key={s.staff}
                onClick={() => onPick(active ? "" : s.staff)}
                title={active ? "Click to clear the sender filter" : "Click to filter the whole deep-dive to this sender"}
                className={cn("cursor-pointer border-t border-border text-[13.5px] hover:bg-surface-2",
                  active && "bg-accent-soft")}
              >
                <td className="px-3.5 py-2.5 text-left font-medium">
                  {nameOf(s.staff)}
                  {active && <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-ink">filtering</span>}
                </td>
                <td className="px-3.5 py-2.5 text-right tabular-nums">{s.sent.this}</td>
                <td className="px-3.5 py-2.5 text-right text-[12.5px]"><Trend current={s.sent.this} prior={s.sent.last} /></td>
                <td className="px-3.5 py-2.5 text-left">
                  <div className="flex items-center gap-2 text-[12px] text-ink-3">
                    <div className="flex h-1.5 w-16 overflow-hidden rounded bg-surface-2">
                      <div className="h-full bg-amber" style={{ width: `${wp}%` }} />
                      <div className="h-full bg-ink-3" style={{ width: `${100 - wp}%` }} />
                    </div>
                    {s.warm} / {s.cold}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="border-t border-border bg-surface-2 px-3.5 py-1.5 text-[11px] text-ink-4">
        Click a row to filter everything below to that sender.
      </div>
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

// ── Account working list (comments + open tasks per account) ──────────────────
function AccountsPanel({ owner }: { owner?: string }) {
  const { data, isLoading } = useOutreachAccounts(owner);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl border border-border-strong bg-surface-2" />;
  const accounts = data?.accounts ?? [];
  const fmtD = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

  const filtered = q.trim()
    ? accounts.filter((a) => a.account.toLowerCase().includes(q.trim().toLowerCase()))
    : accounts;
  const shown = showAll ? filtered : filtered.slice(0, ACCOUNTS_PAGE);

  const searchBar = (
    <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
      <Search size={14} className="text-ink-4" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setShowAll(true); }}
        placeholder="Search accounts…"
        className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
      />
      {q && <button onClick={() => setQ("")} className="text-[11.5px] text-ink-4 hover:text-ink">clear</button>}
    </div>
  );

  if (accounts.length === 0) return <div className="rounded-xl border border-border-strong bg-surface px-4 py-6 text-center text-[13px] text-ink-4">{owner ? `No accounts with notes or open tasks for ${owner.split("@")[0]} yet.` : "No accounts with comments or open tasks yet."}</div>;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
      {searchBar}
      {shown.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-ink-4">No accounts match “{q}”.</div>}
      {shown.map((a, idx) => {
        const isOpen = open.has(a.account);
        const latest = a.comments[0];
        return (
          <div key={a.account} className={cn(idx > 0 && "border-t border-border")}>
            <button
              onClick={() => setOpen((prev) => { const n = new Set(prev); n.has(a.account) ? n.delete(a.account) : n.add(a.account); return n; })}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
            >
              <span className="w-3.5 shrink-0 text-ink-4">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] font-semibold text-ink">{a.account}</span>
                  <span className="text-[11.5px] text-ink-4">{a.owner ? a.owner.split("@")[0] : "unowned"}</span>
                </div>
                {!isOpen && latest && (
                  <div className="mt-0.5 truncate text-[12px] text-ink-3">
                    “{latest.content}” <span className="text-ink-4">— {latest.author?.split("@")[0]}, {fmtD(latest.date)}</span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {a.open_task_count > 0 && (
                  <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber">
                    {a.open_task_count} open task{a.open_task_count === 1 ? "" : "s"}
                  </span>
                )}
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-3">
                  {a.comment_count} note{a.comment_count === 1 ? "" : "s"}
                </span>
                {a.contact_count > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">
                    <Users size={11} /> {a.contact_count}
                  </span>
                )}
                <span className="w-[52px] text-right text-[11.5px] tabular-nums text-ink-4">{fmtD(a.last_activity)}</span>
              </div>
            </button>
            {isOpen && (
              <div className="flex flex-col gap-3 border-t border-border bg-bg px-4 py-3 pl-10">
                {a.open_tasks.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-amber">Open tasks</div>
                    {a.open_tasks.map((t, i) => (
                      <div key={i} className="flex items-baseline gap-2 py-0.5 text-[12.5px]">
                        <span className="text-ink">{t.title}</span>
                        <span className="text-[11.5px] text-ink-4">
                          {t.owner || "unassigned"}{t.deadline ? ` · due ${fmtD(t.deadline)}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {a.comments.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-ink-3">Notes</div>
                    {a.comments.map((c, i) => (
                      <div key={i} className="py-1 text-[12.5px] leading-relaxed text-ink-2">
                        {c.content}
                        <span className="ml-1.5 text-[11.5px] text-ink-4">— {c.author?.split("@")[0]}, {fmtD(c.date)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {a.contacts.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-accent-ink">Contacts ({a.contact_count})</div>
                    <div className="flex flex-wrap gap-1.5">
                      {a.contacts.map((c, i) => (
                        <span key={i} className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink-2" title={c.title || ""}>
                          {c.name || "—"}{c.title ? <span className="text-ink-4"> · {c.title}</span> : null}
                        </span>
                      ))}
                      {a.contact_count > a.contacts.length && (
                        <span className="px-1 py-1 text-[11.5px] text-ink-4">+{a.contact_count - a.contacts.length} more</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {!showAll && filtered.length > ACCOUNTS_PAGE && (
        <button onClick={() => setShowAll(true)} className="border-t border-border px-4 py-2.5 text-left text-[12.5px] font-medium text-accent-ink hover:underline">
          Show more ({filtered.length - ACCOUNTS_PAGE} more accounts)
        </button>
      )}
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

  return (
    <div className="flex flex-col gap-4 pt-3">
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-900">
        🚧 WIP — to be merged with Performance
      </div>
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
            <ScorecardTable title="User Pipeline" firstColHeader="Stage" rows={sc.user_pipeline} idPrefix="user" drillKind="user" granularity={granularity} scope={scope} owner={owner || undefined} range={range} />
            <ScorecardTable title="Activity Pipeline" firstColHeader="Activity" rows={sc.activity_pipeline} idPrefix="act" drillKind="activity" granularity={granularity} scope={scope} owner={owner || undefined} range={range} />
          </div>

          <SectionHead title="Conversion Figures" />
          <ConversionTables sc={sc} />

          <SectionHead title="Origin Comparison" />
          <OriginComparison sc={sc} />

          {/* ── Divider: everything above = high-level review; below = per-sender/account detail ── */}
          <div className="mt-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border-strong" />
            <span className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">Sender segments and accounts</span>
            <div className="h-px flex-1 bg-border-strong" />
          </div>

          <SectionHead title="By Sender" note="Sent volume & warm/cold, per staff — click a row to filter" />
          <BySenderTable sc={sc} selectedOwner={owner} onPick={setOwner} nameOf={nameOf} />

          <SectionHead title="Targeting Mix" note={`Outreach & replies by segment${owner ? ` · ${owner.split("@")[0]}` : ""} · this period`} />
          <TargetingMix granularity={granularity} scope={scope} owner={owner || undefined} range={range} />

          <SectionHead title="Account Working List" note={owner ? `${owner.split("@")[0]}'s accounts · notes & open tasks` : "Accounts with notes & open tasks — most recently touched first"} />
          <AccountsPanel owner={owner || undefined} />

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
    </div>
  );
}
