/**
 * Cleanup tab — bulk-edit opportunities.
 *
 * Workflow:
 *   1) Filter the table down (chip-based filters, combinable AND)
 *   2) Select rows (checkbox per row + select-all in header)
 *   3) Apply a bulk action (Stage or Owner — only two for now)
 *   4) Confirm dialog shows N + first 5 names before the writes fire
 *
 * Hard cap: 500 selections per bulk apply, to keep the round-trip volume
 * manageable and prevent footguns. Per-row writes go through the existing
 * useUpdateOpportunityStage / useUpdateOpportunity hooks (one call per
 * row, ran with bounded parallelism). Failures are reported per-row.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  Filter as FilterIcon,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AccountAvatar } from "@/components/AccountAvatar";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { ExportCsvButton } from "@/components/ui/ExportCsvButton";
import { ResizableTh, useColumnDrag } from "@/components/ui/ResizableTable";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { useColumnVisibility } from "@/lib/columnVisibility";
import type { CsvColumn } from "@/lib/csv";
import { fmtDate, fmtMoney } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { isOpen, stageStatus } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { runBulk as runBulkShared, type BulkProgress } from "@/pages/cleanup/CleanupShared";
import {
  useOpportunities,
  useUpdateOpportunity,
  useUpdateOpportunityStage,
} from "@/services/opportunities";
import { useAccountsEnrichment } from "@/services/accounts";
import { usePerm } from "@/services/permissions";
import { useActiveUsers, useUsers } from "@/services/users";
import type { SfOpportunity } from "@/types/salesforce";

// ── Filter model ──────────────────────────────────────────────────────────

const FILTERABLE = {
  stage: { label: "Stage", type: "select" as const, getValue: (o: SfOpportunity) => o.StageName ?? "" },
  owner: { label: "Owner", type: "select" as const, getValue: (o: SfOpportunity) => o.OwnerId ?? "" },
  recordType: { label: "Record Type", type: "select" as const, getValue: (o: SfOpportunity) => o.RecordType?.Name ?? "" },
  account: { label: "Account", type: "text" as const, getValue: (o: SfOpportunity) => o.Account?.Name ?? "" },
  name: { label: "Name", type: "text" as const, getValue: (o: SfOpportunity) => o.Name ?? "" },
  // SF custom flag the org uses to mark "this opp is currently being
  // worked" — filter as Yes/No since it's boolean-coded but renders
  // best as an explicit dropdown choice.
  active: {
    label: "Active",
    type: "select" as const,
    getValue: (o: SfOpportunity) => (o.Active_Opportunity__c ? "Yes" : "No"),
  },
  amount: { label: "Amount", type: "number" as const, getValue: (o: SfOpportunity) => o.Amount ?? null },
  probability: { label: "Probability", type: "number" as const, getValue: (o: SfOpportunity) => o.Probability ?? null },
  closeDate: { label: "Close date", type: "date" as const, getValue: (o: SfOpportunity) => o.CloseDate ?? null },
  createdDate: { label: "Created", type: "date" as const, getValue: (o: SfOpportunity) => o.CreatedDate ?? null },
  lastModified: { label: "Last modified", type: "date" as const, getValue: (o: SfOpportunity) => o.LastModifiedDate ?? null },
} satisfies Record<string, { label: string; type: "select" | "text" | "number" | "date"; getValue: (o: SfOpportunity) => string | number | null }>;

type FieldKey = keyof typeof FILTERABLE;

type Operator =
  | "equals"
  | "is_empty"
  | "is_not_empty"
  | "contains"
  | "gt"
  | "lt"
  | "before"
  | "after";

interface FilterRule {
  id: string;
  field: FieldKey;
  op: Operator;
  // Multi-value capable. For select-type fields with op="equals", any
  // listed value matches (OR within the rule). For text / number / date
  // ops only values[0] is consulted.
  values: string[];
}

const OPS_BY_TYPE: Record<"select" | "text" | "number" | "date", { value: Operator; label: string }[]> = {
  select: [
    { value: "equals", label: "is" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "has any value" },
  ],
  text: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "is" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "has any value" },
  ],
  number: [
    { value: "equals", label: "=" },
    { value: "gt", label: ">" },
    { value: "lt", label: "<" },
    { value: "is_empty", label: "is empty" },
  ],
  date: [
    { value: "before", label: "before" },
    { value: "after", label: "after" },
    { value: "equals", label: "is" },
    { value: "is_empty", label: "is empty" },
  ],
};

function ruleApplies(o: SfOpportunity, r: FilterRule): boolean {
  const meta = FILTERABLE[r.field];
  const v = meta.getValue(o);

  if (r.op === "is_empty") return v == null || v === "";
  if (r.op === "is_not_empty") return v != null && v !== "";

  // Single-value ops read values[0]; select supports OR across values.
  const first = r.values[0] ?? "";

  if (meta.type === "select") {
    if (r.op === "equals") {
      if (r.values.length === 0) return true; // no values picked = match all
      const s = String(v ?? "");
      return r.values.includes(s);
    }
  }

  if (meta.type === "text") {
    const s = String(v ?? "").toLowerCase();
    if (r.op === "contains") return s.includes(first.toLowerCase());
    if (r.op === "equals") return s === first.toLowerCase();
  }

  if (meta.type === "number") {
    if (v == null || first === "") return false;
    const n = Number(v);
    const target = Number(first);
    if (!Number.isFinite(target)) return false;
    if (r.op === "gt") return n > target;
    if (r.op === "lt") return n < target;
    if (r.op === "equals") return n === target;
  }

  if (meta.type === "date") {
    if (v == null || first === "") return false;
    const ms = new Date(String(v)).getTime();
    const target = new Date(first).getTime();
    if (!Number.isFinite(ms) || !Number.isFinite(target)) return false;
    if (r.op === "before") return ms < target;
    if (r.op === "after") return ms > target;
    if (r.op === "equals") return String(v).slice(0, 10) === first;
  }

  return true;
}

function describeRule(r: FilterRule, opts: {
  ownerLabel: (id: string) => string;
}): string {
  const meta = FILTERABLE[r.field];
  if (r.op === "is_empty") return `${meta.label} is empty`;
  if (r.op === "is_not_empty") return `${meta.label} has any value`;
  const opLabel = OPS_BY_TYPE[meta.type].find((o) => o.value === r.op)?.label ?? r.op;
  // Multi-value: render up to 2 names, then "+N more". Owner gets a name lookup.
  const renderValue = (v: string) =>
    r.field === "owner" && v ? opts.ownerLabel(v) : v;
  let valLabel: string;
  if (r.values.length <= 1) {
    valLabel = renderValue(r.values[0] ?? "");
  } else if (r.values.length === 2) {
    valLabel = `${renderValue(r.values[0])}, ${renderValue(r.values[1])}`;
  } else {
    valLabel = `${renderValue(r.values[0])}, ${renderValue(r.values[1])} +${r.values.length - 2} more`;
  }
  return `${meta.label} ${opLabel} ${valLabel}`;
}

// ── Columns ───────────────────────────────────────────────────────────────

type ColKey =
  | "name"
  | "account"
  | "stage"
  | "owner"
  | "recordType"
  | "active"
  | "amount"
  | "probability"
  | "closeDate"
  | "lastModified";

const COLUMN_ORDER: ColKey[] = [
  "name", "account", "stage", "owner", "recordType",
  "active", "amount", "probability", "closeDate", "lastModified",
];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 280,
  account: 180,
  stage: 200,
  owner: 150,
  recordType: 130,
  active: 80,
  amount: 110,
  probability: 80,
  closeDate: 110,
  lastModified: 120,
};

const COL_LABELS: Record<ColKey, string> = {
  name: "Opportunity",
  account: "Account",
  stage: "Stage",
  owner: "Owner",
  recordType: "Record Type",
  active: "Active",
  amount: "Amount",
  probability: "Prob.",
  closeDate: "Close",
  lastModified: "Last modified",
};

const ROW_HEIGHT = 44;

function extractOpp(o: SfOpportunity, key: ColKey): unknown {
  switch (key) {
    case "name": return o.Name;
    case "account": return o.Account?.Name ?? "";
    case "stage": return o.StageName;
    case "owner": return o.Owner?.Name ?? "";
    case "recordType": return o.RecordType?.Name ?? "";
    case "active":
      // Sort booleans as numbers — true rows float to the top under
      // ascending sort.
      return o.Active_Opportunity__c ? 1 : 0;
    case "amount": return o.Amount ?? 0;
    case "probability": return o.Probability ?? 0;
    case "closeDate": return o.CloseDate;
    case "lastModified": return o.LastModifiedDate;
  }
}

const SELECTION_CAP = 500;

/** Static router-state object passed via `<Link state={...}>` from rows
 *  in this page → so detail pages render "Back to Cleanup" instead of
 *  defaulting to "Pipeline" / "Accounts" / "Contacts". Constant ref so
 *  memoized rows don't re-render. */
