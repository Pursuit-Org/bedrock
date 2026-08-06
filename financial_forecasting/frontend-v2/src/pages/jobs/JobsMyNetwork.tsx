/**
 * /jobs/network — My Network (staff LinkedIn connections), on its own page
 * (nav: xOrg › My Network). Connections are the current user's LinkedIn imports
 * mapped to Bedrock contacts.
 *
 * The table is a DATA-ENTRY view, not a browsing one: six columns, always ranked
 * by priority band, with three editable cells per row (expect a response, hiring
 * fit, note) that each save on a single click. Last touch, co-connections and the
 * pipeline signals moved into the row expand, which still carries the contact's
 * full Activity / Opportunities / Job listings / Comments tabs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Linkedin, ThumbsDown, ThumbsUp } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { ContactExpandTabs } from "@/components/jobs/jobsEntity";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { useSort, compare } from "@/lib/sort";
import {
  useContactTagCatalog, useMyNetwork, useMyNetworkFacets, useSaveRelationshipContext,
  useSetConnectionStatus, type MyNetworkFacets, type NetworkConnection, type NetworkScope,
} from "@/services/jobs";
import { usePermissions } from "@/services/permissions";
import {
  AddFilterButton, FilterChip, describeRule, ruleApplies,
  type FieldMeta, type FilterRule,
} from "@/pages/cleanup/Filters";

// ── Section label + bordered panel (same shell as the Jobs Home zones) ───────
function Section({ title, count, action, children }: {
  title: string; count?: number; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
          {count != null && <span className="text-[11px] tabular-nums text-ink-4">{count}</span>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// Six columns, in Jac's order (2026-08-05):
// priority | connection (name + title) | company | expect a response | hiring fit | note.
// Last touch / connected / staff / signals were dropped from the table — all of it
// is still one click away in the row expand, and the point of this view is now
// rapid data entry, not browsing.
// The Pursuit scope adds a Tags column; everything else is identical.
const NET_GRID_MINE = "grid grid-cols-[34px_minmax(0,1.9fr)_minmax(0,1.2fr)_92px_92px_minmax(0,1.6fr)] items-center gap-2";
const NET_GRID_PURSUIT = "grid grid-cols-[34px_minmax(0,1.7fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_92px_92px_minmax(0,1.4fr)] items-center gap-2";
const netGrid = (scope: NetworkScope) => (scope === "pursuit" ? NET_GRID_PURSUIT : NET_GRID_MINE);
type NetSortKey = "name" | "company" | "status" | "priority" | "fit" | "note" | "tags";
// The stored vote vocabulary (bedrock.connection_status.status). Legacy spellings
// are still recognised so a row written before the 2026-08-05 rename renders as a
// real vote whether or not the data migration has run yet — the server normalises
// too, this is the belt to its braces.
const VOTE_UP = "expect_response";
const VOTE_DOWN = "dont_expect_response";
const VOTE_NONE = "new";
const LEGACY_UP = "will_reach_out";
const LEGACY_DOWN = "declined";
// Sorting on the vote groups 👍 / no-vote / 👎 in that order. The stored strings
// would sort alphabetically otherwise, which is meaningless to a human scanning
// the column.
const VOTE_RANK: Record<string, number> = {
  [VOTE_UP]: 0, [LEGACY_UP]: 0,
  [VOTE_NONE]: 1,
  [VOTE_DOWN]: 2, [LEGACY_DOWN]: 2,
};
const NET_SORT_VALUE: Record<NetSortKey, (c: NetworkConnection) => unknown> = {
  name: (c) => c.full_name,
  company: (c) => c.current_company,
  status: (c) => VOTE_RANK[c.status] ?? 1,
  // yes first, then unanswered, then no — same shape as VOTE_RANK.
  fit: (c) => (c.hiring_fit === "yes" ? 0 : c.hiring_fit === "no" ? 2 : 1),
  // Rows with a note first; alphabetical within.
  note: (c) => (c.relationship_context ? `0${c.relationship_context.toLowerCase()}` : "1"),
  // Unranked sorts after both bands rather than before "P1" alphabetically.
  priority: (c) => c.priority ?? "ZZ",
  tags: (c) => (c.tags ?? []).slice().sort().join(","),
};

// ── Filters ──────────────────────────────────────────────────────────────────
// The same rule engine the Contacts page uses (pages/cleanup/Filters). These
// four dimensions are the ones the employer-prospect ranking work sliced on;
// Investor is the fifth and needs bedrock.company_investor, which does not exist
// yet — see the plan's deferred section.
type Field =
  | "headcount" | "tristate" | "industry" | "seniority"
  | "company" | "title" | "tags"
  | "is_jobs" | "has_open_opp" | "hired_before" | "warm" | "touched"
  | "expect_response" | "hiring_fit";
const FILTERABLE: Record<Field, FieldMeta<NetworkConnection>> = {
  // firmographics
  headcount: { label: "Headcount", type: "select", getValue: (c) => c.headcount_band ?? "" },
  tristate: { label: "Tri-state presence", type: "select", getValue: (c) => c.tristate ?? "" },
  industry: { label: "Industry", type: "select", getValue: (c) => c.industry ?? "" },
  seniority: { label: "Seniority", type: "select", getValue: (c) => c.seniority ?? "" },
  // the contact themselves
  company: { label: "Company", type: "text", getValue: (c) => c.current_company ?? "" },
  title: { label: "Title", type: "text", getValue: (c) => c.current_title ?? "" },
  tags: { label: "Tags", type: "tags", getValue: (c) => (c.tags ?? []).join(",") },
  // signals — the same three chips the row renders, plus the warmth dot
  is_jobs: { label: "In jobs pipeline", type: "select", getValue: (c) => (c.is_jobs_contact ? "yes" : "no") },
  has_open_opp: { label: "Open opportunity", type: "select", getValue: (c) => (c.has_open_opp ? "yes" : "no") },
  hired_before: { label: "Company hired before", type: "select", getValue: (c) => (c.company_hired_before ? "yes" : "no") },
  warm: { label: "You've been in touch", type: "select", getValue: (c) => (c.warm ? "yes" : "no") },
  touched: { label: "Pursuit has been in touch", type: "select", getValue: (c) => (c.touched ? "yes" : "no") },
  // The caller's own two answers. "" is the unanswered state, so is_empty on these
  // means "still to review" — the filter an exec working the list actually wants.
  expect_response: {
    label: "Expect a response", type: "select",
    getValue: (c) => (c.status === VOTE_UP || c.status === LEGACY_UP ? "yes"
      : c.status === VOTE_DOWN || c.status === LEGACY_DOWN ? "no" : ""),
  },
  hiring_fit: { label: "Hiring fit", type: "select", getValue: (c) => c.hiring_fit ?? "" },
};
const YESNO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];
/** Stable empty default so the tag-catalog fallback doesn't remake the memo. */
const EMPTY_TAGS: { slug: string; label: string }[] = [];
// Ladders, so the menu reads in a sensible order rather than alphabetically
// ("1-10, 1001-5000, 11-50, …"). Values absent from a staff member's network are
// dropped; anything the server returns that we don't know about is appended
// rather than hidden.
const HEADCOUNT_ORDER = ["1-10", "11-50", "51-200", "201-1000", "1001-5000", "5000+"];
const SENIORITY_ORDER = ["Highest", "High", "Medium", "Low", "Lowest"];
const TRISTATE_ORDER = ["Yes", "HQ elsewhere", "Unknown"];
// "Yes" alone would read as a bare claim of presence; name what the data says.
const TRISTATE_LABEL: Record<string, string> = {
  Yes: "Tri-state HQ",
  "HQ elsewhere": "HQ elsewhere",
  Unknown: "Unknown",
};
const SENIORITY_LABEL: Record<string, string> = {
  Highest: "Highest — founder / CEO / owner",
  High: "High — C-suite / EVP / president",
  Medium: "Medium — VP / SVP / head of / MD",
  Low: "Low — director / manager / principal",
  Lowest: "Lowest — everyone else",
};
/** Order `values` by `order`, appending anything unrecognised. */
function byLadder(values: string[], order: string[]): string[] {
  const known = order.filter((v) => values.includes(v));
  return [...known, ...values.filter((v) => !order.includes(v))];
}
function buildSelectOptions(
  facets: MyNetworkFacets | undefined,
  tagCatalog: { slug: string; label: string }[],
): Partial<Record<Field, { value: string; label: string }[]>> {
  const f = facets ?? { headcount: [], industry: [], tristate: [], seniority: [] };
  return {
    headcount: byLadder(f.headcount, HEADCOUNT_ORDER).map((v) => ({ value: v, label: v })),
    tristate: byLadder(f.tristate, TRISTATE_ORDER).map((v) => ({ value: v, label: TRISTATE_LABEL[v] ?? v })),
    seniority: byLadder(f.seniority, SENIORITY_ORDER).map((v) => ({ value: v, label: SENIORITY_LABEL[v] ?? v })),
    industry: [...f.industry].sort().map((v) => ({ value: v, label: v })),
    tags: tagCatalog.map((t) => ({ value: t.slug, label: t.label })),
    // Company and title are free-text "contains" rules — no option list.
    is_jobs: YESNO, has_open_opp: YESNO, hired_before: YESNO, warm: YESNO, touched: YESNO,
    expect_response: YESNO, hiring_fit: YESNO,
  };
}
/** Chip text: turn stored values into what the menu showed. Seniority deliberately
 *  keeps its bare rung ("Highest") — the explanatory menu label is far too wide
 *  for a chip. */
