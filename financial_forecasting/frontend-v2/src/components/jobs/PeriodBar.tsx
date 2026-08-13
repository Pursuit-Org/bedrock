import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { OutreachGranularity } from "@/services/jobs";

/**
 * The period control shared by Outreach and Pipeline, so the two pages read
 * identically: stepper + range label on the left, the two date inputs, then the
 * Daily / Weekly / Monthly presets. Page-specific controls (sender, scope,
 * owner, deal type) go in `children` on the right.
 *
 * Works in local YYYY-MM-DD strings throughout — `toISOString()` would shift the
 * day for anyone west of UTC.
 */

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (v: string) => new Date(`${v}T00:00:00`);
const dayDiff = (a: string, b: string) =>
  Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
const addDays = (v: string, n: number) => {
  const d = parse(v);
  d.setDate(d.getDate() + n);
  return iso(d);
};

/** Yesterday. Every preset ends here rather than today: reviewing on a Monday
 *  you want the week that finished, not the two days of the one in progress —
 *  an in-progress period always reads as a collapse in volume. */
function yesterday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d;
}

/** Each preset sets the window AND the bucket size together — a month of dates
 *  shown in weekly buckets reads as a bug. All three are trailing windows ending
 *  yesterday, so "Weekly" on Aug 3 means Jul 27 – Aug 2. */
export const PERIOD_PRESETS: {
  key: OutreachGranularity;
  label: string;
  title: string;
  get: () => [string, string];
}[] = [
  {
    key: "day",
    label: "Daily",
    title: "Yesterday",
    get: () => { const e = yesterday(); return [iso(e), iso(e)]; },
  },
  {
    key: "week",
    label: "Weekly",
    title: "The 7 days ending yesterday",
    get: () => {
      const e = yesterday();
      const s = new Date(e); s.setDate(e.getDate() - 6);
      return [iso(s), iso(e)];
    },
  },
  {
    key: "month",
    label: "Monthly",
    title: "The month ending yesterday",
    get: () => {
      const e = yesterday();
      const s = new Date(e); s.setMonth(e.getMonth() - 1); s.setDate(s.getDate() + 1);
      return [iso(s), iso(e)];
    },
  },
];

/** The default window for a page: the completed week. */
export function defaultPeriod(): [string, string] {
  return PERIOD_PRESETS[1].get();
}

function fmt(v: string) {
  return parse(v).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function PeriodBar({
  from, to, onChange, granularity, onGranularityChange, clampToToday = false, children,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  granularity: OutreachGranularity;
  onGranularityChange: (g: OutreachGranularity) => void;
  /** Pipeline never shows a future window (it would always be empty). */
  clampToToday?: boolean;
  children?: React.ReactNode;
}) {
  const today = iso(new Date());
  const span = Math.max(1, dayDiff(from, to) + 1);
  const label = `${fmt(from)} – ${fmt(to)}`;
  const canGoNext = !clampToToday || dayDiff(to, today) >= 1;

  /** Step the whole window by its own length, so a week stays a week. */
  const shift = (dir: -1 | 1) => {
    let nf = addDays(from, dir * span);
    let nt = addDays(to, dir * span);
    if (clampToToday && dir === 1 && dayDiff(nt, today) < 0) {
      nt = today;
      nf = addDays(today, -(span - 1));
    }
    onChange(nf, nt);
  };

  const setFrom = (v: string) => {
    const f = clampToToday && dayDiff(v, today) < 0 ? today : v;
    onChange(f, dayDiff(f, to) < 0 ? f : to);
  };
  const setTo = (v: string) => {
    const t = clampToToday && dayDiff(v, today) < 0 ? today : v;
    onChange(dayDiff(from, t) < 0 ? t : from, t);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border-strong bg-surface-2 px-3 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Period</span>

      {/* Stepper + the window it currently shows */}
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => shift(-1)} title="Previous period"
          className="grid h-6 w-6 place-items-center rounded border border-border-strong bg-surface text-ink-3 hover:text-ink">
          <ChevronLeft size={13} />
        </button>
        <span className="min-w-[124px] text-center text-[12.5px] font-semibold text-ink">
          {label}
          <span className="ml-1.5 font-normal text-ink-4">{span}d</span>
        </span>
        <button type="button" onClick={() => shift(1)} disabled={!canGoNext}
          title={canGoNext ? "Next period" : "Already at the current period"}
          className={cn("grid h-6 w-6 place-items-center rounded border border-border-strong bg-surface",
            canGoNext ? "text-ink-3 hover:text-ink" : "cursor-not-allowed text-ink-4/50")}>
          <ChevronRight size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
          title="Range start"
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent" />
        <span className="text-ink-4">→</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
          title="Range end"
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent" />
      </div>

      <div className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
        {PERIOD_PRESETS.map((p) => {
          const [pf, pt] = p.get();
          const active = granularity === p.key && from === pf && to === pt;
          return (
            <button key={p.key} type="button"
              onClick={() => { onGranularityChange(p.key); onChange(pf, pt); }}
              title={`${p.title} — ${pf} to ${pt}`}
              className={cn("rounded px-2 py-0.5 text-[12px] font-medium transition-colors",
                active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2")}>
              {p.label}
            </button>
          );
        })}
      </div>

      {children ? <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">{children}</div> : null}
    </div>
  );
}

/** Three-way sender scope, shared by the pages that filter by who did the work. */
export function ScopeButtons({ value, onChange }: {
  value: "pursuit" | "team" | "staff";
  onChange: (v: "pursuit" | "team" | "staff") => void;
}) {
  const opts: { key: "team" | "staff" | "pursuit"; label: string; title: string }[] = [
    { key: "team", label: "Jobs Team", title: "Avni, Damon and Devika" },
    { key: "staff", label: "Other Staff", title: "Everyone else at Pursuit" },
    { key: "pursuit", label: "Everyone", title: "The whole Pursuit team" },
  ];
  return (
    <div className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
      {opts.map((o) => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)} title={o.title}
          className={cn("rounded px-2 py-0.5 text-[12px] font-medium transition-colors",
            value === o.key ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
