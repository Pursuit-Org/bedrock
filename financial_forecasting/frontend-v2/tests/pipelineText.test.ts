import { test } from "node:test";
import assert from "node:assert/strict";

import {
  byAccount, byOwner, idleText, lastActivityLine, noReasonLine, nyDay, opportunities,
  plainDay, priorityLabel, slowLine,
} from "../src/components/jobs/pipelineText.ts";
import type { ThursdayAccount, ThursdayOpportunity } from "../src/services/jobs.ts";

const name = (e: string | null) => (e ? e.split("@")[0] : "—");

function opp(over: Partial<ThursdayOpportunity>): ThursdayOpportunity {
  return {
    opportunity_id: "x", account: "Acme", account_key: "acme", title: null, deal_type: "ft",
    stage: "active_in_discussions", stage_label: "In Discussions", owner: "avni@pursuit.org",
    relationship_owner: null, priority: null, days_in_stage: 3, stage_from_created: false,
    idle_days: 3, last_movement: null, last_stage_change: null, last_activity: null,
    state: "active", slow: null, ...over,
  };
}

test("a day reads as New York's, whatever the browser", () => {
  // 02:00 UTC on 9/15 is still 9/14 in New York.
  assert.equal(nyDay("2026-09-15T02:00:00Z"), "9/14");
  assert.equal(plainDay("2026-11-01"), "Nov 1");
});

test("the last activity says what, when and who", () => {
  assert.equal(lastActivityLine({ at: "2026-09-14T15:00:00Z", type: "email", by: "avni@pursuit.org" }, name),
    "Email 9/14 by avni");
  assert.equal(lastActivityLine({ at: "2026-09-14T15:00:00Z", type: "linkedin", by: null }, name),
    "LinkedIn 9/14");
  assert.equal(lastActivityLine(null, name), "No activity recorded");
});

test("idle days and priority", () => {
  assert.equal(idleText(33), "33d since anything moved");
  assert.equal(idleText(null), "Nothing recorded");
  assert.equal(priorityLabel(5), "P1");
  assert.equal(priorityLabel(1), "P5");
});

test("a slow mark says when to look again, and what it was once it lapses", () => {
  const slow = { reason: "Enterprise cycle", check_again: "2026-11-01", marked_by: null, marked_at: null };
  assert.equal(slowLine({ ...slow, lapsed: false }), "Check again Nov 1");
  assert.equal(slowLine({ ...slow, lapsed: true }), "Marked slow but active until Nov 1: Enterprise cycle");
});

test("owners with a P1 come first", () => {
  const rows = [opp({ owner: "devika@p.org", priority: 3 }), opp({ owner: "avni@p.org", priority: 5 }),
    opp({ owner: "avni@p.org", priority: 4 })];
  const g = byOwner(rows, name);
  assert.deepEqual(g.map((x) => [x.owner, x.rows.length]), [["avni@p.org", 2], ["devika@p.org", 1]]);
});

test("open opportunities roll up by account, stalled first within one", () => {
  const rows = [
    opp({ opportunity_id: "1", account: "Newmark", account_key: "newmark", state: "active" }),
    opp({ opportunity_id: "2", account: "Newmark", account_key: "newmark", state: "stalled", idle_days: 40 }),
    opp({ opportunity_id: "3", account: "Burbio", account_key: "burbio" }),
  ];
  const accounts: ThursdayAccount[] = [{ account_key: "newmark", account: "Newmark", state: "stalled",
    last_contact_touch: null, last_opportunity_move: null, idle_days: 50, opportunity_ids: ["1", "2"] }];
  const g = byAccount(rows, accounts);
  assert.deepEqual(g.map((x) => x.name), ["Burbio", "Newmark"]);
  assert.deepEqual(g[1].rows.map((r) => r.opportunity_id), ["2", "1"]);
  assert.equal(g[1].account?.state, "stalled");
  assert.equal(g[0].account, null);
});

test("lost reasons say how many have none", () => {
  const g = [{ key: "budget", label: "No budget", count: 30, rows: [] },
    { key: null, label: "No reason given", count: 4, rows: [] }];
  assert.equal(noReasonLine(g), "4 of 34 have no reason. A reason is now required to close an opportunity as lost.");
  assert.equal(noReasonLine(g.slice(0, 1)), null);
  assert.equal(opportunities(1), "1 opportunity");
  assert.equal(opportunities(2), "2 opportunities");
});
