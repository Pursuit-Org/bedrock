import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, Loader2, Mail, Calendar } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
// Same card wrapper as Targeting Mix — see the Panel note at the return below.
import { Panel } from "@/pages/jobs/JobsOpportunitiesOverview";
import {
  useActivityTrends, useActivityTrendDetail, useVolumeTrends,
  type ActivityTrendBucket, type OutreachChannel, type OutreachScope, type OutreachRange,
  type VolumeSeriesKey,
} from "@/services/jobs";

const ownerName = (email: string) => {
  const lp = email.split("@")[0].replace(/[._]/g, " ");
  return lp.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};
const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

/** What the chart plots. "volume" is the default (Kwame 2026-09-21): the page
 *  above answers "how did this week go", and the first question that follows is
 *  "compared to what". */
type SplitMode = "volume" | "total" | "split";

const NEW_COLOR = "#4242EA";       // new accounts (activation)
const EXISTING_COLOR = "#C7C7F5";  // existing accounts

/** The four Activity Pipeline headlines, in funnel order, each with its own
 *  colour. Same keys the volume endpoint returns, same definitions the table
 *  uses, so a point here equals a row there for the same window. */
const VOLUME_SERIES: { key: VolumeSeriesKey; label: string; color: string }[] = [
  { key: "accounts_activated", label: "Accounts activated", color: "#0EA5A4" },
  { key: "outreach",           label: "Total outreach",     color: NEW_COLOR },
  { key: "calls",              label: "Total calls",        color: "#F59E0B" },
  { key: "opportunities",      label: "Opportunities",      color: "#16A34A" },
];

/** How far back the trend looks, in days, given the page's own window.
 *
 *  The whole point of this chart is to see PAST the period the rest of the page
 *  is fixed on (Kwame 2026-09-21), so it never simply mirrors it. Two months is
 *  the floor and the answer for a weekly page: about nine weekly points, enough
 *  to tell a bad week from a new normal. A longer page period scales up — eight
 *  of whatever you are looking at — because two months of a monthly view is two
 *  points, which is a line between two dots rather than a trend.
 */
const TREND_MIN_DAYS = 60;
const TREND_PERIODS = 8;

function trendWindow(range: OutreachRange | undefined): OutreachRange | undefined {
  if (!range?.from || !range?.to) return undefined;
  const at = (iso: string) => new Date(`${iso}T12:00:00`);
  const end = at(range.to);
  const pageDays = Math.max(1, Math.round((end.getTime() - at(range.from).getTime()) / 86_400_000) + 1);
  const span = Math.max(TREND_MIN_DAYS, pageDays * TREND_PERIODS);
  const start = new Date(end);
  start.setDate(end.getDate() - (span - 1));
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(start), to: range.to };
}

function fmtPeriod(iso: string, gran: "day" | "week" | "month"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = new Date(y, m - 1, d).toLocaleString("en-US", { month: "short" });
  if (gran === "month") return `${month} ${String(y).slice(2)}`;
  return `${month} ${d}`;  // day + week both show "Jul 6"
}

/**
 * Account-level outreach over time — a line per period of how many accounts
 * were reached. The dropdown splits that into NEW accounts (first activated
 * that period) vs EXISTING ones. Period, scope and sender are owned by the
 * page's period row. The only controls here are the series split and the bucket
 * size (how finely the selected period is sliced), which is a different question
 * from how long the period is.
 */
