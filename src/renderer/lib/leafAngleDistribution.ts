// Leaf angle distribution (LAD) analysis for a triangulated mesh.
//
// Pure logic (no React, no three.js viewer wiring) so it can be unit-tested and
// reused. Operates directly on the mesh geometry: each triangle contributes its
// inclination (zenith of the face normal) and azimuth, AREA-WEIGHTED — a large
// leaf face counts more than a sliver. This is distinct from the Helios
// /api/lad/compute pipeline (which inverts Beer's law for leaf area *density*);
// here we characterise the angular distribution of the leaf surfaces directly.
//
// The per-triangle angles/areas come from `triangleGeometry` in
// pointCloudHelpers.ts — the SAME function that drives the mesh's
// inclination/azimuth pseudocolor modes, so the plot and the colormap agree.
// Convention (Z up): inclination 0deg = horizontal leaf, 90deg = vertical.
//
// SOLID-ANGLE CONVENTION (important). The inclination PDF here is g(θ): leaf
// area PER UNIT INCLINATION ANGLE, normalized so ∫g dθ = 1 over [0,90°]. This is
// the SAME quantity the canonical de Wit archetypes are written in — their
// sin θ (the solid-angle / spherical-cap Jacobian) is already baked in: the
// `spherical` archetype is g(θ) = sin θ, NOT a flat line, precisely because a
// canopy with leaf normals uniform over the sphere of directions has more leaf
// area at mid-inclinations (~57°) than near 0° or 90°. We do NOT divide the
// empirical histogram by sin θ, and we do NOT add an extra sin θ to the
// canonical curves — both sides are g(θ), so the least-squares fit compares
// like with like. (Verified by the "mesh sampled as spherical fits spherical"
// unit test: the sampler emits triangles ∝ g(θ), i.e. ∝ sin θ for spherical.)

import type { MeshData } from './pointCloudTypes';
import { triangleGeometry, outwardRefForMesh } from './pointCloudHelpers';

// ---------------------------------------------------------------------------
// Empirical histograms (area-weighted)
// ---------------------------------------------------------------------------

export interface Histogram {
  binCenters: number[];  // bin midpoints (degrees)
  binWidth: number;      // bin width (degrees)
  // Probability density: weights normalized so sum(density * binWidth) == 1.
  // (Empty / all-NaN input yields all-zero density.)
  density: number[];
  // Total triangle area that contributed (excludes NaN-angle triangles).
  totalArea: number;
}

// Iterate a mesh's triangles, optionally restricted to one grid cell, calling
// `visit(angle, area)` for each triangle whose angle is finite. `pick` selects
// inclination vs azimuth from the per-triangle geometry.
function forEachTriangle(
  data: MeshData,
  cellId: number | undefined,
  pick: (g: { inclination: number; azimuth: number; area: number }) => number,
  visit: (angle: number, area: number) => void,
): void {
  const { vertices, indices, triangleCount, triangleCellIds } = data;
  // Orient azimuth toward the scanner when the mesh carries scan origins, so a
  // scanned closed surface reads a continuous outward bearing (no equator seam).
  const refFor = outwardRefForMesh(data);
  for (let t = 0; t < triangleCount; t++) {
    if (cellId !== undefined && triangleCellIds && triangleCellIds[t] !== cellId) continue;
    const g = triangleGeometry(vertices, indices, t, refFor ? refFor(t) : null);
    const angle = pick(g);
    if (Number.isFinite(angle) && g.area > 0) visit(angle, g.area);
  }
}

// Bin angles in [lo, hi) into `binCount` equal bins, weighting by area, and
// normalize to a probability density. Shared by inclination + azimuth.
function areaWeightedHistogram(
  data: MeshData,
  cellId: number | undefined,
  pick: (g: { inclination: number; azimuth: number; area: number }) => number,
  lo: number,
  hi: number,
  binCount: number,
): Histogram {
  const binWidth = (hi - lo) / binCount;
  const weights = new Array(binCount).fill(0);
  const binCenters = new Array(binCount);
  for (let b = 0; b < binCount; b++) binCenters[b] = lo + (b + 0.5) * binWidth;

  let totalArea = 0;
  forEachTriangle(data, cellId, pick, (angle, area) => {
    let b = Math.floor((angle - lo) / binWidth);
    if (b < 0) b = 0;
    if (b >= binCount) b = binCount - 1;  // include the hi endpoint in the last bin
    weights[b] += area;
    totalArea += area;
  });

  const density = new Array(binCount).fill(0);
  if (totalArea > 0) {
    for (let b = 0; b < binCount; b++) {
      density[b] = weights[b] / (totalArea * binWidth);
    }
  }
  return { binCenters, binWidth, density, totalArea };
}

export interface PdfOptions {
  binCount?: number;     // default 18 (5deg bins over 0..90)
  cellId?: number;       // restrict to one grid cell; omit for the whole mesh
}

// Area-weighted PDF of leaf inclination (zenith of face normal) over [0,90]deg.
export function computeInclinationPdf(data: MeshData, opts: PdfOptions = {}): Histogram {
  const binCount = opts.binCount ?? 18;
  return areaWeightedHistogram(data, opts.cellId, g => g.inclination, 0, 90, binCount);
}

