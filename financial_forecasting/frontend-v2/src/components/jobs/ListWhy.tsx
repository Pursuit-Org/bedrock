import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/utils";
import { useListsWhy } from "@/services/jobs";

/**
 * "Why these?" beside a list's heading (PRO-105): who is in it, the order, how
 * many are listed, and what each date on a row means, in the words kept in
 * services/jobs_lists.py. `listKey` must be one of its keys; the backend tests
 * check every key used here.
 */
export function ListWhy({ listKey, className }: { listKey: string; className?: string }) {
  const { data } = useListsWhy();
  const w = data?.[listKey];
  if (!w) return null;
  return (
    <Popover content={
      <div className="space-y-2">
        <div className="text-[13px] font-semibold text-ink">Why these?</div>
        <p className="leading-snug">{w.who}</p>
        <Line label="Order">{w.order}</Line>
        <Line label="How many">{w.cap}</Line>
        {w.dates.length ? <Line label="Dates">{w.dates.join(" ")}</Line> : null}
        {w.notes.length ? (
          <ul className="list-disc space-y-0.5 pl-4 text-[11.5px] text-ink-3">
            {w.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        ) : null}
      </div>
    }>
      <button
        type="button"
        className={cn("rounded px-1 text-[11px] font-medium normal-case tracking-normal text-ink-4 underline decoration-dotted underline-offset-2 hover:text-ink-2",
          className)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        Why these?
      </button>
    </Popover>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-[11.5px]">
      <span className="font-semibold text-ink-3">{label}: </span>{children}
    </div>
  );
}
