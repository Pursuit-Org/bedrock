/**
 * Jobs · Opportunity detail — per-deal page, in sync with the portfolio
 * OpportunityDetail. Inline-editable fields + reused Roles/Builders sections +
 * shared Activity/Contacts/Tasks/Comments. Stage stays read-only here (its
 * changes are gated by the Opportunities-tab modals — closed-lost reason,
 * committed roles, placements); manage stage there.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Briefcase, Cloud, Trash2 } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { BackLink, EditField, SectionCard, Stat } from "@/components/detail";
import { JobsActivityList } from "@/components/jobs/JobsActivityList";
import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { HandoffToPbcDialog } from "@/components/jobs/HandoffToPbcDialog";
import { OppBuilderActivity } from "@/components/jobs/OppBuilderActivity";
import { OppRolesSection } from "@/components/jobs/OppRolesSection";
import {
  DealStagePill,
  DEAL_TYPE_LABELS,
  JobsContactRow,
  OwnerSelect,
  jobsAccountPath,
} from "@/components/jobs/jobsEntity";
import { withReferrer } from "@/components/detail";
import { InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import {
  useJobsOpportunity,
  useUpdateOpportunity,
  useDeleteOpportunity,
  useJobsStaff,
  type DealType,
} from "@/services/jobs";

const DEAL_TYPE_OPTIONS = (Object.keys(DEAL_TYPE_LABELS) as DealType[]).map((v) => ({ value: v, label: DEAL_TYPE_LABELS[v] }));
const PRIORITY_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `P${n}` }));
const LIKELIHOOD_OPTIONS = [
  { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" },
];

export function JobsOpportunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: o, isLoading, isError, refetch } = useJobsOpportunity(id ?? null);
  const updateOpp = useUpdateOpportunity();
  const del = useDeleteOpportunity();
  const { data: staff = [] } = useJobsStaff();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const patch = async (field: string, val: unknown) => { await updateOpp.mutateAsync({ id: id!, [field]: val }); };
  const removeOpp = () => {
    if (!o) return;
    if (window.confirm(`Delete opportunity "${o.title || o.account_name}"? This removes it from the pipeline.`))
      del.mutate(id!, { onSuccess: () => navigate(-1) });
  };

  if (isLoading) return <div className="px-7 py-6 text-[13px] text-ink-3">Loading opportunity…</div>;
  if (isError) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs/pipeline" defaultLabel="Pipeline" />
        <p className="text-[13px] text-red">Couldn't load this opportunity.</p>
        <button type="button" onClick={() => refetch()} className="self-start rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
      </div>
    );
  }
  if (!o) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs/pipeline" defaultLabel="Pipeline" />
        <p className="text-[13px] text-ink-3">Opportunity not found.</p>
      </div>
    );
  }

  const accountKey = (o.account_name ?? "").trim().toLowerCase();
  const lastActivity = o.activity?.find((a) => !a.deleted_at)?.activity_date ?? null;

  return (
    <div className="flex flex-col gap-4 px-7 py-4 pb-16">
      <BackLink defaultTo="/jobs/pipeline" defaultLabel="Pipeline" />

      {/* Header */}
      <div className="flex items-start gap-4">
        <AccountAvatar name={o.account_name ?? o.title ?? "—"} logoUrl={null} size={44} />
        <div className="min-w-0 flex-1">
          <InlineText value={o.title} onSave={(v) => patch("title", v)} placeholder="Untitled opportunity" className="text-[22px] font-bold text-ink" />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            <DealStagePill stage={o.stage} />
            {o.deal_type && <span className="font-medium uppercase tracking-wide text-ink-4">{DEAL_TYPE_LABELS[o.deal_type] ?? o.deal_type}</span>}
            {accountKey && (
              <Link to={jobsAccountPath(accountKey)} state={withReferrer({ pathname: "/jobs", label: "Jobs" })} className="text-accent underline-offset-4 hover:underline">
                {o.account_name}
              </Link>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {o.sf_opportunity_id ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-green/40 bg-green/10 px-2.5 py-1 text-[12px] font-medium text-green" title={`Linked SF opportunity ${o.sf_opportunity_id}`}>
              <Cloud size={13} /> Handed off to PBC
            </span>
          ) : (
            <button type="button" onClick={() => setHandoffOpen(true)} className="inline-flex items-center gap-1 rounded-md border border-accent px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent-soft" title="Create a linked PBC opportunity in Salesforce">
              <Briefcase size={13} /> Hand off to PBC
            </button>
          )}
          <button type="button" onClick={removeOpp} className="flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-[12px] font-medium text-ink-3 transition-colors hover:border-red hover:text-red" title="Delete opportunity">
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>

      {handoffOpen && (
        <HandoffToPbcDialog
          oppId={o.id}
          accountId={o.account_id}
          accountName={o.account_name ?? ""}
          defaultName={`${o.account_name ?? "Untitled"}${o.title ? ` — ${o.title}` : ""}`}
          onClose={() => setHandoffOpen(false)}
        />
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Stage" value={o.stage} />
        <Stat label="Deal type" value={o.deal_type ? (DEAL_TYPE_LABELS[o.deal_type] ?? o.deal_type) : "—"} />
        <Stat label="Roles" value={String(o.num_roles ?? 0)} />
        <Stat label="Last activity" value={lastActivity ? new Date(lastActivity).toLocaleDateString() : "—"} />
      </div>

      {/* Details — inline editable */}
      <SectionCard title="Details" collapsible={false} storageScope="jobs-opportunity">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 md:grid-cols-3">
          <EditField label="Owner">
            <OwnerSelect owner={o.owner_email} staff={staff} onSave={(email) => patch("owner_email", email)} />
          </EditField>
          <EditField label="Relationship owner">
            <OwnerSelect owner={o.relationship_owner} staff={staff} onSave={(email) => patch("relationship_owner", email)} />
          </EditField>
          <EditField label="Deal type">
            <InlineSelect<string> value={o.deal_type} options={DEAL_TYPE_OPTIONS} emptyLabel="—" onSave={(v) => patch("deal_type", v || null)} />
          </EditField>
          <EditField label="Priority">
            <InlineSelect<string> value={o.priority ? String(o.priority) : null} options={PRIORITY_OPTIONS} emptyLabel="—" onSave={(v) => patch("priority", v ? Number(v) : null)} />
          </EditField>
          <EditField label="Likelihood">
            <InlineSelect<string> value={o.likelihood} options={LIKELIHOOD_OPTIONS} emptyLabel="—" onSave={(v) => patch("likelihood", v || null)} />
          </EditField>
          <EditField label="Segment"><InlineText value={o.segment ?? null} onSave={(v) => patch("segment", v)} placeholder="—" /></EditField>
          <EditField label="Expected salary"><InlineText value={o.salary_expected != null ? String(o.salary_expected) : null} onSave={(v) => patch("salary_expected", v ? Number(v.replace(/[^0-9.]/g, "")) : null)} placeholder="—" /></EditField>
          <EditField label="# Roles"><InlineText value={o.num_roles != null ? String(o.num_roles) : null} onSave={(v) => patch("num_roles", v ? Number(v) : null)} placeholder="—" /></EditField>
          <EditField label="Warm intro by"><InlineText value={o.intro_by ?? null} onSave={(v) => patch("intro_by", v)} placeholder="—" /></EditField>
        </div>
        {o.closed_lost_reason ? (
          <div className="border-t border-border-strong px-5 py-3 text-[12px] text-ink-3">
            <span className="font-semibold text-ink-2">Closed-lost:</span> {o.closed_lost_reason}{o.closed_lost_note ? ` — ${o.closed_lost_note}` : ""}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title={`Roles (${o.num_roles ?? 0})`} storageScope="jobs-opportunity"><div className="px-3 py-2"><OppRolesSection oppId={o.id} /></div></SectionCard>
      <SectionCard title="Builders" storageScope="jobs-opportunity"><div className="px-3 py-2"><OppBuilderActivity oppId={o.id} /></div></SectionCard>
      <SectionCard title={`Contacts (${o.contacts?.length ?? 0})`} storageScope="jobs-opportunity">
        {o.contacts && o.contacts.length > 0 ? (
          <div className="flex flex-col gap-1.5 p-4">{o.contacts.map((c) => <JobsContactRow key={c.contact_id} contact={c} />)}</div>
        ) : <div className="px-4 py-6 text-[12.5px] text-ink-3">No contacts linked.</div>}
      </SectionCard>
      <SectionCard title="Activity" storageScope="jobs-opportunity"><JobsActivityList entries={o.activity ?? []} /></SectionCard>
      <SectionCard title="Tasks" storageScope="jobs-opportunity"><div className="px-3 py-2"><JobsTasks parentType="opportunity" parentId={o.id} /></div></SectionCard>
      <SectionCard title="Comments" storageScope="jobs-opportunity"><div className="px-3 py-2"><JobsComments parentType="opportunity" parentId={o.id} /></div></SectionCard>
    </div>
  );
}
