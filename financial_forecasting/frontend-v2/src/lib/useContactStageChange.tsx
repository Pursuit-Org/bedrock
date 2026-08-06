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
import { useState } from "react";
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

  /** Stages the database currently accepts, labelled. */
  const options: { value: string; label: string }[] = vocab?.membership_stages ?? FALLBACK;

  /**
   * Move a contact to `stage`. Returns a promise that settles when the write is
   * done — or immediately, for Revisit, once the dialog is open (the write then
   * happens on save). Callers using InlineSelect need the promise to settle so
   * the control leaves its saving state.
   */
  const change = (contactId: number, name: string, stage: string) =>
    new Promise<void>((resolve, reject) => {
      if (stage === "revisit") {
        setPending({ id: contactId, name });
        return resolve();
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
      onCancel={() => setPending(null)}
      onSave={(date) => {
        const { id, name } = pending;
        setPending(null);
        update.mutate({ contact_id: id, stage: "revisit", revisit_date: date }, {
          onSuccess: () => toast.success(`${name} set to revisit on ${date} — task filed for the owner`),
        });
      }}
    />
  ) : null;

  return { options, change, dialog, isPending: update.isPending };
}