function makeRenderFilterValue(tagCatalog: { slug: string; label: string }[]) {
  return (field: Field, value: string): string => {
    if (field === "tristate") return TRISTATE_LABEL[value] ?? value;
    if (field === "tags") return tagCatalog.find((t) => t.slug === value)?.label ?? value;
    return value;
  };
}

// ── Priority badge ───────────────────────────────────────────────────────────
// Banded server-side (routes/jobs.py _net_priority_case). Unranked renders as
// nothing at all — a badge is meant to mean "act on this", so a third grey tier
// for everyone else would dilute it.
function PriorityBadge({ c }: { c: NetworkConnection }) {
  if (!c.priority) return <span />;
  // A P1 can come from the decision-maker override alone, so name that first —
  // otherwise the tooltip lists one fit and the badge looks unexplained. Window
  // mirrors _PRIORITY_SENIORITY_HEADCOUNT_WINDOW in routes/jobs.py.
  const decider = c.seniority === "Highest"
    && ["11-50", "51-200", "201-1000", "1001-5000"].includes(c.headcount_band ?? "");
  const fits = [
    c.headcount_band === "51-200" && "headcount 51-200",
    (c.tristate === "Yes" || c.tristate === "Unknown") &&
      (c.tristate === "Yes" ? "tri-state HQ" : "tri-state unknown (counts as a fit)"),
    (c.seniority === "High" || c.seniority === "Highest") && `seniority ${c.seniority?.toLowerCase()}`,
  ].filter(Boolean) as string[];
  const why = [
    decider && `decision-maker at ${c.headcount_band}`,
    c.is_portco && "portfolio company",
    ...fits,
  ].filter(Boolean).join(" · ");
  return (
    <span
      title={`${c.priority} — ${why || "no criteria matched"}`}
      className={cn("grid h-5 w-6 place-items-center rounded text-[10.5px] font-bold tabular-nums",
        c.priority === "P1" ? "bg-accent text-surface" : "bg-accent-soft text-accent-ink")}
    >
      {c.priority}
    </span>
  );
}

