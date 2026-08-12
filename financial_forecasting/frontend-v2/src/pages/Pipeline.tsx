import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink, Plus, Search, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AccountAvatar } from "@/components/AccountAvatar";
import { OpportunityExpandPanel, OPP_PANEL_HEIGHT } from "@/components/OpportunityExpandPanel";
import { PageHeader } from "@/components/PageHeader";
import { AwardSetupDialog } from "@/components/AwardSetupDialog";
import { PaymentScheduleBuilder } from "@/components/PaymentScheduleBuilder";
import { StageGateDialog } from "@/components/StageGateDialog";
import {
  usePipelineReviewFlags,
  ruleLabels,
  salesforceOpportunityUrl,
  type OpportunityFlags,
} from "@/services/pipelineReview";
import { useProbabilityScheduleGate } from "@/lib/useProbabilityScheduleGate";
import { useStageChangeGate } from "@/lib/useStageChangeGate";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { StageChip } from "@/components/ui/StageChip";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { fmtDate, fmtMoney, fmtMoneyFull } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "@/pages/cleanup/Filters";
import {
  isLost,
  isOpen,
  isWon,
  SF_STAGE_OPTIONS,
  stageStatus,
} from "@/lib/stages";
import { cn } from "@/lib/utils";
import { useSessionState } from "@/lib/useSessionState";
import { useAccounts, useAccountsEnrichment } from "@/services/accounts";
import {
  useCreateOpportunity,
  useOppRecordTypes,
  useOpportunities,
  useUpdateOpportunity,
} from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import { useActiveUsers, useUsers } from "@/services/users";
import type { SfOpportunity } from "@/types/salesforce";
import { toast } from "sonner";

// Three-pill scope toggle. "All" was dropped per JR — when no scope
// pill is active the user can use chip filters or search instead, and
// the union of Open/Won/Lost equals every opp anyway. We keep "all" as
// a valid Scope union value so older saved views and the inScope()
// helper still work; just no UI pill maps to it.
const SCOPES = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
] as const;
type Scope = "open" | "won" | "lost" | "all";

const RECORD_TYPES = [
  { value: "All", label: "All" },
  { value: "Philanthropy", label: "Philanthropy" },
  { value: "PBC", label: "PBC" },
] as const;
type RecordType = (typeof RECORD_TYPES)[number]["value"];

function inScope(o: SfOpportunity, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === "open") return isOpen(o);
  if (scope === "won") return isWon(o);
  if (scope === "lost") return isLost(o);
  return true;
}

// ── Chip filter model ────────────────────────────────────────────────────
//
// Mirrors the Cleanup tabs' filter rig so the same operator catalog,
// chip rendering, and saved-view payload work here. Adds Pipeline-
// specific fields (Active flag, Payment date) that the table surfaces.

const PIPELINE_FILTERABLE = {
  name: { label: "Name", type: "text", getValue: (o: SfOpportunity) => o.Name ?? "" },
  account: { label: "Account", type: "text", getValue: (o: SfOpportunity) => o.Account?.Name ?? "" },
  stage: { label: "Stage", type: "select", getValue: (o: SfOpportunity) => o.StageName ?? "" },
  owner: { label: "Owner", type: "select", getValue: (o: SfOpportunity) => o.OwnerId ?? "" },
  recordType: { label: "Record Type", type: "select", getValue: (o: SfOpportunity) => o.RecordType?.Name ?? "" },
  priority: {
    label: "Priority",
    type: "select",
    getValue: (o: SfOpportunity) => o.Priority__c ?? "",
  },
  active: {
    label: "Active",
    type: "select",
    getValue: (o: SfOpportunity) => (o.Active_Opportunity__c ? "Yes" : "No"),
  },
  amount: { label: "Amount", type: "number", getValue: (o: SfOpportunity) => o.Amount ?? null },
  probability: { label: "Probability", type: "number", getValue: (o: SfOpportunity) => o.Manager_Probability_Override__c ?? o.Probability ?? null },
  closeDate: { label: "Close date", type: "date", getValue: (o: SfOpportunity) => o.CloseDate ?? null },
  paymentDate: { label: "1st payment", type: "date", getValue: (o: SfOpportunity) => o.PaymentDate__c ?? null },
} satisfies Record<string, FieldMeta<SfOpportunity>>;

type PipelineField = keyof typeof PIPELINE_FILTERABLE;

/** Persisted shape stored in `bedrock.saved_view.filters` for the
 *  Pipeline page. Each field is optional — the loader gracefully
 *  defaults missing values, so older saved views (pre-rules,
 *  pre-columns) still load cleanly. */
interface PipelineSavedView {
  scope?: Scope;
  recordType?: RecordType;
  rules?: FilterRule<PipelineField>[];
  /** Visible column keys, in display order. */
  visibleCols?: ColKey[];
  /** Per-column pixel widths. Keys not in the map fall back to the
   *  page-level DEFAULT_WIDTHS, so adding a new column doesn't
   *  break previously-saved views. */
  widths?: Partial<Record<ColKey, number>>;
}

// NextStep was dropped — Pursuit uses Tasks as the system of record
// for "what's next on this opp", not the standard SF NextStep field.
type ColKey =
  | "name"
  | "owner"
  | "stage"
  | "priority"
  | "amount"
  | "probability"
  | "close"
  | "paymentDate";

