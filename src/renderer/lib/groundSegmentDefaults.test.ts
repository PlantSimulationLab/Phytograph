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
});
