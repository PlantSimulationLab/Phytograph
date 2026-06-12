import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYNTHETIC_SCAN_OPTIONS,
  coerceSyntheticScanOptions,
} from './syntheticScanOptions';

// coerceSyntheticScanOptions merges a (possibly partial / stale / invalid)
// persisted blob over the defaults so a remembered value can never produce an
// invalid options object.

describe('coerceSyntheticScanOptions', () => {
  it('returns the defaults for null/undefined/non-object', () => {
    expect(coerceSyntheticScanOptions(undefined)).toEqual(DEFAULT_SYNTHETIC_SCAN_OPTIONS);
    expect(coerceSyntheticScanOptions(null)).toEqual(DEFAULT_SYNTHETIC_SCAN_OPTIONS);
    expect(coerceSyntheticScanOptions(42)).toEqual(DEFAULT_SYNTHETIC_SCAN_OPTIONS);
  });

  it('defaults misses ON', () => {
    expect(DEFAULT_SYNTHETIC_SCAN_OPTIONS.includeMisses).toBe(true);
    // An empty blob keeps the ON default rather than coercing to false.
    expect(coerceSyntheticScanOptions({}).includeMisses).toBe(true);
  });

  it('carries valid stored values through', () => {
    const stored = {
      rangeNoiseMm: 3,
      angleNoiseMrad: 0.2,
      includeMisses: false,
      raysPerPulse: 50,
      pulseDistanceThresholdM: 0.05,
      cropToGrid: true,
    };
    expect(coerceSyntheticScanOptions(stored)).toEqual(stored);
  });

  it('clamps negatives, fixes non-finite, and rounds rays per pulse', () => {
    const out = coerceSyntheticScanOptions({
      rangeNoiseMm: -5,            // clamped to 0
      angleNoiseMrad: Number.NaN, // falls back to default
      raysPerPulse: 12.7,         // rounded
      pulseDistanceThresholdM: 0, // 0 is invalid → default
    });
    expect(out.rangeNoiseMm).toBe(0);
    expect(out.angleNoiseMrad).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.angleNoiseMrad);
    expect(out.raysPerPulse).toBe(13);
    expect(out.pulseDistanceThresholdM).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.pulseDistanceThresholdM);
  });

  it('enforces a minimum of 1 ray per pulse', () => {
    expect(coerceSyntheticScanOptions({ raysPerPulse: 0 }).raysPerPulse).toBe(1);
    expect(coerceSyntheticScanOptions({ raysPerPulse: -3 }).raysPerPulse).toBe(1);
  });
});
