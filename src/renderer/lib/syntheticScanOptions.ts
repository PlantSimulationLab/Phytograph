// Run-time options for a synthetic (ray-traced) LiDAR scan. These are distinct
// from a scan's PROPERTIES (origin, sweep, return type, beam optics, tilt — see
// ./scanParameters): properties describe a scan whether it's real or synthetic,
// while these only matter when the engine ray-traces a synthetic acquisition.
// They're chosen per-run in the Synthetic Scan Options popup and remembered
// (last-used) in the electron store.

import {
  SCAN_HIT_FIELD_SLUGS,
  DEFAULT_RETAINED_FIELDS,
} from './scanHitFields';

export interface SyntheticScanOptions {
  // Gaussian along-beam range measurement noise, in millimeters (0 = perfect
  // ranging). Converted to meters for pyhelios. Applies to single + multi.
  rangeNoiseMm: number;
  // Gaussian beam-pointing jitter, in milliradians (0 = no jitter). Applies to
  // single + multi. Distinct from beam divergence (which spreads sub-rays).
  angleNoiseMrad: number;
  // Record sky/miss points (rays that hit nothing). When on, the scan routes
  // through a backend session so the miss overlay + LAD can use them.
  includeMisses: boolean;
  // Beam-cone sampling: sub-rays fired per pulse across the beam cone, and the
  // distance threshold for aggregating their hits into discrete returns (m).
  // Set raysPerPulse to 1 for an idealized exact scan (one ray per pulse, no beam
  // footprint) — that is why an exact scan is a run option, not a return mode.
  raysPerPulse: number;
  pulseDistanceThresholdM: number;
  // Restrict ray-tracing to the cells of the single visible voxel grid.
  cropToGrid: boolean;
  // Per-hit scalar fields (slugs from ./scanHitFields) to retain on the
  // resulting cloud's color-by list. Checked fields appear in "Color by" even
  // when constant-valued (they bypass the variance filter in the cloud builder).
  // Optional fields (deviation/nRaysHit/reflectance) are additionally read by
  // the backend by sending them through the scan request's extra_fields.
  retainedFields: string[];
}

export const DEFAULT_SYNTHETIC_SCAN_OPTIONS: SyntheticScanOptions = {
  rangeNoiseMm: 0,
  angleNoiseMrad: 0,
  includeMisses: true,
  raysPerPulse: 100,
  pulseDistanceThresholdM: 0.02,
  cropToGrid: false,
  retainedFields: [...DEFAULT_RETAINED_FIELDS],
};

// Electron-store key for the remembered last-used options.
export const SYNTHETIC_SCAN_OPTIONS_STORE_KEY = 'syntheticScanOptions';

// Merge a (possibly partial / older-shape) stored value over the defaults so a
// missing or stale persisted blob can never produce an invalid options object.
export function coerceSyntheticScanOptions(stored: unknown): SyntheticScanOptions {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SYNTHETIC_SCAN_OPTIONS };
  const s = stored as Partial<SyntheticScanOptions>;
  const num = (v: unknown, fallback: number, min = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback;
  return {
    rangeNoiseMm: num(s.rangeNoiseMm, DEFAULT_SYNTHETIC_SCAN_OPTIONS.rangeNoiseMm),
    angleNoiseMrad: num(s.angleNoiseMrad, DEFAULT_SYNTHETIC_SCAN_OPTIONS.angleNoiseMrad),
    includeMisses: typeof s.includeMisses === 'boolean'
      ? s.includeMisses : DEFAULT_SYNTHETIC_SCAN_OPTIONS.includeMisses,
    raysPerPulse: Math.round(num(s.raysPerPulse, DEFAULT_SYNTHETIC_SCAN_OPTIONS.raysPerPulse, 1)),
    pulseDistanceThresholdM: num(
      s.pulseDistanceThresholdM, DEFAULT_SYNTHETIC_SCAN_OPTIONS.pulseDistanceThresholdM,
    ) || DEFAULT_SYNTHETIC_SCAN_OPTIONS.pulseDistanceThresholdM,
    cropToGrid: typeof s.cropToGrid === 'boolean'
      ? s.cropToGrid : DEFAULT_SYNTHETIC_SCAN_OPTIONS.cropToGrid,
    // Drop unknown slugs (catalog may have changed) but HONOR an explicit empty
    // array — the user may have unchecked everything. Only a missing/non-array
    // value falls back to the defaults.
    retainedFields: Array.isArray(s.retainedFields)
      ? s.retainedFields.filter(
          (v): v is string => typeof v === 'string' && SCAN_HIT_FIELD_SLUGS.includes(v),
        )
      : [...DEFAULT_RETAINED_FIELDS],
  };
}
