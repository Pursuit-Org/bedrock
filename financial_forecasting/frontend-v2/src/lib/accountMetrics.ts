/**
 * Per-account roll-ups derived from the Opportunity list. Used by the
 * Accounts page table and the Cleanup → Accounts tab so both views
 * agree on Open Pipeline / Amount Won / Received / Outstanding.
 *
 * Outstanding is `max(0, amountWon - received)` so partial-pay clamps
 * to zero rather than going negative if SF reports overpayment.
 */
import { isOpen, isWon } from "@/lib/stages";
import type { SfOpportunity } from "@/types/salesforce";

/**
 * Canonical record types we expose as separate Lifetime-Won columns.
 * Anything else falls into `wonByRecordType["Other"]`.
 * Source: services/awards_service.py:ELIGIBLE_STAGES_BY_RECORD_TYPE.
 */
export const TRACKED_RECORD_TYPES = [
  "Grant",
  "Donation",
  "PBC",
  "Debt / Equity",
  "Other Fee For Service",
] as const;

export interface AccountMetrics {
  openPipeline: number;
  amountWon: number;
  received: number;
  outstanding: number;
  /** Lifetime won broken out by RecordType.Name. Keys not in
   *  TRACKED_RECORD_TYPES are aggregated under "Other". Always
   *  populated for every tracked type (zero if no won opps). */
  wonByRecordType: Record<string, number>;
}

function emptyWonByRecordType(): Record<string, number> {
  const out: Record<string, number> = { Other: 0 };
  for (const k of TRACKED_RECORD_TYPES) out[k] = 0;
  return out;
}

export const ZERO_ACCOUNT_METRICS: AccountMetrics = {
  openPipeline: 0,
  amountWon: 0,
  received: 0,
  outstanding: 0,
  wonByRecordType: emptyWonByRecordType(),
};

export function buildAccountMetricsMap(
  opps: SfOpportunity[],
): Map<string, AccountMetrics> {
  const m = new Map<string, AccountMetrics>();
  for (const o of opps) {
    const accountId = o.AccountId;
    if (!accountId) continue;
    let cur = m.get(accountId);
    if (!cur) {
      cur = {
        openPipeline: 0,
        amountWon: 0,
        received: 0,
        outstanding: 0,
        wonByRecordType: emptyWonByRecordType(),
      };
      m.set(accountId, cur);
    }
    const amount = o.Amount ?? 0;
    if (isOpen(o)) {
      cur.openPipeline += amount;
    } else if (isWon(o)) {
      cur.amountWon += amount;
      cur.received += o.npe01__Payments_Made__c ?? 0;
      const rt = o.RecordType?.Name ?? "";
      const bucket = (TRACKED_RECORD_TYPES as readonly string[]).includes(rt) ? rt : "Other";
      cur.wonByRecordType[bucket] = (cur.wonByRecordType[bucket] ?? 0) + amount;
    }
  }
  for (const v of m.values()) {
    v.outstanding = Math.max(0, v.amountWon - v.received);
  }
  return m;
}
