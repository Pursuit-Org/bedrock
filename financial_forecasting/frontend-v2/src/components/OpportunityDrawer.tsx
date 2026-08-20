import { ActivityListRow } from "@/components/ActivityListRow";
import { Drawer } from "@/components/ui/Drawer";
import { StageChip } from "@/components/ui/StageChip";
import { stageStatus } from "@/lib/stages";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useActivities } from "@/services/activities";
import {
  useOpportunityPayments,
  useOpportunityTasks,
} from "@/services/opportunities";
import type { SfOpportunity, SfPayment, SfTask } from "@/types/salesforce";

/**
 * Right-side drawer surfacing the meta + child collections for a single
 * opportunity: tasks, payments, recent activity. Mirrors AccountDrawer.
 */
export function OpportunityDrawer({
  opportunity,
  onClose,
}: {
  opportunity: SfOpportunity | null;
  onClose: () => void;
}) {
  const open = !!opportunity;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={opportunity?.Name ?? "Opportunity"}
      subtitle={
        opportunity
          ? [opportunity.Account?.Name, opportunity.RecordType?.Name]
              .filter(Boolean)
              .join(" · ") || undefined
          : undefined
      }
      linkTo={opportunity ? `/opportunities/${opportunity.Id}` : undefined}
      width={680}
    >
      {opportunity ? <OpportunityDrawerBody opp={opportunity} /> : null}
    </Drawer>
  );
}

function OpportunityDrawerBody({ opp }: { opp: SfOpportunity }) {
  const oppId = opp.Id;
  const { data: tasks = [] } = useOpportunityTasks(oppId);
  const { data: payments = [] } = useOpportunityPayments(oppId);
  const { data: activities = [] } = useActivities({
    opportunityId: oppId,
    limit: 30,
  });

  const openTasks = tasks.filter((t) => !t.IsClosed);
  const closedTasks = tasks.filter((t) => t.IsClosed);

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Stage"
          value={<StageChip stage={opp.StageName} status={stageStatus(opp)} />}
        />
        <Stat
          label="Amount"
          value={
            <span className="mono text-[15px] font-semibold tabular-nums">
              {opp.Amount ? fmtMoneyFull(opp.Amount) : "—"}
            </span>
          }
        />
        <Stat
          label="Close"
          value={
            <span className="mono text-[13px] font-medium tabular-nums">
              {fmtDate(opp.CloseDate)}
            </span>
          }
        />
      </div>

      {/* Meta block */}
      <Section title="Details">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-[12.5px]">
          <Meta label="Owner" value={opp.Owner?.Name} />
          <Meta label="Probability" value={opp.Probability != null ? `${opp.Probability}%` : null} />
          <Meta label="Forecast" value={opp.ForecastCategory} />
          <Meta label="Lead source" value={opp.LeadSource} />
          <Meta label="Type" value={opp.RecordType?.Name} />
          <Meta
            label="Primary contact"
            value={opp.npsp__Primary_Contact__r?.Name}
          />
        </dl>
      </Section>

      {/* Tasks */}
      <Section title={`Tasks (${tasks.length})`}>
        {tasks.length === 0 ? (
          <Empty>No tasks logged on this opportunity.</Empty>
        ) : (
          <>
            {openTasks.length > 0 ? (
              <ul className="flex flex-col">
                {openTasks.map((t) => (
                  <TaskRow key={t.Id} t={t} />
                ))}
              </ul>
            ) : null}
            {closedTasks.length > 0 ? (
              <details className="border-t border-border-strong">
                <summary className="cursor-pointer px-4 py-2 text-[11.5px] text-ink-3 hover:text-ink">
                  {closedTasks.length} closed
                </summary>
                <ul className="flex flex-col">
                  {closedTasks.slice(0, 20).map((t) => (
                    <TaskRow key={t.Id} t={t} />
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </Section>

      {/* Payments */}
      <Section title={`Payments (${payments.length})`}>
        {payments.length === 0 ? (
          <Empty>No payments scheduled.</Empty>
        ) : (
          <ul className="flex flex-col">
            {payments.map((p) => (
              <PaymentRow key={p.Id} p={p} />
            ))}
          </ul>
        )}
      </Section>

      {/* Activity timeline */}
      <Section title={`Activity (${activities.length})`}>
        {activities.length === 0 ? (
          <Empty>No activities logged.</Empty>
        ) : (
          <ul className="flex flex-col">
            {activities.slice(0, 12).map((a) => (
              <ActivityListRow key={a.id} a={a} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function TaskRow({ t }: { t: SfTask }) {
  return (
    <li className="flex items-center gap-3 border-b border-border-strong px-4 py-2 last:border-b-0">
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium",
          t.IsClosed ? "bg-surface-2 text-ink-3" : "bg-amber-soft text-amber",
        )}
      >
        {t.Status ?? "Open"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {t.Subject ?? "(no subject)"}
      </span>
      <span className="mono w-24 flex-shrink-0 text-right text-[11px] text-ink-3">
        {fmtDate(t.ActivityDate)}
      </span>
    </li>
  );
}

function PaymentRow({ p }: { p: SfPayment }) {
  const paid = !!p.npe01__Paid__c;
  const writtenOff = !!p.npe01__Written_Off__c;
  const status = writtenOff ? "Written off" : paid ? "Paid" : (p.Payment_Status__c ?? "Scheduled");
  return (
    <li className="flex items-center gap-3 border-b border-border-strong px-4 py-2 last:border-b-0">
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium",
          paid
            ? "bg-green-soft text-green"
            : writtenOff
              ? "bg-surface-2 text-ink-3"
              : "bg-amber-soft text-amber",
        )}
      >
        {status}
      </span>
      <span className="mono min-w-0 flex-1 truncate text-[12.5px] tabular-nums">
        {p.npe01__Payment_Amount__c
          ? fmtMoneyFull(p.npe01__Payment_Amount__c, true)
          : "—"}
      </span>
      <span className="mono w-28 flex-shrink-0 text-right text-[11px] text-ink-3">
        {fmtDate(p.npe01__Payment_Date__c ?? p.npe01__Scheduled_Date__c)}
      </span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border-strong bg-surface-2 px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      <div className="border-b border-border-strong bg-surface-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        {title}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-5 text-center text-[12px] text-ink-3">
      {children}
    </div>
  );
}

function Meta({
  label,
  value,
  full,
}: {
  label: string;
  value: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={cn("flex flex-col", full && "col-span-2")}>
      <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </dt>
      <dd className="text-[12.5px] text-ink">
        {value ? value : <span className="text-ink-4">—</span>}
      </dd>
    </div>
  );
}
