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
// density-driven, so the paper's 2 m suits ALS forests already. We only loosen
// it on very large tiles (wider-spaced crowns); the floor keeps TLS scans at
// exactly 2 m.
const MAX_GAP_FRACTION = 2 / 186;
const MAX_GAP_MIN = 2.0;
const MAX_GAP_MAX = 6.0;

// `maxOutlierGap` is the post-merge SPLIT distance: how far apart one instance's
// own points may be and still be called one tree. It is NOT a looser twin of
// `maxGap` — the two point in opposite directions. `maxGap` is how far stage 2
// may reach ACROSS a void to connect an occluded limb back to its tree, so it
// wants to be generous; `maxOutlierGap` is the distance beyond which a body is
// declared a DIFFERENT tree, so it wants to be tight. Seeding it at 1.5x maxGap
// (the previous rule, a 3 m floor) made it unreachable in practice: measured on
// the Nickels tree_8 almond scan, segments genuinely belonging to one tree touch
// at 0.49-0.52 m while a neighbouring tree's branches were merged in across
// 0.92 m and 1.72 m, so nothing at or above 2 m ever splits anything and the
// knob was inert.
//
// The value is calibrated on TWO independent datasets rather than one, because a
// threshold tuned on a single scan generalises badly. Sweeping both:
//
//   Nickels almond tree_8 (8.85 m extent, the reported failure)
//     0.40  over-splits (12 trees) AND reabsorbs the neighbour
//     0.50-0.75  correct: focal tree ends at x=6.63, neighbour separated
//     1.00  neighbour reabsorbed into the focal tree again
//   TreeIso's own demo cloud (17.1 m extent, 9 GROUND-TRUTH trees)
//     0.40  badly over-segments: 22 trees, recall 0.968
//     0.50  one spurious split (10 trees)
//     0.55-0.90+  exactly 9 trees, purity/recall 0.995
//
// Safe on both = 0.55-0.75 m; 0.65 is its midpoint, so it carries the most
// margin against over-splitting below and re-merging above.
//
// For outside corroboration: treeX (2025), which ships a TLS-specific preset,
// uses a 0.5 m maximum crown region-growing radius for the same decision — how
// far a crown may extend before it stops belonging to that tree. That is the
// same order of magnitude, and measurably a touch too tight for this algorithm
// (0.5 splits the demo fixture's 9 trees into 10). There is no published default
// to copy: upstream TreeIso's PR_MAX_OUTLIER_GAP=3.0 is commented "trivial:
// post-processing to remove isolated points", i.e. noise cleanup rather than
// tree separation, and the CloudCompare TreeIso plugin — the reference
// implementation — exposes no outlier-gap parameter at all.
//
// Kept as a FLOOR that still scales with extent, on the same reasoning as the
// Deliberately NOT scaled by extent, unlike the decimation knobs above. That
// analogy is tempting and wrong: decimation tracks point SPACING, which really
// does change with survey scale, whereas this is a crown-to-crown separation set
// by canopy architecture. The two calibration clouds settle it — 8.85 m and
// 17.1 m extent, a ~2x difference, both correct at the same 0.65 m. Scaling it
// linearly (the first attempt here) pushed the 17.1 m demo cloud to 1.256 m,
// past the 0.75 m ceiling that cloud needs — and only the UI path would have
// shown it, since the backend default is a flat constant.
//
// It is still capped at `maxGap`: stage 2 uses maxGap to CONNECT an occluded
// limb back to its tree, so a split distance above it would tear apart exactly
// what stage 2 just joined.
const OUTLIER_GAP_DEFAULT = 0.65;

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
  const maxOutlierGap = clampRound(OUTLIER_GAP_DEFAULT, 0, maxGap);
  return { decimateRes1, decimateRes2, maxGap, maxOutlierGap };
}
