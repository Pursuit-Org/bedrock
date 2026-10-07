import type { CallKind } from "@/services/jobs";

// What logging a call asks for (PRO-102), shared by the three log forms.
// Kept free of React and path aliases so `npm run test` (node --test) can
// import it directly.

/** Today in the browser's own time zone, as YYYY-MM-DD. `toISOString()` is
 *  UTC, so after 8pm in New York the forms defaulted to tomorrow. */
export function localTodayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface CallDetails {
  kind: CallKind | null;
  /** The day the call was booked. What Calls booked counts it on. */
  booked: string;
  /** The day it was held, or will be. Empty: the day it was booked. */
  held: string;
}

export function newCallDetails(now?: Date): CallDetails {
  return { kind: null, booked: localTodayIso(now), held: "" };
}

/** Why the call can't be logged yet, or null when it can. A type is required
 *  once the database can store one; until then the picker is disabled and
 *  asking for it would block every call. */
export function callNotReady(d: CallDetails, typesAvailable: boolean, today: string = localTodayIso()): string | null {
  if (typesAvailable && !d.kind) return "Pick a call type";
  if (!d.booked) return "Add the day it was booked";
  if (d.booked > today) return "A call can't be booked in the future";
  if (d.held && d.held < d.booked) return "It can't be held before it was booked";
  return null;
}

/** The call's part of the log request. Dates go as bare days; the API reads
 *  them as New York days. */
export function callRequestFields(d: CallDetails): { call_kind: CallKind | null; booked_at: string; activity_date: string } {
  return { call_kind: d.kind, booked_at: d.booked, activity_date: d.held || d.booked };
}