// ── Excel-style row cells ────────────────────────────────────────────────────
// This view exists to be filled in fast, so every editable cell is one click:
// y/n toggles immediately, the note becomes an input and saves on Enter or blur.
// All three save through one partial PATCH, so editing one cell never disturbs
// its neighbours. Writes are optimistic — nothing waits on the network.

/** Thumbs cell. Clicking the active thumb clears it back to unanswered. Used for
 *  both yes/no columns so they read as one gesture. */
function ThumbsCell({
  value, onChange, yesLabel, noLabel, disabled, disabledHint,
}: {
  value: "yes" | "no" | null;
  onChange: (next: string) => void;
  yesLabel: string;
  noLabel: string;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const pick = (e: React.MouseEvent, target: "yes" | "no") => {
    e.stopPropagation();                       // must not expand the row
    if (disabled) return;
    onChange(value === target ? "" : target);   // click the active thumb to clear
  };
  const base = "grid h-6 flex-1 place-items-center";
  const hint = (label: string, active: boolean) =>
    disabled ? disabledHint : active ? `${label} — click to clear` : label;
  return (
    <div
      title={disabled ? disabledHint : undefined}
      className={cn("flex overflow-hidden rounded border border-border-strong",
        disabled && "opacity-40")}
    >
      <button type="button" aria-pressed={value === "yes"} aria-label={yesLabel}
        title={hint(yesLabel, value === "yes")}
        onClick={(e) => pick(e, "yes")}
        className={cn(base, "border-r border-border-strong",
          value === "yes" ? "bg-green/15 text-green" : "text-ink-4 hover:bg-surface-2 hover:text-ink-2")}>
        <ThumbsUp size={13} aria-hidden />
      </button>
      <button type="button" aria-pressed={value === "no"} aria-label={noLabel}
        title={hint(noLabel, value === "no")}
        onClick={(e) => pick(e, "no")}
        className={cn(base,
          value === "no" ? "bg-red/15 text-red" : "text-ink-4 hover:bg-surface-2 hover:text-ink-2")}>
        <ThumbsDown size={13} aria-hidden />
      </button>
    </div>
  );
}

/** Note cell — YOUR note, stored as a real team comment.
 *
 *  Blank for each person until they write one: the row returns only the caller's
 *  own "relationship context:" comment. It still lands in the contact's Comments
 *  thread, so colleagues can read it — but their notes never appear in your cell
 *  and yours never overwrites theirs. `relationship_context_others` says how many
 *  other people have written here; the full thread is in the row expand. */
function NoteCell({ c }: { c: NetworkConnection }) {
  const value = c.relationship_context;
  const others = c.relationship_context_others;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const save = useSaveRelationshipContext();

  // Re-sync when the row's saved value changes underneath us (another tab, or the
  // refetch after our own save) — but never while typing, or we'd fight the user.
  useEffect(() => { if (!editing) setDraft(value ?? ""); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (value ?? "")) return;
    // Always our own comment, so this is a plain update / create / delete.
    save.mutate({ contact_id: c.contact_id, text: next, existing_id: c.relationship_context_id });
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title={[value || "Click to add your relationship context — saved to the contact's comments",
                others > 0 ? `${others} other ${others === 1 ? "person has" : "people have"} left context — see Comments in the row expand` : ""]
          .filter(Boolean).join("\n\n")}
        className={cn("flex h-6 w-full items-center gap-1 rounded border border-transparent px-1.5 text-left text-[11.5px]",
          "hover:border-border-strong hover:bg-surface",
          value ? "text-ink-2" : "text-ink-4")}
      >
        <span className="min-w-0 flex-1 truncate">{value || "—"}</span>
        {others > 0 && (
          <span className="shrink-0 rounded bg-surface-2 px-1 text-[9.5px] tabular-nums text-ink-4">+{others}</span>
        )}
      </button>
    );
  }
  return (
    <input
      ref={inputRef}
      autoFocus
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); setDraft(value ?? ""); setEditing(false); }
      }}
      placeholder="Relationship context…"
      className="h-6 w-full rounded border border-accent bg-surface px-1.5 text-[11.5px] text-ink outline-none"
    />
  );
}

