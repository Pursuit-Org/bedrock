/**
 * Portfolio · Accounts table.
 *
 * Compact table of the user's accounts, with chevron-to-expand rows that
 * mount the existing {@link AccountExpandPanel} (tasks/opps/awards/activity).
 * Top-level fields are inline-editable via the same hooks the global
 * Accounts page uses, so a change here propagates everywhere through
 * React Query cache.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink, Pin, Search, X } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { AccountExpandPanel } from "@/components/AccountExpandPanel";
import { SectionCard, withReferrer } from "@/components/detail";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineText } from "@/components/ui/InlineEdit";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { ButtonGroup } from "@/components/ui/Toolbar";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import {
  buildAccountMetricsMap,
  ZERO_ACCOUNT_METRICS as ZERO_METRICS,
} from "@/lib/accountMetrics";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { fmtMoney } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { useSessionState } from "@/lib/useSessionState";
import { useAccountsEnrichment, useUpdateAccount } from "@/services/accounts";
import { useOpportunities } from "@/services/opportunities";
import type { SfAccount } from "@/types/salesforce";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "@/pages/cleanup/Filters";

// ── Filter / column model ────────────────────────────────────────────────

const TYPE_FILTERS = ["All", "Foundation", "Corporate", "Government", "Individual"] as const;
type TypeFilter = (typeof TYPE_FILTERS)[number];

type ColKey = "name" | "type" | "status" | "openPipeline" | "amountWon";
type AccountField = ColKey | "tier" | "philanthropy" | "active";

const COLUMN_ORDER: ColKey[] = ["name", "type", "status", "openPipeline", "amountWon"];
const DEFAULT_VISIBLE: ColKey[] = ["name", "type", "status", "openPipeline", "amountWon"];
const COL_LABELS: Record<ColKey, string> = {
  name: "Account",
  type: "Type",
  status: "Status",
  openPipeline: "Open pipeline",
  amountWon: "Won (FY)",
};

const EMPTY_RULES: FilterRule<AccountField>[] = [];

interface PortfolioSavedView {
  filter?: TypeFilter;
  rules?: FilterRule<AccountField>[];
  visibleCols?: ColKey[];
}

const PORTFOLIO_FILTERABLE_BASE = {
  name: { label: "Name", type: "text", getValue: (a: SfAccount) => a.Name ?? "" },
  status: { label: "Status", type: "select", getValue: (a: SfAccount) => a.account_status ?? "" },
  type: { label: "Type", type: "select", getValue: (a: SfAccount) => a.Type ?? "" },
  tier: { label: "Tier", type: "select", getValue: (a: SfAccount) => a.Account_Tier__c ?? "" },
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
} satisfies Record<string, FieldMeta<SfAccount>>;

function matchesType(account: SfAccount, filter: TypeFilter): boolean {
  if (filter === "All") return true;
  const t = (account.Type ?? "").toLowerCase();
  if (filter === "Foundation") return t.includes("foundation");
  if (filter === "Corporate") return t.includes("corporate") || t.includes("corporation");
  if (filter === "Government") return t.includes("government") || t.includes("public");
  if (filter === "Individual") return t.includes("individual");
  return true;
}

// ── Pin persistence ──────────────────────────────────────────────────────

const PIN_KEY = "bedrock-v2:portfolio-pinned-accounts";

function loadPins(): Set<string> {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

// ── Component ────────────────────────────────────────────────────────────

interface PortfolioAccountsProps {
  accounts: SfAccount[];
  loading: boolean;
  sfReady: boolean;
  canEdit: boolean;
}

export function PortfolioAccounts({ accounts, loading, sfReady, canEdit }: PortfolioAccountsProps) {
  const oppsQ = useOpportunities();
  const updateAccount = useUpdateAccount();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [q, setQ] = useSessionState<string>("portfolio:accounts:q", "");
  const [typeFilter, setTypeFilter] = useSessionState<TypeFilter>("portfolio:accounts:filter", "All");
  const [rules, setRules] = useSessionState<FilterRule<AccountField>[]>(
    "portfolio:accounts:rules",
    EMPTY_RULES,
  );
  const [groupBy, setGroupBy] = useSessionState<string>("portfolio:accounts:groupBy", "");
  const [pinned, setPinned] = useState<Set<string>>(loadPins);
  const { sort, toggle } = useSort<ColKey>();
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>(
      "bedrock-v2:vis:portfolio-accounts",
      COLUMN_ORDER,
      DEFAULT_VISIBLE,
    );

  useEffect(() => {
    localStorage.setItem(PIN_KEY, JSON.stringify([...pinned]));
  }, [pinned]);

  const togglePin = (id: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const enrichmentQ = useAccountsEnrichment(accounts.map((a) => a.Id));
  const metricsByAccount = useMemo(
    () => buildAccountMetricsMap(oppsQ.data ?? []),
    [oppsQ.data],
  );

  const filterable = useMemo(
    () =>
      ({
        ...PORTFOLIO_FILTERABLE_BASE,
        openPipeline: {
          label: "Open pipeline",
          type: "number",
          getValue: (a: SfAccount) => metricsByAccount.get(a.Id)?.openPipeline ?? 0,
        },
        amountWon: {
          label: "Amount won",
          type: "number",
          getValue: (a: SfAccount) => metricsByAccount.get(a.Id)?.amountWon ?? 0,
        },
      }) as Record<AccountField, FieldMeta<SfAccount>>,
    [metricsByAccount],
  );

  const chipFacets = useMemo(() => {
    const types = new Set<string>();
    const tiers = new Set<string>();
    for (const a of accounts) {
      if (a.Type) types.add(a.Type);
      if (a.Account_Tier__c) tiers.add(a.Account_Tier__c);
    }
    const yesNo = [
      { value: "Yes", label: "Yes" },
      { value: "No", label: "No" },
    ];
    return {
      status: [
        { value: "Prospect", label: "Prospect" },
        { value: "Pursuing", label: "Pursuing" },
        { value: "Stewarding", label: "Stewarding" },
        { value: "Re-activating", label: "Re-activating" },
        { value: "Dormant", label: "Dormant" },
        { value: "Deprioritized", label: "Deprioritized" },
        { value: "On Hold", label: "On Hold" },
      ],
      type: Array.from(types)
        .sort()
        .map((v) => ({ value: v, label: v })),
      tier: Array.from(tiers)
        .sort()
        .map((v) => ({ value: v, label: v })),
      philanthropy: yesNo,
      active: yesNo,
    };
  }, [accounts]);

  const pinnedAccounts = useMemo(
    () => accounts.filter((a) => pinned.has(a.Id)),
    [accounts, pinned],
  );

  const visible = useMemo(() => {
    const needle = q.toLowerCase();
    const filtered = accounts.filter((a) => {
      if (pinned.has(a.Id)) return false;
      if (!matchesType(a, typeFilter)) return false;
      if (q && !(a.Name ?? "").toLowerCase().includes(needle)) return false;
      for (const r of rules) {
        if (!ruleApplies(a, r, filterable)) return false;
      }
      return true;
    });
    return sortBy(filtered, sort, (a, key) => {
      const m = metricsByAccount.get(a.Id) ?? ZERO_METRICS;
      switch (key) {
        case "name": return a.Name;
        case "type": return a.Type ?? "";
        case "status": return a.account_status ?? "";
        case "openPipeline": return m.openPipeline;
        case "amountWon": return m.amountWon;
      }
    });
  }, [accounts, q, typeFilter, rules, filterable, pinned, sort, metricsByAccount]);

  // Grouping for non-pinned rows
  type DisplayRow =
    | { kind: "row"; account: SfAccount }
    | { kind: "header"; key: string; label: string; count: number };

  const groupedVisible = useMemo((): DisplayRow[] | null => {
    if (!groupBy) return null;
    const field = filterable[groupBy as AccountField];
    if (!field) return null;
    const buckets = new Map<string, SfAccount[]>();
    for (const a of visible) {
      const raw = field.getValue(a);
      const k = raw == null || raw === "" ? "" : String(raw);
      const list = buckets.get(k);
      if (list) list.push(a);
      else buckets.set(k, [a]);
    }
    const sortedKeys = [...buckets.keys()].sort((a, b) => (a || "zzz").localeCompare(b || "zzz"));
    const out: DisplayRow[] = [];
    for (const k of sortedKeys) {
      const group = buckets.get(k)!;
      out.push({ kind: "header", key: k, label: k || "—", count: group.length });
      for (const a of group) out.push({ kind: "row", account: a });
    }
    return out;
  }, [visible, groupBy, filterable]);

  const totalVisible = pinnedAccounts.length + visible.length;
  const colSpan = visibleCols.length + 2; // +2 for chevron + pin columns

  return (
    <SectionCard
      title={`Accounts (${totalVisible}${totalVisible !== accounts.length ? ` of ${accounts.length}` : ""})`}
      storageScope="portfolio"
    >
      {/* ── Toolbar ── */}
      {accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border-strong bg-surface px-3 py-2.5">
          <ButtonGroup
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as TypeFilter)}
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
              className="h-7 w-48 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
            />
            {q && (
              <button
                onClick={() => setQ("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
              >
                <X size={10} />
              </button>
            )}
          </div>
          <AddFilterButton<AccountField>
            filterable={filterable as Record<AccountField, FieldMeta<unknown>>}
            selectOptions={{
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
            onChange={(e) => setGroupBy(e.target.value)}
            title="Group rows by a field"
            className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent"
          >
            <option value="">No grouping</option>
            <option value="status">Group by Status</option>
            <option value="type">Group by Type</option>
            <option value="tier">Group by Tier</option>
          </select>
          <div className="ml-auto flex items-center gap-2">
            <ColumnChooser
              allColumns={COLUMN_ORDER}
              labels={COL_LABELS}
              visible={visibleCols}
              required={["name"]}
              onToggle={toggleCol}
            />
            <SavedViewsPicker<PortfolioSavedView>
              scopeKey="portfolio-accounts"
              currentFilters={{ filter: typeFilter, rules, visibleCols }}
              onLoad={(v) => {
                setTypeFilter(v.filter ?? "All");
                setRules(v.rules ?? []);
                if (v.visibleCols && v.visibleCols.length > 0) replaceVisibleCols(v.visibleCols);
              }}
            />
          </div>
        </div>
      )}

      {/* ── Active filter chips ── */}
      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, filterable, (_field, v) => v)}
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
      )}

      {/* ── Body ── */}
      {!sfReady ? (
        <EmptyState>Connect Salesforce to see account ownership.</EmptyState>
      ) : loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : accounts.length === 0 ? (
        <EmptyState>No accounts owned by this user.</EmptyState>
      ) : totalVisible === 0 ? (
        <EmptyState>No accounts match your filters.</EmptyState>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-[28px] px-3 py-1.5" />
              {visibleCols.includes("name") && (
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Account" sortKey="name" sort={sort} onToggle={toggle} />
                </th>
              )}
              {visibleCols.includes("type") && (
                <th className="w-[120px] px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Type" sortKey="type" sort={sort} onToggle={toggle} />
                </th>
              )}
              {visibleCols.includes("status") && (
                <th className="w-[120px] px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggle} />
                </th>
              )}
              {visibleCols.includes("openPipeline") && (
                <th className="w-[130px] px-3 py-1.5 text-right font-semibold">
                  <SortableHeader
                    label="Open pipeline"
                    sortKey="openPipeline"
                    sort={sort}
                    onToggle={toggle}
                    align="right"
                  />
                </th>
              )}
              {visibleCols.includes("amountWon") && (
                <th className="w-[120px] px-3 py-1.5 text-right font-semibold">
                  <SortableHeader
                    label="Won (FY)"
                    sortKey="amountWon"
                    sort={sort}
                    onToggle={toggle}
                    align="right"
                  />
                </th>
              )}
              <th className="w-[36px] px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {/* Pinned group */}
            {pinnedAccounts.length > 0 && (
              <tr className="bg-surface-2/60">
                <td
                  colSpan={colSpan}
                  className="px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3"
                >
                  Pinned · {pinnedAccounts.length}
                </td>
              </tr>
            )}
            {pinnedAccounts.map((a) => (
              <AccountRow
                key={a.Id}
                account={a}
                metrics={metricsByAccount.get(a.Id) ?? ZERO_METRICS}
                isExpanded={a.Id === expandedId}
                logoUrl={enrichmentQ.data?.[a.Id]?.logo_url ?? null}
                isPinned
                canEdit={canEdit}
                visibleCols={visibleCols}
                colSpan={colSpan}
                onExpand={() => setExpandedId(a.Id === expandedId ? null : a.Id)}
                onTogglePin={() => togglePin(a.Id)}
                updateAccount={updateAccount}
              />
            ))}

            {/* Regular rows — grouped or flat */}
            {pinnedAccounts.length > 0 && visible.length > 0 && !groupBy && (
              <tr className="bg-surface-2/60">
                <td
                  colSpan={colSpan}
                  className="px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3"
                >
                  All · {visible.length}
                </td>
              </tr>
            )}
            {groupedVisible
              ? groupedVisible.map((row) =>
                  row.kind === "header" ? (
                    <tr key={`hdr-${row.key}`} className="bg-surface-2/60">
                      <td
                        colSpan={colSpan}
                        className="px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3"
                      >
                        {row.label} · {row.count}
                      </td>
                    </tr>
                  ) : (
                    <AccountRow
                      key={row.account.Id}
                      account={row.account}
                      metrics={metricsByAccount.get(row.account.Id) ?? ZERO_METRICS}
                      isExpanded={row.account.Id === expandedId}
                      logoUrl={enrichmentQ.data?.[row.account.Id]?.logo_url ?? null}
                      isPinned={false}
                      canEdit={canEdit}
                      visibleCols={visibleCols}
                      colSpan={colSpan}
                      onExpand={() =>
                        setExpandedId(row.account.Id === expandedId ? null : row.account.Id)
                      }
                      onTogglePin={() => togglePin(row.account.Id)}
                      updateAccount={updateAccount}
                    />
                  ),
                )
              : visible.map((a) => (
                  <AccountRow
                    key={a.Id}
                    account={a}
                    metrics={metricsByAccount.get(a.Id) ?? ZERO_METRICS}
                    isExpanded={a.Id === expandedId}
                    logoUrl={enrichmentQ.data?.[a.Id]?.logo_url ?? null}
                    isPinned={false}
                    canEdit={canEdit}
                    visibleCols={visibleCols}
                    colSpan={colSpan}
                    onExpand={() => setExpandedId(a.Id === expandedId ? null : a.Id)}
                    onTogglePin={() => togglePin(a.Id)}
                    updateAccount={updateAccount}
                  />
                ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

// ── AccountRow ────────────────────────────────────────────────────────────

import type { AccountMetrics } from "@/lib/accountMetrics";

interface AccountRowProps {
  account: SfAccount;
  metrics: AccountMetrics;
  isExpanded: boolean;
  logoUrl: string | null;
  isPinned: boolean;
  canEdit: boolean;
  visibleCols: ColKey[];
  colSpan: number;
  onExpand: () => void;
  onTogglePin: () => void;
  updateAccount: ReturnType<typeof useUpdateAccount>;
}

function AccountRow({
  account: a,
  metrics: m,
  isExpanded,
  logoUrl,
  isPinned,
  canEdit,
  visibleCols,
  colSpan,
  onExpand,
  onTogglePin,
  updateAccount,
}: AccountRowProps) {
  return (
    <Fragment>
      <tr
        className="group cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
        onClick={onExpand}
      >
        <td className="px-3 py-1.5 align-middle">
          {isExpanded ? (
            <ChevronDown size={12} className="text-ink-3" />
          ) : (
            <ChevronRight size={12} className="text-ink-3" />
          )}
        </td>
        {visibleCols.includes("name") && (
          <td className="px-3 py-1.5 align-middle">
            <div className="flex items-center gap-2.5">
              <AccountAvatar name={a.Name} logoUrl={logoUrl} size={18} />
              <div className="min-w-0 flex-1">
                {canEdit ? (
                  <InlineText
                    value={a.Name}
                    onSave={(name) =>
                      Promise.resolve(updateAccount.mutate({ id: a.Id, patch: { Name: name } }))
                    }
                    className="text-[13px] font-medium"
                  />
                ) : (
                  <span className="block truncate text-[13px] font-medium">{a.Name}</span>
                )}
              </div>
              <Link
                to={`/accounts/${a.Id}`}
                state={withReferrer({ pathname: "/portfolio", label: "Portfolio" })}
                className="flex-shrink-0 text-ink-4 hover:text-accent"
                onClick={(e) => e.stopPropagation()}
                title="Open account detail"
              >
                <ExternalLink size={12} />
              </Link>
            </div>
          </td>
        )}
        {visibleCols.includes("type") && (
          <td className="px-3 py-1.5 align-middle text-[12px] text-ink-2">{a.Type ?? "—"}</td>
        )}
        {visibleCols.includes("status") && (
          <td className="px-3 py-1.5 align-middle">
            {a.account_status ? (
              <Tag variant={accountStatusVariant(a.account_status)}>{a.account_status}</Tag>
            ) : (
              <span className="text-ink-4">—</span>
            )}
          </td>
        )}
        {visibleCols.includes("openPipeline") && (
          <td className="mono px-3 py-1.5 text-right align-middle tabular-nums">
            {fmtMoney(m.openPipeline)}
          </td>
        )}
        {visibleCols.includes("amountWon") && (
          <td className="mono px-3 py-1.5 text-right align-middle tabular-nums">
            {fmtMoney(m.amountWon)}
          </td>
        )}
        <td className="px-3 py-1.5 align-middle">
          <button
            className={`flex items-center justify-center rounded p-0.5 transition-colors hover:text-accent ${
              isPinned ? "text-accent" : "text-transparent group-hover:text-ink-3"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            title={isPinned ? "Unpin account" : "Pin account"}
          >
            <Pin size={12} fill={isPinned ? "currentColor" : "none"} />
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={colSpan} className="p-0">
            <AccountExpandPanel accountId={a.Id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}
