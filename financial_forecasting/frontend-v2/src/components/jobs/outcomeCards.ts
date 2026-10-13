// What the Overview's outcome cards say (PRO-99). Kept pure so the wording is
// tested without rendering: the headline is Placed (D2: full-time or a paid
// trial), committed roles sit beside it and are never added in, and Avg FT
// salary is placed-only with committed roles' expected salary on its own line.
import type { JobTypeOption, PlacementsSummary } from "@/services/jobs";

export const FULL_TIME = "full_time";
export const ALL_PAID = "all";

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/** The Placed card's title under a job type. */
export function placedLabel(jobType: string, options: JobTypeOption[] = []): string {
  if (jobType === FULL_TIME) return "Placed";
  if (jobType === ALL_PAID) return "Paid work, all types";
  const label = options.find((o) => o.value === jobType)?.label ?? jobType.replace(/_/g, " ");
  return `Placed · ${label}`;
}

/** Under full-time: how the headline splits into full-time and paid trials. */
export function placedBreakdown(p: Pick<PlacementsSummary, "placed_ft" | "placed_trial">, jobType: string): string | null {
  if (jobType !== FULL_TIME) return null;
  const parts = [`${n(p.placed_ft)} full-time`];
  if (p.placed_trial > 0) parts.push(`${n(p.placed_trial)} in a paid trial`);
  return parts.join(" · ");
}

/** Left the role still counts (default, 10/7); say how many are still in it. */
export function inRoleLine(p: Pick<PlacementsSummary, "placed_in_role" | "placed_left">): string {
  const line = `${n(p.placed_in_role)} still in the role`;
  return p.placed_left > 0 ? `${line} · ${n(p.placed_left)} have left` : line;
}

/** "30.5% of 59 job-ready" */
export function ofJobReady(rate: number | null | undefined, jobReady: number): string {
  return `${rate ?? 0}% of ${n(jobReady)} job-ready`;
}

export function pctOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((1000 * part) / whole) / 10 : 0;
}

/** The ring: 0–100, whole numbers. */
export function ringPct(rate: number | null | undefined): number {
  return Math.max(0, Math.min(100, Math.round(rate ?? 0)));
}

/** Committed roles, beside Placed. They have no cohort, so under a cohort
 *  they're the same number, and say so. */
export function committedLine(committed: number, scoped: boolean): string {
  const line = `${plural(committed, "committed role")}, not counted`;
  return scoped ? `${line} (all cohorts)` : line;
}

/** Committed roles' expected salary, under Avg FT salary. */
export function expectedSalaryLine(avg: number | null | undefined, committed: number, scoped: boolean): string | null {
  if (avg == null || committed === 0) return null;
  const line = `Committed roles expect ${usd(avg)} avg (${plural(committed, "role")})`;
  return scoped ? `${line}, all cohorts` : line;
}

/** "placed builders' highest full-time pay · 14 builders" */
export function salaryBasis(ftSalaried: number): string {
  return `placed builders only · ${plural(ftSalaried, "builder")}`;
}
