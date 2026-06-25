// Adaptive default cell size for DEM (Digital Elevation Model) generation.
//
// Like the Cloth Simulation Filter parameters (see groundSegmentDefaults.ts), a
// DEM cell size is an ABSOLUTE distance and therefore scale-dependent: a 5 cm
// grid that's right for a ~1 m close-range plant scan produces an enormous,
// mostly-empty raster on a 50 m field tile, while a 0.5 m grid washes out a
// close-range scan. So we seed the cell size from the cloud's horizontal extent
// when the DEM panel opens.
//
// Unlike CSF, the cell size is purely a horizontal-resolution choice — terrain
// relief doesn't change what grid spacing is sensible — so there's no
// relief-ratio branch here. cellSize ≈ extent/100 gives ~256 cells across the
// larger axis at the seeding scale, clamped to a sane range. The user can
// override it in the panel (which allows finer values for expert use).

export interface DemDefaults {
  cellSize: number;
}

// Seeding bounds (metres). The panel input allows finer values; we never
// auto-seed below the plant-scale floor.
const CELL_MIN = 0.02;
const CELL_MAX = 2;
const EXTENT_FRACTION = 1 / 100;

function clampRound(value: number, lo: number, hi: number): number {
  const clamped = Math.max(lo, Math.min(hi, value));
  // 3 decimals keeps seeded values clean without float noise.
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Suggested DEM cell size for a cloud, seeded from its horizontal extent (the
 * larger of the X/Y spans, Z being up). Falls back to the plant-scale default
 * for a non-finite or non-positive extent.
 */
export function demDefaultsForExtent(horizontalExtentM: number): DemDefaults {
  const ext = Number.isFinite(horizontalExtentM) && horizontalExtentM > 0 ? horizontalExtentM : 1.5;
  return { cellSize: clampRound(ext * EXTENT_FRACTION, CELL_MIN, CELL_MAX) };
}
