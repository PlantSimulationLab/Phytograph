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

// ---------------------------------------------------------------------------
// G(θ) — leaf-projection coefficient (Ross's G-function), measured directly
// ---------------------------------------------------------------------------

// G is the mean projection of unit leaf area onto the plane perpendicular to a
// beam: the fraction of a leaf that a beam "sees". We measure it directly from
// the mesh rather than assuming a distribution — G(θ) is the AREA-WEIGHTED mean
// of |n̂ · v̂| over the triangles, where n̂ is the unit face normal and v̂ the
// unit beam direction. (|·| because a leaf projects the same area whichever face
// the beam hits.) This is the same quantity Helios reports per voxel in the LAD
// inversion, here computed straight from the geometry.
//
// Beam direction per triangle:
//   - If the mesh carries scan provenance, v̂ points from the triangle centroid
//     toward the scanner that saw it (scan origin − centroid) — the true sensor
//     geometry.
//   - Otherwise (e.g. a triangulated plant model, no scanner) we use the
//     conventional NADIR view, v̂ = +Z (straight down). G(θ) then reduces to the
//     area-weighted mean of |cos(inclination)|, the standard nadir projection
//     coefficient — well-defined for any mesh.
//
// Returns null only when there's genuinely nothing to average (no triangles
// with finite area in the cell).
export function computeGTheta(data: MeshData, cellId?: number): number | null {
  const refFor = outwardRefForMesh(data);  // null ⇒ no scan provenance ⇒ nadir

  const { vertices, indices, triangleCount, triangleCellIds } = data;
  let weighted = 0;  // Σ area·|n̂·v̂|
  let totalArea = 0;
  for (let t = 0; t < triangleCount; t++) {
    if (cellId !== undefined && triangleCellIds && triangleCellIds[t] !== cellId) continue;

    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    const ax = vertices[i0 * 3], ay = vertices[i0 * 3 + 1], az = vertices[i0 * 3 + 2];
    const bx = vertices[i1 * 3], by = vertices[i1 * 3 + 1], bz = vertices[i1 * 3 + 2];
    const cx = vertices[i2 * 3], cy = vertices[i2 * 3 + 1], cz = vertices[i2 * 3 + 2];
    // n = (b - a) × (c - a); |n| = 2·area; direction = face normal.
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < 1e-20) continue;  // degenerate sliver, no normal
    const area = 0.5 * nlen;

    // Beam direction: triangle centroid → scanner when known, else nadir (+Z).
    let vx = 0, vy = 0, vz = 1;
    const ref = refFor ? refFor(t) : null;
    if (ref) {
      const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3, gz = (az + bz + cz) / 3;
      vx = ref.x - gx; vy = ref.y - gy; vz = ref.z - gz;
      const vlen = Math.hypot(vx, vy, vz);
      if (vlen < 1e-20) { vx = 0; vy = 0; vz = 1; }  // scanner at centroid → nadir
      else { vx /= vlen; vy /= vlen; vz /= vlen; }
    }

    // |n̂·v̂| — projection magnitude, sign-independent (either leaf face).
    const proj = Math.abs((nx * vx + ny * vy + nz * vz) / nlen);
    weighted += area * proj;
    totalArea += area;
  }

  if (totalArea <= 0) return null;
  return weighted / totalArea;
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

// ---------------------------------------------------------------------------
// Beta-distribution fit (Goel & Strebel 1984)
// ---------------------------------------------------------------------------

// A two-parameter Beta distribution is the standard continuous model for a leaf
// inclination distribution (Goel & Strebel 1984): inclination is normalized to
// t = theta/90 in [0,1], and a Beta(alpha,beta) density on t describes the
// canopy. The shape parameters are estimated by MOMENT MATCHING — the closed
// form that maps the mean and variance of t to (alpha,beta), no optimizer:
//   nu = tbar(1 - tbar)/var - 1,  alpha = tbar*nu,  beta = (1 - tbar)*nu
// This is the Goel-Strebel estimator and the one the literature reports.
//
// SOLID-ANGLE CONVENTION (same as de Wit above): the empirical `density` is
// g(theta) — leaf area per unit inclination angle, with the sin theta Jacobian
// already baked in. We fit the Beta DIRECTLY to g(theta), exactly as the de Wit
// archetypes are fit; we do NOT divide the histogram by sin theta. The mean and
// variance below are therefore the moments of the area-weighted g(theta), which
// is what we plot — so the fitted Beta overlays the empirical curve like-for-like.

