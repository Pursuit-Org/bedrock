/**
 * Cleanup → Accounts tab.
 *
 * Bulk-edit support: change owner OR delete (irreversible). Hard cap
 * at SELECTION_CAP rows per apply, same as opportunities cleanup.
 *
 * Filters (chip-style, AND'ed):
 *   - text search across name/owner/billing city/website
 *   - owner picker (multi-select, OR within rule)
 *
 * Permission: `edit_accounts` gates the bulk action bar. Per-row
 * ownership enforcement happens server-side (PR #169 hardening).
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AccountAvatar } from "@/components/AccountAvatar";
import { ExportCsvButton } from "@/components/ui/ExportCsvButton";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { accountStatusVariant } from "@/lib/accountStatus";
import type { CsvColumn } from "@/lib/csv";
import {
  buildAccountMetricsMap,
  ZERO_ACCOUNT_METRICS,
  type AccountMetrics,
} from "@/lib/accountMetrics";
import { fmtDate, fmtMoney } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { cn } from "@/lib/utils";
import {
  useAccounts,
  useDeleteAccount,
  useUpdateAccount,
  useAccountsEnrichment,
} from "@/services/accounts";
import { useOpportunities } from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import { useActiveUsers, useUsers } from "@/services/users";
import type { SfAccount } from "@/types/salesforce";

import {
  BulkDialog,
  type BulkMode,
  type BulkProgress,
  SELECTION_CAP,
  runBulk,
} from "./CleanupShared";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "./Filters";

// ── Filter model ─────────────────────────────────────────────────────────

/**
 * Account row enriched with the per-account roll-ups from
 * {@link buildAccountMetricsMap}. Columns and filter rules read from
 * `_metrics` for Open pipeline / Amount won / Received / Outstanding,
 * keeping the cleanup tab in sync with the Accounts page table.
 */
type AccountWithMetrics = SfAccount & { _metrics: AccountMetrics };

const ACCOUNT_FILTERABLE = {
  name: { label: "Name", type: "text", getValue: (a: AccountWithMetrics) => a.Name ?? "" },
  owner: { label: "Owner", type: "select", getValue: (a: AccountWithMetrics) => a.OwnerId ?? "" },
  openPipeline: { label: "Open pipeline", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.openPipeline },
  amountWon: { label: "Lifetime won", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.amountWon },
  wonGrant: { label: "Won: Grant", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.wonByRecordType["Grant"] ?? 0 },
  wonDonation: { label: "Won: Donation", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.wonByRecordType["Donation"] ?? 0 },
  wonPBC: { label: "Won: PBC", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.wonByRecordType["PBC"] ?? 0 },
  wonDebtEquity: { label: "Won: Debt / Equity", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.wonByRecordType["Debt / Equity"] ?? 0 },
  wonOtherFFS: { label: "Won: Other FFS", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.wonByRecordType["Other Fee For Service"] ?? 0 },
  received: { label: "Received", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.received },
  outstanding: { label: "Outstanding", type: "number", getValue: (a: AccountWithMetrics) => a._metrics.outstanding },
  type: { label: "Type", type: "select", getValue: (a: AccountWithMetrics) => a.Type ?? "" },
  industry: { label: "Industry", type: "select", getValue: (a: AccountWithMetrics) => a.Industry ?? "" },
  recordType: { label: "Record Type", type: "select", getValue: (a: AccountWithMetrics) => a.RecordType?.Name ?? "" },
  billingCity: { label: "Billing city", type: "text", getValue: (a: AccountWithMetrics) => a.BillingCity ?? "" },
  billingState: { label: "Billing state", type: "select", getValue: (a: AccountWithMetrics) => a.BillingState ?? "" },
  website: { label: "Website", type: "text", getValue: (a: AccountWithMetrics) => a.Website ?? "" },
  annualRevenue: { label: "Annual revenue", type: "number", getValue: (a: AccountWithMetrics) => a.AnnualRevenue ?? null },
  numEmployees: { label: "Employees", type: "number", getValue: (a: AccountWithMetrics) => a.NumberOfEmployees ?? null },
  closedOpps: { label: "Closed opps (SF)", type: "number", getValue: (a: AccountWithMetrics) => a.npo02__NumberOfClosedOpps__c ?? null },
  lastActivity: { label: "Last activity", type: "date", getValue: (a: AccountWithMetrics) => a.LastActivityDate ?? null },
  createdDate: { label: "Created", type: "date", getValue: (a: AccountWithMetrics) => a.CreatedDate ?? null },
  lastModified: { label: "Last modified", type: "date", getValue: (a: AccountWithMetrics) => a.LastModifiedDate ?? null },
} satisfies Record<string, FieldMeta<AccountWithMetrics>>;

