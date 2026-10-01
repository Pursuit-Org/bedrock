/**
 * Shared search matching for the PBD pages' search boxes and pickers.
 *
 * Rules:
 *   0. Normalize: lowercase, strip accents, punctuation → space, trim.
 *   1. Squashed: drop every space/punctuation mark on both sides, then
 *      substring-match ("open ai" → "openai" finds OpenAI).
 *   2. All words, any order: every query word appears in some field
 *      ("smith john" finds John Smith). Filler words (the/and/inc/…)
 *      aren't required when the query has other words.
 *   3. Rank: exact > prefix > word-prefix > substring > squashed > words.
 *   4. Typo fallback: only when 1–2 match nothing across the whole list,
 *      allow a small edit distance per word ("opnai" → OpenAI).
 *
 * Pure module — no React, no path aliases — so it runs under `node --test`.
 */

/** Minimum query length for quick-find pickers that search big lists. */
export const SEARCH_MIN_CHARS = 2;

const FILLER_WORDS = new Set(["the", "and", "inc", "llc", "co", "corp", "ltd"]);

const MARKS = /\p{M}+/gu;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

// Field values repeat across keystrokes, so memoize normalization. Cleared
// wholesale when full — cheap, and bounded memory.
type Keys = { norm: string; squashed: string };
const KEY_CACHE = new Map<string, Keys>();
const KEY_CACHE_MAX = 100_000;
const EMPTY_KEYS: Keys = { norm: "", squashed: "" };

function keysOf(value: unknown): Keys {
  if (value == null) return EMPTY_KEYS;
  const raw = String(value);
  const hit = KEY_CACHE.get(raw);
  if (hit) return hit;
  const norm = raw.normalize("NFKD").replace(MARKS, "").toLowerCase().replace(NON_ALNUM, " ").trim();
  const keys = { norm, squashed: norm.replace(/ /g, "") };
  if (KEY_CACHE.size >= KEY_CACHE_MAX) KEY_CACHE.clear();
  KEY_CACHE.set(raw, keys);
  return keys;
}

/** Lowercase, accent-free, punctuation → single spaces, trimmed. */
export function normalize(value: unknown): string {
  return keysOf(value).norm;
}

/** Normalized with every space removed — "J.P. Morgan" → "jpmorgan". */
export function squash(value: unknown): string {
  return keysOf(value).squashed;
}

export interface ParsedQuery {
  norm: string;
  squashed: string;
  /** Words that must all appear (filler dropped when others remain). */
  words: string[];
}

export function parseQuery(q: string): ParsedQuery {
  const norm = normalize(q);
  const all = norm ? norm.split(" ") : [];
  const meaningful = all.filter((w) => !FILLER_WORDS.has(w));
  return {
    norm,
    squashed: norm.replace(/ /g, ""),
    words: meaningful.length ? meaningful : all,
  };
}

export const MatchRank = {
  None: 0,
  Words: 1,
  Squashed: 2,
  Substring: 3,
  WordPrefix: 4,
  Prefix: 5,
  Exact: 6,
} as const;

/** Does `squashedQuery` start at a word boundary of normalized text `n`? */
function startsAtWord(n: string, squashedQuery: string): boolean {
  for (let i = n.indexOf(" "); i !== -1; i = n.indexOf(" ", i + 1)) {
    if (n.slice(i + 1).replace(/ /g, "").startsWith(squashedQuery)) return true;
  }
  return false;
}

/**
 * How well `fields` match the query — 0 means no match. An empty query
 * matches everything with rank `Words` so callers can filter uniformly.
 */
export function matchScore(query: string | ParsedQuery, fields: readonly unknown[]): number {
  const pq = typeof query === "string" ? parseQuery(query) : query;
  if (!pq.norm) return MatchRank.Words;

  let best: number = MatchRank.None;
  const squashes: string[] = [];
  for (const f of fields) {
    const { norm: n, squashed: s } = keysOf(f);
    if (!n) continue;
    squashes.push(s);
    if (n === pq.norm || s === pq.squashed) return MatchRank.Exact;
    if (best >= MatchRank.Prefix || !s.includes(pq.squashed)) continue;
    // Spacing-insensitive, so "open ai" ranks "OpenAI Fund" as a prefix hit.
    if (s.startsWith(pq.squashed)) best = MatchRank.Prefix;
    else if (best < MatchRank.WordPrefix && startsAtWord(n, pq.squashed)) best = MatchRank.WordPrefix;
    else if (best < MatchRank.Substring && n.includes(pq.norm)) best = MatchRank.Substring;
    else if (best < MatchRank.Squashed) best = MatchRank.Squashed;
  }
  if (best !== MatchRank.None) return best;

  const allWords = pq.words.every((w) => squashes.some((s) => s.includes(w)));
  return allWords ? MatchRank.Words : MatchRank.None;
}

/** Strict match (rules 1–2, no typo fallback). Empty query → true. */
export function matchesQuery(query: string | ParsedQuery, fields: readonly unknown[]): boolean {
  return matchScore(query, fields) > MatchRank.None;
}

function maxTypos(len: number): number {
  if (len < 4) return 0;
  return len < 8 ? 1 : 2;
}

/** Levenshtein distance, bailing out once it exceeds `max`. */
function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** Typo-tolerant match: every query word is within a small edit distance
 *  of some field word (or of a whole squashed field). */
export function fuzzyMatches(query: string | ParsedQuery, fields: readonly unknown[]): boolean {
  const pq = typeof query === "string" ? parseQuery(query) : query;
  if (!pq.norm) return true;
  const candidates: string[] = [];
  for (const f of fields) {
    const { norm, squashed } = keysOf(f);
    if (!norm) continue;
    candidates.push(...norm.split(" "), squashed);
  }
  return pq.words.every((w) => {
    const max = maxTypos(w.length);
    return candidates.some((c) => c.includes(w) || (max > 0 && withinDistance(w, c, max)));
  });
}

export interface SearchOptions {
  /** Fall back to typo tolerance when nothing matches strictly. Default true. */
  fuzzy?: boolean;
}

/**
 * Build a predicate for `items` against `query`. Strict rules first; if
 * nothing in `items` matches and `fuzzy` isn't disabled, the predicate
 * switches to typo tolerance. Use when the search is one filter among
 * several and the caller keeps its own sort order.
 */
export function searchMatcher<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly unknown[],
  opts: SearchOptions = {},
): (item: T) => boolean {
  const pq = parseQuery(query);
  if (!pq.norm) return () => true;
  const hits = new Set<T>();
  for (const it of items) if (matchScore(pq, fields(it)) > MatchRank.None) hits.add(it);
  if (hits.size === 0 && opts.fuzzy !== false) {
    for (const it of items) if (fuzzyMatches(pq, fields(it))) hits.add(it);
  }
  return (item) => hits.has(item);
}

/**
 * Filter `items` by `query`, best matches first (stable within a rank).
 * For pickers and quick-find lists where relevance is the right order.
 */
export function rankByQuery<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly unknown[],
  opts: SearchOptions = {},
): T[] {
  const pq = parseQuery(query);
  if (!pq.norm) return items.slice();
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const score = matchScore(pq, fields(item));
    if (score > MatchRank.None) scored.push({ item, score, i });
  });
  if (scored.length === 0 && opts.fuzzy !== false) {
    return items.filter((item) => fuzzyMatches(pq, fields(item)));
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}
