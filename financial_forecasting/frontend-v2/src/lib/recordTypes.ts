/**
 * Salesforce Opportunity record types + the dashboard's record-type
 * buckets. Single source of truth on the frontend — mirrors
 * `services/record_type_bucket.py` on the backend.
 *
 * As of 2026-10-22 the former "Philanthropy" record type was renamed
 * "Grant" (same SF Id) and donation-style opps moved to "Donation".
 * See product/crm-architecture/canonical-definitions.md
 * § Opportunity Record Types.
 */
import type { CashflowBucket } from "@/services/cashflow";

export const RT_GRANT = "Grant";
export const RT_DONATION = "Donation";
export const RT_PBC = "PBC";
export const RT_DEBT_EQUITY = "Debt / Equity";
export const RT_OTHER_FFS = "Other Fee For Service";

/** Grant + Donation — what the old "Philanthropy" record type covered. */
export const PHILANTHROPY_RECORD_TYPES: readonly string[] = [RT_GRANT, RT_DONATION];

export const CAPITAL_GRANT_TYPE = "Capital Grant";

/** Pill order + labels for bucket filters (Dashboard, Cash Flow). */
export const BUCKET_OPTIONS: readonly { value: CashflowBucket; label: string }[] = [
  { value: "all",            label: "All" },
  { value: "philanthropy",   label: "Grant + Donation" },
  { value: "grant",          label: "Grant" },
  { value: "donation",       label: "Donation" },
  { value: "pbc",            label: "PBC" },
  { value: "capital_grants", label: "Capital Grants" },
  { value: "other",          label: "Other" },
];

/** True for opportunities on the Grant record type (includes Capital Grants). */
export function isGrantOpp(opp: { RecordType?: { Name?: string | null } | null } | null | undefined): boolean {
  return opp?.RecordType?.Name === RT_GRANT;
}

/** Validation message for a grant period pair, or null when valid.
 *  Both dates optional together; if one is set the other is required,
 *  and the end date can't precede the start. Dates are ISO yyyy-mm-dd
 *  (SF date fields), so string comparison orders correctly. */
export function grantPeriodError(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  if (start && !end) return "Grant end date is also required.";
  if (!start && end) return "Grant start date is also required.";
  if (start && end && end.slice(0, 10) < start.slice(0, 10)) {
    return "Grant end date can't be before the start date.";
  }
  return null;
}
