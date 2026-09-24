/**
 * Jobs · Account detail — the per-account page, modeled on the portfolio
 * AccountDetail (header + sections). Reuses the account-hub query (keyed by
 * normalized company name) so navigating in from the list is instant.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Cloud, CloudOff, ExternalLink, Info } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { BackLink, EditField, SectionCard } from "@/components/detail";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { toast } from "sonner";
import { ConfirmDeprioritizeDialog } from "@/components/ConfirmDeprioritizeDialog";
import { cn } from "@/lib/utils";
import { accountStatusVariant } from "@/lib/accountStatus";
import { useUpdateAccount } from "@/services/accounts";
import {
  useJobsAccounts,
  useJobsStaff,
  useUpdateJobsAccount,
  type JobsAccount,
} from "@/services/jobs";
import { isSfAccountId } from "@/services/jobsSf";
import { PromoteAccountDialog } from "@/components/jobs/PromoteAccountDialog";

import { OwnerSelect, jobsAccountPath } from "@/components/jobs/jobsEntity";
// The same tab bodies the Accounts list opens under a row, so the page can do
// everything the list can (Kwame 2026-09-24) and the two cannot drift apart.
import {
  AccountActivityTab, AccountBuildersTab, AccountCommentsTab, AccountContactsTab,
  AccountOppsTab, AccountRolesTab, AccountTasksTab,
} from "@/components/jobs/accountTabs";

function relativeDays(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Set or clear this company's investor, and — when this account IS an investor
 *  — list the companies that name it. Both directions read the same
 *  `investor_account_key`, so they cannot disagree. */
