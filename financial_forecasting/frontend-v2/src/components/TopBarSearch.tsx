/**
 * Inline global search — lives in the top bar with an anchored
 * dropdown of results. Replaces the modal `GlobalSearch` (still kept
 * around for cmd-K to focus this input). Same data source
 * (/api/salesforce/search), same keyboard nav.
 *
 * Design:
 *   - Input is always visible in the top bar.
 *   - Dropdown portal anchors to the input's bounding rect; opens on
 *     focus when the query has ≥ 2 chars, OR when there are results.
 *   - Click outside / Esc / pick-a-result closes the dropdown.
 *   - ⌘K from anywhere focuses the input (registered globally).
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Clock, Search, X } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Recent searches ─────────────────────────────────────────────────────────
// Persist the user's last N clicked search results in localStorage so the
// empty-input dropdown can surface them — standard enterprise-search UX
// (Notion / Linear / Asana). We store ResultItem-shaped entries so a
// click on a recent navigates directly to the record; no re-query needed.

const RECENTS_KEY = "bedrock:topbar-search-recents";
const MAX_RECENTS = 8;

function readRecents(): ResultItem[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ResultItem =>
        x && typeof x === "object" && typeof x.label === "string" && typeof x.href === "string",
    ).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function writeRecents(items: ResultItem[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)));
  } catch {
    /* private mode — drop silently */
  }
}

function pushRecent(prev: ResultItem[], item: ResultItem): ResultItem[] {
  // Dedupe by href (clicking the same record twice promotes it, doesn't dup).
  const filtered = prev.filter((p) => p.href !== item.href);
  return [item, ...filtered].slice(0, MAX_RECENTS);
}

interface SfRecord {
  Id: string;
  Name?: string;
  Email?: string;
  StageName?: string;
  Amount?: number;
  CloseDate?: string;
  AccountName?: string;
}

interface SearchResults {
  Account?: SfRecord[];
  Contact?: SfRecord[];
  Opportunity?: SfRecord[];
}

interface ResultItem {
  group: string;
  label: string;
  sub?: string | null;
  href: string;
}

/** A bedrock/jobs contact (public.contacts) — not necessarily in Salesforce. */
interface BedrockContact {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
}

function buildItems(results: SearchResults, bedrockContacts: BedrockContact[] = []): ResultItem[] {
  const out: ResultItem[] = [];
  for (const r of results.Account ?? []) {
    out.push({
      group: "Accounts",
      label: r.Name ?? r.Id,
      href: `/accounts/${r.Id}`,
    });
  }
  const sfEmails = new Set<string>();
  for (const r of results.Contact ?? []) {
    if (r.Email) sfEmails.add(r.Email.toLowerCase());
    out.push({
      group: "Contacts",
      label: r.Name ?? r.Id,
      sub: r.Email ?? null,
      href: `/contacts/${r.Id}`,
    });
  }
  // Bedrock/jobs contacts (32k+ in public.contacts, incl. people not in SF).
  // Searches name + email + company, so e.g. "adonis" surfaces its contacts.
  for (const c of bedrockContacts) {
    if (c.email && sfEmails.has(c.email.toLowerCase())) continue;
    const name = c.full_name ?? c.email ?? `#${c.contact_id}`;
    out.push({
      group: "Contacts",
      label: name,
      sub: [c.current_title, c.current_company].filter(Boolean).join(" · ") || c.email || null,
      // Deep-link straight to the contact's detail drawer (opens on arrival).
      href: `/jobs/contacts?contact=${c.contact_id}`,
    });
  }
  for (const r of results.Opportunity ?? []) {
    out.push({
      group: "Opportunities",
      label: r.Name ?? r.Id,
      sub: r.AccountName ?? r.StageName ?? null,
      href: `/opportunities/${r.Id}`,
    });
  }
  return out;
}

const PANEL_WIDTH = 480;
const PANEL_MARGIN = 6;

