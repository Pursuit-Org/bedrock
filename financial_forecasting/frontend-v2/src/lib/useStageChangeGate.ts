import { useCallback, useRef, useState } from "react";

import { getStageGate, type StageGateSpec } from "@/lib/stageGates";
import { useUpdateOpportunityStage } from "@/services/opportunities";
import type { SfOpportunity } from "@/types/salesforce";

interface PendingGate {
  opp: SfOpportunity;
  toStage: string;
  spec: StageGateSpec;
}

/**
 * Wraps a stage-change request with the playbook's gate checklist.
 *
 *   const { request, pending, dismiss, complete } = useStageChangeGate();
 *   // In your inline-edit save: await request(opp, newStage)
 *   // In the render tree: {pending && <StageGateDialog .../>}
 *
 * Behavior:
 * - When `getStageGate(from, to)` returns null, fires the mutation
 *   directly and resolves on success.
 * - When a gate exists, returns a Promise that RESOLVES when the
 *   user confirms (and the stage update succeeds) and REJECTS when
 *   the user cancels / closes the dialog. The rejection lets the
 *   calling InlineSelect roll back its optimistic display so the
 *   cell shows the original stage again — otherwise the cell would
 *   look stuck on the new stage even though nothing was written.
 *
 * StageGateDialog calls `complete()` after a successful submit and
 * `dismiss()` on Cancel / Esc / backdrop click.
 */
interface PendingAwardSetup {
  awardId: string;
  opportunityId: string;
}

export function useStageChangeGate() {
  const [pending, setPending] = useState<PendingGate | null>(null);
  /** Set by the gate dialog when the background stage write returns
   *  with `award_created: true`. The page renders AwardSetupDialog
   *  from this state. Lives in the hook so it survives the
   *  StageGateDialog unmount (which happens before the background
   *  write completes — optimistic close). */
  const [awardSetup, setAwardSetup] = useState<PendingAwardSetup | null>(null);
  const updateStage = useUpdateOpportunityStage();
  const resolverRef = useRef<{
    resolve: () => void;
    reject: (err: Error) => void;
  } | null>(null);

  const request = useCallback(
    (opp: SfOpportunity, newStage: string): Promise<void> => {
      const fromStage = opp.StageName ?? "";
      const spec = getStageGate(fromStage, newStage, opp.RecordType?.Name);
      if (!spec) {
        // No gate — fire the mutation directly. Existing optimistic
        // update + awards handshake apply.
        return updateStage.mutateAsync({ id: opp.Id, newStage }).then(() => undefined);
      }
      return new Promise<void>((resolve, reject) => {
        resolverRef.current = { resolve, reject };
        setPending({ opp, toStage: newStage, spec });
      });
    },
    [updateStage],
  );

  /** Called by StageGateDialog when the user successfully completes
   *  the checklist + stage change. */
  const complete = useCallback(() => {
    resolverRef.current?.resolve();
    resolverRef.current = null;
    setPending(null);
  }, []);

  /** Called on Cancel / Esc / backdrop click. Rejects the outer
   *  promise so the caller (InlineSelect) reverts the optimistic
   *  display. */
  const dismiss = useCallback(() => {
    resolverRef.current?.reject(new Error("Stage change cancelled"));
    resolverRef.current = null;
    setPending(null);
  }, []);

  /** Called by StageGateDialog after a Contracting → Collecting / In
   *  Effect stage change comes back with `award_created`. Surfaces
   *  the follow-up award setup dialog. */
  const openAwardSetup = useCallback((awardId: string, opportunityId: string) => {
    setAwardSetup({ awardId, opportunityId });
  }, []);

  const dismissAwardSetup = useCallback(() => {
    setAwardSetup(null);
  }, []);

  return {
    pending,
    request,
    dismiss,
    complete,
    awardSetup,
    openAwardSetup,
    dismissAwardSetup,
  };
}
