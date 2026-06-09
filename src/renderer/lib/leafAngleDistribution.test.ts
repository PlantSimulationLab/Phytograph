import { describe, it, expect } from 'vitest';
import type { MeshData } from './pointCloudTypes';
import { triangleGeometry } from './pointCloudHelpers';
import {
  computeInclinationPdf,
  computeAzimuthHistogram,
  fitDeWit,
  deWitDensityRad,
  deWitCurve,
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
