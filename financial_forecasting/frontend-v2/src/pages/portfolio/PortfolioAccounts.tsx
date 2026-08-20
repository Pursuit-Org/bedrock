/**
 * Portfolio · Accounts table.
 *
 * Compact table of the user's accounts, with chevron-to-expand rows that
 * mount the existing {@link AccountExpandPanel} (tasks/opps/awards/activity).
 * Top-level fields are inline-editable via the same hooks the global
 * Accounts page uses, so a change here propagates everywhere through
 * React Query cache.
 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { AccountExpandPanel } from "@/components/AccountExpandPanel";
import { ExpandRow } from "@/components/ui/ExpandRow";
import { SectionCard, withReferrer } from "@/components/detail";
import { InlineText } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import { fmtMoney } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { isOpen, isWon } from "@/lib/stages";
import { useAccountsEnrichment, useUpdateAccount } from "@/services/accounts";
import { useOpportunities } from "@/services/opportunities";
import type { SfAccount, SfOpportunity } from "@/types/salesforce";

import { TableToolbar } from "./TableToolbar";

type AccountSortKey = "name" | "type" | "openPipeline" | "amountWon";

interface PortfolioAccountsProps {
  accounts: SfAccount[];
  loading: boolean;
  sfReady: boolean;
  canEdit: boolean;
}

interface AccountMetrics {
  openPipeline: number;
  amountWon: number;
}

export function PortfolioAccounts({ accounts, loading, sfReady, canEdit }: PortfolioAccountsProps) {
  const oppsQ = useOpportunities();
  const updateAccount = useUpdateAccount();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { sort, toggle } = useSort<AccountSortKey>();

  // Enrichment fetches account logos in bulk. Keyed on the displayed
  // accounts so we don't request logos for the whole org.
  const enrichmentQ = useAccountsEnrichment(accounts.map((a) => a.Id));

  const metrics = useMemo(
    () => computeMetrics(accounts, oppsQ.data ?? []),
    [accounts, oppsQ.data],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = accounts.filter((a) => {
      if (!q) return true;
      if (a.Name.toLowerCase().includes(q)) return true;
      if ((a.Type ?? "").toLowerCase().includes(q)) return true;
      return false;
    });
    return sortBy(filtered, sort, (a, key) => {
      switch (key) {
        case "name": return a.Name;
        case "type": return a.Type ?? "";
        case "openPipeline": return metrics.get(a.Id)?.openPipeline ?? 0;
        case "amountWon": return metrics.get(a.Id)?.amountWon ?? 0;
      }
    });
  }, [accounts, query, sort, metrics]);

  return (
    <SectionCard
      title={`Accounts (${visible.length}${visible.length !== accounts.length ? ` of ${accounts.length}` : ""})`}
      storageScope="portfolio"
      action={
        accounts.length > 0 ? (
          <TableToolbar
            query={query}
            onQueryChange={setQuery}
            placeholder="Search accounts…"
          />
        ) : null
      }
    >
      {!sfReady ? (
        <EmptyState>Connect Salesforce to see account ownership.</EmptyState>
      ) : loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : accounts.length === 0 ? (
        <EmptyState>No accounts owned by this user.</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No accounts match your filters.</EmptyState>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-[28px] px-3 py-1.5"></th>
              <th className="px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Account" sortKey="name" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Type" sortKey="type" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-left font-semibold">
                Status
              </th>
              <th className="w-[120px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Open pipeline" sortKey="openPipeline" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-right font-semibold">
                <SortableHeader label="Won (FY)" sortKey="amountWon" sort={sort} onToggle={toggle} align="right" />
              </th>
              <th className="w-[40px] px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const m = metrics.get(a.Id) ?? { openPipeline: 0, amountWon: 0 };
              const isExpanded = a.Id === expandedId;
              const logoUrl = enrichmentQ.data?.[a.Id]?.logo_url ?? null;
              return (
                <Fragment key={a.Id}>
                  <tr
                    className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
                    onClick={() => setExpandedId(isExpanded ? null : a.Id)}
                  >
                    <td className="px-3 py-1.5 align-middle">
                      {isExpanded ? (
                        <ChevronDown size={12} className="text-ink-3" />
                      ) : (
                        <ChevronRight size={12} className="text-ink-3" />
                      )}
                    </td>
                    <td className="px-3 py-1.5 align-middle">
                      <div className="flex items-center gap-2.5">
                        <AccountAvatar name={a.Name} logoUrl={logoUrl} size={18} />
                        <div className="min-w-0 flex-1">
                          {canEdit ? (
                            <InlineText
                              value={a.Name}
                              onSave={(name) =>
                                Promise.resolve(
                                  updateAccount.mutate({ id: a.Id, patch: { Name: name } }),
                                )
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
                    <td className="px-3 py-1.5 align-middle text-[12px] text-ink-2">
                      {a.Type ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 align-middle">
                      {a.account_status ? (
                        <Tag variant={accountStatusVariant(a.account_status)}>{a.account_status}</Tag>
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>
                    <td className="mono px-3 py-1.5 text-right align-middle tabular-nums">
                      {fmtMoney(m.openPipeline)}
                    </td>
                    <td className="mono px-3 py-1.5 text-right align-middle tabular-nums">
                      {fmtMoney(m.amountWon)}
                    </td>
                    <td className="px-3 py-1.5 text-right align-middle text-ink-4">
                      {/* Right-most affordance spacer */}
                    </td>
                  </tr>
                  {isExpanded ? (
                    <ExpandRow colSpan={7}>
                      <AccountExpandPanel accountId={a.Id} />
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

/**
 * Aggregate open pipeline + amount-won for each account based on its
 * child opportunities. Pure: a re-render with the same inputs returns
 * a cached map.
 */
function computeMetrics(
  accounts: SfAccount[],
  opps: SfOpportunity[],
): Map<string, AccountMetrics> {
  const out = new Map<string, AccountMetrics>();
  for (const a of accounts) out.set(a.Id, { openPipeline: 0, amountWon: 0 });
  for (const o of opps) {
    const m = o.AccountId ? out.get(o.AccountId) : null;
    if (!m) continue;
    const amt = o.Amount ?? 0;
    if (isOpen(o)) m.openPipeline += amt;
    else if (isWon(o)) m.amountWon += amt;
  }
  return out;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}
