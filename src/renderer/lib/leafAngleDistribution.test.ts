import { describe, it, expect } from 'vitest';
import type { MeshData } from './pointCloudTypes';
import { triangleGeometry } from './pointCloudHelpers';
import {
  computeInclinationPdf,
  computeAzimuthHistogram,
  fitDeWit,
  deWitDensityRad,
  deWitCurve,
  fitBeta,
  betaCurve,
  computeGTheta,
  computeCellDistributions,
  meshCellIds,
  triangleCountByCell,
  DE_WIT_MODELS,
} from './leafAngleDistribution';

// ---------------------------------------------------------------------------
// Synthetic-mesh builders
// ---------------------------------------------------------------------------

// Build a single triangle whose face normal points at zenith `inclDeg` (angle
// from +Z) and azimuth `azDeg`, scaled so its area ≈ `area`. We place a
// right-isosceles triangle in the plane perpendicular to that normal: pick two
// orthonormal in-plane axes (u, v) and use vertices {0, s·u, s·v}; its area is
// s²/2, so s = sqrt(2·area).
function triFromNormal(inclDeg: number, azDeg: number, area: number): number[] {
  const incl = (inclDeg * Math.PI) / 180;
  const az = (azDeg * Math.PI) / 180;
  // Normal at zenith `incl`, azimuth `az` (Z up).
  const nx = Math.sin(incl) * Math.cos(az);
  const ny = Math.sin(incl) * Math.sin(az);
  const nz = Math.cos(incl);
  // An in-plane axis u perpendicular to n: cross n with a non-parallel ref.
  const refx = Math.abs(nz) < 0.9 ? 0 : 1, refy = 0, refz = Math.abs(nz) < 0.9 ? 1 : 0;
  let ux = ny * refz - nz * refy;
  let uy = nz * refx - nx * refz;
  let uz = nx * refy - ny * refx;
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  // v = n × u (already unit, orthogonal to both).
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  const s = Math.sqrt(2 * area);
  return [0, 0, 0, s * ux, s * uy, s * uz, s * vx, s * vy, s * vz];
}

// Assemble a MeshData from a list of triangles. Each triangle is 9 floats (3
// vertices); vertices are NOT shared (fine for these tests). `cellIds` (one per
// triangle) is optional.
function meshFromTris(tris: number[][], cellIds?: number[]): MeshData {
  const triangleCount = tris.length;
  const vertices = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    vertices.set(tris[t], t * 9);
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  const data: MeshData = { vertices, indices, vertexCount: triangleCount * 3, triangleCount };
  if (cellIds) data.triangleCellIds = Uint32Array.from(cellIds.map(c => c < 0 ? 0xffffffff : c));
  return data;
}

// ---------------------------------------------------------------------------
// Sanity: the builder produces the requested inclination
// ---------------------------------------------------------------------------

describe('triFromNormal sanity (via triangleGeometry)', () => {
  it.each([0, 15, 30, 45, 60, 90])('produces inclination ≈ %i°', (deg) => {
    const m = meshFromTris([triFromNormal(deg, 37, 1)]);
    const g = triangleGeometry(m.vertices, m.indices, 0);
    expect(g.inclination).toBeCloseTo(deg, 4);
    expect(g.area).toBeCloseTo(1, 4);
  });
});

// ---------------------------------------------------------------------------
// Area weighting — the critical requirement
// ---------------------------------------------------------------------------