type AccountField = keyof typeof ACCOUNT_FILTERABLE;

const ROW_HEIGHT = 44;
const CHECKBOX_W = 36;

/** Stable referrer state — see CleanupPage for rationale. */
const CLEANUP_REFERRER = {
  from: { pathname: "/cleanup", label: "Cleanup" },
} as const;

type ColKey =
  | "name"
  | "owner"
  | "status"
  | "openPipeline"
  | "amountWon"
  | "wonGrant"
  | "wonDonation"
  | "wonPBC"
  | "wonDebtEquity"
  | "wonOtherFFS"
  | "received"
  | "outstanding"
  | "type"
  | "industry"
  | "billing"
  | "website"
  | "lastModified";

const COL_LABELS: Record<ColKey, string> = {
  name: "Account",
  owner: "Owner",
  status: "Status",
  openPipeline: "Open pipeline",
  amountWon: "Lifetime won",
  wonGrant: "Won: Grant",
  wonDonation: "Won: Donation",
  wonPBC: "Won: PBC",
  wonDebtEquity: "Won: Debt / Equity",
  wonOtherFFS: "Won: Other FFS",
  received: "Received",
  outstanding: "Outstanding",
  type: "Type",
  industry: "Industry",
  billing: "Location",
  website: "Website",
  lastModified: "Last modified",
};

const COL_WIDTHS: Record<ColKey, number> = {
  name: 280,
  owner: 150,
  status: 130,
  openPipeline: 130,
  amountWon: 130,
  wonGrant: 140,
  wonDonation: 140,
  wonPBC: 110,
  wonDebtEquity: 140,
  wonOtherFFS: 130,
  received: 120,
  outstanding: 130,
  type: 110,
  industry: 150,
  billing: 150,
  website: 180,
  lastModified: 120,
};

const COLUMN_ORDER: ColKey[] = [
  "name",
  "owner",
  "status",
  "openPipeline",
  "amountWon",
  "wonGrant",
  "wonDonation",
  "wonPBC",
  "wonDebtEquity",
  "wonOtherFFS",
  "received",
  "outstanding",
  "type",
  "industry",
  "billing",
  "website",
  "lastModified",
];

/**
 * Columns emitted into the CSV export. Wider than the visible table —
 * the export should be self-sufficient for downstream analysis (Excel /
 * Sheets), so we include the SF Id, all four roll-ups as raw numbers
 * (no "$" prefix or thousands sep — easier to sum), ISO dates instead
 * of "May 4, 2026", and a couple of fields that aren't on-screen
 * (RecordType, AnnualRevenue, NumberOfEmployees) but are useful for
 * downstream pivots.
 */
const ACCOUNT_CSV_COLUMNS: CsvColumn<AccountWithMetrics>[] = [
  { label: "SF Id", getValue: (a) => a.Id },
  { label: "Name", getValue: (a) => a.Name },
  { label: "Owner", getValue: (a) => a.Owner?.Name },
  { label: "Owner Id", getValue: (a) => a.OwnerId },
  { label: "Open Pipeline", getValue: (a) => a._metrics.openPipeline || "" },
  { label: "Lifetime Won", getValue: (a) => a._metrics.amountWon || "" },
  { label: "Won: Grant", getValue: (a) => a._metrics.wonByRecordType["Grant"] || "" },
  { label: "Won: Donation", getValue: (a) => a._metrics.wonByRecordType["Donation"] || "" },
  { label: "Won: PBC", getValue: (a) => a._metrics.wonByRecordType["PBC"] || "" },
  { label: "Won: Debt / Equity", getValue: (a) => a._metrics.wonByRecordType["Debt / Equity"] || "" },
  { label: "Won: Other FFS", getValue: (a) => a._metrics.wonByRecordType["Other Fee For Service"] || "" },
  { label: "Received", getValue: (a) => a._metrics.received || "" },
  { label: "Outstanding", getValue: (a) => a._metrics.outstanding || "" },
  { label: "Type", getValue: (a) => a.Type },
  { label: "Industry", getValue: (a) => a.Industry },
  { label: "Record Type", getValue: (a) => a.RecordType?.Name },
  { label: "Billing City", getValue: (a) => a.BillingCity },
  { label: "Billing State", getValue: (a) => a.BillingState },
  { label: "Billing Country", getValue: (a) => a.BillingCountry },
  { label: "Website", getValue: (a) => a.Website },
  { label: "Annual Revenue", getValue: (a) => a.AnnualRevenue ?? "" },
  { label: "Employees", getValue: (a) => a.NumberOfEmployees ?? "" },
  { label: "Last Activity", getValue: (a) => isoDate(a.LastActivityDate) },
  { label: "Created", getValue: (a) => isoDate(a.CreatedDate) },
  { label: "Last Modified", getValue: (a) => isoDate(a.LastModifiedDate) },
];

