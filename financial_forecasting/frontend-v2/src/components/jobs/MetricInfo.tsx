import { Info } from "lucide-react";

import { Popover, PopoverClose } from "@/components/ui/Popover";
import { cn } from "@/lib/utils";
import type { MetricDefinition } from "@/services/jobs";

import {
  appliedFilters, definitionBadge, ignoredFilters, recordsLabel, windowLine,
} from "./metricInfoText";

const BADGE_TONE = {
  settled: "bg-emerald-50 text-emerald-800",
  draft: "bg-amber-50 text-amber-800",
  missing: "bg-surface-2 text-ink-3",
} as const;

/**
 * "How is this calculated?" (PRO-105): an info icon beside a number that opens
 * its definition, how settled that is, the dates it covers, the filters it
 * applies and the ones it ignores, and a link to the records behind it.
 *
 * Every word comes from `definition` (the response's `definitions` entry), so
 * the icon and the data dictionary can't say different things. `onViewRecords`
 * opens the page's own drill for the number; without it there is no link.
 *
 * Render it as a sibling of a clickable card's button, never inside it: a
 * button can't hold another.
 */
export function MetricInfo({
  definition,
  label,
  onViewRecords,
  className,
}: {
  definition: MetricDefinition | null | undefined;
  /** The line's own name, when it is one column of a measure whose label
   *  covers several (Placed: full-time, paid trial). */
  label?: string;
  onViewRecords?: () => void;
  className?: string;
}) {
  if (!definition) return null;
  const d = label ? { ...definition, label } : definition;
  const title = d.label ?? d.measure.replace(/_/g, " ");
  return (
    <Popover content={<MetricInfoBody definition={d} onViewRecords={onViewRecords} />}>
      <button
        type="button"
        aria-label={`How is ${title} calculated?`}
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-4",
          "hover:bg-surface-2 hover:text-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        // Cards that open a drill on Enter/Space mustn't hear this key too.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Info size={12} aria-hidden />
      </button>
    </Popover>
  );
}

function MetricInfoBody({ definition: d, onViewRecords }: {
  definition: MetricDefinition;
  onViewRecords?: () => void;
}) {
  const badge = definitionBadge(d);
  const when = windowLine(d);
  const applied = appliedFilters(d);
  const ignored = ignoredFilters(d);
  const link = onViewRecords ? recordsLabel(d) : null;
  return (
    <div className="space-y-2.5">
      <div>
        <div className="text-[13px] font-semibold text-ink">{d.label ?? d.measure.replace(/_/g, " ")}</div>
        <span className={cn("mt-1 inline-block rounded px-1.5 py-0.5 text-[10.5px] font-medium", BADGE_TONE[badge.tone])}>
          {badge.label}
        </span>
      </div>
      {d.definition ? <p className="leading-snug">{d.definition}</p> : (
        <p className="text-ink-4">No definition has been written for this number yet.</p>
      )}
      {d.numerator || d.denominator ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
          {d.numerator ? (<><dt className="text-ink-4">Counts</dt><dd>{d.numerator}</dd></>) : null}
          {d.denominator && !/^n\/a/i.test(d.denominator) ? (
            <><dt className="text-ink-4">Divides by</dt><dd>{d.denominator}</dd></>
          ) : null}
        </dl>
      ) : null}
      {when ? <Section label="When">{when}</Section> : null}
      {applied.length ? (
        <Section label="Filters applied">
          <ul>{applied.map((f) => <li key={f}>{f}</li>)}</ul>
        </Section>
      ) : null}
      {ignored.length ? (
        <Section label="Filters this number ignores">
          <ul>{ignored.map((f) => <li key={f.label}><span className="font-medium">{f.label}</span>: {f.why}</li>)}</ul>
        </Section>
      ) : null}
      {d.caveat ? <p className="text-[11.5px] text-ink-3">{d.caveat}</p> : null}
      {link ? (
        <PopoverClose asChild>
          <button type="button" onClick={onViewRecords}
                  className="text-[12px] font-medium text-accent-ink hover:underline">
            {link}
          </button>
        </PopoverClose>
      ) : null}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-[11.5px]">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
