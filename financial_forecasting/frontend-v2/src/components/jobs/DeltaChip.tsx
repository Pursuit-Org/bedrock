import { cn } from "@/lib/utils";

/** The gap to a target, as a signed number.
 *
 *  One component for the Activity Pipeline (both cuts) and the Jobs
 *  Projection, so a delta reads the same everywhere (Kwame 2026-09-21,
 *  2026-09-29). Three states, deliberately distinct: no target is a dash,
 *  exactly on target is a green 0 with no sign, and anything else is signed.
 *  Hitting the number exactly is a pass, so 0 is green; red is reserved for a
 *  shortfall — the only state that asks someone to do something. */
export function DeltaChip({ actual, target }: { actual: number; target: number | null | undefined }) {
  if (target == null) return <span className="text-ink-4">—</span>;
  const d = actual - target;
  // Monthly jobs targets are a third of a quarter's, so the gap can be fractional.
  const shown = Number.isInteger(d) ? String(d) : d.toFixed(1);
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[12.5px] font-semibold tabular-nums",
      d >= 0 ? "bg-green-soft text-green" : "bg-red-soft text-red")}>
      {d > 0 ? "+" : ""}{shown}
    </span>
  );
}
