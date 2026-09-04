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
      retainedFields: ['timestamp', 'distance'],
      returnMode: 'multi' as const,
      maxReturns: 15,
      returnSelection: 'first' as const,
      beamExitDiameterM: 0.00225,
      beamDivergenceMrad: 0.4,
    };
    expect(coerceSyntheticScanOptions(stored)).toEqual(stored);
  });

  it('fills retainedFields with the defaults when absent or not an array', () => {
    expect(coerceSyntheticScanOptions({}).retainedFields)
      .toEqual(DEFAULT_SYNTHETIC_SCAN_OPTIONS.retainedFields);
    expect(coerceSyntheticScanOptions({ retainedFields: 'oops' }).retainedFields)
      .toEqual(DEFAULT_SYNTHETIC_SCAN_OPTIONS.retainedFields);
  });

  it('honors an explicit empty retainedFields array', () => {
    expect(coerceSyntheticScanOptions({ retainedFields: [] }).retainedFields).toEqual([]);
  });

  it('drops unknown retainedFields slugs but keeps valid ones', () => {
    const out = coerceSyntheticScanOptions({
      retainedFields: ['timestamp', 'bogus', 42, 'deviation'],
    });
    expect(out.retainedFields).toEqual(['timestamp', 'deviation']);
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

describe('coerceSyntheticScanOptions — return + beam optics', () => {
  it('round-trips a full set of return/beam settings', () => {
    const out = coerceSyntheticScanOptions({
      returnMode: 'multi',
      maxReturns: 12,
      returnSelection: 'last',
      beamExitDiameterM: 0.0035,
      beamDivergenceMrad: 0.35,
    });
    expect(out.returnMode).toBe('multi');
    expect(out.maxReturns).toBe(12);
    expect(out.returnSelection).toBe('last');
    expect(out.beamExitDiameterM).toBe(0.0035);
    expect(out.beamDivergenceMrad).toBe(0.35);
  });

  // A blob persisted before these fields moved off ScanParameters has none of
  // them. It must read back as the defaults rather than undefined, or the first
  // run after upgrading would send undefined optics to the backend.
  it('fills defaults for a stored blob predating the move', () => {
    const out = coerceSyntheticScanOptions({ raysPerPulse: 50 });
    expect(out.returnMode).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.returnMode);
    expect(out.maxReturns).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.maxReturns);
    expect(out.returnSelection).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.returnSelection);
    expect(out.beamExitDiameterM).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.beamExitDiameterM);
    expect(out.beamDivergenceMrad).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.beamDivergenceMrad);
  });

  it('rejects out-of-vocabulary enum values', () => {
    const out = coerceSyntheticScanOptions({
      returnMode: 'waveform', returnSelection: 'brightest',
    });
    expect(out.returnMode).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.returnMode);
    expect(out.returnSelection).toBe(DEFAULT_SYNTHETIC_SCAN_OPTIONS.returnSelection);
  });

  // Beam optics of exactly 0 are meaningful (a pencil beam with no footprint),
  // so they must survive coercion rather than being treated as missing.
  it('preserves a beam diameter/divergence of 0', () => {
    const out = coerceSyntheticScanOptions({
      beamExitDiameterM: 0, beamDivergenceMrad: 0,
    });
    expect(out.beamExitDiameterM).toBe(0);
    expect(out.beamDivergenceMrad).toBe(0);
  });

  it('clamps maxReturns to at least 1 and rounds it', () => {
    expect(coerceSyntheticScanOptions({ maxReturns: 0 }).maxReturns).toBe(1);
    expect(coerceSyntheticScanOptions({ maxReturns: 7.6 }).maxReturns).toBe(8);
  });
});
