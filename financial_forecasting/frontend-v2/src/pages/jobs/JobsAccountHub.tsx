/**
 * Jobs · Accounts — the account-level hub.
 *
 * The account (company) is the organizing unit. Full configurable table like the
 * rest of the app: search, per-column filters, group-by, sortable headers,
 * column chooser, and saved views (personal + global). Fluid layout — columns
 * share 100% width and truncate, so there is NO horizontal scroll. Expanding a
 * row reveals everything at that account via tabs.
 */
import { Fragment, useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Briefcase, CheckSquare, ChevronDown, ChevronRight, ExternalLink, Plus, Search, UserCheck, Users } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { AccountAvatar } from "@/components/AccountAvatar";
import { withReferrer } from "@/components/detail";
import { AccountExpandTabs } from "@/components/jobs/accountTabs";
import { NewAccountDialog } from "@/components/jobs/NewAccountDialog";
import { DEAL_TYPE_LABELS, OwnerSelect, jobsAccountPath } from "@/components/jobs/jobsEntity";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { accountStatusVariant } from "@/lib/accountStatus";
import { cn } from "@/lib/utils";
import { RECENCY_OPTIONS, recencyLabel } from "@/lib/recencyFilter";
import { useAccountsWithFellows } from "@/services/affiliations";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { useColumnWidths } from "@/lib/columnWidths";
import { ResizableTh, ColGroup } from "@/components/ui/ResizableTable";
import { useSessionState } from "@/lib/useSessionState";
import { useSort, sortBy, type SortState } from "@/lib/sort";
import {
  AddFilterButton, FilterChip, describeRule, ruleApplies,
  type FieldMeta, type FilterRule,
} from "@/pages/cleanup/Filters";
import {
  useJobsAccounts, useJobsStaff, useUpdateJobsAccount,
  type JobsAccount, type JobsAccountStatus, type JobsStaff,
} from "@/services/jobs";

// ── helpers ──────────────────────────────────────────────────────────────────
function relativeDays(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
const dealTypesOf = (a: JobsAccount) =>
  [...new Set(a.opportunities.map((o) => o.deal_type).filter(Boolean))] as string[];

// ── columns ──────────────────────────────────────────────────────────────────
type ColKey = "account" | "status" | "owner" | "size" | "hq" | "industry" | "opps" | "contacts" | "listings" | "hired" | "tasks" | "deal_types" | "last_activity";
const COLUMN_ORDER: ColKey[] = ["account", "status", "owner", "size", "hq", "industry", "opps", "contacts", "listings", "hired", "tasks", "deal_types", "last_activity"];
// Size / HQ / Industry are all default-visible: they were asked for explicitly,
// and useColumnVisibility only auto-reveals a NEW column to an existing saved
// layout when it's in this list. Hide them per-user via the column picker.
const DEFAULT_VISIBLE: ColKey[] = ["account", "status", "owner", "size", "hq", "industry", "opps", "contacts", "listings", "hired", "tasks", "last_activity"];
const COL_LABELS: Record<ColKey, string> = {
  account: "Account", status: "Status", owner: "Jobs owner",
  size: "Size", hq: "HQ", industry: "Industry", opps: "Opps",
  contacts: "Contacts", listings: "Roles", hired: "Hired", tasks: "Open tasks", deal_types: "Deal types", last_activity: "Last touch",
};
// Default pixel widths — user-resizable via drag handles (useColumnWidths),
// same grid components as the Opportunities table.
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  account: 250, status: 125, owner: 135, size: 100, hq: 140, industry: 150,
  opps: 75, contacts: 90, listings: 80, hired: 80, tasks: 90, deal_types: 115, last_activity: 100,
};
const SORTABLE = new Set<ColKey>(["account", "status", "owner", "size", "hq", "industry", "opps", "contacts", "listings", "hired", "tasks", "last_activity"]);

/** Size bands sort by headcount order, not alphabetically — "1001-5000" would
 *  otherwise sort before "51-200". Unknown sorts last. */
