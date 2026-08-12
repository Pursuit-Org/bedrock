import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Plus, Search, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AccountExpandPanel, ACCOUNT_PANEL_HEIGHT } from "@/components/AccountExpandPanel";
import { PageHeader } from "@/components/PageHeader";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import {
  buildAccountMetricsMap,
  ZERO_ACCOUNT_METRICS as ZERO_METRICS,
  type AccountMetrics,
} from "@/lib/accountMetrics";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { fmtMoney } from "@/lib/format";
import { sortBy, type SortState } from "@/lib/sort";
import { cn } from "@/lib/utils";
import { useSessionState } from "@/lib/useSessionState";
import { AccountAvatar } from "@/components/AccountAvatar";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "@/pages/cleanup/Filters";
import {
  useAccounts,
  useAccountsEnrichment,
  useCreateAccount,
  useUpdateAccount,
} from "@/services/accounts";
import { useOpportunities } from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import { useActiveUsers, useUsers } from "@/services/users";
import type { SfAccount } from "@/types/salesforce";
import { accountStatusVariant } from "@/lib/accountStatus";
import { toast } from "sonner";

const TYPE_FILTERS = ["All", "Foundation", "Corporate", "Government", "Individual"] as const;
// Stable empty-array reference for the default of the
// collapsedGroups / rules useSessionState. See note on useSessionState
// dep-stability where this is used.
const EMPTY_COLLAPSED: string[] = [];
const EMPTY_RULES: FilterRule<AccountField>[] = [];
type TypeFilter = (typeof TYPE_FILTERS)[number];

function matchesType(account: SfAccount, filter: TypeFilter): boolean {
  if (filter === "All") return true;
  const t = (account.Type ?? "").toLowerCase();
  if (filter === "Foundation") return t.includes("foundation");
  if (filter === "Corporate") return t.includes("corporate") || t.includes("corporation");
  if (filter === "Government") return t.includes("government") || t.includes("public");
  if (filter === "Individual") return t.includes("individual");
  return true;
}


// ── Chip filter model ────────────────────────────────────────────────────
//
// Mirrors the Cleanup tabs' filter rig so the same operator catalog,
// chip rendering, and saved-view payload work here. Native fields
// (Owner, Type, Tier, Industry, State, flags, last activity) are in
// the static base; computed metrics (open pipeline, won, received,
// outstanding) join in via useMemo so they can read the metrics map.

const ACCOUNTS_FILTERABLE_BASE = {
  name: { label: "Name", type: "text", getValue: (a: SfAccount) => a.Name ?? "" },
  owner: { label: "Owner", type: "select", getValue: (a: SfAccount) => a.OwnerId ?? "" },
  status: { label: "Status", type: "select", getValue: (a: SfAccount) => a.account_status ?? "" },
  type: {
    label: "Type",
    type: "select",
    // Households live on a separate NPSP record type ("HH Account")
    // and often have an empty SF Type field, so a filter like
    // "Type is not Household" was leaking them through. Coalesce
    // record-type-driven Household identity into the Type bucket so
    // the filter actually catches every household account.
    getValue: (a: SfAccount) => {
      if (a.Type) return a.Type;
      const rt = (a.RecordType?.Name ?? "").toLowerCase();
      if (rt.includes("household") || rt === "hh account") return "Household";
      if ((a.Name ?? "").toLowerCase().endsWith("household")) return "Household";
      return "";
    },
  },
  tier: { label: "Tier", type: "select", getValue: (a: SfAccount) => a.Account_Tier__c ?? "" },
  industry: { label: "Industry", type: "text", getValue: (a: SfAccount) => a.Industry ?? "" },
  state: { label: "State", type: "text", getValue: (a: SfAccount) => a.BillingState ?? "" },
  philanthropy: {
    label: "Philanthropy",
    type: "select",
    getValue: (a: SfAccount) => (a.Philanthropy__c ? "Yes" : "No"),
  },
  active: {
    label: "Active",
    type: "select",
    getValue: (a: SfAccount) => (a.Active__c ? "Yes" : "No"),
  },
  lastActivity: {
    label: "Last activity",
    type: "date",
    getValue: (a: SfAccount) => a.Last_Activity_Date__c ?? null,
  },
} satisfies Record<string, FieldMeta<SfAccount>>;

type AccountField =
  | keyof typeof ACCOUNTS_FILTERABLE_BASE
  | "openPipeline"
  | "amountWon"
  | "received"
  | "outstanding"
  | "wonPhilanthropy"
  | "wonPBC"
  | "wonDebtEquity"
  | "wonOtherFFS";

