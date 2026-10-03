import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Search, X } from "lucide-react";

import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import { StageGateDialog } from "@/components/StageGateDialog";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import { fmtMoney } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { isOpen, isWon, SF_STAGE_OPTIONS, stageStatus } from "@/lib/stages";
import { useStageChangeGate } from "@/lib/useStageChangeGate";
import { searchMatcher } from "@/lib/search";
import { useAccounts } from "@/services/accounts";
import { useAwards, useUpdateAward, type AwardStatus } from "@/services/awards";
import {
  useOpportunities,
  useUpdateOpportunity,
  useUserTasks,
} from "@/services/opportunities";
import type { AccountStatus, SfOpportunity } from "@/types/salesforce";

// Record-type families surfaced as checkmarks on the Accounts tab so RMs
// can see at a glance which types of business they've already won with a
// given account. The canonical four mirror the cashflow bucket filter.
const RECORD_TYPE_BUCKETS = ["Philanthropy", "PBC", "Capital Grants", "Other"] as const;
type RecordTypeBucket = typeof RECORD_TYPE_BUCKETS[number];

/** Map an opp's RecordType.Name + Philanthropy_Type__c into one of the
 *  four buckets we show as checkmarks. Falls back to "Other". */
function recordTypeBucket(o: SfOpportunity): RecordTypeBucket {
  const rt = o.RecordType?.Name ?? "";
  const phType = o.Philanthropy_Type__c ?? "";
  if (phType === "Capital Grant") return "Capital Grants";
  if (rt === "Philanthropy") return "Philanthropy";
  if (rt === "PBC") return "PBC";
  return "Other";
}
export const OWNER_PANEL_HEIGHT = ROW_EXPAND_HEIGHT;

/**
 * Per-owner tabbed expand panel for the Dashboard's Individual Goals
 * table. Same RowExpandPanel pattern used elsewhere; tabs are lazy-
 * mounted so switching is what triggers each tab's queries.
 *
 * Tasks and Activity are owner-scoped via dedicated backend filters
 * (Task.OwnerId and bedrock.activity.owner_id respectively); the
 * other tabs filter from the already-cached list queries shared with
 * the Accounts / Pipeline / Awards pages.
 */
