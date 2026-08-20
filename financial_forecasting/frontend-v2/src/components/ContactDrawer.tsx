import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Linkedin, Mail, Phone } from "lucide-react";

import { ActivityListRow } from "@/components/ActivityListRow";
import { Drawer } from "@/components/ui/Drawer";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoney, initials } from "@/lib/format";
import { isOpen, stageStatus } from "@/lib/stages";
import { useActivities } from "@/services/activities";
import { useContacts } from "@/services/contacts";
import { useOpportunities } from "@/services/opportunities";
import type { SfContact } from "@/types/salesforce";

export function ContactDrawer({
  contact,
  onClose,
}: {
  contact: SfContact | null;
  onClose: () => void;
}) {
  const open = !!contact;
  const fullName = contact
    ? [contact.FirstName, contact.LastName].filter(Boolean).join(" ") ||
      contact.Name ||
      "Contact"
    : "Contact";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={fullName}
      subtitle={
        contact
          ? [contact.Title, contact.Account?.Name].filter(Boolean).join(" · ") ||
            undefined
          : undefined
      }
      linkTo={contact?.AccountId ? `/accounts/${contact.AccountId}` : undefined}
      width={680}
    >
      {contact ? <ContactDrawerBody contact={contact} /> : null}
    </Drawer>
  );
}

function ContactDrawerBody({ contact }: { contact: SfContact }) {
  const fullName =
    [contact.FirstName, contact.LastName].filter(Boolean).join(" ") ||
    contact.Name ||
    "—";

  // Pull all contacts (cached, no extra request once Contacts page is open)
  // and use them to approximate the M:M account count via primary
  // affiliation + AccountId. The real npsp__Affiliation__c table isn't
  // exposed by the backend yet — note this in the count tooltip.
  const { data: allContacts = [] } = useContacts();

  const { data: opps = [] } = useOpportunities();
  const { data: activities = [] } = useActivities({
    contactId: contact.Id,
    limit: 30,
  });

  // Account count: union of AccountId + Primary Affiliation across all
  // contact rows for this person (deduped). For one human across multiple
  // SF Contact records this won't fire — that's a backend-only join. As a
  // conservative single-row approximation we use this contact's two
  // account references.
  const accountIds = useMemo(() => {
    const ids = new Set<string>();
    if (contact.AccountId) ids.add(contact.AccountId);
    if (contact.npsp__Primary_Affiliation__c) {
      ids.add(contact.npsp__Primary_Affiliation__c);
    }
    // If there are sibling SfContact rows with the same email, count
    // their accounts too — loose dedupe for cross-account presence.
    if (contact.Email) {
      for (const c of allContacts) {
        if (c.Id === contact.Id) continue;
        if ((c.Email ?? "").toLowerCase() === contact.Email.toLowerCase()) {
          if (c.AccountId) ids.add(c.AccountId);
          if (c.npsp__Primary_Affiliation__c) {
            ids.add(c.npsp__Primary_Affiliation__c);
          }
        }
      }
    }
    return ids;
  }, [contact, allContacts]);

  const primaryOpenOpps = useMemo(
    () =>
      opps.filter(
        (o) => o.npsp__Primary_Contact__c === contact.Id && isOpen(o),
      ),
    [opps, contact.Id],
  );

  const lastActivity =
    contact.Last_Activity_Date__c ?? contact.LastActivityDate ?? null;

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* Header card: avatar + identity + reachability */}
      <section className="rounded-lg border border-border-strong bg-surface-2 p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-surface text-[12px] font-semibold text-ink-2">
            {initials(fullName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold leading-tight">
              {fullName}
            </div>
            {contact.Title ? (
              <div className="mt-0.5 truncate text-[12px] text-ink-3">
                {contact.Title}
              </div>
            ) : null}
            {contact.AccountId ? (
              <Link
                to={`/accounts/${contact.AccountId}`}
                className="mt-1 inline-flex items-center gap-1 text-[12px] text-ink-2 hover:text-accent-ink hover:underline"
              >
                {contact.Account?.Name ?? "Account"}
                <ExternalLink size={11} />
              </Link>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
          {contact.Email ? (
            <a
              href={`mailto:${contact.Email}`}
              className="inline-flex items-center gap-1 text-ink-2 hover:text-accent-ink"
            >
              <Mail size={12} /> {contact.Email}
            </a>
          ) : null}
          {contact.Phone || contact.MobilePhone ? (
            <span className="inline-flex items-center gap-1 text-ink-2">
              <Phone size={12} /> {contact.Phone || contact.MobilePhone}
            </span>
          ) : null}
          {contact.LinkedIn_URL__c ? (
            <a
              href={contact.LinkedIn_URL__c}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-ink-2 hover:text-accent-ink"
            >
              <Linkedin size={12} /> LinkedIn
            </a>
          ) : null}
        </div>

        {contact.Philanthropic_Contact__c ||
        contact.Philanthropy__c ||
        contact.Board_Status__c ||
        contact.Volunteer__c ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {contact.Philanthropic_Contact__c || contact.Philanthropy__c ? (
              <Tag variant="accent">Philanthropy</Tag>
            ) : null}
            {contact.Board_Status__c ? <Tag>Board</Tag> : null}
            {contact.Volunteer__c ? <Tag>Volunteer</Tag> : null}
          </div>
        ) : null}
      </section>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Accounts"
          value={String(Math.max(1, accountIds.size))}
          hint="primary + affiliation (best-effort; M:M requires server join)"
        />
        <Stat
          label="Open opps (primary)"
          value={String(primaryOpenOpps.length)}
        />
        <Stat label="Last activity" value={fmtDate(lastActivity)} />
      </div>

      {/* Open opportunities where this contact is primary */}
      <Section
        title={`Open opportunities — primary contact (${primaryOpenOpps.length})`}
      >
        {primaryOpenOpps.length === 0 ? (
          <Empty>No open opportunities with this contact as primary.</Empty>
        ) : (
          <ul className="flex flex-col">
            {primaryOpenOpps.map((o) => (
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

      {/* Tasks — placeholder. No backend endpoint exists for per-contact
          SF tasks (WhoId-keyed). The Account drawer queries tasks per opp,
          which won't include unrelated tasks logged directly against this
          person. Surfaced explicitly so we don't quietly under-report. */}
      <Section title="Tasks">
        <div className="px-4 py-4 text-[12px] text-ink-3">
          <div className="font-medium text-ink-2">
            Per-contact tasks: backend endpoint{" "}
            <code className="rounded bg-surface-2 px-1 py-px text-[11px]">
              /api/salesforce/contacts/{"{id}"}/tasks
            </code>{" "}
            doesn't exist yet.
          </div>
          <div className="mt-1 text-ink-3">
            TODO: add a server route that returns SF tasks where{" "}
            <code className="text-[11px]">WhoId</code> = the contact id, then
            wire it here. For now, opp-scoped tasks live on the Account
            drawer.
          </div>
        </div>
      </Section>

      {/* Activity timeline */}
      <Section title={`Activity (${activities.length})`}>
        {activities.length === 0 ? (
          <Empty>No activities logged for this contact.</Empty>
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

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      className="rounded-md border border-border-strong bg-surface-2 px-3 py-2"
      title={hint}
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mono mt-0.5 text-[15px] font-semibold tabular-nums">
        {value}
      </div>
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