const CLEANUP_REFERRER = {
  from: { pathname: "/cleanup", label: "Cleanup" },
} as const;

/** CSV columns for Opportunities export. Wider than the visible table —
 *  includes SF Id (for re-import / pivots), raw money values, and ISO
 *  dates so downstream tooling can parse without the display layer's
 *  formatting in the way. */
const OPP_CSV_COLUMNS: CsvColumn<SfOpportunity>[] = [
  { label: "SF Id", getValue: (o) => o.Id },
  { label: "Name", getValue: (o) => o.Name },
  { label: "Account", getValue: (o) => o.Account?.Name },
  { label: "Account Id", getValue: (o) => o.AccountId },
  { label: "Stage", getValue: (o) => o.StageName },
  { label: "Owner", getValue: (o) => o.Owner?.Name },
  { label: "Owner Id", getValue: (o) => o.OwnerId },
  { label: "Record Type", getValue: (o) => o.RecordType?.Name },
  { label: "Active", getValue: (o) => (o.Active_Opportunity__c ? "Yes" : "No") },
  { label: "Amount", getValue: (o) => o.Amount ?? "" },
  { label: "Probability", getValue: (o) => o.Probability ?? "" },
  { label: "Forecast Category", getValue: (o) => o.ForecastCategory },
  { label: "Lead Source", getValue: (o) => o.LeadSource },
  { label: "Close Date", getValue: (o) => isoDate(o.CloseDate) },
  { label: "First Payment", getValue: (o) => isoDate(o.PaymentDate__c) },
  { label: "Last Modified", getValue: (o) => isoDate(o.LastModifiedDate) },
  { label: "Created", getValue: (o) => isoDate(o.CreatedDate) },
];

