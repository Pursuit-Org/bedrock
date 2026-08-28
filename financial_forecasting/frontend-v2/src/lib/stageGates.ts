/**
 * Stage-gate rules — playbook checklists that must be completed
 * before certain stage transitions are allowed.
 *
 * Each gate is a pure function of (fromStage, toStage). The
 * StageGateDialog reads the returned spec and renders the matching
 * checklist. If `getStageGate` returns null, the transition is
 * unrestricted and the standard mutation fires directly.
 *
 * Multi-stage jumps (e.g. New Lead → Contracting) aggregate the
 * checklists from every intermediate transition the playbook would
 * have forced — `getStageGate` returns the union so a single dialog
 * still enforces everything the user would have hit step-by-step.
 */
import { STAGE_RANK } from "@/lib/stages";

/** Which checklist items the gate requires. */
export interface StageGateSpec {
  id:
    | "ask-in-progress-exit"
    | "proposal-to-contracting"
    | "contracting-to-collecting"
    | "withdrawn"
    | "closed-lost"
    | "multi-step";
  title: string;
  description: string;
  /** Confirm + edit Close Date. */
  confirmCloseDate?: boolean;
  /** Confirm + edit Amount. */
  confirmAmount?: boolean;
  /** Confirm + edit Probability (writes both Probability and the
   *  Manager_Probability_Override__c custom field). */
  confirmProbability?: boolean;
  /** Show the payment-schedule builder. */
  confirmPaymentSchedule?: boolean;
  /** File pickers tied to filename hints (e.g. "proposal" /
   *  "contract"). The user must have at least one matching file
   *  attached to the opp before the gate's primary button enables.
   *  An array so multi-step jumps can require multiple attachments
   *  in the same dialog. */
  fileAttachments?: Array<{
    label: string;
    hint: string;
  }>;
  /** Free-text close/withdrawal reason. */
  closeReason?: boolean;
  /** The SF field to write the reason to. Defaults to
   *  npsp__Closed_Lost_Reason__c when omitted. */
  closeReasonField?: string;
}

const PURSUIT_CHECKLIST_BODY: Pick<
  StageGateSpec,
  "confirmCloseDate" | "confirmAmount" | "confirmProbability" | "confirmPaymentSchedule" | "fileAttachments"
> = {
  confirmCloseDate: true,
  confirmAmount: true,
  confirmProbability: true,
  confirmPaymentSchedule: true,
  fileAttachments: [{ label: "Proposal", hint: "proposal" }],
};

/** Inverse of STAGE_RANK — find the canonical stage name at a rank.
 *  Picks the first match when multiple stages share a rank (e.g.
 *  Closed / Completed and Closed Won both = 6); we only walk forward
 *  through the pipeline so duplicates at terminal ranks don't matter. */
function stageAtRank(rank: number): string | null {
  for (const [name, r] of Object.entries(STAGE_RANK)) {
    if (r === rank) return name;
  }
  return null;
}

/** Resolve the gate for a SINGLE direct transition. Used by the
 *  aggregator below — not exported because callers should always go
 *  through getStageGate, which handles multi-stage jumps. */
