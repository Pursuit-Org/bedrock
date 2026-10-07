// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callNotReady, callRequestFields, localTodayIso, newCallDetails,
} from "../src/components/jobs/callLog.ts";

test("today is the local day, not the UTC one", () => {
  // 9:30pm on Oct 7 local time is already Oct 8 in UTC west of Greenwich.
  assert.equal(localTodayIso(new Date(2026, 9, 7, 21, 30)), "2026-10-07");
  assert.equal(localTodayIso(new Date(2026, 0, 3, 0, 5)), "2026-01-03");
});

test("a new call is booked today, held unknown, no type yet", () => {
  assert.deepEqual(newCallDetails(new Date(2026, 9, 7, 10)), { kind: null, booked: "2026-10-07", held: "" });
});

test("a call needs a type once the database can store one", () => {
  const d = { kind: null, booked: "2026-10-07", held: "" };
  assert.equal(callNotReady(d, true, "2026-10-07"), "Pick a call type");
  // Before the call-kind migration the picker is disabled; don't block the log.
  assert.equal(callNotReady(d, false, "2026-10-07"), null);
  assert.equal(callNotReady({ ...d, kind: "discovery" }, true, "2026-10-07"), null);
});

test("booked is required, not in the future, and not after the call", () => {
  const d = { kind: "general" as const, booked: "2026-10-07", held: "" };
  assert.match(callNotReady({ ...d, booked: "" }, true, "2026-10-07") ?? "", /booked/);
  assert.match(callNotReady({ ...d, booked: "2026-10-08" }, true, "2026-10-07") ?? "", /future/);
  assert.match(callNotReady({ ...d, held: "2026-10-06" }, true, "2026-10-07") ?? "", /before it was booked/);
  // Held next week is fine: a call booked today for later.
  assert.equal(callNotReady({ ...d, held: "2026-10-14" }, true, "2026-10-07"), null);
});

test("an empty held day is the booked day", () => {
  assert.deepEqual(callRequestFields({ kind: "discovery", booked: "2026-10-01", held: "" }),
                   { call_kind: "discovery", booked_at: "2026-10-01", activity_date: "2026-10-01" });
  assert.equal(callRequestFields({ kind: "general", booked: "2026-10-01", held: "2026-10-05" }).activity_date,
               "2026-10-05");
});
