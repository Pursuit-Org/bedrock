import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appliedFilters, definitionBadge, ignoredFilters, nyDay, nyToday, recordsCount, recordsLabel, windowLine,
} from "../src/components/jobs/metricInfoText.ts";

test("the badge says how settled the words are (PRO-105, decided 10/20)", () => {
  assert.deepEqual(definitionBadge({ source: "dictionary", status: "confirmed" }),
    { label: "Signed off", tone: "settled" });
  assert.equal(definitionBadge({ source: "dictionary", status: "draft" }).label, "Draft");
  // The dictionary can't save yet, so most numbers show their repo draft.
  assert.equal(definitionBadge({ source: "repo_draft", status: "not_in_dictionary" }).label,
    "Draft, not yet in the data dictionary");
  assert.equal(definitionBadge({ source: null, status: "not_in_dictionary" }).tone, "missing");
});

test("New York dates keep their day in any browser timezone", () => {
  assert.equal(nyDay("2026-10-05"), "Mon Oct 5");
  assert.equal(nyDay("2026-10-11", true), "Sun Oct 11, 2026");
  assert.equal(nyToday(new Date("2026-10-21T02:30:00Z")), "2026-10-20");   // 10:30pm in New York
});

test("the window reads as a range, a since, or a moment", () => {
  const base = { window: null, as_of: null, time_anchor: null };
  assert.equal(windowLine({ ...base, window: { from: "2026-10-05", to: "2026-10-11", tz: "America/New_York" } }),
    "Mon Oct 5 – Sun Oct 11, 2026, New York time");
  assert.equal(windowLine({ ...base, window: { from: "2025-12-29", to: "2026-01-04", tz: "America/New_York" } }),
    "Mon Dec 29, 2025 – Sun Jan 4, 2026, New York time");
  assert.equal(windowLine({ ...base, window: { from: "2026-09-22", to: null, tz: "America/New_York" } }),
    "Since Tue Sep 22, to now");
  assert.equal(windowLine({ ...base, as_of: "2026-09-27" }, "2026-10-20"), "As of the end of Sun Sep 27, 2026");
  assert.equal(windowLine({ ...base, as_of: "2026-10-20" }, "2026-10-20"), "As of today");
  assert.equal(windowLine({ ...base, time_anchor: "as of today" }), "As of today");
  assert.equal(windowLine(base), null);
});

test("filters read in words; ignored ones say why", () => {
  assert.deepEqual(appliedFilters({ filters: { scope: "team", segment: "L3 - March 2025" } }),
    ["Whose activity: the Jobs team", "Cohort: L3 - March 2025"]);
  assert.deepEqual(ignoredFilters({ ignored: { job_type: "Paid work counts every job type" } }),
    [{ label: "Job type", why: "Paid work counts every job type" }]);
  assert.deepEqual(ignoredFilters({ ignored: {} }), []);
});

test("View records counts the number, or what an average is over", () => {
  const rec = { endpoint: "/api/jobs/metrics/placements" };
  assert.equal(recordsLabel({ value: 1234, records: rec }), "View records (1,234)");
  assert.equal(recordsCount({ value: 76821, records: { ...rec, count: 14 } }), 14);
  assert.equal(recordsLabel({ value: 5, records: null }), null);
});
