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
 */
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  useStageVocabulary, useUpdateJobsMembership,
  MEMBERSHIP_STAGES, MEMBERSHIP_STAGE_LABELS,
  type MembershipStage,
} from "@/services/jobs";
import { RevisitDialog } from "@/components/jobs/RevisitDialog";

const FALLBACK = MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] }));

export function useContactStageChange() {
  const update = useUpdateJobsMembership();
  const { data: vocab } = useStageVocabulary();
  const [pending, setPending] = useState<{ id: number; name: string } | null>(null);
  // The caller's promise, parked while the Revisit dialog is open. InlineSelect
  // paints its optimistic value as soon as it calls us and only rolls it back
  // if the promise REJECTS, so resolving early made "Revisit → Cancel" leave
  // the cell reading Revisit — with a saved checkmark — over a row the database
  // never changed. It stayed wrong until the row unmounted, because
  // InlineSelect only clears the optimistic value once the server value catches
  // up, which after a cancel it never does.
  const resolverRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

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
  const change = (contactId: number, name: string, stage: string) =>
    new Promise<void>((resolve, reject) => {
      if (stage === "revisit") {
        // Only one dialog can be open; if another row somehow got here first,
        // release its caller rather than stranding a promise that never settles.
        settle("reject");
        resolverRef.current = { resolve, reject };
        setPending({ id: contactId, name });
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

  /** Render this somewhere in the calling component's tree. */
  const dialog = pending ? (
    <RevisitDialog
      contactName={pending.name}
      onCancel={() => {
        setPending(null);
        settle("reject");
      }}
      onSave={(date) => {
        const { id, name } = pending;
        setPending(null);
        update.mutate({ contact_id: id, stage: "revisit", revisit_date: date }, {
          onSuccess: () => {
            toast.success(`${name} set to revisit on ${date} — task filed for the owner`);
            settle("resolve");
          },
          // The mutation's own onError already toasts the reason; rejecting
          // here is what rolls the cell back off "Revisit".
          onError: () => settle("reject"),
        });
      }}
    />
  ) : null;

  return { options, change, dialog, isPending: update.isPending };
}
