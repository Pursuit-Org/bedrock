import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AccountAvatar } from "@/components/AccountAvatar";
import { AwardExpandPanel, AWARD_PANEL_HEIGHT } from "@/components/AwardExpandPanel";
import { PageHeader } from "@/components/PageHeader";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { ExpandRow } from "@/components/ui/ExpandRow";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { fmtDate, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { sortBy, useSort } from "@/lib/sort";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "@/pages/cleanup/Filters";
import { useAccountsEnrichment } from "@/services/accounts";
import {
  useAwards,
  useUpdateAward,
  type Award,
  type AwardStatus,
} from "@/services/awards";
import { useOpportunities, useUpdateOpportunity } from "@/services/opportunities";
import { useProjects } from "@/services/projects";
import { useActiveUsers, useUsers } from "@/services/users";
import { usePerm } from "@/services/permissions";
import type { SfOpportunity } from "@/types/salesforce";

interface AwardFilter {
  status: "All" | AwardStatus;
}

const STATUS_FILTERS: { value: "All" | AwardStatus; label: string }[] = [
  { value: "All", label: "All" },
  { value: "Active", label: "Active" },
  { value: "Closing", label: "Closing" },
  { value: "Closed", label: "Closed" },
  { value: "Did Not Fulfill", label: "Did Not Fulfill" },
];

const STATUS_OPTIONS: { value: AwardStatus; label: string }[] = [
  { value: "Active", label: "Active" },
  { value: "Closing", label: "Closing" },
  { value: "Closed", label: "Closed" },
  { value: "Did Not Fulfill", label: "Did Not Fulfill" },
];

function statusVariant(s: AwardStatus): "green" | "amber" | "default" | "red" {
  if (s === "Active") return "green";
  if (s === "Closing") return "amber";
  if (s === "Did Not Fulfill") return "red";
  return "default";
}

// ── Chip filter model ────────────────────────────────────────────────────
//
// Native Award fields live in the static base. Opp-derived fields
// (name / account / owner / amount / paid / pending) join in via
// useMemo so they can read oppById without re-creating the static
// definition each render.

const AWARDS_FILTERABLE_BASE = {
  status: {
    label: "Status",
    type: "select",
    getValue: (a: Award) => a.award_status,
  },
  reportingFrequency: {
    label: "Reporting frequency",
    type: "select",
    getValue: (a: Award) => a.reporting_frequency ?? "",
  },
  awardDate: {
    label: "Awarded",
    type: "date",
    getValue: (a: Award) => a.award_date,
  },
  periodEnd: {
    label: "Period end",
    type: "date",
    getValue: (a: Award) => a.period_end_date,
  },
  nextReportDue: {
    label: "Next report due",
    type: "date",
    getValue: (a: Award) => a.next_report_date ?? a.next_report_due ?? null,
  },
  overdue: {
    label: "Reports overdue",
    type: "select",
    getValue: (a: Award) => (a.report_overdue > 0 ? "Yes" : "No"),
  },
  notes: {
    label: "Notes",
    type: "text",
    getValue: (a: Award) => a.notes ?? "",
  },
} satisfies Record<string, FieldMeta<Award>>;

type AwardField =
  | keyof typeof AWARDS_FILTERABLE_BASE
  | "name"
  | "account"
  | "owner"
  | "amount"
  | "paid"
  | "pending";

interface AwardsSavedView {
  filter?: AwardFilter;
  rules?: FilterRule<AwardField>[];
  visibleCols?: ColKey[];
  widths?: Partial<Record<ColKey, number>>;
}

type ColKey =
  | "name"
  | "owner"
  | "status"
  | "amount"
  | "paymentBar"
  | "paid"
  | "pending"
  | "reporting"
  | "projects"
  | "awardDate";

const COLUMN_ORDER: ColKey[] = [
  "name",
  "owner",
  "status",
  "amount",
  "paymentBar",
  "paid",
  "pending",
  "reporting",
  "projects",
  "awardDate",
];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 300,
  owner: 150,
  status: 120,
  amount: 120,
  paymentBar: 140,
  paid: 110,
  pending: 110,
  reporting: 180,
  projects: 150,
  awardDate: 120,
};

