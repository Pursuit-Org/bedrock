/**
 * Portfolio · Opportunities table.
 *
 * Inline-editable Pipeline-style row (name / stage / amount / close /
 * probability) with row-click expand to {@link OpportunityExpandPanel}.
 *
 * Stage changes go through {@link useUpdateOpportunityStage} (which does
 * the SF validate + award auto-create handshake), other fields through
 * the generic {@link useUpdateOpportunity}. This mirrors Pipeline.tsx so
 * a mutation here keeps every other surface in sync via React Query.
 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { AwardSetupDialog } from "@/components/AwardSetupDialog";
import { OpportunityExpandPanel } from "@/components/OpportunityExpandPanel";
import { ExpandRow } from "@/components/ui/ExpandRow";
import { PaymentScheduleBuilder } from "@/components/PaymentScheduleBuilder";
import { StageGateDialog } from "@/components/StageGateDialog";
import { SectionCard, withReferrer } from "@/components/detail";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { fmtDate, fmtMoney } from "@/lib/format";
import { riskForOpenOpp, riskTextClass } from "@/lib/risk";
import { sortBy, useSort } from "@/lib/sort";
import { isLost, isOpen, isWon, SF_STAGE_OPTIONS, stageStatus } from "@/lib/stages";
import { useProbabilityScheduleGate } from "@/lib/useProbabilityScheduleGate";
import { useStageChangeGate } from "@/lib/useStageChangeGate";
import { useUpdateOpportunity } from "@/services/opportunities";
import type { SfOpportunity } from "@/types/salesforce";

import { TableToolbar } from "./TableToolbar";

type OppSortKey = "name" | "stage" | "amount" | "probability" | "close";
type OppFilter = "all" | "open" | "won" | "lost";

interface PortfolioOpportunitiesProps {
  opps: SfOpportunity[];
  loading: boolean;
  sfReady: boolean;
  canEdit: boolean;
}

export function PortfolioOpportunities({
  opps,
  loading,
  sfReady,
  canEdit,
}: PortfolioOpportunitiesProps) {
  const updateOpp = useUpdateOpportunity();
  const stageGate = useStageChangeGate();
  const probGate = useProbabilityScheduleGate();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<OppFilter>("open");
  // One-click "High priority only" toggle. Sits next to the Open/Won/
  // Lost pill so a user can quickly narrow their portfolio to what
  // needs attention now. Stacks AND with the other filters.
  const [highPriorityOnly, setHighPriorityOnly] = useState(false);
  const { sort, toggle } = useSort<OppSortKey>();

  const highPriorityCount = useMemo(
    () => opps.filter((o) => (o.Priority__c ?? "") === "High").length,
    [opps],
  );

  const counts = useMemo(() => {
    let open = 0, won = 0, lost = 0;
    for (const o of opps) {
      if (isOpen(o)) open++;
      else if (isWon(o)) won++;
      else lost++;
    }
    return { open, won, lost, all: opps.length };
  }, [opps]);

  const atRiskCount = useMemo(
    () =>
      opps.filter((o) => isOpen(o) && riskForOpenOpp(o.CloseDate) === "overdue").length,
    [opps],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = opps.filter((o) => {
      if (statusFilter === "open" && !isOpen(o)) return false;
      if (statusFilter === "won" && !isWon(o)) return false;
      if (statusFilter === "lost" && !isLost(o)) return false;
      if (highPriorityOnly && (o.Priority__c ?? "") !== "High") return false;
      if (!q) return true;
      if (o.Name?.toLowerCase().includes(q)) return true;
      if (o.Account?.Name?.toLowerCase().includes(q)) return true;
      if (o.StageName?.toLowerCase().includes(q)) return true;
      return false;
    });
    if (sort.key == null) return sortOpps(filtered);
    return sortBy(filtered, sort, (o, key) => {
      switch (key) {
        case "name": return o.Name ?? "";
        case "stage": return o.StageName ?? "";
        case "amount": return o.Amount ?? 0;
        case "probability": return o.Manager_Probability_Override__c ?? o.Probability ?? 0;
        case "close": return o.CloseDate ?? "";
      }
    });
  }, [opps, query, statusFilter, highPriorityOnly, sort]);

  return (
    <>
    <SectionCard
      title={`Opportunities (${visible.length}${visible.length !== opps.length ? ` of ${opps.length}` : ""})`}
      storageScope="portfolio"
      action={
        <div className="flex items-center gap-3">
          {atRiskCount > 0 ? (
            <span className="text-[11.5px] font-semibold text-red">
              {atRiskCount} past close
            </span>
          ) : null}
          {opps.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setHighPriorityOnly((v) => !v)}
                aria-pressed={highPriorityOnly}
                className={
                  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12px] font-medium transition-colors " +
                  (highPriorityOnly
                    ? "border-red bg-red-soft text-red"
                    : "border-border-strong bg-surface text-ink-3 hover:bg-surface-2")
                }
                title={
                  highPriorityOnly
                    ? "Showing High priority only — click to clear"
                    : "Show only opps with Priority = High"
                }
              >
                <span
                  aria-hidden
                  className={
                    "inline-block h-1.5 w-1.5 rounded-full " +
                    (highPriorityOnly ? "bg-red" : "bg-ink-3/60")
                  }
                />
                High priority{highPriorityCount > 0 ? ` (${highPriorityCount})` : ""}
              </button>
              <TableToolbar<OppFilter>
                query={query}
                onQueryChange={setQuery}
                filter={{
                  value: statusFilter,
                  options: [
                    { value: "all", label: "All", count: counts.all },
                    { value: "open", label: "Open", count: counts.open },
                    { value: "won", label: "Won", count: counts.won },
                    { value: "lost", label: "Lost", count: counts.lost },
                  ],
                  onChange: setStatusFilter,
                }}
                placeholder="Search opportunities…"
              />
            </>
          ) : null}
        </div>
      }
    >
      {!sfReady ? (
        <EmptyState>Connect Salesforce to see opportunity ownership.</EmptyState>
      ) : loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : opps.length === 0 ? (
        <EmptyState>No opportunities owned by this user.</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No opportunities match your filters.</EmptyState>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-[28px] px-3 py-1.5"></th>
              <th className="px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Opportunity" sortKey="name" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[160px] px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Stage" sortKey="stage" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[110px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Amount" sortKey="amount" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[80px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Prob." sortKey="probability" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Close" sortKey="close" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[40px] px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => {
              const isExpanded = o.Id === expandedId;
              const open = isOpen(o);
              const risk = open ? riskForOpenOpp(o.CloseDate) : "none";
              return (
                <Fragment key={o.Id}>
                  <tr
                    className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
                    onClick={() => setExpandedId(isExpanded ? null : o.Id)}
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
                          {canEdit ? (
                            <InlineText
                              value={o.Name}
                              onSave={(name) =>
                                Promise.resolve(
                                  updateOpp.mutate({ id: o.Id, patch: { Name: name } }),
                                )
                              }
                              className="text-[13px] font-medium"
                            />
                          ) : (
                            <span className="block truncate text-[13px] font-medium">
                              {o.Name}
                            </span>
                          )}
                          {o.Account?.Name ? (
                            <span className="block truncate text-[11px] text-ink-3">
                              {o.Account.Name}
                            </span>
                          ) : null}
                        </div>
                        {risk === "overdue" ? (
                          <Tag variant="red">past due</Tag>
                        ) : risk === "due-soon" ? (
                          <Tag variant="amber">due soon</Tag>
                        ) : null}
                        <Link
                          to={`/opportunities/${o.Id}`}
                          state={withReferrer({ pathname: "/portfolio", label: "Portfolio" })}
                          className="flex-shrink-0 text-ink-4 hover:text-accent"
                          onClick={(e) => e.stopPropagation()}
                          title="Open opportunity detail"
                        >
                          <ExternalLink size={12} />
                        </Link>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 align-middle">
                      {canEdit ? (
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
                      ) : o.StageName ? (
                        <StageChip stage={o.StageName} status={stageStatus(o)} />
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>
                    <td
                      className={
                        "mono px-3 py-1.5 text-right align-middle tabular-nums " +
                        (isWon(o) ? "font-semibold text-green" : "")
                      }
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canEdit ? (
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
                      ) : (
                        <span>{o.Amount != null ? fmtMoney(o.Amount) : "—"}</span>
                      )}
                    </td>
                    <td
                      className="mono px-3 py-1.5 text-right align-middle tabular-nums text-ink-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canEdit ? (
                        <InlineText
                          value={
                            o.Manager_Probability_Override__c != null
                              ? String(o.Manager_Probability_Override__c)
                              : o.Probability != null
                                ? String(o.Probability)
                                : ""
                          }
                          onSave={async (v) => {
                            const n = v ? Number(v.replace(/[^\d.-]/g, "")) : null;
                            // Block 0 → >0 raises that don't have a
                            // payment schedule yet — opens the builder,
                            // rejection here reverts the optimistic.
                            await probGate.request(o, n);
                            // Mirror SF's UI: co-write Probability with the
                            // override when set. Clearing falls back to SF.
                            const patch: Record<string, unknown> = { Manager_Probability_Override__c: n };
                            if (n != null) patch.Probability = n;
                            await updateOpp.mutateAsync({ id: o.Id, patch });
                          }}
                          formatDisplay={(raw) => {
                            const n = Number(raw.replace(/[^\d.-]/g, ""));
                            return Number.isFinite(n) ? `${n}%` : "—";
                          }}
                          placeholder="—"
                          className="justify-end text-right"
                        />
                      ) : (
                        <span>
                          {(o.Manager_Probability_Override__c ?? o.Probability) != null
                            ? `${o.Manager_Probability_Override__c ?? o.Probability}%`
                            : "—"}
                        </span>
                      )}
                    </td>
                    <td
                      className={
                        "mono px-3 py-1.5 text-right align-middle tabular-nums " +
                        riskTextClass(risk)
                      }
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canEdit ? (
                        <InlineDate
                          value={o.CloseDate}
                          onSave={(d) =>
                            Promise.resolve(
                              updateOpp.mutate({ id: o.Id, patch: { CloseDate: d } }),
                            )
                          }
                          align="right"
                          placeholder="—"
                        />
                      ) : (
                        <span>{fmtDate(o.CloseDate)}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 align-middle text-right text-ink-4"></td>
                  </tr>
                  {isExpanded ? (
                    <ExpandRow colSpan={7}>
                      <OpportunityExpandPanel
                        opportunityId={o.Id}
                        oppAmount={o.Amount ?? null}
                        oppCloseDate={o.CloseDate ?? null}
                      />
                    </ExpandRow>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-strong bg-surface-2/60">
              <td colSpan={2} className="px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-ink-3">
                {counts.open} open
              </td>
              <td colSpan={5} className="px-3 py-1.5 text-right text-[11.5px] text-ink-3">
                Click a row to expand
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </SectionCard>
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
    </>
  );
}

/** Sort: open by close-date ascending (overdue surfaces first), then
 *  won, then lost. Missing dates sink to the bottom of their bucket. */
function sortOpps(opps: SfOpportunity[]): SfOpportunity[] {
  const buckets = { open: [] as SfOpportunity[], won: [] as SfOpportunity[], other: [] as SfOpportunity[] };
  for (const o of opps) {
    if (isOpen(o)) buckets.open.push(o);
    else if (isWon(o)) buckets.won.push(o);
    else buckets.other.push(o);
  }
  const byClose = (a: SfOpportunity, b: SfOpportunity) => {
    if (!a.CloseDate) return 1;
    if (!b.CloseDate) return -1;
    return a.CloseDate.localeCompare(b.CloseDate);
  };
  buckets.open.sort(byClose);
  buckets.won.sort((a, b) => byClose(b, a)); // most-recent wins first
  buckets.other.sort((a, b) => byClose(b, a));
  return [...buckets.open, ...buckets.won, ...buckets.other];
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}
