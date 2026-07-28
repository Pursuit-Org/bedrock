import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Search, User, TrendingUp, X } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface SfRecord {
  Id: string;
  Name?: string;
  // Contact
  Email?: string;
  Title?: string;
  Account?: { Name?: string };
  // Opportunity
  StageName?: string;
  Amount?: number;
  Owner?: { Name?: string };
  // Account
  Type?: string;
}

interface SearchResults {
  Contact: SfRecord[];
  Account: SfRecord[];
  Opportunity: SfRecord[];
  Task: SfRecord[];
}

interface ResultItem {
  id: string;
  label: string;
  sub: string | null;
  href: string;
  group: "Accounts" | "Contacts" | "Opportunities";
  icon: React.ReactNode;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A bedrock/jobs contact (public.contacts) — not necessarily in Salesforce. */
interface BedrockContact {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
}

function buildItems(results: SearchResults, bedrockContacts: BedrockContact[]): ResultItem[] {
  const items: ResultItem[] = [];

  for (const r of results.Account ?? []) {
    items.push({
      id: r.Id,
      label: r.Name ?? r.Id,
      sub: r.Type ?? null,
      href: `/accounts/${r.Id}`,
      group: "Accounts",
      icon: <Building2 size={13} className="text-ink-3" />,
    });
  }

  // SF contacts first; track their emails so we don't double-list a person who
  // exists both in Salesforce and in the bedrock/jobs contact set.
  const sfEmails = new Set<string>();
  for (const r of results.Contact ?? []) {
    if (r.Email) sfEmails.add(r.Email.toLowerCase());
    items.push({
      id: r.Id,
      label: r.Name ?? r.Id,
      sub: [r.Title, r.Account?.Name].filter(Boolean).join(" · ") || null,
      href: `/contacts/${r.Id}`,
      group: "Contacts",
      icon: <User size={13} className="text-ink-3" />,
    });
  }
  // Bedrock/jobs contacts (the 32k+ in public.contacts) — SF-only search missed
  // these. Deep-link to the jobs Prospects tab with the search pre-filled.
  for (const c of bedrockContacts) {
    if (c.email && sfEmails.has(c.email.toLowerCase())) continue;
    const name = c.full_name ?? c.email ?? `#${c.contact_id}`;
    items.push({
      id: `bedrock-${c.contact_id}`,
      label: name,
      sub: [c.current_title, c.current_company].filter(Boolean).join(" · ") || c.email || null,
      href: `/jobs/contacts?q=${encodeURIComponent(c.email || name)}`,
      group: "Contacts",
      icon: <User size={13} className="text-ink-3" />,
    });
  }

  for (const r of results.Opportunity ?? []) {
    items.push({
      id: r.Id,
      label: r.Name ?? r.Id,
      sub: [r.StageName, r.Account?.Name].filter(Boolean).join(" · ") || null,
      href: `/opportunities/${r.Id}`,
      group: "Opportunities",
      icon: <TrendingUp size={13} className="text-ink-3" />,
    });
  }

  return items;
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function GlobalSearch({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardNavRef = useRef(false);
  const navigate = useNavigate();

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setItems([]);
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Close on Escape; lock page scroll while open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const q = encodeURIComponent(query.trim());
      try {
        // Search Salesforce + bedrock/jobs contacts in parallel; either can fail
        // independently without sinking the other.
        const [sf, bedrock] = await Promise.all([
          api
            .get<SearchResults>(`/api/salesforce/search?q=${q}&limit=8`)
            .then((r) => r.data)
            .catch(() => ({ Contact: [], Account: [], Opportunity: [], Task: [] } as SearchResults)),
          api
            .get<{ success: boolean; data: BedrockContact[] }>(`/api/jobs/contacts/search?q=${q}&limit=8`)
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
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      keyboardNavRef.current = true;
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      keyboardNavRef.current = true;
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[activeIdx]) {
      go(items[activeIdx].href);
    }
  };

  // Only scroll active item into view on keyboard navigation, never on mouse hover.
  useEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const go = (href: string) => {
    navigate(href);
    onClose();
  };

  if (!open) return null;

  // Group items for display
  const groups: { label: string; items: ResultItem[] }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!seen.has(item.group)) {
      seen.add(item.group);
      groups.push({ label: item.group, items: [] });
    }
    groups[groups.length - 1].items.push(item);
  }

  // Flat index → item (for activeIdx highlighting)
  let flatIdx = 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-ink/20 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed left-1/2 top-[18%] z-50 w-full max-w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl">
        {/* Input row */}
        <div className="flex items-center gap-3 border-b border-border-strong px-4 py-3">
          <Search size={15} className="flex-shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search…"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-4"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="flex-shrink-0 text-ink-4 hover:text-ink"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="flex-shrink-0 rounded border border-border-strong px-1.5 py-px text-[10px] text-ink-4">
              esc
            </kbd>
          )}
        </div>

        {/* Results */}
        <div className="max-h-[400px] overflow-y-auto overscroll-contain">
          {loading ? (
            <div className="px-4 py-5 text-center text-[12.5px] text-ink-3">
              Searching…
            </div>
          ) : query.trim().length < 2 ? (
            <div className="px-4 py-5 text-center text-[12.5px] text-ink-4">
              Type at least 2 characters
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-5 text-center text-[12.5px] text-ink-3">
              No results for <span className="font-medium text-ink">"{query}"</span>
            </div>
          ) : (
            <ul ref={listRef}>
              {groups.map((group) => (
                <li key={group.label}>
                  <div className="px-4 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const idx = flatIdx++;
                    const isActive = idx === activeIdx;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => go(item.href)}
                        onMouseEnter={() => setActiveIdx(idx)}
                        className={cn(
                          "flex w-full items-center gap-3 px-4 py-2 text-left",
                          isActive && "bg-surface-2",
                        )}
                      >
                        <span className="flex-shrink-0">{item.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">
                            {item.label}
                          </span>
                          {item.sub ? (
                            <span className="block truncate text-[11.5px] text-ink-3">
                              {item.sub}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        {items.length > 0 ? (
          <div className="flex gap-4 border-t border-border-strong px-4 py-2 text-[10.5px] text-ink-4">
            <span><kbd className="font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono">↵</kbd> open</span>
            <span><kbd className="font-mono">esc</kbd> close</span>
          </div>
        ) : null}
      </div>
    </>
  );
}