// Natural log of the Gamma function (Lanczos approximation, g=7, n=9). Accurate
// to ~1e-15 for x > 0, which is all we need (alpha,beta are positive).
function lgamma(x: number): number {
  const G = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula: Gamma(x)Gamma(1-x) = pi / sin(pi x).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = C[0];
  const tmp = x + G + 0.5;
  for (let i = 1; i < G + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(tmp) - tmp + Math.log(a);
}

// Beta(alpha,beta) probability density at t in [0,1]. Uses lgamma for the
// normalizing 1/B(alpha,beta); t is clamped off the exact endpoints so a shape
// parameter < 1 (a density that diverges at an edge) yields a large-but-finite
// value rather than 0^(negative) = Infinity/NaN.
function betaPdfUnit(t: number, alpha: number, beta: number): number {
  const eps = 1e-9;
  const tc = Math.min(1 - eps, Math.max(eps, t));
  const logB = lgamma(alpha) + lgamma(beta) - lgamma(alpha + beta);
  const logPdf = (alpha - 1) * Math.log(tc) + (beta - 1) * Math.log(1 - tc) - logB;
  return Math.exp(logPdf);
}

// Sample a fitted Beta on the same bin centers as an empirical inclination
// histogram, returning a per-DEGREE density so it overlays the empirical density
// curve. The Beta is defined on t = deg/90, so the change of variable adds the
// Jacobian dt/dtheta = 1/90.
export function betaCurve(alpha: number, beta: number, binCenters: number[]): number[] {
  return binCenters.map(deg => betaPdfUnit(deg / 90, alpha, beta) / 90);
}

export interface BetaFit {
  alpha: number;
  beta: number;
  // Area-weighted mean inclination in DEGREES (= tbar * 90), for display.
  meanIncl: number;
  // Goodness vs the empirical per-degree density, computed like fitDeWit's:
  // `sse` is the sum of squared residuals, `r2` the coefficient of determination.
  sse: number;
  r2: number;
}

// Estimate Beta(alpha,beta) from an empirical inclination histogram by
// Goel-Strebel moment matching. Returns null when the fit is undefined:
//   - empty histogram (no area),
//   - zero variance (all mass in one bin — a Beta needs spread), or
//   - over-dispersed: var >= tbar(1 - tbar), where the moment estimator gives a
//     non-positive nu (no valid unimodal Beta matches those moments).
export function fitBeta(hist: Histogram): BetaFit | null {
  if (hist.totalArea <= 0) return null;
  const { binCenters, binWidth, density } = hist;

  // Moments of t = theta/90, weighted by the (already-normalized) density.
  let tbar = 0;
  for (let b = 0; b < density.length; b++) {
    const t = binCenters[b] / 90;
    tbar += density[b] * binWidth * t;
  }
  let variance = 0;
  for (let b = 0; b < density.length; b++) {
    const t = binCenters[b] / 90;
    variance += density[b] * binWidth * (t - tbar) ** 2;
  }
  if (variance <= 0) return null;

  const nu = (tbar * (1 - tbar)) / variance - 1;
  if (nu <= 0) return null;
  const alpha = tbar * nu;
  const beta = (1 - tbar) * nu;

  // Goodness of fit on the per-degree density, identical convention to fitDeWit.
  const mean = density.reduce((s, d) => s + d, 0) / density.length;
  const ssTot = density.reduce((s, d) => s + (d - mean) ** 2, 0) || 1e-30;
  const curve = betaCurve(alpha, beta, binCenters);
  let sse = 0;
  for (let b = 0; b < density.length; b++) sse += (density[b] - curve[b]) ** 2;

  return { alpha, beta, meanIncl: tbar * 90, sse, r2: 1 - sse / ssTot };
}
