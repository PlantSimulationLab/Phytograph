import { describe, it, expect } from 'vitest';
import { groundSegmentDefaultsForExtent } from './groundSegmentDefaults';

describe('groundSegmentDefaultsForExtent', () => {
  describe('flat terrain (low relief ratio)', () => {
    it('reduces to the plant-tuned defaults at close range (~1.5 m extent)', () => {
      // extent/100 = 0.015, clamped up to the plant-scale floors → the historical
      // static defaults (cloth 0.05, threshold 0.02), stiff cloth, no smoothing.
      const d = groundSegmentDefaultsForExtent(1.5);
      expect(d.clothResolution).toBe(0.05);
      expect(d.classThreshold).toBe(0.02);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
    });

    it('scales up for a flat field/orchard-scale cloud (~50 m extent, ~6 m relief)', () => {
      // Mission1: relief ratio 6/50 = 0.12 < 0.2 → flat recipe. extent/100 = 0.5.
      const d = groundSegmentDefaultsForExtent(50, 6);
      expect(d.clothResolution).toBe(0.5);
      expect(d.classThreshold).toBe(0.5);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
    });

    it('clamps cloth resolution to its max for an enormous flat extent', () => {
      const d = groundSegmentDefaultsForExtent(1000, 10);
      expect(d.clothResolution).toBe(2); // CLOTH_MAX
      expect(d.classThreshold).toBe(1); // THRESH_MAX
      expect(d.rigidness).toBe(3);
    });

    it('scales linearly in the mid range', () => {
      const d = groundSegmentDefaultsForExtent(20);
      expect(d.clothResolution).toBe(0.2);
      expect(d.classThreshold).toBe(0.2);
      expect(d.rigidness).toBe(3);
    });

    it('treats zero / omitted relief as flat (backward compatible)', () => {
      const d = groundSegmentDefaultsForExtent(50);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
      expect(d.clothResolution).toBe(0.5);
    });
  });

  describe('sloped terrain (high relief ratio)', () => {
    it('uses a fine, low-rigidness, slope-smoothed cloth for a steep ALS tile', () => {
      // BR04: 186 m extent, 81 m relief → ratio 0.44 > 0.2 → slope recipe.
      // cloth = extent/200 = 0.93 (< 1 m cap); thr 0.5; rigidness 1; smooth on.
      const d = groundSegmentDefaultsForExtent(186, 81);
      expect(d.clothResolution).toBeCloseTo(0.93, 2);
      expect(d.classThreshold).toBe(0.5);
      expect(d.rigidness).toBe(1);
      expect(d.slopeSmooth).toBe(true);
    });

    it('caps the slope cloth at 1 m for a very large steep tile', () => {
      // extent/200 = 2.5 would exceed the cap → clamped to 1 m.
      const d = groundSegmentDefaultsForExtent(500, 200);
      expect(d.clothResolution).toBe(1);
      expect(d.rigidness).toBe(1);
      expect(d.slopeSmooth).toBe(true);
    });

    it('switches to the slope recipe right at the relief-ratio threshold', () => {
      // ratio exactly 0.2 (>=) → slope recipe.
      const d = groundSegmentDefaultsForExtent(100, 20);
      expect(d.rigidness).toBe(1);
      expect(d.slopeSmooth).toBe(true);
    });

    it('stays on the flat recipe just below the threshold', () => {
      // ratio 0.19 < 0.2 → flat recipe.
      const d = groundSegmentDefaultsForExtent(100, 19);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
    });
  });

  describe('a tall plant is not terrain relief', () => {
    it('uses the flat recipe for a single tree on flat ground', () => {
      // The `tree_1` reference: an 8.4 m tree over a 9.2 m footprint whose
      // ground is flat to within 47 cm. Ratio 0.915 — the bounding box measures
      // the TREE, not the terrain. The conforming (sloped) recipe climbs the
      // trunk here, costing ~43k extra misclassified trunk points.
      const d = groundSegmentDefaultsForExtent(9.18, 8.4);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
    });

    it('handles a tree taller than its own footprint', () => {
      // `tree_4`: a 12.2 m tree over a 9.4 m footprint, so the bounding-box
      // ratio is 1.303 — a "slope" steeper than 45 deg, while the ground under
      // it is flat to 1.9 deg. Routing this to the flat recipe cuts trunk
      // points misread as ground from 86,798 to 7,919.
      const d = groundSegmentDefaultsForExtent(9.37, 12.21);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
    });

    it('still treats a genuine slope as sloped', () => {
      // BR04: 186 m wide, 81 m of relief (~15 deg). Ratio 0.44 — real terrain,
      // and it must keep the conforming recipe.
      const d = groundSegmentDefaultsForExtent(186, 81);
      expect(d.rigidness).toBe(1);
      expect(d.slopeSmooth).toBe(true);
    });
  });

  it('falls back to the plant-scale flat default for a non-finite or zero extent', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const d = groundSegmentDefaultsForExtent(bad);
      expect(d.clothResolution).toBe(0.05);
      expect(d.classThreshold).toBe(0.02);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
    }
  });

  it('ignores non-finite relief and treats the cloud as flat', () => {
    for (const badRelief of [NaN, Infinity, -10]) {
      const d = groundSegmentDefaultsForExtent(186, badRelief);
      expect(d.rigidness).toBe(3);
      expect(d.slopeSmooth).toBe(false);
    }
  });

  describe('airborne (ALS) regime', () => {
    // Extent/relief/spacing triples below are MEASURED on the 15 ISPRS
    // filtertest samples and the close-range references — see the ALS_SPACING_M
    // comment for the benchmark numbers this recipe is calibrated against.

    it('gives an airborne tile the fixed ALS recipe, not the extent-scaled one', () => {
      // samp51: 430 m across, 1.74 m point spacing. The extent-scaled rule asks
      // for a 4.3 m cloth, clamps to 2.0, and scores 0.498 overall accuracy —
      // a cloth FINER than the data supports, conforming to sampling noise.
      const d = groundSegmentDefaultsForExtent(430, 49, 1.74);
      expect(d.clothResolution).toBe(0.75);
      expect(d.rigidness).toBe(2);
      expect(d.slopeSmooth).toBe(true);
    });

    it('applies the ALS recipe regardless of relief ratio', () => {
      // The close-range branches key off relief ratio; an airborne tile can be
      // flat (samp71, ratio 0.04) or steep (samp11, ratio 0.36) and must take
      // the same recipe either way. Before this, samp11 landed in the sloped
      // branch and samp71 in the flat one, and both were wrong.
      for (const [ext, relief] of [[395, 16], [303, 109]]) {
        const d = groundSegmentDefaultsForExtent(ext, relief, 1.7);
        expect(d.clothResolution).toBe(0.75);
        expect(d.rigidness).toBe(2);
      }
    });

    it('keeps close-range clouds on the extent-scaled path', () => {
      // Measured spacings: tree_1 0.0020, Nickels 0.0052, bean 0.0125 — two
      // orders of magnitude below the cutoff.
      for (const [ext, relief, spacing] of [[9.2, 8.4, 0.0020], [12.6, 9.1, 0.0052], [5.9, 0.3, 0.0125]]) {
        const d = groundSegmentDefaultsForExtent(ext, relief, spacing);
        expect(d.clothResolution).toBeLessThan(0.5);
      }
    });

    it('does NOT call a small sparse cloud airborne', () => {
      // Spacing alone is not enough: 3D nearest-neighbour distance measures
      // spatial separation, so a volume-filling cloud reads far sparser than a
      // surface scan of the same size — 2000 points in a 5 m cube measure
      // 0.219 m, past the spacing cutoff. A 0.75 m cloth on a 5 m cloud would
      // be absurd, so the extent condition has to hold too.
      const d = groundSegmentDefaultsForExtent(5, 5, 0.219);
      expect(d.clothResolution).toBeLessThan(0.5);
    });

    it('stays on the close-range path when spacing is unknown', () => {
      // Renderer-built clouds carry no measured spacing. Every such cloud is
      // close-range, and guessing airborne would be far more damaging than the
      // reverse.
      for (const spacing of [undefined, NaN, 0]) {
        const d = groundSegmentDefaultsForExtent(430, 49, spacing);
        expect(d.clothResolution).not.toBe(0.75);
      }
    });
  });
});