function NetworkRow({ c, expanded, onToggle, fitEnabled, scope, tagLabel }: {
  c: NetworkConnection; expanded: boolean; onToggle: () => void; fitEnabled: boolean;
  scope: NetworkScope; tagLabel: (slug: string) => string;
}) {
  const save = useSetConnectionStatus();
  const expectValue = c.status === VOTE_UP || c.status === LEGACY_UP ? "yes"
    : c.status === VOTE_DOWN || c.status === LEGACY_DOWN ? "no" : null;
  return (
    <>
      <div
        onClick={onToggle}
        className={cn(netGrid(scope), "cursor-pointer border-t border-border-strong px-3 py-1 text-[12.5px] hover:bg-surface-2/40", expanded && "bg-surface-2/40")}
      >
        <PriorityBadge c={c} />
        {/* Connection: name + title. The warmth dot and LinkedIn link stay — they
            cost no column and the "last touch" column that carried that signal is
            gone. Everything else moved into the expand. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
          {c.warm ? <span title={`You've been in touch (${c.my_activity_count})`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                  : c.touched ? <span title="Pursuit has activity, but not you" className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" />
                  : <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-border-strong" />}
          <div className="min-w-0">
            <Link to={`/jobs/contacts/${c.contact_id}`} onClick={(e) => e.stopPropagation()}
              className="block truncate font-medium text-ink hover:text-accent">
              {c.full_name || "—"}
            </Link>
            {c.current_title ? <span className="block truncate text-[10.5px] leading-tight text-ink-4">{c.current_title}</span> : null}
            {/* What LinkedIn says today, shown only when it contradicts the row.
                The imported title stays above it and stays authoritative — this
                is a prompt to look, not a correction that has been applied. */}
            {c.live_title ? (
              <span className="block truncate text-[10.5px] leading-tight text-amber-600"
                title={`LinkedIn says "${c.live_title}"${c.enriched_at ? ` (checked ${new Date(c.enriched_at).toLocaleDateString()})` : ""} — not yet applied`}>
                now: {c.live_title}
              </span>
            ) : null}
          </div>
          {c.linkedin_url && (
            <a href={c.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
              title="Open LinkedIn profile" className="shrink-0 text-ink-4 hover:text-accent">
              <Linkedin size={12} />
            </a>
          )}
        </div>
        <div className="min-w-0 text-[11.5px] text-ink-3" title={c.current_company ?? undefined}>
          <span className="block truncate">{c.current_company || "—"}</span>
          {c.live_company ? (
            <span className="block truncate text-[10.5px] leading-tight text-amber-600"
              title={`LinkedIn says "${c.live_company}"${c.enriched_at ? ` (checked ${new Date(c.enriched_at).toLocaleDateString()})` : ""} — not yet applied`}>
              now: {c.live_company}
            </span>
          ) : null}
        </div>
        {scope === "pursuit" && (
          /* Why this contact is in the list at all. Curated tags only — a raw tag
             array can also hold internal markers that mean nothing to a reader. */
          <div className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden"
            title={(c.tags ?? []).map(tagLabel).join(", ")}>
            {(c.tags ?? []).slice(0, 2).map((t) => (
              <span key={t} className="truncate rounded bg-surface-2 px-1 py-px text-[10px] text-ink-3">
                {tagLabel(t)}
              </span>
            ))}
            {(c.tags?.length ?? 0) > 2 && (
              <span className="text-[10px] text-ink-4">+{(c.tags?.length ?? 0) - 2}</span>
            )}
          </div>
        )}
        <ThumbsCell
          value={expectValue}
          yesLabel="Expect a response" noLabel="Don't expect a response"
          onChange={(next) => save.mutate({
            contact_id: c.contact_id,
            status: next === "yes" ? VOTE_UP : next === "no" ? VOTE_DOWN : VOTE_NONE,
          })}
        />
        <ThumbsCell
          value={(c.hiring_fit as "yes" | "no" | null) ?? null}
          yesLabel="Hiring fit" noLabel="Not a hiring fit"
          disabled={!fitEnabled}
          disabledHint="Hiring fit needs db/migrations/2026-08-05-connection-hiring-fit.sql applied"
          onChange={(next) => save.mutate({ contact_id: c.contact_id, hiring_fit: next })}
        />
        <NoteCell c={c} />
      </div>
      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/20">
          <ContactExpandTabs contactId={c.contact_id} />
        </div>
      )}
    </>
  );
}

