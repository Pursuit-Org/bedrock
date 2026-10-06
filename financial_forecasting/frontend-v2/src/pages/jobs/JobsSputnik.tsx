/**
 * Jobs · Sputnik leads section.
 *
 * Pulls from segundo-db's `public.outreach` — the staff-personal-outreach
 * tracker. Each row is a staff member's contact attempt against a real
 * person (name, title, company, LinkedIn) with notes + stage + ownership.
 *
 * Tagged "Pre-merge" — these contacts are tracked independently of SF
 * today; long-term we'll dedupe + merge.
 */
import { useMemo, useState } from "react";

import { SectionCard } from "@/components/detail";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { fmtDate } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { useSputnikLeads, type SputnikLead } from "@/services/sputnik";

import { TableToolbar } from "../portfolio/TableToolbar";

type SortKey = "contact" | "company" | "stage" | "owner" | "last";

/** Multi-value source/sector come back as JSON arrays or strings. */
function asLabel(v: SputnikLead["source"]): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "string") {
    // Stored as a JSON-encoded array in some rows.
    if (v.startsWith("[")) {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return parsed.join(", ");
      } catch {
        /* fall through */
      }
    }
    return v;
  }
  return String(v);
}

export function JobsSputnik() {
  const { data, isLoading } = useSputnikLeads();
  const [query, setQuery] = useState("");
  const { sort, toggle } = useSort<SortKey>();

  const leads = data?.data ?? [];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = leads.filter((l) => {
      if (!q) return true;
      const fields = [
        l.contact_name ?? "",
        l.contact_title ?? "",
        l.company_name ?? "",
        l.staff_name ?? "",
        l.stage ?? "",
        l.status ?? "",
        asLabel(l.source),
        asLabel(l.aligned_sector),
        l.notes ?? "",
      ];
      return fields.some((f) => f.toLowerCase().includes(q));
    });
    if (sort.key == null) {
      return filtered.slice().sort((a, b) => {
        const aKey = a.last_interaction_date ?? a.outreach_date ?? a.updated_at ?? "";
        const bKey = b.last_interaction_date ?? b.outreach_date ?? b.updated_at ?? "";
        return bKey.localeCompare(aKey);
      });
    }
    return sortBy(filtered, sort, (l, key) => {
      switch (key) {
        case "contact":
          return l.contact_name ?? "";
        case "company":
          return l.company_name ?? "";
        case "stage":
          return l.stage ?? "";
        case "owner":
          return l.staff_name ?? "";
        case "last":
          return l.last_interaction_date ?? l.outreach_date ?? l.updated_at ?? "";
      }
    });
  }, [leads, query, sort]);

  return (
    <SectionCard
      title={`Sputnik leads (${visible.length}${visible.length !== leads.length ? ` of ${leads.length}` : ""})`}
      storageScope="jobs"
      action={<PreMergeBadge />}
    >
      {isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : data && !data.available ? (
        <EmptyState>
          Sputnik (public.outreach) isn't available in this database.
          {data.error ? (
            <span className="mt-1 block text-[11.5px] text-ink-4">
              {data.error}
            </span>
          ) : null}
        </EmptyState>
      ) : leads.length === 0 ? (
        <EmptyState>No outreach rows yet.</EmptyState>
      ) : (
        <>
          <div className="flex items-center justify-end gap-3 px-5 py-2">
            <TableToolbar
              query={query}
              onQueryChange={setQuery}
              placeholder="Search leads…"
            />
          </div>
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Contact" sortKey="contact" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Company" sortKey="company" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Stage" sortKey="stage" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-3 py-1.5 text-left font-semibold">Sector</th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Owner" sortKey="owner" sort={sort} onToggle={toggle} />
                </th>
                <th className="w-[120px] px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Last activity" sortKey="last" sort={sort} onToggle={toggle} />
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => (
                <tr key={l.id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <div className="flex flex-col leading-tight">
                      <span className="truncate font-medium text-ink">
                        {l.contact_name ?? "(no name)"}
                      </span>
                      {l.contact_title ? (
                        <span className="truncate text-[10.5px] text-ink-3">
                          {l.contact_title}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate">{l.company_name ?? "—"}</span>
                      {l.linkedin_url ? (
                        <a
                          href={l.linkedin_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-ink-4 hover:text-accent"
                          title="Open LinkedIn"
                        >
                          ↗
                        </a>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">
                    <div className="flex flex-col leading-tight">
                      <span>{l.stage ?? "—"}</span>
                      {l.status ? (
                        <span className="text-[10.5px] text-ink-3">{l.status}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">
                    {asLabel(l.aligned_sector) || "—"}
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">{l.staff_name ?? "—"}</td>
                  <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                    {fmtDate(
                      l.last_interaction_date ?? l.outreach_date ?? l.updated_at,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </SectionCard>
  );
}

function PreMergeBadge() {
  return (
    <span
      className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-amber-900"
      title="Not yet reconciled against Salesforce records"
    >
      Pre-merge
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}
