/**
 * The words and groupings on the Thursday Pipeline view (PRO-110), kept apart
 * from the components so they can be tested on their own.
 */
import type {
  OppState, ThursdayAccount, ThursdayDealType, ThursdayLostReason, ThursdayOpportunity,
} from "@/services/jobs";

export const STATE_LABEL: Record<OppState, string> = {
  active: "Active",
  stalled: "Stalled",
  slow: "Slow but active",
};

/** Full-time first: it is the default (Avni, Kwame). */
export const DEAL_TYPE_CHOICES: { key: ThursdayDealType; label: string; title: string }[] = [
  { key: "ft", label: "Full-time", title: "Full-time opportunities" },
  { key: "pt_contract", label: "Part-time and contract", title: "Part-time and contract opportunities" },
  { key: "all", label: "All", title: "Every type, and opportunities with none" },
];

const ACTIVITY_LABEL: Record<string, string> = {
  email: "Email", call: "Call", meeting: "Meeting", linkedin: "LinkedIn", text: "Text",
};

/** "9/14": a timestamp's day in New York, the day the team saw it. */
export function nyDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", timeZone: "America/New_York",
  });
}

/** "Nov 1" from a YYYY-MM-DD date, the same day in every browser timezone. */
export function plainDay(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

/** "Email 9/14 by Avni Nahar". */
export function lastActivityLine(
  a: ThursdayOpportunity["last_activity"], nameOf: (email: string | null) => string,
): string {
  if (!a) return "No activity recorded";
  const kind = (a.type && ACTIVITY_LABEL[a.type]) || "Activity";
  return `${kind} ${nyDay(a.at)}${a.by ? ` by ${nameOf(a.by)}` : ""}`;
}

/** Days since anything moved: activity, a stage move or creation. Not the
 *  last activity's age, which can be older when the stage moved since. */
export function idleText(days: number | null): string {
  return days == null ? "Nothing recorded" : `${days}d since anything moved`;
}

/** Stored 5 is P1, the mapping used everywhere priority is shown. */
export function priorityLabel(stored: number): string {
  return `P${6 - stored}`;
}

/** The owner's mark, or what is left of it after the check-again date. */
export function slowLine(slow: NonNullable<ThursdayOpportunity["slow"]>): string {
  return slow.lapsed
    ? `Marked slow but active until ${plainDay(slow.check_again)}: ${slow.reason}`
    : `Check again ${plainDay(slow.check_again)}`;
}

/** Rows grouped by owner, each owner's best priority first, then by name.
 *  `rows` arrive in the order to show them. */
export function byOwner<T extends { owner: string | null; priority: number | null }>(
  rows: T[], nameOf: (email: string | null) => string,
): { owner: string | null; rows: T[] }[] {
  const groups = new Map<string, { owner: string | null; rows: T[] }>();
  for (const r of rows) {
    const k = (r.owner ?? "").toLowerCase();
    if (!groups.has(k)) groups.set(k, { owner: r.owner, rows: [] });
    groups.get(k)!.rows.push(r);
  }
  const best = (g: { rows: T[] }) => Math.max(...g.rows.map((r) => r.priority ?? 0));
  return [...groups.values()].sort((a, b) =>
    best(b) - best(a) || nameOf(a.owner).localeCompare(nameOf(b.owner)));
}

const STATE_ORDER: Record<OppState, number> = { stalled: 0, slow: 1, active: 2 };

/** Open opportunities rolled up by account (D9), by account name; within an
 *  account, stalled first, then slow but active, then active. */
export function byAccount(
  opps: ThursdayOpportunity[], accounts: ThursdayAccount[],
): { key: string; name: string; account: ThursdayAccount | null; rows: ThursdayOpportunity[] }[] {
  const meta = new Map(accounts.map((a) => [a.account_key, a]));
  const groups = new Map<string, ThursdayOpportunity[]>();
  for (const o of opps) {
    if (!groups.has(o.account_key)) groups.set(o.account_key, []);
    groups.get(o.account_key)!.push(o);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      name: rows[0].account || "No account",
      account: meta.get(key) ?? null,
      rows: [...rows].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
        || (b.idle_days ?? 0) - (a.idle_days ?? 0)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "4 of 34 have no reason. …", or null when every one has a reason. */
export function noReasonLine(groups: ThursdayLostReason[]): string | null {
  const total = groups.reduce((n, g) => n + g.count, 0);
  const none = groups.find((g) => g.key === null)?.count ?? 0;
  if (!none) return null;
  return `${none} of ${total} have no reason. A reason is now required to close an opportunity as lost.`;
}

/** "3 opportunities" / "1 opportunity". */
export function opportunities(n: number): string {
  return `${n} opportunit${n === 1 ? "y" : "ies"}`;
}
