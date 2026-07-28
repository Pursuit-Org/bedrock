import { useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
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

const NEW_COLOR = "#4242EA";       // new accounts (activation)
const EXISTING_COLOR = "#C7C7F5";  // existing accounts

function fmtPeriod(iso: string, gran: "day" | "week" | "month"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = new Date(y, m - 1, d).toLocaleString("en-US", { month: "short" });
  if (gran === "month") return `${month} ${String(y).slice(2)}`;
  return `${month} ${d}`;  // day + week both show "Jul 6"
}

/**
 * Account-level outreach over time — one stacked bar per period, split into
 * touches to NEW accounts (first activated that period) vs EXISTING accounts.
 * Toggle the channel (all / email / meeting) and the bucket size (week/month).
 */
export function ActivityTrends() {
  const [gran, setGran] = useState<"day" | "week" | "month">("week");
  const [channel, setChannel] = useState<OutreachChannel>("all");
  const [owner, setOwner] = useState<string>("");          // "" = whole scope
  const [scope, setScope] = useState<OutreachScope>("team"); // team = Avni/Damon/Devika; staff = everyone else
  const [openPeriod, setOpenPeriod] = useState<string | null>(null);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const range: OutreachRange | undefined = from && to && from <= to ? { from, to } : undefined;
  const { data, isLoading, isError, refetch } = useActivityTrends(gran, channel, owner || undefined, scope, range);

  const chartData = useMemo(
    () => (data?.buckets ?? []).map((b: ActivityTrendBucket) => ({ ...b, label: fmtPeriod(b.period, gran) })),
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
      action={
        <div className="flex items-center gap-2">
          <Toggle value={scope} onChange={(v) => { setScope(v as OutreachScope); setOwner(""); }}
                  opts={[["team", "Core team"], ["staff", "Other staff"]]} />
          <Toggle value={channel} onChange={(v) => setChannel(v as OutreachChannel)}
                  opts={[["all", "All"], ["email", "Email"], ["meeting", "Meetings"]]} />
          <Toggle value={gran} onChange={(v) => setGran(v as "day" | "week" | "month")}
                  opts={[["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]]} />
          <div className="flex items-center gap-1 rounded-md border border-border-strong px-1.5 py-0.5">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
              title="Range start" className="h-6 bg-transparent text-[11.5px] text-ink-2 outline-none" />
            <span className="text-[11px] text-ink-4">→</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
              title="Range end" className="h-6 bg-transparent text-[11.5px] text-ink-2 outline-none" />
            {(from || to) && (
              <button type="button" onClick={() => { setFrom(""); setTo(""); }}
                title="Clear range (back to trailing window)" className="px-1 text-[11px] font-medium text-ink-4 hover:text-ink-2">×</button>
            )}
          </div>
        </div>
      }
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
          <div className="grid grid-cols-3 gap-3">
            <Stat label={`Accounts reached · ${range ? `${from} → ${to}` : gran === "day" ? "14 days" : gran === "week" ? "12 wks" : "12 mos"}`} value={data?.totals.touches ?? 0} />
            <Stat label="To new accounts" value={data?.totals.new ?? 0} accent />
            <Stat label="To existing accounts" value={data?.totals.existing ?? 0} />
          </div>

          {data?.coverage_note ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /><span>{data.coverage_note}</span>
            </div>
          ) : null}

          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} barSize={gran === "week" ? 18 : 30} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}
              onClick={(s: any) => { const lbl = s?.activeLabel; if (lbl && labelToPeriod[lbl]) setOpenPeriod(labelToPeriod[lbl]); }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" allowDecimals={false} />
              <ReTooltip cursor={{ fill: "var(--color-surface-2)" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
              <Bar dataKey="new" name="New accounts" stackId="a" fill={NEW_COLOR} className="cursor-pointer" />
              <Bar dataKey="existing" name="Existing accounts" stackId="a" fill={EXISTING_COLOR} radius={[3, 3, 0, 0]} className="cursor-pointer" />
            </BarChart>
          </ResponsiveContainer>
          <p className="-mt-1 text-[10.5px] text-ink-4">Click a bar to see who was reached out to that {gran}.</p>
          <div className="flex flex-wrap items-center gap-4 pl-1">
            <Legend color={NEW_COLOR} label="New accounts (first activated this period)" />
            <Legend color={EXISTING_COLOR} label="Existing accounts" />
          </div>
          <p className="text-[11px] text-ink-4">
            Jobs-related outreach by {owner ? ownerName(owner) : (scope === "staff" ? "the wider staff" : "the core jobs team")} (email, meetings, manual logs), counted once per account per period.
          </p>
        </div>
      )}
      <OutreachDetailDrawer period={openPeriod} gran={gran} channel={channel} owner={owner} scope={scope} onClose={() => setOpenPeriod(null)} />
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

function Toggle({ value, onChange, opts }: { value: string; onChange: (v: string) => void; opts: [string, string][] }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border-strong p-0.5 text-[11.5px]">
      {opts.map(([v, label]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={`rounded px-2.5 py-1 font-medium ${value === v ? "bg-ink text-surface" : "text-ink-3 hover:text-ink"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />{label}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border-strong bg-surface px-3 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className={`text-[20px] font-semibold leading-tight ${accent ? "text-accent" : "text-ink"}`}>{value.toLocaleString()}</span>
    </div>
  );
}
