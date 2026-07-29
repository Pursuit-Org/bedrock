/**
 * /jobs/network — My Network (staff LinkedIn connections), moved off the Jobs
 * Home screen to its own page (nav: xOrg › My Network). Connections are the
 * current user's LinkedIn imports mapped to Bedrock contacts, with last-touch,
 * co-connection, and pipeline signals, expanding inline to the contact's tabs.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Linkedin } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import { ContactExpandTabs } from "@/components/jobs/jobsEntity";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { useSort, compare } from "@/lib/sort";
import { useMyNetwork, useSetConnectionStatus, type NetworkConnection } from "@/services/jobs";
import { relDay } from "@/lib/format";

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

// Fixed grid so columns line up: name | company | last touch | connected | staff | signals | status.
const NET_GRID = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_72px_52px_minmax(0,1.2fr)_120px] items-center gap-2";
type NetSortKey = "name" | "company" | "touch" | "connected" | "staff" | "status";
const NET_SORT_VALUE: Record<NetSortKey, (c: NetworkConnection) => unknown> = {
  name: (c) => c.full_name,
  company: (c) => c.current_company,
  touch: (c) => (c.my_activity_count > 0 ? c.my_last_activity : c.last_activity),
  connected: (c) => c.connected_date,
  staff: (c) => c.co_connections,
  status: (c) => c.status,
};
const NET_STATUS = [
  { value: "new", label: "New" },
  { value: "will_reach_out", label: "Will reach out" },
  { value: "declined", label: "Not a fit" },
];

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
        <select
          value={c.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setStatus.mutate({ contact_id: c.contact_id, status: e.target.value })}
          className={cn("h-7 w-full rounded border bg-surface px-1 text-[11.5px] outline-none focus:border-accent",
            c.status === "declined" ? "border-red/40 text-red" : c.status === "will_reach_out" ? "border-green/40 text-green" : "border-border-strong text-ink-3")}
        >
          {NET_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
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
  const { sort, toggle: toggleSort } = useSort<NetSortKey>();
  const { data, isLoading } = useMyNetwork(q || undefined);
  let conns = data?.connections ?? [];
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
  const controls = (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1 text-[11px] text-ink-4">
        <input type="checkbox" checked={warmOnly} onChange={(e) => { setWarmOnly(e.target.checked); setShowAll(false); }} className="accent-accent" /> warm only
      </label>
      <label className="flex items-center gap-1 text-[11px] text-ink-4">
        <input type="checkbox" checked={byCompany} onChange={(e) => setByCompany(e.target.checked)} className="accent-accent" /> by company
      </label>
      <input value={q} onChange={(e) => { setQ(e.target.value); setShowAll(false); }}
        placeholder="Search name / company / title"
        className="h-7 w-48 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
    </div>
  );
  return (
    <Section title="Connections" count={data?.total} action={controls}>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : !data?.mapped ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">{data?.message || "No LinkedIn connections mapped to your account yet."}</div>
        ) : conns.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">{q || warmOnly ? "No connections match the filters." : "No connections."}</div>
        ) : (
          <>
            <div className={cn(NET_GRID, "bg-surface-2/60 px-3 py-1.5")}>
              <SortableHeader label="Connection" sortKey="name" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Company" sortKey="company" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Last touch" sortKey="touch" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Connected" sortKey="connected" sort={sort} onToggle={toggleSort} />
              <SortableHeader label="Staff" sortKey="staff" sort={sort} onToggle={toggleSort} />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Signals</span>
              <SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggleSort} />
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
