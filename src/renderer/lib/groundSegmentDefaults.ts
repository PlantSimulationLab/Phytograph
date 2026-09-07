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

// Airborne (ALS) clouds need a different recipe entirely, and the extent-scaled
// one above is actively harmful there. Measured over all 15 samples of the ISPRS
// filtertest benchmark (the standard ground-filtering reference, with per-point
// ground/non-ground labels), scoring the real CSF + threshold estimator:
//
//   extent-scaled seeding (what we shipped)   mean overall accuracy 0.7634
//   fixed cloth 0.75, rigidness 2, smooth     mean overall accuracy 0.8574
//
// A single FIXED recipe beats the adaptive one by 9 points. Why the adaptivity
// hurts: ext/100 on a 300-500 m tile asks for a 3-5 m cloth, CLOTH_MAX clamps it
// to 2.0, and on samp54 (median point spacing 2.03 m) that is a cloth FINER than
// the data supports — its nodes have no points to settle against, so it conforms
// to sampling noise instead of terrain. Accuracy there was 0.33.
//
// This is a REGIME SWITCH rather than a smarter formula because two candidate
// continuous drivers were tested and both are unsupported:
//   - extent: best-cloth per sample has no relationship to it (samp51 at 430 m
//     and samp23 at 206 m want the same cloth; samp61 at 504 m and samp42 at
//     227 m both want 1.0).
//   - spacing as a MAGNITUDE: best-cloth/spacing ranges 0.24-1.29 across the ALS
//     samples and 7.8-289 within close-range scans alone.
// What actually bounds the cloth is the height of the shortest object that must
// stay separable from ground — the bean fixture, whose plants sit a median
// 0.117 m up, collapses from 0.988 to 0.672 accuracy at cloth 0.25 — but that is
// only knowable AFTER a segmentation.
//
// Spacing fails as a magnitude yet works as a CLASSIFIER, a far weaker claim the
// data supports overwhelmingly: close-range scans measure 0.0020-0.0125 m and
// airborne ones 0.53-2.03 m, a 42x gap with nothing in between. 0.1 sits in that
// void, so the cutoff is not delicate.
//
// The cloth is 0.75 rather than the literature's habitual 0.5 because COST
// decides it. CSF simulates an (ext/cloth)^2 node grid ~500x, so halving the
// cloth quadruples the work: on a 430 m tile, cloth 0.5 measured 15.5 s against
// 7.6 s at 0.75. Accuracy across 0.40-0.75 is a plateau (0.854 / 0.853 / 0.857)
// that falls off only at 0.25 (0.785) and 1.0 (0.824), so 0.75 is at once the
// most accurate point measured and 2.3x cheaper than 0.5.
//
// Mirrored by `_ALS_SPACING_M` / `_ALS_CLOTH` in backend-api/main.py, which the
// DEM tool's auto path uses.
// BOTH conditions are required, and the extent one is not redundant. Spacing
// alone misreads a sparse SMALL cloud: 3D nearest-neighbour distance measures how
// far apart points are in space, so a volume-filling cloud reads far sparser than
// a surface scan of the same extent — 2000 points scattered through a 5 m cube
// measure 0.219 m, past the cutoff. Real close-range scans sample surfaces at
// 0.0017-0.0125 m and are nowhere near it, but "small and sparse" must not mean
// "airborne": every ISPRS sample spans 122-504 m while every close-range
// reference spans 5.9-12.6 m, so requiring both keeps such a cloud close-range,
// where a 0.75 m cloth would be absurd.
const ALS_SPACING_M = 0.1;
const ALS_MIN_EXTENT_M = 50;
const ALS_CLOTH = 0.75;
const ALS_CLASS_THRESHOLD = 0.5;

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
  pointSpacingM?: number,
): GroundSegmentDefaults {
  // Airborne clouds take a fixed recipe; see ALS_SPACING_M. Checked FIRST because
  // the extent/relief rules below are close-range calibrations that this data
  // does not obey — an ALS tile is large and can be steep, so it would otherwise
  // land in the sloped branch and get a cloth its point spacing cannot support.
  if (Number.isFinite(pointSpacingM ?? NaN)
      && (pointSpacingM as number) >= ALS_SPACING_M
      && Number.isFinite(horizontalExtentM) && horizontalExtentM >= ALS_MIN_EXTENT_M) {
    return {
      clothResolution: ALS_CLOTH,
      classThreshold: ALS_CLASS_THRESHOLD,
      rigidness: 2,
      slopeSmooth: true,
    };
  }

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