// Area-weighted histogram of leaf azimuth over [0,360)deg, for the polar plot.
// Returned as a density (same normalization) so cells with different total area
// are comparable.
export function computeAzimuthHistogram(data: MeshData, opts: PdfOptions = {}): Histogram {
  const binCount = opts.binCount ?? 36;  // 10deg sectors
  return areaWeightedHistogram(data, opts.cellId, g => g.azimuth, 0, 360, binCount);
}

// The distinct grid cell ids present in a mesh (sorted), excluding the
// outside-grid sentinel. Returns [] when the mesh carries no cell ids (e.g.
// non-Helios) — callers then treat the whole mesh as a single distribution.
export function meshCellIds(data: MeshData): number[] {
  if (!data.triangleCellIds) return [];
  const seen = new Set<number>();
  for (let i = 0; i < data.triangleCellIds.length; i++) {
    const c = data.triangleCellIds[i];
    if (c !== 0xffffffff) seen.add(c);  // -1 stored as uint32
  }
  return [...seen].sort((a, b) => a - b);
}

// Triangle count per cell id (for labeling the cell tick-boxes).
export function triangleCountByCell(data: MeshData): Map<number, number> {
  const counts = new Map<number, number>();
  if (!data.triangleCellIds) return counts;
  for (let i = 0; i < data.triangleCellIds.length; i++) {
    const c = data.triangleCellIds[i];
    if (c === 0xffffffff) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Canonical de Wit leaf inclination distributions
// ---------------------------------------------------------------------------

// The six canonical de Wit archetypes as inclination probability densities
// g(theta) over theta in [0,90]deg, each integrating to 1 (de Wit 1965; Goel &
// Strebel 1984 parameterization; theta in radians inside the closed forms):
//   planophile   g = (2/pi)(1 + cos 2t)   — mostly horizontal leaves
//   erectophile  g = (2/pi)(1 - cos 2t)   — mostly vertical leaves
//   plagiophile  g = (2/pi)(1 - cos 4t)   — mostly ~45deg leaves
//   extremophile g = (2/pi)(1 + cos 4t)   — horizontal AND vertical
//   spherical    g = sin t                — angles as on a sphere surface (random)
//   uniform      g = 2/pi                 — every inclination equally likely
// Densities are per-radian; we evaluate at theta(deg) and the SSE fit below
// compares them to the empirical per-degree density after matching units.
export type DeWitModel =
  | 'planophile' | 'erectophile' | 'plagiophile'
  | 'extremophile' | 'spherical' | 'uniform';

export const DE_WIT_MODELS: DeWitModel[] = [
  'planophile', 'erectophile', 'plagiophile', 'extremophile', 'spherical', 'uniform',
];

const TWO_OVER_PI = 2 / Math.PI;

// Density per radian at inclination `deg` (0..90).
export function deWitDensityRad(model: DeWitModel, deg: number): number {
  const t = (deg * Math.PI) / 180;
  switch (model) {
    case 'planophile':   return TWO_OVER_PI * (1 + Math.cos(2 * t));
    case 'erectophile':  return TWO_OVER_PI * (1 - Math.cos(2 * t));
    case 'plagiophile':  return TWO_OVER_PI * (1 - Math.cos(4 * t));
    case 'extremophile': return TWO_OVER_PI * (1 + Math.cos(4 * t));
    case 'spherical':    return Math.sin(t);
    case 'uniform':      return TWO_OVER_PI;
  }
}

// Sample a canonical model on the same bin centers as an empirical histogram,
// returning a per-DEGREE density (so it overlays the empirical density curve,
// which is normalized per degree). Per-radian -> per-degree is * (pi/180).
export function deWitCurve(model: DeWitModel, binCenters: number[]): number[] {
  const k = Math.PI / 180;
  return binCenters.map(deg => deWitDensityRad(model, deg) * k);
}

export interface DeWitFit {
  best: DeWitModel;
  // Per-model goodness, sorted best-first. `sse` is sum of squared residuals vs
  // the empirical per-degree density; `r2` is the coefficient of determination
  // (can be negative for a poor model).
  scores: { model: DeWitModel; sse: number; r2: number }[];
}

// Fit all six canonical forms to an empirical inclination histogram by
// least-squares on the per-degree density, and return the best match. Returns
// null when there's no data to fit (empty histogram).
export function fitDeWit(hist: Histogram): DeWitFit | null {
  if (hist.totalArea <= 0) return null;
  const { binCenters, density } = hist;

  const mean = density.reduce((s, d) => s + d, 0) / density.length;
  const ssTot = density.reduce((s, d) => s + (d - mean) ** 2, 0) || 1e-30;

  const scores = DE_WIT_MODELS.map(model => {
    const curve = deWitCurve(model, binCenters);
    let sse = 0;
    for (let b = 0; b < density.length; b++) {
      sse += (density[b] - curve[b]) ** 2;
    }
    return { model, sse, r2: 1 - sse / ssTot };
  }).sort((a, b) => a.sse - b.sse);

  return { best: scores[0].model, scores };
}

// Human-readable label for a de Wit model (Title Case).
export function deWitLabel(model: DeWitModel): string {
  return model.charAt(0).toUpperCase() + model.slice(1);
}