const COL_LABELS: Record<ColKey, string> = {
  name: "Award",
  owner: "Owner",
  status: "Status",
  amount: "Total",
  paymentBar: "Progress",
  paid: "Paid",
  pending: "Pending",
  reporting: "Reports",
  projects: "Projects",
  awardDate: "Awarded",
};

const DEFAULT_VISIBLE: ColKey[] = [
  "name", "owner", "status", "amount", "paymentBar", "paid", "pending", "reporting", "projects",
];

const ROW_HEIGHT = 52; // taller — name now has account on a second line

/** Stable router-state for outbound detail-page links so BackLinks
 *  render "Back to Awards". */
const AWARDS_REFERRER = {
  from: { pathname: "/awards", label: "Awards" },
} as const;

function pendingAmount(opp: SfOpportunity | undefined): number {
  const total = opp?.Amount ?? 0;
  const paid = opp?.npe01__Payments_Made__c ?? 0;
  return Math.max(0, total - paid);
}

function extractAward(
  a: Award,
  opp: SfOpportunity | undefined,
  key: ColKey,
): unknown {
  switch (key) {
    case "name": return opp?.Name ?? a.opportunity_id;
    case "owner": return opp?.Owner?.Name ?? "";
    case "status": return a.award_status;
    case "amount": return opp?.Amount ?? 0;
    case "paid": return opp?.npe01__Payments_Made__c ?? 0;
    case "pending": return pendingAmount(opp);
    case "paymentBar": return opp?.npe01__Payments_Made__c ?? 0;
    case "awardDate": return a.award_date;
    case "reporting":
      // Sort by next due date (if any), falling back to "no reports" (empty)
      return a.next_report_date ?? a.next_report_due ?? "";
    case "projects": return ""; // sort handled separately via projectsByOpp
  }
}

// ── Payment bar ───────────────────────────────────────────────────────────

function PaymentBar({ paid, total }: { paid: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (paid / total) * 100) : 0;
  const allPaid = pct >= 99.9;
  return (
    <div className="flex w-full items-center gap-1.5">
      <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            "absolute left-0 top-0 h-full rounded-full transition-all",
            allPaid ? "bg-green-500" : "bg-accent",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="mono flex-shrink-0 text-[11px] text-ink-3">
        {Math.round(pct)}%
      </span>
    </div>
  );
}

// ── Reports progress cell ─────────────────────────────────────────────────
//
// Compact, dense visual: ●●●○ 3/4 · Aug 15 (color = next-due urgency).
// For 1–6 reports we draw individual dots; ≥7 we fall back to a fraction badge.

function ReportsProgress({ award }: { award: Award }) {
  const total = award.report_total;
  const done = award.report_done;
  const overdue = award.report_overdue > 0;
  const next = award.next_report_date;

  if (total === 0) {
    // Surface SF's npsp__Next_Grant_Deadline_Due_Date__c if no schedule yet.
    return (
      <span className="text-[11.5px] text-ink-4">
        No schedule
      </span>
    );
  }

  const allDone = done === total;
  const dueColor = allDone
    ? "text-green-700"
    : overdue
      ? "text-red"
      : isWithinDays(next, 30)
        ? "text-amber-700"
        : "text-ink-3";

  return (
    <div className="flex min-w-0 items-center gap-1.5 leading-tight">
      {total <= 6 ? (
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "inline-block h-2 w-2 rounded-full",
                i < done
                  ? "bg-green-500"
                  : overdue && i === done
                    ? "bg-red"
                    : "bg-surface-2 ring-1 ring-border-strong",
              )}
            />
          ))}
        </div>
      ) : (
        <span className={cn("mono flex-shrink-0 text-[11px] font-medium", dueColor)}>
          {done}/{total}
        </span>
      )}
      <span className={cn("mono truncate text-[11px]", dueColor)}>
        {allDone ? "Complete" : next ? `· ${fmtDate(next)}` : ""}
      </span>
    </div>
  );
}

function isWithinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  return ts - Date.now() <= days * 86_400_000 && ts >= Date.now();
}

// ── Page ──────────────────────────────────────────────────────────────────

