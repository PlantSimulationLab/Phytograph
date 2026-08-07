// Adaptive defaults for the Cloth Simulation Filter (CSF) ground segmentation.
//
// CSF's parameters are ABSOLUTE distances, so they're scale-dependent: a cloth
// grid spacing and ground class-threshold tuned for a ~1 m close-range plant
// scan (cloth 5 cm, threshold 2 cm) badly UNDER-segment a 50 m field/orchard
// scan. At cm resolution the cloth can't drape over metre-scale terrain relief,
// and a 2 cm class threshold rejects true ground points that settle further
// than that from the cloth — the failure mode is "nearly everything labelled
// non-ground" even when the ground is visually obvious. The fix is to seed the
// params from the cloud's extent when the segmentation panel opens.
//
// RELIEF MATTERS, not just horizontal extent. The original heuristic scaled
// cloth/threshold from horizontal extent alone (extent/100), which is right for
// a large *flat* field but exactly backwards for a large *steep* tile. On a
// 186 m-wide ALS forest tile with 81 m of relief (~15° slope), extent/100 seeds
// a 1.86 m cloth at rigidness 3 — a near-flat, rigid sheet that can't bend to
// follow the slope, so it drapes onto the valley floor and labels the entire
// uphill slope non-ground (measured: 3% ground, all in the lowest elevation
// band, on a tile whose true ground fraction is ~10–18%). Sloped terrain wants
// the OPPOSITE: a FINER cloth, rigidness 1 (so the cloth conforms instead of
// bridging), and slope-smoothing ON. So we detect relief via the relief ratio
// (vertical extent / horizontal extent) and switch recipe:
//
//   - Flat (low relief ratio): coarse-ish cloth ∝ extent, rigidness 3, no
//     slope-smooth. This is the Mission1 field/orchard case and is unchanged.
//   - Sloped (high relief ratio): fine cloth (≈ extent/200, capped at 1 m),
//     rigidness 1, slope-smooth ON. This is the BR04 ALS-forest-slope case.
//
// Calibration against real example datasets (measured with the CSF C-extension):
//   - Prunus close-range plant: hext ~1.5 m, relief ~tiny → cloth 0.05, thr 0.02
//   - Mission1 field/orchard:   hext ~50 m,  relief ~6 m (ratio 0.12, FLAT)
//                                            → cloth 0.5, thr 0.5, r3  (67% ground)
//   - BR04 ALS forest slope:    hext ~186 m, relief ~81 m (ratio 0.44, SLOPED)
//                                            → cloth 0.93, thr 0.5, r1, smooth
//                                              (3%→7% ground, spread across the
//                                               whole slope, 17→44/64 cells)
// The user can still override every field in the panel.

export interface GroundSegmentDefaults {
  clothResolution: number;
  classThreshold: number;
  rigidness: number;
  slopeSmooth: boolean;
}

// Seeding bounds. The panel's inputs allow finer values (cloth down to 0.005,
// threshold down to 0.001), but we never AUTO-seed below the plant-tuned floor
// — those very fine settings are an expert opt-in, not a sensible default.
const CLOTH_MIN = 0.05;
const CLOTH_MAX = 2;
const THRESH_MIN = 0.02;
const THRESH_MAX = 1;

// Fraction of horizontal extent used for cloth/threshold on FLAT terrain (see
// calibration above — extent/100 lands cloth 0.5 / thr 0.5 at 50 m).
const FLAT_EXTENT_FRACTION = 1 / 100;
// On SLOPED terrain a finer cloth is needed so it can bend to follow the slope
// instead of bridging over it; capped at 1 m so an enormous tile still drapes.
const SLOPE_CLOTH_FRACTION = 1 / 200;
const SLOPE_CLOTH_MAX = 1;
// A flatter class threshold works best on slopes (the cloth tracks the terrain,
// so ground points sit close to it); 0.5 m recovers ground across the relief
// without sweeping in low canopy.
const SLOPE_THRESHOLD = 0.5;

// Relief ratio = vertical extent / horizontal extent. Above this the terrain is
// treated as sloped/undulating and gets the conforming recipe. Mission1 sits at
// 0.12 (flat); BR04 at 0.44 (sloped). 0.2 (~11°) cleanly separates them and is
// a sensible geometric break between "essentially flat" and "needs to conform".
const SLOPE_RELIEF_RATIO = 0.2;

