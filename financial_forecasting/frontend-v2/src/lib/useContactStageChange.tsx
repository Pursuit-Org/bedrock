/**
 * Changing a contact's jobs stage, in one place.
 *
 * Four screens can move a contact through the funnel (Jobs Home, Contacts,
 * Outreach's stuck queue, and the contact drawer). Two rules have to hold at all
 * of them, and duplicating them four times is how they drift apart:
 *
 *  1. Only offer stages the database will accept. The 2026-08-05 stage migration
 *     is applied out-of-band, so `revisit` and `call_booked` are rejected by the
 *     CHECK constraint until it lands. Offering them early means a save that
 *     fails for whoever clicks it.
 *  2. Revisit must ask for a date. That date is the entire reason Revisit exists
 *     rather than the On Hold it replaces — it files a task so the contact comes
 *     back. Setting the stage without one recreates the problem.
 *  3. Converted must name its opportunity (D15, PRO-101): pick one at the
 *     contact's account, or create one with the contact on it. The API refuses
 *     a conversion without one.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  useCreateOpportunity, useStageVocabulary, useUpdateJobsMembership,
  MEMBERSHIP_STAGES, MEMBERSHIP_STAGE_LABELS,
  type JobsOpportunity, type MembershipStage,
} from "@/services/jobs";
import { ConvertDialog, type ConvertChoice } from "@/components/jobs/ConvertDialog";
import { RevisitDialog } from "@/components/jobs/RevisitDialog";

/** Stages that ask something first: Revisit a date, Converted its opportunity. */
const DIALOG_STAGES = new Set(["revisit", "converted_to_opportunity"]);

const FALLBACK = MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] }));

export function useContactStageChange() {
  const update = useUpdateJobsMembership();
  const createOpp = useCreateOpportunity();
  const { data: vocab } = useStageVocabulary();
  const [pending, setPending] = useState<{
    id: number; name: string; stage: "revisit" | "converted_to_opportunity";
    ensure?: () => Promise<unknown>; company?: string | null;
  } | null>(null);
  // The caller's promise, parked while the Revisit dialog is open. InlineSelect
  // paints its optimistic value as soon as it calls us and only rolls it back
  // if the promise REJECTS, so resolving early made "Revisit → Cancel" leave
  // the cell reading Revisit — with a saved checkmark — over a row the database
  // never changed. It stayed wrong until the row unmounted, because
  // InlineSelect only clears the optimistic value once the server value catches
  // up, which after a cancel it never does.
  const resolverRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  // An opportunity created in the Convert dialog whose conversion then failed,
  // by contact: a retry links it instead of creating a second one.
  const createdRef = useRef(new Map<number, string>());

  const settle = (fn: "resolve" | "reject") => {
    const r = resolverRef.current;
    resolverRef.current = null;
    if (!r) return;
    if (fn === "resolve") r.resolve();
    else r.reject(new Error("cancelled"));
  };

  /** The target vocabulary, with anything the database can't accept yet marked
   *  disabled rather than dropped — so Call Booked and Revisit are visibly on
   *  their way instead of looking unbuilt. */
  const options: { value: string; label: string; disabled?: boolean; title?: string }[] =
    vocab?.membership_stages.map((o) => ({
      value: o.value,
      label: o.label,
      disabled: !o.available,
      title: o.unavailable_reason ?? undefined,
    })) ?? FALLBACK;

  /**
   * Move a contact to `stage`. The returned promise settles only when the write
   * is actually done.
   *
   * For Revisit that means it stays pending for as long as the dialog is open,
   * and rejects if the user cancels — which is what rolls an InlineSelect's
   * optimistic value back. Resolving when the dialog merely OPENED was the bug.
   */
  /**
   * @param ensure  For a contact with NO membership row yet. PATCH
   *   /jobs-membership is UPDATE-only and 404s on a missing row, so those
   *   pickers have to create the membership first — pass the call that does it
   *   and the dialog will run it before writing the date. Omit when the contact
   *   already has a stage.
   */
  /** @param company  The contact's company, to find and prefill its account's
   *   opportunities when converting. */
  const change = (contactId: number, name: string, stage: string,
                  ensure?: () => Promise<unknown>, company?: string | null) =>
    new Promise<void>((resolve, reject) => {
      if (stage === "revisit" || stage === "converted_to_opportunity") {
        // Only one dialog can be open; if another row somehow got here first,
        // release its caller rather than stranding a promise that never settles.
        settle("reject");
        resolverRef.current = { resolve, reject };
        setPending({ id: contactId, name, stage, ensure, company });
        return;
      }
      update.mutate({ contact_id: contactId, stage }, {
        onSuccess: () => {
          toast.success(`Moved ${name} to ${MEMBERSHIP_STAGE_LABELS[stage as MembershipStage] ?? stage}`);
          resolve();
        },
        onError: reject,
      });
    });

  const convert = async ({ opportunityIds, create }: ConvertChoice) => {
    if (!pending) return;
    const { id, name, ensure } = pending;
    setPending(null);
    try {
      if (ensure) await ensure();
      const ids = [...opportunityIds];
      const already = createdRef.current.get(id);
      if (create && already) {
        ids.push(already);
      } else if (create) {
        const created = await createOpp.mutateAsync({
          account_id: "UNKNOWN",
          account_name: create.account_name.trim(),
          deal_type: create.deal_type,
          title: create.title.trim() || undefined,
          target_close_date: create.target_close_date,
          sf_contact_ids: [`pub:${id}`],
        } as Partial<JobsOpportunity>);
        if (created?.id) {
          ids.push(created.id);
          createdRef.current.set(id, created.id);
        }
      }
      await update.mutateAsync({ contact_id: id, stage: "converted_to_opportunity", opportunity_ids: ids });
      createdRef.current.delete(id);
      toast.success(`${name} converted — linked to ${ids.length} opportunit${ids.length === 1 ? "y" : "ies"}`);
      settle("resolve");
    } catch {
      // The mutations toast their own reason; rejecting rolls the cell back.
      settle("reject");
    }
  };

  /** Render this somewhere in the calling component's tree. */
  const dialog = pending?.stage === "converted_to_opportunity" ? (
    <ConvertDialog
      contactId={pending.id}
      contactName={pending.name}
      company={pending.company}
      onCancel={() => {
        setPending(null);
        settle("reject");
      }}
      onSave={convert}
    />
  ) : pending ? (
    <RevisitDialog
      contactName={pending.name}
      onCancel={() => {
        setPending(null);
        settle("reject");
      }}
      onSave={async (date) => {
        const { id, name, ensure } = pending;
        setPending(null);
        try {
          // Create the membership first when there isn't one — otherwise the
          // PATCH below 404s and the contact silently keeps no stage.
          if (ensure) await ensure();
          await update.mutateAsync({ contact_id: id, stage: "revisit", revisit_date: date });
          toast.success(`${name} set to revisit on ${date} — task filed for the owner`);
          settle("resolve");
        } catch {
          // Both mutations toast their own reason; rejecting here is what rolls
          // the cell back off "Revisit".
          settle("reject");
        }
      }}
    />
  ) : null;

  /** True when `change` opens a dialog for this stage instead of writing. */
  const needsDialog = (stage: string) => DIALOG_STAGES.has(stage);

  return { options, change, dialog, needsDialog, isPending: update.isPending || createOpp.isPending };
}
