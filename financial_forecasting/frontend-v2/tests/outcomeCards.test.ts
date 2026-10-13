import { test } from "node:test";
import assert from "node:assert/strict";

import {
  placedLabel, placedBreakdown, inRoleLine, ofJobReady, pctOf, ringPct,
  committedLine, expectedSalaryLine, salaryBasis,
} from "../src/components/jobs/outcomeCards.ts";

// Production, 10/13: 18 of 59 placed (14 full-time, 4 in a paid trial), all
// in the role; 8 committed roles at $86,660 expected (PRO-99).
const P = { placed_ft: 14, placed_trial: 4, placed_in_role: 18, placed_left: 0 };

test("the headline is Placed, split into full-time and paid trials (OVR-02, D2)", () => {
  assert.equal(placedLabel("full_time"), "Placed");
  assert.equal(placedBreakdown(P, "full_time"), "14 full-time · 4 in a paid trial");
  assert.equal(placedBreakdown({ placed_ft: 3, placed_trial: 0 }, "full_time"), "3 full-time");
});

test("another job type swaps the headline and drops the full-time split (D4)", () => {
  const options = [{ value: "contract", label: "Contract", count: 30 }];
  assert.equal(placedLabel("contract", options), "Placed · Contract");
  assert.equal(placedLabel("internship"), "Placed · internship");
  assert.equal(placedLabel("all"), "Paid work, all types");
  assert.equal(placedBreakdown(P, "contract"), null);
});

test("builders who left still count; the card says how many are still in the role", () => {
  assert.equal(inRoleLine(P), "18 still in the role");
  assert.equal(inRoleLine({ placed_in_role: 15, placed_left: 3 }), "15 still in the role · 3 have left");
});

test("the ring is placed ÷ job-ready", () => {
  assert.equal(ofJobReady(30.5, 59), "30.5% of 59 job-ready");
  assert.equal(pctOf(39, 59), 66.1);
  assert.equal(pctOf(1, 0), 0);
  assert.equal(ringPct(30.5), 31);
  assert.equal(ringPct(null), 0);
  assert.equal(ringPct(140), 100);
});

test("committed roles sit beside Placed, never in it", () => {
  assert.equal(committedLine(8, false), "8 committed roles, not counted");
  assert.equal(committedLine(1, true), "1 committed role, not counted (all cohorts)");
});

test("Avg FT salary is placed-only; committed roles' expected salary is its own line (OVR-04)", () => {
  assert.equal(expectedSalaryLine(86660, 8, false), "Committed roles expect $86,660 avg (8 roles)");
  assert.equal(expectedSalaryLine(86660, 8, true), "Committed roles expect $86,660 avg (8 roles), all cohorts");
  assert.equal(expectedSalaryLine(null, 8, false), null);
  assert.equal(salaryBasis(14), "placed builders only · 14 builders");
});