function MyNetworkZone({ scope }: { scope: NetworkScope }) {
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [warmOnly, setWarmOnly] = useState(false);
  const [byCompany, setByCompany] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rules, setRules] = useState<FilterRule<Field>[]>([]);
  // Always ranked (Jac, 2026-08-05 — the checkbox is gone). Kept as a named const
  // rather than inlined so the sort interaction below still reads clearly.
  const prioritized = true;
  const { sort, toggle: toggleSort } = useSort<NetSortKey>();
  const { data, isLoading } = useMyNetwork(q || undefined, rules, prioritized, scope);
  const { data: facets } = useMyNetworkFacets(scope);
  const { data: tagCatalog = EMPTY_TAGS } = useContactTagCatalog();
  const selectOptions = useMemo(() => buildSelectOptions(facets, tagCatalog), [facets, tagCatalog]);
  const renderFilterValue = useMemo(() => makeRenderFilterValue(tagCatalog), [tagCatalog]);
  const tagLabel = useMemo(() => {
    const m = new Map(tagCatalog.map((t) => [t.slug, t.label]));
    return (slug: string) => m.get(slug) ?? slug;
  }, [tagCatalog]);
  const fitEnabled = data?.hiring_fit_available ?? false;
  let conns = data?.connections ?? [];
  // The server already applied these rules in SQL; re-applying them here is a
  // guard against a client/server semantic mismatch, the same belt-and-braces
  // the Contacts page uses.
  if (rules.length) conns = conns.filter((c) => rules.every((r) => ruleApplies(c, r, FILTERABLE)));
  if (warmOnly) conns = conns.filter((c) => c.warm);
  if (sort.key) {
    const val = NET_SORT_VALUE[sort.key];
    // With "prioritized" on, the band stays the primary key and the chosen column
    // orders WITHIN each band. Sorting on the column alone would silently throw
    // away the server's ranking, making the checkbox look broken the moment you
    // click any header.
    const band = (c: NetworkConnection) => (c.priority ?? "ZZ");
    conns = [...conns].sort((a, b) =>
      (prioritized && sort.key !== "priority" ? compare(band(a), band(b), "asc") : 0)
      || compare(val(a), val(b), sort.direction));
  }
  const shown = showAll ? conns : conns.slice(0, 25);
  // Group the shown rows by company (largest group first, no-company last).
  const groups = useMemo(() => {
    if (!byCompany) return null;
    const m = new Map<string, NetworkConnection[]>();
    for (const c of shown) {
      const k = c.current_company?.trim() || "No company";
      (m.get(k) ?? m.set(k, []).get(k)!).push(c);
    }
    return [...m.entries()].sort((a, b) =>
      a[0] === "No company" ? 1 : b[0] === "No company" ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [byCompany, shown]);
  const toggle = (id: number) => setExpandedId((p) => (p === id ? null : id));
  const filtering = rules.length > 0 || !!q || warmOnly;
  // `matched` is counted in SQL over the WHOLE network and is the real answer to
  // "how many?". `connections` is capped at 2,000 and several staff networks are
  // bigger than that, so the two genuinely differ — say so rather than let a
  // capped list read as a complete one. "warm only" is applied client-side, so
  // it narrows what's shown without changing `matched`.
  const matched = data?.matched ?? 0;
  const loaded = data?.connections.length ?? 0;
  const truncated = !!data?.mapped && matched > loaded;
  const controls = (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1 text-[11px] text-ink-4">
        <input type="checkbox" checked={warmOnly} onChange={(e) => { setWarmOnly(e.target.checked); setShowAll(false); }} className="accent-accent" /> warm only
      </label>
      <label className="flex items-center gap-1 text-[11px] text-ink-4">
        <input type="checkbox" checked={byCompany} onChange={(e) => setByCompany(e.target.checked)} className="accent-accent" /> by company
      </label>
      <AddFilterButton<Field>
        filterable={FILTERABLE as Record<Field, FieldMeta<unknown>>}
        selectOptions={selectOptions}
        onAdd={(r) => { setRules((p) => [...p, r]); setShowAll(false); }}
        buttonLabel="Filter"
      />
      <input value={q} onChange={(e) => { setQ(e.target.value); setShowAll(false); }}
        placeholder="Search name / company / title"
        className="h-7 w-48 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
    </div>
  );
  return (
    <Section
      title={scope === "pursuit" ? "Tagged contacts" : "Connections"}
      // Show "matched of total" the moment a filter narrows anything, so the
      // count can never be mistaken for the whole network.
      count={filtering ? undefined : data?.total}
      action={controls}
    >
      {filtering && data?.mapped && (
        <div className="text-[11.5px] text-ink-3">
          {/* `matched` is the SQL answer for search + filters. "warm only" and
              the 2,000-row cap then both narrow things in the browser, so the
              second number is only ever "how many rows you're looking at" — it
              is deliberately NOT called a warm total, because when the list is
              truncated it counts warmth within the loaded rows alone. */}
          <span className="font-semibold tabular-nums text-ink-2">{matched.toLocaleString()}</span>
          {" of "}
          <span className="tabular-nums">{(data?.total ?? 0).toLocaleString()}</span>
          {scope === "pursuit" ? " tagged contacts" : " connections"}
          {matched !== conns.length && (
            <span className="text-ink-4">{" · "}showing {conns.length.toLocaleString()}</span>
          )}
        </div>
      )}
      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, FILTERABLE, renderFilterValue)}
              onRemove={() => { setRules((p) => p.filter((x) => x.id !== r.id)); setShowAll(false); }}
            />
          ))}
          <button type="button" onClick={() => { setRules([]); setShowAll(false); }}
            className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      )}
      {truncated && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-900">
          {/* Fires with no filters too: a 5,000-connection network was already
              being cut to 2,000 silently. Better to say it than to imply the
              list is everything. */}
          Showing the first {loaded.toLocaleString()} of{" "}
          {matched.toLocaleString()} {rules.length > 0 || q ? "matching connections" : "connections"}.{" "}
          {rules.length > 0 || q ? "Narrow further" : "Add a filter"} to see the rest.
        </div>
      )}
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : !data?.mapped ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">{data?.message || "No LinkedIn connections mapped to your account yet."}</div>
        ) : conns.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">{filtering ? "No connections match the filters." : "No connections."}</div>
        ) : (
          <>
            <div className={cn(netGrid(scope), "bg-surface-2/60 px-3 py-1.5")}>
              <SortableHeader label="P" sortKey="priority" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Connection" sortKey="name" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Company" sortKey="company" sort={sort} onToggle={toggleSort} />
              {scope === "pursuit" && (
                <SortableHeader label="Tags" sortKey="tags" sort={sort} onToggle={toggleSort} />
              )}
              <SortableHeader label="Expect a response" sortKey="status" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Hiring fit" sortKey="fit" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Note" sortKey="note" sort={sort} onToggle={toggleSort} />
            </div>
            {groups ? groups.map(([company, rows]) => (
              <div key={company}>
                <div className="flex items-baseline gap-2 border-t border-border-strong bg-surface-2/50 px-3 py-1 text-[11px] font-semibold text-ink-2">
                  {company} <span className="font-normal tabular-nums text-ink-4">{rows.length}</span>
                </div>
                {rows.map((c) => <NetworkRow key={c.contact_id} c={c} expanded={expandedId === c.contact_id} onToggle={() => toggle(c.contact_id)} fitEnabled={fitEnabled} scope={scope} tagLabel={tagLabel} />)}
              </div>
            )) : shown.map((c) => <NetworkRow key={c.contact_id} c={c} expanded={expandedId === c.contact_id} onToggle={() => toggle(c.contact_id)} fitEnabled={fitEnabled} scope={scope} tagLabel={tagLabel} />)}
            {conns.length > shown.length && (
              <button type="button" onClick={() => setShowAll(true)}
                className="border-t border-border-strong px-3 py-2 text-[12px] text-accent hover:bg-surface-2/50">Show all {conns.length} loaded</button>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

// Profiles that may see the Pursuit network. Mirrors _PURSUIT_SCOPE_PROFILES in
// routes/jobs.py — the endpoint enforces it independently, so this only decides
// whether the tab is worth showing.
const PURSUIT_PROFILES = ["Executive", "Admin"];

export function MyNetworkPage() {
  const [scope, setScope] = useState<NetworkScope>("mine");
  const { data: perms } = usePermissions();
  const canSeePursuit = PURSUIT_PROFILES.includes(perms?.profile_name ?? "");
  // If the tab is hidden mid-session (profile change, or perms arriving late),
  // don't leave the page stuck on a scope the server will now refuse.
  const active: NetworkScope = canSeePursuit ? scope : "mine";

  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title={active === "pursuit" ? "Pursuit Network" : "My Network"}
        subtitle={active === "pursuit"
          ? "Every tagged contact at Pursuit — hiring partners, staff network, volunteers, BASH, board. Leadership only."
          : "Your LinkedIn connections, mapped to Bedrock contacts."}
      />
      {canSeePursuit && (
        <div role="tablist" className="mb-3 inline-flex overflow-hidden rounded-md border border-border-strong bg-surface">
          {([["mine", "My network"], ["pursuit", "Pursuit network"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active === value}
              onClick={() => setScope(value)}
              className={cn(
                "border-l border-border-strong px-3 py-1 text-[12px] font-medium first:border-l-0",
                active === value ? "bg-ink text-surface" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {/* Keyed so switching scope resets filters, sort and the expanded row —
          the two lists have different shapes and a stale filter would confuse. */}
      <MyNetworkZone key={active} scope={active} />
    </div>
  );
}
