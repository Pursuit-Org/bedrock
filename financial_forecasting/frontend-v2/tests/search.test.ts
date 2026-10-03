// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MatchRank,
  fuzzyMatches,
  matchScore,
  matchesQuery,
  normalize,
  rankByQuery,
  searchMatcher,
  squash,
} from "../src/lib/search.ts";

test("normalize strips case, accents, punctuation, extra space", () => {
  assert.equal(normalize("  Nestlé  S.A. "), "nestle s a");
  assert.equal(normalize("O'Brien-Smith"), "o brien smith");
  assert.equal(normalize(null), "");
  assert.equal(squash("J.P. Morgan"), "jpmorgan");
  assert.equal(normalize("北京 Office"), "北京 office");
});

const cases: [string, string[], boolean][] = [
  ["open ai", ["OpenAI"], true],
  ["openai", ["Open AI Foundation"], true],
  ["open-ai", ["OpenAI"], true],
  ["open.ai", ["OpenAI"], true],
  ["OPENAI ", ["OpenAI"], true],
  ["jp morgan", ["JPMorgan Chase"], true],
  ["jpmorgan", ["J.P. Morgan"], true],
  ["j.p. morgan", ["JPMorgan Chase"], true],
  ["at&t", ["AT&T"], true],
  ["att", ["AT&T"], true],
  ["at and t", ["AT&T"], true],
  ["nestle", ["Nestlé"], true],
  ["obrien", ["O'Brien"], true],
  ["o brien", ["O'Brien"], true],
  ["smith john", ["John Smith"], true],
  ["smith, john", ["John Smith"], true],
  ["ryan google", ["Ryan Lee", "Google"], true],
  ["robin hood", ["The Robin Hood Foundation"], true],
  ["pursuit inc", ["Pursuit"], true],
  ["100%", ["100 Women in Finance"], true],
  ["100%", ["Acme"], false],
  ["my_co", ["My Co Holdings"], true],
  ["open ai", ["Anthropic"], false],
  ["nyc", ["New York City Foundation"], false],
];

for (const [q, fields, expected] of cases) {
  test(`"${q}" vs ${JSON.stringify(fields)} → ${expected}`, () => {
    assert.equal(matchesQuery(q, fields), expected);
  });
}

test("empty query matches everything", () => {
  assert.equal(matchesQuery("   ", ["x"]), true);
});

test("ranking: exact > prefix > word prefix > substring > squashed > words", () => {
  assert.equal(matchScore("openai", ["OpenAI"]), MatchRank.Exact);
  assert.equal(matchScore("open", ["OpenAI"]), MatchRank.Prefix);
  assert.equal(matchScore("robin", ["The Robin Hood Foundation"]), MatchRank.WordPrefix);
  assert.equal(matchScore("obin", ["Robin Hood"]), MatchRank.Substring);
  assert.equal(matchScore("openai", ["Friends of Open AI"]), MatchRank.WordPrefix);
  assert.equal(matchScore("openai", ["Reopen AI Lab"]), MatchRank.Squashed);
  assert.equal(matchScore("smith john", ["John Smith"]), MatchRank.Words);
});

test("rankByQuery orders best first, stable within a rank", () => {
  const items = ["Stuart Openai Fans", "OpenAI Fund", "OpenAI", "Open AI Institute"];
  assert.deepEqual(rankByQuery(items, "open ai", (s) => [s]), [
    "OpenAI",
    "OpenAI Fund",
    "Open AI Institute",
    "Stuart Openai Fans",
  ]);
});

test("typo fallback only when nothing matches strictly", () => {
  assert.equal(fuzzyMatches("opnai", ["OpenAI"]), true);
  assert.equal(fuzzyMatches("bloomburg", ["Bloomberg Philanthropies"]), true);
  assert.equal(fuzzyMatches("xyz", ["OpenAI"]), false);
  assert.deepEqual(rankByQuery(["OpenAI", "Anthropic"], "opnai", (s) => [s]), ["OpenAI"]);
  // A strict hit exists, so typo matches are not mixed in.
  assert.deepEqual(rankByQuery(["Bloomberg", "Bloomburg Cafe"], "bloomburg", (s) => [s]), [
    "Bloomburg Cafe",
  ]);
  assert.deepEqual(rankByQuery(["OpenAI"], "opnai", (s) => [s], { fuzzy: false }), []);
});

test("searchMatcher predicate honours strict-then-fuzzy", () => {
  const items = [{ n: "OpenAI" }, { n: "Anthropic" }];
  const m = searchMatcher(items, "open ai", (i) => [i.n]);
  assert.deepEqual(items.filter(m).map((i) => i.n), ["OpenAI"]);
  const f = searchMatcher(items, "anthropik", (i) => [i.n]);
  assert.deepEqual(items.filter(f).map((i) => i.n), ["Anthropic"]);
});