interface AccountsSavedView {
  filter?: TypeFilter;
  rules?: FilterRule<AccountField>[];
  visibleCols?: ColKey[];
  widths?: Partial<Record<ColKey, number>>;
}

type ColKey =
  | "name"
  | "owner"
  | "status"
  | "openPipeline"
  | "amountWon"
  | "received"
  | "outstanding"
  | "wonPhilanthropy"
  | "wonPBC"
  | "wonDebtEquity"
  | "wonOtherFFS";

// Won-by-record-type columns are hidden by default — they're long, and
// most users only want them when slicing by funding source. Toggle on
// via the column chooser.
const COLUMN_ORDER: ColKey[] = [
  "name",
  "owner",
  "status",
  "openPipeline",
  "amountWon",
  "received",
  "outstanding",
  "wonPhilanthropy",
  "wonPBC",
  "wonDebtEquity",
  "wonOtherFFS",
];

const DEFAULT_VISIBLE: ColKey[] = [
  "name",
  "owner",
  "status",
  "openPipeline",
  "amountWon",
  "received",
  "outstanding",
];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 280,
  owner: 160,
  status: 130,
  openPipeline: 130,
  amountWon: 130,
  received: 120,
  outstanding: 130,
  wonPhilanthropy: 140,
  wonPBC: 110,
  wonDebtEquity: 140,
  wonOtherFFS: 140,
};

const COL_LABELS: Record<ColKey, string> = {
  name: "Account",
  owner: "Account owner",
  status: "Status",
  openPipeline: "Open pipeline",
  amountWon: "Amount won",
  received: "Received",
  outstanding: "Outstanding",
  wonPhilanthropy: "Won: Philanthropy",
  wonPBC: "Won: PBC",
  wonDebtEquity: "Won: Debt / Equity",
  wonOtherFFS: "Won: Other FFS",
};

const ROW_HEIGHT = 44; // px — must match the row's actual rendered height

/** Stable router-state passed when opening an account from this page,
 *  so AccountDetail's BackLink renders "Back to Accounts" instead of
 *  the static default. Constant ref so memoized rows don't re-render. */
const ACCOUNTS_REFERRER = {
  from: { pathname: "/accounts", label: "Accounts" },
} as const;

function extractAccount(
  a: SfAccount,
  metrics: AccountMetrics,
  key: ColKey,
): unknown {
  switch (key) {
    case "name": return a.Name;
    case "owner": return a.Owner?.Name;
    case "status": return a.account_status ?? "";
    case "openPipeline": return metrics.openPipeline;
    case "amountWon": return metrics.amountWon;
    case "received": return metrics.received;
    case "outstanding": return metrics.outstanding;
    case "wonPhilanthropy": return metrics.wonByRecordType["Philanthropy"] ?? 0;
    case "wonPBC": return metrics.wonByRecordType["PBC"] ?? 0;
    case "wonDebtEquity": return metrics.wonByRecordType["Debt / Equity"] ?? 0;
    case "wonOtherFFS": return metrics.wonByRecordType["Other Fee For Service"] ?? 0;
  }
}

