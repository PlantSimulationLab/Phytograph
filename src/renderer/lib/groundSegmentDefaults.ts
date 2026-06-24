// Adaptive defaults for the Cloth Simulation Filter (CSF) ground segmentation.
//
// CSF's parameters are ABSOLUTE distances, so they're scale-dependent: a cloth
// grid spacing and ground class-threshold tuned for a ~1 m close-range plant
// scan (cloth 5 cm, threshold 2 cm) badly UNDER-segment a 50 m field/orchard
// scan. At cm resolution the cloth can't drape over metre-scale terrain relief,
// and a 2 cm class threshold rejects true ground points that settle further
// than that from the cloth — the failure mode is "nearly everything labelled
// non-ground" even when the ground is visually obvious. The fix is to seed both
// params from the cloud's horizontal extent when the segmentation panel opens.
//
// Calibration against two real example datasets:
//   - Prunus close-range plant: horizontal extent ~1.5 m → cloth 0.05, thr 0.02
//   - Mission1 field/orchard:   horizontal extent ~50 m  → cloth 0.5,  thr 0.5
// extent/100 lands on both end-points (≈0.015 at plant scale, clamped up to the
// plant-tuned floor; 0.5 at field scale), so we scale linearly in extent and
// clamp to the panel's input bounds. The user can still override in the panel.

export interface GroundSegmentDefaults {
  clothResolution: number;
  classThreshold: number;
}

// Seeding bounds. The panel's inputs allow finer values (cloth down to 0.005,
// threshold down to 0.001), but we never AUTO-seed below the plant-tuned floor
// — those very fine settings are an expert opt-in, not a sensible default.
const CLOTH_MIN = 0.05;
const CLOTH_MAX = 2;
const THRESH_MIN = 0.02;
const THRESH_MAX = 1;

// Fraction of horizontal extent used for both the cloth grid spacing and the
// ground class threshold (see calibration above).
const EXTENT_FRACTION = 1 / 100;

function clampRound(value: number, lo: number, hi: number): number {
  const clamped = Math.max(lo, Math.min(hi, value));
  // 3 decimals keeps seeded values clean (0.5, 0.237) without float noise.
  return Math.round(clamped * 1000) / 1000;
}

// Suggested CSF defaults for a cloud whose largest horizontal span is
// `horizontalExtentM` metres (max of the X/Y bounds — Z is up). Falls back to
// the plant-scale default for a non-finite or non-positive extent.
export function groundSegmentDefaultsForExtent(horizontalExtentM: number): GroundSegmentDefaults {
  const ext = Number.isFinite(horizontalExtentM) && horizontalExtentM > 0 ? horizontalExtentM : 1.5;
  const scaled = ext * EXTENT_FRACTION;
  return {
    clothResolution: clampRound(scaled, CLOTH_MIN, CLOTH_MAX),
    classThreshold: clampRound(scaled, THRESH_MIN, THRESH_MAX),
  };
}