export function AwardsPage() {
  // Default to Active so the page opens to actionable awards instead
  // of a noisy union of historical Closed / Did-Not-Fulfill rows.
  // User can still pick All / Closed / etc. via the toolbar pill.
  const [filter, setFilter] = useState<AwardFilter>({ status: "Active" });
  const [q, setQ] = useState("");
  const [rules, setRules] = useState<FilterRule<AwardField>[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const canEdit = usePerm("edit_awards");
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:awards", COLUMN_ORDER, DEFAULT_VISIBLE);

  const { sort, toggle } = useSort<ColKey>({ key: "awardDate", direction: "desc" });
  const { widths, startResize, replaceAll: replaceWidths } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:awards",
    DEFAULT_WIDTHS,
  );

  const { data: awardsData, isLoading: awardsLoading, isError, error } =
    useAwards(filter.status === "All" ? undefined : filter.status);
  const { data: oppsData } = useOpportunities({});
  const usersQ = useActiveUsers();
  // All users (active + inactive). Used only for the chip-filter owner
  // facet — write-side pickers stay on `usersQ` (active only).
  const allUsersQ = useUsers();
  const projectsQ = useProjects();
  const updateAward = useUpdateAward();
  const updateOpp = useUpdateOpportunity();

  // Pull logo enrichment for every account that owns an award. Reuses
  // the same Apollo-overlay pipeline as the Accounts page so the brand
  // logos rendered here are the high-quality marks (not favicons).
  const accountIdsForEnrichment = useMemo(() => {
    const set = new Set<string>();
    for (const o of oppsData ?? []) {
      if (o.AccountId) set.add(o.AccountId);
    }
    return Array.from(set);
  }, [oppsData]);
  const enrichmentQ = useAccountsEnrichment(accountIdsForEnrichment);

  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  const oppById = useMemo(() => {
    const m = new Map<string, SfOpportunity>();
    for (const o of oppsData ?? []) m.set(o.Id, o);
    return m;
  }, [oppsData]);

  // Filterable extends the static base with opp-derived fields.
  const filterable = useMemo(
    () => ({
      ...AWARDS_FILTERABLE_BASE,
      name: {
        label: "Name",
        type: "text",
        getValue: (a: Award) => oppById.get(a.opportunity_id)?.Name ?? "",
      },
      account: {
        label: "Account",
        type: "text",
        getValue: (a: Award) => oppById.get(a.opportunity_id)?.Account?.Name ?? "",
      },
      owner: {
        label: "Owner",
        type: "select",
        getValue: (a: Award) => oppById.get(a.opportunity_id)?.OwnerId ?? "",
      },
      amount: {
        label: "Total",
        type: "number",
        getValue: (a: Award) => oppById.get(a.opportunity_id)?.Amount ?? 0,
      },
      paid: {
        label: "Paid",
        type: "number",
        getValue: (a: Award) =>
          oppById.get(a.opportunity_id)?.npe01__Payments_Made__c ?? 0,
      },
      pending: {
        label: "Pending",
        type: "number",
        getValue: (a: Award) => pendingAmount(oppById.get(a.opportunity_id)),
      },
    }) as Record<AwardField, FieldMeta<Award>>,
    [oppById],
  );

  // Awards visible after toolbar-level filters (server-side status pill
  // already filtered awardsData; only `q` search remains as a
  // client-side toolbar filter). Used for the chip-filter facet so the
  // owner picker reflects rows visible in the table. Chip `rules` are
  // excluded to keep the picker stable when an owner filter is applied.
  const awardsInView = useMemo(() => {
    const needle = q.toLowerCase();
    return (awardsData ?? []).filter((a) => {
      if (!q) return true;
      const opp = oppById.get(a.opportunity_id);
      return (
        (opp?.Name ?? "").toLowerCase().includes(needle) ||
        (opp?.Account?.Name ?? "").toLowerCase().includes(needle) ||
        (opp?.Owner?.Name ?? "").toLowerCase().includes(needle) ||
        (a.notes ?? "").toLowerCase().includes(needle)
      );
    });
  }, [awardsData, oppById, q]);

  // Chip-filter facets — owner options are the union of:
  //   (a) every active SF user, and
  //   (b) inactive users with at least one row in the current view.
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
    const freqs = new Set<string>();
    for (const a of awardsInView) {
      const opp = oppById.get(a.opportunity_id);
      if (opp?.OwnerId) {
        ownersInView.add(opp.OwnerId);
        if (opp.Owner?.Name) ownerNameFromData.set(opp.OwnerId, opp.Owner.Name);
      }
      if (a.reporting_frequency) freqs.add(a.reporting_frequency);
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
    return {
      owner: ownerOptions,
      status: STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      reportingFrequency: Array.from(freqs)
        .sort()
        .map((v) => ({ value: v, label: v })),
      overdue: yesNo,
    };
  }, [awardsInView, oppById, allUsersQ.data]);

  const ownerLabelLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of usersQ.data ?? []) m.set(u.Id, u.Name);
    for (const a of awardsData ?? []) {
      const opp = oppById.get(a.opportunity_id);
      if (opp?.OwnerId && !m.has(opp.OwnerId) && opp.Owner?.Name) {
        m.set(opp.OwnerId, opp.Owner.Name);
      }
    }
    return (id: string) => m.get(id) ?? id;
  }, [usersQ.data, awardsData, oppById]);

  const projectsByOpp = useMemo(() => {
    const m = new Map<string, { id: string; name: string }[]>();
    for (const p of projectsQ.data ?? []) {
      if (!p.opportunity_id) continue;
      const arr = m.get(p.opportunity_id) ?? [];
      arr.push({ id: p.id, name: p.name });
      m.set(p.opportunity_id, arr);
    }
    return m;
  }, [projectsQ.data]);

  const awards = awardsData ?? [];
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    const filt = awards.filter((a) => {
      if (q) {
        const opp = oppById.get(a.opportunity_id);
        const hit =
          (opp?.Name ?? "").toLowerCase().includes(needle) ||
          (opp?.Account?.Name ?? "").toLowerCase().includes(needle) ||
          (opp?.Owner?.Name ?? "").toLowerCase().includes(needle) ||
          (a.notes ?? "").toLowerCase().includes(needle);
        if (!hit) return false;
      }
      for (const r of rules) {
        if (!ruleApplies(a, r, filterable)) return false;
      }
      return true;
    });
    return sortBy(filt, sort, (a, key) =>
      extractAward(a, oppById.get(a.opportunity_id), key),
    );
  }, [awards, oppById, q, rules, filterable, sort]);

  const totalAmount = filtered.reduce((s, a) => s + (oppById.get(a.opportunity_id)?.Amount ?? 0), 0);
  const totalPaid = filtered.reduce((s, a) => s + (oppById.get(a.opportunity_id)?.npe01__Payments_Made__c ?? 0), 0);
  const totalPending = filtered.reduce((s, a) => s + pendingAmount(oppById.get(a.opportunity_id)), 0);

  const tableMinWidth = totalWidth(widths);

  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) =>
      filtered[i]?.id === expandedId ? ROW_HEIGHT + AWARD_PANEL_HEIGHT : ROW_HEIGHT,
    overscan: 8,
  });
  useEffect(() => { virtualizer.measure(); }, [expandedId, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  const saveAward = (id: string) => async (patch: Record<string, unknown>) => {
    await updateAward.mutateAsync({ id, patch });
  };

  return (
    <div className="flex h-full flex-col px-7 py-6 pb-6">
      <PageHeader
        title="Awards"
        subtitle={
          awardsLoading
            ? "Loading…"
            : `${filtered.length.toLocaleString()} awards · ${fmtMoney(totalAmount)}`
        }
      />

      <Toolbar>
        <ButtonGroup
          value={filter.status}
          onChange={(v) => setFilter((f) => ({ ...f, status: v as "All" | AwardStatus }))}
          options={STATUS_FILTERS}
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
        <AddFilterButton<AwardField>
          filterable={filterable as Record<AwardField, FieldMeta<unknown>>}
          selectOptions={{
            owner: chipFacets.owner,
            status: chipFacets.status,
            reportingFrequency: chipFacets.reportingFrequency,
            overdue: chipFacets.overdue,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser<ColKey>
            allColumns={COLUMN_ORDER}
            labels={COL_LABELS}
            visible={visibleCols}
            onToggle={toggleCol}
            required={["name"]}
          />
          <SavedViewsPicker<AwardsSavedView>
            scopeKey="awards"
            currentFilters={{ filter, rules, visibleCols, widths }}
            onLoad={(v) => {
              setFilter(v.filter ?? { status: "Active" });
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

      {/* Active filter chips. Border-attached strip — same pattern
          as Pipeline / Accounts / Contacts. */}
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

      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto rounded-b-lg border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{ tableLayout: "fixed", width: "100%", minWidth: tableMinWidth }}
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
                  <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {awardsLoading ? (
              <SkeletonRows colCount={visibleCols.length} />
            ) : isError ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-10 text-center text-[13px] text-red">
                  Failed to load awards{error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-12 text-center text-[13px] text-ink-3">
                  {awards.length === 0 ? "No awards yet." : "No awards match your filters."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 && <tr aria-hidden style={{ height: paddingTop }}><td colSpan={visibleCols.length} /></tr>}
                {virtualItems.map((vi) => {
                  const a = filtered[vi.index];
                  const opp = oppById.get(a.opportunity_id);
                  const isExpanded = a.id === expandedId;
                  const projects = projectsByOpp.get(a.opportunity_id) ?? [];
                  const logoUrl = opp?.AccountId
                    ? (enrichmentQ.data?.[opp.AccountId]?.logo_url ?? null)
                    : null;
                  return (
                    <Fragment key={a.id}>
                      <AwardRow
                        a={a}
                        opp={opp}
                        logoUrl={logoUrl}
                        ownerOptions={ownerOptions}
                        projects={projects}
                        visibleCols={visibleCols}
                        canEdit={canEdit}
                        isExpanded={isExpanded}
                        onToggleExpand={() => setExpandedId(isExpanded ? null : a.id)}
                        onSave={saveAward(a.id)}
                        onSaveOwner={async (ownerId) => {
                          if (!opp) return;
                          const ownerName =
                            ownerOptions.find((o) => o.value === ownerId)?.label ?? null;
                          await updateOpp.mutateAsync({
                            id: opp.Id,
                            patch: { OwnerId: ownerId },
                            displayPatch: { Owner: ownerName ? { Name: ownerName } : null } as Record<string, unknown>,
                          });
                        }}
                      />
                      {isExpanded ? (
                        <ExpandRow colSpan={visibleCols.length}>
                          <AwardExpandPanel award={a} />
                        </ExpandRow>
                      ) : null}
                    </Fragment>
                  );
                })}
                {paddingBottom > 0 && <tr aria-hidden style={{ height: paddingBottom }}><td colSpan={visibleCols.length} /></tr>}
              </>
            )}
          </tbody>
          {filtered.length > 0 && !awardsLoading && (
            <tfoot className="sticky bottom-0 z-10">
              <tr className="border-t border-border-strong bg-surface-2">
                {visibleCols.map((key, idx) => {
                  if (idx === 0) return <td key={key} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Totals</td>;
                  if (key === "amount") return <td key={key} className="mono px-3 py-2 text-[13px] font-semibold tabular-nums">{fmtMoney(totalAmount)}</td>;
                  if (key === "paid") return <td key={key} className="mono px-3 py-2 text-[13px] font-semibold tabular-nums text-green-700">{fmtMoney(totalPaid)}</td>;
                  if (key === "pending") return <td key={key} className="mono px-3 py-2 text-[13px] font-semibold tabular-nums text-amber-700">{fmtMoney(totalPending)}</td>;
                  return <td key={key} />;
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────

interface RowProps {
  a: Award;
  opp: SfOpportunity | undefined;
  logoUrl: string | null;
  ownerOptions: { value: string; label: string }[];
  projects: { id: string; name: string }[];
  visibleCols: ColKey[];
  canEdit: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onSaveOwner: (ownerId: string) => Promise<void>;
}

const AwardRow = memo(function AwardRow({
  a,
  opp,
  logoUrl,
  ownerOptions,
  projects,
  visibleCols,
  canEdit,
  isExpanded,
  onToggleExpand,
  onSave,
  onSaveOwner,
}: RowProps) {
  const account = opp?.Account?.Name ?? "—";
  const oppName = opp?.Name ?? a.opportunity_id;
  const ownerName = opp?.Owner?.Name ?? "—";
  const total = opp?.Amount ?? 0;
  const paid = opp?.npe01__Payments_Made__c ?? 0;
  const pending = pendingAmount(opp);

  const cells: Record<ColKey, React.ReactNode> = {
    name: (
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="flex-shrink-0 text-ink-4 transition-colors hover:text-ink-2"
          aria-label={isExpanded ? "Collapse details" : "Expand details"}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <AccountAvatar
          name={account === "—" ? oppName : account}
          logoUrl={logoUrl}
          size={20}
        />
        <Link
          to={`/awards/${a.id}`}
          state={AWARDS_REFERRER}
          className="flex min-w-0 flex-1 flex-col leading-tight"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate font-medium hover:underline" title={oppName}>{oppName}</span>
          <span className="truncate text-[11px] text-ink-3" title={account}>{account}</span>
        </Link>
      </div>
    ),
    owner: canEdit && opp ? (
      <InlineSelect
        value={opp.OwnerId ?? ""}
        options={ownerOptions}
        onSave={onSaveOwner}
        renderValue={(v) => (
          <span className="truncate text-[12.5px] text-ink-2">
            {opp.Owner?.Name ?? ownerOptions.find((o) => o.value === v)?.label ?? "—"}
          </span>
        )}
      />
    ) : (
      <span className="truncate text-[12.5px] text-ink-2" title={ownerName}>
        {ownerName}
      </span>
    ),
    status: canEdit ? (
      <InlineSelect
        value={a.award_status}
        options={STATUS_OPTIONS}
        onSave={(v) => onSave({ award_status: v })}
        renderValue={(v) => v ? <Tag variant={statusVariant(v as AwardStatus)}>{v}</Tag> : <Tag>—</Tag>}
      />
    ) : (
      <Tag variant={statusVariant(a.award_status)}>{a.award_status}</Tag>
    ),
    paymentBar: total > 0
      ? <PaymentBar paid={paid} total={total} />
      : <span className="text-[11px] text-ink-4">—</span>,
    paid: paid > 0
      ? <span className="mono text-[12px] font-medium text-green-700 tabular-nums">{fmtMoney(paid)}</span>
      : <span className="text-ink-4">—</span>,
    pending: pending > 0
      ? <span className="mono text-[12px] font-medium text-amber-700 tabular-nums">{fmtMoney(pending)}</span>
      : <span className="text-ink-4">—</span>,
    reporting: <ReportsProgress award={a} />,
    projects: projects.length === 0 ? (
      <span className="text-[11.5px] text-ink-4">—</span>
    ) : projects.length === 1 ? (
      <span className="truncate text-[12px] text-ink" title={projects[0].name}>
        {projects[0].name}
      </span>
    ) : (
      <span className="truncate text-[12px] text-ink" title={projects.map((p) => p.name).join(", ")}>
        {projects[0].name}
        <span className="ml-1 rounded bg-surface-2 px-1 text-[10.5px] text-ink-2">
          +{projects.length - 1}
        </span>
      </span>
    ),
    amount: total > 0 ? <span className="mono tabular-nums">{fmtMoney(total)}</span> : <span className="text-ink-4">—</span>,
    awardDate: <span className="mono text-[11.5px] text-ink-3">{fmtDate(a.award_date)}</span>,
  };

  const cellCls: Record<ColKey, string> = {
    name: "overflow-hidden px-3 py-1 text-[13px]",
    owner: "overflow-hidden px-3 py-1",
    status: "overflow-hidden px-3 py-1",
    amount: "mono cursor-pointer overflow-hidden truncate px-3 py-1 text-[12px] tabular-nums",
    paymentBar: "cursor-pointer overflow-hidden px-3 py-1",
    paid: "mono cursor-pointer overflow-hidden px-3 py-1 text-[12px]",
    pending: "mono cursor-pointer overflow-hidden px-3 py-1 text-[12px]",
    reporting: "cursor-pointer overflow-hidden px-3 py-1",
    projects: "cursor-pointer overflow-hidden px-3 py-1",
    awardDate: "mono cursor-pointer overflow-hidden truncate px-3 py-1 text-[11.5px] text-ink-3",
  };

  // Clicking these cells expands the row (the row's full detail is the expansion).
  const expandsOnClick = new Set<ColKey>([
    "amount", "paymentBar", "paid", "pending", "reporting", "projects", "awardDate",
  ]);

  return (
    <tr className="group/row border-b border-border-strong hover:bg-surface-2" style={{ height: ROW_HEIGHT }}>
      {visibleCols.map((key) => (
        <td
          key={key}
          className={cellCls[key]}
          onClick={expandsOnClick.has(key) ? onToggleExpand : undefined}
        >
          {cells[key]}
        </td>
      ))}
    </tr>
  );
});

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
