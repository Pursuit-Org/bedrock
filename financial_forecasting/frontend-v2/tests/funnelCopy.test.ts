// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { funnelSubtitle } from "../src/components/jobs/funnelCopy.ts";

test("snapshot subtitle describes current counts, not 30-day transitions (OVR-09)", () => {
  const s = funnelSubtitle("opportunities", false);
  assert.doesNotMatch(s, /transition|30d|last 30/i);
  assert.match(s, /now/);
});

test("period subtitle names the window", () => {
  assert.equal(
    funnelSubtitle("opportunities", true, "Sep 28 – Oct 4"),
    "companies that entered each stage · Sep 28 – Oct 4",
  );
  assert.equal(funnelSubtitle("prospects", true), "contacts that entered each stage");
});
