import { Link } from "react-router-dom";

import { SectionCard } from "@/components/detail";
import { Tag } from "@/components/ui/Tag";
import { fmtDate } from "@/lib/format";
import type { SfDeliverableWithOppName } from "@/types/salesforce";

type TagVariant = "default" | "accent" | "green" | "amber" | "red" | "sky";
type DeliverableType = "LOI" | "Application" | "Interim Report" | "Final Report";

const TYPE_VARIANT: Record<DeliverableType, TagVariant> = {
  LOI: "default",
  Application: "sky",
  "Interim Report": "amber",
  "Final Report": "green",
};

const ACCOUNT_MSG =
  "This account has upcoming deliverables for opportunities associated with it that have a due date within the next 30 days.";
const PORTFOLIO_MSG =
  "You have upcoming deliverables for opportunities associated with you that have a due date within the next 30 days.";

interface Props {
  deliverables: SfDeliverableWithOppName[];
  context?: "account" | "portfolio";
  loading?: boolean;
}

export function UpcomingDeliverablesPanel({
  deliverables,
  context = "account",
  loading,
}: Props) {
  if (loading || deliverables.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <SectionCard title="Opportunity Deliverables">
      <div className="px-5 pt-3 pb-1">
        <p className="text-[12.5px] italic text-ink-3">
          {context === "portfolio" ? PORTFOLIO_MSG : ACCOUNT_MSG}
        </p>
      </div>

      <div className="overflow-x-auto px-5 pb-4">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              <th className="pb-2 pr-4 pt-3">Opportunity</th>
              <th className="pb-2 pr-4 pt-3">Name</th>
              <th className="pb-2 pr-4 pt-3">Type</th>
              <th className="pb-2 pr-4 pt-3">Due Date</th>
              <th className="pb-2 pr-4 pt-3">Requirements</th>
              <th className="pb-2 pt-3">Submitted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {deliverables.map((d) => {
              const overdue = !!d.due_date && !d.close_date && d.due_date < today;
              return (
                <tr key={d.id} className="align-top">
                  <td className="py-2.5 pr-4">
                    <Link
                      to={`/opportunities/${d.opportunity_id}`}
                      className="font-medium text-accent underline-offset-2 hover:underline"
                    >
                      {d.opportunity_name ?? "—"}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 text-ink">{d.name ?? "—"}</td>
                  <td className="py-2.5 pr-4">
                    {d.type ? (
                      <Tag variant={TYPE_VARIANT[d.type] ?? "default"}>
                        {d.type}
                      </Tag>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className={`py-2.5 pr-4 ${overdue ? "font-medium text-red" : "text-ink"}`}>
                    {fmtDate(d.due_date)}
                  </td>
                  <td className="max-w-[240px] py-2.5 pr-4 text-ink-2">
                    {d.requirements ? d.requirements : <span className="text-ink-3">—</span>}
                  </td>
                  <td className="py-2.5 text-ink-2">
                    {d.close_date ? fmtDate(d.close_date) : <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
