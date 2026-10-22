/**
 * Client-side record-type bucket filter for opportunities.
 * Same buckets as the backend (`services/record_type_bucket.py`).
 */
import type { SfOpportunity } from "@/types/salesforce";
import type { CashflowBucket } from "@/services/cashflow";
import {
  CAPITAL_GRANT_TYPE,
  PHILANTHROPY_RECORD_TYPES,
  RT_DONATION,
  RT_GRANT,
  RT_PBC,
} from "@/lib/recordTypes";

export function filterByBucket(
  opps: SfOpportunity[],
  bucket: CashflowBucket,
): SfOpportunity[] {
  if (bucket === "all") return opps;
  return opps.filter((o) => oppMatchesBucket(o, bucket));
}

export function oppMatchesBucket(
  o: SfOpportunity,
  bucket: CashflowBucket,
): boolean {
  const rt = o.RecordType?.Name ?? "";
  const isCapital = (o.Philanthropy_Type__c ?? "") === CAPITAL_GRANT_TYPE;
  switch (bucket) {
    case "philanthropy":
      return PHILANTHROPY_RECORD_TYPES.includes(rt) && !isCapital;
    case "grant":
      return rt === RT_GRANT && !isCapital;
    case "donation":
      return rt === RT_DONATION && !isCapital;
    case "capital_grants":
      return isCapital;
    case "pbc":
      return rt === RT_PBC;
    case "other":
      return !PHILANTHROPY_RECORD_TYPES.includes(rt) && rt !== RT_PBC && !isCapital;
    default:
      return true;
  }
}