export function ActivityTrends({ scope, owner, range }: {
  scope: OutreachScope;
  owner?: string;
  range?: OutreachRange;
}) {
  // Bucket size within the trend window. Defaults to WEEKLY (Kwame 2026-09-21):
  // over two months, daily points are sixty of them and the line reads as noise;
  // a week is also the unit the targets are set in, so a point can be compared
  // to a goal without arithmetic.
  const [bucket, setBucket] = useState<"day" | "week" | "month">("week");
  const gran = bucket;
  // Channel stays "all": splitting email vs meetings was a fourth control on a
  // page that already has three, and the line answers "how much outreach".
  const channel: OutreachChannel = "all";
  const [openPeriod, setOpenPeriod] = useState<string | null>(null);
  // "volume" is the default — the four Activity Pipeline headlines over a long
  // run. The two account views stay: whether outreach is opening new doors or
  // working the existing book is still worth asking, just not first.
  const [split, setSplit] = useState<SplitMode>("volume");
  // Deliberately NOT the page's range — see trendWindow. This card exists to
  // show the run the selected period sits inside.
  const trendRange = useMemo(() => trendWindow(range), [range]);
  const isVolume = split === "volume";
  const accounts = useActivityTrends(gran, channel, owner || undefined, scope, trendRange);
  const volume = useVolumeTrends(gran, owner || undefined, scope, trendRange);
  const { isLoading, isError, refetch } = isVolume ? volume : accounts;
  const data = accounts.data;

  // One array, two shapes. Recharts reads keys off the row, so the union has to
  // be widened for it rather than narrowed — every series names its own dataKey.
  const chartData: Record<string, number | string>[] = useMemo(() => {
    if (isVolume) {
      return (volume.data?.buckets ?? []).map((b) => ({ ...b, label: fmtPeriod(b.period, gran) }));
    }
    return (data?.buckets ?? []).map((b: ActivityTrendBucket) => ({
      ...b,
      total: (b.new ?? 0) + (b.existing ?? 0),
      label: fmtPeriod(b.period, gran),
    }));
  }, [isVolume, volume.data, data, gran]);
  const labelToPeriod = useMemo(
    () => Object.fromEntries((isVolume ? volume.data?.buckets ?? [] : data?.buckets ?? [])
      .map((b) => [fmtPeriod(b.period, gran), b.period])),
    [isVolume, volume.data, data, gran],
  );
  // "Sep 14 – Nov 12" under the title, so the window this card uses is stated
  // rather than assumed to be the page's.
  const windowLabel = useMemo(() => {
    const b = chartData;
    if (b.length === 0) return "";
    return `${b[0].label} – ${b[b.length - 1].label}`;
  }, [chartData]);

  // Data-points buttons + the series select, in Panel's header slot so this card
  // has exactly the same header geometry as Targeting Mix beside it.
  const controls = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Data points</span>
      <div className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
        {([["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]] as const).map(([k, lbl]) => (
          <button key={k} type="button" onClick={() => setBucket(k)}
            title={`One point per ${k} across the selected period`}
            className={`rounded px-2 py-0.5 text-[12px] font-medium transition-colors ${
              gran === k ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
            {lbl}
          </button>
        ))}
      </div>
      <select
        value={split}
        onChange={(e) => setSplit(e.target.value as SplitMode)}
        title="What the chart plots"
        className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[11.5px] text-ink-2 outline-none focus:border-accent"
      >
        <option value="volume">Outreach activity</option>
        <option value="total">Accounts reached</option>
        <option value="split">New vs existing accounts</option>
      </select>
    </div>
  );

  return (
    // Panel, not SectionCard: SectionCard's collapse header is a band above the
    // content, which pushed this chart's body a header's height below Targeting
    // Mix's. Same wrapper = tops line up by construction, not by hand-tuning.
    <Panel
      title="Outreach Trends"
      desc={isVolume
        ? `Accounts activated, outreach, calls and opportunities${windowLabel ? ` · ${windowLabel}` : ""}`
        : `Accounts contacted${windowLabel ? ` · ${windowLabel}` : ""}`}
      action={controls}
      className="h-full"
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-3"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2 py-10">
          <p className="text-[13px] text-red">Couldn't load outreach trends.</p>
          <button type="button" onClick={() => refetch()} className="rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {!isVolume && data?.coverage_note ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /><span>{data.coverage_note}</span>
            </div>
          ) : null}

          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}
              // Only the account views drill: the drawer lists accounts and their
              // touches, which answers nothing about a conversion count.
              onClick={(s: any) => { if (isVolume) return; const lbl = s?.activeLabel; if (lbl && labelToPeriod[lbl]) setOpenPeriod(labelToPeriod[lbl]); }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" allowDecimals={false} />
              <ReTooltip cursor={{ stroke: "var(--color-border)" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
              {isVolume ? (
                VOLUME_SERIES.map((sr) => (
                  <Line key={sr.key} type="monotone" dataKey={sr.key} name={sr.label} stroke={sr.color}
                    strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
                ))
              ) : split === "total" ? (
                <Line type="monotone" dataKey="total" name="Accounts reached" stroke={NEW_COLOR}
                  strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} className="cursor-pointer" />
              ) : (
                <>
                  <Line type="monotone" dataKey="new" name="New accounts" stroke={NEW_COLOR}
                    strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} className="cursor-pointer" />
                  <Line type="monotone" dataKey="existing" name="Existing accounts" stroke={EXISTING_COLOR}
                    strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} className="cursor-pointer" />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
          {isVolume ? (
            <div className="flex flex-wrap items-center gap-4 pl-1">
              {VOLUME_SERIES.map((sr) => {
                const t = volume.data?.targets?.[sr.key];
                return (
                  <Legend key={sr.key} color={sr.color}
                    label={t != null ? `${sr.label} (target ${t})` : sr.label} />
                );
              })}
            </div>
          ) : split === "split" ? (
            <div className="flex flex-wrap items-center gap-4 pl-1">
              <Legend color={NEW_COLOR} label="New accounts (first activated this period)" />
              <Legend color={EXISTING_COLOR} label="Existing accounts" />
            </div>
          ) : null}
          <p className="text-[11px] text-ink-4">
            {isVolume ? (
              <>The same four numbers the Activity Pipeline shows for one period, over a longer run,
                so a week can be read against the ones around it. Targets in the legend are per {gran}.</>
            ) : (
              <>Jobs-related outreach by {owner ? ownerName(owner) : (scope === "staff" ? "the wider staff" : "the core jobs team")} (email, meetings, manual logs), counted once per account per period.</>
            )}
          </p>
        </div>
      )}
      <OutreachDetailDrawer period={openPeriod} gran={gran} channel={channel} owner={owner ?? ""} scope={scope} onClose={() => setOpenPeriod(null)} />
    </Panel>
  );
}

function OutreachDetailDrawer({ period, gran, channel, owner, scope, onClose }: {
  period: string | null; gran: "day" | "week" | "month"; channel: OutreachChannel; owner: string; scope: OutreachScope; onClose: () => void;
}) {
  const { data, isLoading } = useActivityTrendDetail(period, gran, channel, owner || undefined, scope);
  return (
    <Drawer open={period != null} onClose={onClose}
      title={period ? `Outreach · ${fmtPeriod(period, gran)}` : "Outreach"}
      subtitle={data ? `${data.total_touches} touches · ${data.total_accounts} accounts${owner ? ` · ${ownerName(owner)}` : ""}` : undefined}
      width={620}>
      {isLoading || !data ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-ink-3"><Loader2 size={15} className="animate-spin" /> Loading…</div>
      ) : data.accounts.length === 0 ? (
        <div className="p-6 text-[13px] text-ink-3">No outreach in this period.</div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {data.accounts.map((acc) => (
            <div key={acc.account} className="overflow-hidden rounded-lg border border-border-strong bg-surface">
              <div className="flex items-center justify-between bg-surface-2/60 px-3 py-1.5">
                <span className="text-[12.5px] font-semibold text-ink">{acc.account}</span>
                <span className="text-[11px] tabular-nums text-ink-4">{acc.touches.length}</span>
              </div>
              {acc.touches.map((t) => (
                <div key={t.activity_id} className="flex items-start gap-2 border-t border-border-strong px-3 py-1.5">
                  {t.channel === "meeting" ? <Calendar size={12} className="mt-0.5 shrink-0 text-ink-4" /> : <Mail size={12} className="mt-0.5 shrink-0 text-ink-4" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-ink">{t.contact || "—"}{t.subject ? <span className="text-ink-4"> · {t.subject}</span> : ""}</div>
                  </div>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-ink-4">{fmtDay(t.date)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}


function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />{label}
    </span>
  );
}