const SIZE_BAND_ORDER = ["1-10", "11-50", "51-200", "201-1000", "1001-5000", "5000+"];
function sizeRank(a: JobsAccount): number {
  const i = SIZE_BAND_ORDER.indexOf((a.size_bucket ?? "").trim());
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

// Total hired = builders we placed (our DB) + historical Pursuit fellows (SF).
const totalHired = (a: JobsAccount) => (a.builders_hired ?? 0) + (a.fellows_hired ?? 0);

function extract(a: JobsAccount, key: ColKey): string | number {
  switch (key) {
    case "account":       return a.account.toLowerCase();
    case "status":        return a.account_status;
    case "owner":         return a.owner_email ?? "";
    // Sort by the band's lower bound, not the label — alphabetically "1001-5000"
    // sorts before "51-200", which is not what anyone means by sorting on size.
    case "size":          return sizeRank(a);
    case "hq":            return (a.hq_location ?? "").toLowerCase();
    case "industry":      return (a.industry ?? "").toLowerCase();
    case "opps":          return a.opp_count;
    case "contacts":      return a.prospect_count;
    case "listings":      return a.job_listings ?? 0;
    case "hired":         return totalHired(a);
    case "tasks":         return a.open_tasks ?? 0;
    case "deal_types":    return dealTypesOf(a).join(",");
    case "last_activity": return a.last_activity ?? "";
  }
}

// ── filters + grouping ───────────────────────────────────────────────────────
type Field = "account" | "status" | "owner" | "industry" | "deal_type" | "has_opps" | "has_contacts" | "last_activity" | "first_contact_date" | "last_contact_date";
const FILTERABLE: Record<Field, FieldMeta<JobsAccount>> = {
  account:      { label: "Account",  type: "text",   getValue: (a) => a.account },
  status:       { label: "Status",   type: "select", getValue: (a) => a.account_status },
  owner:        { label: "Jobs owner", type: "select", getValue: (a) => a.owner_email ?? "" },
  industry:     { label: "Industry", type: "select", getValue: (a) => a.industry ?? "" },
  // An account can have several opportunities of different types; join code +
  // label so a "contains" filter matches on either ("ft", "contract", "Part-time").
  deal_type:    { label: "Deal type", type: "text", getValue: (a) => dealTypesOf(a).map((t) => `${t} ${DEAL_TYPE_LABELS[t as keyof typeof DEAL_TYPE_LABELS] ?? ""}`).join(" | ") },
  has_opps:     { label: "Has opportunities", type: "select", getValue: (a) => (a.opp_count > 0 ? "yes" : "no") },
  has_contacts: { label: "Has contacts",      type: "select", getValue: (a) => (a.prospect_count > 0 ? "yes" : "no") },
  // Top-of-funnel triage: filter by activity recency (Last 7/30/90 days dropdown).
  last_activity: { label: "Last touch", type: "recency", getValue: (a) => a.last_activity_at ?? "" },
  // Exact-date windows on the touch history (before/after a calendar date).
  first_contact_date: { label: "Initial outreach date", type: "date", getValue: (a) => a.first_activity_at ?? "" },
  last_contact_date: { label: "Last contact date", type: "date", getValue: (a) => a.last_activity_at ?? "" },
};
const GROUP_OPTIONS = [
  { value: "", label: "No grouping" },
  { value: "status", label: "Group by Status" },
  { value: "owner", label: "Group by Owner" },
  { value: "has_opps", label: "Group by Has opportunities" },
];
const STATUSES: JobsAccountStatus[] = ["Pursuing", "Stewarding", "Re-activating", "Activating", "Prospect", "Dormant"];
const YESNO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

interface JobsAccountsView {
  query?: string; rules?: FilterRule<Field>[]; visibleCols?: ColKey[];
  groupBy?: string; sort?: SortState<ColKey>;
}

const EMPTY: string[] = [];

// ── row ──────────────────────────────────────────────────────────────────────
function AccountRow({
  account, expanded, onToggle, visibleCols, staff, onSaveOwner, scope,
}: {
  account: JobsAccount; expanded: boolean; onToggle: () => void; visibleCols: ColKey[];
  staff: JobsStaff[]; onSaveOwner: (account: string, email: string) => Promise<void>;
  scope: "engaged" | "all";
}) {
  const cells: Record<ColKey, React.ReactNode> = {
    account: (
      <span className="flex min-w-0 items-center gap-2">
        {expanded ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
        <AccountAvatar name={account.account} logoUrl={null} size={20} />
        <span className="truncate text-[13px] font-semibold text-ink">{account.account}</span>
        <Link to={jobsAccountPath(account.account_key)} state={withReferrer({ pathname: "/jobs", label: "Jobs" })} onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-4 hover:text-accent" title="Open account detail"><ExternalLink size={12} /></Link>
      </span>
    ),
    status: <Tag variant={accountStatusVariant(account.account_status)}>{account.account_status}</Tag>,
    tasks: (account.open_tasks ?? 0) > 0
      ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><CheckSquare size={11} className="text-ink-4" />{account.open_tasks}</span>
      : <span className="text-ink-4">—</span>,
    owner: <OwnerSelect owner={account.owner_email} staff={staff} onSave={(email) => onSaveOwner(account.account, email)} />,
    // Firmographics from public.companies. Read-only on purpose: other systems
    // feed this, so making it editable here would invite two answers.
    size: account.size_bucket ? (
      <span className="text-[12px] tabular-nums text-ink-2"
        title={account.company_stage ? `${account.size_bucket} · stage: ${account.company_stage}` : account.size_bucket}>
        {account.size_bucket}
      </span>
    ) : <span className="text-ink-4">—</span>,
    hq: account.hq_location
      ? <span className="block truncate text-[12px] text-ink-2" title={account.hq_location}>{account.hq_location}</span>
      : <span className="text-ink-4">—</span>,
    industry: account.industry
      ? <span className="block truncate text-[12px] text-ink-2" title={account.industry}>{account.industry}</span>
      : <span className="text-ink-4">—</span>,
    opps: account.opp_count > 0 ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><Briefcase size={11} className="text-ink-4" />{account.opp_count}</span> : <span className="text-ink-4">—</span>,
    contacts: account.prospect_count > 0 ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><Users size={11} className="text-ink-4" />{account.prospect_count}</span> : <span className="text-ink-4">—</span>,
    listings: (account.job_listings ?? 0) > 0
      ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2" title={`${account.roles_sourced ?? 0} sourced · ${account.roles_applied ?? 0} builder-applied`}><Briefcase size={11} className="text-ink-4" />{account.job_listings}</span>
      : <span className="text-ink-4">—</span>,
    hired: (() => {
      const b = account.builders_hired ?? 0;
      const f = account.fellows_hired ?? 0;
      const total = b + f;
      if (total === 0) return <span className="text-ink-4">—</span>;
      const title = account.fellows_hired == null
        ? `${b} builder${b === 1 ? "" : "s"} placed`
        : `${b} builder${b === 1 ? "" : "s"} placed · ${f} fellow${f === 1 ? "" : "s"} (Salesforce)`;
      return <span className="inline-flex items-center gap-1 text-[12px] text-ink-2" title={title}><UserCheck size={11} className="text-green" />{total}</span>;
    })(),
    deal_types: (() => { const d = dealTypesOf(account); return d.length ? <span className="truncate text-[11.5px] text-ink-3">{d.map((t) => DEAL_TYPE_LABELS[t as keyof typeof DEAL_TYPE_LABELS] ?? t).join(", ")}</span> : <span className="text-ink-4">—</span>; })(),
    last_activity: <span className="whitespace-nowrap text-[11.5px] text-ink-4">{relativeDays(account.last_activity)}</span>,
  };
  return (
    <Fragment>
      <tr className="cursor-pointer border-t border-border-strong bg-surface hover:bg-surface-2/50" onClick={onToggle}>
        {visibleCols.map((key, i) => (
          <td key={key} className={cn("overflow-hidden px-3 py-2 align-middle", i === 0 && "sticky left-0 z-10 bg-surface")} onClick={key === "owner" ? (e) => e.stopPropagation() : undefined}>
            {cells[key]}
          </td>
        ))}
      </tr>
      {expanded && (
        <tr className="bg-surface-2/30"><td colSpan={visibleCols.length} className="p-0"><AccountExpandTabs account={account} scope={scope} /></td></tr>
      )}
    </Fragment>
  );
}

export function JobsAccountHub({ initialQuery }: { initialQuery?: string } = {}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [rules, setRules] = useState<FilterRule<Field>[]>([]);
  const [scope, setScope] = useState<"engaged" | "all">("engaged"); // engaged hides ~32k cold contacts; All shows every jobs account (e.g. impact.com)
  const [showNew, setShowNew] = useState(false);
  const [showAll, setShowAll] = useState(false); // window big lists (2.8k+ engaged accounts) so the table renders instantly
  const RENDER_CAP = 200;
  const [groupBy, setGroupBy] = useSessionState<string>("jobs-accounts:groupBy", "");
  const [collapsedGroups, setCollapsedGroups] = useSessionState<string[]>("jobs-accounts:groupCollapsed", EMPTY);
  // Persisted so returning from a contact/opportunity detail page restores the
  // same account rows expanded.
  const [expandedList, setExpandedList] = useSessionState<string[]>("jobs-accounts:expanded", EMPTY);
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  const setExpanded = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => setExpandedList((prev) => [...updater(new Set(prev))]),
    [setExpandedList],
  );

  const { sort, toggle, setSort } = useSort<ColKey>({ key: "status", direction: "asc" });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:jobs-accounts", COLUMN_ORDER, DEFAULT_VISIBLE);
  const { widths, startResize } = useColumnWidths<ColKey>("bedrock-v2:cols:jobs-accounts", DEFAULT_WIDTHS);

  const { data: rawAccounts = [], isLoading, isError, refetch } = useJobsAccounts("all", scope);
  // Historical Pursuit fellows hired, from Salesforce (Affiliation object),
  // keyed by SF account id. Merged in client-side so /accounts stays SF-free
  // and the page still renders if SF is unavailable. When the affiliation
  // object isn't configured, fellows stays null (Hired = builders only).
  const { data: fellowsData } = useAccountsWithFellows();
  const accounts = useMemo(() => {
    if (!fellowsData?.affiliation_available) return rawAccounts;
    const counts = fellowsData.fellow_counts ?? {};
    return rawAccounts.map((a) => {
      // Sum fellow counts across every SF account id this account maps to
      // (a company can have more than one SF account record).
      const ids = a.sf_account_ids?.length ? a.sf_account_ids : (a.account_id ? [a.account_id] : []);
      const fellows = ids.reduce((sum, id) => sum + (counts[id] ?? 0), 0);
      return { ...a, fellows_hired: fellows };
    });
  }, [rawAccounts, fellowsData]);
  const { data: staff = [] } = useJobsStaff();
  const updateAccount = useUpdateJobsAccount();
  const saveOwner = useCallback(
    (account: string, email: string) => updateAccount.mutateAsync({ account, owner_email: email }).then(() => undefined),
    [updateAccount],
  );

  const ownerOptions = useMemo(() => {
    const emails = [...new Set(accounts.map((a) => a.owner_email).filter(Boolean) as string[])];
    return emails.map((e) => ({ value: e, label: staff.find((s) => s.email === e)?.name ?? e.split("@")[0] }));
  }, [accounts, staff]);
  const industryOptions = useMemo(() => {
    const vals = [...new Set(accounts.map((a) => a.industry).filter(Boolean) as string[])].sort();
    return vals.map((v) => ({ value: v, label: v }));
  }, [accounts]);
  const selectOptions: Partial<Record<Field, { value: string; label: string }[]>> = useMemo(() => ({
    status: STATUSES.map((s) => ({ value: s, label: s })),
    owner: ownerOptions,
    industry: industryOptions,
    has_opps: YESNO, has_contacts: YESNO,
    last_activity: RECENCY_OPTIONS,
  }), [ownerOptions, industryOptions]);

  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  const toggleGroup = useCallback((k: string) => setCollapsedGroups((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]), [setCollapsedGroups]);
  const toggleRow = useCallback((acct: string) => setExpanded((p) => { const n = new Set(p); n.has(acct) ? n.delete(acct) : n.add(acct); return n; }), [setExpanded]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const f = accounts.filter((a) => {
      for (const r of rules) if (!ruleApplies(a, r, FILTERABLE)) return false;
      if (!q) return true;
      // Prospects aren't in the list payload anymore (loaded lazily on expand),
      // so account search matches the company name + its opportunity titles.
      // People search lives on the Contacts page.
      return a.account.toLowerCase().includes(q)
        || a.opportunities.some((o) => (o.title ?? "").toLowerCase().includes(q));
    });
    return sort.key == null ? f : sortBy(f, sort, (a, k) => extract(a, k));
  }, [accounts, q, rules, sort]);

  const groupLabel = useCallback((k: string) => {
    if (k === "") return "—";
    if (groupBy === "owner") return staff.find((s) => s.email === k)?.name ?? k;
    if (groupBy === "has_opps") return k === "yes" ? "Has opportunities" : "No opportunities";
    return k;
  }, [groupBy, staff]);

  type DisplayRow = { kind: "row"; a: JobsAccount } | { kind: "header"; key: string; label: string; count: number; collapsed: boolean };
  const grouped: DisplayRow[] | null = useMemo(() => {
    if (!groupBy) return null;
    const field = FILTERABLE[groupBy as Field]; if (!field) return null;
    const buckets = new Map<string, JobsAccount[]>();
    for (const a of filtered) { const k = String(field.getValue(a) ?? ""); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(a); }
    const out: DisplayRow[] = [];
    for (const k of [...buckets.keys()].sort((x, y) => groupLabel(x).localeCompare(groupLabel(y)))) {
      const list = buckets.get(k)!; const collapsed = collapsedSet.has(k);
      out.push({ kind: "header", key: k, label: groupLabel(k), count: list.length, collapsed });
      if (!collapsed) for (const a of list) out.push({ kind: "row", a });
    }
    return out;
  }, [filtered, groupBy, collapsedSet, groupLabel]);

  const totals = useMemo(() => filtered.reduce((acc, a) => ({ opps: acc.opps + a.opp_count, contacts: acc.contacts + a.prospect_count }), { opps: 0, contacts: 0 }), [filtered]);
  const tableMinWidth = visibleCols.reduce((s, k) => s + widths[k], 0);

  const renderRow = (a: JobsAccount) => (
    <AccountRow key={a.account} account={a} expanded={expanded.has(a.account)} onToggle={() => toggleRow(a.account)} visibleCols={visibleCols} staff={staff} onSaveOwner={saveOwner} scope={scope} />
  );

  return (
    <div className="flex flex-col px-5 py-2">
      {showNew && <NewAccountDialog onClose={() => setShowNew(false)} />}
      <Toolbar>
        <div className="relative shrink-0">
          <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input placeholder="Search accounts, contacts, opportunities…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 w-64 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink" />
        </div>
        <AddFilterButton<Field> filterable={FILTERABLE as Record<Field, FieldMeta<unknown>>} selectOptions={selectOptions} onAdd={(r) => setRules((p) => [...p, r])} buttonLabel="Filter" />
        <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value); setCollapsedGroups([]); }} title="Group rows by a field" className="h-7 shrink-0 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as "engaged" | "all")} title="Engaged hides cold, untouched contacts; All shows every jobs account" className="h-7 shrink-0 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          <option value="engaged">Engaged</option>
          <option value="all">All accounts</option>
        </select>
        <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-ink-4" title={isLoading ? undefined : `${totals.opps} opportunities · ${totals.contacts} contacts`}>{isLoading ? "…" : `${filtered.length.toLocaleString()} account${filtered.length === 1 ? "" : "s"}`}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visibleCols} required={["account"]} onToggle={toggleCol} />
          <SavedViewsPicker<JobsAccountsView>
            scopeKey="jobs-accounts"
            currentFilters={{ query, rules, visibleCols, groupBy, sort }}
            onLoad={(v) => {
              setQuery(v.query ?? ""); setRules(v.rules ?? []); setGroupBy(v.groupBy ?? ""); setCollapsedGroups([]);
              if (v.visibleCols?.length) replaceVisibleCols(v.visibleCols);
              if (v.sort) setSort(v.sort);
            }}
          />
          <button type="button" onClick={() => setShowNew(true)} className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"><Plus size={13} className="shrink-0" /> New account</button>
        </div>
      </Toolbar>

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip key={r.id} label={describeRule(r, FILTERABLE, (f, v) => f === "owner" ? (staff.find((s) => s.email === v)?.name ?? v) : f === "last_activity" ? recencyLabel(v) : v)} onRemove={() => setRules((p) => p.filter((x) => x.id !== r.id))} />
          ))}
          <button type="button" onClick={() => setRules([])} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      )}

      <div
        className="overflow-auto rounded-b-lg border border-border-strong bg-surface"
        style={{ maxHeight: "calc(100vh - 220px)" }}
      >
        {/* Bounded data-grid viewport: scrolls both axes internally with a
            sticky header and pinned first column (same shell as
            Opportunities); columns keep real, user-resizable pixel widths. */}
        <table className="w-full table-fixed border-collapse" style={{ minWidth: tableMinWidth }}>
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-20 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              {visibleCols.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  isLast={idx === visibleCols.length - 1}
                  className={cn("py-1.5 font-semibold", idx === 0 && "sticky left-0 z-30")}
                >
                  {SORTABLE.has(key) ? <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} /> : COL_LABELS[key]}
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading accounts…</td></tr>
            ) : isError ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-red">Couldn't load accounts.{" "}
                <button type="button" className="text-accent underline underline-offset-2" onClick={() => refetch()}>Retry</button></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">No accounts match.{" "}
                <button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setRules([]); }}>Clear filters</button></td></tr>
            ) : grouped ? (
              grouped.map((item) => item.kind === "header" ? (
                <tr key={`g-${item.key}`} className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2" onClick={() => toggleGroup(item.key)}>
                  <td colSpan={visibleCols.length} className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2">
                    <span className="inline-block w-3 text-ink-3">{item.collapsed ? "▸" : "▾"}</span>{item.label}<span className="ml-2 normal-case tracking-normal text-ink-3">{item.count}</span>
                  </td>
                </tr>
              ) : renderRow(item.a))
            ) : (
              <>
                {(showAll ? filtered : filtered.slice(0, RENDER_CAP)).map(renderRow)}
                {!showAll && filtered.length > RENDER_CAP && (
                  <tr><td colSpan={visibleCols.length} className="px-6 py-3 text-center text-[12.5px] text-ink-3">
                    Showing {RENDER_CAP} of {filtered.length} — search or filter to narrow, or{" "}
                    <button type="button" className="text-accent underline underline-offset-2" onClick={() => setShowAll(true)}>show all</button>.
                  </td></tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * /jobs/accounts — Accounts as its own routed page (2026-07 nav restructure).
 * Deep-link param: ?q=<text> seeds the account search.
 */
export function JobsAccountsPage() {
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? undefined;
  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader title="Accounts" subtitle="Account-level hub — opportunities and contacts." />
      <JobsAccountHub initialQuery={initialQuery} />
    </div>
  );
}
