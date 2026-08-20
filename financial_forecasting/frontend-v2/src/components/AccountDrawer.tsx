import { useMemo } from "react";
import { Link } from "react-router-dom";

import { ActivityListRow } from "@/components/ActivityListRow";
import { Drawer } from "@/components/ui/Drawer";
import { StageChip } from "@/components/ui/StageChip";
import { fmtDate, fmtMoney, fmtMoneyFull } from "@/lib/format";
import { isOpen, stageStatus } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { useActivities } from "@/services/activities";
import { useContacts } from "@/services/contacts";
import {
  useOpportunities,
  useOpportunityTasks,
} from "@/services/opportunities";
import type { SfAccount, SfTask } from "@/types/salesforce";

export function AccountDrawer({
  account,
  onClose,
}: {
  account: SfAccount | null;
  onClose: () => void;
}) {
  const open = !!account;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={account?.Name ?? "Account"}
      subtitle={
        account
          ? [account.Type, account.Industry].filter(Boolean).join(" · ") || undefined
          : undefined
      }
      linkTo={account ? `/accounts/${account.Id}` : undefined}
      width={680}
    >
      {account ? <AccountDrawerBody account={account} /> : null}
    </Drawer>
  );
}

function AccountDrawerBody({ account }: { account: SfAccount }) {
  const accountId = account.Id;
  const { data: opps = [] } = useOpportunities();
  const { data: contacts = [] } = useContacts(accountId);
  const { data: activities = [] } = useActivities({
    accountId,
    limit: 30,
  });

  const oppsForAccount = useMemo(
    () => opps.filter((o) => o.AccountId === accountId),
    [opps, accountId],
  );

  const openOpps = oppsForAccount.filter(isOpen);

  // Build aggregates
  const lifetime = account.npo02__TotalOppAmount__c ?? 0;
  const closedCount = account.npo02__NumberOfClosedOpps__c ?? 0;

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Open opps" value={String(openOpps.length)} />
        <Stat label="Closed opps" value={closedCount > 0 ? String(closedCount) : "—"} />
        <Stat label="Lifetime" value={lifetime > 0 ? fmtMoneyFull(lifetime) : "—"} />
      </div>

      {/* Open opportunities */}
      <Section title={`Open opportunities (${openOpps.length})`}>
        {openOpps.length === 0 ? (
          <Empty>No open opportunities.</Empty>
        ) : (
          <ul className="flex flex-col">
            {openOpps.map((o) => (
              <li
                key={o.Id}
                className="flex items-center gap-3 border-b border-border-strong px-4 py-2.5 last:border-b-0"
              >
                <StageChip stage={o.StageName} status={stageStatus(o)} />
                <Link
                  to={`/opportunities/${o.Id}`}
                  className="min-w-0 flex-1 truncate text-[13px] font-medium hover:underline"
                >
                  {o.Name}
                </Link>
                <span className="mono flex-shrink-0 text-right text-[12.5px] font-medium tabular-nums">
                  {o.Amount ? fmtMoney(o.Amount) : "—"}
                </span>
                <span className="mono w-24 flex-shrink-0 text-right text-[11px] text-ink-3">
                  {fmtDate(o.CloseDate)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Tasks across all opportunities for this account */}
      <TasksAcrossOppsSection oppIds={oppsForAccount.map((o) => o.Id)} />

      {/* Contacts */}
      <Section title={`Contacts (${contacts.length})`}>
        {contacts.length === 0 ? (
          <Empty>No contacts on this account.</Empty>
        ) : (
          <ul className="flex flex-col">
            {contacts.slice(0, 8).map((c) => (
              <li
                key={c.Id}
                className="flex items-center gap-3 border-b border-border-strong px-4 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {[c.FirstName, c.LastName].filter(Boolean).join(" ") || c.Name || "—"}
                  </div>
                  {c.Title ? (
                    <div className="truncate text-[11.5px] text-ink-3">{c.Title}</div>
                  ) : null}
                </div>
                {c.Email ? (
                  <a
                    href={`mailto:${c.Email}`}
                    className="truncate text-[11.5px] text-ink-2 hover:text-accent-ink"
                  >
                    {c.Email}
                  </a>
                ) : null}
              </li>
            ))}
            {contacts.length > 8 ? (
              <li className="px-4 py-2 text-[11.5px] text-ink-3">
                + {contacts.length - 8} more
              </li>
            ) : null}
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

/**
 * SF Tasks live on Opportunity (not Account directly), so we union them
 * across all opps for this account. Each useOpportunityTasks runs in
 * parallel; React Query caches per opp, so revisiting is instant.
 */
function TasksAcrossOppsSection({ oppIds }: { oppIds: string[] }) {
  // We intentionally call useOpportunityTasks at module-call time for
  // every opp id. With <30 opps per account this is fine; we cap to 20
  // to avoid pathological blowups on whales.
  const sliced = oppIds.slice(0, 20);
  return (
    <Section title="Tasks">
      <TasksFromOpps oppIds={sliced} />
      {oppIds.length > sliced.length ? (
        <div className="px-4 py-2 text-[11px] text-ink-3">
          Showing tasks from {sliced.length} of {oppIds.length} opportunities.
        </div>
      ) : null}
    </Section>
  );
}

function TasksFromOpps({ oppIds }: { oppIds: string[] }) {
  // Inline component so we don't violate hook rules with dynamic counts.
  // We use a simple key-based render: one TaskListForOpp per opp,
  // hidden if it has no tasks.
  if (oppIds.length === 0) {
    return <Empty>No opportunities → no tasks.</Empty>;
  }
  return (
    <div className="flex flex-col">
      {oppIds.map((id) => (
        <TaskListForOpp key={id} oppId={id} />
      ))}
    </div>
  );
}

function TaskListForOpp({ oppId }: { oppId: string }) {
  const { data = [] } = useOpportunityTasks(oppId);
  const open = data.filter((t) => !t.IsClosed);
  if (open.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {open.map((t) => (
        <TaskRow key={t.Id} t={t} />
      ))}
    </ul>
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
      <span className="min-w-0 flex-1 truncate text-[13px]">{t.Subject ?? "(no subject)"}</span>
      <span className="mono w-24 flex-shrink-0 text-right text-[11px] text-ink-3">
        {fmtDate(t.ActivityDate)}
      </span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-strong bg-surface-2 px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mono mt-0.5 text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
  return <div className="px-4 py-5 text-center text-[12px] text-ink-3">{children}</div>;
}
