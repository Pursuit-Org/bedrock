// What the "How is this calculated?" icon says about a number (PRO-105). Kept
// pure so the wording is tested without rendering: the definition and how
// settled it is, the dates it covers, the filters it applies and the ones it
// ignores, and how many records "View records" opens.
import type { MetricDefinition } from "@/services/jobs";

export type DefinitionBadge = { label: string; tone: "settled" | "draft" | "missing" };

/** How settled the words are. A dictionary entry is signed off once the
 *  group confirms it; until it is saved there, the words are its draft. */
export function definitionBadge(d: Pick<MetricDefinition, "source" | "status">): DefinitionBadge {
  if (d.source === "dictionary") {
    return d.status === "confirmed"
      ? { label: "Signed off", tone: "settled" }
      : { label: "Draft", tone: "draft" };
  }
  if (d.source === "repo_draft") return { label: "Draft, not yet in the data dictionary", tone: "draft" };
  return { label: "Not in the data dictionary yet", tone: "missing" };
}

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const YEAR = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "UTC" });

/** "Mon Oct 5" for a New York date string. Dates arrive as YYYY-MM-DD New
 *  York days; formatting them at UTC noon keeps the day whatever the
 *  browser's timezone. */
export function nyDay(iso: string, withYear = false): string {
  const t = new Date(`${iso}T12:00:00Z`);
  const s = DAY.format(t).replace(",", "");
  return withYear ? `${s}, ${YEAR.format(t)}` : s;
}

/** The dates a number covers, in words. */
export function windowLine(d: Pick<MetricDefinition, "window" | "as_of" | "time_anchor">,
                           today?: string): string | null {
  const w = d.window;
  if (w && w.from && w.to) {
    const sameYear = w.from.slice(0, 4) === w.to.slice(0, 4);
    return `${nyDay(w.from, !sameYear)} – ${nyDay(w.to, true)}, New York time`;
  }
  if (w && w.from) return `Since ${nyDay(w.from)}, to now`;
  if (d.as_of) {
    return d.as_of === (today ?? nyToday()) ? "As of today" : `As of the end of ${nyDay(d.as_of, true)}`;
  }
  return d.time_anchor ? capitalize(d.time_anchor) : null;
}

/** Today's date in New York, YYYY-MM-DD. */
export function nyToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

const FILTER_LABELS: Record<string, string> = {
  segment: "Cohort",
  job_type: "Job type",
  owner: "Owner",
  scope: "Whose activity",
  deal_type: "Deal type",
  campaign: "Campaign",
  call_date: "Calls dated by",
  period: "Dates",
  population: "Counted over",
  metric: "Row",
  per: "Grouped by",
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  scope: { team: "the Jobs team", staff: "other Pursuit staff", pursuit: "everyone at Pursuit" },
  job_type: { full_time: "Full-time (placed)", all: "All paid work" },
  call_date: { held: "the day held", booked: "the day booked" },
  per: { day: "day", week: "week", month: "month" },
};

export function filterLabel(key: string): string {
  return FILTER_LABELS[key] ?? capitalize(key.replace(/_/g, " "));
}

/** The filters a number applies, as "Label: value" lines. */
export function appliedFilters(d: Pick<MetricDefinition, "filters">): string[] {
  return Object.entries(d.filters ?? {}).map(([k, v]) =>
    `${filterLabel(k)}: ${VALUE_LABELS[k]?.[String(v)] ?? String(v)}`);
}

/** The page's filters this number doesn't apply, with why. */
export function ignoredFilters(d: Pick<MetricDefinition, "ignored">): { label: string; why: string }[] {
  return Object.entries(d.ignored ?? {}).map(([k, why]) => ({ label: filterLabel(k), why }));
}

/** How many records "View records" opens: the number itself, or for an
 *  average or a rate the records it is over. Null when there is no link. */
export function recordsCount(d: Pick<MetricDefinition, "records" | "value">): number | null {
  if (!d.records) return null;
  if (d.records.count !== undefined) return d.records.count;
  return typeof d.value === "number" ? d.value : null;
}

export function recordsLabel(d: Pick<MetricDefinition, "records" | "value">): string | null {
  const n = recordsCount(d);
  return n === null ? null : `View records (${n.toLocaleString("en-US")})`;
}

/** A measure's words for a column heading, without one row's value, filters
 *  or records: the same for every row beneath it. */
export function columnDefinition<T extends MetricDefinition>(d: T | undefined): T | undefined {
  return d ? { ...d, value: null, filters: {}, ignored: {}, records: null } : undefined;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
