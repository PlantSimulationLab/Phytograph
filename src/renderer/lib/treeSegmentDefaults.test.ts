import { describe, it, expect } from 'vitest';
import { treeSegmentDefaultsForExtent } from './treeSegmentDefaults';

describe('treeSegmentDefaultsForExtent', () => {
  it('keeps the upstream paper defaults at close range (~1.5 m extent)', () => {
    // decimate_res1 = 1.5/372 = 0.004 → clamped up to DEC1_MIN (0.05). maxGap
    // and maxOutlierGap clamp to their 2.0/3.0 floors. This is the load-bearing
    // assertion: small TLS scans must behave exactly as before.
    const d = treeSegmentDefaultsForExtent(1.5);
    expect(d).toEqual({ decimateRes1: 0.05, decimateRes2: 0.1, maxGap: 2.0, maxOutlierGap: 3.0 });
  });

  it('coarsens decimation for a large ALS tile (BR04, ~186 m extent)', () => {
    const d = treeSegmentDefaultsForExtent(186);
    expect(d.decimateRes1).toBeGreaterThanOrEqual(0.45);
    expect(d.decimateRes1).toBeLessThanOrEqual(0.55);
    expect(d.decimateRes2).toBeCloseTo(2 * d.decimateRes1, 5);
    expect(d.decimateRes2).toBeCloseTo(1.0, 2);
    // Gap stays at the floor for a 186 m tile (that's the calibration anchor).
    expect(d.maxGap).toBe(2.0);
    expect(d.maxOutlierGap).toBe(3.0);
  });

  it('loosens gap thresholds only on very large tiles', () => {
    const d = treeSegmentDefaultsForExtent(500);
    expect(d.maxGap).toBeGreaterThan(2.0); // 500*(2/186) ≈ 5.38
    expect(d.maxOutlierGap).toBeCloseTo(1.5 * d.maxGap, 5);
  });

  it('clamps decimation and gap to their maxima for an enormous extent', () => {
    const d = treeSegmentDefaultsForExtent(10000);
    expect(d.decimateRes1).toBe(1.0); // DEC1_MAX
    expect(d.decimateRes2).toBe(2.0); // 2 × DEC1_MAX
    expect(d.maxGap).toBe(6.0); // MAX_GAP_MAX
    expect(d.maxOutlierGap).toBe(9.0); // 1.5 × MAX_GAP_MAX
  });

  it('falls back to the paper defaults for a non-finite or zero extent', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(treeSegmentDefaultsForExtent(bad)).toEqual({
        decimateRes1: 0.05,
        decimateRes2: 0.1,
        maxGap: 2.0,
        maxOutlierGap: 3.0,
      });
    }
  });
});
