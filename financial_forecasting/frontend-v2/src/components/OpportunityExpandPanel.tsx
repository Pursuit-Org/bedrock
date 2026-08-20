import { useMemo, useState } from "react";

import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { PaymentScheduleBuilder } from "@/components/PaymentScheduleBuilder";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import { EntityComments } from "@/components/EntityComments";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoney } from "@/lib/format";
import {
  useCreateTask,
  useOpportunityTasks,
} from "@/services/opportunities";
import { useOpportunityPayments, type SfPayment } from "@/services/payments";
import { useActiveUsers } from "@/services/users";

export const OPP_PANEL_HEIGHT = ROW_EXPAND_HEIGHT;

export function OpportunityExpandPanel({
  opportunityId,
  oppAmount,
  oppCloseDate,
}: {
  opportunityId: string;
  /** Used as the cap when creating/editing the payment schedule from
   *  the Payments tab. Required to enable the schedule editor — when
   *  absent, the Payments tab stays read-only. */
  oppAmount?: number | null;
  /** Default first-payment date seed when creating a new schedule. */
  oppCloseDate?: string | null;
}) {
  return (
    <RowExpandPanel
      tabs={[
        {
          id: "tasks",
          label: "Tasks",
          render: () => <OppTasks opportunityId={opportunityId} />,
        },
        {
          id: "payments",
          label: "Payments",
          render: () => (
            <OppPayments
              opportunityId={opportunityId}
              oppAmount={oppAmount ?? null}
              oppCloseDate={oppCloseDate ?? null}
            />
          ),
        },
        {
          id: "activity",
          label: "Activity",
          render: () => (
            <ActivityTab
              filters={{ opportunityId }}
              emptyMessage="No emails, meetings, or notes recorded for this opportunity yet."
            />
          ),
        },
        {
          id: "comments",
          label: "Comments",
          render: () => <EntityComments entityType="opportunity" entityId={opportunityId} />,
        },
      ]}
    />
  );
}

function OppTasks({ opportunityId }: { opportunityId: string }) {
  const { data: tasks = [], isLoading } = useOpportunityTasks(opportunityId);
  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );
  const createTask = useCreateTask();

  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      placeholder="Add a task — press Enter to create"
      emptyMessage="No open tasks for this opportunity."
      ownerOptions={ownerOptions}
      onCreate={async ({ subject, ownerId, activityDate }) => {
        await createTask.mutateAsync({
          opportunityId,
          body: {
            Subject: subject,
            OwnerId: ownerId ?? undefined,
            ActivityDate: activityDate ?? undefined,
          },
        });
      }}
    />
  );
}

function rawPaymentStatus(p: SfPayment): string {
  return p.Paid_Status__c ?? p.Payment_Status__c ?? (p.npe01__Paid__c ? "Paid" : "Scheduled");
}

/** Salesforce buckets paid payments into "Paid <= 60 Days" / "Paid > 60 Days"
 *  etc. Tab already shows the paid date in the next column, so collapse every
 *  "Paid …" variant to just "Paid". The raw value still surfaces on hover. */
function paymentStatusLabel(p: SfPayment): string {
  const raw = rawPaymentStatus(p);
  if (raw.startsWith("Paid")) return "Paid";
  return raw;
}

function paymentStatusVariant(p: SfPayment): "green" | "amber" | "red" | "default" {
  if (p.npe01__Written_Off__c) return "red";
  if (p.npe01__Paid__c) return "green";
  if (p.Delinquent__c) return "red";
  const label = (p.Paid_Status__c ?? p.Payment_Status__c ?? "").toLowerCase();
  if (label.includes("paid")) return "green";
  if (label.includes("delinquent") || label.includes("written")) return "red";
  if (label.includes("scheduled") || label.includes("pending")) return "amber";
  return "default";
}