const COLUMN_ORDER: ColKey[] = [
  "name",
  "owner",
  "stage",
  "priority",
  "amount",
  "probability",
  "close",
  "paymentDate",
];

// Defaults balanced for ~1280px viewport. Mirrors the legacy DEFAULT_VISIBLE
// set: name+account / owner / stage / amount / probability / close /
// 1st-payment. Sum ≈ 1110 to leave a touch of horizontal slack. Priority
// is hidden by default (opt-in via column chooser) so existing layouts
// don't shift.
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 260,
  owner: 150,
  stage: 150,
  priority: 100,
  amount: 130,
  probability: 90,
  close: 110,
  paymentDate: 120,
};

const COL_LABELS: Record<ColKey, string> = {
  name: "Opportunity",
  owner: "Owner",
  stage: "Stage",
  priority: "Priority",
  amount: "Amount",
  probability: "Prob.",
  close: "Close",
  paymentDate: "1st Payment",
};

const DEFAULT_VISIBLE_COLS: ColKey[] = [
  "name",
  "owner",
  "stage",
  "amount",
  "probability",
  "close",
  "paymentDate",
];

const ROW_HEIGHT = 44; // px — must match the row's actual rendered height

/** Stable router-state passed when opening an opp from this page so
 *  the detail page's BackLink renders "Back to Pipeline". */
const PIPELINE_REFERRER = {
  from: { pathname: "/pipeline", label: "Pipeline" },
} as const;

function extractOpp(o: SfOpportunity, key: ColKey): unknown {
  switch (key) {
    case "name": return o.Name;
    case "owner": return o.Owner?.Name;
    case "stage": return o.StageName;
    // Sort: High > Medium > Low > (empty). Map to a numeric rank so the
    // sort comparator orders them sensibly instead of alphabetically.
    case "priority": {
      const rank: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
      return rank[o.Priority__c ?? ""] ?? 0;
    }
    case "amount": return o.Amount ?? 0;
    case "probability": return o.Manager_Probability_Override__c ?? o.Probability ?? 0;
    case "close": return o.CloseDate;
    case "paymentDate": return o.PaymentDate__c;
  }
}

