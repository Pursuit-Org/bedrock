/**
 * The jobs fields the Contacts list edits inline: owner, jobs stage, tags and
 * the jobs-prospect flag, as labelled fields for the contact detail page and
 * the contact drawer (Kwame 2026-09-24).
 *
 * Same hooks and endpoints as the list row, so a value set in one place reads
 * the same in the other and the two cannot drift into different rules:
 *   owner    → PATCH /contacts/{id} {owner_email}      (public.contacts owner)
 *   stage    → PATCH /contacts/{id}/jobs-membership, or POST /contacts/flag-jobs
 *              when there is no membership yet (the PATCH is update-only)
 *   tags     → PATCH /contacts/{id} {tags}
 *   prospect → POST/DELETE /contacts/{id}/add-to-jobs
 */
import { useMemo, useState } from "react";

import { EditField } from "@/components/detail";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { useContactStageChange } from "@/lib/useContactStageChange";
import { cn } from "@/lib/utils";
import {
  useAddContactToJobs, useContactTagCatalog, useFlagContactsForJobs, useStaff, useUpdateContact,
  MEMBERSHIP_STAGE_LABELS, type MembershipStage,
} from "@/services/jobs";

/** Humanize a tag slug so chips never flash the raw slug (e.g.
 *  "prior_commit_partner") while the catalog query is still loading. */
export function humanizeTag(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Tag chips that open a checkbox popover. Positioned `fixed` so it escapes a
 *  table cell's overflow on the list and a drawer's scroll area on detail. */
export function ContactTagsEditor({ contactId, tags }: { contactId: number; tags: string[] }) {
  const { data: catalog = [] } = useContactTagCatalog();
  const update = useUpdateContact();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [draft, setDraft] = useState<string[]>([]);
  const labels = useMemo(() => Object.fromEntries(catalog.map((t) => [t.slug, t.label])), [catalog]);
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="Edit tags"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ top: r.bottom + 4, left: r.left });
          setDraft(tags);
          setOpen((v) => !v);
        }}
        className="flex min-h-[20px] w-full flex-wrap items-center gap-1 text-left"
      >
        {tags.length > 0
          ? tags.map((t) => <span key={t} className="truncate rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">{labels[t] ?? humanizeTag(t)}</span>)
          : <span className="text-[12px] text-ink-4">—</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div style={{ position: "fixed", top: pos.top, left: pos.left }} className="z-50 max-h-72 w-60 overflow-auto rounded-md border border-border-strong bg-surface p-2 shadow-xl">
            {catalog.map((t) => (
              <label key={t.slug} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
                <input type="checkbox" checked={draft.includes(t.slug)} onChange={() => setDraft((d) => d.includes(t.slug) ? d.filter((x) => x !== t.slug) : [...d, t.slug])} className="h-3.5 w-3.5 accent-[color:var(--accent,#4242EA)]" />
                {t.label}
              </label>
            ))}
            <div className="mt-1 flex items-center justify-end gap-2 border-t border-border-strong pt-1.5">
              <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-3 hover:text-ink">Cancel</button>
              <button type="button" disabled={update.isPending}
                onClick={() => update.mutate({ id: contactId, tags: draft }, { onSuccess: () => setOpen(false) })}
                className="rounded bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">
                {update.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export interface ContactJobsFieldsValue {
  contact_id: number;
  full_name: string | null;
  owner_email?: string | null;
  membership_stage?: string | null;
  crm_tags?: string[];
  is_jobs_contact?: boolean;
}

/** Owner, jobs stage, tags and prospect as EditFields. Renders a fragment so
 *  the caller's grid lays them out alongside its own fields. */
export function ContactJobsFields({ contact }: { contact: ContactJobsFieldsValue }) {
  const updateContact = useUpdateContact();
  const addToJobs = useAddContactToJobs();
  const flagOne = useFlagContactsForJobs();
  const stageChange = useContactStageChange();
  const { data: staffList = [] } = useStaff();
  const staffOptions = useMemo(
    () => [{ value: "", label: "—" }, ...staffList.map((s) => ({ value: s.email, label: s.name }))],
    [staffList],
  );
  const staffName = (email: string | null | undefined) =>
    staffList.find((s) => s.email === email)?.name ?? email ?? "—";
  const id = contact.contact_id;
  const name = contact.full_name ?? "contact";
  const stage = contact.membership_stage ?? "";
  const stageChip = (v: string | null | undefined) =>
    v ? <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-ink">{MEMBERSHIP_STAGE_LABELS[v as MembershipStage] ?? v}</span>
      : <span className="text-[12.5px] text-ink-4">—</span>;

  return (
    <>
      <EditField label="Owner">
        <InlineSelect<string>
          value={contact.owner_email ?? ""}
          options={staffOptions}
          renderValue={(v) => {
            const email = (v || contact.owner_email) || null;
            return <span className={cn("truncate text-[12.5px]", email ? "text-ink-2" : "text-ink-4")}>{email ? staffName(email) : "—"}</span>;
          }}
          onSave={(v) => updateContact.mutateAsync({ id, owner_email: v || null }).then(() => undefined)}
        />
      </EditField>
      <EditField label="Jobs stage">
        <InlineSelect<string>
          value={stage}
          options={stageChange.options}
          emptyLabel="—"
          renderValue={(v) => stageChip(v || stage)}
          onSave={(v) => {
            if (!v) return Promise.resolve();
            // With a membership, the shared handler writes the stage (and asks
            // for a date on Revisit). Without one, the membership has to be
            // created first, because PATCH /jobs-membership is update-only.
            if (stage) return stageChange.change(id, name, v);
            if (v === "revisit") {
              return stageChange.change(id, name, v,
                () => flagOne.mutateAsync({ contact_ids: [id], stage: v }));
            }
            return flagOne.mutateAsync({ contact_ids: [id], stage: v }).then(() => undefined);
          }}
        />
      </EditField>
      <EditField label="Tags">
        <ContactTagsEditor contactId={id} tags={contact.crm_tags ?? []} />
      </EditField>
      <EditField label="Jobs prospect">
        <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={!!contact.is_jobs_contact}
            disabled={addToJobs.isPending}
            onChange={() => addToJobs.mutate({ id, add: !contact.is_jobs_contact })}
            className="h-4 w-4 accent-[color:var(--accent,#4242EA)]"
          />
          {contact.is_jobs_contact ? "In the jobs pipeline" : "Not a prospect"}
        </label>
      </EditField>
      {/* Revisit asks for a date in a dialog, rendered once for this contact. */}
      {stageChange.dialog}
    </>
  );
}
