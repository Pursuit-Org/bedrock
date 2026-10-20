import { cn } from "@/lib/utils";

/** The card every Jobs dashboard section sits in: a title, an optional
 *  "How is this calculated?" or "Why these?" beside it, a line under it, and
 *  controls on the right. */
export function Panel({
  title, desc, action, badge, info, className, children,
}: {
  title: string; desc?: string; action?: React.ReactNode; badge?: string;
  /** "How is this calculated?" or "Why these?" (PRO-105), beside the title. */
  info?: React.ReactNode;
  /** For a panel that has to fill its grid row — pass "h-full". */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border border-border-strong bg-surface px-5 py-4", className)}>
      {/* flex-wrap: when the title block and the controls don't fit on one
          line, the controls drop to their own line, right-aligned. The title
          block used to be shrink-0, which kept a long `desc` on one line and
          pushed the controls past the card's right edge, under the panel
          beside it (Outreach Trends' Data points buttons, ~100px at laptop
          widths). Only the title itself refuses to wrap now; `desc` may. */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="whitespace-nowrap text-[14px] font-semibold text-ink">{title}</h3>
            {info}
            {badge ? (
              <span className="rounded-full bg-[var(--red-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--red)]">{badge}</span>
            ) : null}
          </div>
          {desc ? <p className="mt-0.5 text-[11.5px] text-ink-4">{desc}</p> : null}
        </div>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