export function PipelinePage() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>("open");
  const [recordType, setRecordType] = useState<RecordType>("All");
  // Stage card click on the funnel strip → narrow the table to one stage.
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  // Chip-based filter rules (parity with Cleanup). Persisted into
  // saved views alongside scope/recordType.
  const [rules, setRules] = useState<FilterRule<PipelineField>[]>([]);
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useSessionState<string | null>("pipeline:expandedId", null);
  const canEdit = usePerm("edit_all_opportunities");

  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility("bedrock-v2:vis:pipeline", COLUMN_ORDER, DEFAULT_VISIBLE_COLS);

  const { sort, toggle } = useSort<ColKey>({ key: "close", direction: "asc" });
  const { widths, startResize, replaceAll: replaceWidths } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:pipeline",
    DEFAULT_WIDTHS,
  );

  const { data, isLoading, isError, error } = useOpportunities({
    recordType: recordType === "All" ? undefined : recordType,
  });
  // Advisory hygiene flags. Deliberately not awaited alongside the grid: the
  // rows render immediately and the tint arrives when it arrives. A failed
  // flags call must never keep the pipeline off screen.
  const { data: reviewFlags } = usePipelineReviewFlags();
  const reviewRuleLabels = useMemo(() => ruleLabels(reviewFlags), [reviewFlags]);
  const accountsQ = useAccounts();
  const usersQ = useActiveUsers();
  // `allUsersQ` includes inactive users — only used by the chip facet
  // so an inactive owner who still has rows in the loaded data can be
  // filtered for. Write-side owner pickers stay on `usersQ` (active).
  const allUsersQ = useUsers();
  const updateOpp = useUpdateOpportunity();
  // updateStage is now consumed inside useStageChangeGate — Pipeline
  // routes every save through stageGate.request(opp, stage) so the
  // playbook checklists fire when needed. Direct calls are gone.

  const opps = data ?? [];

  // Logo enrichment for the account behind every visible opp. Same
  // Apollo-overlay pipeline used elsewhere — chunked 200 ids per
  // batch by the hook so a 2000-row pipeline doesn't pile into one
  // monstrous URL.
  const accountIdsForEnrichment = useMemo(() => {
    const set = new Set<string>();
    for (const o of opps) {
      if (o.AccountId) set.add(o.AccountId);
    }
    return Array.from(set);
  }, [opps]);
  const enrichmentQ = useAccountsEnrichment(accountIdsForEnrichment);

  // Stage <select> options are the curated 7 canonical stages in
  // funnel order — see SF_STAGE_OPTIONS in lib/stages.ts. Rows already
  // in a legacy stage continue to display that stage as their resting
  // value (HTML select handles unknown selected values), but opening
  // the dropdown only offers the 7 canonical choices.
  const stageOptions = useMemo(
    () => SF_STAGE_OPTIONS.map((s) => ({ value: s.value, label: s.label })),
    [],
  );

  // Filter chip's stage options — keep data-derived so users can still
  // filter to historical legacy stages (e.g. "Closed Lost" rollups).
  // Sorted by canonical funnel position; unknown legacy values fall to
  // the end.
  const stageFilterOptions = useMemo(() => {
    const rank = new Map(SF_STAGE_OPTIONS.map((s, i) => [s.value, i]));
    const seen = new Set<string>();
    for (const o of opps) if (o.StageName) seen.add(o.StageName);
    return Array.from(seen)
      .sort((a, b) => (rank.get(a) ?? 9999) - (rank.get(b) ?? 9999))
      .map((s) => ({ value: s, label: s }));
  }, [opps]);

  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({
        value: u.Id,
        label: u.Name,
      })),
    [usersQ.data],
  );

  // Opps that match the toolbar filters (scope pill, stage pill, search
  // box) — used to populate the chip-filter picker facets so the picker
  // reflects what's visible in the table, not the entire server load.
  // We intentionally don't apply existing chip `rules` here: doing so
  // would shrink the picker to "current selection only" once you add an
  // owner filter, defeating the purpose of switching owners.
  const oppsInView = useMemo(() => {
    return opps.filter((o) => {
      if (!inScope(o, scope)) return false;
      if (stageFilter && o.StageName !== stageFilter) return false;
      if (q) {
        const needle = q.toLowerCase();
        const hay =
          (o.Name ?? "").toLowerCase() +
          " " +
          (o.Account?.Name ?? "").toLowerCase() +
          " " +
          (o.Owner?.Name ?? "").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [opps, scope, stageFilter, q]);

  // Chip-filter facets — owner options are the union of:
  //   (a) every active SF user (always — so you can filter to a
  //       teammate even if they have zero rows right now), and
  //   (b) inactive users that own at least one row in the current view.
  // Inactive users with zero visible rows are dropped. Per user spec:
  //   "active Salesforce users + inactive ones that have records in the
  //    table".
  // Record types come from the opps present in the current view.
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
    const recordTypes = new Set<string>();
    for (const o of oppsInView) {
      if (o.OwnerId) {
        ownersInView.add(o.OwnerId);
        if (o.Owner?.Name) ownerNameFromData.set(o.OwnerId, o.Owner.Name);
      }
      if (o.RecordType?.Name) recordTypes.add(o.RecordType.Name);
    }

    type OwnerOption = { value: string; label: string };
    const ownerOptions: OwnerOption[] = [];
    // (a) every active user
    for (const u of activeById.values()) {
      ownerOptions.push({ value: u.Id, label: u.Name });
    }
    // (b) inactive users with rows in the current view
    for (const id of ownersInView) {
      if (activeById.has(id)) continue;
      const inactive = inactiveById.get(id);
      const name = inactive?.Name ?? ownerNameFromData.get(id) ?? id;
      ownerOptions.push({ value: id, label: `${name} (inactive)` });
    }
    ownerOptions.sort((a, b) => a.label.localeCompare(b.label));

    return {
      stage: stageFilterOptions,
      owner: ownerOptions,
      recordType: Array.from(recordTypes).sort().map((v) => ({ value: v, label: v })),
      priority: [
        { value: "High", label: "High" },
        { value: "Medium", label: "Medium" },
        { value: "Low", label: "Low" },
      ],
      active: [
        { value: "Yes", label: "Yes" },
        { value: "No", label: "No" },
      ],
    };
  }, [oppsInView, allUsersQ.data, stageFilterOptions]);

  // Owner-id → display-name lookup for filter-chip rendering.
  const ownerLabelLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of usersQ.data ?? []) m.set(u.Id, u.Name);
    for (const o of opps) {
      if (o.OwnerId && !m.has(o.OwnerId) && o.Owner?.Name) {
        m.set(o.OwnerId, o.Owner.Name);
      }
    }
    return (id: string) => m.get(id) ?? id;
  }, [usersQ.data, opps]);

  const accountOptions = useMemo(
    () =>
      (accountsQ.data ?? []).map((a) => ({
        value: a.Id,
        label: a.Name,
      })),
    [accountsQ.data],
  );

  const filtered = useMemo(() => {
    const filt = opps.filter((o) => {
      if (!inScope(o, scope)) return false;
      if (stageFilter && o.StageName !== stageFilter) return false;
      if (q) {
        const needle = q.toLowerCase();
        const hay =
          (o.Name ?? "").toLowerCase() +
          " " +
          (o.Account?.Name ?? "").toLowerCase() +
          " " +
          (o.Owner?.Name ?? "").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      // Chip rules — every active rule must pass (AND).
      for (const r of rules) {
        if (!ruleApplies(o, r, PIPELINE_FILTERABLE)) return false;
      }
      return true;
    });
    return sortBy(filt, sort, extractOpp);
  }, [opps, scope, stageFilter, q, rules, sort]);

  const total = useMemo(
    () => filtered.reduce((s, o) => s + (o.Amount ?? 0), 0),
    [filtered],
  );

  // Route stage changes through the gate so transitions like
  // "Ask in Progress → Proposal Submitted" or "→ Withdrawn" can
  // prompt for the playbook's required fields before the mutation
  // fires. Unrestricted transitions still fire the mutation directly.
  const stageGate = useStageChangeGate();
  const probGate = useProbabilityScheduleGate();
  const saveStage = useCallback(
    async (opp: SfOpportunity, stage: string) => {
      await stageGate.request(opp, stage);
    },
    [stageGate],
  );

  const saveAmount = useCallback(
    async (id: string, raw: string) => {
      const cleaned = raw.replace(/[$,\s]/g, "");
      const parsed = cleaned === "" ? null : Number(cleaned);
      if (parsed != null && !Number.isFinite(parsed)) {
        throw new Error("Not a number");
      }
      await updateOpp.mutateAsync({ id, patch: { Amount: parsed } });
    },
    [updateOpp],
  );

  const saveProbability = useCallback(
    async (opp: SfOpportunity, raw: string) => {
      const cleaned = raw.replace(/[%\s]/g, "");
      const parsed = cleaned === "" ? null : Number.parseInt(cleaned, 10);
      if (parsed != null) {
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          throw new Error("0–100");
        }
      }
      // Playbook rule: cannot raise probability from 0 → >0 without a
      // payment schedule. The gate fetches the opp's payments; if none
      // exist it opens PaymentScheduleBuilder and rejects this promise
      // — InlineSelect catches and reverts the optimistic display. The
      // promise resolves only after the user saves a schedule.
      await probGate.request(opp, parsed);

      // Match what Salesforce does when you edit Mgr Prob in its UI:
      // it propagates the override into Probability so the two stay in
      // sync. We only co-write Probability when the user set a value —
      // clearing the override falls back to SF's stage-driven default.
      const patch: Record<string, unknown> = { Manager_Probability_Override__c: parsed };
      if (parsed != null) patch.Probability = parsed;
      await updateOpp.mutateAsync({ id: opp.Id, patch });
    },
    [updateOpp, probGate],
  );

  const saveOwner = useCallback(
    async (id: string, ownerId: string) => {
      const ownerName =
        (usersQ.data ?? []).find((u) => u.Id === ownerId)?.Name ?? null;
      await updateOpp.mutateAsync({
        id,
        patch: { OwnerId: ownerId },
        displayPatch: { Owner: { Name: ownerName } },
      });
    },
    [updateOpp, usersQ.data],
  );

  const savePaymentDate = useCallback(
    async (id: string, next: string | null) => {
      await updateOpp.mutateAsync({ id, patch: { PaymentDate__c: next } });
    },
    [updateOpp],
  );

  const savePriority = useCallback(
    async (id: string, next: string) => {
      await updateOpp.mutateAsync({
        id,
        patch: { Priority__c: next || null },
      });
    },
    [updateOpp],
  );

  const saveCloseDate = useCallback(
    async (id: string, next: string | null) => {
      await updateOpp.mutateAsync({ id, patch: { CloseDate: next } });
    },
    [updateOpp],
  );

  const tableMinWidth = totalWidth(widths);

  // ── Virtualization ─────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) =>
      filtered[i]?.Id === expandedId ? ROW_HEIGHT + OPP_PANEL_HEIGHT : ROW_HEIGHT,
    overscan: 8,
  });
  useEffect(() => { virtualizer.measure(); }, [expandedId, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom =
    totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  return (
    <div className="flex h-full flex-col px-7 py-6 pb-6">
      <PageHeader
        title="Pipeline"
        subtitle={
          isLoading
            ? "Loading…"
            : `${filtered.length.toLocaleString()} opportunities · ${fmtMoney(total)}`
        }
        actions={
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex h-[30px] items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[13px] font-medium text-surface hover:opacity-90"
          >
            <Plus size={14} /> New opportunity
          </button>
        }
      />

      <FunnelStrip
        opps={opps}
        scope={scope}
        activeStage={stageFilter}
        onStageClick={(s) => setStageFilter((cur) => (cur === s ? null : s))}
      />

      {/* Row 1 — primary controls all on one line, matching pill
          aesthetic across the row: scope pills · record-type pills ·
          [stage chip] · Search · Filter · spacer · Columns · Views.
          Wraps cleanly on narrower viewports. */}
      <Toolbar className="mt-4">
        <ButtonGroup
          value={scope}
          onChange={(v) => { setScope(v as Scope); setStageFilter(null); }}
          options={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
        />
        <ButtonGroup
          value={recordType}
          onChange={(v) => { setRecordType(v as RecordType); setStageFilter(null); }}
          options={RECORD_TYPES.map((r) => ({ value: r.value, label: r.label }))}
        />
        {stageFilter ? (
          <button
            type="button"
            onClick={() => setStageFilter(null)}
            className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-accent bg-accent/10 px-2.5 text-[12px] text-ink hover:bg-accent/20"
            title="Clear stage filter"
          >
            Stage: {stageFilter}
            <X size={11} aria-hidden="true" />
          </button>
        ) : null}
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
        <AddFilterButton<PipelineField>
          filterable={PIPELINE_FILTERABLE as Record<PipelineField, FieldMeta<unknown>>}
          selectOptions={{
            stage: chipFacets.stage,
            owner: chipFacets.owner,
            recordType: chipFacets.recordType,
            priority: chipFacets.priority,
            active: chipFacets.active,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser
            allColumns={COLUMN_ORDER}
            labels={COL_LABELS}
            visible={visibleCols}
            required={["name"]}
            onToggle={toggleCol}
          />
          <SavedViewsPicker<PipelineSavedView>
            scopeKey="pipeline"
            currentFilters={{
              scope,
              recordType,
              rules,
              visibleCols,
              widths,
            }}
            onLoad={(v) => {
              // Tolerate older saved views that pre-date the rules /
              // visibleCols / widths fields by defaulting to current.
              setScope(v.scope ?? "open");
              setRecordType(v.recordType ?? "All");
              setRules(v.rules ?? []);
              setStageFilter(null);
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

      {/* Row 2 — active filter chips. Sits flush against the toolbar
          above and the table below, sharing the same border so the
          three rows read as one continuous card. Horizontal padding
          matches the toolbar's px-3 so the first chip's left edge
          aligns with the "Open" pill directly above it. */}
      {rules.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, PIPELINE_FILTERABLE, (field, v) =>
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
        spacer rows above + below the visible window. Row count in the DOM
        stays bounded regardless of dataset size.
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
                  Failed to load opportunities
                  {error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleCols.length}
                  className="px-7 py-10 text-center text-[13px] text-ink-3"
                >
                  {opps.length === 0
                    ? "No opportunities. (Is Salesforce connected?)"
                    : "No opportunities match your filters."}
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
                  const o = filtered[vi.index];
                  const isExpanded = o.Id === expandedId;
                  const logoUrl = o.AccountId
                    ? (enrichmentQ.data?.[o.AccountId]?.logo_url ?? null)
                    : null;
                  return (
                    <Fragment key={o.Id}>
                      <OpportunityRow
                        o={o}
                        logoUrl={logoUrl}
                        stageOptions={stageOptions}
                        ownerOptions={ownerOptions}
                        onOpen={() => navigate(`/opportunities/${o.Id}`, { state: PIPELINE_REFERRER })}
                        onSaveStage={(stage) => saveStage(o, stage)}
                        onSaveAmount={(raw) => saveAmount(o.Id, raw)}
                        onSaveProbability={(raw) => saveProbability(o, raw)}
                        onSaveOwner={(ownerId) => saveOwner(o.Id, ownerId)}
                        onSavePaymentDate={(next) => savePaymentDate(o.Id, next)}
                        onSavePriority={(next) => savePriority(o.Id, next)}
                        onSaveCloseDate={(next) => saveCloseDate(o.Id, next)}
                        isExpanded={isExpanded}
                        onToggleExpand={() => setExpandedId(isExpanded ? null : o.Id)}
                        canEdit={canEdit}
                        visibleCols={visibleCols}
                        flags={reviewFlags?.flagged[o.Id]}
                        ruleLabel={reviewRuleLabels}
                      />
                      {isExpanded ? (
                        <tr>
                          <td colSpan={visibleCols.length} className="p-0">
                            <OpportunityExpandPanel
                              opportunityId={o.Id}
                              oppAmount={o.Amount ?? null}
                              oppCloseDate={o.CloseDate ?? null}
                            />
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
                  if (idx === 0) {
                    return (
                      <td key={key} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                        Totals · {filtered.length.toLocaleString()} opp{filtered.length === 1 ? "" : "s"}
                      </td>
                    );
                  }
                  if (key === "amount") {
                    return (
                      <td key={key} className="mono px-3 py-2 text-right text-[13px] font-semibold tabular-nums">
                        {fmtMoney(total)}
                      </td>
                    );
                  }
                  return <td key={key} />;
                })}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {showCreate ? (
        <CreateOpportunityModal
          ownerOptions={ownerOptions}
          accountOptions={accountOptions}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            // Modal already closed itself optimistically; toast is
            // handled inside the modal's submit. Just navigate to the
            // detail page now that we have the real SF id.
            navigate(`/opportunities/${id}`, { state: PIPELINE_REFERRER });
          }}
        />
      ) : null}

      {stageGate.pending ? (
        <StageGateDialog
          spec={stageGate.pending.spec}
          opp={stageGate.pending.opp}
          toStage={stageGate.pending.toStage}
          onClose={stageGate.dismiss}
          onCompleted={stageGate.complete}
          onAwardCreated={stageGate.openAwardSetup}
        />
      ) : null}

      {stageGate.awardSetup ? (
        <AwardSetupDialog
          awardId={stageGate.awardSetup.awardId}
          opportunityId={stageGate.awardSetup.opportunityId}
          onClose={stageGate.dismissAwardSetup}
        />
      ) : null}

      {probGate.pending ? (
        <PaymentScheduleBuilder
          opportunityId={probGate.pending.opp.Id}
          oppAmount={probGate.pending.opp.Amount ?? null}
          existingPayments={[]}
          initialFirstDate={probGate.pending.opp.CloseDate ?? null}
          prompt={`Raising probability to ${probGate.pending.nextProbability}% — set the expected payment schedule before continuing.`}
          onClose={probGate.dismiss}
          onSaved={probGate.complete}
        />
      ) : null}
    </div>
  );
}

function CreateOpportunityModal({
  ownerOptions,
  accountOptions,
  onClose,
  onCreated,
}: {
  ownerOptions: { value: string; label: string }[];
  accountOptions: { value: string; label: string }[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const createOpp = useCreateOpportunity();
  const { data: recordTypes = [] } = useOppRecordTypes();
  const [form, setForm] = useState({
    Name: "",
    StageName: "New Lead",
    CloseDate: "",
    AccountId: "",
    Amount: "",
    OwnerId: "",
    RecordTypeId: "",
  });
  const [accountQ, setAccountQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const filteredAccounts = useMemo(() => {
    if (!accountQ.trim()) return accountOptions.slice(0, 50);
    const q = accountQ.toLowerCase();
    return accountOptions.filter((a) => a.label.toLowerCase().includes(q)).slice(0, 50);
  }, [accountOptions, accountQ]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.Name.trim() || !form.CloseDate || !form.AccountId) return;
    setError(null);
    // Optimistic close: dismiss the modal immediately and toast the
    // background save. Once the SF id arrives, navigate to the detail
    // page (the new opp is already inserted into the opportunities
    // cache in useCreateOpportunity.onSuccess, so the detail page
    // renders instantly).
    const body = {
      Name: form.Name.trim(),
      StageName: form.StageName,
      CloseDate: form.CloseDate,
      AccountId: form.AccountId,
      Amount: form.Amount ? Number(form.Amount.replace(/[^0-9.]/g, "")) : undefined,
      OwnerId: form.OwnerId || undefined,
      RecordTypeId: form.RecordTypeId || undefined,
    };
    const toastId = `opp-create-${Date.now()}`;
    toast.loading(`Creating ${body.Name}…`, { id: toastId });
    onClose();
    void (async () => {
      try {
        const result = await createOpp.mutateAsync(body);
        toast.success(`Created ${body.Name}`, { id: toastId });
        onCreated(result.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create opportunity.";
        toast.error(`Couldn't create: ${msg}`, { id: toastId, duration: 8000 });
      }
    })();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-3">
          <span className="text-[14px] font-semibold">New opportunity</span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3 px-5 py-4">
          <ModalField label="Name *">
            <input
              value={form.Name}
              onChange={set("Name")}
              placeholder="Opportunity name"
              required
              className={modalInputCls}
            />
          </ModalField>
          <ModalField label="Account *">
            <input
              value={accountQ}
              onChange={(e) => {
                setAccountQ(e.target.value);
                setForm((f) => ({ ...f, AccountId: "" }));
              }}
              placeholder="Search accounts…"
              className={modalInputCls}
            />
            {accountQ.trim() && !form.AccountId ? (
              <div className="mt-0.5 max-h-36 overflow-auto rounded border border-border-strong bg-surface shadow-md">
                {filteredAccounts.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-ink-3">No accounts found</div>
                ) : (
                  filteredAccounts.map((a) => (
                    <button
                      key={a.value}
                      type="button"
                      className="block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2"
                      onClick={() => {
                        setForm((f) => ({ ...f, AccountId: a.value }));
                        setAccountQ(a.label);
                      }}
                    >
                      {a.label}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </ModalField>
          {recordTypes.length > 0 && (
            <ModalField label="Record type">
              <select value={form.RecordTypeId} onChange={set("RecordTypeId")} className={modalInputCls}>
                <option value="">— default —</option>
                {recordTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>{rt.name}</option>
                ))}
              </select>
            </ModalField>
          )}
          <ModalField label="Stage">
            <select value={form.StageName} onChange={set("StageName")} className={modalInputCls}>
              {SF_STAGE_OPTIONS.map((s: { value: string; label: string }) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </ModalField>
          <ModalField label="Close date *">
            <input
              type="date"
              value={form.CloseDate}
              onChange={set("CloseDate")}
              required
              className={modalInputCls}
            />
          </ModalField>
          <ModalField label="Amount">
            <input
              value={form.Amount}
              onChange={set("Amount")}
              placeholder="0"
              className={modalInputCls}
            />
          </ModalField>
          <ModalField label="Owner">
            <select value={form.OwnerId} onChange={set("OwnerId")} className={modalInputCls}>
              <option value="">— unassigned —</option>
              {ownerOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </ModalField>
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
              disabled={!form.Name.trim() || !form.CloseDate || !form.AccountId || createOpp.isPending}
              className="rounded border border-ink bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
            >
              {createOpp.isPending ? "Creating…" : "Create opportunity"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const modalInputCls =
  "w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink-3 placeholder:text-ink-4";

function ModalField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}

function FunnelStrip({
  opps,
  scope,
  activeStage,
  onStageClick,
}: {
  opps: SfOpportunity[];
  scope: Scope;
  activeStage: string | null;
  onStageClick: (stage: string) => void;
}) {
  // Group by the literal SF StageName — no mapping. Show every stage that
  // actually appears in the filtered data, ordered by canonical funnel position.
  const groups = useMemo(() => {
    const stageRank = new Map(SF_STAGE_OPTIONS.map((s, i) => [s.value, i]));
    const m = new Map<string, { stage: string; status: "open" | "won" | "lost"; count: number; amount: number }>();
    for (const o of opps) {
      if (!inScope(o, scope)) continue;
      const stage = o.StageName || "—";
      const cur = m.get(stage) ?? { stage, status: stageStatus(o), count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += o.Amount ?? 0;
      m.set(stage, cur);
    }
    return Array.from(m.values()).sort(
      (a, b) =>
        (stageRank.get(a.stage) ?? 9999) - (stageRank.get(b.stage) ?? 9999),
    );
  }, [opps, scope]);

  if (groups.length === 0) return null;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2">
      {groups.map((g) => {
        const isActive = activeStage === g.stage;
        const isDimmed = activeStage != null && !isActive;
        return (
          <button
            key={g.stage}
            type="button"
            onClick={() => onStageClick(g.stage)}
            className={cn(
              "flex flex-col rounded-md border bg-surface px-3 py-2.5 text-left shadow-sm transition-all hover:border-accent",
              isActive && "border-accent ring-2 ring-accent/30",
              !isActive && "border-border-strong",
              isDimmed && "opacity-50 hover:opacity-100",
            )}
            aria-pressed={isActive}
            title={isActive ? `Clear filter (${g.stage})` : `Filter to ${g.stage}`}
          >
            <div className="flex items-center gap-2">
              <StageChip stage={g.stage} status={g.status} />
              <span className="text-[11.5px] uppercase tracking-wide text-ink-3">
                {g.count}
              </span>
            </div>
            <span className="mono mt-1 text-[15px] font-semibold tabular-nums">
              {fmtMoney(g.amount)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface RowProps {
  o: SfOpportunity;
  logoUrl: string | null;
  stageOptions: { value: string; label: string }[];
  ownerOptions: { value: string; label: string }[];
  onOpen: () => void;
  onSaveStage: (stage: string) => void | Promise<void>;
  onSaveAmount: (raw: string) => Promise<void>;
  onSaveProbability: (raw: string) => Promise<void>;
  onSaveOwner: (ownerId: string) => Promise<void>;
  onSavePaymentDate: (next: string | null) => Promise<void>;
  onSavePriority: (next: string) => Promise<void>;
  onSaveCloseDate: (next: string | null) => Promise<void>;
  isExpanded: boolean;
  onToggleExpand: () => void;
  canEdit: boolean;
  visibleCols: ColKey[];
  /** Advisory hygiene flags for this row, absent when it's clean. */
  flags?: OpportunityFlags;
  /** Rule key → sentence, for the hover text. */
  ruleLabel: Record<string, string>;
}

/** Resting-state formatters for the row's inline-edit fields. Defined
 *  outside the component so the function references are stable across
 *  renders (memo cache). */
function pipelineMoneyDisplay(raw: string): string {
  const n = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? fmtMoneyFull(n) : raw;
}

function pipelinePercentDisplay(raw: string): string {
  const n = Number(raw);
  return Number.isFinite(n) ? `${n}%` : raw;
}

// Priority cell options — empty string clears the value via the
// existing patch path (the row's savePriority maps "" → null).
const PIPELINE_PRIORITY_OPTIONS = [
  { value: "", label: "—" },
  { value: "High", label: "High" },
  { value: "Medium", label: "Medium" },
  { value: "Low", label: "Low" },
];

function PriorityDot({ value }: { value: string | null }) {
  if (!value) return <span className="text-ink-4">—</span>;
  const tone =
    value === "High"
      ? "border-red bg-red-soft text-red"
      : value === "Medium"
      ? "border-amber bg-amber-soft text-amber"
      : "border-border-strong bg-surface-2 text-ink-3";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[11.5px] font-medium",
        tone,
      )}
    >
      {value}
    </span>
  );
}

const OpportunityRow = memo(function OpportunityRow({
  o,
  logoUrl,
  stageOptions,
  ownerOptions,
  onOpen,
  onSaveStage,
  onSaveAmount,
  onSaveProbability,
  onSaveOwner,
  onSavePaymentDate,
  onSavePriority,
  onSaveCloseDate,
  isExpanded,
  onToggleExpand,
  canEdit,
  visibleCols,
  flags,
  ruleLabel,
}: RowProps) {
  const account = o.Account?.Name ?? "—";

  // Advisory tint. `bg-amber-soft` at full strength on purpose: the palette is
  // declared as bare `var(--x)` in tailwind.config.ts, so Tailwind can't
  // compose an alpha channel and any `/opacity` modifier is silently dropped.
  // --amber-soft is already a pale wash, which is the weight we want.
  const flagCls = (key: ColKey) =>
    flags?.cells[key] ? "bg-amber-soft" : undefined;

  /** Why this cell is tinted — one sentence per rule, for the title tooltip. */
  const flagWhy = (key: ColKey): string | undefined => {
    const rules = flags?.cells[key];
    if (!rules?.length) return undefined;
    const lines = rules.map((r) => `• ${ruleLabel[r] ?? r}`);
    // Payment-level rules are about a specific payment, and "which one" is the
    // first thing you need in order to fix it.
    if (key === "paymentDate" && flags?.payments.length) {
      for (const p of flags.payments) {
        const when = p.scheduled_date ? ` scheduled ${p.scheduled_date}` : "";
        lines.push(`— ${p.name ?? "Payment"}${when}`);
      }
    }
    return lines.join("\n");
  };

  const cells: Partial<Record<ColKey, React.ReactNode>> = {
    name: (
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="flex-shrink-0 text-ink-4 hover:text-ink-2 transition-colors"
          aria-label={isExpanded ? "Collapse tasks" : "Expand tasks"}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <AccountAvatar name={account} logoUrl={logoUrl} size={18} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight cursor-pointer" onClick={onOpen}>
          <span className="truncate font-medium hover:underline" title={o.Name}>{o.Name}</span>
          <span className="truncate text-[11px] text-ink-3" title={account}>{account}</span>
        </div>
        {/* Open in Salesforce — a new tab, so the review keeps its filters and
            scroll position. Angie works the pipeline with SF alongside for the
            fields Bedrock doesn't surface (secondary owner, closed-lost
            reason); losing the filtered list on every hop was the actual
            complaint. Appears on row hover so it doesn't add permanent chrome. */}
        <a
          href={salesforceOpportunityUrl(o.Id)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open this opportunity in Salesforce (new tab)"
          aria-label={`Open ${o.Name ?? "opportunity"} in Salesforce`}
          className="flex-shrink-0 text-ink-4 opacity-0 transition-opacity hover:text-accent focus:opacity-100 group-hover/row:opacity-100"
        >
          <ExternalLink size={12} />
        </a>
      </div>
    ),
    owner: canEdit ? (
      <InlineSelect
        value={o.OwnerId}
        options={ownerOptions}
        onSave={onSaveOwner}
        renderValue={(v) => (
          <span className="truncate text-[12.5px] text-ink-2">
            {o.Owner?.Name ?? ownerOptions.find((opt) => opt.value === v)?.label ?? "—"}
          </span>
        )}
      />
    ) : (
      <span className="truncate text-[12.5px] text-ink-2">{o.Owner?.Name ?? "—"}</span>
    ),
    stage: canEdit ? (
      <InlineSelect
        value={o.StageName}
        options={stageOptions}
        onSave={onSaveStage}
        renderValue={(v) =>
          v ? (
            <StageChip stage={v} status={stageStatus(o)} />
          ) : (
            <span className="text-ink-4">—</span>
          )
        }
      />
    ) : (
      o.StageName ? (
        <StageChip stage={o.StageName} status={stageStatus(o)} />
      ) : (
        <span className="text-ink-4">—</span>
      )
    ),
    priority: canEdit ? (
      <InlineSelect
        value={o.Priority__c ?? ""}
        options={PIPELINE_PRIORITY_OPTIONS}
        onSave={onSavePriority}
        renderValue={(v) => <PriorityDot value={v ?? o.Priority__c ?? null} />}
      />
    ) : (
      <PriorityDot value={o.Priority__c ?? null} />
    ),
    amount: canEdit ? (
      <InlineText
        value={o.Amount != null ? String(o.Amount) : ""}
        onSave={onSaveAmount}
        formatDisplay={pipelineMoneyDisplay}
        placeholder="—"
        className="justify-end text-right"
      />
    ) : (
      <span className={cn("tabular-nums text-right block", o.Amount && o.Amount > 0 && "font-semibold")}>
        {o.Amount != null ? fmtMoney(o.Amount) : "—"}
      </span>
    ),
    probability: canEdit ? (
      <InlineText
        value={o.Manager_Probability_Override__c != null ? String(o.Manager_Probability_Override__c) : (o.Probability != null ? String(o.Probability) : "")}
        onSave={onSaveProbability}
        formatDisplay={pipelinePercentDisplay}
        placeholder="—"
        className="justify-end text-right"
      />
    ) : (
      <span className="tabular-nums text-right block">{(o.Manager_Probability_Override__c ?? o.Probability) != null ? `${o.Manager_Probability_Override__c ?? o.Probability}%` : "—"}</span>
    ),
    close: canEdit ? (
      <InlineDate value={o.CloseDate} onSave={onSaveCloseDate} align="right" placeholder="—" />
    ) : (
      <span className="block text-right text-[13px] tabular-nums text-ink-2">{fmtDate(o.CloseDate)}</span>
    ),
    paymentDate: canEdit ? (
      <InlineDate value={o.PaymentDate__c} onSave={onSavePaymentDate} align="right" placeholder="—" />
    ) : (
      <span className="block text-right text-[13px] tabular-nums text-ink-2">{fmtDate(o.PaymentDate__c)}</span>
    ),
  };

  const cellCls: Partial<Record<ColKey, string>> = {
    name: "overflow-hidden px-3 py-1 text-[13px]",
    owner: "overflow-hidden px-3 py-1 text-[12.5px] text-ink-2",
    stage: "overflow-hidden px-3 py-1 text-[13px]",
    priority: "overflow-hidden px-3 py-1 text-[12.5px]",
    amount: cn(numCell, o.Amount && o.Amount > 0 && "font-semibold"),
    probability: cn(numCell),
    close: "overflow-hidden px-3 py-1",
    paymentDate: "overflow-hidden px-3 py-1",
  };

  return (
    <tr
      className="group/row border-b border-border-strong hover:bg-surface-2"
      style={{ height: ROW_HEIGHT }}
    >
      {visibleCols.map((key) => (
        <td key={key} className={cn(cellCls[key], flagCls(key))} title={flagWhy(key)}>
          {cells[key]}
        </td>
      ))}
    </tr>
  );
});

const numCell =
  "mono px-3 py-1 text-right text-[13px] tabular-nums overflow-hidden";

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
