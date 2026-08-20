/**
 * Portfolio · Awards table.
 *
 * Inline-editable top row (status / award date / period end) with
 * row-click expand to {@link AwardExpandPanel} (reports/payments/tasks/projects).
 * Award reports are the most common "overdue" surface, so we badge the
 * row with the report_overdue count and let users drill into Reports
 * tab inside the expand for the actual editing of report rows.
 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { AwardExpandPanel } from "@/components/AwardExpandPanel";
import { ExpandRow } from "@/components/ui/ExpandRow";
import { SectionCard, withReferrer } from "@/components/detail";
import { Tag } from "@/components/ui/Tag";
import { InlineDate, InlineSelect } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { fmtDate, fmtMoney } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { useUpdateAward, type Award, type AwardStatus } from "@/services/awards";
import type { SfOpportunity } from "@/types/salesforce";

import { TableToolbar } from "./TableToolbar";

type AwardSortKey = "name" | "status" | "amount" | "awarded" | "periodEnd" | "reports";
type AwardFilter = "all" | "Active" | "Closing" | "Closed" | "Did Not Fulfill";

const AWARD_STATUS_OPTIONS: { value: AwardStatus; label: string }[] = [
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

interface PortfolioAwardsProps {
  awards: Award[];
  oppsById: Map<string, SfOpportunity>;
  loading: boolean;
  canEdit: boolean;
}

export function PortfolioAwards({ awards, oppsById, loading, canEdit }: PortfolioAwardsProps) {
  const updateAward = useUpdateAward();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AwardFilter>("Active");
  const { sort, toggle } = useSort<AwardSortKey>();

  const counts = useMemo(() => {
    let active = 0, closing = 0, closed = 0, dnf = 0;
    for (const a of awards) {
      if (a.award_status === "Active") active++;
      else if (a.award_status === "Closing") closing++;
      else if (a.award_status === "Closed") closed++;
      else dnf++;
    }
    return { all: awards.length, active, closing, closed, dnf };
  }, [awards]);

  const overdueReports = useMemo(
    () => awards.reduce((sum, a) => sum + (a.report_overdue ?? 0), 0),
    [awards],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = awards.filter((a) => {
      if (statusFilter !== "all" && a.award_status !== statusFilter) return false;
      if (!q) return true;
      const opp = oppsById.get(a.opportunity_id);
      if (opp?.Name?.toLowerCase().includes(q)) return true;
      if (opp?.Account?.Name?.toLowerCase().includes(q)) return true;
      if (a.award_status.toLowerCase().includes(q)) return true;
      return false;
    });
    if (sort.key == null) return sortAwards(filtered);
    return sortBy(filtered, sort, (a, key) => {
      const opp = oppsById.get(a.opportunity_id);
      switch (key) {
        case "name": return opp?.Name ?? a.opportunity_id;
        case "status": return a.award_status;
        case "amount": return opp?.Amount ?? 0;
        case "awarded": return a.award_date ?? "";
        case "periodEnd": return a.period_end_date ?? "";
        case "reports": return a.report_overdue ?? 0;
      }
    });
  }, [awards, query, statusFilter, sort, oppsById]);

  return (
    <SectionCard
      title={`Awards (${visible.length}${visible.length !== awards.length ? ` of ${awards.length}` : ""})`}
      storageScope="portfolio"
      action={
        <div className="flex items-center gap-3">
          {overdueReports > 0 ? (
            <span className="text-[11.5px] font-semibold text-red">
              {overdueReports} report{overdueReports === 1 ? "" : "s"} overdue
            </span>
          ) : null}
          {awards.length > 0 ? (
            <TableToolbar<AwardFilter>
              query={query}
              onQueryChange={setQuery}
              filter={{
                value: statusFilter,
                options: [
                  { value: "all", label: "All", count: counts.all },
                  { value: "Active", label: "Active", count: counts.active },
                  { value: "Closing", label: "Closing", count: counts.closing },
                  { value: "Closed", label: "Closed", count: counts.closed },
                ],
                onChange: setStatusFilter,
              }}
              placeholder="Search awards…"
            />
          ) : null}
        </div>
      }
    >
      {loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : awards.length === 0 ? (
        <EmptyState>No awards under this user's opportunities.</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No awards match your filters.</EmptyState>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-[28px] px-3 py-1.5"></th>
              <th className="px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Award" sortKey="name" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[140px] px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[110px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Amount" sortKey="amount" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Awarded" sortKey="awarded" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Period end" sortKey="periodEnd" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[100px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Reports" sortKey="reports" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[40px] px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const opp = oppsById.get(a.opportunity_id);
              const isExpanded = a.id === expandedId;
              const reportsBehind = a.report_overdue ?? 0;
              return (
                <Fragment key={a.id}>
                  <tr
                    className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
                    onClick={() => setExpandedId(isExpanded ? null : a.id)}
                  >
                    <td className="px-3 py-1.5 align-middle">
                      {isExpanded ? (
                        <ChevronDown size={12} className="text-ink-3" />
                      ) : (
                        <ChevronRight size={12} className="text-ink-3" />
                      )}
                    </td>
                    <td className="px-3 py-1.5 align-middle">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">
                            {opp?.Name ?? a.opportunity_id}
                          </span>
                          {opp?.Account?.Name ? (
                            <span className="block truncate text-[11px] text-ink-3">
                              {opp.Account.Name}
                            </span>
                          ) : null}
                        </div>
                        {reportsBehind > 0 ? (
                          <Tag variant="red">{reportsBehind} late</Tag>
                        ) : null}
                        <Link
                          to={`/awards/${a.id}`}
                          state={withReferrer({ pathname: "/portfolio", label: "Portfolio" })}
                          className="flex-shrink-0 text-ink-4 hover:text-accent"
                          onClick={(e) => e.stopPropagation()}
                          title="Open award detail"
                        >
                          <ExternalLink size={12} />
                        </Link>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
                      {canEdit ? (
                        <InlineSelect
                          value={a.award_status}
                          options={AWARD_STATUS_OPTIONS}
                          onSave={(status) =>
                            Promise.resolve(
                              updateAward.mutate({ id: a.id, patch: { award_status: status as AwardStatus } }),
                            )
                          }
                          renderValue={(v) =>
                            v ? <Tag variant={statusVariant(v as AwardStatus)}>{v}</Tag> : null
                          }
                        />
                      ) : (
                        <Tag variant={statusVariant(a.award_status)}>{a.award_status}</Tag>
                      )}
                    </td>
                    <td className="mono px-3 py-1.5 text-right align-middle tabular-nums">
                      {opp?.Amount ? fmtMoney(opp.Amount) : "—"}
                    </td>
                    <td className="mono px-3 py-1.5 text-right align-middle tabular-nums text-ink-2">
                      {/* award_date is system-managed (set at award creation
                          time from opp.CloseDate). Display-only here; edit
                          via the underlying opp if it needs adjustment. */}
                      <span>{fmtDate(a.award_date)}</span>
                    </td>
                    <td
                      className="mono px-3 py-1.5 text-right align-middle tabular-nums text-ink-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canEdit ? (
                        <InlineDate
                          value={a.period_end_date}
                          onSave={(d) =>
                            Promise.resolve(
                              updateAward.mutate({ id: a.id, patch: { period_end_date: d } }),
                            )
                          }
                          align="right"
                          placeholder="—"
                        />
                      ) : (
                        <span>{fmtDate(a.period_end_date)}</span>
                      )}
                    </td>
                    <td className="mono px-3 py-1.5 text-right align-middle tabular-nums">
                      {a.report_total > 0 ? (
                        <span className={reportsBehind > 0 ? "font-semibold text-red" : "text-ink-2"}>
                          {a.report_done}/{a.report_total}
                        </span>
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 align-middle text-right text-ink-4"></td>
                  </tr>
                  {isExpanded ? (
                    <ExpandRow colSpan={8}>
                      <AwardExpandPanel award={a} />
                    </ExpandRow>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

const STATUS_RANK: Record<AwardStatus, number> = {
  Active: 0,
  Closing: 1,
  Closed: 2,
  "Did Not Fulfill": 3,
};

function sortAwards(awards: Award[]): Award[] {
  return [...awards].sort((a, b) => {
    const rsa = STATUS_RANK[a.award_status] ?? 9;
    const rsb = STATUS_RANK[b.award_status] ?? 9;
    if (rsa !== rsb) return rsa - rsb;
    const oa = a.report_overdue ?? 0;
    const ob = b.report_overdue ?? 0;
    if (oa !== ob) return ob - oa;
    if (!a.award_date && !b.award_date) return 0;
    if (!a.award_date) return 1;
    if (!b.award_date) return -1;
    return b.award_date.localeCompare(a.award_date);
  });
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}
