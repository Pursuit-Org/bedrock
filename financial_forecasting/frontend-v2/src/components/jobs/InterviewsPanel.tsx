/**
 * Builder interviews over time (PRO-117), on the Pipeline tab until the
 * Placement tab (PRO-111) takes it.
 *
 * Counts the Jobs team's applications that moved into interview, dated by
 * their stage history (services/jobs_metrics.interviews), so an interview stays
 * counted once the application is accepted or rejected. Interview → hire is
 * the share of those interviews hired now (D11).
 *
 * History has been recorded since `history_from` (9/29). Weeks before it are
 * drawn hatched as "not recorded", never as zero, and the builders at interview
 * whose move has no date are counted in the footer and listed on request.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { Info } from "lucide-react";

import { useInterviews, type InterviewRecord, type InterviewWeek } from "@/services/jobs";
import { APP_STAGE_OPTIONS } from "@/services/jobsOpps2";
import { cn } from "@/lib/utils";

const STAGE_LABEL = new Map(APP_STAGE_OPTIONS.map((o) => [o.value as string, o.label]));
const day = (iso: string) => format(parseISO(iso), "MMM d");

export function InterviewsPanel({ from, to, rangeLabel, owner, dealType }: {
  from: string;            // New York dates, inclusive
  to: string;
  rangeLabel: string;
  owner?: string;
  dealType?: string;
}) {
  const { data, isLoading, isError } = useInterviews(from, to, owner, dealType);
  const [list, setList] = useState<"window" | "undated" | null>(null);

  const rateLine = !data ? null
    : data.interviews === 0 ? "No interviews in this period"
    : `${data.hired} hired so far · ${data.rate_pct}% interview → hire`;

  return (
    <section className="rounded-2xl border border-border-strong bg-surface px-5 py-4">
      <div className="mb-3">
        <h3 className="text-[14px] font-semibold text-ink">Builder interviews</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-4">
          The Jobs team's applications that moved into interview, by the day it was recorded. Still counted once
          they're hired or rejected.
        </p>
      </div>

      {isError ? (
        <p className="text-[12.5px] text-[var(--red)]">Couldn't load interviews.</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[220px_1fr]">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{rangeLabel}</div>
            {isLoading || !data ? (
              <div className="mt-2 h-8 w-16 animate-pulse rounded bg-surface-2" />
            ) : (
              <>
                <button type="button" onClick={() => setList(list === "window" ? null : "window")}
                  disabled={data.interviews === 0}
                  className="mt-1.5 text-left text-[30px] font-bold leading-none tabular-nums text-ink enabled:hover:text-[var(--accent)]">
                  {data.interviews}
                  <span className="ml-1.5 align-middle text-[12px] font-medium text-ink-3">
                    interview{data.interviews === 1 ? "" : "s"}{data.interviews > 0 ? " ›" : ""}
                  </span>
                </button>
                <div className="mt-2 text-[12px] text-ink-3">{rateLine}</div>
              </>
            )}
          </div>
          <WeekBars weeks={data?.weeks ?? []} from={from} to={to} historyFrom={data?.history_from}
            isLoading={isLoading} />
        </div>
      )}

      {data && (
        <div className="mt-3 flex items-start gap-1.5 border-t border-border-strong pt-2.5 text-[11.5px] text-ink-3">
          <Info size={12} className="mt-[2px] shrink-0" />
          <span>
            Interview history starts {day(data.history_from)}: earlier interviews aren't dated, so earlier weeks
            aren't comparable.
            {data.undated > 0 && (
              <>
                {" "}
                <button type="button" onClick={() => setList(list === "undated" ? null : "undated")}
                  className="font-medium text-ink-2 underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">
                  {data.undated} more {data.undated === 1 ? "is" : "are"} at interview with no recorded date
                </button>
                .
              </>
            )}
          </span>
        </div>
      )}

      {data && list && (
        <InterviewList
          title={list === "window" ? `Moved into interview · ${rangeLabel}` : "At interview, no recorded date"}
          rows={list === "window" ? data.rows : data.undated_rows}
          dated={list === "window"}
          onClose={() => setList(null)}
        />
      )}
    </section>
  );
}

// One accent bar per Mon–Sun week. Weeks inside the selected period are full
// strength; the others recede. A week that ended before history began sits on
// a hatched backdrop: what it shows was recorded, the rest is missing, so its
// low count isn't a drop.
function WeekBars({ weeks, from, to, historyFrom, isLoading }: {
  weeks: InterviewWeek[];
  from: string;
  to: string;
  historyFrom?: string;
  isLoading: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (isLoading) return <div className="h-[120px] animate-pulse rounded-lg bg-surface-2" />;
  const max = Math.max(1, ...weeks.map((w) => w.interviews));
  const inRange = (w: InterviewWeek) => {
    const end = format(new Date(parseISO(w.week_start).getTime() + 6 * 86_400_000), "yyyy-MM-dd");
    return w.week_start <= to && end >= from;
  };
  const labelAt = new Set([0, Math.floor((weeks.length - 1) / 2), weeks.length - 1]);

  return (
    <div>
      <div className="relative flex h-[96px] items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {weeks.map((w, i) => {
          const sel = inRange(w);
          const h = w.interviews ? Math.max(6, (w.interviews / max) * 100) : 2;
          return (
            <div key={w.week_start} className="relative flex h-full flex-1 items-end"
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
              aria-label={`Week of ${day(w.week_start)}: ${w.interviews} interviews recorded, ${w.hired} hired`
                + (w.before_history ? ", history incomplete" : "")}>
              {w.before_history && (
                <div className="absolute inset-0 rounded-t-[4px] opacity-50" style={{
                  backgroundImage: "repeating-linear-gradient(45deg, var(--border-strong) 0 1.5px, transparent 1.5px 6px)",
                }} />
              )}
              {sel && w.interviews > 0 && (
                <span className="absolute inset-x-0 text-center text-[10.5px] font-semibold tabular-nums text-ink-2"
                  style={{ bottom: `calc(${h}% + 2px)` }}>{w.interviews}</span>
              )}
              <div
                className={cn("relative w-full rounded-t-[4px] bg-[var(--accent)]",
                  !sel && hover !== i && "opacity-35")}
                style={{ height: `${h}%` }}
              />
            </div>
          );
        })}
        {hover !== null && weeks[hover] && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border-strong bg-surface px-2 py-1 text-[11px] text-ink shadow-sm"
            style={{ left: `${((hover + 0.5) / weeks.length) * 100}%` }}>
            <div className="font-semibold">Week of {day(weeks[hover].week_start)}</div>
            <div className="text-ink-3 tabular-nums">
              {weeks[hover].interviews} interview{weeks[hover].interviews === 1 ? "" : "s"} · {weeks[hover].hired} hired
            </div>
            {weeks[hover].before_history && (
              <div className="text-ink-3">Incomplete: history starts {historyFrom ? day(historyFrom) : ""}</div>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 flex border-t border-border-strong pt-1 text-[10.5px] text-ink-4">
        {weeks.map((w, i) => (
          <div key={w.week_start} className={cn("flex-1 whitespace-nowrap",
            i === 0 ? "text-left" : i === weeks.length - 1 ? "text-right" : "text-center")}>
            {labelAt.has(i) ? day(w.week_start) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function InterviewList({ title, rows, dated, onClose }: {
  title: string;
  rows: InterviewRecord[];
  dated: boolean;
  onClose: () => void;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border-strong bg-surface-2/40">
      <div className="flex items-center justify-between border-b border-border-strong px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title} · {rows.length}</span>
        <button type="button" onClick={onClose} className="text-[11px] text-ink-3 hover:text-ink">Close</button>
      </div>
      <div className="max-h-[320px] overflow-y-auto">
        <table className="w-full text-[12.5px]">
          <thead className="text-left text-[10.5px] uppercase tracking-wider text-ink-4">
            <tr>
              <th className="px-3 py-1.5 font-semibold">Builder</th>
              <th className="px-3 py-1.5 font-semibold">Company</th>
              <th className="px-3 py-1.5 font-semibold">Role</th>
              {dated && <th className="px-3 py-1.5 font-semibold">Interview</th>}
              <th className="px-3 py-1.5 font-semibold">Now</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.job_application_id} className="border-t border-border-strong/60">
                <td className="px-3 py-1.5 text-ink">{r.builder}</td>
                <td className="px-3 py-1.5 text-ink-2">
                  {r.opportunity_id
                    ? <Link to={`/jobs/opportunities/${r.opportunity_id}`} className="hover:text-[var(--accent)] hover:underline">{r.company}</Link>
                    : r.company}
                </td>
                <td className="px-3 py-1.5 text-ink-2">{r.role}</td>
                {dated && <td className="px-3 py-1.5 tabular-nums text-ink-2">{r.entered ? day(r.entered) : "—"}</td>}
                <td className="px-3 py-1.5 text-ink-2">{STAGE_LABEL.get(r.stage) ?? r.stage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
