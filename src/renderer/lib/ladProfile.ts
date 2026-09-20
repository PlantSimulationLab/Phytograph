import type { LADResultEntry, LADVoxel } from './pointCloudTypes';
import { ladCellSize } from './ladExport';

/**
 * Vertical LAD profile and bulk LAI for a gridded LAD result.
 *
 * Both numbers already exist on the backend — LAI in `_lad_statistics_bytes`
 * (the summary .txt), the per-level binning in the occlusion `byLayer`
 * accounting — but only ever as bytes written to a file. This module recomputes
 * them from the in-memory result so the viewer can SHOW them, and it copies both
 * definitions exactly rather than inventing kinder ones. Any drift here would be
 * an app that reports a different LAI than the file it exports.
 *
 * The rule inherited from the backend, and the reason this file exists at all:
 * **an occluded voxel is not a zero.** Helios writes a hard 0 for a voxel the
 * beams never adequately probed, so summing `lad` over every cell silently
 * averages real canopy against canopy nobody measured, and biases LAD and LAI
 * low. Every aggregate below counts MEASURED voxels only — solved, adequately
 * probed, and not kriging-filled — and reports the excluded ones beside the
 * number rather than inside it.
 */

/** One horizontal slab of the grid. */
export interface LADProfileLevel {
  /** Helios k-major z-level, 0 = lowest. */
  level: number;
  /** Level center height, in the same frame as the result's voxel centers. */
  height: number;
  /** Slab thickness (m) — the voxel z size. */
  thickness: number;
  /** Mean LAD (m²/m³) over this level's MEASURED voxels; 0 when it has none. */
  meanLad: number;
  /** Population standard deviation of LAD across those same voxels. */
  stdLad: number;
  /** Summed leaf area (m²) over this level's measured voxels. */
  leafArea: number;
  /**
   * This level's contribution to LAI (m²/m²): its measured leaf area over the
   * FULL grid footprint. Summing this column over every level reproduces the
   * bulk LAI exactly — that identity is what makes the profile and the headline
   * number the same measurement rather than two similar ones.
   */
  laiContribution: number;
  /** Voxels present at this level, measured or not. */
  voxelCount: number;
  /** Of those, how many were real measurements. */
  measuredCount: number;
  /** Of those, how many were screened out as occluded (unsolved or under-sampled). */
  occludedCount: number;
  /** Of the occluded, how many carry an interpolated (kriged) LAD. */
  filledCount: number;
}

export interface LADProfile {
  levels: LADProfileLevel[];
  /** Bulk leaf area index (m²/m²): measured leaf area over the grid footprint. */
  lai: number;
  /** Measured leaf area (m²) — the numerator of `lai`. */
  leafArea: number;
  /** Ground footprint (m²) — the denominator of `lai`. */
  groundArea: number;
  /**
   * Leaf area (m²) sitting in kriging-filled voxels. Reported beside `lai`,
   * never inside it, exactly as the summary export does.
   */
  filledLeafArea: number;
  /**
   * What LAI would be if the filled voxels' interpolated area were counted.
   * This is the honest upper bracket on how much the occlusion screen is
   * withholding — shown as context, never as the headline.
   */
  laiWithFilled: number;
  /**
   * Wood area (m²) over MEASURED voxels, and the wood area index it gives over
   * the same footprint as `lai`. Both undefined when the result carries no
   * leaf/wood split, so a caller can tell "no classification" from "no wood".
   *
   * The same measured-voxel rule as `lai` — an occluded voxel is excluded here
   * too, for the identical reason. `wai` is TOTAL woody surface area per unit
   * ground while `lai` is one-sided leaf area, so `lai + wai` is PAI.
   */
  woodArea?: number;
  wai?: number;
  pai?: number;
  /** Voxels excluded from every aggregate above (unsolved or under-sampled). */
  occludedCount: number;
  totalCount: number;
  /**
   * True when the grid's voxels don't sit on uniform z levels — a
   * terrain-following grid gives every column its own base height. The level
   * bins are still exact (they are Helios cell indices, unaffected by the
   * column offsets), but `height` is then a MEAN over the level rather than a
   * single shared elevation, so it must be labelled as height above ground.
   */
  terrainFollow: boolean;
}

