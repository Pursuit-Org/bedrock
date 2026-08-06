/**
 * Jobs · Account detail — the per-account page, modeled on the portfolio
 * AccountDetail (header + sections). Reuses the account-hub query (keyed by
 * normalized company name) so navigating in from the list is instant.
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Cloud, CloudOff, ExternalLink } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { BackLink, SectionCard } from "@/components/detail";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import {
  useAccountProspects,
  useJobsAccounts,
  useJobsStaff,
  useUpdateJobsAccount,
} from "@/services/jobs";
import { isSfAccountId } from "@/services/jobsSf";
import { PromoteAccountDialog } from "@/components/jobs/PromoteAccountDialog";

import { ContactsLinkTab, OppsTab, OwnerSelect } from "@/components/jobs/jobsEntity";
import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";

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

  const { data: accounts = [], isLoading, isError, refetch } = useJobsAccounts();
  const account = useMemo(() => accounts.find((a) => a.account_key === key), [accounts, key]);
  const { data: prospects = [] } = useAccountProspects(account?.account_key ?? null);

  const { data: staff = [] } = useJobsStaff();
  const updateAccount = useUpdateJobsAccount();
  const [promoteOpen, setPromoteOpen] = useState(false);

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
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Owner</span>
          <OwnerSelect
            owner={account.owner_email}
            staff={staff}
            onSave={(email) => updateAccount.mutateAsync({ account: account.account, owner_email: email })}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Status" value={account.account_status} />
        <Stat label="Opportunities" value={account.opp_count} />
        <Stat label="Contacts" value={account.prospect_count} />
        <Stat label="Last activity" value={relativeDays(account.last_activity)} />
      </div>

      {/* Firmographics — read-only, from public.companies. Bedrock shows them;
          the enrichment pipeline owns them, so there's nothing to edit here. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Company size"
          value={account.employee_count != null
            ? `${account.employee_count.toLocaleString()}${account.size_bucket ? ` (${account.size_bucket})` : ""}`
            : account.size_bucket || "—"} />
        <Stat label="HQ" value={account.hq_location || "—"} />
        <Stat label="Industry" value={account.industry || "—"} />
        <Stat label="Company stage" value={account.company_stage || "—"} />
      </div>

      {/* Sections */}
      <SectionCard title={`Opportunities (${account.opp_count})`} storageScope="jobs-account" defaultOpen>
        <OppsTab opps={account.opportunities} />
      </SectionCard>

      <SectionCard title={`Contacts (${account.prospect_count})`} storageScope="jobs-account" defaultOpen>
        <ContactsLinkTab contacts={prospects} />
      </SectionCard>

      <SectionCard title="Tasks" storageScope="jobs-account">
        <div className="px-3 py-2"><JobsTasks parentType="account" parentId={account.account_key} /></div>
      </SectionCard>

      <SectionCard title="Comments" storageScope="jobs-account">
        <div className="px-3 py-2"><JobsComments parentType="account" parentId={account.account_key} /></div>
      </SectionCard>

      {promoteOpen && (
        <PromoteAccountDialog accountKey={account.account_key} displayName={account.account} onClose={() => setPromoteOpen(false)} />
      )}
    </div>
  );
}
