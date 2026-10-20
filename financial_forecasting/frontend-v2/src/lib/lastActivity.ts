// Relative + .ts so the node --test runner (no path aliases) can load it.
import { parseDateForDisplay } from "./format.ts";

/**
 * "Last activity" for a contact or account: the most recent of Bedrock's own
 * activity (Gmail replies included — Salesforce never sees synced email) and
 * the SF fields (Tasks/Events logged in Salesforce). Returns the winning raw
 * string so callers format it like any other date.
 */
export function lastActivityDate(rec: {
  bedrock_last_activity_at?: string | null;
  Last_Activity_Date__c?: string | null;
  LastActivityDate?: string | null;
}): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of [rec.bedrock_last_activity_at, rec.Last_Activity_Date__c, rec.LastActivityDate]) {
    if (!v) continue;
    const ms = parseDateForDisplay(v).getTime();
    if (!Number.isNaN(ms) && ms > bestMs) {
      best = v;
      bestMs = ms;
    }
  }
  return best;
}

/** Whole calendar days from `iso` to today (local time); null when unknown. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = parseDateForDisplay(iso);
  if (Number.isNaN(d.getTime())) return null;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.max(0, Math.round((startOf(new Date()) - startOf(d)) / 86_400_000));
}
