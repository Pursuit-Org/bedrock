import { useMemo } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ExternalLink, Mail, Phone } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import {
  BackLink as SharedBackLink,
  EditField,
  LinkedProjectsCard,
  SectionCard,
  Stat,
} from "@/components/detail";
import { InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import { isOpen, stageStatus } from "@/lib/stages";
import { useAccountEnrichment } from "@/services/accounts";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { useActivities } from "@/services/activities";
import { useContacts, useUpdateContact } from "@/services/contacts";
import { useContactTasks, useCreateGenericTask, useOpportunities } from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";
import type { SfContact, SfTask } from "@/types/salesforce";

const LEAD_SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "Web", label: "Web" },
  { value: "Phone Inquiry", label: "Phone Inquiry" },
  { value: "Partner Referral", label: "Partner Referral" },
  { value: "Purchased List", label: "Purchased List" },
  { value: "Other", label: "Other" },
  { value: "Word of mouth", label: "Word of mouth" },
  { value: "Event", label: "Event" },
  { value: "Internal", label: "Internal" },
];

const BOARD_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "—" },
  { value: "Current", label: "Current" },
  { value: "Former", label: "Former" },
  { value: "Prospect", label: "Prospect" },
];

export function ContactDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();

  const { data: contacts } = useContacts();
  const contact = useMemo(
    () => (contacts ?? []).find((c) => c.Id === id),
    [contacts, id],
  );

  const { data: activities = [] } = useActivities({ contactId: id, limit: 100 });
  const { data: opps = [] } = useOpportunities();
  const enrichment = useAccountEnrichment(contact?.AccountId ?? null);
  const usersQ = useActiveUsers();
  const updateContact = useUpdateContact();
  const { data: tasks = [], isLoading: tasksLoading } = useContactTasks(id ?? "");
  const createTask = useCreateGenericTask();
  const taskContextResolver = (t: SfTask) => t.WhatName ?? null;

  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  // Opps where this contact is the npsp__Primary_Contact — drives the
  // "Opportunities" section and the "Opps influenced" stat.
  const primaryOnOpps = useMemo(
    () => opps.filter((o) => o.npsp__Primary_Contact__c === id),
    [opps, id],
  );

  if (!contact) {
    return (
      <div className="mx-auto max-w-[1320px] px-7 py-6">
        <BackLink />
        <div className="mt-6 rounded-lg border border-border-strong bg-surface p-10 text-center text-[13px] text-ink-3 shadow-sm">
          Loading contact…
        </div>
      </div>
    );
  }

  const fullName = contactDisplayName(contact);

  // Inline-edit dispatcher — converts empty strings to null so SF
  // clears the field instead of writing "" (which is invalid for some
  // typed fields like LinkedIn URL).
  const patch = (field: string, val: unknown): Promise<void> => {
    const normalized = val === "" ? null : val;
    return updateContact
      .mutateAsync({ id: contact.Id, patch: { [field]: normalized } })
      .then(() => undefined);
  };

  const saveOwner = async (ownerId: string) => {
    const ownerName = (usersQ.data ?? []).find((u) => u.Id === ownerId)?.Name ?? null;
    await updateContact.mutateAsync({
      id: contact.Id,
      patch: { OwnerId: ownerId },
      displayPatch: { Owner: { Name: ownerName } },
    });
  };

  const lastActivity = contact.Last_Activity_Date__c ?? contact.LastActivityDate ?? null;
  const wonOnOpps = primaryOnOpps.filter((o) => o.IsWon);
  const wonAmount = wonOnOpps.reduce((sum, o) => sum + (o.Amount ?? 0), 0);

  // Referrer for cross-detail jumps (account → contact's account, opps
  // → opp page). When the user clicks one of these, the resulting
  // page's BackLink should return here.
  const referrer = {
    from: { pathname: location.pathname, label: fullName || "Contact" },
  };

  return (
    <div className="mx-auto max-w-[1320px] px-7 py-6 pb-20">
      <BackLink />

      {/* Header */}
      <div className="mt-4 flex items-start gap-4">
        <AccountAvatar
          name={contact.Account?.Name ?? fullName}
          logoUrl={enrichment.data?.logo_url ?? null}
          website={null}
          size={48}
        />
        <div className="flex-1 min-w-0">
          <InlineText
            value={fullName}
            onSave={(next) => splitNameAndSave(next, contact, patch)}
            className="text-[24px] font-bold leading-tight tracking-tight text-ink py-0"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            {contact.Title ? <span>{contact.Title}</span> : null}
            {contact.Department ? <span>· {contact.Department}</span> : null}
            {contact.AccountId ? (
              <>
                <span>·</span>
                <Link
                  to={`/accounts/${contact.AccountId}`}
                  state={referrer}
                  className="underline-offset-4 hover:underline"
                >
                  {contact.Account?.Name ?? contact.AccountId}
                </Link>
              </>
            ) : null}
            {contact.Philanthropic_Contact__c || contact.Philanthropy__c ? (
              <Tag variant="accent">Philanthropic</Tag>
            ) : null}
            {contact.Board_Status__c ? <Tag>{contact.Board_Status__c}</Tag> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[12.5px]">
            {contact.Email ? (
              <a
                href={`mailto:${contact.Email}`}
                className="inline-flex items-center gap-1 text-ink-2 hover:text-accent-ink"
              >
                <Mail size={12} aria-hidden="true" /> {contact.Email}
              </a>
            ) : null}
            {contact.Phone || contact.MobilePhone ? (
              <span className="inline-flex items-center gap-1 text-ink-3">
                <Phone size={12} aria-hidden="true" /> {contact.Phone || contact.MobilePhone}
              </span>
            ) : null}
            {contact.LinkedIn_URL__c ? (
              <a
                href={contact.LinkedIn_URL__c}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-ink-2 hover:text-accent-ink"
              >
                <ExternalLink size={12} aria-hidden="true" /> LinkedIn
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Last activity" value={fmtDate(lastActivity)} />
        <Stat
          label="Days since"
          value={
            contact.Days_Since_Last_Activity__c != null
              ? String(contact.Days_Since_Last_Activity__c)
              : "—"
          }
          tone={
            contact.Days_Since_Last_Activity__c != null &&
            contact.Days_Since_Last_Activity__c > 90
              ? "amber"
              : "default"
          }
        />
        <Stat
          label="Opps as primary"
          value={primaryOnOpps.length > 0 ? String(primaryOnOpps.length) : "—"}
        />
        <Stat
          label="Won as primary"
          value={wonAmount > 0 ? fmtMoneyFull(wonAmount) : "—"}
          tone={wonAmount > 0 ? "green" : "default"}
        />
      </div>

      {/* Details — canonical inline-editable fields. Always-on (no
          collapse) so the user can update without an extra click. */}
      <SectionCard title="Details" collapsible={false} storageScope="contact">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 md:grid-cols-3">
          <EditField label="Owner">
            <InlineSelect
              value={contact.OwnerId ?? null}
              options={ownerOptions}
              onSave={saveOwner}
              renderValue={() => (
                <span className="text-[13px] text-ink-2">
                  {contact.Owner?.Name ?? ownerOptions.find((o) => o.value === contact.OwnerId)?.label ?? "—"}
                </span>
              )}
            />
          </EditField>
          <EditField label="Title">
            <InlineText
              value={contact.Title}
              onSave={(v) => patch("Title", v)}
              placeholder="—"
            />
          </EditField>
          <EditField label="Department">
            <InlineText
              value={contact.Department}
              onSave={(v) => patch("Department", v)}
              placeholder="—"
            />
          </EditField>
          <EditField label="Email">
            <InlineText
              value={contact.Email}
              onSave={(v) => patch("Email", v)}
              placeholder="—"
            />
          </EditField>
          <EditField label="Phone">
            <InlineText
              value={contact.Phone}
              onSave={(v) => patch("Phone", v)}
              placeholder="—"
            />
          </EditField>
          <EditField label="Mobile">
            <InlineText
              value={contact.MobilePhone}
              onSave={(v) => patch("MobilePhone", v)}
              placeholder="—"
            />
          </EditField>
          <EditField label="Lead source">
            <InlineSelect
              value={contact.LeadSource ?? null}
              options={LEAD_SOURCE_OPTIONS}
              onSave={(v) => patch("LeadSource", v)}
              emptyLabel="—"
            />
          </EditField>
          <EditField label="Board status">
            <InlineSelect
              value={contact.Board_Status__c ?? null}
              options={BOARD_STATUS_OPTIONS}
              onSave={(v) => patch("Board_Status__c", v || null)}
              emptyLabel="—"
            />
          </EditField>
          <EditField label="LinkedIn">
            <InlineText
              value={contact.LinkedIn_URL__c}
              onSave={(v) => patch("LinkedIn_URL__c", v)}
              placeholder="https://linkedin.com/in/…"
            />
          </EditField>
          <EditField label="Mailing city">
            <InlineText
              value={contact.MailingCity}
              onSave={(v) => patch("MailingCity", v)}
              placeholder="—"
            />
          </EditField>
          <EditField label="Mailing state">
            <InlineText
              value={contact.MailingState}
              onSave={(v) => patch("MailingState", v)}
              placeholder="—"
            />
          </EditField>
          <EditField label="Pronouns">
            <InlineText
              value={contact.Pronouns__c}
              onSave={(v) => patch("Pronouns__c", v)}
              placeholder="—"
            />
          </EditField>
        </div>
      </SectionCard>

      {/* Opportunities (where contact is npsp__Primary_Contact). */}
      {primaryOnOpps.length > 0 ? (
        <SectionCard
          title={`Opportunities (${primaryOnOpps.length})`}
          storageScope="contact"
          defaultOpen={primaryOnOpps.some((o) => isOpen(o))}
        >
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-border-strong bg-surface-2 px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                  Opportunity
                </th>
                <th className="border-b border-border-strong bg-surface-2 px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                  Stage
                </th>
                <th className="border-b border-border-strong bg-surface-2 px-5 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                  Amount
                </th>
                <th className="border-b border-border-strong bg-surface-2 px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                  Close
                </th>
              </tr>
            </thead>
            <tbody>
              {primaryOnOpps
                // Sort: open first by close-date ascending, then closed by recency.
                .slice()
                .sort((a, b) => {
                  const aOpen = isOpen(a);
                  const bOpen = isOpen(b);
                  if (aOpen !== bOpen) return aOpen ? -1 : 1;
                  return (
                    new Date(b.CloseDate ?? 0).getTime() -
                    new Date(a.CloseDate ?? 0).getTime()
                  );
                })
                .map((o) => (
                  <tr key={o.Id} className="border-b border-border-strong last:border-b-0">
                    <td className="px-5 py-2.5">
                      <Link
                        to={`/opportunities/${o.Id}`}
                        state={referrer}
                        className="block min-w-0 text-[13px] font-medium hover:underline"
                      >
                        {o.Name}
                      </Link>
                      {o.Account?.Name ? (
                        <span className="text-[11px] text-ink-3">{o.Account.Name}</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-2.5">
                      <StageChip stage={o.StageName} status={stageStatus(o)} />
                    </td>
                    <td className="mono px-5 py-2.5 text-right text-[12.5px] tabular-nums">
                      {o.Amount != null ? fmtMoneyFull(o.Amount) : "—"}
                    </td>
                    <td className="mono px-5 py-2.5 text-[11.5px] text-ink-3">
                      {fmtDate(o.CloseDate)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </SectionCard>
      ) : null}

      {/* About — bio / freeform notes. */}
      <SectionCard
        title="About"
        storageScope="contact"
        defaultOpen={Boolean(contact.Description && contact.Description.length > 0)}
      >
        <div className="px-5 py-3">
          <InlineText
            value={contact.Description}
            onSave={(v) => patch("Description", v)}
            placeholder="Add a bio, context, or notes…"
            multiline
          />
        </div>
      </SectionCard>

      <SectionCard title="Tasks" storageScope="contact" defaultOpen>
        <TaskListTab
          tasks={tasks}
          isLoading={tasksLoading}
          placeholder="Add a task linked to this contact — Enter to create"
          emptyMessage="No tasks linked to this contact."
          ownerOptions={ownerOptions}
          onCreate={async ({ subject, ownerId, activityDate }) => {
            await createTask.mutateAsync({
              Subject: subject,
              WhoId: contact.Id,
              OwnerId: ownerId ?? undefined,
              ActivityDate: activityDate ?? undefined,
            });
          }}
          contextResolver={taskContextResolver}
        />
      </SectionCard>

      <SectionCard title="Linked projects" storageScope="contact">
        <div className="px-5 py-4">
          <LinkedProjectsCard
            entityType="contact"
            entityId={contact.Id}
            referrerLabel="Contact"
          />
        </div>
      </SectionCard>

      {/* Activity timeline — scopeKey persists pin/filter state per
          contact instead of leaking across pages. */}
      <ActivityTimeline activities={activities} scopeKey={`contact:${contact.Id}`} />

      <p className="mt-6 text-[11px] text-ink-4">
        SF Id: <span className="mono">{contact.Id}</span>
      </p>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function contactDisplayName(c: SfContact): string {
  if (c.Name) return c.Name;
  const composed = [c.FirstName, c.LastName].filter(Boolean).join(" ").trim();
  return composed || "—";
}

/**
 * Inline-edit the contact's display name. SF stores First/Last separately
 * (Name is the read-only roll-up), so we split the input on the last
 * whitespace and write FirstName + LastName independently. If only one
 * token is given, it goes to LastName (SF requires LastName).
 */
async function splitNameAndSave(
  raw: string,
  contact: SfContact,
  patch: (field: string, val: unknown) => Promise<void>,
): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace < 0) {
    if (contact.LastName !== trimmed) await patch("LastName", trimmed);
    if (contact.FirstName) await patch("FirstName", null);
    return;
  }
  const first = trimmed.slice(0, lastSpace).trim();
  const last = trimmed.slice(lastSpace + 1).trim();
  if (contact.FirstName !== first) await patch("FirstName", first);
  if (contact.LastName !== last) await patch("LastName", last);
}

function BackLink() {
  return <SharedBackLink defaultTo="/contacts" defaultLabel="Contacts" />;
}
