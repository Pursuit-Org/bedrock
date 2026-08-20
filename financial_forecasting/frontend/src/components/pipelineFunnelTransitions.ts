/**
 * Pure helpers for classifying stage transitions on the Pipeline Funnel.
 * Kept in its own module (no MUI, no axios, no hooks) so it can be unit-tested
 * without pulling the entire component tree.
 */
import {
  OPEN_STAGES,
  WON_STAGES as CANONICAL_WON_STAGES,
  LOST_STAGES as CANONICAL_LOST_STAGES,
} from '../types/salesforce';

export type TransitionKind = 'forward' | 'backward' | 'won' | 'lost';

// Active (non-terminal) pipeline stages, in order. Re-exports OPEN_STAGES from
// types/salesforce.ts as the single source of truth for what the active funnel
// renders. Collecting / In Effect is intentionally NOT here — it's a terminal
// "won, payment in progress" stage that belongs in the Closed section of the
// Progress page (JP call, 2026-04-22).
export const ACTIVE_FUNNEL_STAGES: readonly string[] = OPEN_STAGES;

// Closed / terminal stages shown as a Closed group below the active funnel.
// Order is display order: positive outcomes first (Collecting → Completed),
// then negative (Lost → Withdrawn → Did not Fulfill). JP-confirmed 2026-04-22.
export const CLOSED_FUNNEL_STAGES = [
  'Collecting / In Effect',
  'Closed / Completed',
  'Closed Lost',
  'Withdrawn',
  'Closed / Did not Fulfill',
] as const;

export const STAGE_IDX = new Map<string, number>(
  ACTIVE_FUNNEL_STAGES.map((s, i) => [s, i]),
);

// Terminal stages — derived from the canonical sets in types/salesforce.ts so
// there's one source of truth. A transition INTO a terminal stage is a win
// or loss, not a backward move within the funnel.
export const WON_STAGES = new Set<string>(CANONICAL_WON_STAGES);
export const LOST_STAGES = new Set<string>(CANONICAL_LOST_STAGES);

export function classifyTransition(from: string, to: string): TransitionKind {
  if (WON_STAGES.has(to)) return 'won';
  if (LOST_STAGES.has(to)) return 'lost';
  const fi = STAGE_IDX.get(from) ?? -1;
  const ti = STAGE_IDX.get(to) ?? -1;
  // "Unclose" — from a known terminal (won/lost) back into an active stage.
  // Treat as a backward move: the opp is regressing out of a closed state.
  // Without this guard, since terminal stages aren't in STAGE_IDX, fi = -1
  // and any active target has ti >= 0, so the fallthrough below would
  // classify as 'forward' — wrong.
  if (fi < 0 && ti >= 0 && (WON_STAGES.has(from) || LOST_STAGES.has(from))) {
    return 'backward';
  }
  // A stage unknown to every set (not active, not won, not lost) silently
  // falls into 'backward' below. That's benign for legitimate moves within
  // the funnel, but it also masks a newly-added Salesforce stage that
  // wasn't added to any canonical set here. Surface it in dev so someone
  // notices; production stays silent (no user-visible breakage).
  if (ti < 0) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        `[pipelineFunnelTransitions] Unknown target stage "${to}". ` +
        `Not in ACTIVE_FUNNEL_STAGES, WON_STAGES, or LOST_STAGES — falling through to "backward". ` +
        `If this is a new stage, update types/salesforce.ts and the sets in this file.`,
      );
    }
  }
  return ti > fi ? 'forward' : 'backward';
}