export function OwnerExpandPanel({ ownerId }: { ownerId: string }) {
  return (
    <RowExpandPanel
      tabs={[
        {
          id: "tasks",
          label: "Tasks",
          render: () => <OwnerTasks ownerId={ownerId} />,
        },
        {
          id: "accounts",
          label: "Accounts",
          render: () => <OwnerAccounts ownerId={ownerId} />,
        },
        {
          id: "opps",
          label: "Opportunities",
          render: () => <OwnerOpps ownerId={ownerId} />,
        },
        {
          id: "awards",
          label: "Awards",
          render: () => <OwnerAwards ownerId={ownerId} />,
        },
        {
          id: "activity",
          label: "Activity",
          render: () => (
            <ActivityTab
              filters={{ ownerId }}
              emptyMessage="No activity attributed to this owner yet."
            />
          ),
        },
      ]}
    />
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────

function OwnerTasks({ ownerId }: { ownerId: string }) {
  const { data: tasks = [], isLoading } = useUserTasks(ownerId);
  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      emptyMessage="No open tasks for this owner."
      contextResolver={(t) => t.WhatName ?? null}
    />
  );
}

// ── Accounts ─────────────────────────────────────────────────────────────

type AccountSortKey = "name" | "open" | "won";

function OwnerAccounts({ ownerId }: { ownerId: string }) {
  const { data: accounts = [], isLoading } = useAccounts();
  const { data: opps = [] } = useOpportunities();
  const [query, setQuery] = useState("");
  const { sort, toggle } = useSort<AccountSortKey>();

  type AccountRow = {
    id: string;
    name: string;
    status: AccountStatus | null;
    open: number;
    won: number;
    /** Record-type buckets the account has at least one won opp in. */
    types: Set<RecordTypeBucket>;
  };

  const rows = useMemo<AccountRow[]>(() => {
    const owned = accounts.filter((a) => a.OwnerId === ownerId);
    const accountIds = new Set(owned.map((a) => a.Id));
    const totals = new Map<string, { open: number; won: number; types: Set<RecordTypeBucket> }>();
    for (const o of opps) {
      if (!o.AccountId || !accountIds.has(o.AccountId)) continue;
      const cur = totals.get(o.AccountId) ?? { open: 0, won: 0, types: new Set<RecordTypeBucket>() };
      const amt = o.Amount ?? 0;
      if (isOpen(o)) cur.open += amt;
      else if (isWon(o)) {
        cur.won += amt;
        cur.types.add(recordTypeBucket(o));
      }
      totals.set(o.AccountId, cur);
    }
    return owned.map((a) => {
      const t = totals.get(a.Id);
      return {
        id: a.Id,
        name: a.Name,
        status: a.account_status ?? null,
        open: t?.open ?? 0,
        won: t?.won ?? 0,
        types: t?.types ?? new Set<RecordTypeBucket>(),
      };
    });
  }, [accounts, opps, ownerId]);

  const visible = useMemo(() => {
    const filtered = rows.filter(searchMatcher(rows, query, (r) => [r.name]));
    if (sort.key == null) return filtered.slice().sort((a, b) => b.open - a.open);
    return sortBy(filtered, sort, (r, key) => {
      switch (key) {
        case "name": return r.name;
        case "open": return r.open;
        case "won": return r.won;
      }
    });
  }, [rows, query, sort]);

  const totalOpen = rows.reduce((s, r) => s + r.open, 0);
  const totalWon = rows.reduce((s, r) => s + r.won, 0);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-wider text-ink-3">
        <span>{isLoading ? "…" : `${visible.length}${visible.length !== rows.length ? ` of ${rows.length}` : ""} account${rows.length === 1 ? "" : "s"}`}</span>
        <div className="flex items-center gap-3">
          {rows.length > 0 ? (
            <span className="mono normal-case">
              {fmtMoney(totalOpen)} open · {fmtMoney(totalWon)} won
            </span>
          ) : null}
          {rows.length > 0 ? <SearchBox value={query} onChange={setQuery} placeholder="Filter accounts…" /> : null}
        </div>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No accounts owned by this user.
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No accounts match.
        </div>
      ) : (
        <div>
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Name" sortKey="name" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  Status
                </th>
                <th className="px-3 py-1.5 text-center font-semibold" colSpan={RECORD_TYPE_BUCKETS.length}>
                  History
                </th>
                <th className="px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Open pipeline" sortKey="open" sort={sort} onToggle={toggle} align="right" />
                </th>
                <th className="px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Lifetime won" sortKey="won" sort={sort} onToggle={toggle} align="right" />
                </th>
              </tr>
              <tr>
                <th></th>
                <th></th>
                {RECORD_TYPE_BUCKETS.map((b) => (
                  <th
                    key={b}
                    className="px-1 pb-1 text-center text-[9.5px] font-medium normal-case text-ink-4"
                    title={b}
                  >
                    {b === "Capital Grants" ? "Cap." : b === "Philanthropy" ? "Phil." : b}
                  </th>
                ))}
                <th colSpan={2}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/accounts/${r.id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={r.name}
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">
                    {r.status ? (
                      <Tag variant={accountStatusVariant(r.status)}>{r.status}</Tag>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </td>
                  {RECORD_TYPE_BUCKETS.map((b) => (
                    <td key={b} className="px-1 py-1.5 text-center">
                      {r.types.has(b) ? (
                        <Check size={12} className="inline text-green" aria-label={`Won ${b}`} />
                      ) : (
                        <span className="text-ink-4">·</span>
                      )}
                    </td>
                  ))}
                  <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
                    {r.open > 0 ? fmtMoney(r.open) : "—"}
                  </td>
                  <td className="mono px-3 py-1.5 text-right tabular-nums text-ink-2">
                    {r.won > 0 ? fmtMoney(r.won) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (s: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search
        size={11}
        className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-ink-4"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-6 w-[160px] rounded border border-border-strong bg-surface pl-5 pr-5 text-[11.5px] normal-case outline-none focus:border-accent"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
          aria-label="Clear"
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

// ── Opportunities ────────────────────────────────────────────────────────

type OppSortKey = "name" | "stage" | "close" | "amount";

function OwnerOpps({ ownerId }: { ownerId: string }) {
  const { data: opps = [], isLoading } = useOpportunities();
  const [query, setQuery] = useState("");
  // Default: open opps only. Toggle expands to include closed (any age).
  const [showClosed, setShowClosed] = useState(false);
  const { sort, toggle } = useSort<OppSortKey>();
  const updateOpp = useUpdateOpportunity();
  const stageGate = useStageChangeGate();

  const ownedAll = useMemo(
    () => opps.filter((o) => o.OwnerId === ownerId),
    [opps, ownerId],
  );
  const ownedOpen = useMemo(() => ownedAll.filter(isOpen), [ownedAll]);
  const scope = showClosed ? ownedAll : ownedOpen;
  const hiddenClosed = ownedAll.length - ownedOpen.length;

  const totals = useMemo(() => {
    let open = 0;
    let won = 0;
    for (const o of ownedAll) {
      const amt = o.Amount ?? 0;
      if (isOpen(o)) open += amt;
      else if (isWon(o)) won += amt;
    }
    return { open, won };
  }, [ownedAll]);

  // Default order: soonest close date first; opps with no close date
  // sink to the bottom. Once the user clicks a column header, that
  // sort takes over.
  const visible = useMemo(() => {
    const filtered = scope.filter(
      searchMatcher(scope, query, (o) => [o.Name, o.Account?.Name, o.StageName]),
    );
    if (sort.key == null) {
      return filtered.slice().sort((a, b) => {
        // Within scope, open at the top (sorted by close date asc),
        // then closed (sorted by close date desc — most recent first).
        const aOpen = isOpen(a) ? 0 : 1;
        const bOpen = isOpen(b) ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        if (!a.CloseDate) return 1;
        if (!b.CloseDate) return -1;
        if (aOpen === 0) return a.CloseDate.localeCompare(b.CloseDate); // open: ASC
        return b.CloseDate.localeCompare(a.CloseDate); // closed: DESC
      });
    }
    return sortBy(filtered, sort, (o, key) => {
      switch (key) {
        case "name": return o.Name ?? "";
        case "stage": return o.StageName ?? "";
        case "close": return o.CloseDate ?? "";
        case "amount": return o.Amount ?? 0;
      }
    });
  }, [scope, query, sort]);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading
            ? "…"
            : `${visible.length}${visible.length !== scope.length ? ` of ${scope.length}` : ""} ${showClosed ? "" : "open "}opportunit${scope.length === 1 ? "y" : "ies"}`}
          {!showClosed && hiddenClosed > 0 ? (
            <button
              type="button"
              onClick={() => setShowClosed(true)}
              className="ml-1.5 normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              +{hiddenClosed} closed
            </button>
          ) : showClosed && hiddenClosed > 0 ? (
            <button
              type="button"
              onClick={() => setShowClosed(false)}
              className="ml-1.5 normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              open only
            </button>
          ) : null}
        </span>
        <div className="flex items-center gap-3">
          {ownedAll.length > 0 ? (
            <span className="mono normal-case">
              {fmtMoney(totals.open)} open · {fmtMoney(totals.won)} won
            </span>
          ) : null}
          {ownedAll.length > 0 ? <SearchBox value={query} onChange={setQuery} placeholder="Filter opps…" /> : null}
        </div>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : scope.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          {showClosed
            ? "No opportunities owned by this user."
            : "No open opportunities owned by this user."}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No opportunities match.
        </div>
      ) : (
        <div>
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Name" sortKey="name" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Stage" sortKey="stage" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Close" sortKey="close" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Amount" sortKey="amount" sort={sort} onToggle={toggle} align="right" />
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.Id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/opportunities/${o.Id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={o.Name}
                    >
                      {o.Name}
                    </Link>
                    {o.Account?.Name ? (
                      <span className="block truncate text-[10.5px] text-ink-3">
                        {o.Account.Name}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">
                    <InlineSelect
                      value={o.StageName}
                      options={SF_STAGE_OPTIONS}
                      onSave={(stage) => stageGate.request(o, stage)}
                      renderValue={(v) =>
                        v ? (
                          <StageChip stage={v} status={stageStatus(o)} />
                        ) : (
                          <span className="text-ink-4">—</span>
                        )
                      }
                    />
                  </td>
                  <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                    <InlineDate
                      value={o.CloseDate}
                      onSave={(d) =>
                        Promise.resolve(
                          updateOpp.mutate({ id: o.Id, patch: { CloseDate: d } }),
                        )
                      }
                      placeholder="—"
                    />
                  </td>
                  <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
                    <InlineText
                      value={o.Amount != null ? String(o.Amount) : ""}
                      onSave={(v) =>
                        Promise.resolve(
                          updateOpp.mutate({
                            id: o.Id,
                            patch: { Amount: v ? Number(v.replace(/[^\d.-]/g, "")) : null },
                          }),
                        )
                      }
                      formatDisplay={(raw) => {
                        const n = Number(raw.replace(/[^\d.-]/g, ""));
                        return Number.isFinite(n) && n !== 0 ? fmtMoney(n) : "—";
                      }}
                      placeholder="—"
                      className="justify-end text-right"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    </div>
  );
}

// ── Awards ──────────────────────────────────────────────────────────────

function statusVariant(s: AwardStatus): "green" | "amber" | "default" | "red" {
  if (s === "Active") return "green";
  if (s === "Closing") return "amber";
  if (s === "Did Not Fulfill") return "red";
  return "default";
}

const AWARD_STATUS_ORDER: Record<AwardStatus, number> = {
  Active: 0,
  Closing: 1,
  Closed: 2,
  "Did Not Fulfill": 3,
};

type AwardSortKey = "name" | "status" | "awarded" | "total" | "collected" | "pending";

const AWARD_STATUS_OPTIONS = [
  { value: "Active", label: "Active" },
  { value: "Closing", label: "Closing" },
  { value: "Closed", label: "Closed" },
  { value: "Did Not Fulfill", label: "Did Not Fulfill" },
];

function OwnerAwards({ ownerId }: { ownerId: string }) {
  const { data: opps = [] } = useOpportunities();
  const { data: awards = [], isLoading } = useAwards();
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const { sort, toggle } = useSort<AwardSortKey>();
  const updateAward = useUpdateAward();

  const rows = useMemo(() => {
    const ownedOppIds = new Set(
      opps.filter((o) => o.OwnerId === ownerId).map((o) => o.Id),
    );
    const oppById = new Map(opps.map((o) => [o.Id, o] as const));
    return awards
      .filter((a) => ownedOppIds.has(a.opportunity_id))
      .map((a) => ({ award: a, opp: oppById.get(a.opportunity_id) ?? null }))
      .sort(
        (x, y) =>
          (AWARD_STATUS_ORDER[x.award.award_status] ?? 99) -
          (AWARD_STATUS_ORDER[y.award.award_status] ?? 99),
      );
  }, [awards, opps, ownerId]);

  const activeRows = useMemo(
    () => rows.filter((r) => r.award.award_status === "Active"),
    [rows],
  );
  const scope = showAll ? rows : activeRows;
  const hiddenCount = rows.length - activeRows.length;

  const displayed = useMemo(() => {
    const filtered = scope.filter(
      searchMatcher(scope, query, ({ award, opp }) => [
        opp?.Name,
        opp?.Account?.Name,
        award.award_status,
      ]),
    );
    if (sort.key == null) return filtered;
    return sortBy(filtered, sort, ({ award, opp }, key) => {
      const total = opp?.Amount ?? 0;
      const collected = opp?.npe01__Payments_Made__c ?? 0;
      switch (key) {
        case "name": return opp?.Name ?? award.opportunity_id;
        case "status": return award.award_status;
        case "awarded": return award.award_date ?? "";
        case "total": return total;
        case "collected": return collected;
        case "pending": return Math.max(0, total - collected);
      }
    });
  }, [scope, query, sort]);

  const totals = useMemo(() => {
    let total = 0;
    let collected = 0;
    for (const { opp } of rows) {
      total += opp?.Amount ?? 0;
      collected += opp?.npe01__Payments_Made__c ?? 0;
    }
    return { total, collected, pending: Math.max(0, total - collected) };
  }, [rows]);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading
            ? "…"
            : showAll
              ? `${displayed.length}${displayed.length !== rows.length ? ` of ${rows.length}` : ""} award${rows.length === 1 ? "" : "s"}`
              : `${displayed.length}${displayed.length !== activeRows.length ? ` of ${activeRows.length}` : ""} active award${activeRows.length === 1 ? "" : "s"}`}
          {!showAll && hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="ml-1.5 normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              +{hiddenCount} more
            </button>
          ) : showAll && hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="ml-1.5 normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              active only
            </button>
          ) : null}
        </span>
        <div className="flex items-center gap-3">
          {rows.length > 0 ? (
            <span className="mono normal-case">
              {fmtMoney(totals.total)} total · {fmtMoney(totals.collected)} collected · {fmtMoney(totals.pending)} pending
            </span>
          ) : null}
          {rows.length > 0 ? <SearchBox value={query} onChange={setQuery} placeholder="Filter awards…" /> : null}
        </div>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No awards owned by this user.
        </div>
      ) : (
        <div>
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Name" sortKey="name" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Awarded" sortKey="awarded" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Total" sortKey="total" sort={sort} onToggle={toggle} align="right" />
                </th>
                <th className="px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Collected" sortKey="collected" sort={sort} onToggle={toggle} align="right" />
                </th>
                <th className="px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Pending" sortKey="pending" sort={sort} onToggle={toggle} align="right" />
                </th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(({ award, opp }) => {
                const total = opp?.Amount ?? 0;
                const collected = opp?.npe01__Payments_Made__c ?? 0;
                const pending = Math.max(0, total - collected);
                return (
                <tr key={award.id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/awards/${award.id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={opp?.Name ?? award.opportunity_id}
                    >
                      {opp?.Name ?? award.opportunity_id}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">
                    <InlineSelect
                      value={award.award_status}
                      options={AWARD_STATUS_OPTIONS}
                      onSave={(v) =>
                        Promise.resolve(
                          updateAward.mutate({
                            id: award.id,
                            patch: { award_status: v as AwardStatus },
                          }),
                        )
                      }
                      renderValue={(v) =>
                        v ? (
                          <Tag variant={statusVariant(v as AwardStatus)}>{v}</Tag>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )
                      }
                    />
                  </td>
                  <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                    <InlineDate
                      value={award.award_date}
                      onSave={(d) =>
                        Promise.resolve(
                          updateAward.mutate({ id: award.id, patch: { award_date: d } }),
                        )
                      }
                      placeholder="—"
                    />
                  </td>
                  <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
                    {total > 0 ? fmtMoney(total) : "—"}
                  </td>
                  <td className="mono px-3 py-1.5 text-right tabular-nums text-green">
                    {collected > 0 ? fmtMoney(collected) : "—"}
                  </td>
                  <td className="mono px-3 py-1.5 text-right tabular-nums text-ink-2">
                    {pending > 0 ? fmtMoney(pending) : "—"}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