describe('computeInclinationPdf area weighting', () => {
  it('one large horizontal triangle outweighs many tiny vertical ones', () => {
    // 1 horizontal (incl 0) of area 100, plus 50 vertical (incl 90) of area 0.1
    // each (total 5). Area-weighted, horizontal must dominate; a count-weighted
    // histogram would wrongly call this mostly-vertical.
    const tris = [triFromNormal(0, 0, 100)];
    for (let i = 0; i < 50; i++) tris.push(triFromNormal(90, (i * 7) % 360, 0.1));
    const pdf = computeInclinationPdf(meshFromTris(tris), { binCount: 18 });

    const firstBin = pdf.density[0];          // 0–5°
    const lastBin = pdf.density[pdf.density.length - 1]; // 85–90°
    expect(firstBin).toBeGreaterThan(lastBin * 10);
    expect(pdf.totalArea).toBeCloseTo(105, 5);
  });

  it('density integrates to 1 over [0,90]', () => {
    const tris = [
      triFromNormal(10, 0, 3), triFromNormal(40, 90, 1),
      triFromNormal(70, 200, 2), triFromNormal(85, 300, 0.5),
    ];
    const pdf = computeInclinationPdf(meshFromTris(tris));
    const integral = pdf.density.reduce((s, d) => s + d * pdf.binWidth, 0);
    expect(integral).toBeCloseTo(1, 6);
  });

  it('empty / degenerate input yields zero density (no NaNs)', () => {
    const pdf = computeInclinationPdf(meshFromTris([]));
    expect(pdf.totalArea).toBe(0);
    expect(pdf.density.every(d => d === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cell filtering
// ---------------------------------------------------------------------------

describe('per-cell restriction', () => {
  const data = meshFromTris(
    [triFromNormal(0, 0, 1), triFromNormal(0, 0, 1), triFromNormal(90, 0, 1)],
    [0, 0, 1],
  );

  it('meshCellIds lists distinct cells, sorted, ignoring -1', () => {
    const withOutside = meshFromTris(
      [triFromNormal(0, 0, 1), triFromNormal(0, 0, 1)], [2, -1]);
    expect(meshCellIds(data)).toEqual([0, 1]);
    expect(meshCellIds(withOutside)).toEqual([2]);
  });

  it('triangleCountByCell counts per cell', () => {
    const counts = triangleCountByCell(data);
    expect(counts.get(0)).toBe(2);
    expect(counts.get(1)).toBe(1);
  });

  it('cellId restricts the PDF to that cell', () => {
    const cell0 = computeInclinationPdf(data, { cellId: 0 });
    const cell1 = computeInclinationPdf(data, { cellId: 1 });
    // Cell 0 is all horizontal → mass in first bin; cell 1 all vertical → last.
    expect(cell0.density[0]).toBeGreaterThan(0);
    expect(cell0.density[cell0.density.length - 1]).toBe(0);
    expect(cell1.density[0]).toBe(0);
    expect(cell1.density[cell1.density.length - 1]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Azimuth histogram
// ---------------------------------------------------------------------------

describe('computeAzimuthHistogram', () => {
  it('area-weights azimuth into the correct sector', () => {
    // Two tilted faces: one pointing east (az 0), one north (az 90), east larger.
    const data = meshFromTris([triFromNormal(45, 0, 4), triFromNormal(45, 90, 1)]);
    const hist = computeAzimuthHistogram(data, { binCount: 36 }); // 10° sectors
    const eastBin = hist.density[0];        // 0–10°
    const northBin = hist.density[9];       // 90–100°
    expect(eastBin).toBeGreaterThan(northBin);
    const integral = hist.density.reduce((s, d) => s + d * hist.binWidth, 0);
    expect(integral).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// de Wit canonical forms
// ---------------------------------------------------------------------------

describe('de Wit canonical densities', () => {
  it('each canonical density integrates to ~1 over [0,90] (per-radian form)', () => {
    const N = 9000;
    const dt = (Math.PI / 2) / N;
    for (const model of DE_WIT_MODELS) {
      let integral = 0;
      for (let i = 0; i < N; i++) {
        const deg = ((i + 0.5) * dt) * (180 / Math.PI);
        integral += deWitDensityRad(model, deg) * dt;
      }
      expect(integral).toBeCloseTo(1, 2);
    }
  });

  it('planophile peaks at horizontal, erectophile at vertical', () => {
    expect(deWitDensityRad('planophile', 0)).toBeGreaterThan(deWitDensityRad('planophile', 90));
    expect(deWitDensityRad('erectophile', 90)).toBeGreaterThan(deWitDensityRad('erectophile', 0));
    // Plagiophile peaks near 45°.
    expect(deWitDensityRad('plagiophile', 45)).toBeGreaterThan(deWitDensityRad('plagiophile', 5));
    expect(deWitDensityRad('plagiophile', 45)).toBeGreaterThan(deWitDensityRad('plagiophile', 85));
  });

  // Guards the solid-angle convention: spherical is g(θ)=sin θ (the sin θ
  // Jacobian is baked IN), so it is NOT flat — it peaks at 90° and is zero at
  // 0°. A canopy "random in all directions" therefore has a non-uniform g(θ).
  it('spherical g(θ)=sin θ is non-flat: 0 at horizontal, max at vertical', () => {
    expect(deWitDensityRad('spherical', 0)).toBeCloseTo(0, 6);
    expect(deWitDensityRad('spherical', 90)).toBeCloseTo(1, 6);
    expect(deWitDensityRad('spherical', 90)).toBeGreaterThan(deWitDensityRad('spherical', 30));
    // Distinct from uniform, which IS flat at 2/π everywhere.
    expect(deWitDensityRad('uniform', 0)).toBeCloseTo(2 / Math.PI, 6);
    expect(deWitDensityRad('uniform', 90)).toBeCloseTo(2 / Math.PI, 6);
  });
});

// The empirical PDF and the canonical curves use the SAME convention (g(θ),
// area per unit inclination, sin θ baked in). This is the consistency guarantee:
// a canopy sampled "random in all directions" (spherical) must read as spherical
// — NOT uniform — and its empirical PDF must rise with θ, not be flat. If one
// side ever divided by sin θ and the other didn't, this would fail.
describe('solid-angle convention is consistent across empirical PDF and fit', () => {
  // Equal-area facets whose normals are uniform over the sphere of directions.
  // Drawing inclination ∝ sin θ reproduces that (more facets at high θ). We do
  // it deterministically: emit a count ∝ sin θ per 1° inclination bin.
  function sphericalMesh(): MeshData {
    const tris: number[][] = [];
    for (let deg = 0.5; deg < 90; deg += 1) {
      const count = Math.round(Math.sin((deg * Math.PI) / 180) * 300);
      for (let k = 0; k < count; k++) tris.push(triFromNormal(deg, (deg * 17 + k * 31) % 360, 1));
    }
    return meshFromTris(tris);
  }

  it('a "random in all directions" canopy reads spherical, not uniform', () => {
    const pdf = computeInclinationPdf(sphericalMesh(), { binCount: 18 });
    const fit = fitDeWit(pdf)!;
    expect(fit.best).toBe('spherical');
    const uniformScore = fit.scores.find(s => s.model === 'uniform')!;
    expect(fit.scores[0].sse).toBeLessThan(uniformScore.sse);
  });

  it('its empirical PDF rises with inclination (the sin θ weighting is present)', () => {
    const pdf = computeInclinationPdf(sphericalMesh(), { binCount: 18 });
    const first = pdf.density[0];                       // 0–5°
    const last = pdf.density[pdf.density.length - 1];   // 85–90°
    // sin θ ⇒ far more leaf area near vertical than near horizontal.
    expect(last).toBeGreaterThan(first * 5);
  });
});

// Build a mesh whose inclination distribution follows a target density g(θ),
// by sampling many equal-area triangles with inclinations drawn proportional to
// g(θ) on a deterministic grid (no RNG — workflow-friendly + reproducible).
function meshSampledFromDensity(g: (deg: number) => number): MeshData {
  const tris: number[][] = [];
  // Fine inclination grid; emit a count of unit-area triangles per bin ∝ g.
  for (let deg = 0.5; deg < 90; deg += 1) {
    const weight = Math.max(0, g(deg));
    const count = Math.round(weight * 200);
    for (let k = 0; k < count; k++) {
      tris.push(triFromNormal(deg, (deg * 13 + k * 29) % 360, 1));
    }
  }
  return meshFromTris(tris);
}

describe('fitDeWit picks the right archetype', () => {
  it.each(DE_WIT_MODELS)('a mesh sampled as %s fits %s best', (model) => {
    const k = Math.PI / 180;
    const data = meshSampledFromDensity(deg => deWitDensityRad(model, deg) * k);
    const pdf = computeInclinationPdf(data, { binCount: 18 });
    const fit = fitDeWit(pdf)!;
    expect(fit).not.toBeNull();
    expect(fit.best).toBe(model);
    // Best fit should be a good fit. For `uniform` the empirical density is
    // ~constant so its variance (ssTot) ≈ 0 and R² is ill-defined; check the
    // residual is tiny instead. For the others, R² should be high.
    if (model === 'uniform') {
      expect(fit.scores[0].sse).toBeLessThan(1e-4);
    } else {
      expect(fit.scores[0].r2).toBeGreaterThan(0.85);
    }
  });

  it('all-horizontal mesh reads as planophile', () => {
    const data = meshFromTris(
      Array.from({ length: 40 }, (_, i) => triFromNormal(2, (i * 9) % 360, 1)));
    expect(fitDeWit(computeInclinationPdf(data))!.best).toBe('planophile');
  });

  it('all-vertical mesh reads as erectophile', () => {
    const data = meshFromTris(
      Array.from({ length: 40 }, (_, i) => triFromNormal(88, (i * 9) % 360, 1)));
    expect(fitDeWit(computeInclinationPdf(data))!.best).toBe('erectophile');
  });

  it('returns null for an empty histogram', () => {
    expect(fitDeWit(computeInclinationPdf(meshFromTris([])))).toBeNull();
  });
});

describe('deWitCurve overlays on the empirical density scale', () => {
  it('returns per-degree density matching one sample point', () => {
    const curve = deWitCurve('uniform', [45]);
    // Uniform per-radian density is 2/π; per-degree is (2/π)·(π/180) = 1/90.
    expect(curve[0]).toBeCloseTo(1 / 90, 8);
  });
});

// ---------------------------------------------------------------------------
// Beta-distribution fit (Goel & Strebel moment matching)
// ---------------------------------------------------------------------------

describe('fitBeta (Goel-Strebel moment matching)', () => {
  it('recovers the shape parameters of a mesh sampled from a known Beta', () => {
    // Build a mesh whose inclination density follows Beta(2, 4) on t=θ/90, using
    // the same per-degree density the fit will compare against (betaCurve).
    const data = meshSampledFromDensity(deg => betaCurve(2, 4, [deg])[0]);
    const pdf = computeInclinationPdf(data, { binCount: 18 });
    const fit = fitBeta(pdf)!;
    expect(fit).not.toBeNull();
    // 5° bins + integer-count sampling blur the moments a little; ±0.3 is ample.
    expect(Math.abs(fit.alpha - 2)).toBeLessThan(0.3);
    expect(Math.abs(fit.beta - 4)).toBeLessThan(0.3);
    expect(fit.r2).toBeGreaterThan(0.9);
  });

  it('planophile (mostly-horizontal) mesh → small mean, α<β (mass near 0)', () => {
    // A planophile g(θ) — most leaf area at low inclination — gives a left-
    // skewed Beta. (A single-inclination mesh has zero variance and no Beta;
    // a realistic distribution does.)
    const k = Math.PI / 180;
    const data = meshSampledFromDensity(deg => deWitDensityRad('planophile', deg) * k);
    const fit = fitBeta(computeInclinationPdf(data))!;
    expect(fit.meanIncl).toBeLessThan(35);
    expect(fit.alpha).toBeLessThan(fit.beta);
  });

  it('erectophile (mostly-vertical) mesh → large mean, α>β (mass near 1)', () => {
    const k = Math.PI / 180;
    const data = meshSampledFromDensity(deg => deWitDensityRad('erectophile', deg) * k);
    const fit = fitBeta(computeInclinationPdf(data))!;
    expect(fit.meanIncl).toBeGreaterThan(55);
    expect(fit.alpha).toBeGreaterThan(fit.beta);
  });

  it('meanIncl is the area-weighted mean inclination in degrees', () => {
    // Two triangles: incl 20° area 3, incl 60° area 1. Area-weighted mean =
    // (20·3 + 60·1)/4 = 30°. (Binned at 18 bins → 5° wide; 20° and 60° fall at
    // bin centers 22.5° and 62.5°, weighted-mean 32.5° — assert against the
    // binned value the histogram actually carries.)
    const data = meshFromTris([triFromNormal(20, 0, 3), triFromNormal(60, 90, 1)]);
    const pdf = computeInclinationPdf(data, { binCount: 18 });
    const fit = fitBeta(pdf)!;
    // Recompute the expected binned mean directly from the histogram density.
    const expected = pdf.binCenters.reduce(
      (s, c, b) => s + pdf.density[b] * pdf.binWidth * c, 0);
    expect(fit.meanIncl).toBeCloseTo(expected, 6);
  });

  it('returns null for an empty histogram', () => {
    expect(fitBeta(computeInclinationPdf(meshFromTris([])))).toBeNull();
  });

  // For the variance-degeneracy guards we build the Histogram directly: binning a
  // mesh always smears a little mass across adjacent bins (45° straddles a bin
  // edge), so a hand-built single-mass / extreme-bimodal histogram is the
  // unambiguous way to hit var=0 and var≥tbar(1-tbar).
  function histFrom(binCount: number, mass: number[]): {
    binCenters: number[]; binWidth: number; density: number[]; totalArea: number;
  } {
    const binWidth = 90 / binCount;
    const binCenters = Array.from({ length: binCount }, (_, b) => (b + 0.5) * binWidth);
    const total = mass.reduce((s, m) => s + m, 0);
    const density = mass.map(m => m / (total * binWidth));
    return { binCenters, binWidth, density, totalArea: total };
  }

  it('returns null when all mass is in one bin (zero variance)', () => {
    const hist = histFrom(18, Array.from({ length: 18 }, (_, b) => (b === 4 ? 1 : 0)));
    expect(fitBeta(hist)).toBeNull();
  });

  it('returns null at the variance bound (var = tbar(1−tbar) → nu ≤ 0)', () => {
    // The moment estimator is only valid for var < tbar(1−tbar). Equality is the
    // Bernoulli extreme — all mass at t=0 and t=1 (θ=0° and 90°). A real binned
    // histogram never quite reaches it (interior bin centers), but the guard must
    // hold at the boundary, so we build that degenerate histogram explicitly.
    const hist = {
      binCenters: [0, 90], binWidth: 90,
      // density on [0,90]: equal mass at the two endpoints, ∫density·binWidth=1.
      density: [1 / 180, 1 / 180], totalArea: 2,
    };
    expect(fitBeta(hist)).toBeNull();
  });

  it('produces no NaNs for a valid fit', () => {
    const data = meshSampledFromDensity(deg => betaCurve(3, 2, [deg])[0]);
    const fit = fitBeta(computeInclinationPdf(data))!;
    for (const v of [fit.alpha, fit.beta, fit.meanIncl, fit.sse, fit.r2]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('betaCurve overlays on the empirical density scale', () => {
  it('integrates to ~1 over [0,90] for valid shape parameters', () => {
    const binCount = 90;
    const binWidth = 90 / binCount;
    const centers = Array.from({ length: binCount }, (_, b) => (b + 0.5) * binWidth);
    const curve = betaCurve(2.5, 3.5, centers);
    const integral = curve.reduce((s, d) => s + d * binWidth, 0);
    expect(integral).toBeCloseTo(1, 2);
  });

  it('is symmetric for α=β (peak at 45°)', () => {
    const curve = betaCurve(3, 3, [10, 45, 80]);
    expect(curve[1]).toBeGreaterThan(curve[0]);
    expect(curve[1]).toBeGreaterThan(curve[2]);
    expect(curve[0]).toBeCloseTo(curve[2], 6);
  });
});

// ---------------------------------------------------------------------------
// computeGTheta — measured leaf-projection coefficient
// ---------------------------------------------------------------------------

// Attach scan provenance to a mesh: one scanner origin, all triangles seen by
// it (scan id 0). computeGTheta needs both buffers or it returns null.
function withScanner(data: MeshData, origin: [number, number, number]): MeshData {
  return {
    ...data,
    triangleScanIds: Uint32Array.from(new Array(data.triangleCount).fill(0)),
    scanOrigins: Float32Array.from(origin),
  };
}

describe('computeGTheta (measured projection coefficient)', () => {
  it('falls back to the nadir view when the mesh has no scan origins', () => {
    // No provenance ⇒ beam = +Z (straight down), so G = mean |cos(inclination)|.
    // Horizontal leaf (incl 0): |cos 0| = 1.
    expect(computeGTheta(meshFromTris([triFromNormal(0, 0, 1)]))!).toBeCloseTo(1, 3);
    // Vertical leaf (incl 90): |cos 90| = 0.
    expect(computeGTheta(meshFromTris([triFromNormal(90, 0, 1)]))!).toBeCloseTo(0, 3);
    // 60° leaf: |cos 60| = 0.5.
    expect(computeGTheta(meshFromTris([triFromNormal(60, 0, 1)]))!).toBeCloseTo(0.5, 3);
  });

  it('returns null only when there are no usable triangles', () => {
    // Empty mesh — nothing to average, even with the nadir fallback.
    expect(computeGTheta(meshFromTris([]))).toBeNull();
  });

  it('is 1 when the beam looks straight down the normal (face-on)', () => {
    // Horizontal triangle (normal ‖ +Z), scanner directly above its centroid:
    // beam direction is +Z, |n̂·v̂| = 1.
    const tri = triFromNormal(0, 0, 1);
    // Centroid of triFromNormal(0,…) lies in the z=0 plane; put the scanner high
    // above the origin so the beam is essentially vertical.
    const mesh = withScanner(meshFromTris([tri]), [0, 0, 1000]);
    expect(computeGTheta(mesh)!).toBeCloseTo(1, 3);
  });

  it('is ~0 when the beam grazes the leaf edge-on', () => {
    // Vertical triangle (normal in the XY plane, pointing +X), scanner far away
    // along +Z so the beam (≈+Z) is perpendicular to the normal: |n̂·v̂| ≈ 0.
    const tri = triFromNormal(90, 0, 1);
    const mesh = withScanner(meshFromTris([tri]), [0, 0, 1e6]);
    expect(computeGTheta(mesh)!).toBeCloseTo(0, 3);
  });

  it('equals |cos 45°| ≈ 0.707 for a leaf tilted 45° to a vertical beam', () => {
    // Normal at 45° zenith (azimuth 0 ⇒ tilts toward +X), scanner far up +Z so
    // the beam is +Z. |n̂·v̂| = |cos 45°|.
    const tri = triFromNormal(45, 0, 1);
    const mesh = withScanner(meshFromTris([tri]), [0, 0, 1e6]);
    expect(computeGTheta(mesh)!).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('is area-weighted across triangles', () => {
    // Big face-on triangle (proj 1) + small edge-on triangle (proj 0). The mean
    // is weighted by area, so a 9× larger face-on triangle pulls G toward 1.
    const faceOn = triFromNormal(0, 0, 9);    // area 9, proj 1
    const edgeOn = triFromNormal(90, 0, 1);   // area 1, proj ~0
    const mesh = withScanner(meshFromTris([faceOn, edgeOn]), [0, 0, 1e6]);
    // (9·1 + 1·0) / (9 + 1) = 0.9.
    expect(computeGTheta(mesh)!).toBeCloseTo(0.9, 2);
  });

  it('respects the cell-id filter', () => {
    // Two cells: cell 0 is face-on (G=1), cell 1 is edge-on (G=0).
    const mesh = withScanner(
      meshFromTris([triFromNormal(0, 0, 1), triFromNormal(90, 0, 1)], [0, 1]),
      [0, 0, 1e6],
    );
    expect(computeGTheta(mesh, 0)!).toBeCloseTo(1, 3);
    expect(computeGTheta(mesh, 1)!).toBeCloseTo(0, 3);
  });
});

// ---------------------------------------------------------------------------
// computeCellDistributions — single-pass parity with the per-cell functions
// ---------------------------------------------------------------------------

describe('computeCellDistributions (single pass)', () => {
  // A mesh spanning three cells (0,1,2) plus an outside-grid triangle (-1),
  // varied inclinations/azimuths, with scan provenance so the G(θ) path uses the
  // real scanner-beam direction (not just the nadir fallback).
  const tris = [
    triFromNormal(10, 20, 3), triFromNormal(80, 200, 1),   // cell 0
    triFromNormal(45, 90, 2), triFromNormal(45, 270, 2),   // cell 1
    triFromNormal(0, 0, 5),                                 // cell 2 (horizontal)
    triFromNormal(60, 130, 1),                              // outside grid (-1)
  ];
  const base = meshFromTris(tris, [0, 0, 1, 1, 2, -1]);
  const mesh = withScanner(base, [2, -3, 50]);
  const cellIds = meshCellIds(mesh);  // [0,1,2]

  it('per-cell PDFs/histograms/G(θ) match the one-cell-at-a-time functions', () => {
    const dists = computeCellDistributions(mesh, cellIds, 18, 36);
    expect([...dists.keys()].sort((a, b) => a - b)).toEqual(cellIds);

    for (const id of cellIds) {
      const d = dists.get(id)!;
      const incl = computeInclinationPdf(mesh, { binCount: 18, cellId: id });
      const az = computeAzimuthHistogram(mesh, { binCount: 36, cellId: id });
      const g = computeGTheta(mesh, id);

      expect(d.inclPdf.totalArea).toBeCloseTo(incl.totalArea, 6);
      expect(d.azHist.totalArea).toBeCloseTo(az.totalArea, 6);
      d.inclPdf.density.forEach((v, b) => expect(v).toBeCloseTo(incl.density[b], 6));
      d.azHist.density.forEach((v, b) => expect(v).toBeCloseTo(az.density[b], 6));
      expect(d.gtheta!).toBeCloseTo(g!, 6);
    }
  });

  it('honors a non-default inclination bin count', () => {
    const dists = computeCellDistributions(mesh, cellIds, 9, 36);
    const d = dists.get(0)!;
    expect(d.inclPdf.density).toHaveLength(9);
    const incl = computeInclinationPdf(mesh, { binCount: 9, cellId: 0 });
    d.inclPdf.density.forEach((v, b) => expect(v).toBeCloseTo(incl.density[b], 6));
  });

  it('a single requested id aggregates the WHOLE mesh (no cell filter)', () => {
    // The "Whole mesh" entry the UI shows when there is no per-cell structure:
    // every triangle — including the outside-grid one — contributes.
    const dists = computeCellDistributions(mesh, [-1], 18, 36);
    const whole = dists.get(-1)!;
    const incl = computeInclinationPdf(mesh, { binCount: 18 });  // no cellId
    const g = computeGTheta(mesh);                               // no cellId
    expect(whole.inclPdf.totalArea).toBeCloseTo(incl.totalArea, 6);
    whole.inclPdf.density.forEach((v, b) => expect(v).toBeCloseTo(incl.density[b], 6));
    expect(whole.gtheta!).toBeCloseTo(g!, 6);
  });

  it('empty mesh yields zero-density, null-G(θ) cells (no NaNs)', () => {
    const dists = computeCellDistributions(meshFromTris([]), [-1], 18, 36);
    const d = dists.get(-1)!;
    expect(d.inclPdf.totalArea).toBe(0);
    expect(d.inclPdf.density.every(v => v === 0)).toBe(true);
    expect(d.gtheta).toBeNull();
  });
});
