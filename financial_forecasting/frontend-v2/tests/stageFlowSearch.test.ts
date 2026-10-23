// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchStageFlow } from "../src/lib/stageFlowSearch.ts";

const row = (key: string, extra: Record<string, unknown> = {}) => ({
  key, label: key, depth: 0, children: null, available: true,
  in_now: { total: 9, cells: [9, 0, 0, 0, 0] }, moved_in: 9, prev_moved_in: 4,
  targetable: true, target_weekly: 5, target_source: "stage", target_source_label: null,
  target: 5, delta: 4, conversion: { on: 3, of: 9 }, ...extra,
});

const member = (band: string, id: string, stage: string, name: string, detail: string | null, bucket = 0) =>
  ({ band, id, stage, name, detail, owner: null, days: 1, bucket });

function payload() {
  return {
    period: { from: "2026-10-17", to: "2026-10-23", days: 7 }, prev_period: { from: "", to: "" },
    buckets: [], stage_labels: {}, targets_available: true, target_scope: "team", team: [],
    bands: [
      { key: "outreach", label: "Outreach", unit: "contacts", rows: [
        row("target_set", { kind: "universe", in_now: { total: 3, cells: null },
          target_set: { processed: ["1"], outstanding: ["7", "8"], by_stage: { initial_outreach: ["1"] } } }),
        row("initial_outreach"),
        row("outreach_sent", { kind: "activity", parent: "initial_outreach", in_now: null, conversion: null }),
      ] },
      { key: "pipeline", label: "Pipeline", unit: "opportunities", rows: [row("active_in_discussions", { conversion: null })] },
    ],
    members: [
      member("outreach", "1", "initial_outreach", "Ada Lovelace", "Duckbill"),
      member("outreach", "2", "initial_outreach", "Grace Hopper", "Acme", 2),
      member("pipeline", "d1", "active_in_discussions", "Duckbill", "SWE Fellow"),
      member("pipeline", "d2", "active_in_discussions", "Acme", "Data role"),
    ],
    moved: [
      { band: "outreach", id: "1", stage: "initial_outreach", name: "Ada Lovelace", detail: "Duckbill", owner: null, at: "2026-10-20", from: null, advanced: true },
      { band: "outreach", id: "2", stage: "initial_outreach", name: "Grace Hopper", detail: "Acme", owner: null, at: "2026-10-20", from: null },
    ],
    activity: [{ row: "outreach_sent", id: "1", n: 3, at: null }, { row: "outreach_sent", id: "2", n: 5, at: null },
               { row: "outreach_sent", id: "7", n: 2, at: null }],
    directory: [{ id: "7", name: "Linus Torvalds", detail: "duckbill " }, { id: "8", name: "Ken Thompson", detail: "Bell Labs" }],
  } as never;
}

const rowsOf = (r: ReturnType<typeof searchStageFlow>) =>
  Object.fromEntries(r!.data.bands.flatMap((b) => b.rows.map((x) => [x.key, x])));

test("an empty search leaves the chart alone", () => {
  assert.equal(searchStageFlow(payload(), "   "), null);
});

test("an account search keeps its contacts and deals and recounts every row", () => {
  const r = searchStageFlow(payload(), "duck")!;
  assert.deepEqual(r.accounts, ["Duckbill"]);
  assert.equal(r.contacts, 2);            // Ada (member) and Linus (directory, same account)
  assert.equal(r.opportunities, 1);
  const rows = rowsOf(r);
  assert.deepEqual(rows.initial_outreach.in_now, { total: 1, cells: [1, 0, 0, 0, 0] });
  assert.equal(rows.initial_outreach.moved_in, 1);
  assert.deepEqual(rows.initial_outreach.conversion, { on: 1, of: 1 });
  assert.equal(rows.outreach_sent.moved_in, 5);   // Ada 3 + Linus 2
  assert.equal(rows.active_in_discussions.in_now!.total, 1);
  // Target List narrows to Ada (processed) and Linus (outstanding, named by the directory).
  assert.deepEqual(rows.target_set.target_set, { processed: ["1"], outstanding: ["7"], by_stage: { initial_outreach: ["1"] } });
  assert.equal(rows.target_set.in_now!.total, 2);
  // Team targets don't scale to one account.
  assert.equal(rows.initial_outreach.target, null);
  assert.equal(rows.initial_outreach.targetable, false);
});

test("a contact's name pulls in the rest of its account", () => {
  const r = searchStageFlow(payload(), "grace")!;
  assert.deepEqual(r.accounts, ["Acme"]);
  assert.deepEqual(r.data.members.map((m) => m.id).sort(), ["2", "d2"]);
});

test("an opportunity title matches the deal and its account", () => {
  const r = searchStageFlow(payload(), "swe fellow")!;
  assert.deepEqual(r.data.members.map((m) => m.id).sort(), ["1", "d1"]);
});

test("no match empties every count", () => {
  const r = searchStageFlow(payload(), "zzz")!;
  assert.equal(r.contacts + r.opportunities, 0);
  assert.equal(rowsOf(r).initial_outreach.in_now!.total, 0);
  assert.equal(rowsOf(r).target_set.in_now!.total, 0);
});
