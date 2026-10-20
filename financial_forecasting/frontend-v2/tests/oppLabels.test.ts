// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLOSED_LOST_LABELS, PRIORITY_OPTIONS, closedLostLabel, untitledOppHeading } from "../src/components/jobs/oppLabels.ts";

test("closed-lost reasons render as words (PLN-03)", () => {
  assert.equal(closedLostLabel("no_response"), "Went cold");
  assert.equal(closedLostLabel("hired_elsewhere"), "Hired elsewhere");
  // An unknown code still shows something rather than blank.
  assert.equal(closedLostLabel("brand_new_code"), "brand_new_code");
});

test("every backend closed-lost reason has a label", () => {
  const src = readFileSync(fileURLToPath(new URL("../../routes/jobs.py", import.meta.url)), "utf8");
  const block = src.match(/^CLOSED_LOST_REASONS = \[([\s\S]*?)^\]/m);
  assert.ok(block, "CLOSED_LOST_REASONS not found in routes/jobs.py");
  const codes = [...block[1].matchAll(/\("([a-z_]+)",/g)].map((m) => m[1]);
  assert.ok(codes.length >= 8);
  for (const code of codes) assert.ok(code in CLOSED_LOST_LABELS, `no label for ${code}`);
});

test("an untitled opportunity is named by its account (PLN-03)", () => {
  assert.equal(untitledOppHeading("Airbnb"), "Airbnb opportunity");
  assert.equal(untitledOppHeading("  "), "Untitled opportunity");
  assert.equal(untitledOppHeading(null), "Untitled opportunity");
});

test("P1 is stored as 5 on every priority picker (PRO-110)", () => {
  assert.equal(PRIORITY_OPTIONS.find((o) => o.label.startsWith("P1"))?.value, "5");
  assert.equal(PRIORITY_OPTIONS.find((o) => o.label.startsWith("P5"))?.value, "1");
  // No page keeps its own list: the opportunity page stored 1 for "P1".
  const page = readFileSync(fileURLToPath(new URL("../src/pages/jobs/JobsOpportunityDetail.tsx", import.meta.url)), "utf8");
  assert.ok(!/PRIORITY_OPTIONSs*=/.test(page));
});
