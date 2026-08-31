import { describe, it, expect } from 'vitest';
import { treeSegmentDefaultsForExtent } from './treeSegmentDefaults';

describe('treeSegmentDefaultsForExtent', () => {
  it('keeps the upstream paper defaults at close range (~1.5 m extent)', () => {
    // decimate_res1 = 1.5/372 = 0.004 → clamped up to DEC1_MIN (0.05). maxGap
    // clamps to its 2.0 floor. This is the load-bearing assertion: small TLS
    // scans must behave exactly as before.
    const d = treeSegmentDefaultsForExtent(1.5);
    expect(d).toEqual({ decimateRes1: 0.05, decimateRes2: 0.1, maxGap: 2.0, maxOutlierGap: 0.65 });
  });

  it('coarsens decimation for a large ALS tile (BR04, ~186 m extent)', () => {
    const d = treeSegmentDefaultsForExtent(186);
    expect(d.decimateRes1).toBeGreaterThanOrEqual(0.45);
    expect(d.decimateRes1).toBeLessThanOrEqual(0.55);
    expect(d.decimateRes2).toBeCloseTo(2 * d.decimateRes1, 5);
    expect(d.decimateRes2).toBeCloseTo(1.0, 2);
    // Gap stays at the floor for a 186 m tile (that's the calibration anchor).
    expect(d.maxGap).toBe(2.0);
    // The split distance does not scale with extent (crown separation is set by
    // canopy architecture, not survey scale), so it stays at its default here.
    expect(d.maxOutlierGap).toBe(0.65);
  });

  it('loosens gap thresholds only on very large tiles', () => {
    const d = treeSegmentDefaultsForExtent(500);
    expect(d.maxGap).toBeGreaterThan(2.0); // 500*(2/186) ≈ 5.38
    // maxOutlierGap is a SPLIT distance, not a looser maxGap: it is capped AT
    // maxGap and never above it, or nothing ever splits (the bug this replaced).
    expect(d.maxOutlierGap).toBeLessThanOrEqual(d.maxGap);
  });

  it('clamps decimation and gap to their maxima for an enormous extent', () => {
    const d = treeSegmentDefaultsForExtent(10000);
    expect(d.decimateRes1).toBe(1.0); // DEC1_MAX
    expect(d.decimateRes2).toBe(2.0); // 2 × DEC1_MAX
    expect(d.maxGap).toBe(6.0); // MAX_GAP_MAX
    expect(d.maxOutlierGap).toBe(0.65); // flat default, well under the maxGap cap
  });

  it('keeps the split distance below the connect distance at every scale', () => {
    // The two knobs point in opposite directions — maxGap reaches ACROSS a void
    // to reconnect an occluded limb, maxOutlierGap declares a distant body a
    // different tree. Seeding the split at 1.5x maxGap (the original rule) made
    // it unreachable, so the parameter was inert for its whole life.
    for (const ext of [1.5, 9, 20, 50, 186, 500, 10000]) {
      const d = treeSegmentDefaultsForExtent(ext);
      expect(d.maxOutlierGap).toBeLessThanOrEqual(d.maxGap);
    }
  });

  it('lands in the band that is correct on both calibration datasets', () => {
    // Swept on two independent clouds (see the constant's comment): TreeIso's
    // 9-ground-truth-tree demo cloud needs >= 0.55 (0.5 splits it into 10, 0.4
    // into 22), and the Nickels almond scan needs <= 0.75 (1.0 reabsorbs the
    // neighbouring tree). Only 0.55-0.75 satisfies both. Pinning the band rather
    // than the value keeps this honest if the seeding is retuned.
    for (const ext of [1.5, 8.85, 17.1, 50, 186, 500, 10000]) {
      const d = treeSegmentDefaultsForExtent(ext);
      expect(d.maxOutlierGap).toBeGreaterThanOrEqual(0.55);
      expect(d.maxOutlierGap).toBeLessThanOrEqual(0.75);
    }
  });

  it('falls back to the paper defaults for a non-finite or zero extent', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(treeSegmentDefaultsForExtent(bad)).toEqual({
        decimateRes1: 0.05,
        decimateRes2: 0.1,
        maxGap: 2.0,
        maxOutlierGap: 0.65,
      });
    }
  });
});
