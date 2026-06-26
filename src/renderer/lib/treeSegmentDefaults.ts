// Adaptive defaults for TreeIso individual-tree segmentation.
//
// Like the DEM cell size (see demDefaults.ts) and the CSF cloth parameters (see
// groundSegmentDefaults.ts), TreeIso's voxel-decimation sizes are ABSOLUTE
// distances and therefore scale-dependent. The upstream paper defaults
// (decimate_res1 5 cm, decimate_res2 10 cm) are tuned for ~1 m close-range TLS
// scans, where 5 cm voxels collapse a dense cloud to a few hundred thousand
// nodes before cut-pursuit runs.
//
// On a large/airborne tile the point SPACING is coarser than those voxels, so
// decimation becomes a no-op and cut-pursuit runs over the full N. Measured on
// the BR04 ALS tile (186 m extent, 2.64 M points, ~13 cm median spacing):
//
//   decimate_res = 0.05 m -> 2,616,372 voxels (99.2% of input)
//   decimate_res = 0.10 m -> 2,504,561 voxels (94.9% of input)
//
// Stage-1 cut-pursuit then builds a k-NN graph + graph cut over 2.6 M nodes and
// Stage-3's O(nGroups²) merge loop runs over millions of segments — the tool
// hangs for 15–20+ min. Coarsening decimation to ~0.5 m / 1.0 m drops the tile
// to 814 k / 269 k voxels and returns TreeIso to its intended regime. So we seed
// the decimation (and gap) defaults from the cloud's horizontal extent when the
// Segment Trees panel opens.
//
// The decimation knobs are NOT surfaced in the panel (raw voxel sizes are an
// implementation detail and a foot-gun — typing 0.05 on an ALS tile re-triggers
// the hang). They flow into the request invisibly. The backend additionally
// self-scales from the cloud's actual median point spacing (see
// _auto_treeiso_decimation in backend-api/main.py), so an un-seeded inline / eval
// call can't hang either. The user can still override the visible λ₁/λ₂/max-gap.
//
// Scaling is linear in extent, anchored so the 186 m BR04 tile lands at
// decimate_res1 ≈ 0.5 m, with a floor at the paper default so small TLS scans are
// unchanged.

export interface TreeSegmentDefaults {
  decimateRes1: number;
  decimateRes2: number;
  maxGap: number;
  maxOutlierGap: number;
}

// Seeding bounds (metres). DEC1_MIN is the upstream paper default, so any scan
// small enough to need finer decimation than the paper assumes stays exactly at
// the paper value — small TLS behaviour is unchanged.
const DEC1_MIN = 0.05;
const DEC1_MAX = 1.0;
// 186 / 372 = 0.5 → BR04 lands at decimate_res1 0.5 m, decimate_res2 1.0 m.
const DEC1_FRACTION = 1 / 372;

// Gap thresholds are occlusion-gap distances (tree-spacing scale), not
// density-driven, so the paper's 2 m / 3 m suit ALS forests already. We only
// loosen them on very large tiles (wider-spaced crowns); the floor keeps TLS
// scans at exactly 2 m / 3 m.
const MAX_GAP_FRACTION = 2 / 186;
const MAX_GAP_MIN = 2.0;
const MAX_GAP_MAX = 6.0;
const OUTLIER_GAP_RATIO = 1.5;

function clampRound(value: number, lo: number, hi: number): number {
  const clamped = Math.max(lo, Math.min(hi, value));
  // 3 decimals keeps seeded values clean without float noise.
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Suggested TreeIso decimation / gap defaults for a cloud, seeded from its
 * horizontal extent (the larger of the X/Y spans, Z being up). Falls back to the
 * upstream paper defaults for a non-finite or non-positive extent — and for any
 * small close-range scan, the clamps land exactly on those paper values.
 */
export function treeSegmentDefaultsForExtent(horizontalExtentM: number): TreeSegmentDefaults {
  const ext = Number.isFinite(horizontalExtentM) && horizontalExtentM > 0 ? horizontalExtentM : 1.5;
  const decimateRes1 = clampRound(ext * DEC1_FRACTION, DEC1_MIN, DEC1_MAX);
  // Preserve the paper's 2× res1:res2 ratio (5 cm → 10 cm).
  const decimateRes2 = clampRound(2 * decimateRes1, DEC1_MIN, 2 * DEC1_MAX);
  const maxGap = clampRound(ext * MAX_GAP_FRACTION, MAX_GAP_MIN, MAX_GAP_MAX);
  const maxOutlierGap = clampRound(OUTLIER_GAP_RATIO * maxGap, MAX_GAP_MIN, OUTLIER_GAP_RATIO * MAX_GAP_MAX);
  return { decimateRes1, decimateRes2, maxGap, maxOutlierGap };
}
