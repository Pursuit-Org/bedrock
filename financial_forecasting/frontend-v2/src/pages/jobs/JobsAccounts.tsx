/**
 * Jobs · Accounts table.
 *
 * Surfaces accounts that have either a Fellow placement affiliation in
 * Salesforce, a won PBC opportunity, or both. The split filter lets RMs
 * see (a) the existing PBC revenue book, (b) where Fellows have landed,
 * or (c) the overlap (accounts that have both — most interesting because
 * they bought a PBC contract AND have a fellow placed).
 *
 * Each row expands into JobsAccountExpandPanel with Fellows / PBC tabs.
 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { JobsAccountExpandPanel } from "@/components/jobs/JobsAccountExpandPanel";
import { ExpandRow } from "@/components/ui/ExpandRow";
import { SectionCard, withReferrer } from "@/components/detail";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import { sortBy, useSort } from "@/lib/sort";
import { useAccountsEnrichment, useAccounts } from "@/services/accounts";
import { useAccountsWithFellows } from "@/services/affiliations";

import { TableToolbar } from "../portfolio/TableToolbar";

type Filter = "all" | "pbc" | "fellows" | "both";
type SortKey = "name" | "type" | "city" | "fellows";

export function JobsAccounts() {
  const accountsQ = useAccounts();
  const fellowsMetaQ = useAccountsWithFellows();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { sort, toggle } = useSort<SortKey>();

  const fellowSet = useMemo(
    () => new Set(fellowsMetaQ.data?.fellow_account_ids ?? []),
    [fellowsMetaQ.data],
  );
  const pbcSet = useMemo(
    () => new Set(fellowsMetaQ.data?.pbc_account_ids ?? []),
    [fellowsMetaQ.data],
  );
  const fellowCounts = fellowsMetaQ.data?.fellow_counts ?? {};

  // Universe = union of (PBC wins) ∪ (Fellow affiliations) — the only
  // accounts that have any reason to live on this page.
  const eligible = useMemo(() => {
    const all = accountsQ.data ?? [];
    return all.filter((a) => fellowSet.has(a.Id) || pbcSet.has(a.Id));
  }, [accountsQ.data, fellowSet, pbcSet]);

  const enrichmentQ = useAccountsEnrichment(eligible.map((a) => a.Id));

  const counts = useMemo(() => {
    let pbc = 0;
    let fellows = 0;
    let both = 0;
    for (const a of eligible) {
      const p = pbcSet.has(a.Id);
      const f = fellowSet.has(a.Id);
      if (p) pbc++;
      if (f) fellows++;
      if (p && f) both++;
    }
    return { all: eligible.length, pbc, fellows, both };
  }, [eligible, pbcSet, fellowSet]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = eligible.filter((a) => {
      if (filter === "pbc" && !pbcSet.has(a.Id)) return false;
      if (filter === "fellows" && !fellowSet.has(a.Id)) return false;
      if (filter === "both" && !(pbcSet.has(a.Id) && fellowSet.has(a.Id))) return false;
      if (!q) return true;
      return a.Name.toLowerCase().includes(q);
    });
    if (sort.key == null) {
      return filtered.slice().sort((a, b) => a.Name.localeCompare(b.Name));
    }
    return sortBy(filtered, sort, (a, key) => {
      switch (key) {
        case "name": return a.Name;
        case "type": return a.Type ?? "";
        case "city": return a.BillingCity ?? "";
        case "fellows": return fellowCounts[a.Id] ?? 0;
      }
    });
  }, [eligible, query, filter, sort, pbcSet, fellowSet]);

  const fellowsUnavailable =
    fellowsMetaQ.data && fellowsMetaQ.data.affiliation_available === false;

  return (
    <SectionCard
      title={`Accounts (${visible.length}${visible.length !== eligible.length ? ` of ${eligible.length}` : ""})`}
      storageScope="jobs"
      action={
        eligible.length > 0 ? (
          <TableToolbar<Filter>
            query={query}
            onQueryChange={setQuery}
            filter={{
              value: filter,
              options: [
                { value: "all", label: "All", count: counts.all },
                { value: "pbc", label: "PBC wins", count: counts.pbc },
                { value: "fellows", label: "Has fellows", count: counts.fellows },
                { value: "both", label: "Both", count: counts.both },
              ],
              onChange: setFilter,
            }}
            placeholder="Search accounts…"
          />
        ) : null
      }
    >
      {fellowsUnavailable ? (
        <div className="mx-5 mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
          Affiliation object isn't configured in Salesforce yet. "Has fellows"
          filtering is unavailable; PBC wins still work.
        </div>
      ) : null}

      {accountsQ.isLoading || fellowsMetaQ.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : eligible.length === 0 ? (
        <EmptyState>No accounts with PBC wins or Fellow placements yet.</EmptyState>
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
              <th className="w-[160px] px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Type" sortKey="type" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-left font-semibold">
                Status
              </th>
              <th className="w-[150px] px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="City" sortKey="city" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[80px] px-3 py-1.5 text-left font-semibold">
                <SortableHeader label="Fellows" sortKey="fellows" sort={sort} onToggle={toggle} />
              </th>
              <th className="w-[120px] px-3 py-1.5 text-left font-semibold">Signals</th>
              <th className="w-[40px] px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const isExpanded = expandedId === a.Id;
              const logoUrl = enrichmentQ.data?.[a.Id]?.logo_url ?? null;
              const hasPbc = pbcSet.has(a.Id);
              const hasFellows = fellowSet.has(a.Id);
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
                        <span className="block truncate text-[13px] font-medium">
                          {a.Name}
                        </span>
                        <Link
                          to={`/accounts/${a.Id}`}
                          state={withReferrer({ pathname: "/jobs", label: "Jobs" })}
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
                    <td className="px-3 py-1.5 align-middle text-[12px] text-ink-2">
                      {a.BillingCity ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 align-middle text-[12px] text-ink-2">
                      {hasFellows ? (fellowCounts[a.Id] ?? "—") : "—"}
                    </td>
                    <td className="px-3 py-1.5 align-middle">
                      <div className="flex flex-wrap gap-1">
                        {hasFellows ? <SignalTag color="green">Fellows</SignalTag> : null}
                        {hasPbc ? <SignalTag color="blue">PBC</SignalTag> : null}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 align-middle"></td>
                  </tr>
                  {isExpanded ? (
                    <ExpandRow colSpan={8}>
                      <JobsAccountExpandPanel accountId={a.Id} />
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

function SignalTag({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "green" | "blue";
}) {
  const cls =
    color === "green"
      ? "border-green/40 bg-green/10 text-green"
      : "border-blue-300 bg-blue-50 text-blue-700";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">
      {children}
    </div>
  );
}
