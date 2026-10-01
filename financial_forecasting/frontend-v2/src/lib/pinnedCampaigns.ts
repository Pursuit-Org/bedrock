import { useCallback, useState } from "react";

/**
 * Campaigns the user has pinned to the top of the picker.
 *
 * Deliberately localStorage rather than the catalog's `sort_order`: that field
 * is the TEAM's outreach priority, edited by dragging the campaign list, and
 * one person's "I open this twenty times a day" is not a reason to reorder
 * everyone else's queue. This is a per-browser convenience, so losing it on a
 * new machine costs a click, not a decision.
 *
 * Every read and write is wrapped — storage throws in private windows and
 * returns null when site data is cleared, and a picker that crashes because it
 * cannot remember a preference is worse than one that forgets.
 */
const KEY = "bedrock:jobs:pinnedCampaigns";

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function usePinnedCampaigns() {
  const [pinned, setPinned] = useState<string[]>(read);

  const toggle = useCallback((key: string) => {
    setPinned((prev) => {
      // Newly pinned campaigns go to the end, so pinning something does not
      // reshuffle the ones already there under the user's cursor.
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const isPinned = useCallback((key: string) => pinned.includes(key), [pinned]);
  return { pinned, isPinned, toggle };
}
