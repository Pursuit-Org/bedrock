/**
 * Jobs · Contact detail — per-contact page, in sync with the portfolio
 * ContactDetail (header + inline-editable details + sections). Reuses the jobs
 * Tasks/Comments + the shared Activity/Opportunities tab blocks.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Cloud, CloudOff, ExternalLink, Linkedin, Mail } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { BackLink, EditField, SectionCard, Stat } from "@/components/detail";
import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { PromoteContactDialog } from "@/components/jobs/PromoteContactDialog";
import { RequestIntroDialog } from "@/components/jobs/RequestIntroDialog";
import {
  ContactActivityTab,
  ContactOppsTab,
} from "@/components/jobs/jobsEntity";
import { InlineText } from "@/components/ui/InlineEdit";
import {
  useContactConnectors, useContactDetail, useUpdateContact,
  MEMBERSHIP_STAGE_LABELS, type MembershipStage,
} from "@/services/jobs";
import { useContactSfStatus } from "@/services/jobsSf";


function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function JobsContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const contactId = Number(id);
  const { data: c, isLoading, isError, refetch } = useContactDetail(Number.isNaN(contactId) ? null : contactId);
  const updateContact = useUpdateContact();
  const sfStatus = useContactSfStatus(Number.isNaN(contactId) ? null : contactId);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const { data: connectors } = useContactConnectors(Number.isNaN(contactId) ? null : contactId);
  const patch = async (field: string, val: string | null) => { await updateContact.mutateAsync({ id: contactId, [field]: val }); };

  if (isLoading) return <div className="px-7 py-6 text-[13px] text-ink-3">Loading contact…</div>;
  if (isError) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs/contacts" defaultLabel="Contacts" />
        <p className="text-[13px] text-red">Couldn't load this contact.</p>
        <button type="button" onClick={() => refetch()} className="self-start rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
      </div>
    );
  }
  if (!c) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs/contacts" defaultLabel="Contacts" />
        <p className="text-[13px] text-ink-3">Contact not found.</p>
      </div>
    );
  }

  const lastActivity = c.activity?.find((a) => !a.deleted_at)?.activity_date ?? null;
  const connectedStaff = (c.connected_staff ?? []).filter((s) => s.name);
  const hasPendingIntro = (connectors ?? []).some((s) => s.has_pending_request);

  return (
    <div className="flex flex-col gap-4 px-7 py-4 pb-16">
      <BackLink defaultTo="/jobs/contacts" defaultLabel="Contacts" />

      {/* Header */}
      <div className="flex items-start gap-4">
        <AccountAvatar name={c.full_name ?? "—"} logoUrl={null} size={44} />
        <div className="min-w-0 flex-1">
          <InlineText value={c.full_name} onSave={(v) => patch("full_name", v)} placeholder="—" className="text-[22px] font-bold text-ink" />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            {c.current_title ? <span>{c.current_title}</span> : null}
            {c.current_company ? <span>· {c.current_company}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[12.5px]">
            {c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-ink-2 hover:text-accent"><Mail size={13} /> {c.email}</a>}
            {c.linkedin_url && <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink-2 hover:text-accent"><Linkedin size={13} /> LinkedIn</a>}
          </div>
        </div>
        <SfBadge linked={sfStatus.data?.linked} onPromote={() => setPromoteOpen(true)} />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Jobs stage" value={c.membership_stage ? (MEMBERSHIP_STAGE_LABELS[c.membership_stage as MembershipStage] ?? c.membership_stage) : "—"} />
        <Stat label="Linked deal" value={c.deal?.account_name ?? "—"} />
        <Stat label="Last activity" value={relativeDays(lastActivity)} />
        <Stat label="Connections" value={String(connectedStaff.length)} />
      </div>

      {/* Details — inline editable */}
      <SectionCard title="Details" collapsible={false} storageScope="jobs-contact">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 md:grid-cols-3">
          <EditField label="Title"><InlineText value={c.current_title} onSave={(v) => patch("current_title", v)} placeholder="—" /></EditField>
          <EditField label="Company"><InlineText value={c.current_company} onSave={(v) => patch("current_company", v)} placeholder="—" /></EditField>
          <EditField label="Email"><InlineText value={c.email} onSave={(v) => patch("email", v)} placeholder="—" /></EditField>
          <EditField label="LinkedIn"><InlineText value={c.linkedin_url} onSave={(v) => patch("linkedin_url", v)} placeholder="—" /></EditField>
        </div>
        {connectedStaff.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border-strong px-5 py-3">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4"><Linkedin size={12} /> Connected on LinkedIn</span>
            {connectedStaff.map((s) => (
              <span key={s.staff_user_id} className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-ink">{s.name}</span>
            ))}
            {hasPendingIntro && (
              <span className="ml-auto rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-medium text-amber">intro request pending</span>
            )}
            <button type="button" onClick={() => setIntroOpen(true)}
              className={hasPendingIntro
                ? "rounded-lg border border-accent px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent-soft"
                : "ml-auto rounded-lg border border-accent px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent-soft"}>
              Request intro
            </button>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Opportunities" storageScope="jobs-contact"><ContactOppsTab contactId={contactId} /></SectionCard>
      <SectionCard title="Activity" storageScope="jobs-contact"><ContactActivityTab contactId={contactId} /></SectionCard>
      <SectionCard title="Tasks" storageScope="jobs-contact"><div className="px-3 py-2"><JobsTasks parentType="prospect" parentId={String(contactId)} /></div></SectionCard>
      <SectionCard title="Comments" storageScope="jobs-contact"><div className="px-3 py-2"><JobsComments parentType="prospect" parentId={String(contactId)} /></div></SectionCard>

      {promoteOpen && (
        <PromoteContactDialog contactId={contactId} contactName={c.full_name ?? "this contact"} onClose={() => setPromoteOpen(false)} />
      )}
      {introOpen && (
        <RequestIntroDialog contactId={contactId} contactName={c.full_name ?? "this contact"} onClose={() => setIntroOpen(false)} />
      )}
    </div>
  );
}

/** "In Salesforce ✓" when linked, else a "Local only" chip + Add to Salesforce. */
function SfBadge({ linked, onPromote }: { linked: boolean | undefined; onPromote: () => void }) {
  if (linked === undefined) return null;
  if (linked) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-green/40 bg-green/10 px-2.5 py-1 text-[11.5px] font-medium text-green">
        <Cloud size={12} /> In Salesforce
      </span>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-ink-3">
        <CloudOff size={12} /> Local only
      </span>
      <button type="button" onClick={onPromote} className="inline-flex items-center gap-1 rounded-lg border border-accent px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent-soft">
        <ExternalLink size={12} /> Add to Salesforce
      </button>
    </div>
  );
}
