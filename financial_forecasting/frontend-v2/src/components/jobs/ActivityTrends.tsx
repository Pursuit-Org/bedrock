import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, Loader2, Mail, Calendar } from "lucide-react";

import { SectionCard } from "@/components/detail";
import { Drawer } from "@/components/ui/Drawer";
import {
  useActivityTrends, useActivityTrendDetail,
  type ActivityTrendBucket, type OutreachChannel, type OutreachScope, type OutreachRange,
} from "@/services/jobs";

const ownerName = (email: string) => {
  const lp = email.split("@")[0].replace(/[._]/g, " ");
  return lp.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};
const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

type SplitMode = "total" | "split";

const NEW_COLOR = "#4242EA";       // new accounts (activation)
const EXISTING_COLOR = "#C7C7F5";  // existing accounts

function fmtPeriod(iso: string, gran: "day" | "week" | "month"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = new Date(y, m - 1, d).toLocaleString("en-US", { month: "short" });
  if (gran === "month") return `${month} ${String(y).slice(2)}`;
  return `${month} ${d}`;  // day + week both show "Jul 6"
}

/**
 * Account-level outreach over time — a line per period of how many accounts
 * were reached. The dropdown splits that into NEW accounts (first activated
 * that period) vs EXISTING ones. Period, bucket size, scope and sender are all
 * owned by the page's period row. The only controls here are the series split
 * and the bucket size (how finely the selected period is sliced), which is a
 * different question from how long the period is.
 */
export function ActivityTrends({ granularity, scope, owner, range }: {
  granularity: "day" | "week" | "month";
  scope: OutreachScope;
  owner?: string;
  range?: OutreachRange;
}) {
  // Bucket size within the selected period. Seeded from the page's granularity
  // but independent of it: the page chooses how long the window is, this chooses
  // how finely to slice it — a month of data by day is a legitimate view.
  const [bucket, setBucket] = useState<"day" | "week" | "month" | null>(null);
  const gran = bucket ?? granularity;
  // Channel stays "all": splitting email vs meetings was a fourth control on a
  // page that already has three, and the line answers "how much outreach".
  const channel: OutreachChannel = "all";
  const [openPeriod, setOpenPeriod] = useState<string | null>(null);
  // "total" = one line, accounts reached. "split" = new vs existing.
  const [split, setSplit] = useState<SplitMode>("total");
  const { data, isLoading, isError, refetch } = useActivityTrends(gran, channel, owner || undefined, scope, range);

  const chartData = useMemo(
    () => (data?.buckets ?? []).map((b: ActivityTrendBucket) => ({
      ...b,
      total: (b.new ?? 0) + (b.existing ?? 0),
      label: fmtPeriod(b.period, gran),
    })),
    [data, gran],
  );
  const labelToPeriod = useMemo(
    () => Object.fromEntries((data?.buckets ?? []).map((b) => [fmtPeriod(b.period, gran), b.period])),
    [data, gran],
  );

  return (
    <SectionCard
      title="Outreach & Activation"
      storageScope="jobs"
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-3"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2 px-5 py-10">
          <p className="text-[13px] text-red">Couldn't load outreach trends.</p>
          <button type="button" onClick={() => refetch()} className="rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-5 py-4">
          {data?.coverage_note ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /><span>{data.coverage_note}</span>
            </div>
          ) : null}

          {/* One line by default — total accounts reached per period. The
              new-vs-existing split is a second question, so it sits behind the
              dropdown rather than competing for the same axis. */}
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
              <option value="total">Accounts reached</option>
              <option value="split">New vs existing accounts</option>
            </select>
          </div>

          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}
              onClick={(s: any) => { const lbl = s?.activeLabel; if (lbl && labelToPeriod[lbl]) setOpenPeriod(labelToPeriod[lbl]); }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" allowDecimals={false} />
              <ReTooltip cursor={{ stroke: "var(--color-border)" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
              {split === "total" ? (
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
          <p className="-mt-1 text-[10.5px] text-ink-4">Click a point to see who was reached out to that {gran}.</p>
          {split === "split" ? (
            <div className="flex flex-wrap items-center gap-4 pl-1">
              <Legend color={NEW_COLOR} label="New accounts (first activated this period)" />
              <Legend color={EXISTING_COLOR} label="Existing accounts" />
            </div>
          ) : null}
          <p className="text-[11px] text-ink-4">
            Jobs-related outreach by {owner ? ownerName(owner) : (scope === "staff" ? "the wider staff" : "the core jobs team")} (email, meetings, manual logs), counted once per account per period.
          </p>
        </div>
      )}
      <OutreachDetailDrawer period={openPeriod} gran={gran} channel={channel} owner={owner ?? ""} scope={scope} onClose={() => setOpenPeriod(null)} />
    </SectionCard>
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

