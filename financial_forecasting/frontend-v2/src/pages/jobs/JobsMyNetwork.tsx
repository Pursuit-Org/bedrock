/**
 * /jobs/network — My Network (staff LinkedIn connections), moved off the Jobs
 * Home screen to its own page (nav: xOrg › My Network). Connections are the
 * current user's LinkedIn imports mapped to Bedrock contacts, with last-touch,
 * co-connection, and pipeline signals, expanding inline to the contact's tabs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Linkedin, MessageSquare, Send, ThumbsDown, ThumbsUp } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import { ContactExpandTabs } from "@/components/jobs/jobsEntity";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { useSort, compare } from "@/lib/sort";
import {
  useContactTagCatalog, useMyNetwork, useMyNetworkFacets, useSetConnectionStatus,
  type MyNetworkFacets, type NetworkConnection,
} from "@/services/jobs";
import { relDay } from "@/lib/format";
import { useCreateJobsComment, useJobsComments } from "@/services/jobsComments";
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

// Fixed grid so columns line up:
// priority | name | company | last touch | connected | staff | signals | note | willing.
const NET_GRID = "grid grid-cols-[34px_minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_72px_52px_minmax(0,1.1fr)_44px_76px] items-center gap-2";
type NetSortKey = "name" | "company" | "touch" | "connected" | "staff" | "status" | "priority";
// Sorting on the vote groups 👍 / no-vote / 👎 in that order. The stored strings
// would sort "declined" before "new" before "will_reach_out" — alphabetical, and
// meaningless to a human scanning the column.
const VOTE_RANK: Record<string, number> = { will_reach_out: 0, new: 1, declined: 2 };
const NET_SORT_VALUE: Record<NetSortKey, (c: NetworkConnection) => unknown> = {
  name: (c) => c.full_name,
  company: (c) => c.current_company,
  touch: (c) => (c.my_activity_count > 0 ? c.my_last_activity : c.last_activity),
  connected: (c) => c.connected_date,
  staff: (c) => c.co_connections,
  status: (c) => VOTE_RANK[c.status] ?? 1,
  // Unranked sorts after both bands rather than before "P1" alphabetically.
  priority: (c) => c.priority ?? "ZZ",
};

// ── Filters ──────────────────────────────────────────────────────────────────
// The same rule engine the Contacts page uses (pages/cleanup/Filters). These
// four dimensions are the ones the employer-prospect ranking work sliced on;
// Investor is the fifth and needs bedrock.company_investor, which does not exist
// yet — see the plan's deferred section.
type Field =
  | "headcount" | "tristate" | "industry" | "seniority"
  | "company" | "title" | "tags"
  | "is_jobs" | "has_open_opp" | "hired_before" | "warm" | "touched";
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
  const fits = [
    c.headcount_band === "51-200" && "headcount 51-200",
    (c.tristate === "Yes" || c.tristate === "Unknown") &&
      (c.tristate === "Yes" ? "tri-state HQ" : "tri-state unknown (counts as a fit)"),
    (c.seniority === "High" || c.seniority === "Highest") && `seniority ${c.seniority?.toLowerCase()}`,
  ].filter(Boolean) as string[];
  const why = [c.is_portco && "portfolio company", ...fits].filter(Boolean).join(" · ");
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

// ── Shared note on the row ───────────────────────────────────────────────────
// Writes a real bedrock.jobs_comment (parent_type='prospect'), so it's the SAME
// thread the row's Comments tab shows and is visible to the whole team — not a
// private scratchpad. Opens in place so a note never costs an expand.
function RowNote({ c }: { c: NetworkConnection }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const id = String(c.contact_id);
  const { data: comments = [], isLoading } = useJobsComments("prospect", open ? id : undefined);
  const create = useCreateJobsComment("prospect", id);

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const submit = () => {
    const body = draft.trim();
    if (!body || create.isPending) return;
    create.mutate(body, { onSuccess: () => setDraft("") });
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        title={c.comment_count > 0 ? `${c.comment_count} team note${c.comment_count === 1 ? "" : "s"}` : "Add a team note"}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex h-7 w-full items-center justify-center gap-0.5 rounded border text-[11px]",
          c.comment_count > 0
            ? "border-border-strong bg-surface-2/60 font-medium text-ink-2"
            : "border-transparent text-ink-4 hover:border-border-strong hover:text-ink-2")}
      >
        <MessageSquare size={12} aria-hidden />
        {c.comment_count > 0 ? <span className="tabular-nums">{c.comment_count}</span> : null}
      </button>
      {open && (
        <div
          ref={boxRef}
          className="absolute right-0 top-8 z-30 w-80 rounded-lg border border-border-strong bg-surface p-2 shadow-lg"
        >
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
              Team notes{comments.length ? ` (${comments.length})` : ""}
            </span>
            <span className="text-[10px] text-ink-4">visible to staff</span>
          </div>
          <div className="max-h-40 overflow-y-auto">
            {isLoading ? (
              <p className="py-2 text-[11.5px] text-ink-4">Loading…</p>
            ) : comments.length === 0 ? (
              <p className="py-1 text-[11.5px] text-ink-4">No notes yet.</p>
            ) : (
              comments.map((cm) => (
                <div key={cm.id} className="border-t border-border-strong py-1.5 first:border-t-0">
                  <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-ink-2">{cm.content}</p>
                  <p className="mt-0.5 text-[10px] text-ink-4">
                    {cm.author_email ?? "unknown"}
                    {cm.created_at ? ` · ${relDay(cm.created_at)}` : ""}
                  </p>
                </div>
              ))
            )}
          </div>
          <div className="mt-1.5 flex items-end gap-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits; Shift+Enter for a second line.
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
              rows={2}
              placeholder="Add a note for the team…"
              className="min-h-[38px] flex-1 resize-y rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || create.isPending}
              className="grid h-7 w-7 shrink-0 place-items-center rounded border border-ink bg-ink text-surface disabled:opacity-40"
              title="Post note (Enter)"
            >
              <Send size={12} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Expect a response: 👍 / 👎 ───────────────────────────────────────────────
// Replaces the three-state dropdown. Clicking the active thumb clears the vote.
//
// The STORED vocabulary is deliberately unchanged — bedrock.connection_status
// still holds will_reach_out | declined | new — so the votes imported from the
// old outreach tracker keep reading correctly and no migration is needed. That
// means the column's label and its stored values no longer use the same words:
// 'will_reach_out' backs 👍 on a column that now asks whether a reply is likely.
// Renaming the data to chase the label would rewrite 123 existing rows and break
// scripts/repair_outreach_links.py for no functional gain.
function VoteButtons({ status, onVote }: { status: string; onVote: (status: string) => void }) {
  const up = status === "will_reach_out";
  const down = status === "declined";
  const vote = (e: React.MouseEvent, target: string, active: boolean) => {
    e.stopPropagation();          // a vote must not expand the row
    onVote(active ? "new" : target);
  };
  return (
    <div className="flex items-center justify-center gap-0.5">
      <button
        type="button"
        aria-pressed={up}
        title={up ? "Expect a response — click to clear" : "Expect a response"}
        onClick={(e) => vote(e, "will_reach_out", up)}
        className={cn("grid h-7 w-7 place-items-center rounded border",
          up ? "border-green/40 bg-green/10 text-green" : "border-transparent text-ink-4 hover:border-border-strong hover:text-ink-2")}
      >
        <ThumbsUp size={13} aria-hidden />
      </button>
      <button
        type="button"
        aria-pressed={down}
        title={down ? "Don't expect a response — click to clear" : "Don't expect a response"}
        onClick={(e) => vote(e, "declined", down)}
        className={cn("grid h-7 w-7 place-items-center rounded border",
          down ? "border-red/40 bg-red/10 text-red" : "border-transparent text-ink-4 hover:border-border-strong hover:text-ink-2")}
      >
        <ThumbsDown size={13} aria-hidden />
      </button>
    </div>
  );
}

function NetworkRow({ c, expanded, onToggle }: { c: NetworkConnection; expanded: boolean; onToggle: () => void }) {
  const setStatus = useSetConnectionStatus();
  // Last touch: prefer MY touch (warm), fall back to team touch.
  const mine = c.my_activity_count > 0;
  const touchIso = mine ? c.my_last_activity : c.last_activity;
  const chIcon = c.last_channel === "meeting" ? "📅" : c.last_channel === "email" ? "✉️" : "";
  return (
    <>
      <div
        onClick={onToggle}
        className={cn(NET_GRID, "cursor-pointer border-t border-border-strong px-3 py-1.5 text-[12.5px] hover:bg-surface-2/40", expanded && "bg-surface-2/40")}
      >
        <PriorityBadge c={c} />
        <div className="flex min-w-0 items-center gap-1.5">
          <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
          {c.warm ? <span title={`You've been in touch (${c.my_activity_count})`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                  : c.touched ? <span title="Pursuit has activity, but not you" className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" />
                  : <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-border-strong" />}
          <Link to={`/jobs/contacts/${c.contact_id}`} onClick={(e) => e.stopPropagation()} className="min-w-0 truncate font-medium text-ink hover:text-accent">
            {c.full_name || "—"}
          </Link>
          {c.linkedin_url && (
            <a href={c.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
              title="Open LinkedIn profile" className="shrink-0 text-ink-4 hover:text-accent">
              <Linkedin size={12} />
            </a>
          )}
          {c.current_title ? <span className="hidden truncate text-[11px] text-ink-4 lg:inline"> · {c.current_title}</span> : null}
        </div>
        <div className="min-w-0 truncate text-[11.5px] text-ink-3">{c.current_company || "—"}</div>
        <div className="min-w-0 truncate text-[11px] tabular-nums" title={touchIso ? new Date(touchIso).toLocaleString() : "No activity"}>
          {touchIso ? (
            <span className={mine ? "text-amber-600" : "text-ink-4"}>
              {chIcon} {relDay(touchIso)}{mine ? ` · you (${c.my_activity_count})` : c.touched ? ` · team (${c.activity_count})` : ""}
            </span>
          ) : <span className="text-ink-4">—</span>}
        </div>
        <div className="truncate text-[11px] tabular-nums text-ink-4" title={c.connected_date ? `Connected ${c.connected_date}` : "Connection date unknown"}>
          {c.connected_date ? relDay(c.connected_date) : "—"}
        </div>
        <div className="text-center text-[11.5px] tabular-nums text-ink-4" title="Other staff also connected">
          {c.co_connections > 0 ? `+${c.co_connections}` : "—"}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {c.is_portco && <Tag variant="default">portco</Tag>}
          {c.is_jobs_contact && <Tag variant="default">pipeline</Tag>}
          {c.has_open_opp && <Tag variant="green">open opp</Tag>}
          {c.company_hired_before && <Tag variant="default">hired before</Tag>}
        </div>
        <RowNote c={c} />
        <VoteButtons status={c.status} onVote={(status) => setStatus.mutate({ contact_id: c.contact_id, status })} />
      </div>
      {expanded && (
        <div className="border-t border-border-strong bg-surface-2/20">
          <ContactExpandTabs contactId={c.contact_id} />
        </div>
      )}
    </>
  );
}

function MyNetworkZone() {
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [warmOnly, setWarmOnly] = useState(false);
  const [byCompany, setByCompany] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rules, setRules] = useState<FilterRule<Field>[]>([]);
  const [prioritized, setPrioritized] = useState(false);
  const { sort, toggle: toggleSort } = useSort<NetSortKey>();
  const { data, isLoading } = useMyNetwork(q || undefined, rules, prioritized);
  const { data: facets } = useMyNetworkFacets();
  const { data: tagCatalog = EMPTY_TAGS } = useContactTagCatalog();
  const selectOptions = useMemo(() => buildSelectOptions(facets, tagCatalog), [facets, tagCatalog]);
  const renderFilterValue = useMemo(() => makeRenderFilterValue(tagCatalog), [tagCatalog]);
  let conns = data?.connections ?? [];
  // The server already applied these rules in SQL; re-applying them here is a
  // guard against a client/server semantic mismatch, the same belt-and-braces
  // the Contacts page uses.
  if (rules.length) conns = conns.filter((c) => rules.every((r) => ruleApplies(c, r, FILTERABLE)));
  if (warmOnly) conns = conns.filter((c) => c.warm);
  if (sort.key) {
    const val = NET_SORT_VALUE[sort.key];
    conns = [...conns].sort((a, b) => compare(val(a), val(b), sort.direction));
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
      <label
        className="flex items-center gap-1 text-[11px] text-ink-4"
        title="Rank P1 / P2 first. P1 = headcount 51-200, tri-state (or unknown) and high seniority; P2 = two of the three. A portfolio company is at least P2, and P1 on two of three. Pursuit staff and alumni are never banded."
      >
        <input type="checkbox" checked={prioritized}
          onChange={(e) => { setPrioritized(e.target.checked); setShowAll(false); }}
          className="accent-accent" /> prioritized
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
      title="Connections"
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
          {" connections"}
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
            <div className={cn(NET_GRID, "bg-surface-2/60 px-3 py-1.5")}>
              <SortableHeader label="P" sortKey="priority" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Connection" sortKey="name" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Company" sortKey="company" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Last touch" sortKey="touch" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Connected" sortKey="connected" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Staff" sortKey="staff" sort={sort} onToggle={toggleSort} />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Signals</span>
              <span className="text-center text-[11px] font-semibold uppercase tracking-wider text-ink-3">Note</span>
              <SortableHeader label="Expect a response" sortKey="status" sort={sort} onToggle={toggleSort} />
            </div>
            {groups ? groups.map(([company, rows]) => (
              <div key={company}>
                <div className="flex items-baseline gap-2 border-t border-border-strong bg-surface-2/50 px-3 py-1 text-[11px] font-semibold text-ink-2">
                  {company} <span className="font-normal tabular-nums text-ink-4">{rows.length}</span>
                </div>
                {rows.map((c) => <NetworkRow key={c.contact_id} c={c} expanded={expandedId === c.contact_id} onToggle={() => toggle(c.contact_id)} />)}
              </div>
            )) : shown.map((c) => <NetworkRow key={c.contact_id} c={c} expanded={expandedId === c.contact_id} onToggle={() => toggle(c.contact_id)} />)}
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

export function MyNetworkPage() {
  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title="My Network"
        subtitle="Your LinkedIn connections, mapped to Bedrock contacts."
      />
      <MyNetworkZone />
    </div>
  );
}