function isoDate(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

// ── Page ──────────────────────────────────────────────────────────────────

export type CleanupTabKey = "opportunities" | "accounts" | "contacts";

import { CleanupAccountsTab } from "./cleanup/CleanupAccountsTab";
import { CleanupContactsTab } from "./cleanup/CleanupContactsTab";

export function CleanupPage() {
  const [tab, setTab] = useState<CleanupTabKey>("opportunities");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-7 pt-5">
        <CleanupTab active={tab === "opportunities"} onClick={() => setTab("opportunities")}>
          Opportunities
        </CleanupTab>
        <CleanupTab active={tab === "accounts"} onClick={() => setTab("accounts")}>
          Accounts
        </CleanupTab>
        <CleanupTab active={tab === "contacts"} onClick={() => setTab("contacts")}>
          Contacts
        </CleanupTab>
      </div>
      {tab === "opportunities" ? <OpportunitiesCleanupTab /> : null}
      {tab === "accounts" ? <CleanupAccountsTab /> : null}
      {tab === "contacts" ? <CleanupContactsTab /> : null}
    </div>
  );
}

function CleanupTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-t-md border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
        active
          ? "border-accent text-ink"
          : "border-transparent text-ink-3 hover:text-ink-2",
      )}
    >
      {children}
    </button>
  );
}