function OppPayments({
  opportunityId,
  oppAmount,
  oppCloseDate,
}: {
  opportunityId: string;
  oppAmount: number | null;
  oppCloseDate: string | null;
}) {
  const { data: payments = [], isLoading } = useOpportunityPayments(opportunityId);
  const [builderOpen, setBuilderOpen] = useState(false);

  const totals = useMemo(() => {
    let scheduled = 0;
    let paid = 0;
    let written = 0;
    for (const p of payments) {
      const amt = p.npe01__Payment_Amount__c ?? 0;
      if (p.npe01__Written_Off__c) written += amt;
      else if (p.npe01__Paid__c) paid += amt;
      else scheduled += amt;
    }
    return { scheduled, paid, written, count: payments.length };
  }, [payments]);

  // Editor is gated on having an opp Amount — the schedule total has
  // to match it or the backend POST is rejected. Without Amount we
  // can't show a sensible cap, so leave the tab read-only.
  const canEdit = oppAmount != null && oppAmount > 0;

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading ? "…" : `${totals.count} payment${totals.count === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-3">
          {totals.count > 0 ? (
            <span className="mono">
              {fmtMoney(totals.paid)} paid · {fmtMoney(totals.scheduled)} scheduled
              {totals.written > 0 ? <> · {fmtMoney(totals.written)} written off</> : null}
            </span>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={() => setBuilderOpen(true)}
              className="rounded border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-ink-2 hover:bg-surface-2"
              title={
                payments.length === 0
                  ? "Create the payment schedule for this opportunity"
                  : "Edit dates and amounts for this opportunity's payment schedule"
              }
            >
              {payments.length === 0 ? "Create schedule" : "Edit schedule"}
            </button>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : payments.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No payments tied to this opportunity.
        </div>
      ) : (
        <div className="max-w-full overflow-hidden rounded border border-border-strong bg-surface">
          {/* w-full + table-fixed with an unsized Payment # column: the
              fixed columns keep their widths and Payment # absorbs the
              rest, so the table tracks the panel width instead of forcing
              horizontal scrolling inside an expanded row. */}
          <table className="w-full table-fixed text-[12px]">
            <colgroup>
              <col />
              <col style={{ width: 180 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 150 }} />
            </colgroup>
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Payment #</th>
                <th className="px-3 py-1.5 text-left font-semibold">Status</th>
                <th className="px-3 py-1.5 text-left font-semibold">Scheduled</th>
                <th className="px-3 py-1.5 text-left font-semibold">Paid</th>
                <th className="px-3 py-1.5 text-right font-semibold">Amount</th>
                <th className="px-3 py-1.5 text-right font-semibold">Received</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.Id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5 align-middle">
                    <span className="block truncate font-medium text-ink" title={p.Name ?? p.Id}>
                      {p.Name ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 align-middle">
                    <span title={rawPaymentStatus(p)}>
                      <Tag variant={paymentStatusVariant(p)}>
                        {paymentStatusLabel(p)}
                      </Tag>
                    </span>
                  </td>
                  <td className="mono px-3 py-1.5 align-middle text-[11.5px] text-ink-2">
                    {fmtDate(p.npe01__Scheduled_Date__c)}
                  </td>
                  <td className="mono px-3 py-1.5 align-middle text-[11.5px] text-ink-2">
                    {fmtDate(p.npe01__Payment_Date__c)}
                  </td>
                  <td className="mono px-3 py-1.5 text-right align-middle font-medium tabular-nums">
                    {p.npe01__Payment_Amount__c ? fmtMoney(p.npe01__Payment_Amount__c) : "—"}
                  </td>
                  <td className="mono px-3 py-1.5 text-right align-middle tabular-nums text-ink-2">
                    {p.Amount_Received__c ? fmtMoney(p.Amount_Received__c) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {builderOpen ? (
        <PaymentScheduleBuilder
          opportunityId={opportunityId}
          oppAmount={oppAmount}
          existingPayments={payments}
          initialFirstDate={oppCloseDate}
          onClose={() => setBuilderOpen(false)}
        />
      ) : null}
    </div>
  );
}
