// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { daysSince, lastActivityDate } from "../src/lib/lastActivity.ts";

test("bedrock date wins when a Gmail reply is newer than SF's logged activity", () => {
  assert.equal(
    lastActivityDate({
      bedrock_last_activity_at: "2026-10-19T16:00:54+00:00",
      Last_Activity_Date__c: "2026-09-16",
      LastActivityDate: "2026-08-01",
    }),
    "2026-10-19T16:00:54+00:00",
  );
});

test("SF date wins when it is newer", () => {
  assert.equal(
    lastActivityDate({ bedrock_last_activity_at: "2026-06-01T10:00:00Z", LastActivityDate: "2026-07-01" }),
    "2026-07-01",
  );
});

test("missing and malformed values are ignored", () => {
  assert.equal(lastActivityDate({}), null);
  assert.equal(lastActivityDate({ bedrock_last_activity_at: "garbage", Last_Activity_Date__c: "2026-01-02" }), "2026-01-02");
});

test("daysSince counts calendar days and never goes negative", () => {
  const today = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(daysSince(iso(today)), 0);
  const fiveAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5);
  assert.equal(daysSince(iso(fiveAgo)), 5);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  assert.equal(daysSince(iso(tomorrow)), 0);
  assert.equal(daysSince(null), null);
});