export function AccountsPage() {
  const navigate = useNavigate();
  const accountsQ = useAccounts();
  const oppsQ = useOpportunities();
  const usersQ = useActiveUsers();
  // All users (active + inactive). Used only for the chip-filter owner
  // facet — write-side pickers stay on `usersQ` (active only).
  const allUsersQ = useUsers();
  const updateAccount = useUpdateAccount();
  const canEdit = usePerm("edit_accounts");

  const [filter, setFilter] = useSessionState<TypeFilter>("accounts:filter", "All");
  const [q, setQ] = useSessionState<string>("accounts:q", "");
  const [rules, setRules] = useSessionState<FilterRule<AccountField>[]>("accounts:rules", EMPTY_RULES);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useSessionState<string | null>("accounts:expandedId", null);
  // Optional group-by — when non-empty, the visible rows are bucketed
  // under a sticky group header per distinct value of this field.
  // Persisted per session so navigating away + back keeps the view.
  // EMPTY_COLLAPSED is a stable reference so useSessionState's setter
  // identity doesn't churn every render — a new `[]` literal in the
  // call site would make the setter dep unstable.
  const [groupBy, setGroupBy] = useSessionState<string>("accounts:groupBy", "");
  const [collapsedGroups, setCollapsedGroups] = useSessionState<string[]>(
    "accounts:groupCollapsed",
    EMPTY_COLLAPSED,
  );
  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsedGroups((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
      ),
    [setCollapsedGroups],
  );

  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility("bedrock-v2:vis:accounts", COLUMN_ORDER, DEFAULT_VISIBLE);

  const [sort, setSort] = useSessionState<SortState<ColKey>>("accounts:sort", {
    key: "openPipeline",
    direction: "desc",
  });
  const toggle = useCallback(
    (key: ColKey) =>
      setSort((prev) => {
        if (prev.key !== key) return { key, direction: "asc" };
        if (prev.direction === "asc") return { key, direction: "desc" };
        return { key: null, direction: "asc" };
      }),
    [setSort],
  );
  const { widths, startResize, replaceAll: replaceWidths } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:accounts",
    DEFAULT_WIDTHS,
  );

  const accounts = accountsQ.data ?? [];
  const opps = oppsQ.data ?? [];

  const metricsByAccount = useMemo(() => buildAccountMetricsMap(opps), [opps]);

  // Logos / domains from public.companies via the bridge map. Fetch once
  // for every visible account in a single batched request (cap 1000).
  const accountIds = useMemo(() => accounts.map((a) => a.Id), [accounts]);
  const enrichmentQ = useAccountsEnrichment(accountIds);
  const enrichment = enrichmentQ.data ?? {};

  // Filterable extends the static base with metric fields that need
  // metricsByAccount to resolve. Re-built only when the metrics map
  // identity changes — cheap.
  const filterable = useMemo(
    () => ({
      ...ACCOUNTS_FILTERABLE_BASE,
      openPipeline: {
        label: "Open pipeline",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.openPipeline ?? 0,
      },
      amountWon: {
        label: "Amount won",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.amountWon ?? 0,
      },
      received: {
        label: "Received",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.received ?? 0,
      },
      outstanding: {
        label: "Outstanding",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.outstanding ?? 0,
      },
      wonPhilanthropy: {
        label: "Won: Philanthropy",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.wonByRecordType["Philanthropy"] ?? 0,
      },
      wonPBC: {
        label: "Won: PBC",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.wonByRecordType["PBC"] ?? 0,
      },
      wonDebtEquity: {
        label: "Won: Debt / Equity",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.wonByRecordType["Debt / Equity"] ?? 0,
      },
      wonOtherFFS: {
        label: "Won: Other FFS",
        type: "number",
        getValue: (a: SfAccount) =>
          metricsByAccount.get(a.Id)?.wonByRecordType["Other Fee For Service"] ?? 0,
      },
    }) as Record<AccountField, FieldMeta<SfAccount>>,
    [metricsByAccount],
  );

  // Accounts that match the toolbar filters (type pill + search). Used
  // to populate the chip-filter owner facet so it reflects what's
  // visible in the table, not the entire server load. Chip `rules` are
  // intentionally excluded — if applied, the owner picker would
  // collapse to whichever owner you'd already filtered to.
  const accountsInView = useMemo(() => {
    const needle = q.toLowerCase();
    return accounts.filter((a) => {
      if (!matchesType(a, filter)) return false;
      if (q) {
        const hit =
          (a.Name ?? "").toLowerCase().includes(needle) ||
          (a.Owner?.Name ?? "").toLowerCase().includes(needle);
        if (!hit) return false;
      }
      return true;
    });
  }, [accounts, filter, q]);

  // Chip-filter facets — owner options are the union of:
  //   (a) every active SF user, and
  //   (b) inactive users that own at least one row in the current view.
  // type/tier come from the accounts visible in the current view.
  const chipFacets = useMemo(() => {
    const all = allUsersQ.data ?? [];
    const activeById = new Map(
      all.filter((u) => u.IsActive).map((u) => [u.Id, u]),
    );
    const inactiveById = new Map(
      all.filter((u) => !u.IsActive).map((u) => [u.Id, u]),
    );

    const ownersInView = new Set<string>();
    const ownerNameFromData = new Map<string, string>();
    const types = new Set<string>();
    const tiers = new Set<string>();
    for (const a of accountsInView) {
      if (a.OwnerId) {
        ownersInView.add(a.OwnerId);
        if (a.Owner?.Name) ownerNameFromData.set(a.OwnerId, a.Owner.Name);
      }
      if (a.Type) types.add(a.Type);
      if (a.Account_Tier__c) tiers.add(a.Account_Tier__c);
    }

    type OwnerOption = { value: string; label: string };
    const ownerOptions: OwnerOption[] = [];
    for (const u of activeById.values()) {
      ownerOptions.push({ value: u.Id, label: u.Name });
    }
    for (const id of ownersInView) {
      if (activeById.has(id)) continue;
      const inactive = inactiveById.get(id);
      const name = inactive?.Name ?? ownerNameFromData.get(id) ?? id;
      ownerOptions.push({ value: id, label: `${name} (inactive)` });
    }
    ownerOptions.sort((x, y) => x.label.localeCompare(y.label));

    const yesNo = [
      { value: "Yes", label: "Yes" },
      { value: "No", label: "No" },
    ];
    // Account status is a fixed enum from the playbook — surface all
    // five values regardless of whether the current view has any of
    // each, so users can filter to e.g. "Re-activating" even when the
    // panel doesn't currently show any.
    const status = [
      { value: "Prospect", label: "Prospect" },
      { value: "Pursuing", label: "Pursuing" },
      { value: "Stewarding", label: "Stewarding" },
      { value: "Re-activating", label: "Re-activating" },
      { value: "Dormant", label: "Dormant" },
    ];

    return {
      owner: ownerOptions,
      status,
      type: Array.from(types).sort().map((v) => ({ value: v, label: v })),
      tier: Array.from(tiers).sort().map((v) => ({ value: v, label: v })),
      philanthropy: yesNo,
      active: yesNo,
    };
  }, [accountsInView, allUsersQ.data]);

  const ownerLabelLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of usersQ.data ?? []) m.set(u.Id, u.Name);
    for (const a of accounts) {
      if (a.OwnerId && !m.has(a.OwnerId) && a.Owner?.Name) {
        m.set(a.OwnerId, a.Owner.Name);
      }
    }
    return (id: string) => m.get(id) ?? id;
  }, [usersQ.data, accounts]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    const f = accounts.filter((a) => {
      if (!matchesType(a, filter)) return false;
      if (q) {
        const hit =
          (a.Name ?? "").toLowerCase().includes(needle) ||
          (a.Owner?.Name ?? "").toLowerCase().includes(needle);
        if (!hit) return false;
      }
      for (const r of rules) {
        if (!ruleApplies(a, r, filterable)) return false;
      }
      return true;
    });
    return sortBy(f, sort, (a, key) =>
      extractAccount(a, metricsByAccount.get(a.Id) ?? ZERO_METRICS, key),
    );
  }, [accounts, filter, q, rules, filterable, sort, metricsByAccount]);

  // Group-by: build a flat list of {kind:'header', ...} and
  // {kind:'row', a} items so the virtualizer can render mixed
  // shapes. When groupBy is empty we short-circuit to `null` and the
  // body iterates `filtered` directly — avoids allocating a 25k-item
  // wrapped array on every React Query refetch.
  type DisplayRow =
    | { kind: "row"; account: SfAccount }
    | { kind: "header"; key: string; label: string; count: number; collapsed: boolean };
  const groupedRows: DisplayRow[] | null = useMemo(() => {
    if (!groupBy) return null;
    const field = filterable[groupBy as keyof typeof filterable];
    if (!field) return null;
    const buckets = new Map<string, SfAccount[]>();
    for (const a of filtered) {
      const raw = field.getValue(a);
      const k = raw == null || raw === "" ? "" : String(raw);
      const list = buckets.get(k);
      if (list) list.push(a);
      else buckets.set(k, [a]);
    }
    const labelFor = (k: string) => {
      if (k === "") return "—";
      if (groupBy === "owner") return ownerLabelLookup(k);
      return k;
    };
    const sortedKeys = [...buckets.keys()].sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
    const out: DisplayRow[] = [];
    for (const k of sortedKeys) {
      const list = buckets.get(k) ?? [];
      const collapsed = collapsedSet.has(k);
      out.push({
        kind: "header",
        key: k,
        label: labelFor(k),
        count: list.length,
        collapsed,
      });
      if (!collapsed) {
        for (const a of list) out.push({ kind: "row", account: a });
      }
    }
    return out;
  }, [filtered, groupBy, filterable, collapsedSet, ownerLabelLookup]);
  const rowCount = groupedRows?.length ?? filtered.length;

  const totals = useMemo(
    () =>
      filtered.reduce<AccountMetrics>(
        (acc, a) => {
          const m = metricsByAccount.get(a.Id);
          if (!m) return acc;
          const summed: Record<string, number> = { ...acc.wonByRecordType };
          for (const [k, v] of Object.entries(m.wonByRecordType)) {
            summed[k] = (summed[k] ?? 0) + v;
          }
          return {
            openPipeline: acc.openPipeline + m.openPipeline,
            amountWon: acc.amountWon + m.amountWon,
            received: acc.received + m.received,
            outstanding: acc.outstanding + m.outstanding,
            wonByRecordType: summed,
          };
        },
        { ...ZERO_METRICS, wonByRecordType: { ...ZERO_METRICS.wonByRecordType } },
      ),
    [filtered, metricsByAccount],
  );

  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({
        value: u.Id,
        label: u.Name,
      })),
    [usersQ.data],
  );

  const saveOwner = useCallback(
    async (id: string, ownerId: string) => {
      // Resolve the owner's name so the row's display label updates
      // optimistically alongside OwnerId.
      const ownerName =
        (usersQ.data ?? []).find((u) => u.Id === ownerId)?.Name ?? null;
      await updateAccount.mutateAsync({
        id,
        patch: { OwnerId: ownerId },
        displayPatch: { Owner: { Name: ownerName } },
      });
    },
    [updateAccount, usersQ.data],
  );

  const isLoading = accountsQ.isLoading || oppsQ.isLoading;
  const isError = accountsQ.isError || oppsQ.isError;
  const error = accountsQ.error ?? oppsQ.error;

  const tableMinWidth = totalWidth(widths);

  // ── Virtualization ─────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const GROUP_HEADER_HEIGHT = 30;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      if (groupedRows) {
        const item = groupedRows[i];
        if (!item) return ROW_HEIGHT;
        if (item.kind === "header") return GROUP_HEADER_HEIGHT;
        return item.account.Id === expandedId
          ? ROW_HEIGHT + ACCOUNT_PANEL_HEIGHT
          : ROW_HEIGHT;
      }
      return filtered[i]?.Id === expandedId
        ? ROW_HEIGHT + ACCOUNT_PANEL_HEIGHT
        : ROW_HEIGHT;
    },
    overscan: 8,
  });
  // Only remeasure when the expand toggles — count changes are already
  // picked up by the virtualizer via its `count` prop, and including
  // the full row list in deps thrashed the main thread on every
  // refetch.
  useEffect(() => { virtualizer.measure(); }, [expandedId, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom =
    totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  return (
    <div className="flex h-full flex-col px-7 py-6 pb-6">
      <PageHeader
        title="Accounts"
        subtitle={
          isLoading
            ? "Loading…"
            : `${accounts.length.toLocaleString()} funder organizations · ${fmtMoney(totals.openPipeline)} open pipeline · ${fmtMoney(totals.amountWon)} won`
        }
        actions={
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex h-[30px] items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[13px] font-medium text-surface hover:opacity-90"
          >
            <Plus size={14} /> New account
          </button>
        }
      />

      <Toolbar>
        <ButtonGroup
          value={filter}
          onChange={(v) => setFilter(v as TypeFilter)}
          options={TYPE_FILTERS.map((t) => ({ value: t, label: t }))}
        />
        <div className="relative">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-56 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
        <AddFilterButton<AccountField>
          filterable={filterable as Record<AccountField, FieldMeta<unknown>>}
          selectOptions={{
            owner: chipFacets.owner,
            status: chipFacets.status,
            type: chipFacets.type,
            tier: chipFacets.tier,
            philanthropy: chipFacets.philanthropy,
            active: chipFacets.active,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <select
          value={groupBy}
          onChange={(e) => {
            setGroupBy(e.target.value);
            setCollapsedGroups([]);
          }}
          title="Group rows by a field"
          className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent"
        >
          <option value="">No grouping</option>
          <option value="owner">Group by Owner</option>
          <option value="status">Group by Status</option>
          <option value="type">Group by Type</option>
          <option value="tier">Group by Tier</option>
          <option value="state">Group by State</option>
          <option value="industry">Group by Industry</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser
            allColumns={COLUMN_ORDER}
            labels={COL_LABELS}
            visible={visibleCols}
            required={["name"]}
            onToggle={toggleCol}
          />
          <SavedViewsPicker<AccountsSavedView>
            scopeKey="accounts"
            currentFilters={{ filter, rules, visibleCols, widths }}
            onLoad={(v) => {
              setFilter(v.filter ?? "All");
              setRules(v.rules ?? []);
              if (v.visibleCols && v.visibleCols.length > 0) {
                replaceVisibleCols(v.visibleCols);
              }
              if (v.widths && Object.keys(v.widths).length > 0) {
                replaceWidths(v.widths);
              }
            }}
          />
        </div>
      </Toolbar>

      {/* Active filter chips. Border-attached strip — toolbar above
          (border-b-0) and table below (top border) sandwich it into
          one continuous card. px-3 matches the toolbar so the first
          chip aligns with the type pill above. */}
      {rules.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, filterable, (field, v) =>
                field === "owner" ? ownerLabelLookup(v) : v,
              )}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules([])}
            className="ml-1 whitespace-nowrap text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {/*
        Single scroll container. Header is sticky, body is virtualized via
        spacer rows above + below the visible window. Total row count
        stays under ~30 in the DOM regardless of dataset size.
      */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-b-lg border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{
            tableLayout: "fixed",
            width: "100%",
            minWidth: tableMinWidth,
          }}
        >
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-10">
            <tr>
              {visibleCols.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align="left"
                  isLast={idx === visibleCols.length - 1}
                >
                  <SortableHeader
                    label={COL_LABELS[key]}
                    sortKey={key}
                    sort={sort}
                    onToggle={toggle}
                  />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <SkeletonRows colCount={visibleCols.length} />
            ) : isError ? (
              <tr>
                <td
                  colSpan={visibleCols.length}
                  className="px-7 py-10 text-center text-[13px] text-red"
                >
                  Failed to load accounts
                  {error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleCols.length}
                  className="px-7 py-10 text-center text-[13px] text-ink-3"
                >
                  {accounts.length === 0
                    ? "No accounts. (Is Salesforce connected?)"
                    : "No accounts match your filters."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
                {virtualItems.map((vi) => {
                  // Two iteration shapes: grouped (with header rows
                  // mixed in) or plain (just account rows). Pick the
                  // current item based on which mode we're in.
                  let a: SfAccount | undefined;
                  if (groupedRows) {
                    const item = groupedRows[vi.index];
                    if (!item) return null;
                    if (item.kind === "header") {
                      return (
                        <tr
                          key={`grp-${item.key}`}
                          className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2"
                          onClick={() => toggleGroup(item.key)}
                        >
                          <td
                            colSpan={visibleCols.length}
                            className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2"
                          >
                            <span className="inline-block w-3 text-ink-3">
                              {item.collapsed ? "▸" : "▾"}
                            </span>
                            {item.label}
                            <span className="ml-2 normal-case tracking-normal text-ink-3">
                              {item.count}
                            </span>
                          </td>
                        </tr>
                      );
                    }
                    a = item.account;
                  } else {
                    a = filtered[vi.index];
                  }
                  if (!a) return null;
                  const isExpanded = a.Id === expandedId;
                  return (
                    <Fragment key={a.Id}>
                      <AccountRow
                        a={a}
                        m={metricsByAccount.get(a.Id) ?? ZERO_METRICS}
                        logoUrl={enrichment[a.Id]?.logo_url ?? null}
                        ownerOptions={ownerOptions}
                        onOpen={() => navigate(`/accounts/${a.Id}`, { state: ACCOUNTS_REFERRER })}
                        onSaveOwner={(id) => saveOwner(a.Id, id)}
                        isExpanded={isExpanded}
                        onToggleExpand={() => setExpandedId(isExpanded ? null : a.Id)}
                        canEdit={canEdit}
                        visibleCols={visibleCols}
                      />
                      {isExpanded ? (
                        <tr>
                          <td colSpan={visibleCols.length} className="p-0">
                            <AccountExpandPanel accountId={a.Id} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
          {filtered.length > 0 && !isLoading ? (
            <tfoot className="sticky bottom-0 z-10">
              <tr className="border-t border-border-strong bg-surface-2">
                {visibleCols.map((key, idx) => {
                  const totalsMap: Partial<Record<ColKey, string>> = {
                    openPipeline: fmtMoney(totals.openPipeline),
                    amountWon: fmtMoney(totals.amountWon),
                    received: fmtMoney(totals.received),
                    outstanding: fmtMoney(totals.outstanding),
                    wonPhilanthropy: fmtMoney(totals.wonByRecordType["Philanthropy"] ?? 0),
                    wonPBC: fmtMoney(totals.wonByRecordType["PBC"] ?? 0),
                    wonDebtEquity: fmtMoney(totals.wonByRecordType["Debt / Equity"] ?? 0),
                    wonOtherFFS: fmtMoney(totals.wonByRecordType["Other Fee For Service"] ?? 0),
                  };
                  const label = totalsMap[key];
                  if (idx === 0) {
                    return (
                      <td key={key} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                        Totals
                      </td>
                    );
                  }
                  return (
                    <td key={key} className="mono px-3 py-2 text-right text-[13px] font-semibold tabular-nums">
                      {label ?? ""}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {showCreate ? (
        <CreateAccountModal
          ownerOptions={ownerOptions}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            toast.success("Account created");
            navigate(`/accounts/${id}`, { state: ACCOUNTS_REFERRER });
          }}
        />
      ) : null}
    </div>
  );
}

function CreateAccountModal({
  ownerOptions,
  onClose,
  onCreated,
}: {
  ownerOptions: { value: string; label: string }[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const createAccount = useCreateAccount();
  const [form, setForm] = useState({
    Name: "",
    Type: "",
    Industry: "",
    Website: "",
    BillingCity: "",
    BillingState: "",
    OwnerId: "",
  });
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.Name.trim()) return;
    setError(null);
    try {
      const result = await createAccount.mutateAsync({
        Name: form.Name.trim(),
        Type: form.Type || undefined,
        Industry: form.Industry.trim() || undefined,
        Website: form.Website.trim() || undefined,
        BillingCity: form.BillingCity.trim() || undefined,
        BillingState: form.BillingState.trim() || undefined,
        OwnerId: form.OwnerId || undefined,
      });
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account.");
    }
  };

  const ACCT_TYPES = ["Prospect", "Customer", "Partner", "Government", "Foundation", "Corporation", "Other"];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-3">
          <span className="text-[14px] font-semibold">New account</span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3 px-5 py-4">
          <AcctField label="Name *">
            <input
              value={form.Name}
              onChange={set("Name")}
              placeholder="Organization name"
              required
              className={acctInputCls}
            />
          </AcctField>
          <AcctField label="Type">
            <select value={form.Type} onChange={set("Type")} className={acctInputCls}>
              <option value="">— select type —</option>
              {ACCT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </AcctField>
          <AcctField label="Industry">
            <input
              value={form.Industry}
              onChange={set("Industry")}
              placeholder="Technology, Finance…"
              className={acctInputCls}
            />
          </AcctField>
          <AcctField label="Website">
            <input
              value={form.Website}
              onChange={set("Website")}
              placeholder="https://example.com"
              className={acctInputCls}
            />
          </AcctField>
          <div className="grid grid-cols-2 gap-3">
            <AcctField label="City">
              <input value={form.BillingCity} onChange={set("BillingCity")} placeholder="New York" className={acctInputCls} />
            </AcctField>
            <AcctField label="State">
              <input value={form.BillingState} onChange={set("BillingState")} placeholder="NY" className={acctInputCls} />
            </AcctField>
          </div>
          <AcctField label="Owner">
            <select value={form.OwnerId} onChange={set("OwnerId")} className={acctInputCls}>
              <option value="">— unassigned —</option>
              {ownerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </AcctField>
          {error ? <p className="text-[12px] text-red-500">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border-strong px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!form.Name.trim() || createAccount.isPending}
              className="rounded border border-ink bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
            >
              {createAccount.isPending ? "Creating…" : "Create account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const acctInputCls =
  "w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink-3 placeholder:text-ink-4";

function AcctField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}

interface RowProps {
  a: SfAccount;
  m: AccountMetrics;
  logoUrl: string | null;
  ownerOptions: { value: string; label: string }[];
  onOpen: () => void;
  onSaveOwner: (ownerId: string) => Promise<void>;
  isExpanded: boolean;
  onToggleExpand: () => void;
  canEdit: boolean;
  visibleCols: ColKey[];
}

const AccountRow = memo(function AccountRow({
  a,
  m,
  logoUrl,
  ownerOptions,
  onOpen,
  onSaveOwner,
  isExpanded,
  onToggleExpand,
  canEdit,
  visibleCols,
}: RowProps) {
  const dash = <span className="text-ink-4">—</span>;

  const cells: Partial<Record<ColKey, React.ReactNode>> = {
    name: (
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="flex-shrink-0 text-ink-4 hover:text-ink-2 transition-colors"
          aria-label={isExpanded ? "Collapse tasks" : "Expand tasks"}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <AccountAvatar name={a.Name} logoUrl={logoUrl} website={a.Website} size={22} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onOpen}>
          <span className="block truncate font-medium hover:underline" title={a.Name}>
            {a.Name}
          </span>
          {a.BillingCity || a.BillingState ? (
            <span className="block truncate text-[11px] text-ink-3">
              {[a.BillingCity, a.BillingState].filter(Boolean).join(", ")}
            </span>
          ) : null}
        </div>
      </div>
    ),
    owner: canEdit ? (
      <InlineSelect
        value={a.OwnerId}
        options={ownerOptions}
        onSave={onSaveOwner}
        renderValue={(v) => (
          <span className="truncate text-[12.5px] text-ink-2">
            {a.Owner?.Name ?? ownerOptions.find((o) => o.value === v)?.label ?? "—"}
          </span>
        )}
      />
    ) : (
      <span className="truncate text-[12.5px] text-ink-2">{a.Owner?.Name ?? "—"}</span>
    ),
    status: a.account_status ? (
      <Tag variant={accountStatusVariant(a.account_status)}>{a.account_status}</Tag>
    ) : dash,
    openPipeline: m.openPipeline > 0 ? fmtMoney(m.openPipeline) : dash,
    amountWon: m.amountWon > 0 ? fmtMoney(m.amountWon) : dash,
    received: m.received > 0 ? fmtMoney(m.received) : dash,
    outstanding: m.outstanding > 0 ? fmtMoney(m.outstanding) : dash,
    wonPhilanthropy: (m.wonByRecordType["Philanthropy"] ?? 0) > 0
      ? fmtMoney(m.wonByRecordType["Philanthropy"]!) : dash,
    wonPBC: (m.wonByRecordType["PBC"] ?? 0) > 0
      ? fmtMoney(m.wonByRecordType["PBC"]!) : dash,
    wonDebtEquity: (m.wonByRecordType["Debt / Equity"] ?? 0) > 0
      ? fmtMoney(m.wonByRecordType["Debt / Equity"]!) : dash,
    wonOtherFFS: (m.wonByRecordType["Other Fee For Service"] ?? 0) > 0
      ? fmtMoney(m.wonByRecordType["Other Fee For Service"]!) : dash,
  };

  const wonP = m.wonByRecordType["Philanthropy"] ?? 0;
  const wonPBCVal = m.wonByRecordType["PBC"] ?? 0;
  const wonDE = m.wonByRecordType["Debt / Equity"] ?? 0;
  const wonOFFS = m.wonByRecordType["Other Fee For Service"] ?? 0;

  const cellCls: Partial<Record<ColKey, string>> = {
    name: "overflow-hidden px-3 py-1 text-[13px]",
    owner: "overflow-hidden px-3 py-1 text-[12.5px] text-ink-2",
    status: "overflow-hidden px-3 py-1",
    openPipeline: cn(numCell, m.openPipeline > 0 && "font-semibold text-accent-ink"),
    amountWon: cn(numCell, m.amountWon > 0 && "font-semibold text-green"),
    received: cn(numCell, m.received > 0 && "font-medium text-green"),
    outstanding: cn(numCell, m.outstanding > 0 && "font-medium text-amber"),
    wonPhilanthropy: cn(numCell, wonP > 0 && "font-medium text-green"),
    wonPBC: cn(numCell, wonPBCVal > 0 && "font-medium text-green"),
    wonDebtEquity: cn(numCell, wonDE > 0 && "font-medium text-green"),
    wonOtherFFS: cn(numCell, wonOFFS > 0 && "font-medium text-green"),
  };

  const clickable = new Set<ColKey>([
    "openPipeline", "amountWon", "received", "outstanding",
    "wonPhilanthropy", "wonPBC", "wonDebtEquity", "wonOtherFFS",
  ]);

  return (
    <tr
      className="group/row border-b border-border-strong hover:bg-surface-2"
      style={{ height: ROW_HEIGHT }}
    >
      {visibleCols.map((key) => (
        <td
          key={key}
          className={cellCls[key]}
          onClick={clickable.has(key) ? onOpen : undefined}
        >
          {cells[key]}
        </td>
      ))}
    </tr>
  );
});

const numCell =
  "mono px-3 py-1 text-right text-[13px] tabular-nums overflow-hidden truncate cursor-pointer";

function SkeletonRows({ colCount }: { colCount: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="border-b border-border-strong">
          <td colSpan={colCount} className="px-3 py-2.5">
            <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
          </td>
        </tr>
      ))}
    </>
  );
}
