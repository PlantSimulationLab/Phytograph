import { describe, it, expect } from 'vitest';
import { seedBackfillSelection } from './BackfillMissesPopup';

const set = (...ids: string[]) => new Set(ids);

describe('seedBackfillSelection', () => {
  it('honors the panel selection, intersected with eligibility', () => {
    // Panel had scan B selected; both A and B are eligible → check B only (NOT A).
    const result = seedBackfillSelection(['A', 'B'], set('B'));
    expect([...result]).toEqual(['B']);
  });

  it('does NOT select a different scan when the selected one is ineligible', () => {
    // The "backwards-select" bug: panel had B selected, but only A is eligible.
    // Must select NOTHING (so the ineligibility note explains) — never silently
    // check A, which the user didn't pick.
    const result = seedBackfillSelection(['A'], set('B'));
    expect([...result]).toEqual([]);
  });

  it('defaults to all eligible when nothing was selected in the panel', () => {
    const result = seedBackfillSelection(['A', 'B'], set());
    expect([...result].sort()).toEqual(['A', 'B']);
  });

  it('intersects a multi-scan selection with eligibility', () => {
    const result = seedBackfillSelection(['A', 'C'], set('A', 'B', 'C'));
    expect([...result].sort()).toEqual(['A', 'C']);
  });

  it('re-seeds purely from the new selection (no carry-over from a prior open)', () => {
    // Reopening with a different panel selection must pick up the NEW one — the
    // helper takes no prior-selection arg, so there is nothing to carry over.
    const firstOpen = seedBackfillSelection(['A', 'B'], set('A'));
    expect([...firstOpen]).toEqual(['A']);
    const reopen = seedBackfillSelection(['A', 'B'], set('B'));
    expect([...reopen]).toEqual(['B']);
  });
});