function InvestorField({ account, accounts }: { account: JobsAccount; accounts: JobsAccount[] }) {
  const update = useUpdateJobsAccount();
  const [editing, setEditing] = useState(false);
  const portfolio = useMemo(
    () => accounts.filter((a) => a.investor_account_key === account.account_key),
    [accounts, account.account_key]);
  // Any account can be an investor, so the picker is every account except this
  // one — there's no "is an investor" flag to filter on, by design: an investor
  // is simply an account that other accounts point at.
  const options = useMemo(
    () => accounts.filter((a) => a.account_key !== account.account_key)
      .sort((a, b) => a.account.localeCompare(b.account)),
    [accounts, account.account_key]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Investor</span>
        {editing ? (
          <>
            <select
              defaultValue={account.investor_account_key ?? ""}
              onChange={(e) => update.mutate(
                { account: account.account, investor_account_key: e.target.value },
                { onSuccess: () => setEditing(false) })}
              className="h-7 min-w-[220px] rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent">
              <option value="">— none —</option>
              {options.map((a) => <option key={a.account_key} value={a.account_key}>{a.account}</option>)}
            </select>
            <button type="button" onClick={() => setEditing(false)}
              className="text-[11.5px] font-medium text-ink-3 hover:text-ink">Cancel</button>
          </>
        ) : (
          <>
            {account.investor_name ? (
              <Link to={jobsAccountPath(account.investor_account_key!)}
                className="text-[13px] font-medium text-accent hover:underline">
                {account.investor_name}
              </Link>
            ) : <span className="text-[13px] text-ink-4">Not set</span>}
            <button type="button" onClick={() => setEditing(true)}
              className="text-[11.5px] font-medium text-accent hover:underline">
              {account.investor_name ? "Change" : "Set investor"}
            </button>
          </>
        )}
      </div>
      {portfolio.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border-strong pt-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
            Portfolio companies ({portfolio.length})
          </span>
          {portfolio.map((a) => (
            <Link key={a.account_key} to={jobsAccountPath(a.account_key)}
              className="rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent hover:underline">
              {a.account}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <EditField label={label}>
      <span className={cn("text-[12.5px]", value ? "text-ink-2" : "text-ink-4")}>{value || "—"}</span>
    </EditField>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border-strong bg-surface px-3 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className="text-[15px] font-semibold text-ink">{value}</span>
    </div>
  );
}

export function JobsAccountDetailPage() {
  const { accountKey } = useParams<{ accountKey: string }>();
  const key = decodeURIComponent(accountKey ?? "");

  // The engaged scope first: it is what the list loads by default, so arriving
  // from the list is instant. An account outside it (no touches yet, say) used
  // to read "not found"; now the page falls back to the full book for it.
  const engagedQ = useJobsAccounts();
  const inEngaged = useMemo(
    () => (engagedQ.data ?? []).some((a) => a.account_key === key), [engagedQ.data, key]);
  const allQ = useJobsAccounts(undefined, "all", { enabled: engagedQ.isSuccess && !inEngaged });
  const scope: "engaged" | "all" = inEngaged ? "engaged" : "all";
  const accounts = useMemo(
    () => (inEngaged ? engagedQ.data : allQ.data) ?? [], [inEngaged, engagedQ.data, allQ.data]);
  const isLoading = engagedQ.isLoading || (engagedQ.isSuccess && !inEngaged && allQ.isLoading);
  const isError = engagedQ.isError || allQ.isError;
  const refetch = () => { void engagedQ.refetch(); if (!inEngaged) void allQ.refetch(); };
  const account = useMemo(() => accounts.find((a) => a.account_key === key), [accounts, key]);

  const { data: staff = [] } = useJobsStaff();
  const updateAccount = useUpdateJobsAccount();
  const updateSfAccount = useUpdateAccount();
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [deprioritizeOpen, setDeprioritizeOpen] = useState(false);
  const [deprioritizeError, setDeprioritizeError] = useState<string | null>(null);

  if (isLoading) {
    return <div className="px-7 py-6 text-[13px] text-ink-3">Loading account…</div>;
  }
  if (isError) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs/accounts" defaultLabel="Accounts" />
        <p className="text-[13px] text-red">Couldn't load accounts.</p>
        <button type="button" onClick={() => refetch()} className="self-start rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
      </div>
    );
  }
  if (!account) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs/accounts" defaultLabel="Accounts" />
        <p className="text-[13px] text-ink-3">Account "{key}" not found in the jobs pipeline.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-7 py-4 pb-12">
      <BackLink defaultTo="/jobs/accounts" defaultLabel="Accounts" />

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <AccountAvatar name={account.account} logoUrl={null} size={32} />
        <h1 className="text-[20px] font-semibold text-ink">{account.account}</h1>
        <Tag variant={accountStatusVariant(account.account_status)}>{account.account_status}</Tag>
        {isSfAccountId(account.account_id) ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-green/40 bg-green/10 px-2.5 py-1 text-[11.5px] font-medium text-green"><Cloud size={12} /> In Salesforce</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-ink-3"><CloudOff size={12} /> Local only</span>
            <button type="button" onClick={() => setPromoteOpen(true)} className="inline-flex items-center gap-1 rounded-lg border border-accent px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent-soft"><ExternalLink size={12} /> Add to Salesforce</button>
          </>
        )}
        {account.sf_account_id != null && (() => {
          const isActive = account.sf_active !== false;
          const runDeprioritize = () => {
            setDeprioritizeError(null);
            updateSfAccount.mutate(
              {
                id: account.sf_account_id!,
                patch: { Active__c: !isActive },
                displayPatch: isActive ? { account_status: "Deprioritized" } : undefined,
              },
              {
                onSuccess: (data) => {
                  setDeprioritizeOpen(false);
                  const reminder = (data as { _reminder_task?: { created?: boolean; reason?: string } } | undefined)
                    ?._reminder_task;
                  if (reminder && reminder.created === false) {
                    toast.warning(
                      `Account deprioritized, but no reminder task was created — ${reminder.reason ?? "unknown reason"}.`,
                    );
                  }
                },
                onError: (err) => {
                  const detail = (err as { response?: { data?: { detail?: unknown } } })
                    ?.response?.data?.detail;
                  setDeprioritizeError(
                    typeof detail === "string"
                      ? detail
                      : err instanceof Error ? err.message : "Could not deprioritize this account.",
                  );
                },
              },
            );
          };
          return (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={updateSfAccount.isPending}
                onClick={() => { if (isActive) setDeprioritizeOpen(true); else runDeprioritize(); }}
                className={cn(
                  "inline-flex h-[30px] items-center gap-1.5 rounded border px-3 text-[13px] font-medium transition-colors",
                  isActive
                    ? "border-border-strong bg-surface text-ink-2 hover:border-red/40 hover:bg-red-soft hover:text-red"
                    : "border-border-strong bg-surface text-ink-2 hover:border-green/40 hover:bg-green-soft hover:text-green",
                )}
              >
                {isActive ? "Deprioritize" : "Reprioritize"}
              </button>
              {deprioritizeOpen && (
                <ConfirmDeprioritizeDialog
                  busy={updateSfAccount.isPending}
                  error={deprioritizeError}
                  onCancel={() => { setDeprioritizeOpen(false); setDeprioritizeError(null); }}
                  onConfirm={runDeprioritize}
                />
              )}
              <Tooltip
                content="All accounts should default to 'Active'. Uncheck if there has been no recent contact with this account and there is no reason to engage with it in the foreseeable future."
                side="bottom"
              >
                <Info size={14} className="cursor-help text-ink-3" />
              </Tooltip>
            </div>
          );
        })()}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Status" value={account.account_status} />
        <Stat label="Opportunities" value={account.opp_count} />
        <Stat label="Contacts" value={account.prospect_count} />
        <Stat label="Last activity" value={relativeDays(account.last_activity)} />
      </div>

      {/* Details — what you set on this account, in one place. Owner lived in
          the header's far corner, where it read as a label rather than a
          field. Firmographics sit alongside, read-only: public.companies owns
          them and the enrichment pipeline fills them. */}
      <SectionCard title="Details" collapsible={false} storageScope="jobs-account">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 md:grid-cols-4">
          <EditField label="Owner">
            <OwnerSelect
              owner={account.owner_email}
              staff={staff}
              onSave={(email) => updateAccount.mutateAsync({ account: account.account, owner_email: email }).then(() => undefined)}
            />
          </EditField>
          <ReadField label="Company size" value={account.size_bucket} />
          <ReadField label="HQ" value={account.hq_location} />
          <ReadField label="Industry" value={account.industry} />
          <ReadField label="Company stage" value={account.company_stage} />
        </div>
        {/* Investor — a relationship, not a label: the investor is itself an
            account, so this links straight to it, and an investor's own page
            lists the companies it owns. */}
        <div className="border-t border-border-strong px-5 py-3">
          <InvestorField account={account} accounts={accounts} />
        </div>
      </SectionCard>

      {/* Sections — in the order you work an account: the deals, the people,
          what you did with them, then the roles and builders behind the deals. */}
      <SectionCard title={`Opportunities (${account.opp_count})`} storageScope="jobs-account" defaultOpen>
        <AccountOppsTab account={account} />
      </SectionCard>

      <SectionCard title={`Contacts (${account.prospect_count})`} storageScope="jobs-account" defaultOpen>
        <AccountContactsTab account={account} scope={scope} />
      </SectionCard>

      <SectionCard title="Activity" storageScope="jobs-account" defaultOpen>
        <AccountActivityTab account={account} scope={scope} />
      </SectionCard>

      <SectionCard title="Roles" storageScope="jobs-account">
        <AccountRolesTab account={account} />
      </SectionCard>

      <SectionCard title="Builders" storageScope="jobs-account">
        <AccountBuildersTab account={account} />
      </SectionCard>

      <SectionCard title="Tasks" storageScope="jobs-account">
        <AccountTasksTab accountKey={account.account_key} />
      </SectionCard>

      <SectionCard title="Comments" storageScope="jobs-account">
        <AccountCommentsTab accountKey={account.account_key} />
      </SectionCard>

      {promoteOpen && (
        <PromoteAccountDialog accountKey={account.account_key} displayName={account.account} onClose={() => setPromoteOpen(false)} />
      )}
    </div>
  );
}