export function TopBarSearch() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [recents, setRecents] = useState<ResultItem[]>(() => readRecents());

  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();

  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);

  // ⌘K / Ctrl-K — focus the input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Position the dropdown under the input, matching width.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const width = Math.max(rect.width, 360);
      let left = rect.left;
      // Clamp to viewport — extend leftward if the input is near the right edge.
      if (left + width > vw - PANEL_MARGIN) {
        left = Math.max(PANEL_MARGIN, vw - width - PANEL_MARGIN);
      }
      setCoords({ top: rect.bottom + PANEL_MARGIN, left, width });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, items.length, query]);

  // Close on outside click. Both trigger and portal need to count as "inside".
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Debounced API search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const qs = encodeURIComponent(query.trim());
      try {
        // SF + bedrock/jobs contacts in parallel; each fails independently so a
        // Salesforce hiccup (e.g. not connected) still shows bedrock contacts.
        const [sf, bedrock] = await Promise.all([
          api.get<SearchResults>(`/api/salesforce/search?q=${qs}&limit=8`)
            .then((r) => r.data)
            .catch(() => ({ Account: [], Contact: [], Opportunity: [] } as SearchResults)),
          api.get<{ success: boolean; data: BedrockContact[] }>(`/api/jobs/contacts/search?q=${qs}&limit=8`)
            .then((r) => r.data.data)
            .catch(() => [] as BedrockContact[]),
        ]);
        setItems(buildItems(sf, bedrock));
        setActiveIdx(0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function go(item: ResultItem | string) {
    // Accept either a ResultItem (so we can persist the recent) or a
    // raw href string (for legacy callers).
    if (typeof item === "object") {
      const next = pushRecent(recents, item);
      setRecents(next);
      writeRecents(next);
      navigate(item.href);
    } else {
      navigate(item);
    }
    setOpen(false);
    setQuery("");
    setItems([]);
    inputRef.current?.blur();
  }

  function clearRecents() {
    setRecents([]);
    writeRecents([]);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setQuery("");
      setItems([]);
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[activeIdx]) {
      e.preventDefault();
      go(items[activeIdx]);
    }
  }

  // Group items for display.
  const groups = useMemo(() => {
    const out: { label: string; items: ResultItem[]; offset: number }[] = [];
    let offset = 0;
    for (const item of items) {
      let g = out.find((x) => x.label === item.group);
      if (!g) {
        g = { label: item.group, items: [], offset };
        out.push(g);
      }
      g.items.push(item);
    }
    // Compute flat-offset per group for activeIdx highlighting.
    let cursor = 0;
    for (const g of out) {
      g.offset = cursor;
      cursor += g.items.length;
    }
    return out;
  }, [items]);

  const showRecents = open && query.trim().length === 0 && recents.length > 0;
  const showResults = open && (query.trim().length >= 2 || items.length > 0 || loading);
  const showEmptyHint =
    open && query.trim().length === 0 && recents.length === 0;
  const showDropdown = showRecents || showResults || showEmptyHint;

  return (
    <div ref={wrapperRef} className="relative">
      <div
        className={cn(
          "flex h-7 w-[360px] items-center gap-2 rounded-md border bg-surface-2/60 px-2.5",
          open ? "border-accent bg-surface" : "border-border-strong",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        <Search size={12} className="flex-shrink-0 text-ink-3" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search accounts, contacts, opportunities…"
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-4"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setItems([]);
              inputRef.current?.focus();
            }}
            className="flex-shrink-0 text-ink-4 hover:text-ink"
            aria-label="Clear search"
          >
            <X size={11} />
          </button>
        ) : (
          <kbd className="flex-shrink-0 rounded border border-border-strong bg-surface px-1 py-px text-[10px] text-ink-3">
            ⌘K
          </kbd>
        )}
      </div>

      {showDropdown && coords
        ? createPortal(
            <div
              ref={panelRef}
              className="fixed z-50 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl"
              style={{ top: coords.top, left: coords.left, width: Math.max(coords.width, PANEL_WIDTH) }}
            >
              <div className="max-h-[440px] overflow-y-auto overscroll-contain">
                {showRecents ? (
                  <div className="py-1">
                    <div className="flex items-center justify-between px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={10} aria-hidden /> Recent
                      </span>
                      <button
                        type="button"
                        onClick={clearRecents}
                        className="text-[10px] font-medium normal-case tracking-normal text-ink-4 hover:text-accent"
                      >
                        Clear
                      </button>
                    </div>
                    <ul>
                      {recents.map((item, i) => (
                        <li key={`recent-${item.href}-${i}`}>
                          <button
                            type="button"
                            onClick={() => go(item)}
                            className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2/60"
                          >
                            <span className="flex w-full min-w-0 items-center gap-2">
                              <span className="truncate font-medium text-ink">{item.label}</span>
                              <span className="ml-auto flex-shrink-0 text-[10.5px] uppercase tracking-wider text-ink-4">
                                {item.group}
                              </span>
                            </span>
                            {item.sub ? (
                              <span className="truncate text-[11px] text-ink-3">{item.sub}</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : showEmptyHint ? (
                  <div className="px-4 py-3 text-center text-[12px] text-ink-4">
                    Start typing to search accounts, contacts, opportunities…
                  </div>
                ) : loading ? (
                  <div className="px-4 py-3 text-center text-[12px] text-ink-3">Searching…</div>
                ) : query.trim().length < 2 ? (
                  <div className="px-4 py-3 text-center text-[12px] text-ink-4">
                    Type at least 2 characters
                  </div>
                ) : items.length === 0 ? (
                  <div className="px-4 py-3 text-center text-[12px] text-ink-3">
                    No results for <span className="font-medium text-ink">"{query}"</span>
                  </div>
                ) : (
                  groups.map((g) => (
                    <div key={g.label} className="py-1">
                      <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                        {g.label}
                      </div>
                      <ul>
                        {g.items.map((item, i) => {
                          const flatIdx = g.offset + i;
                          const isActive = flatIdx === activeIdx;
                          return (
                            <li key={`${g.label}-${item.href}`}>
                              <button
                                type="button"
                                onMouseEnter={() => setActiveIdx(flatIdx)}
                                onClick={() => go(item)}
                                className={cn(
                                  "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-[12.5px]",
                                  isActive ? "bg-surface-2" : "hover:bg-surface-2/60",
                                )}
                              >
                                <span className="truncate font-medium text-ink">{item.label}</span>
                                {item.sub ? (
                                  <span className="truncate text-[11px] text-ink-3">{item.sub}</span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
