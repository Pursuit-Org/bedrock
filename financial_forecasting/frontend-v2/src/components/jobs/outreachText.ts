/**
 * The words and the red/green rule on the Monday Outreach view (PRO-106),
 * kept apart from the components so they can be tested on their own.
 */

/** Where a number stands against its goal. Met includes exactly on it, as
 *  DeltaChip reads it: red is kept for a shortfall, the only state that asks
 *  someone to act. No goal set is its own state, never a green zero. */
export type TargetState = "met" | "short" | "none";

export function vsTarget(actual: number, target: number | null | undefined): TargetState {
  if (target == null) return "none";
  return actual >= target ? "met" : "short";
}

/** n of `of` as a whole percent, or null when there is nothing to divide by. */
export function share(n: number, of: number): number | null {
  return of > 0 ? Math.round((100 * n) / of) : null;
}

/** "12 new · 3 follow-ups on open opportunities". */
export function followUpLine(split: { new: number; follow_up: number }): string {
  const f = split.follow_up;
  return `${split.new} new · ${f} follow-up${f === 1 ? "" : "s"} on open opportunities`;
}

export type StuckReasonKind = "intro" | "revisit" | "not_a_fit" | "none";

/** "Nov 1" from a YYYY-MM-DD date, the same day in every browser timezone. */
function plainDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

/** Why a contact hasn't been reached, as a sentence fragment. */
export function stuckReasonText(reason: { kind: StuckReasonKind; detail: string | null }): string {
  switch (reason.kind) {
    case "intro":
      return `Waiting on an intro from ${reason.detail ?? "a colleague"}`;
    case "revisit":
      return reason.detail ? `Revisit on ${plainDay(reason.detail)}` : "Revisit later";
    case "not_a_fit":
      return reason.detail ? `Not a fit: ${reason.detail}` : "Not a fit";
    default:
      return "No reason recorded";
  }
}

/** "3 days", "1 day", or a dash when the contact has no assigned date. */
export function waitingLabel(days: number | null): string {
  if (days == null) return "—";
  return `${days} day${days === 1 ? "" : "s"}`;
}
