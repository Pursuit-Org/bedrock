/**
 * Jobs · Prospects — tabbed expand panel for an account row.
 *
 * Mirrors {@link AccountExpandPanel} on the portfolio/Accounts page: an
 * account row expands into a {@link RowExpandPanel} whose tabs lazily mount
 * their content. Tabs:
 *   - Contacts: the account's prospect list (inline-editable stage); clicking
 *     a contact expands the existing {@link ContactDetail} drawer (activity +
 *     per-contact Tasks/Comments).
 *   - Tasks / Comments: account-level, keyed to a stable `acct:<name>` parent
 *     id so they survive across the account's contacts.
 *   - Activity: roll-up of every contact's logged activity for this account.
 */
import { useMemo, useState } from "react";
import {
  Building2,
  Calendar,
  ChevronDown,
  ChevronRight,
  FileText,
  Linkedin,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  Plus,
  Trash2,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { RequestIntroDialog } from "@/components/jobs/RequestIntroDialog";
import { RowExpandPanel } from "@/components/RowExpandPanel";
import { InlineText } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";
import {
  STAGE_LABELS,
  useContactDetail,
  useDeleteActivity,
  useUpdateContact,
  type JobStage,
} from "@/services/jobs";
import {
  useLogProspectActivity,
  type AccountGroup,
  type AccountGroupContact,
} from "@/services/jobsAccounts";

// ── Stage styling ──────────────────────────────────────────────────────────

export const CONTACT_STAGE_STYLES: Record<string, string> = {
  active:           "bg-emerald-50 text-emerald-700",
  initial_outreach: "bg-accent-soft text-accent-ink",
  lead:             "bg-stone-100 text-stone-500",
  on_hold:          "bg-amber-50 text-amber-700",
};

export const CONTACT_STAGE_LABELS: Record<string, string> = {
  active:           "Active",
  initial_outreach: "Outreach",
  lead:             "Lead",
  on_hold:          "On Hold",
};


const DEAL_STAGE_STYLES: Record<string, string> = {
  active_in_discussions:        "bg-amber-50 text-amber-700",
  active_opportunity_confirmed: "bg-emerald-50 text-emerald-700",
  active_builder_interview:     "bg-emerald-100 text-emerald-800",
  closed_won:                   "bg-green-100 text-green-800",
  closed_lost:                  "bg-red-50 text-red-600",
  lead_submitted:               "bg-stone-100 text-stone-500",
  initial_outreach:             "bg-blue-50 text-blue-600",
};

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  email:    Mail,
  call:     Phone,
  text:     MessageCircle,
  linkedin: Linkedin,
  meeting:  Calendar,
  note:     FileText,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function initials(name: string | null) {
  if (!name) return "?";
  const parts = name.trim().split(" ").filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ownerName(email: string | null) {
  if (!email) return null;
  const local = email.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** Stable parent id for account-level tasks/comments. */
function accountKey(account: string) {
  return `acct:${account}`;
}

// ── Activity log form ────────────────────────────────────────────────────────

// Email is here to catch sends the Gmail sync missed — it lands in the same
// emailed-contacts numbers as synced mail, and can't double-count a contact
// who also has a synced copy (the metric counts distinct people).
const ACTIVITY_TYPE_OPTIONS = [
  { value: "call",     label: "Call" },
  { value: "email",    label: "Email" },
  { value: "text",     label: "Text" },
  { value: "linkedin", label: "LinkedIn" },
] as const;

type ActivityType = (typeof ACTIVITY_TYPE_OPTIONS)[number]["value"];

export function LogActivityForm({
  contactId,
  onClose,
}: {
  contactId: number;
  onClose: () => void;
}) {
  const [type, setType] = useState<ActivityType>("call");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const { mutateAsync: logActivity } = useLogProspectActivity();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;
    setSubmitting(true);
    try {
      await logActivity({
        contact_id: contactId,
        type,
        description: description.trim(),
        activity_date: date || undefined,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mb-4 flex flex-col gap-3 rounded-lg border border-border-strong bg-surface p-3">
      <div className="flex flex-wrap gap-1.5">
        {ACTIVITY_TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setType(opt.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
              type === opt.value
                ? "border-accent bg-accent text-white"
                : "border-border-strong bg-surface text-ink-3 hover:border-accent hover:text-accent",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div>
        <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-4">Date</label>
        <input
          type="date"
          value={date}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border border-border-strong bg-surface px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div>
        <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-4">Description</label>
        <textarea
          rows={3}
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What happened?"
          className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || !description.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {submitting ? "Logging…" : "Log"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] text-ink-3 transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ isJobs, source }: { isJobs: boolean; source: string }) {
  if (isJobs) {
    return (
      <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-0.5 font-medium leading-none text-accent-ink" style={{ fontSize: 10 }}>
        Jobs
      </span>
    );
  }
  if (source === "gmail-sync") {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 font-medium leading-none text-blue-600" style={{ fontSize: 10 }}>
        Gmail
      </span>
    );
  }
  if (source === "calendar-sync") {
    return (
      <span className="inline-flex items-center rounded-full bg-violet-50 px-1.5 py-0.5 font-medium leading-none text-violet-600" style={{ fontSize: 10 }}>
        Calendar
      </span>
    );
  }
  if (source === "salesforce") {
    return (
      <span className="inline-flex items-center rounded-full bg-sky-50 px-1.5 py-0.5 font-medium leading-none text-sky-600" style={{ fontSize: 10 }}>
        SF
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-0.5 font-medium leading-none text-stone-500" style={{ fontSize: 10 }}>
      Manual
    </span>
  );
}

// ── Contact detail drawer (unchanged behaviour) ───────────────────────────────

export function ContactDetail({ contactId }: { contactId: number }) {
  const { data, isLoading } = useContactDetail(contactId);
  const { mutateAsync: updateContact } = useUpdateContact();
  const { mutate: deleteActivity } = useDeleteActivity();
  const [showLogForm, setShowLogForm] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="animate-pulse border-t border-border-strong bg-surface-2 px-6 py-5">
        <div className="mb-3 h-4 w-48 rounded bg-surface" />
        <div className="h-3 w-80 rounded bg-surface" />
      </div>
    );
  }
  if (!data) return null;

  const dealStageStyle = data.deal?.stage
    ? DEAL_STAGE_STYLES[data.deal.stage] ?? "bg-stone-100 text-stone-500"
    : null;

  const save = (field: string) => async (value: string) => {
    await updateContact({ id: contactId, [field]: value });
  };

  // Who on staff is connected to this contact — from LinkedIn connections
  // (staff_contact_relationships), resolved to names. Only show resolved names.
  const staffConnections = (data.connected_staff ?? []).filter((s) => s.name);

  return (
    <div className="border-t border-border-strong bg-surface-2">
      <div className="flex gap-6 p-5">
        {/* ── Left: contact info ── */}
        <div className="flex w-64 flex-shrink-0 flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
              {initials(data.full_name)}
            </div>
            <div className="min-w-0 flex-1">
              <InlineText
                value={data.full_name}
                onSave={save("full_name")}
                placeholder="Full name"
                className="text-[14px] font-semibold text-ink"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2.5 text-[12px]">
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-4">Title</div>
              <InlineText value={data.current_title} onSave={save("current_title")} placeholder="Current title" />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-4">Company</div>
              <InlineText value={data.current_company} onSave={save("current_company")} placeholder="Current company" />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-4">Email</div>
              <InlineText value={data.email} onSave={save("email")} placeholder="Email address" />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-4">LinkedIn</div>
              <InlineText value={data.linkedin_url} onSave={save("linkedin_url")} placeholder="LinkedIn URL" />
            </div>
          </div>

          <button type="button" onClick={() => setIntroOpen(true)}
            className="self-start rounded-lg border border-accent px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent-soft">
            Request intro
          </button>
          {introOpen && (
            <RequestIntroDialog contactId={contactId} contactName={data.full_name ?? "this contact"} onClose={() => setIntroOpen(false)} />
          )}

          {data.deal && (
            <div className="rounded-lg border border-border-strong bg-surface p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-4">Linked Deal</div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
                <Building2 size={11} className="flex-shrink-0 text-ink-4" />
                {data.deal.account_name || "—"}
              </div>
              {dealStageStyle && (
                <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-4", dealStageStyle)}>
                  {STAGE_LABELS[data.deal.stage as JobStage] ?? data.deal.stage}
                </span>
              )}
              {data.deal.owner_email && (
                <div className="mt-1.5 text-[11px] text-ink-4">
                  Owner: {ownerName(data.deal.owner_email)}
                </div>
              )}
            </div>
          )}

          {staffConnections.length > 0 && (
            <div className="rounded-lg border border-border-strong bg-surface p-3">
              <div className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
                <Linkedin size={11} className="text-[#0a66c2]" /> Connected on LinkedIn ({staffConnections.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {staffConnections.map((s) => (
                  <span
                    key={s.staff_user_id}
                    title={s.email ?? undefined}
                    className="inline-flex items-center rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2"
                  >
                    {s.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right: activity timeline ── */}
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              Engagement History ({data.activity.length})
            </div>
            <button
              type="button"
              onClick={() => setShowLogForm((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-border-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
            >
              <Plus size={11} />
              Log Activity
            </button>
          </div>

          {showLogForm && (
            <LogActivityForm contactId={contactId} onClose={() => setShowLogForm(false)} />
          )}

          {data.activity.length === 0 ? (
            <div className="py-4 text-[13px] italic text-ink-4">
              No engagement history recorded yet.
            </div>
          ) : (() => {
            const jobsActivity = data.activity.filter((a) => a.is_jobs);
            const otherActivity = data.activity.filter((a) => !a.is_jobs);

            const renderActivityGroup = (
              items: typeof data.activity,
              dotColorClass: string,
            ) => (
              <div className="flex flex-col gap-0">
                {items.map((act, i) => {
                  const Icon = ACTIVITY_ICONS[act.type] ?? MessageSquare;
                  const actDate = act.activity_date ? new Date(act.activity_date) : null;
                  const isExpanded = expandedActivityId === act.id;
                  const preview = act.description
                    ? act.description.slice(0, 120) + (act.description.length > 120 ? "…" : "")
                    : null;

                  return (
                    <div key={act.id} className="relative flex gap-3 pb-4">
                      {i < items.length - 1 && (
                        <div className="absolute bottom-0 left-[15px] top-7 w-px bg-border-strong" />
                      )}
                      <div className={cn("z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border", dotColorClass)}>
                        <Icon size={13} className={act.is_jobs ? "text-accent-ink" : "text-stone-400"} />
                      </div>
                      <div
                        className="min-w-0 flex-1 cursor-pointer pt-1"
                        onClick={() => setExpandedActivityId(isExpanded ? null : act.id)}
                      >
                        <div className="mb-0.5 flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-medium capitalize text-ink">{act.type}</span>
                          {actDate && (
                            <span className="text-[11px] text-ink-4" title={format(actDate, "MMM d, yyyy")}>
                              {formatDistanceToNow(actDate, { addSuffix: true })}
                            </span>
                          )}
                          {act.logged_by && (
                            <span className="text-[11px] text-ink-4">· {ownerName(act.logged_by)}</span>
                          )}
                          <SourceBadge isJobs={act.is_jobs} source={act.source} />
                          {act.is_jobs && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteActivity(act.id);
                              }}
                              className="ml-auto rounded p-0.5 text-ink-4 transition-colors hover:text-red-500"
                              title="Delete activity"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                        {!isExpanded && preview && (
                          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">{preview}</p>
                        )}
                        {isExpanded && (
                          <div className="flex flex-col gap-1.5">
                            {act.description && (
                              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">{act.description}</p>
                            )}
                            {act.subject && (
                              <div className="text-[11px] text-ink-3">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">Subject: </span>
                                {act.subject}
                              </div>
                            )}
                            {act.email_from && (
                              <div className="text-[11px] text-ink-3">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">From: </span>
                                {act.email_from}
                              </div>
                            )}
                            {act.meeting_duration_minutes != null && (
                              <div className="text-[11px] text-ink-3">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">Duration: </span>
                                {act.meeting_duration_minutes}m
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );

            return (
              <div className="flex flex-col gap-4">
                {jobsActivity.length > 0 && (
                  <div>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent-ink">
                      Jobs Activity ({jobsActivity.length})
                    </div>
                    {renderActivityGroup(jobsActivity, "border-accent-soft bg-accent-soft")}
                  </div>
                )}
                {otherActivity.length > 0 && (
                  <div>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
                      Other Activity ({otherActivity.length})
                    </div>
                    {renderActivityGroup(otherActivity, "border-border-strong bg-surface")}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── Per-contact Tasks + Comments ── */}
          <div className="mt-6 flex flex-col gap-6 border-t border-border-strong pt-5">
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Tasks</div>
              <JobsTasks parentType="prospect" parentId={String(contactId)} />
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Comments</div>
              <JobsComments parentType="prospect" parentId={String(contactId)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Contacts tab — nested prospect list with inline stage edit ────────────────

function NestedContactRow({
  contact,
  expanded,
  onToggle,
}: {
  contact: AccountGroupContact;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <div
        onClick={onToggle}
        className={cn(
          "flex cursor-pointer items-center gap-3 border-b border-border-strong px-3 py-2.5 transition-colors last:border-0",
          expanded ? "bg-surface" : "bg-surface-2/40 hover:bg-surface",
        )}
      >
        <div className="flex-shrink-0 text-ink-4">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>

        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-ink">
          {initials(contact.full_name)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">
            {contact.full_name || "—"}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-ink-3">
            {contact.current_title || "—"}
          </div>
        </div>


        {/* Links — stop propagation so clicks don't toggle the row */}
        <div className="flex flex-shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="text-ink-3 transition-colors hover:text-accent" title={contact.email}>
              <Mail size={14} />
            </a>
          )}
          {contact.linkedin_url && (
            <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-ink-3 transition-colors hover:text-accent">
              <Linkedin size={14} />
            </a>
          )}
        </div>
      </div>

      {expanded && <ContactDetail contactId={contact.contact_id} />}
    </>
  );
}

function ContactsTab({ contacts }: { contacts: AccountGroupContact[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (contacts.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No contacts for this account.
      </div>
    );
  }

  return (
    <div className="overflow-hidden">
      {contacts.map((c) => (
        <NestedContactRow
          key={c.contact_id}
          contact={c}
          expanded={expandedId === c.contact_id}
          onToggle={() => setExpandedId((prev) => (prev === c.contact_id ? null : c.contact_id))}
        />
      ))}
    </div>
  );
}

// ── Activity roll-up — aggregates each contact's logged activity ──────────────

function AccountActivityTab({ contacts }: { contacts: AccountGroupContact[] }) {
  return (
    <div className="flex flex-col">
      {contacts.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-ink-3">No contacts for this account.</div>
      ) : (
        contacts.map((c) => <ContactActivityBlock key={c.contact_id} contact={c} />)
      )}
    </div>
  );
}

function ContactActivityBlock({ contact }: { contact: AccountGroupContact }) {
  const { data } = useContactDetail(contact.contact_id);
  const activity = data?.activity ?? [];
  if (activity.length === 0) return null;

  return (
    <div className="border-b border-border-strong px-4 py-3 last:border-0">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-ink">
          {initials(contact.full_name)}
        </div>
        <span className="text-[12px] font-semibold text-ink">{contact.full_name || "—"}</span>
        <span className="text-[11px] text-ink-4">({activity.length})</span>
      </div>
      <div className="flex flex-col gap-2 pl-8">
        {activity.slice(0, 8).map((act) => {
          const Icon = ACTIVITY_ICONS[act.type] ?? MessageSquare;
          const actDate = act.activity_date ? new Date(act.activity_date) : null;
          return (
            <div key={act.id} className="flex items-start gap-2">
              <Icon size={12} className="mt-0.5 flex-shrink-0 text-ink-4" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11.5px] font-medium capitalize text-ink-2">{act.type}</span>
                  {actDate && (
                    <span className="text-[11px] text-ink-4">{formatDistanceToNow(actDate, { addSuffix: true })}</span>
                  )}
                  <SourceBadge isJobs={act.is_jobs} source={act.source} />
                </div>
                {act.description && (
                  <p className="truncate text-[11.5px] text-ink-3">{act.description}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Account expand panel ──────────────────────────────────────────────────────

export function ProspectAccountExpandPanel({ group }: { group: AccountGroup }) {
  const key = useMemo(() => accountKey(group.account), [group.account]);

  return (
    <RowExpandPanel
      tabs={[
        {
          id: "contacts",
          label: "Contacts",
          count: group.contact_count,
          render: () => <ContactsTab contacts={group.contacts} />,
        },
        {
          id: "tasks",
          label: "Tasks",
          render: () => (
            <div className="px-4 py-3">
              <JobsTasks parentType="prospect" parentId={key} />
            </div>
          ),
        },
        {
          id: "comments",
          label: "Comments",
          render: () => (
            <div className="px-4 py-3">
              <JobsComments parentType="prospect" parentId={key} />
            </div>
          ),
        },
        {
          id: "activity",
          label: "Activity",
          render: () => <AccountActivityTab contacts={group.contacts} />,
        },
      ]}
    />
  );
}
