import { test } from "node:test";
import assert from "node:assert/strict";

import {
  followUpLine, share, stuckReasonText, vsTarget, waitingLabel,
} from "../src/components/jobs/outreachText.ts";

test("on goal or over is green, under is red, no goal is neither (PRO-106)", () => {
  assert.equal(vsTarget(45, 45), "met");
  assert.equal(vsTarget(50, 45), "met");
  assert.equal(vsTarget(44, 45), "short");
  assert.equal(vsTarget(0, null), "none");
  assert.equal(vsTarget(3, undefined), "none");
  // A goal of zero is a goal, met by doing nothing.
  assert.equal(vsTarget(0, 0), "met");
});

test("a share has nothing to divide by when nothing was assigned", () => {
  assert.equal(share(36, 116), 31);
  assert.equal(share(0, 0), null);
});

test("the follow-up line counts both halves of outreach", () => {
  assert.equal(followUpLine({ new: 12, follow_up: 3 }), "12 new · 3 follow-ups on open opportunities");
  assert.equal(followUpLine({ new: 1, follow_up: 1 }), "1 new · 1 follow-up on open opportunities");
});

test("why a contact is waiting, from what is recorded", () => {
  assert.equal(stuckReasonText({ kind: "intro", detail: "Nick Ferrer" }), "Waiting on an intro from Nick Ferrer");
  assert.equal(stuckReasonText({ kind: "revisit", detail: "2026-11-01" }), "Revisit on Nov 1");
  assert.equal(stuckReasonText({ kind: "revisit", detail: null }), "Revisit later");
  assert.equal(stuckReasonText({ kind: "not_a_fit", detail: "No tech roles" }), "Not a fit: No tech roles");
  assert.equal(stuckReasonText({ kind: "none", detail: null }), "No reason recorded");
});

test("days waiting", () => {
  assert.equal(waitingLabel(1), "1 day");
  assert.equal(waitingLabel(20), "20 days");
  assert.equal(waitingLabel(null), "—");
});