function OpportunitiesCleanupTab() {
  const canEdit = usePerm("edit_all_opportunities");
  const { data: oppsData, isLoading } = useOpportunities();
  const usersQ = useActiveUsers();
  const allUsersQ = useUsers();

  // Cleanup is for fixing in-flight pipeline data — closed opps are
  // historical and shouldn't be re-touched here.
  const opps = useMemo(
    () => (oppsData ?? []).filter(isOpen),
    [oppsData],
  );

  // Logo enrichment for the account behind every visible opp.
  const accountIdsForEnrichment = useMemo(() => {
    const set = new Set<string>();
    for (const o of opps) {
      if (o.AccountId) set.add(o.AccountId);
    }
    return Array.from(set);
  }, [opps]);
  const enrichmentQ = useAccountsEnrichment(accountIdsForEnrichment);

  // Curated bulk-action stage targets — only stages that make sense as
  // the *destination* of a cleanup rewrite. Ordered to match the funnel
  // (open stages first, then closed). If you need to set something else,
  // do it on the opp detail page where the full picklist is available.
  const bulkStageOptions = useMemo(
    () => [
      { value: "New Lead", label: "New Lead" },
      { value: "Qualifying", label: "Qualifying" },
      { value: "Ask in Progress", label: "Ask in Progress" },
      { value: "Proposal Submitted", label: "Proposal Submitted" },
      { value: "Contracting", label: "Contracting" },
      { value: "Closed Won", label: "Closed Won" },
      { value: "Closed Lost", label: "Closed Lost" },
      { value: "Withdrawn", label: "Withdrawn" },
    ],
    [],
  );

  const [rules, setRules] = useState<FilterRule[]>([]);
  const [q, setQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Bulk-action picker (re-assigning ownership) — active users only.
  // Don't let users hand opps off to someone who left.
  const ownerBulkOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  // Opps that match the toolbar-level filter (search box only; chip
  // `rules` excluded to avoid the picker collapsing once an owner
  // filter is applied). Used to seed the chip-filter facets so the
  // owner picker reflects what's actually visible in the table.
  const oppsInView = useMemo(() => {
    if (!q) return opps;
    const needle = q.toLowerCase();
    return opps.filter((o) => {
      const hay =
        (o.Name ?? "") + " " + (o.Account?.Name ?? "") + " " + (o.Owner?.Name ?? "");
      return hay.toLowerCase().includes(needle);
    });
  }, [opps, q]);

  // Stage / record-type / owner filter options.
  // Owner picker = every active SF user + inactive users with rows in
  // the current view.
  const facets = useMemo(() => {
    const all = allUsersQ.data ?? [];
    const activeById = new Map(
      all.filter((u) => u.IsActive).map((u) => [u.Id, u]),
    );
    const inactiveById = new Map(
      all.filter((u) => !u.IsActive).map((u) => [u.Id, u]),
    );

    const stages = new Set<string>();
    const recordTypes = new Set<string>();
    const ownersInView = new Set<string>();
    const ownerNameFromData = new Map<string, string>();
    for (const o of oppsInView) {
      if (o.StageName) stages.add(o.StageName);
      if (o.RecordType?.Name) recordTypes.add(o.RecordType.Name);
      if (o.OwnerId) {
        ownersInView.add(o.OwnerId);
        if (o.Owner?.Name && !ownerNameFromData.has(o.OwnerId)) {
          ownerNameFromData.set(o.OwnerId, o.Owner.Name);
        }
      }
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

    return {
      stages: Array.from(stages).sort().map((v) => ({ value: v, label: v })),
      recordTypes: Array.from(recordTypes).sort().map((v) => ({ value: v, label: v })),
      owners,
    };
  }, [oppsInView, allUsersQ.data]);

  const ownerLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of usersQ.data ?? []) m.set(u.Id, u.Name);
    // Fall back to whatever's on the opp record if the user isn't active.
    for (const o of opps) {
      if (o.OwnerId && !m.has(o.OwnerId) && o.Owner?.Name) {
        m.set(o.OwnerId, o.Owner.Name);
      }
    }
    return (id: string) => m.get(id) ?? id;
  }, [usersQ.data, opps]);

  const filtered = useMemo(() => {
    return opps.filter((o) => {
      // Free-text search across name/account/owner.
      if (q) {
        const needle = q.toLowerCase();
        const hay =
          (o.Name ?? "") +
          " " +
          (o.Account?.Name ?? "") +
          " " +
          (o.Owner?.Name ?? "");
        if (!hay.toLowerCase().includes(needle)) return false;
      }
      // All chip rules must pass (AND).
      for (const r of rules) {
        if (!ruleApplies(o, r)) return false;
      }
      return true;
    });
  }, [opps, q, rules]);

  const { sort, toggle } = useSort<ColKey>({ key: "name", direction: "asc" });
  const sorted = useMemo(() => sortBy(filtered, sort, extractOpp), [filtered, sort]);

  const { visible: visibleCols, toggle: toggleCol, move: moveCol } = useColumnVisibility<ColKey>(
    "bedrock-v2:vis:cleanup",
    COLUMN_ORDER,
  );
  const colDrag = useColumnDrag(visibleCols, moveCol);
  const { widths, startResize } = useColumnWidths<ColKey>("bedrock-v2:cols:cleanup", DEFAULT_WIDTHS);

  // Drop selections that disappear from the filtered set so the count
  // shown to the user always reflects current state.
  useEffect(() => {
    setSelectedIds((prev) => {
      const visible = new Set(filtered.map((o) => o.Id));
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
    sorted.length > 0 && sorted.every((o) => selectedIds.has(o.Id));
  const someVisibleSelected =
    sorted.some((o) => selectedIds.has(o.Id)) && !allVisibleSelected;

  const toggleAll = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const o of sorted) next.delete(o.Id);
        return next;
      }
      const next = new Set(prev);
      for (const o of sorted) {
        if (next.size >= SELECTION_CAP) break;
        next.add(o.Id);
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

  // ── Bulk apply ──────────────────────────────────────────────────────────

  const updateStage = useUpdateOpportunityStage();
  const updateOpp = useUpdateOpportunity();

  const [bulkMode, setBulkMode] = useState<"stage" | "owner" | null>(null);
  const [bulkValue, setBulkValue] = useState<string>("");
  const [progress, setProgress] = useState<BulkProgress | null>(null);

  const selectedOpps = useMemo(
    () => sorted.filter((o) => selectedIds.has(o.Id)),
    [sorted, selectedIds],
  );

  const startBulk = (mode: "stage" | "owner") => {
    setBulkMode(mode);
    setBulkValue("");
    setProgress(null);
  };

  /** Single-item mutation — closes over the dialog's stage/owner choice
   *  and is shared between the initial run and the retry-failed re-run. */
  const applyOne = async (it: { id: string; name: string }) => {
    if (bulkMode === "stage") {
      await updateStage.mutateAsync({ id: it.id, newStage: bulkValue });
    } else {
      const ownerName = ownerLabel(bulkValue);
      await updateOpp.mutateAsync({
        id: it.id,
        patch: { OwnerId: bulkValue },
        displayPatch: { Owner: { Name: ownerName } } as Record<string, unknown>,
      });
    }
  };

  const runBulk = async () => {
    if (!bulkMode || !bulkValue || selectedOpps.length === 0) return;
    const items = selectedOpps.map((o) => ({ id: o.Id, name: o.Name ?? o.Id }));
    await runBulkShared(items, applyOne, setProgress);
  };

  /** Re-run the same bulk action against just the rows that failed last
   *  time. The shared runner re-derives the failures + progress, so the
   *  user sees a fresh "Updating N of M" line for the retry pass. */
  const retryFailed = async () => {
    if (!progress || progress.failures.length === 0) return;
    const items = progress.failures.map((f) => ({ id: f.id, name: f.name }));
    await runBulkShared(items, applyOne, setProgress);
  };

  const closeBulk = () => {
    setBulkMode(null);
    setBulkValue("");
    setProgress(null);
    // Wipe selections only if the run finished cleanly.
    if (progress && progress.failures.length === 0 && progress.done === progress.total) {
      setSelectedIds(new Set());
    }
  };

  const tableMinWidth = totalWidth(widths) + CHECKBOX_W;

  // Virtualizer (the table is all-rows; no row-expansion to reserve space for).
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
          : `${sorted.length.toLocaleString()} of ${opps.length.toLocaleString()} opportunities${selectedIds.size > 0 ? ` · ${selectedIds.size.toLocaleString()} selected` : ""}`}
      </div>

      <Toolbar>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            placeholder="Search opps, accounts, owner, next step"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-80 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>
        <AddFilterButton
          existingRules={rules}
          stageOptions={facets.stages}
          recordTypeOptions={facets.recordTypes}
          ownerOptions={facets.owners}
          onAdd={(r) => setRules((prev) => [...prev, r])}
        />
        <ColumnChooser
          allColumns={COLUMN_ORDER}
          labels={COL_LABELS}
          visible={visibleCols}
          required={["name"]}
          onToggle={toggleCol}
        />
        <div className="ml-auto">
          <ExportCsvButton
            baseFilename="cleanup-opportunities"
            rows={sorted}
            columns={OPP_CSV_COLUMNS}
          />
        </div>
      </Toolbar>

      {rules.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, { ownerLabel })}
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

      {/* Bulk action bar */}
      {selectedIds.size > 0 && canEdit ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-[12.5px]">
          <span className="font-medium text-ink">
            {selectedIds.size.toLocaleString()} selected
            {selectedIds.size >= SELECTION_CAP ? ` (cap: ${SELECTION_CAP})` : ""}
          </span>
          <span className="text-ink-3">·</span>
          <button
            type="button"
            onClick={() => startBulk("stage")}
            className="rounded bg-ink px-2.5 py-1 text-[12px] font-medium text-surface hover:opacity-90"
          >
            Change stage…
          </button>
          <button
            type="button"
            onClick={() => startBulk("owner")}
            className="rounded bg-ink px-2.5 py-1 text-[12px] font-medium text-surface hover:opacity-90"
          >
            Change owner…
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
            {visibleCols.map((k) => (
              <col key={k} style={{ width: widths[k] }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="border-b border-border-strong bg-surface px-3 py-2 text-left">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                  onChange={toggleAll}
                  aria-label={allVisibleSelected ? "Deselect all" : "Select all visible"}
                  className="h-3.5 w-3.5 cursor-pointer accent-accent"
                />
              </th>
              {visibleCols.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align="left"
                  isLast={idx === visibleCols.length - 1}
                  drag={colDrag(key)}
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
              <tr>
                <td colSpan={visibleCols.length + 1} className="px-7 py-12 text-center text-[13px] text-ink-3">
                  Loading…
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length + 1} className="px-7 py-12 text-center text-[13px] text-ink-3">
                  {opps.length === 0 ? "No opportunities." : "No opportunities match the current filters."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={visibleCols.length + 1} />
                  </tr>
                ) : null}
                {virtualItems.map((vi) => {
                  const o = sorted[vi.index];
                  const isChecked = selectedIds.has(o.Id);
                  const logoUrl = o.AccountId
                    ? (enrichmentQ.data?.[o.AccountId]?.logo_url ?? null)
                    : null;
                  return (
                    <CleanupRow
                      key={o.Id}
                      o={o}
                      logoUrl={logoUrl}
                      visibleCols={visibleCols}
                      checked={isChecked}
                      onToggle={() => toggleOne(o.Id)}
                    />
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={visibleCols.length + 1} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>

      {bulkMode ? (
        <BulkConfirmDialog
          mode={bulkMode}
          value={bulkValue}
          onValueChange={setBulkValue}
          stageOptions={bulkStageOptions}
          ownerOptions={ownerBulkOptions}
          selectedOpps={selectedOpps}
          progress={progress}
          onRun={runBulk}
          onRetryFailed={retryFailed}
          onClose={closeBulk}
        />
      ) : null}
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────

const CHECKBOX_W = 36;

interface RowProps {
  o: SfOpportunity;
  logoUrl: string | null;
  visibleCols: ColKey[];
  checked: boolean;
  onToggle: () => void;
}

const CleanupRow = memo(function CleanupRow({ o, logoUrl, visibleCols, checked, onToggle }: RowProps) {
  const account = o.Account?.Name ?? "—";

  const cells: Record<ColKey, React.ReactNode> = {
    name: (
      <div className="flex min-w-0 items-center gap-2">
        <AccountAvatar
          name={account === "—" ? (o.Name ?? "") : account}
          logoUrl={logoUrl}
          size={18}
        />
        <Link
          to={`/opportunities/${o.Id}`}
          state={CLEANUP_REFERRER}
          className="min-w-0 flex-1 truncate font-medium hover:underline"
          title={o.Name ?? ""}
          onClick={(e) => e.stopPropagation()}
        >
          {o.Name}
        </Link>
      </div>
    ),
    account: (
      <span className="truncate text-[12.5px] text-ink-2" title={account}>
        {account}
      </span>
    ),
    stage: o.StageName ? (
      <StageChip stage={o.StageName} status={stageStatus(o)} />
    ) : (
      <span className="text-ink-4">—</span>
    ),
    owner: (
      <span className="truncate text-[12.5px] text-ink-2">{o.Owner?.Name ?? "—"}</span>
    ),
    recordType: o.RecordType?.Name ? (
      <Tag>{o.RecordType.Name}</Tag>
    ) : (
      <span className="text-ink-4">—</span>
    ),
    active: o.Active_Opportunity__c ? (
      <Tag variant="green">Yes</Tag>
    ) : (
      <span className="text-[12px] text-ink-4">No</span>
    ),
    amount: o.Amount != null ? (
      <span className="mono tabular-nums">{fmtMoney(o.Amount)}</span>
    ) : (
      <span className="text-ink-4">—</span>
    ),
    probability: o.Probability != null ? (
      <span className="mono tabular-nums text-ink-2">{o.Probability}%</span>
    ) : (
      <span className="text-ink-4">—</span>
    ),
    closeDate: <span className="text-[13px] tabular-nums text-ink-2">{fmtDate(o.CloseDate)}</span>,
    lastModified: <span className="text-[13px] tabular-nums text-ink-2">{fmtDate(o.LastModifiedDate)}</span>,
  };

  const cellCls: Record<ColKey, string> = {
    name: "px-3 py-1 text-[13px]",
    account: "px-3 py-1 text-[12.5px]",
    stage: "px-3 py-1",
    owner: "px-3 py-1",
    recordType: "px-3 py-1",
    active: "px-3 py-1",
    amount: "mono px-3 py-1 text-[12px] tabular-nums",
    probability: "mono px-3 py-1 text-[12px] tabular-nums",
    closeDate: "px-3 py-1 text-[13px] tabular-nums text-ink-2",
    lastModified: "px-3 py-1 text-[13px] tabular-nums text-ink-2",
  };

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
      {visibleCols.map((key) => (
        <td key={key} className={cellCls[key]}>
          {cells[key]}
        </td>
      ))}
    </tr>
  );
});

// ── Filter chip + add-filter button ───────────────────────────────────────

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11.5px] text-ink">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="text-ink-3 hover:text-ink"
        aria-label="Remove filter"
      >
        <X size={11} />
      </button>
    </span>
  );
}

/** Static option list for the boolean Active_Opportunity__c filter —
 *  Yes/No instead of true/false so the chip reads naturally. */
const ACTIVE_OPP_OPTIONS = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];

interface AddFilterProps {
  existingRules: FilterRule[];
  stageOptions: { value: string; label: string }[];
  recordTypeOptions: { value: string; label: string }[];
  ownerOptions: { value: string; label: string }[];
  onAdd: (rule: FilterRule) => void;
}

function AddFilterButton({
  stageOptions,
  recordTypeOptions,
  ownerOptions,
  onAdd,
}: AddFilterProps) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<FieldKey>("stage");
  const [op, setOp] = useState<Operator>("equals");
  const [singleValue, setSingleValue] = useState("");
  // For select-type fields with op="equals" the user can pick many values
  // (OR within the rule). Tracked separately so switching field/op doesn't
  // wipe a single text/number/date entry.
  const [multiValues, setMultiValues] = useState<string[]>([]);
  const [pickerQ, setPickerQ] = useState("");

  const meta = FILTERABLE[field];
  const ops = OPS_BY_TYPE[meta.type];
  const needsValue = op !== "is_empty" && op !== "is_not_empty";
  const isMultiSelect = meta.type === "select" && op === "equals";

  const valueOptions = useMemo(() => {
    if (field === "stage") return stageOptions;
    if (field === "recordType") return recordTypeOptions;
    if (field === "owner") return ownerOptions;
    if (field === "active") return ACTIVE_OPP_OPTIONS;
    return null;
  }, [field, stageOptions, recordTypeOptions, ownerOptions]);

  const filteredOptions = useMemo(() => {
    if (!valueOptions) return null;
    if (!pickerQ.trim()) return valueOptions;
    const needle = pickerQ.toLowerCase();
    return valueOptions.filter((o) => o.label.toLowerCase().includes(needle));
  }, [valueOptions, pickerQ]);

  const reset = () => {
    setField("stage");
    setOp("equals");
    setSingleValue("");
    setMultiValues([]);
    setPickerQ("");
  };

  const handleAdd = () => {
    if (!needsValue) {
      onAdd({ id: `${field}-${Date.now()}`, field, op, values: [] });
    } else if (isMultiSelect) {
      if (multiValues.length === 0) return;
      onAdd({ id: `${field}-${Date.now()}`, field, op, values: multiValues });
    } else {
      if (!singleValue) return;
      onAdd({ id: `${field}-${Date.now()}`, field, op, values: [singleValue] });
    }
    reset();
    setOpen(false);
  };

  const toggleMulti = (v: string) => {
    setMultiValues((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 hover:bg-surface-2"
      >
        <FilterIcon size={12} />
        <span>Add filter</span>
        <ChevronDown size={12} />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-[420px] rounded-md border border-border-strong bg-surface p-2 shadow-md">
          <div className="flex items-center gap-1.5">
            <select
              value={field}
              onChange={(e) => {
                const next = e.target.value as FieldKey;
                setField(next);
                const firstOp = OPS_BY_TYPE[FILTERABLE[next].type][0].value;
                setOp(firstOp);
                setSingleValue("");
                setMultiValues([]);
                setPickerQ("");
              }}
              className="h-7 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
            >
              {(Object.keys(FILTERABLE) as FieldKey[]).map((k) => (
                <option key={k} value={k}>
                  {FILTERABLE[k].label}
                </option>
              ))}
            </select>
            <select
              value={op}
              onChange={(e) => {
                setOp(e.target.value as Operator);
                setSingleValue("");
                setMultiValues([]);
              }}
              className="h-7 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
            >
              {ops.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {needsValue && !isMultiSelect ? (
              valueOptions ? (
                <select
                  value={singleValue}
                  onChange={(e) => setSingleValue(e.target.value)}
                  className="h-7 min-w-[140px] flex-1 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
                >
                  <option value="">—</option>
                  {valueOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : meta.type === "date" ? (
                <input
                  type="date"
                  value={singleValue}
                  onChange={(e) => setSingleValue(e.target.value)}
                  className="h-7 flex-1 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
                />
              ) : meta.type === "number" ? (
                <input
                  type="number"
                  value={singleValue}
                  onChange={(e) => setSingleValue(e.target.value)}
                  placeholder="0"
                  className="h-7 flex-1 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
                />
              ) : (
                <input
                  type="text"
                  value={singleValue}
                  onChange={(e) => setSingleValue(e.target.value)}
                  placeholder="value"
                  className="h-7 flex-1 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
                />
              )
            ) : null}
          </div>

          {isMultiSelect && valueOptions ? (
            <div className="mt-2 rounded border border-border-strong">
              <div className="flex items-center justify-between border-b border-border-strong px-2 py-1.5">
                <input
                  autoFocus
                  type="text"
                  value={pickerQ}
                  onChange={(e) => setPickerQ(e.target.value)}
                  placeholder={`Search ${meta.label.toLowerCase()}…`}
                  className="h-6 flex-1 bg-transparent text-[12px] text-ink outline-none"
                />
                <span className="text-[11px] text-ink-3">
                  {multiValues.length} selected
                </span>
              </div>
              <div className="max-h-[220px] overflow-y-auto">
                {filteredOptions && filteredOptions.length > 0 ? (
                  filteredOptions.map((o) => {
                    const checked = multiValues.includes(o.value);
                    return (
                      <label
                        key={o.value}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 px-2 py-1 text-[12.5px] hover:bg-surface-2",
                          checked && "bg-accent/5",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleMulti(o.value)}
                          className="h-3.5 w-3.5 cursor-pointer accent-accent"
                        />
                        <span className="truncate text-ink" title={o.label}>
                          {o.label}
                        </span>
                      </label>
                    );
                  })
                ) : (
                  <div className="px-2 py-2 text-center text-[11.5px] text-ink-3">
                    No matches
                  </div>
                )}
              </div>
              {multiValues.length > 0 ? (
                <div className="flex items-center justify-between border-t border-border-strong px-2 py-1">
                  <button
                    type="button"
                    onClick={() => setMultiValues([])}
                    className="text-[11.5px] text-ink-3 hover:text-ink-2"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => filteredOptions && setMultiValues(filteredOptions.map((o) => o.value))}
                    className="text-[11.5px] text-ink-3 hover:text-ink-2"
                  >
                    Select all{pickerQ ? " filtered" : ""}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => { reset(); setOpen(false); }}
              className="text-[11.5px] text-ink-3 hover:text-ink-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={
                needsValue &&
                (isMultiSelect ? multiValues.length === 0 : !singleValue)
              }
              className="inline-flex h-7 items-center gap-1 rounded bg-ink px-2.5 text-[12px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={11} /> Add filter
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Bulk confirm dialog ───────────────────────────────────────────────────

interface BulkDialogProps {
  mode: "stage" | "owner";
  value: string;
  onValueChange: (v: string) => void;
  stageOptions: { value: string; label: string }[];
  ownerOptions: { value: string; label: string }[];
  selectedOpps: SfOpportunity[];
  progress: BulkProgress | null;
  onRun: () => Promise<void>;
  /** Re-run the same action targeting only previously-failed rows.
   *  Surfaces a "Retry N failed" CTA when the run finishes with errors. */
  onRetryFailed?: () => Promise<void>;
  onClose: () => void;
}

function BulkConfirmDialog({
  mode,
  value,
  onValueChange,
  stageOptions,
  ownerOptions,
  selectedOpps,
  progress,
  onRun,
  onRetryFailed,
  onClose,
}: BulkDialogProps) {
  const fieldLabel = mode === "stage" ? "Stage" : "Owner";
  const options = mode === "stage" ? stageOptions : ownerOptions;
  const previewNames = selectedOpps.slice(0, 5).map((o) => o.Name ?? o.Id);
  const remaining = selectedOpps.length - previewNames.length;

  const running = progress != null && progress.done < progress.total;
  const finished = progress != null && progress.done === progress.total;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-surface shadow-xl">
        <header className="border-b border-border-strong px-5 py-3">
          <h2 className="text-[15px] font-semibold text-ink">
            Change {fieldLabel.toLowerCase()} for {selectedOpps.length.toLocaleString()} opportunit{selectedOpps.length === 1 ? "y" : "ies"}
          </h2>
        </header>

        <div className="px-5 py-4">
          {!progress ? (
            <>
              <label className="block text-[12px] font-medium text-ink-3">
                New {fieldLabel.toLowerCase()}
              </label>
              <select
                value={value}
                onChange={(e) => onValueChange(e.target.value)}
                autoFocus
                className="mt-1 h-9 w-full rounded border border-border-strong bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent"
              >
                <option value="">Pick a value…</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              <div className="mt-4 rounded border border-border-strong bg-surface-2 px-3 py-2.5 text-[12px] text-ink-2">
                <div className="font-medium text-ink">First {previewNames.length} of {selectedOpps.length}:</div>
                <ul className="mt-1 list-disc pl-4 leading-relaxed">
                  {previewNames.map((n) => (
                    <li key={n} className="truncate">{n}</li>
                  ))}
                </ul>
                {remaining > 0 ? (
                  <div className="mt-1 text-ink-3">…and {remaining.toLocaleString()} more</div>
                ) : null}
              </div>
            </>
          ) : (
            <div>
              <div className="text-[13px] text-ink">
                {running
                  ? `Updating ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}…`
                  : `Updated ${(progress.total - progress.failures.length).toLocaleString()} of ${progress.total.toLocaleString()}.`}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              {progress.failures.length > 0 ? (
                <div className="mt-3 max-h-40 overflow-y-auto rounded border border-red/40 bg-red/5 p-2 text-[11.5px] text-red">
                  <div className="font-semibold">Failed ({progress.failures.length}):</div>
                  <ul className="mt-1 list-disc pl-4">
                    {progress.failures.slice(0, 10).map((f) => (
                      <li key={f.id} className="truncate">
                        <span className="font-medium">{f.name}</span> — {f.error}
                      </li>
                    ))}
                    {progress.failures.length > 10 ? (
                      <li>…and {progress.failures.length - 10} more</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-strong px-5 py-3">
          {!progress ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onRun}
                disabled={!value}
                className="rounded bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Apply to {selectedOpps.length.toLocaleString()}{selectedOpps.length === 1 ? " opp" : " opps"}
              </button>
            </>
          ) : (
            <>
              {finished && progress.failures.length > 0 && onRetryFailed ? (
                <button
                  type="button"
                  onClick={() => void onRetryFailed()}
                  className="rounded border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2"
                >
                  Retry {progress.failures.length.toLocaleString()} failed
                </button>
              ) : null}
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="rounded bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {finished ? "Done" : "Running…"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

