/**
 * /jobs/network — My Network (staff LinkedIn connections), moved off the Jobs
 * Home screen to its own page (nav: xOrg › My Network). Connections are the
 * current user's LinkedIn imports mapped to Bedrock contacts, with last-touch,
 * co-connection, and pipeline signals, expanding inline to the contact's tabs.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Linkedin, ThumbsDown, ThumbsUp } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import { ContactExpandTabs } from "@/components/jobs/jobsEntity";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { useSort, compare } from "@/lib/sort";
import { useMyNetwork, useMyNetworkFacets, useSetConnectionStatus, type MyNetworkFacets, type NetworkConnection } from "@/services/jobs";
import { relDay } from "@/lib/format";
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

// Fixed grid so columns line up: name | company | last touch | connected | staff | signals | your call.
const NET_GRID = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_72px_52px_minmax(0,1.2fr)_76px] items-center gap-2";
type NetSortKey = "name" | "company" | "touch" | "connected" | "staff" | "status";
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
};

// ── Filters ──────────────────────────────────────────────────────────────────
// The same rule engine the Contacts page uses (pages/cleanup/Filters). These
// four dimensions are the ones the employer-prospect ranking work sliced on;
// Investor is the fifth and needs bedrock.company_investor, which does not exist
// yet — see the plan's deferred section.
type Field = "headcount" | "tristate" | "industry" | "seniority";
const FILTERABLE: Record<Field, FieldMeta<NetworkConnection>> = {
  headcount: { label: "Headcount", type: "select", getValue: (c) => c.headcount_band ?? "" },
  tristate: { label: "Tri-state presence", type: "select", getValue: (c) => c.tristate ?? "" },
  industry: { label: "Industry", type: "select", getValue: (c) => c.industry ?? "" },
  seniority: { label: "Seniority", type: "select", getValue: (c) => c.seniority ?? "" },
};
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
function buildSelectOptions(facets: MyNetworkFacets | undefined): Partial<Record<Field, { value: string; label: string }[]>> {
  const f = facets ?? { headcount: [], industry: [], tristate: [], seniority: [] };
  return {
    headcount: byLadder(f.headcount, HEADCOUNT_ORDER).map((v) => ({ value: v, label: v })),
    tristate: byLadder(f.tristate, TRISTATE_ORDER).map((v) => ({ value: v, label: TRISTATE_LABEL[v] ?? v })),
    seniority: byLadder(f.seniority, SENIORITY_ORDER).map((v) => ({ value: v, label: SENIORITY_LABEL[v] ?? v })),
    industry: [...f.industry].sort().map((v) => ({ value: v, label: v })),
  };
}
/** Chip text. Only tri-state needs relabelling — seniority deliberately keeps its
 *  bare rung ("Highest"), because the explanatory menu label is far too wide for
 *  a chip. */
function renderFilterValue(field: Field, value: string): string {
  return field === "tristate" ? TRISTATE_LABEL[value] ?? value : value;
}

// ── Your call: 👍 / 👎 ───────────────────────────────────────────────────────
// Replaces the three-state dropdown. Stored vocabulary is unchanged
// (bedrock.connection_status: will_reach_out | declined | new), so the votes
// imported from the old outreach tracker still read correctly. Clicking the
// active thumb clears the vote.
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
        title={up ? "Will reach out — click to clear" : "Will reach out"}
        onClick={(e) => vote(e, "will_reach_out", up)}
        className={cn("grid h-7 w-7 place-items-center rounded border",
          up ? "border-green/40 bg-green/10 text-green" : "border-transparent text-ink-4 hover:border-border-strong hover:text-ink-2")}
      >
        <ThumbsUp size={13} aria-hidden />
      </button>
      <button
        type="button"
        aria-pressed={down}
        title={down ? "Not a fit — click to clear" : "Not a fit"}
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
          {c.is_jobs_contact && <Tag variant="default">pipeline</Tag>}
          {c.has_open_opp && <Tag variant="green">open opp</Tag>}
          {c.company_hired_before && <Tag variant="default">hired before</Tag>}
        </div>
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
  const { sort, toggle: toggleSort } = useSort<NetSortKey>();
  const { data, isLoading } = useMyNetwork(q || undefined, rules);
  const { data: facets } = useMyNetworkFacets();
  const selectOptions = useMemo(() => buildSelectOptions(facets), [facets]);
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
              <SortableHeader label="Connection" sortKey="name" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Company" sortKey="company" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Last touch" sortKey="touch" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Connected" sortKey="connected" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Staff" sortKey="staff" sort={sort} onToggle={toggleSort} />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Signals</span>
              <SortableHeader label="Your call" sortKey="status" sort={sort} onToggle={toggleSort} />
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