function singleStepGate(fromStage: string, toStage: string): StageGateSpec | null {
  // Contracting → Collecting / In Effect — final contract + finalize
  // close date, amount, and payment schedule so the auto-generated
  // award starts with the right financial picture.
  if (fromStage === "Contracting" && toStage === "Collecting / In Effect") {
    return {
      id: "contracting-to-collecting",
      title: "Finalize the deal before moving to Collecting / In Effect",
      description: "Attach the executed contract and confirm the close date, amount, and payment schedule. The award record auto-generates on save — the values you confirm here become its starting state.",
      fileAttachments: [{ label: "Signed contract", hint: "contract" }],
      confirmCloseDate: true,
      confirmAmount: true,
      // Backend's _validate_stage_change_logic enforces a payment
      // schedule exists with matching total before this transition.
      // Surfacing it here lets the user verify in one place instead
      // of failing the gate, fixing the schedule, then retrying.
      confirmPaymentSchedule: true,
    };
  }

  // Proposal Submitted → Contracting — full pursuit checklist.
  if (fromStage === "Proposal Submitted" && toStage === "Contracting") {
    return {
      id: "proposal-to-contracting",
      title: "Confirm proposal details before moving to Contracting",
      description: "Verify close date, amount, probability, and payment schedule reflect what's being contracted. Attach the latest proposal for the file record.",
      ...PURSUIT_CHECKLIST_BODY,
    };
  }

  // Ask in Progress → anything later in the funnel — full pursuit checklist.
  // Single-step version: fires on Ask in Progress → Proposal Submitted
  // (the next rank up). Skipping further ahead is handled by the
  // aggregator, which still picks this gate up via the same call.
  if (fromStage === "Ask in Progress" && toStage === "Proposal Submitted") {
    return {
      id: "ask-in-progress-exit",
      title: "Confirm proposal details before advancing past Ask in Progress",
      description: "An ask is becoming a real deal. Verify the close date, amount, probability, and payment schedule are accurate, and attach the proposal.",
      ...PURSUIT_CHECKLIST_BODY,
    };
  }

  return null;
}

/** Merge N gate specs into a single composite. Used when the user
 *  skips multiple stages at once — the dialog enforces every gate
 *  that would have fired along the way without making them click
 *  through N modals. */
function mergeGates(
  gates: StageGateSpec[],
  fromStage: string,
  toStage: string,
): StageGateSpec {
  // Dedupe file attachments by hint so we don't render two identical
  // pickers if the same attachment is required by two gates.
  const fileMap = new Map<string, { label: string; hint: string }>();
  for (const g of gates) {
    for (const f of g.fileAttachments ?? []) {
      if (!fileMap.has(f.hint)) fileMap.set(f.hint, f);
    }
  }
  return {
    id: "multi-step",
    title: `Confirm details for moving from ${fromStage} to ${toStage}`,
    description: `You're skipping ahead ${gates.length} playbook step${gates.length === 1 ? "" : "s"}. Complete the combined checklist below — everything below is enforced for at least one of the stages you're crossing.`,
    confirmCloseDate: gates.some((g) => g.confirmCloseDate),
    confirmAmount: gates.some((g) => g.confirmAmount),
    confirmProbability: gates.some((g) => g.confirmProbability),
    confirmPaymentSchedule: gates.some((g) => g.confirmPaymentSchedule),
    fileAttachments: [...fileMap.values()],
    closeReason: gates.some((g) => g.closeReason),
  };
}

export function getStageGate(fromStage: string | null | undefined, toStage: string): StageGateSpec | null {
  if (!fromStage) return null;

  // Terminal closing states — single gate regardless of from. Don't
  // aggregate with anything else; closing means the user has made up
  // their mind and we only need the close-reason capture.
  if (toStage === "Withdrawn") {
    return {
      id: "withdrawn",
      title: "Mark opportunity as withdrawn",
      description: "Briefly note why this opportunity is being withdrawn. This helps the team understand trends and provides context for future interactions.",
      closeReason: true,
      closeReasonField: "Withdrawn_Reason__c",
    };
  }
  if (toStage === "Closed Lost") {
    return {
      id: "closed-lost",
      title: "Mark opportunity as closed lost",
      description: "Capture the loss reason for trend analysis. This helps the team understand what's driving closed lost outcomes.",
      closeReason: true,
    };
  }

  const fromRank = STAGE_RANK[fromStage] ?? -1;
  const toRank = STAGE_RANK[toStage] ?? -1;

  // Backward / same-stage moves get no gate.
  if (toRank <= fromRank || fromRank < 0) return null;

  // Walk every intermediate single-step transition and collect each
  // single-step gate's spec. Skipping ahead can only ADD requirements
  // (you can't unblock by leapfrogging).
  const subGates: StageGateSpec[] = [];
  for (let r = fromRank; r < toRank; r++) {
    const from = stageAtRank(r);
    const to = stageAtRank(r + 1);
    if (!from || !to) continue;
    const g = singleStepGate(from, to);
    if (g) subGates.push(g);
  }

  if (subGates.length === 0) return null;
  if (subGates.length === 1) return subGates[0];
  return mergeGates(subGates, fromStage, toStage);
}