/** Render any datetime-y field as YYYY-MM-DD for CSV. SF returns ISO
 *  strings already, but defensively trim time component. */
function isoDate(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function extract(a: AccountWithMetrics, key: ColKey): unknown {
  switch (key) {
    case "name": return a.Name ?? "";
    case "owner": return a.Owner?.Name ?? "";
    case "status": return a.account_status ?? "";
    case "openPipeline": return a._metrics.openPipeline;
    case "amountWon": return a._metrics.amountWon;
    case "wonGrant": return a._metrics.wonByRecordType["Grant"] ?? 0;
    case "wonDonation": return a._metrics.wonByRecordType["Donation"] ?? 0;
    case "wonPBC": return a._metrics.wonByRecordType["PBC"] ?? 0;
    case "wonDebtEquity": return a._metrics.wonByRecordType["Debt / Equity"] ?? 0;
    case "wonOtherFFS": return a._metrics.wonByRecordType["Other Fee For Service"] ?? 0;
    case "received": return a._metrics.received;
    case "outstanding": return a._metrics.outstanding;
    case "type": return a.Type ?? "";
    case "industry": return a.Industry ?? "";
    case "billing":
      return [a.BillingCity, a.BillingState].filter(Boolean).join(", ");
    case "website": return a.Website ?? "";
    case "lastModified": return a.LastModifiedDate ?? "";
  }
}

export function CleanupAccountsTab() {
  const canEdit = usePerm("edit_accounts");
  const { data: accountsData, isLoading } = useAccounts();
  const { data: opps = [] } = useOpportunities();
  const usersQ = useActiveUsers();
  const allUsersQ = useUsers();
  const updateAccount = useUpdateAccount();
  const deleteAccount = useDeleteAccount();

  // Local toolbar state — declared early so `facets` (below) can depend
  // on `q` to constrain owner options to rows visible in the table.
  const [q, setQ] = useState("");
  const [rules, setRules] = useState<FilterRule<AccountField>[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Per-account roll-ups (open pipeline / lifetime won / received /
  // outstanding) — same source as the Accounts page table so both
  // views stay in sync.
  const metricsByAccount = useMemo(() => buildAccountMetricsMap(opps), [opps]);
  const accounts = useMemo<AccountWithMetrics[]>(
    () =>
      (accountsData ?? []).map((a) => ({
        ...a,
        _metrics: metricsByAccount.get(a.Id) ?? ZERO_ACCOUNT_METRICS,
      })),
    [accountsData, metricsByAccount],
  );
  const accountIds = useMemo(() => accounts.map((a) => a.Id), [accounts]);
  const enrichmentQ = useAccountsEnrichment(accountIds);

  // Accounts that pass the toolbar-level search (chip `rules` excluded
  // so the picker stays usable when an owner rule is active).
  const accountsInView = useMemo(() => {
    if (!q) return accounts;
    const needle = q.toLowerCase();
    return accounts.filter((a) => {
      const hay = [
        a.Name, a.Owner?.Name, a.BillingCity, a.BillingState,
        a.Website, a.Type, a.Industry,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [accounts, q]);

  // Facets for select-typed filter fields. Owner picker = every active
  // SF user + inactive users with rows in the current view.
  const facets = useMemo(() => {
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
    const industries = new Set<string>();
    const recordTypes = new Set<string>();
    const states = new Set<string>();
    for (const a of accountsInView) {
      if (a.OwnerId) {
        ownersInView.add(a.OwnerId);
        if (a.Owner?.Name && !ownerNameFromData.has(a.OwnerId)) {
          ownerNameFromData.set(a.OwnerId, a.Owner.Name);
        }
      }
      if (a.Type) types.add(a.Type);
      if (a.Industry) industries.add(a.Industry);
      if (a.RecordType?.Name) recordTypes.add(a.RecordType.Name);
      if (a.BillingState) states.add(a.BillingState);
    }

    type OwnerOption = { value: string; label: string };
    const owners: OwnerOption[] = [];
    for (const u of activeById.values()) {
      owners.push({ value: u.Id, label: u.Name });
    }
    for (const id of ownersInView) {
      if (activeById.has(id)) continue;
      const inactive = inactiveById.get(id);
      const name = inactive?.Name ?? ownerNameFromData.get(id) ?? id;
      owners.push({ value: id, label: `${name} (inactive)` });
    }
    owners.sort((a, b) => a.label.localeCompare(b.label));

    const sortedOpts = (s: Set<string>) =>
      Array.from(s).sort().map((v) => ({ value: v, label: v }));
    return {
      owner: owners,
      type: sortedOpts(types),
      industry: sortedOpts(industries),
      recordType: sortedOpts(recordTypes),
      billingState: sortedOpts(states),
    };
  }, [accountsInView, allUsersQ.data]);

  // Active users only for the bulk-assign picker — don't let users hand
  // accounts off to deactivated SF users.
  const ownerBulkOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  const ownerLabel = useMemo(() => {
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
    return accounts.filter((a) => {
      if (q) {
        const needle = q.toLowerCase();
        const hay = [
          a.Name,
          a.Owner?.Name,
          a.BillingCity,
          a.BillingState,
          a.Website,
          a.Type,
          a.Industry,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      for (const r of rules) {
        if (!ruleApplies(a, r, ACCOUNT_FILTERABLE)) return false;
      }
      return true;
    });
  }, [accounts, q, rules]);

  const { sort, toggle: toggleSort } = useSort<ColKey>({ key: "name", direction: "asc" });
  const sorted = useMemo(() => sortBy(filtered, sort, extract), [filtered, sort]);

  // Drop selections that disappear from the filtered set (consistent with
  // the opportunities cleanup tab — count always reflects what's visible).
  useEffect(() => {
    setSelectedIds((prev) => {
      const visible = new Set(filtered.map((a) => a.Id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filtered]);

  const allVisibleSelected =
    sorted.length > 0 && sorted.every((a) => selectedIds.has(a.Id));
  const someVisibleSelected =
    sorted.some((a) => selectedIds.has(a.Id)) && !allVisibleSelected;

  const toggleAll = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const a of sorted) next.delete(a.Id);
        return next;
      }
      const next = new Set(prev);
      for (const a of sorted) {
        if (next.size >= SELECTION_CAP) break;
        next.add(a.Id);
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < SELECTION_CAP) next.add(id);
      return next;
    });
  };

  // ── Bulk apply ─────────────────────────────────────────────────────────

  const [bulkMode, setBulkMode] = useState<BulkMode | null>(null);
  const [bulkValue, setBulkValue] = useState<string>("");
  const [progress, setProgress] = useState<BulkProgress | null>(null);

  const selectedAccounts = useMemo(
    () => sorted.filter((a) => selectedIds.has(a.Id)),
    [sorted, selectedIds],
  );

  const startBulk = (mode: BulkMode) => {
    setBulkMode(mode);
    setBulkValue("");
    setProgress(null);
  };

  /** Shared mutation for an item — used by both the initial bulk run
   *  and the retry-failed re-run. Closes over `bulkMode` + `bulkValue`
   *  which are stable for the duration of a dialog session. */
  const applyOne = async (it: { id: string; name: string }) => {
    if (bulkMode === "owner") {
      const ownerName =
        ownerBulkOptions.find((o) => o.value === bulkValue)?.label ?? "";
      await updateAccount.mutateAsync({
        id: it.id,
        patch: { OwnerId: bulkValue },
        displayPatch: { Owner: { Name: ownerName } } as Record<string, unknown>,
      });
    } else {
      await deleteAccount.mutateAsync(it.id);
    }
  };

  const runApply = async () => {
    if (!bulkMode) return;
    if (bulkMode === "owner" && !bulkValue) return;
    const items = selectedAccounts.map((a) => ({
      id: a.Id,
      name: a.Name ?? a.Id,
    }));
    await runBulk(items, applyOne, setProgress);
  };

  /** Re-run the bulk action against just the rows that failed last time.
   *  Map { id → name } via the original selection so we don't have to
   *  refetch — `selectedAccounts` is still the same array. */
  const retryFailed = async () => {
    if (!progress || progress.failures.length === 0) return;
    const items = progress.failures.map((f) => ({ id: f.id, name: f.name }));
    await runBulk(items, applyOne, setProgress);
  };

  const closeBulk = () => {
    setBulkMode(null);
    setBulkValue("");
    setProgress(null);
    if (progress && progress.failures.length === 0 && progress.done === progress.total) {
      setSelectedIds(new Set());
    }
  };

  const tableMinWidth =
    COLUMN_ORDER.reduce((sum, k) => sum + COL_WIDTHS[k], 0) + CHECKBOX_W;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-7 pt-3 pb-6">
      <div className="mb-3 text-[12px] text-ink-3">
        {isLoading
          ? "Loading…"
          : `${sorted.length.toLocaleString()} of ${accounts.length.toLocaleString()} accounts${selectedIds.size > 0 ? ` · ${selectedIds.size.toLocaleString()} selected` : ""}`}
      </div>

      <Toolbar>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            placeholder="Search name, owner, location, website"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-80 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>
        <AddFilterButton<AccountField>
          filterable={ACCOUNT_FILTERABLE as Record<AccountField, FieldMeta<unknown>>}
          selectOptions={{
            owner: facets.owner,
            type: facets.type,
            industry: facets.industry,
            recordType: facets.recordType,
            billingState: facets.billingState,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
        />
        <div className="ml-auto">
          <ExportCsvButton
            baseFilename="cleanup-accounts"
            rows={sorted}
            columns={ACCOUNT_CSV_COLUMNS}
          />
        </div>
      </Toolbar>

      {rules.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, ACCOUNT_FILTERABLE, (field, v) =>
                field === "owner" ? ownerLabel(v) : v,
              )}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules([])}
            className="text-[11.5px] text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {selectedIds.size > 0 && canEdit ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-[12.5px]">
          <span className="font-medium text-ink">
            {selectedIds.size.toLocaleString()} selected
            {selectedIds.size >= SELECTION_CAP ? ` (cap: ${SELECTION_CAP})` : ""}
          </span>
          <span className="text-ink-3">·</span>
          <button
            type="button"
            onClick={() => startBulk("owner")}
            className="rounded bg-ink px-2.5 py-1 text-[12px] font-medium text-surface hover:opacity-90"
          >
            Change owner…
          </button>
          <button
            type="button"
            onClick={() => startBulk("delete")}
            className="rounded bg-red px-2.5 py-1 text-[12px] font-medium text-surface hover:opacity-90"
          >
            Delete…
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-[12px] text-ink-3 hover:text-ink-2"
          >
            Clear selection
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="mt-3 flex-1 overflow-x-auto rounded-b-lg border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{ tableLayout: "fixed", width: "100%", minWidth: tableMinWidth }}
        >
          <colgroup>
            <col style={{ width: CHECKBOX_W }} />
            {COLUMN_ORDER.map((k) => (
              <col key={k} style={{ width: COL_WIDTHS[k] }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="border-b border-border-strong bg-surface px-3 py-2 text-left">
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 cursor-pointer accent-accent"
                  aria-label="Select all visible"
                />
              </th>
              {COLUMN_ORDER.map((k) => (
                <th
                  key={k}
                  className="border-b border-border-strong bg-surface px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(k)}
                    className="hover:text-ink"
                  >
                    {COL_LABELS[k]}
                    {sort.key === k ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 ? (
              <tr aria-hidden style={{ height: paddingTop }}>
                <td colSpan={COLUMN_ORDER.length + 1} />
              </tr>
            ) : null}
            {virtualItems.map((vi) => {
              const a = sorted[vi.index];
              if (!a) return null;
              const enrichment = enrichmentQ.data?.[a.Id] ?? null;
              return (
                <AccountRow
                  key={a.Id}
                  a={a}
                  logoUrl={enrichment?.logo_url ?? null}
                  checked={selectedIds.has(a.Id)}
                  onToggle={() => toggleOne(a.Id)}
                />
              );
            })}
            {paddingBottom > 0 ? (
              <tr aria-hidden style={{ height: paddingBottom }}>
                <td colSpan={COLUMN_ORDER.length + 1} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {bulkMode ? (
        <BulkDialog
          entity="account"
          mode={bulkMode}
          ownerValue={bulkValue}
          onOwnerValueChange={setBulkValue}
          ownerOptions={ownerBulkOptions}
          selected={selectedAccounts.map((a) => ({ id: a.Id, name: a.Name ?? a.Id }))}
          progress={progress}
          onRun={runApply}
          onRetryFailed={retryFailed}
          onClose={closeBulk}
        />
      ) : null}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

const AccountRow = memo(function AccountRow({
  a,
  logoUrl,
  checked,
  onToggle,
}: {
  a: AccountWithMetrics;
  logoUrl: string | null;
  checked: boolean;
  onToggle: () => void;
}) {
  const billing = [a.BillingCity, a.BillingState].filter(Boolean).join(", ");
  const m = a._metrics;
  return (
    <tr
      className={cn(
        "group/row border-b border-border-strong hover:bg-surface-2",
        checked && "bg-accent/5",
      )}
      style={{ height: ROW_HEIGHT }}
      onClick={onToggle}
    >
      <td className="px-3 py-1" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-3.5 w-3.5 cursor-pointer accent-accent"
        />
      </td>
      <td className="px-3 py-1 text-[13px]">
        <div className="flex min-w-0 items-center gap-2">
          <AccountAvatar name={a.Name} logoUrl={logoUrl} website={a.Website} size={22} />
          <Link
            to={`/accounts/${a.Id}`}
            state={CLEANUP_REFERRER}
            className="min-w-0 flex-1 truncate font-medium hover:underline"
            title={a.Name ?? ""}
            onClick={(e) => e.stopPropagation()}
          >
            {a.Name ?? "(no name)"}
          </Link>
        </div>
      </td>
      <td className="px-3 py-1">
        <span className="truncate text-[12.5px] text-ink-2">{a.Owner?.Name ?? "—"}</span>
      </td>
      <td className="px-3 py-1">
        {a.account_status ? (
          <Tag variant={accountStatusVariant(a.account_status)}>{a.account_status}</Tag>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </td>
      <MoneyCell value={m.openPipeline} />
      <MoneyCell value={m.amountWon} />
      <MoneyCell value={m.wonByRecordType["Grant"] ?? 0} />
      <MoneyCell value={m.wonByRecordType["Donation"] ?? 0} />
      <MoneyCell value={m.wonByRecordType["PBC"] ?? 0} />
      <MoneyCell value={m.wonByRecordType["Debt / Equity"] ?? 0} />
      <MoneyCell value={m.wonByRecordType["Other Fee For Service"] ?? 0} />
      <MoneyCell value={m.received} />
      <MoneyCell value={m.outstanding} />
      <td className="px-3 py-1">
        <span className="truncate text-[12.5px] text-ink-2">{a.Type ?? "—"}</span>
      </td>
      <td className="px-3 py-1">
        <span className="truncate text-[12.5px] text-ink-2">{a.Industry ?? "—"}</span>
      </td>
      <td className="px-3 py-1">
        <span className="truncate text-[12.5px] text-ink-3">{billing || "—"}</span>
      </td>
      <td className="px-3 py-1">
        {a.Website ? (
          <a
            href={a.Website.startsWith("http") ? a.Website : `https://${a.Website}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="truncate text-[12px] text-accent hover:underline"
          >
            {a.Website.replace(/^https?:\/\/(www\.)?/i, "")}
          </a>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </td>
      <td className="px-3 py-1 text-[13px] tabular-nums text-ink-2">{fmtDate(a.LastModifiedDate)}</td>
    </tr>
  );
});

/** Right-aligned money cell — em-dash for zero so the table doesn't
 *  read as a wall of "$0" for accounts with no pipeline yet. */
function MoneyCell({ value }: { value: number }) {
  return (
    <td className="mono px-3 py-1 text-right text-[12.5px] tabular-nums text-ink-2">
      {value > 0 ? fmtMoney(value) : <span className="text-ink-4">—</span>}
    </td>
  );
}

