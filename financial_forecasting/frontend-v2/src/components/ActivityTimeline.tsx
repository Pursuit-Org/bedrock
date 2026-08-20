import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Phone,
  Pin,
  PinOff,
  Plus,
  Search,
  X,
} from "lucide-react";

import { ActivitySourceIcon } from "@/components/ActivitySourceIcon";
import { useCollapsible } from "@/lib/collapsible";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/services/auth";
import { useLogCall, type LogCallBody } from "@/services/activities";
import type { BedrockActivity, SfContact, SfOpportunity } from "@/types/salesforce";

// ── Body normalization ─────────────────────────────────────────────────────

const EMAIL_PREVIEW_LENGTH = 800;

/** Strip HTML tags, decode entities, and normalize whitespace. */
function cleanEmailText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function activityTimestamp(a: BedrockActivity): string | null {
  return a.activity_date ?? a.occurred_at ?? a.created_at ?? null;
}

// ── Quick filter chips ─────────────────────────────────────────────────────

type Quick = "all" | "7d" | "30d" | "by-me" | "mentions-me";

const QUICK_OPTS: { value: Quick; label: string }[] = [
  { value: "all", label: "All" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "by-me", label: "By me" },
  { value: "mentions-me", label: "Mentions me" },
];

const ALL_TYPE = "__all_types__";
const ALL_SOURCE = "__all_sources__";

// ── Pin persistence ────────────────────────────────────────────────────────

const PIN_STORAGE_PREFIX = "bedrock-v2:activity-pinned:";

function loadPins(scopeKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_PREFIX + scopeKey);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function savePins(scopeKey: string, ids: Set<string>) {
  try {
    localStorage.setItem(
      PIN_STORAGE_PREFIX + scopeKey,
      JSON.stringify(Array.from(ids)),
    );
  } catch {}
}

// ── Component ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_H = 600;

/**
 * Searchable, AI-summarizable activity timeline with quick filters,
 * pinning, and contact/time grouping toggle.
 *
 * `scopeKey` namespaces persisted state (pins) — pass the account id
 * so different accounts don't share each other's pins. Defaults to
 * "shared" if not provided.
 */