// ...but the relief ratio is computed from the cloud's BOUNDING BOX, which
// measures the tallest OBJECT, not the terrain. A single tree fills the box
// vertically regardless of how flat the ground under it is: the `tree_1`
// reference is a 8.4 m tree on a 9.2 m footprint of ground that is flat to
// within 47 cm, and scores 0.915 — deep in "sloped" territory, so it got the
// steep-terrain recipe (rigidness 1 + slope-smooth) purely because a tree is
// tall. That recipe makes the cloth conform to local structure, which is
// exactly wrong here: a conforming cloth climbs the trunk. Measured, it costs
// 43k extra misclassified trunk points versus the flat recipe.
//
// A tall isolated object and genuine terrain relief are separable by ASPECT:
// terrain that rises 0.44x its own width is a slope spanning the whole tile,
// while a tree is tall relative to its footprint but occupies a small part of
// it. Without per-point data (the panel only has bounds) the usable proxy is
// that a slope's relief is bounded by its run, whereas vegetation's is not —
// so a relief ratio ABOVE this is read as "something tall standing on the
// ground" rather than terrain, and falls back to the flat recipe. BR04's 0.44
// (a real ~15 deg slope) stays below it; tree_1's 0.915 and tree_4's 1.303 are
// both caught. A 1.0 ratio would be a 45 deg terrain slope sustained across the
// entire tile, which is far outside anything these tools target — note tree_4
// EXCEEDS that on bounding box alone while its ground is flat to 1.9 deg, which
// is the clearest demonstration that the box measures the tree, not the ground.
const VEGETATION_RELIEF_RATIO = 0.7;

function clampRound(value: number, lo: number, hi: number): number {
  const clamped = Math.max(lo, Math.min(hi, value));
  // 3 decimals keeps seeded values clean (0.5, 0.237) without float noise.
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Suggested CSF defaults for a cloud, seeded from its horizontal extent and
 * vertical relief. `horizontalExtentM` is the largest X/Y span (Z is up);
 * `verticalReliefM` is the Z span (optional — omit / pass 0 for the historical
 * flat-terrain behaviour). Falls back to the plant-scale default for a
 * non-finite or non-positive extent.
 *
 * Note the relief is the cloud's bounding-box height, so a tall plant reads as
 * "relief" it did not create; ratios above VEGETATION_RELIEF_RATIO are treated
 * as vegetation over flat ground rather than terrain (see the constant).
 */
export function groundSegmentDefaultsForExtent(
  horizontalExtentM: number,
  verticalReliefM = 0,
): GroundSegmentDefaults {
  const ext = Number.isFinite(horizontalExtentM) && horizontalExtentM > 0 ? horizontalExtentM : 1.5;
  const relief = Number.isFinite(verticalReliefM) && verticalReliefM > 0 ? verticalReliefM : 0;
  const reliefRatio = relief / ext;

  if (reliefRatio >= SLOPE_RELIEF_RATIO && reliefRatio < VEGETATION_RELIEF_RATIO) {
    // Sloped / undulating terrain: fine, low-rigidness, slope-smoothed cloth so
    // it conforms to the slope rather than bridging onto the valley floor.
    const cloth = Math.min(ext * SLOPE_CLOTH_FRACTION, SLOPE_CLOTH_MAX);
    return {
      clothResolution: clampRound(cloth, CLOTH_MIN, CLOTH_MAX),
      classThreshold: clampRound(SLOPE_THRESHOLD, THRESH_MIN, THRESH_MAX),
      rigidness: 1,
      slopeSmooth: true,
    };
  }

  // Flat terrain (default): coarse-ish cloth ∝ extent, stiff cloth, no smoothing.
  const scaled = ext * FLAT_EXTENT_FRACTION;
  return {
    clothResolution: clampRound(scaled, CLOTH_MIN, CLOTH_MAX),
    classThreshold: clampRound(scaled, THRESH_MIN, THRESH_MAX),
    rigidness: 3,
    slopeSmooth: false,
  };
}
