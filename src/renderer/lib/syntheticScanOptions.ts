// Run-time options for a synthetic (ray-traced) LiDAR scan. These are distinct
// from a scan's PROPERTIES (origin, sweep, return type, beam optics, tilt — see
// ./scanParameters): properties describe a scan whether it's real or synthetic,
// while these only matter when the engine ray-traces a synthetic acquisition.
// They're chosen per-run in the Synthetic Scan Options popup and remembered
// (last-used) in the electron store.

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
  // Full-waveform only (a scanner with return_type === 'multi'): sub-rays per
  // pulse, and the distance threshold for aggregating them into returns (m).
  raysPerPulse: number;
  pulseDistanceThresholdM: number;
  // Restrict ray-tracing to the cells of the single visible voxel grid.
  cropToGrid: boolean;
}

export const DEFAULT_SYNTHETIC_SCAN_OPTIONS: SyntheticScanOptions = {
  rangeNoiseMm: 0,
  angleNoiseMrad: 0,
  includeMisses: true,
  raysPerPulse: 100,
  pulseDistanceThresholdM: 0.02,
  cropToGrid: false,
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
  };
}
