import { describe, it, expect } from 'vitest';
import { seedScannerSelection } from './SyntheticScanOptionsPopup';

const set = (...ids: string[]) => new Set(ids);

describe('seedScannerSelection', () => {
  it('honors the panel selection, intersected with the candidates', () => {
    // Panel had scan B selected; both A and B are scan positions → check B only
    // (NOT both — the bug this fixes seeded every candidate regardless of panel).
    const result = seedScannerSelection(['A', 'B'], set('B'));
    expect([...result]).toEqual(['B']);
  });

  it('intersects a multi-scan selection with the candidate set', () => {
    // C is selected in the panel but isn't a scan position; keep A and B.
    const result = seedScannerSelection(['A', 'B'], set('A', 'B', 'C'));
    expect([...result].sort()).toEqual(['A', 'B']);
  });

  it('defaults to all candidates when nothing was selected in the panel', () => {
    const result = seedScannerSelection(['A', 'B'], set());
    expect([...result].sort()).toEqual(['A', 'B']);
  });

  it('falls back to all candidates when the selection touches no candidate', () => {
    // Opened the scan tool with an unrelated object (a mesh, say) selected and no
    // scan position among the selection — check everything rather than run empty.
    // (Differs from Backfill, where a non-matching selection selects nothing and
    // an ineligibility note explains; here there is no ineligibility concept.)
    const result = seedScannerSelection(['A', 'B'], set('Z'));
    expect([...result].sort()).toEqual(['A', 'B']);
  });

  it('re-seeds purely from the new selection (no carry-over from a prior open)', () => {
    const firstOpen = seedScannerSelection(['A', 'B'], set('A'));
    expect([...firstOpen]).toEqual(['A']);
    const reopen = seedScannerSelection(['A', 'B'], set('B'));
    expect([...reopen]).toEqual(['B']);
  });
});
