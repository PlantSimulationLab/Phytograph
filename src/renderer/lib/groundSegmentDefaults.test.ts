import { describe, it, expect } from 'vitest';
import { groundSegmentDefaultsForExtent } from './groundSegmentDefaults';

describe('groundSegmentDefaultsForExtent', () => {
  it('reduces to the plant-tuned defaults at close range (~1.5 m extent)', () => {
    // extent/100 = 0.015, clamped up to the plant-scale floors → the historical
    // static defaults (cloth 0.05, threshold 0.02).
    const d = groundSegmentDefaultsForExtent(1.5);
    expect(d.clothResolution).toBe(0.05);
    expect(d.classThreshold).toBe(0.02);
  });

  it('scales up for a field/orchard-scale cloud (~50 m extent)', () => {
    // extent/100 = 0.5 for both — the empirically good config for Mission1.
    const d = groundSegmentDefaultsForExtent(50);
    expect(d.clothResolution).toBe(0.5);
    expect(d.classThreshold).toBe(0.5);
  });

  it('clamps cloth resolution to its max for an enormous extent', () => {
    const d = groundSegmentDefaultsForExtent(1000);
    expect(d.clothResolution).toBe(2); // CLOTH_MAX
    expect(d.classThreshold).toBe(1); // THRESH_MAX
  });

  it('scales linearly in the mid range', () => {
    const d = groundSegmentDefaultsForExtent(20);
    expect(d.clothResolution).toBe(0.2);
    expect(d.classThreshold).toBe(0.2);
  });

  it('falls back to the plant-scale default for a non-finite or zero extent', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const d = groundSegmentDefaultsForExtent(bad);
      expect(d.clothResolution).toBe(0.05);
      expect(d.classThreshold).toBe(0.02);
    }
  });
});
