import { describe, it, expect } from 'vitest';
import { seedQSMSelection } from './QSMPopup';

const set = (...ids: string[]) => new Set(ids);

describe('seedQSMSelection', () => {
  it('honors the panel selection, intersected with eligibility', () => {
    // Panel had scan B selected; both A and B are eligible → check B only (NOT A).
    const result = seedQSMSelection(['A', 'B'], set('B'));
    expect([...result]).toEqual(['B']);
  });

  it('does NOT select a different scan when the selected one is ineligible', () => {
    // Panel had B selected, but only A is eligible (e.g. B is a params-only scan
    // with no point data). Must select NOTHING — never silently check A.
    const result = seedQSMSelection(['A'], set('B'));
    expect([...result]).toEqual([]);
  });

  it('defaults to all eligible when nothing was selected in the panel', () => {
    const result = seedQSMSelection(['A', 'B'], set());
    expect([...result].sort()).toEqual(['A', 'B']);
  });

  it('intersects a multi-scan selection with eligibility', () => {
    const result = seedQSMSelection(['A', 'C'], set('A', 'B', 'C'));
    expect([...result].sort()).toEqual(['A', 'C']);
  });

  it('re-seeds purely from the new selection (no carry-over from a prior open)', () => {
    const firstOpen = seedQSMSelection(['A', 'B'], set('A'));
    expect([...firstOpen]).toEqual(['A']);
    const reopen = seedQSMSelection(['A', 'B'], set('B'));
    expect([...reopen]).toEqual(['B']);
  });
});
