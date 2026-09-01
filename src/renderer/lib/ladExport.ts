import type { LADResultEntry } from './pointCloudTypes';
import type { LADExportCell, LADExportRequest } from '../utils/backendApi';

// Building the wire request for a gridded LAD export. Kept out of the component
// so the two things most likely to break silently — the stored→world shift and
// the raster-eligibility rule — are unit-testable without a viewer.

// Per-voxel variables offerable as rasters, in display order. Must stay in step
// with _LAD_EXPORT_VARIABLES on the backend, which rejects unknown names.
export const LAD_EXPORT_VARIABLES: { key: string; label: string }[] = [
  { key: 'lad', label: 'Leaf area density (m²/m³)' },
  { key: 'leaf_area', label: 'Leaf area (m²)' },
  { key: 'gtheta', label: 'G(θ)' },
  { key: 'hit_count', label: 'Hit count' },
  { key: 'beam_count', label: 'Beam count' },
  { key: 'relative_density_index', label: 'Relative density index' },
  { key: 'mean_path_length', label: 'Mean path length (m)' },
  { key: 'lad_std', label: 'LAD std (1/m)' },
];

// 'txt' is the plain-text grid summary — the one place LAI is reported, since no
// other format carries it. (A VoxLAD-flavoured '.asc' was offered briefly and
// removed: one tool's undocumented output, with a leaf-angle class we could only
// approximate. GeoTIFF is the interoperable option, .vox the community one.)
export type LadExportFormat = 'tif' | 'csv' | 'vox' | 'txt';

/**
 * Decode a base64 payload into bytes for `fs.writeBinary`.
 *
 * `atob` yields a binary string, so it has to be walked charCode by charCode —
 * a Blob/fetch round-trip would be async for no benefit here.
 */
export function base64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Why a raster can't be written for this result, or null when it can.
 *
 * A GeoTIFF is a regular north-up lattice by construction. A rotated grid's
 * voxels don't lie on one, and a terrain-following grid gives every column its
 * own starting z — so either would produce a confidently WRONG georeferenced
 * file. The text formats store each voxel's own center and are unaffected.
 */
export function rasterBlockedReason(result: LADResultEntry): string | null {
  if (result.gridRotationDeg && Math.abs(result.gridRotationDeg) > 1e-9) {
    return `This grid is rotated ${result.gridRotationDeg.toFixed(1)}°, so it has no `
      + 'axis-aligned raster lattice. Export CSV or .vox instead — both carry the '
      + 'true per-voxel positions.';
  }
  if (result.terrainFollow) {
    return 'This grid follows the terrain, so its voxel columns are not a regular '
      + 'raster lattice. Export CSV or .vox instead — both carry the true '
      + 'per-voxel positions.';
  }
  return null;
}

/**
 * Cell size from the grid extents. The response carries no explicit cell-size
 * field, so it is `gridSize / (nx, ny, nz)`; fall back to the first voxel's own
 * size (they are uniform within a grid) when a legacy result has no gridSize.
 */
export function ladCellSize(result: LADResultEntry): [number, number, number] {
  const n: [number, number, number] = [result.nx, result.ny, result.nz];
  if (result.gridSize) {
    return [result.gridSize[0] / n[0], result.gridSize[1] / n[1], result.gridSize[2] / n[2]];
  }
  const first = result.voxels[0];
  return first ? [...first.size] as [number, number, number] : [1, 1, 1];
}

/**
 * The grid's lower-left-bottom corner in WORLD coordinates.
 *
 * `bounds` is in the stored frame, so worldShift is added back here. On a
 * terrain-following grid `bounds` describes the UNSNAPPED box (the backend
 * computes it as gridCenter ± gridSize/2), which is exactly what we want as a
 * lattice origin — the per-voxel centers carry the actual column offsets.
 */
export function ladWorldOrigin(result: LADResultEntry): [number, number, number] {
  const ws = result.worldShift ?? [0, 0, 0];
  return [
    result.bounds.min[0] + ws[0],
    result.bounds.min[1] + ws[1],
    result.bounds.min[2] + ws[2],
  ];
}

/**
 * Build the export request for one result.
 *
 * Every coordinate is shifted stored→world here, once, so no downstream caller
 * has to remember to. `solved` defaults to true for a legacy voxel with no flag:
 * that preserves the old behaviour rather than silently voiding a whole grid.
 */
export function buildLadExportRequest(
  result: LADResultEntry,
  format: LadExportFormat,
  variables: string[],
  destDir?: string | null,
): LADExportRequest {
  const ws = result.worldShift ?? [0, 0, 0];
  const cells: LADExportCell[] = result.voxels.map(v => ({
    center: [v.center[0] + ws[0], v.center[1] + ws[1], v.center[2] + ws[2]],
    size: [...v.size] as [number, number, number],
    lad: v.lad,
    leaf_area: v.leafArea,
    gtheta: v.gtheta,
    hit_count: v.hitCount,
    beam_count: v.beamCount ?? null,
    relative_density_index: v.relativeDensityIndex ?? null,
    mean_path_length: v.meanPathLength ?? null,
    lad_variance: v.ladVariance ?? null,
    lad_std: v.ladStd ?? null,
    ci_valid: v.ciValid ?? null,
    leaf_area_ci_lower: v.leafAreaCiLower ?? null,
    leaf_area_ci_upper: v.leafAreaCiUpper ?? null,
    solved: v.solved !== false,
  }));

  return {
    format,
    cells,
    nx: result.nx,
    ny: result.ny,
    nz: result.nz,
    origin: ladWorldOrigin(result),
    cell_size: ladCellSize(result),
    variables,
    grid_rotation: result.gridRotationDeg ?? 0,
    terrain_follow: result.terrainFollow ?? false,
    crs_epsg: result.crsEpsg ?? null,
    ...(destDir ? { dest_dir: destDir } : {}),
  };
}