/** A voxel that is a real measurement: solved, adequately probed, not interpolated. */
export function isMeasured(v: LADVoxel): boolean {
  return v.solved !== false && v.underSampled !== true && v.ladFilled !== true;
}

/**
 * Compute the vertical profile and bulk LAI of a LAD result.
 *
 * Level assignment uses Helios's k-major cell order (`index // (nx*ny)`), the
 * same convention as the G(θ) vertical profile and the occlusion `byLayer`
 * accounting. It is deliberately NOT derived from the voxel's z coordinate:
 * on a terrain-following grid each column is lifted by its own ground height,
 * so equal-z voxels belong to DIFFERENT levels and a z-binned profile would
 * smear the canopy across slabs. The index survives that lift untouched.
 */
export function computeLadProfile(result: LADResultEntry): LADProfile {
  const nx = Math.max(1, result.nx);
  const ny = Math.max(1, result.ny);
  const nz = Math.max(1, result.nz);
  const cellsPerLevel = nx * ny;
  const [dx, dy, dz] = ladCellSize(result);

  // Accumulators per level. `sumLad`/`sumLadSq` cover measured voxels only, so
  // the mean and spread describe the canopy that was actually seen.
  const zeros = () => new Array<number>(nz).fill(0);
  const sumLad = zeros(), sumLadSq = zeros(), sumArea = zeros(), sumHeight = zeros();
  const nMeasured = zeros(), nVoxels = zeros(), nOccluded = zeros(), nFilled = zeros();

  let filledLeafArea = 0;
  // Wood totals; `sawWood` distinguishes a result with no split from one whose
  // wood genuinely sums to zero.
  let woodArea = 0;
  let sawWood = false;

  for (const v of result.voxels) {
    const level = Math.min(Math.max(0, Math.floor(v.index / cellsPerLevel)), nz - 1);
    nVoxels[level] += 1;
    sumHeight[level] += v.center[2];
    if (v.ladFilled === true) {
      nFilled[level] += 1;
      filledLeafArea += v.leafArea;
    }
    if (!isMeasured(v)) {
      nOccluded[level] += 1;
      continue;
    }
    nMeasured[level] += 1;
    sumLad[level] += v.lad;
    sumLadSq[level] += v.lad * v.lad;
    sumArea[level] += v.leafArea;
    // Wood rides the SAME measured-voxel gate as leaf: an occluded voxel is an
    // absence of measurement for both media, not a zero for either.
    if (v.woodArea != null) {
      woodArea += v.woodArea;
      sawWood = true;
    }
  }

  // The FULL grid footprint, not the occupied one. This matches the summary
  // export (`dx*nx * dy*ny`) — LAI is leaf area per unit ground, and the ground
  // under a column the beams missed is still ground.
  const groundArea = dx * nx * dy * ny;
  // The z origin of the lattice, used only to label levels on a flat grid.
  const z0 = result.bounds.min[2];

  const levels: LADProfileLevel[] = [];
  for (let k = 0; k < nz; k++) {
    const n = nMeasured[k];
    const mean = n > 0 ? sumLad[k] / n : 0;
    // Population variance, clamped at 0: catastrophic cancellation in
    // E[x²]−E[x]² can go slightly negative on a level whose voxels are identical.
    const variance = n > 0 ? Math.max(0, sumLadSq[k] / n - mean * mean) : 0;
    levels.push({
      level: k,
      // On a flat grid every voxel in a level shares one elevation, so the mean
      // IS that elevation. On a terrain-following grid the columns are lifted
      // individually and the mean is the honest summary — flagged as such by
      // `terrainFollow`. With no voxels at all (a level entirely dropped), fall
      // back to the nominal lattice height so the axis stays monotonic.
      height: nVoxels[k] > 0 ? sumHeight[k] / nVoxels[k] : z0 + (k + 0.5) * dz,
      thickness: dz,
      meanLad: mean,
      stdLad: Math.sqrt(variance),
      leafArea: sumArea[k],
      laiContribution: groundArea > 0 ? sumArea[k] / groundArea : 0,
      voxelCount: nVoxels[k],
      measuredCount: n,
      occludedCount: nOccluded[k],
      filledCount: nFilled[k],
    });
  }

  const leafArea = sumArea.reduce((a, b) => a + b, 0);
  const occludedCount = nOccluded.reduce((a, b) => a + b, 0);

  return {
    levels,
    lai: groundArea > 0 ? leafArea / groundArea : 0,
    leafArea,
    groundArea,
    filledLeafArea,
    laiWithFilled: groundArea > 0 ? (leafArea + filledLeafArea) / groundArea : 0,
    ...(sawWood ? {
      woodArea,
      wai: groundArea > 0 ? woodArea / groundArea : 0,
      pai: groundArea > 0 ? (leafArea + woodArea) / groundArea : 0,
    } : {}),
    occludedCount,
    totalCount: result.voxels.length,
    terrainFollow: result.terrainFollow === true,
  };
}

