// Run-time options for a synthetic (ray-traced) LiDAR scan. These are distinct
// from a scan's PROPERTIES (origin, sweep, tilt, heading — see ./scanParameters):
// properties describe a scan whether it's real or synthetic, while these only
// matter when the engine ray-traces a synthetic acquisition. They're chosen
// per-run in the Synthetic Scan Options popup and remembered (last-used) in the
// electron store.
//
// The RETURN and BEAM-OPTICS fields live here, not on ScanParameters, because
// they are load-bearing for exactly one thing: generating a synthetic scan.
// Verified in helios-core — `getScanBeamExitDiameter`/`getScanBeamDivergence` are
// read only inside `syntheticScan` (LiDAR.cpp), while `calculateLeafArea` and
// `gapfillMisses` never call them and use one algorithm regardless of return
// mode. For a REAL imported scan, multi- vs single-return is decided by the
// per-pulse columns the data actually carries (see `detectedReturnMode` in
// ./scan), so asking the user to declare it there was asking for a value nothing
// read. They remain on ScanParameters as persisted data for the Helios scan-XML
// round-trip; the Scan Parameters dialog just reports what the data shows instead
// of offering these as editable fields.

import {
  SCAN_HIT_FIELD_SLUGS,
  DEFAULT_RETAINED_FIELDS,
} from './scanHitFields';
import type { PulseReturnMode, SingleReturnSelection } from './scanParameters';

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
  // How many returns each simulated pulse reports. 'multi' keeps every detected
  // return up to `maxReturns` (full-waveform, penetrates foliage); 'single' keeps
  // the one return named by `returnSelection`. One setting for the whole run: a
  // scene mixing instruments simulates them with the same optics.
  returnMode: PulseReturnMode;
  // Multi-return only: cap on returns reported per pulse. Ignored by 'single'.
  maxReturns: number;
  // Single-return only: which return to keep when the beam cone resolves several.
  // Ignored by 'multi'.
  returnSelection: SingleReturnSelection;
  // Beam cone geometry: exit diameter in meters, divergence in milliradians (the
  // units pyhelios takes). These size the cone that `raysPerPulse` sub-rays are
  // fired across — so at raysPerPulse = 1 the cone collapses to one exact ray and
  // both are effectively ignored.
  beamExitDiameterM: number;
  beamDivergenceMrad: number;
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
  // Match the values these fields carried as scan parameters, so a run after the
  // move behaves exactly as it did before.
  returnMode: 'single',
  maxReturns: 5,
  returnSelection: 'strongest',
  beamExitDiameterM: 0.01,
  beamDivergenceMrad: 0.5,
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
    // Enum fields fall back unless the stored value is one of the known variants,
    // so a blob predating the move (or a hand-edited store) can't smuggle in a
    // value the backend would reject.
    returnMode: s.returnMode === 'multi' || s.returnMode === 'single'
      ? s.returnMode : DEFAULT_SYNTHETIC_SCAN_OPTIONS.returnMode,
    maxReturns: Math.max(
      1, Math.round(num(s.maxReturns, DEFAULT_SYNTHETIC_SCAN_OPTIONS.maxReturns, 1)),
    ),
    returnSelection: s.returnSelection === 'strongest' || s.returnSelection === 'first'
      || s.returnSelection === 'last'
      ? s.returnSelection : DEFAULT_SYNTHETIC_SCAN_OPTIONS.returnSelection,
    // Beam optics may legitimately be 0 (a pencil beam), so `num`'s floor of 0 is
    // the only clamp — no `|| default` fallback, which would reject a real 0.
    beamExitDiameterM: num(
      s.beamExitDiameterM, DEFAULT_SYNTHETIC_SCAN_OPTIONS.beamExitDiameterM,
    ),
    beamDivergenceMrad: num(
      s.beamDivergenceMrad, DEFAULT_SYNTHETIC_SCAN_OPTIONS.beamDivergenceMrad,
    ),
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
