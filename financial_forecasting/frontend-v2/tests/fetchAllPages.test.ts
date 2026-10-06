// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAllPages } from "../src/lib/fetchAllPages.ts";

/** A fake offset-paged endpoint over `n` rows that records each request. */
function endpoint(n: number) {
  const rows = Array.from({ length: n }, (_, i) => i);
  const calls: [number, number][] = [];
  const fetchPage = async (limit: number, offset: number) => {
    calls.push([limit, offset]);
    return { data: rows.slice(offset, offset + limit), total: n };
  };
  return { fetchPage, calls };
}

test("loads every row across pages, not just the first (PRO-96)", async () => {
  const { fetchPage, calls } = endpoint(7731);
  const res = await fetchAllPages(fetchPage, 2000);
  assert.equal(res.total, 7731);
  assert.equal(res.data.length, 7731);
  assert.deepEqual(res.data.slice(-2), [7729, 7730]);
  assert.deepEqual(calls, [[2000, 0], [2000, 2000], [2000, 4000], [1731, 6000]]);
});

test("one request when everything fits on the first page", async () => {
  const { fetchPage, calls } = endpoint(155);
  const res = await fetchAllPages(fetchPage, 500);
  assert.equal(res.data.length, 155);
  assert.equal(calls.length, 1);
});

test("empty list", async () => {
  const { fetchPage } = endpoint(0);
  assert.deepEqual(await fetchAllPages(fetchPage, 500), { data: [], total: 0 });
});

test("maxRows stops early but still reports the server's total", async () => {
  const { fetchPage, calls } = endpoint(47000);
  const res = await fetchAllPages(fetchPage, 2000, 5000);
  assert.equal(res.data.length, 5000);
  assert.equal(res.total, 47000);
  assert.deepEqual(calls, [[2000, 0], [2000, 2000], [1000, 4000]]);
});

test("a server that returns a short first page is not re-asked", async () => {
  // e.g. the server's own cap is below pageSize: trust what came back.
  const calls: number[] = [];
  const res = await fetchAllPages(async (_limit, offset) => {
    calls.push(offset);
    return { data: [1, 2, 3], total: 10 };
  }, 5);
  assert.deepEqual(calls, [0]);
  assert.equal(res.data.length, 3);
  assert.equal(res.total, 10);
});
