// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { oppMatchesBucket } from "../src/lib/bucketFilter.ts";
import { BUCKET_OPTIONS, grantPeriodError, isGrantOpp } from "../src/lib/recordTypes.ts";
import { getStageGate } from "../src/lib/stageGates.ts";
import type { SfOpportunity } from "../src/types/salesforce.ts";

const opp = (rt: string | null, philType: string | null = null) =>
  ({ RecordType: rt ? { Name: rt } : null, Philanthropy_Type__c: philType }) as unknown as SfOpportunity;

test("bucket filter: Grant + Donation make up 'philanthropy', Capital Grants excluded", () => {
  assert.equal(oppMatchesBucket(opp("Grant"), "philanthropy"), true);
  assert.equal(oppMatchesBucket(opp("Donation"), "philanthropy"), true);
  assert.equal(oppMatchesBucket(opp("Grant", "Capital Grant"), "philanthropy"), false);
  assert.equal(oppMatchesBucket(opp("PBC"), "philanthropy"), false);
  // The pre-split name no longer means anything.
  assert.equal(oppMatchesBucket(opp("Philanthropy"), "philanthropy"), false);
});

test("bucket filter: single-type buckets", () => {
  assert.equal(oppMatchesBucket(opp("Grant"), "grant"), true);
  assert.equal(oppMatchesBucket(opp("Donation"), "grant"), false);
  assert.equal(oppMatchesBucket(opp("Donation"), "donation"), true);
  assert.equal(oppMatchesBucket(opp("Grant", "Capital Grant"), "capital_grants"), true);
  assert.equal(oppMatchesBucket(opp("PBC"), "pbc"), true);
});

test("bucket filter: 'other' catches everything not Grant/Donation/PBC", () => {
  for (const rt of ["Debt / Equity", "Other Fee For Service", "Other In-Kind", null]) {
    assert.equal(oppMatchesBucket(opp(rt), "other"), true, String(rt));
  }
  for (const rt of ["Grant", "Donation", "PBC"]) {
    assert.equal(oppMatchesBucket(opp(rt), "other"), false, rt);
  }
  assert.equal(oppMatchesBucket(opp("Grant", "Capital Grant"), "other"), false);
});

test("BUCKET_OPTIONS lists every bucket once, with the combined view labelled", () => {
  const values = BUCKET_OPTIONS.map((o) => o.value);
  assert.deepEqual(values, ["all", "philanthropy", "grant", "donation", "pbc", "capital_grants", "other"]);
  assert.equal(BUCKET_OPTIONS.find((o) => o.value === "philanthropy")?.label, "Grant + Donation");
});

test("isGrantOpp", () => {
  assert.equal(isGrantOpp(opp("Grant")), true);
  assert.equal(isGrantOpp(opp("Donation")), false);
  assert.equal(isGrantOpp(null), false);
});

test("grantPeriodError", () => {
  assert.equal(grantPeriodError(null, null), null);
  assert.equal(grantPeriodError("2026-01-01", "2027-12-31"), null);
  assert.equal(grantPeriodError("2026-01-01", "2026-01-01"), null);
  assert.match(grantPeriodError("2026-01-01", null) ?? "", /end date/);
  assert.match(grantPeriodError(null, "2026-01-01") ?? "", /start date/);
  assert.match(grantPeriodError("2026-06-01", "2026-01-01") ?? "", /before/);
});

test("stage gate: Grant entering Collecting requires the grant period", () => {
  const g = getStageGate("Contracting", "Collecting / In Effect", "Grant");
  assert.equal(g?.id, "contracting-to-collecting");
  assert.equal(g?.confirmGrantPeriod, true);
});

test("stage gate: multi-step jump into Collecting keeps the grant period", () => {
  const g = getStageGate("Ask in Progress", "Collecting / In Effect", "Grant");
  assert.equal(g?.id, "multi-step");
  assert.equal(g?.confirmGrantPeriod, true);
});

test("stage gate: non-Grant record types don't get the grant period", () => {
  for (const rt of ["Donation", "PBC", null]) {
    const g = getStageGate("Contracting", "Collecting / In Effect", rt);
    assert.equal(g?.confirmGrantPeriod ?? false, false, String(rt));
  }
});

test("stage gate: Grant moves that don't enter Collecting are unchanged", () => {
  assert.equal(getStageGate("New Lead", "Qualifying", "Grant"), null);
  assert.equal(getStageGate("Proposal Submitted", "Contracting", "Grant")?.confirmGrantPeriod, undefined);
  // Already collecting → no new gate.
  assert.equal(getStageGate("Collecting / In Effect", "Collecting / In Effect", "Grant"), null);
});

test("stage gate: backward Grant move into Collecting asks for dates AND payment schedule", () => {
  const g = getStageGate("Closed / Completed", "Collecting / In Effect", "Grant");
  assert.equal(g?.id, "grant-period");
  assert.equal(g?.confirmGrantPeriod, true);
  assert.equal(g?.confirmPaymentSchedule, true);
});
