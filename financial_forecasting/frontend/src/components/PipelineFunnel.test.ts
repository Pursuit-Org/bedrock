import {
  ACTIVE_FUNNEL_STAGES,
  CLOSED_FUNNEL_STAGES,
  classifyTransition,
  WON_STAGES,
  LOST_STAGES,
} from './pipelineFunnelTransitions';

// Pipeline stage transition classifier — exercises the logic that was
// previously misbucketing wins as setbacks because terminal stages aren't
// in ACTIVE_FUNNEL_STAGES.

describe('classifyTransition', () => {
  describe('wins', () => {
    it('classifies Collecting → Closed / Completed as won', () => {
      expect(classifyTransition('Collecting / In Effect', 'Closed / Completed')).toBe('won');
    });

    it('classifies Qualifying → Closed / Completed as won (skipping stages)', () => {
      expect(classifyTransition('Qualifying', 'Closed / Completed')).toBe('won');
    });

    it('classifies Lead Gen → Closed / Completed as won (instant close)', () => {
      expect(classifyTransition('Lead Gen', 'Closed / Completed')).toBe('won');
    });

    it('classifies any stage → Closed Won as won (Donorbox philanthropy)', () => {
      expect(classifyTransition('Qualifying', 'Closed Won')).toBe('won');
      expect(classifyTransition('Lead Gen', 'Closed Won')).toBe('won');
    });

    it('classifies any stage → Collecting / In Effect as won (signed contract = 100% prob)', () => {
      expect(classifyTransition('Proposal Negotiation', 'Collecting / In Effect')).toBe('won');
      expect(classifyTransition('Lead Gen', 'Collecting / In Effect')).toBe('won');
    });
  });

  describe('losses', () => {
    it('classifies Contract Creation → Closed Lost as lost', () => {
      expect(classifyTransition('Contract Creation', 'Closed Lost')).toBe('lost');
    });

    it('classifies Qualifying → Withdrawn as lost', () => {
      expect(classifyTransition('Qualifying', 'Withdrawn')).toBe('lost');
    });

    it('classifies Proposal Negotiation → Closed / Did not Fulfill as lost', () => {
      expect(classifyTransition('Proposal Negotiation', 'Closed / Did not Fulfill')).toBe('lost');
    });
  });

  describe('forward (within active funnel)', () => {
    it('classifies Qualifying → Proposal Negotiation as forward', () => {
      expect(classifyTransition('Qualifying', 'Proposal Negotiation')).toBe('forward');
    });

    it('classifies Lead Gen → Contract Creation as forward (skipping stages)', () => {
      expect(classifyTransition('Lead Gen', 'Contract Creation')).toBe('forward');
    });
  });

  describe('backward (within active funnel)', () => {
    it('classifies Contract Creation → Qualifying as backward', () => {
      expect(classifyTransition('Contract Creation', 'Qualifying')).toBe('backward');
    });

    it('classifies Collecting / In Effect → Proposal Negotiation as backward', () => {
      expect(classifyTransition('Collecting / In Effect', 'Proposal Negotiation')).toBe('backward');
    });
  });

  describe('terminal-state registry', () => {
    it('treats Collecting / In Effect, Closed / Completed, and Closed Won as win stages', () => {
      expect(WON_STAGES.has('Collecting / In Effect')).toBe(true);
      expect(WON_STAGES.has('Closed / Completed')).toBe(true);
      expect(WON_STAGES.has('Closed Won')).toBe(true);
      expect(WON_STAGES.has('Closed Lost')).toBe(false);
      expect(WON_STAGES.has('Withdrawn')).toBe(false);
    });

    it('includes Closed Lost, Withdrawn, and Closed / Did not Fulfill as loss stages', () => {
      expect(LOST_STAGES.has('Closed Lost')).toBe(true);
      expect(LOST_STAGES.has('Withdrawn')).toBe(true);
      expect(LOST_STAGES.has('Closed / Did not Fulfill')).toBe(true);
      expect(LOST_STAGES.has('Closed / Completed')).toBe(false);
      expect(LOST_STAGES.has('Closed Won')).toBe(false);
    });
  });

  // Regression guard: a stage that Pursuit adds to Salesforce later but
  // forgets to add to ACTIVE_FUNNEL_STAGES / WON_STAGES / LOST_STAGES
  // used to silently render as a "setback" in the funnel. The fallback
  // still returns 'backward' (for UI stability), but we now log a dev
  // warning so the omission gets noticed. These cases pin the behavior.
  describe('unknown stages (future-added / legacy)', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('classifies unknown-from → known-active as forward (treats pre-funnel origin as 0)', () => {
      expect(classifyTransition('LegacyPreFunnelStage', 'Qualifying')).toBe('forward');
    });

    it('classifies known-active → unknown-target as backward AND warns in dev', () => {
      expect(classifyTransition('Qualifying', 'Paused_NewStage')).toBe('backward');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown target stage "Paused_NewStage"'),
      );
    });

    it('classifies both-unknown as backward AND warns in dev', () => {
      expect(classifyTransition('LegacyA', 'LegacyB')).toBe('backward');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('does not warn when target is a known terminal (won: Closed / Completed)', () => {
      classifyTransition('Qualifying', 'Closed / Completed');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when target is Closed Won (Donorbox philanthropy, known win)', () => {
      classifyTransition('Qualifying', 'Closed Won');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when target is Collecting / In Effect (known win)', () => {
      classifyTransition('Lead Gen', 'Collecting / In Effect');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when target is a known terminal (lost)', () => {
      classifyTransition('Qualifying', 'Closed Lost');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // A5 Progress funnel split (mega-B, 2026-04-22): Collecting / In Effect was
  // removed from ACTIVE_FUNNEL_STAGES and lives in CLOSED_FUNNEL_STAGES. The
  // classifier still treats INTO-Collecting as 'won' (WON_STAGES unchanged),
  // and adds an "unclose" guard so FROM-terminal BACK TO active reads as
  // 'backward' (would otherwise misclassify as 'forward' because terminal
  // stages aren't in STAGE_IDX → fi=-1).
  describe('A5 funnel split — terminal unclose regressions', () => {
    it('classifies Collecting / In Effect → Proposal Negotiation as backward (post-split)', () => {
      // Was backward when Collecting was in STAGE_IDX (fi=7, ti=4). After the
      // split, fi=-1 and the new guard catches this as a known-terminal
      // regression.
      expect(classifyTransition('Collecting / In Effect', 'Proposal Negotiation')).toBe('backward');
    });

    it('classifies Closed / Completed → Qualifying as backward (win regression)', () => {
      expect(classifyTransition('Closed / Completed', 'Qualifying')).toBe('backward');
    });

    it('classifies Closed Lost → Proposal Negotiation as backward (loss regression)', () => {
      expect(classifyTransition('Closed Lost', 'Proposal Negotiation')).toBe('backward');
    });

    it('classifies Withdrawn → Contract Creation as backward (loss regression)', () => {
      expect(classifyTransition('Withdrawn', 'Contract Creation')).toBe('backward');
    });
  });

  describe('A5 funnel split — exports', () => {
    it('ACTIVE_FUNNEL_STAGES has 7 stages and excludes Collecting / In Effect', () => {
      expect(ACTIVE_FUNNEL_STAGES.length).toBe(7);
      expect(ACTIVE_FUNNEL_STAGES.includes('Collecting / In Effect' as any)).toBe(false);
      // Sanity: the 7 open stages we expect
      expect(ACTIVE_FUNNEL_STAGES.includes('Lead Gen' as any)).toBe(true);
      expect(ACTIVE_FUNNEL_STAGES.includes('Negotiating Contract' as any)).toBe(true);
    });

    it('CLOSED_FUNNEL_STAGES has 5 SF-canonical terminal stages in display order', () => {
      expect(CLOSED_FUNNEL_STAGES).toEqual([
        'Collecting / In Effect',
        'Closed / Completed',
        'Closed Lost',
        'Withdrawn',
        'Closed / Did not Fulfill',
      ]);
    });

    it('ACTIVE and CLOSED sets are disjoint (no stage in both)', () => {
      const activeSet = new Set<string>(ACTIVE_FUNNEL_STAGES);
      for (const stage of CLOSED_FUNNEL_STAGES) {
        expect(activeSet.has(stage)).toBe(false);
      }
    });
  });
});