export function ActivityTimeline({
  activities,
  title,
  maxHeight = DEFAULT_MAX_H,
  scopeKey = "shared",
  accountId,
  contacts = [],
  opportunities = [],
}: {
  activities: BedrockActivity[];
  title?: string;
  maxHeight?: number;
  scopeKey?: string;
  accountId?: string;
  contacts?: SfContact[];
  opportunities?: SfOpportunity[];
}) {
  const { open, toggle } = useCollapsible(
    "bedrock-v2:section:activity-timeline",
    true,
  );
  const meQ = useCurrentUser();
  const myEmail = (meQ.data?.email ?? "").toLowerCase();

  // Search + filter state.
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPE);
  const [sourceFilter, setSourceFilter] = useState<string>(ALL_SOURCE);
  const [quick, setQuick] = useState<Quick>("all");

  // Log Call form state
  const [showLogCall, setShowLogCall] = useState(false);
  const logCall = useLogCall(accountId);

  // Pin state — persisted per scope.
  const [pinned, setPinned] = useState<Set<string>>(() => loadPins(scopeKey));
  useEffect(() => { savePins(scopeKey, pinned); }, [scopeKey, pinned]);
  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Activity feed only shows real outreach signal: emails, meetings,
  // calls. Tasks live in their own section above. "Notes" in SF are
  // mostly auto-generated reminders ("Report Due", "[Account Name]")
  // not actual logged interactions, so we drop them too — too noisy
  // to be useful in this context.
  const visibleActivities = useMemo(() => {
    const drop = new Set(["task", "note"]);
    return activities.filter((a) => !drop.has((a.type ?? "").toLowerCase()));
  }, [activities]);

  // Facets.
  const facets = useMemo(() => {
    const types = new Map<string, number>();
    const sources = new Map<string, number>();
    for (const a of visibleActivities) {
      if (a.type) types.set(a.type, (types.get(a.type) ?? 0) + 1);
      if (a.source) sources.set(a.source, (sources.get(a.source) ?? 0) + 1);
    }
    return {
      types: Array.from(types.entries()).sort((a, b) => b[1] - a[1]),
      sources: Array.from(sources.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [visibleActivities]);

  const needle = q.trim().toLowerCase();

  const filtered = useMemo(() => {
    const now = Date.now();
    const dayMs = 86_400_000;
    // Defensive sort: server already orders by activity_date DESC, but
    // resort client-side so manual additions / cache merges can't put
    // older rows on top.
    const sorted = [...visibleActivities].sort((a, b) => {
      const at = activityTimestamp(a);
      const bt = activityTimestamp(b);
      if (!at && !bt) return 0;
      if (!at) return 1;
      if (!bt) return -1;
      return bt.localeCompare(at);
    });
    return sorted.filter((a) => {
      if (typeFilter !== ALL_TYPE && a.type !== typeFilter) return false;
      if (sourceFilter !== ALL_SOURCE && a.source !== sourceFilter) return false;
      if (quick !== "all") {
        const ts = activityTimestamp(a);
        const tsMs = ts ? new Date(ts).getTime() : 0;
        if (quick === "7d" && (!ts || now - tsMs > 7 * dayMs)) return false;
        if (quick === "30d" && (!ts || now - tsMs > 30 * dayMs)) return false;
        if (quick === "by-me") {
          if (!myEmail) return false;
          if ((a.owner_email ?? "").toLowerCase() !== myEmail) return false;
        }
        if (quick === "mentions-me") {
          if (!myEmail) return false;
          const hay = (
            (a.subject ?? "") +
            "\n" + (a.description ?? "") +
            "\n" + (a.email_snippet ?? "") +
            "\n" + (a.email_body_text ?? "")
          ).toLowerCase();
          if (!hay.includes(myEmail)) return false;
        }
      }
      if (!needle) return true;
      const hay = [
        a.subject,
        a.description,
        a.email_snippet,
        a.owner_email,
        a._context_name,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [visibleActivities, typeFilter, sourceFilter, quick, needle, myEmail]);

  // Pinned + non-pinned split.
  const pinnedRows = useMemo(
    () => filtered.filter((a) => pinned.has(a.id)),
    [filtered, pinned],
  );
  const unpinnedRows = useMemo(
    () => filtered.filter((a) => !pinned.has(a.id)),
    [filtered, pinned],
  );

  const heading =
    title ??
    `Activity${
      filtered.length === visibleActivities.length
        ? ` · ${visibleActivities.length}`
        : ` · ${filtered.length} of ${visibleActivities.length}`
    }`;

  const filtersActive =
    needle.length > 0 ||
    typeFilter !== ALL_TYPE ||
    sourceFilter !== ALL_SOURCE ||
    quick !== "all";

  const clearFilters = () => {
    setQ("");
    setTypeFilter(ALL_TYPE);
    setSourceFilter(ALL_SOURCE);
    setQuick("all");
  };

  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="flex items-center border-b border-border-strong bg-surface-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 px-5 py-2.5 text-left text-[12px] font-semibold uppercase tracking-wider text-ink-3"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {heading}
        </button>
        {accountId && (
          <button
            type="button"
            onClick={() => setShowLogCall(true)}
            className="mr-3 flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-1 text-[11px] font-medium text-ink-3 hover:border-accent hover:text-accent"
            title="Log a call"
          >
            <Phone size={11} />
            Log Call
          </button>
        )}
      </div>

      {showLogCall && accountId && (
        <LogCallForm
          accountId={accountId}
          contacts={contacts}
          opportunities={opportunities}
          onClose={() => setShowLogCall(false)}
          onSubmit={async (data) => {
            await logCall.mutateAsync(data);
            setShowLogCall(false);
          }}
          isPending={logCall.isPending}
        />
      )}

      {!open ? null : (
        <>
          {/* Quick filter chips */}
          {visibleActivities.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border-strong bg-surface px-4 py-2">
              {QUICK_OPTS.map((q) => (
                <button
                  key={q.value}
                  type="button"
                  onClick={() => setQuick(q.value)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors",
                    quick === q.value
                      ? "border-accent bg-accent/10 text-ink"
                      : "border-border-strong bg-surface text-ink-3 hover:bg-surface-2",
                    q.value === "by-me" && !myEmail && "opacity-40",
                    q.value === "mentions-me" && !myEmail && "opacity-40",
                  )}
                  disabled={
                    (q.value === "by-me" || q.value === "mentions-me") && !myEmail
                  }
                  title={
                    (q.value === "by-me" || q.value === "mentions-me") && !myEmail
                      ? "Sign in to use this filter"
                      : undefined
                  }
                >
                  {q.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* Search + dropdown filters */}
          {visibleActivities.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface px-4 py-2">
              <div className="flex min-w-[240px] flex-1 items-center gap-2 rounded border border-border-strong bg-surface-2 px-2.5 focus-within:border-accent">
                <Search size={13} className="flex-shrink-0 text-ink-3" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search by contact, email, or content…"
                  className="h-8 flex-1 bg-transparent text-[12.5px] text-ink outline-none"
                />
                {q ? (
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    className="text-ink-3 hover:text-ink"
                    aria-label="Clear search"
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </div>

              {facets.types.length > 1 ? (
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="h-8 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
                  aria-label="Filter by type"
                >
                  <option value={ALL_TYPE}>All types</option>
                  {facets.types.map(([t, n]) => (
                    <option key={t} value={t}>
                      {prettyType(t)} ({n})
                    </option>
                  ))}
                </select>
              ) : null}

              {facets.sources.length > 1 ? (
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="h-8 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
                  aria-label="Filter by source"
                >
                  <option value={ALL_SOURCE}>All sources</option>
                  {facets.sources.map(([s, n]) => (
                    <option key={s} value={s}>
                      {prettySource(s)} ({n})
                    </option>
                  ))}
                </select>
              ) : null}

              {filtersActive ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-[11.5px] text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
                >
                  Clear
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Body */}
          {visibleActivities.length === 0 ? (
            <div className="px-5 py-10 text-center text-[12.5px] text-ink-3">
              No activities logged.
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-10 text-center text-[12.5px] text-ink-3">
              No activities match.{" "}
              <button
                type="button"
                onClick={clearFilters}
                className="text-accent underline-offset-4 hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div
              className="overflow-auto"
              style={{ maxHeight: `${maxHeight}px` }}
            >
              {pinnedRows.length > 0 ? (
                <div>
                  <GroupHeader label={`Pinned · ${pinnedRows.length}`} accent />
                  <ul className="flex flex-col">
                    {pinnedRows.map((a) => (
                      <ActivityRow
                        key={a.id}
                        a={a}
                        showContext
                        needle={needle}
                        pinned
                        onTogglePin={() => togglePin(a.id)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Flat list, sorted by date desc. No grouping — pinned
                  rows already get their own group above. */}
              <ul className="flex flex-col">
                {unpinnedRows.map((a) => (
                  <ActivityRow
                    key={a.id}
                    a={a}
                    showContext
                    needle={needle}
                    pinned={false}
                    onTogglePin={() => togglePin(a.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Log Call Form ──────────────────────────────────────────────────────────

function LogCallForm({
  accountId,
  contacts,
  opportunities,
  onClose,
  onSubmit,
  isPending,
}: {
  accountId: string;
  contacts: SfContact[];
  opportunities: SfOpportunity[];
  onClose: () => void;
  onSubmit: (data: LogCallBody) => Promise<void>;
  isPending: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [subject, setSubject] = useState("Call");
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [contactId, setContactId] = useState("");
  const [opportunityId, setOpportunityId] = useState("");
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstInputRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim()) return;
    await onSubmit({
      account_id: accountId,
      subject: subject.trim(),
      activity_date: date,
      description: description.trim() || undefined,
      contact_id: contactId || undefined,
      opportunity_id: opportunityId || undefined,
    });
  };

  const inputCls =
    "h-8 w-full rounded border border-border-strong bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-accent";

  return (
    <form
      onSubmit={handleSubmit}
      className="border-b border-border-strong bg-surface-2/40 px-5 py-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <Phone size={13} className="text-ink-3" />
        <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
          Log a Call
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Subject */}
        <div className="col-span-2 flex flex-col gap-1">
          <label className="text-[11px] font-medium text-ink-3">Subject</label>
          <input
            ref={firstInputRef}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            className={inputCls}
          />
        </div>

        {/* Date */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-ink-3">Date</label>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            required
            className={inputCls}
          />
        </div>

        {/* Related Contact */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-ink-3">Related Contact</label>
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            className={inputCls}
          >
            <option value="">— None —</option>
            {contacts.map((c) => (
              <option key={c.Id} value={c.Id}>
                {c.Name || `${c.FirstName ?? ""} ${c.LastName ?? ""}`.trim()}
              </option>
            ))}
          </select>
        </div>

        {/* Related Opportunity */}
        {opportunities.length > 0 && (
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-medium text-ink-3">Related Opportunity</label>
            <select
              value={opportunityId}
              onChange={(e) => setOpportunityId(e.target.value)}
              className={inputCls}
            >
              <option value="">— None —</option>
              {opportunities.map((o) => (
                <option key={o.Id} value={o.Id}>
                  {o.Name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Notes */}
        <div className="col-span-2 flex flex-col gap-1">
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium text-ink-3">Notes</span>
            <span className="text-[10.5px] text-ink-4">
              If a Fireflies link is available, please add it to your notes
            </span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Add call notes… or paste a Fireflies link for transcript context"
            className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border-strong bg-surface px-3 py-1.5 text-[12px] text-ink-3 hover:bg-surface-2"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending || !subject.trim()}
          className="flex items-center gap-1.5 rounded bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Logging…" : (
            <><Plus size={12} /> Log Call</>
          )}
        </button>
      </div>
    </form>
  );
}

// ── Section bits ───────────────────────────────────────────────────────────

function GroupHeader({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 border-b border-border-strong px-5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3 backdrop-blur-sm",
        accent ? "bg-accent/10 text-accent" : "bg-surface-2/90",
      )}
    >
      {label}
    </div>
  );
}

// ── Pretty labels ──────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  email: "Email",
  meeting: "Meeting",
  call: "Call",
  task: "Task",
  note: "Note",
  event: "Event",
};

function prettyType(t: string): string {
  return TYPE_LABELS[t.toLowerCase()] ?? capitalize(t);
}

const SOURCE_LABELS: Record<string, string> = {
  salesforce: "Salesforce",
  fireflies: "Fireflies",
  gmail: "Gmail",
  slack: "Slack",
  manual: "Manual",
};

function prettySource(s: string): string {
  return SOURCE_LABELS[s.toLowerCase()] ?? capitalize(s);
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── Context chip ──────────────────────────────────────────────────────────

const CONTEXT_STYLES: Record<
  string,
  { bg: string; text: string; label?: string }
> = {
  opportunity: { bg: "bg-accent/10", text: "text-accent-ink" },
  contact: { bg: "bg-purple-100", text: "text-purple-700" },
  account: { bg: "bg-surface-2", text: "text-ink-3", label: "Account" },
};

function ContextChip({
  type,
  name,
}: {
  type: string | null | undefined;
  name: string | null | undefined;
}) {
  if (!type || type === "account") return null;
  const style = CONTEXT_STYLES[type] ?? CONTEXT_STYLES.account;
  const display = name ?? style.label ?? type;
  return (
    <span
      className={cn(
        "inline-flex max-w-[140px] flex-shrink-0 items-center truncate rounded px-1.5 py-px text-[10.5px] font-medium",
        style.bg,
        style.text,
      )}
      title={display}
    >
      {display}
    </span>
  );
}

// ── Match highlighting ─────────────────────────────────────────────────────

function highlightMatches(text: string, needle: string): React.ReactNode {
  if (!needle || !text) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let last = 0;
  while ((i = lower.indexOf(needle, last)) !== -1) {
    if (i > last) parts.push(text.slice(last, i));
    parts.push(
      <mark
        key={`m-${i}`}
        className="rounded bg-amber-100 px-0.5 text-ink"
      >
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    last = i + needle.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ── Activity row ──────────────────────────────────────────────────────────

function ActivityRow({
  a,
  showContext = false,
  needle = "",
  pinned,
  onTogglePin,
}: {
  a: BedrockActivity;
  showContext?: boolean;
  needle?: string;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  // Manual expand only — search no longer auto-opens rows.
  const [expanded, setExpanded] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const rawBody = a.email_body_text ?? a.email_snippet ?? a.description ?? "";
  const hasBody = rawBody.trim().length > 0;
  const body = hasBody ? cleanEmailText(rawBody) : "";
  const date = fmtDate(activityTimestamp(a));
  // Meetings often have no body but still carry useful detail (location,
  // duration, Fireflies notes if logged on the SF Event description).
  const hasMeetingMeta = !!(a.meeting_location || a.meeting_duration_minutes);
  const isManualCall = a.source === "manual" && a.type === "call";
  // Show chevron when there's content to read, or it's a manual call.
  // The pencil button bypasses this by setting expanded=true directly.
  const isExpandable = hasBody || hasMeetingMeta || isManualCall;

  return (
    <li className="group/row border-b border-border-strong last:border-b-0">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => isExpandable && setExpanded((v) => !v)}
          disabled={!isExpandable}
          className={cn(
            "flex flex-1 items-center gap-3 px-5 py-2.5 text-left",
            isExpandable ? "hover:bg-surface-2" : "cursor-default",
          )}
          aria-expanded={isExpandable ? expanded : undefined}
        >
          <span className="flex-shrink-0 text-ink-3">
            {isExpandable ? (
              expanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : (
              <span className="block h-[14px] w-[14px]" />
            )}
          </span>
          <span className="flex-shrink-0">
            <ActivitySourceIcon source={a.source} type={a.type} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink">
              {highlightMatches(a.subject ?? "(no subject)", needle)}
            </div>
            {hasBody && !expanded ? (
              <div className="line-clamp-1 text-[12px] text-ink-3">
                {highlightMatches(body, needle)}
              </div>
            ) : null}
            {a.owner_email ? (
              <div className="truncate text-[10.5px] text-ink-4">
                {highlightMatches(a.owner_email, needle)}
              </div>
            ) : null}
          </div>
          {showContext && a._context_type && a._context_type !== "account" && (
            <ContextChip type={a._context_type} name={a._context_name} />
          )}
          {a.sf_sync_status === "pending" && (
            <span
              title="Syncing to Salesforce…"
              className="flex-shrink-0 text-amber-400"
            >
              <Clock size={11} />
            </span>
          )}
          {a.sf_sync_status === "failed" && (
            <span
              title="Salesforce sync failed"
              className="flex-shrink-0 text-red-400"
            >
              ⚠
            </span>
          )}
          <div className="mono flex-shrink-0 text-[11px] text-ink-3">{date}</div>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          className={cn(
            "flex-shrink-0 rounded p-1.5 transition-opacity",
            pinned
              ? "text-accent opacity-100"
              : "text-ink-4 opacity-0 hover:text-ink-2 group-hover/row:opacity-100",
          )}
          aria-label={pinned ? "Unpin activity" : "Pin activity"}
          title={pinned ? "Unpin" : "Pin"}
        >
          {pinned ? <Pin size={12} fill="currentColor" /> : <PinOff size={12} />}
        </button>
      </div>
      {expanded && isExpandable ? (
        <div className="border-t border-border-strong bg-surface-2/40 px-5 py-3 pl-[58px] text-[12.5px] leading-relaxed text-ink-2">
          {hasMeetingMeta ? (
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
              {a.meeting_location ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-ink-4">📍</span>
                  <span>{a.meeting_location}</span>
                </span>
              ) : null}
              {a.meeting_duration_minutes ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-ink-4">⏱</span>
                  <span>{a.meeting_duration_minutes} min</span>
                </span>
              ) : null}
            </div>
          ) : null}
          {hasBody ? (
            <>
              <div className="whitespace-pre-wrap break-words">
                {highlightMatches(
                  showFull || body.length <= EMAIL_PREVIEW_LENGTH
                    ? body
                    : body.slice(0, EMAIL_PREVIEW_LENGTH) + "…",
                  needle,
                )}
              </div>
              {body.length > EMAIL_PREVIEW_LENGTH ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowFull((v) => !v); }}
                  className="mt-1.5 text-[11.5px] text-accent hover:underline"
                >
                  {showFull ? "Show less" : "Show more"}
                </button>
              ) : null}
            </>
          ) : isManualCall ? (
            <div className="text-ink-4 italic">No notes logged.</div>
          ) : null}
          {isManualCall && (a.owner_email || a.owner_name) ? (
            <div className="mt-3 text-[11px] text-ink-3">
              Logged by {a.owner_name ?? a.owner_email}
            </div>
          ) : a.owner_email ? (
            <div className="mt-3 text-[11px] text-ink-3">{a.owner_email}</div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
