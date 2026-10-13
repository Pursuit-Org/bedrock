// Run: npm run test  (node --test, native TypeScript stripping)
// PRO-100: the campaign Sankey's "contacted" is the row's and the Activation
// card's, and every label lists exactly the contacts its number counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inBucket, pipelineCounts, pipelineLinks, PIPELINE_STAGES, type PipelineBucket,
} from "../src/components/jobs/campaignBuckets.ts";

// Six pipeline contacts: two contacted in outreach, one converted with no
// activity (an intro), one ruled out untouched, one worked and still at
// Assigned, one at Scheduling (once dropped from every campaign view).
const CONTACTS = [
  { stage: "initial_outreach", contacted: true },
  { stage: "initial_outreach", contacted: true },
  { stage: "converted_to_opportunity", contacted: false },
  { stage: "not_a_fit", contacted: false },
  { stage: "assigned", contacted: true },
  { stage: "scheduling", contacted: false },
];

function totals(rows: typeof CONTACTS) {
  const stages: Record<string, number> = {};
  const stages_contacted: Record<string, number> = {};
  for (const r of rows) {
    stages[r.stage] = (stages[r.stage] ?? 0) + 1;
    if (r.contacted) stages_contacted[r.stage] = (stages_contacted[r.stage] ?? 0) + 1;
  }
  return { in_pipeline: rows.length, contacted: rows.filter((r) => r.contacted).length, stages, stages_contacted };
}

test("contacted is the backend's number, not a stage rule", () => {
  const c = pipelineCounts(totals(CONTACTS));
  assert.equal(c.all, 6);
  assert.equal(c.contacted, 3);
  assert.equal(c.not_contacted, 3);
});

test("every label lists exactly the contacts its number counts", () => {
  const t = totals(CONTACTS);
  const counts = pipelineCounts(t);
  const buckets: PipelineBucket[] = ["all", "contacted", "not_contacted", ...PIPELINE_STAGES];
  for (const b of buckets) {
    assert.equal(CONTACTS.filter((c) => inBucket(b, c)).length, counts[b], b);
  }
});

test("ribbons out of each split add up to the node they leave", () => {
  const t = totals(CONTACTS);
  const links = pipelineLinks(t);
  const out = (from: PipelineBucket) => links.filter((l) => l.from === from).reduce((n, l) => n + l.value, 0);
  assert.equal(out("all"), 6);
  assert.equal(out("contacted"), 3);
  assert.equal(out("not_contacted"), 3);
  // Both branches can feed a stage: worked-but-Assigned, untouched-but-Not-a-fit.
  assert.ok(links.some((l) => l.from === "contacted" && l.to === "assigned"));
  assert.ok(links.some((l) => l.from === "not_contacted" && l.to === "not_a_fit"));
  assert.ok(links.every((l) => l.value > 0));
});

test("on_hold reads as revisit", () => {
  assert.ok(inBucket("revisit", { stage: "on_hold", contacted: false }));
});