/**
 * The profile as CSV, one row per level.
 *
 * Carries the counts alongside the densities on purpose: a level whose mean LAD
 * rests on three measured voxels out of ninety is a very different number from
 * one that rests on all ninety, and a bare (height, lad) pair hides that.
 */
export function ladProfileCsv(profile: LADProfile, terrainFollow = profile.terrainFollow): string {
  const heightCol = terrainFollow
    ? 'mean_height_above_ground_m'
    : 'height_m';
  const rows = [
    `level,${heightCol},thickness_m,mean_lad_m2_m3,std_lad_m2_m3,leaf_area_m2,`
    + 'lai_contribution,voxel_count,measured_count,occluded_count,filled_count',
  ];
  for (const l of profile.levels) {
    rows.push([
      l.level,
      l.height.toFixed(4),
      l.thickness.toFixed(4),
      l.meanLad.toFixed(6),
      l.stdLad.toFixed(6),
      l.leafArea.toFixed(4),
      l.laiContribution.toFixed(6),
      l.voxelCount,
      l.measuredCount,
      l.occludedCount,
      l.filledCount,
    ].join(','));
  }
  // Trailing provenance so a CSV read months later still says what the profile
  // excluded and what the bulk number was.
  rows.push('');
  rows.push(`# bulk LAI (measured voxels only),${profile.lai.toFixed(6)}`);
  rows.push(`# measured leaf area m2,${profile.leafArea.toFixed(4)}`);
  rows.push(`# grid footprint m2,${profile.groundArea.toFixed(4)}`);
  rows.push(`# interpolated leaf area m2 (excluded),${profile.filledLeafArea.toFixed(4)}`);
  rows.push(`# LAI if interpolated area were included,${profile.laiWithFilled.toFixed(6)}`);
  rows.push(`# occluded voxels excluded,${profile.occludedCount} of ${profile.totalCount}`);
  // Wood, appended only when the result carries a split, so an unclassified
  // profile's CSV is byte-identical to before. The per-level COLUMNS are left
  // alone deliberately: they are a parsing contract, and the wood totals are
  // grid-scale numbers that belong with the other bulk provenance lines.
  if (profile.wai != null && profile.pai != null) {
    rows.push(`# measured wood surface area m2,${(profile.woodArea ?? 0).toFixed(4)}`);
    rows.push(`# bulk WAI (measured voxels only),${profile.wai.toFixed(6)}`);
    rows.push(`# bulk PAI (LAI + WAI),${profile.pai.toFixed(6)}`);
  }
  return rows.join('\n') + '\n';
}
