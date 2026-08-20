import {
  classifyField,
  validateDateBounds,
} from './fieldSensitivity';

describe('classifyField', () => {
  describe('safe fields', () => {
    it('Opportunity Name is safe', () => {
      expect(classifyField('Opportunity', 'Name').sensitivity).toBe('safe');
    });
    it('Opportunity NextStep is safe', () => {
      expect(classifyField('Opportunity', 'NextStep').sensitivity).toBe('safe');
    });
    it('Account Phone is safe', () => {
      expect(classifyField('Account', 'Phone').sensitivity).toBe('safe');
    });
    it('Contact Email is safe', () => {
      expect(classifyField('Contact', 'Email').sensitivity).toBe('safe');
    });
    it('Milestone status / phase / due_date are safe', () => {
      expect(classifyField('Milestone', 'status').sensitivity).toBe('safe');
      expect(classifyField('Milestone', 'phase').sensitivity).toBe('safe');
      expect(classifyField('Milestone', 'due_date').sensitivity).toBe('safe');
    });
    it('Task Status / Priority / Subject are safe', () => {
      expect(classifyField('Task', 'Status').sensitivity).toBe('safe');
      expect(classifyField('Task', 'Priority').sensitivity).toBe('safe');
      expect(classifyField('Task', 'Subject').sensitivity).toBe('safe');
    });
    // A9 (mega-B, 2026-04-22): Amount + Probability softened from
    // 'sensitive' to 'safe' — RM daily-edit velocity. StageName stays
    // sensitive (sf_stages_sacred).
    it('Opportunity Amount is safe (softened in A9)', () => {
      expect(classifyField('Opportunity', 'Amount').sensitivity).toBe('safe');
    });
    it('Opportunity Probability is safe (softened in A9)', () => {
      expect(classifyField('Opportunity', 'Probability').sensitivity).toBe('safe');
    });
  });

  describe('sensitive fields', () => {
    it('Opportunity Stage is sensitive', () => {
      const c = classifyField('Opportunity', 'StageName');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toBeTruthy();
    });
    it('Opportunity OwnerId is sensitive', () => {
      expect(classifyField('Opportunity', 'OwnerId').sensitivity).toBe('sensitive');
    });
    it('Opportunity AccountId is sensitive', () => {
      expect(classifyField('Opportunity', 'AccountId').sensitivity).toBe('sensitive');
    });
    it('Opportunity PaymentDate__c is sensitive', () => {
      expect(classifyField('Opportunity', 'PaymentDate__c').sensitivity).toBe('sensitive');
    });
    it('Account OwnerId is sensitive', () => {
      expect(classifyField('Account', 'OwnerId').sensitivity).toBe('sensitive');
    });
    it('Account AnnualRevenue is sensitive', () => {
      expect(classifyField('Account', 'AnnualRevenue').sensitivity).toBe('sensitive');
    });
    it('Contact AccountId reassignment is sensitive', () => {
      expect(classifyField('Contact', 'AccountId').sensitivity).toBe('sensitive');
    });
    it('Milestone owner_id is sensitive', () => {
      expect(classifyField('Milestone', 'owner_id').sensitivity).toBe('sensitive');
    });
    it('Task OwnerId is sensitive', () => {
      expect(classifyField('Task', 'OwnerId').sensitivity).toBe('sensitive');
    });
    it('Account NumberOfEmployees is sensitive (mega-B #8)', () => {
      const c = classifyField('Account', 'NumberOfEmployees');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toMatch(/segmentation/i);
    });
    it('Contact npsp__Primary_Affiliation__c is sensitive (mega-B #8)', () => {
      const c = classifyField('Contact', 'npsp__Primary_Affiliation__c');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toMatch(/household|rollup/i);
    });
    it('Activity OwnerId is sensitive (mega-B #8)', () => {
      expect(classifyField('Activity', 'OwnerId').sensitivity).toBe('sensitive');
    });
    it('Activity WhatId + WhoId are sensitive (mega-B #8)', () => {
      expect(classifyField('Activity', 'WhatId').sensitivity).toBe('sensitive');
      expect(classifyField('Activity', 'WhoId').sensitivity).toBe('sensitive');
    });
  });

  describe('Activity safe fields (mega-B #8)', () => {
    it.each(['Subject', 'Status', 'Priority', 'ActivityDate', 'Description'])(
      'Activity.%s is safe',
      (f) => {
        expect(classifyField('Activity', f).sensitivity).toBe('safe');
      },
    );
  });

  describe('permission-gated fields', () => {
    it('Project status requires edit_project_status', () => {
      const c = classifyField('Project', 'status');
      expect(c.sensitivity).toBe('permission-gated');
      expect(c.permission).toBe('edit_project_status');
      expect(c.lockReason).toBeTruthy();
    });
    it('Target amount requires manage_owner_goals', () => {
      const c = classifyField('Target', 'amount');
      expect(c.sensitivity).toBe('permission-gated');
      expect(c.permission).toBe('manage_owner_goals');
    });
    it('Target period requires manage_owner_goals', () => {
      const c = classifyField('Target', 'period');
      expect(c.sensitivity).toBe('permission-gated');
      expect(c.permission).toBe('manage_owner_goals');
    });
  });

  describe('unknown fields fail safe to sensitive', () => {
    it('returns sensitive for unknown object type', () => {
      const c = classifyField('UnknownObject', 'Name');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toContain('not classified');
    });
    it('returns sensitive for unknown field on known object', () => {
      const c = classifyField('Opportunity', 'SomeFieldNobodyClassified__c');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toContain('not classified');
    });
  });

  // A10 audit / mega-B: Commit 6 adds an optional defaultSensitivity arg so
  // schema-generated cells (schemaColumns.tsx) can opt unclassified fields
  // into 'safe' without declaring every SF-updateable field. Hand-coded
  // call sites still fail safe.
  describe('defaultSensitivity override for unclassified pairs', () => {
    it("returns 'safe' when defaultSensitivity='safe' for unknown field", () => {
      const c = classifyField('Account', 'CustomField_That_Isnt_Listed__c', 'safe');
      expect(c.sensitivity).toBe('safe');
      // No lockReason when defaulting safe — the cell edits freely without
      // a "not classified" tooltip.
      expect(c.lockReason).toBeUndefined();
    });

    it("returns 'sensitive' fail-safe when defaultSensitivity is omitted", () => {
      const c = classifyField('Account', 'CustomField_That_Isnt_Listed__c');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toContain('not classified');
    });

    it('explicit classification always wins over defaultSensitivity', () => {
      // Opportunity.StageName is 'sensitive' in the table — passing 'safe'
      // as the default must not downgrade it.
      const c = classifyField('Opportunity', 'StageName', 'safe');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toBeTruthy();
    });

    it('explicit safe in the table also wins over defaultSensitivity=sensitive', () => {
      // Opportunity.Name is 'safe' in the table — a caller passing
      // 'sensitive' as the default shouldn't re-lock it.
      const c = classifyField('Opportunity', 'Name', 'sensitive');
      expect(c.sensitivity).toBe('safe');
    });
  });

  // Guard against the "silent sensitive fallback" regression: every domain
  // cell (StageCell, OwnerCell, …) ships with a default (objectType,
  // fieldName) pair. If that default isn't in FIELD_CLASSIFICATIONS, the
  // fallback branch returns sensitivity: 'sensitive' with a "not classified"
  // tooltip — users suddenly need to click-through an unlock dialog for a
  // field that should have been safe. This test enumerates every default
  // shipped by the cells in components/inline-edit/cells/ and asserts each
  // has an explicit entry.
  //
  // Updating a cell's default objectType or fieldName: also update this
  // list AND add/confirm the classification in FIELD_CLASSIFICATIONS.
  describe('domain-cell default pairs are explicitly classified', () => {
    const CELL_DEFAULTS: Array<{ cell: string; objectType: string; fieldName: string }> = [
      { cell: 'StageCell',       objectType: 'Opportunity', fieldName: 'StageName' },
      { cell: 'OwnerCell',       objectType: 'Opportunity', fieldName: 'OwnerId' },
      { cell: 'AccountCell',     objectType: 'Opportunity', fieldName: 'AccountId' },
      { cell: 'AmountCell',      objectType: 'Opportunity', fieldName: 'Amount' },
      { cell: 'DateCell',        objectType: 'Opportunity', fieldName: 'CloseDate' },
      { cell: 'ProbabilityCell', objectType: 'Opportunity', fieldName: 'Probability' },
      { cell: 'PhasePillCell',   objectType: 'Milestone',   fieldName: 'priority' },
      // StatusPillCell has no default — caller always supplies the pair.
    ];

    CELL_DEFAULTS.forEach(({ cell, objectType, fieldName }) => {
      it(`${cell} default (${objectType}.${fieldName}) is explicitly classified`, () => {
        const c = classifyField(objectType, fieldName);
        // The fallback message is "<fieldName> is not classified. …".
        // If we see it, the cell's default pair is missing from the table.
        expect(c.lockReason ?? '').not.toMatch(/not classified/);
      });
    });
  });
});

describe('validateDateBounds', () => {
  it('returns null for a date well within bounds', () => {
    expect(validateDateBounds('2026-06-15')).toBeNull();
    expect(validateDateBounds('1999-01-01')).toBeNull();
  });

  it('rejects dates before 1970', () => {
    expect(validateDateBounds('1969-12-31')).toMatch(/1970/);
    expect(validateDateBounds('1900-06-01')).toMatch(/1970/);
  });

  it('rejects dates more than 10 years out', () => {
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 11);
    const result = validateDateBounds(farFuture);
    expect(result).toMatch(/10 years/);
  });

  it('returns null for a date exactly at the 10-year horizon', () => {
    const tenYears = new Date();
    tenYears.setFullYear(tenYears.getFullYear() + 10);
    tenYears.setDate(tenYears.getDate() - 1); // 1 day under
    expect(validateDateBounds(tenYears)).toBeNull();
  });

  it('rejects invalid date strings', () => {
    expect(validateDateBounds('not a date')).toMatch(/invalid/i);
  });

  it('accepts a Date object directly', () => {
    expect(validateDateBounds(new Date(2026, 5, 15))).toBeNull();
  });
});
