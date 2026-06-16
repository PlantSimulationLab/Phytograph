import { describe, it, expect } from 'vitest';
import {
  computeTriangleMetrics,
  applyTriangleFilter,
  triangleFilterCounts,
  hasTriangleFilterMetrics,
} from './triangleFilter';
import type { MeshData } from './pointCloudTypes';

// Build a minimal MeshData of `n` independent triangles, each a right triangle
// with legs (edge, edge) in the XY plane offset along X so they don't overlap.
// triEdgeMax / triAspect are supplied explicitly so the filter logic is tested
// against known metrics rather than re-derived geometry.
function makeMesh(tris: { edgeMax: number; aspect: number; scan?: number }[]): MeshData {
  const n = tris.length;
  const vertices = new Float32Array(n * 3 * 3);
  const indices = new Uint32Array(n * 3);
  const triEdgeMax = new Float32Array(n);
  const triAspect = new Float32Array(n);
  const triangleScanIds = new Uint32Array(n);
  for (let t = 0; t < n; t++) {
    const e = tris[t].edgeMax;
    const ox = t * 10;
    vertices[t * 9 + 0] = ox; vertices[t * 9 + 1] = 0; vertices[t * 9 + 2] = 0;
    vertices[t * 9 + 3] = ox + e; vertices[t * 9 + 4] = 0; vertices[t * 9 + 5] = 0;
    vertices[t * 9 + 6] = ox; vertices[t * 9 + 7] = e; vertices[t * 9 + 8] = 0;
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
    triEdgeMax[t] = tris[t].edgeMax;
    triAspect[t] = tris[t].aspect;
    triangleScanIds[t] = tris[t].scan ?? 0;
  }
  return {
    vertices,
    indices,
    vertexCount: n * 3,
    triangleCount: n,
    triEdgeMax,
    triAspect,
    triangleScanIds,
    scanColors: ['#ff0000', '#00ff00'],
  };
}

describe('computeTriangleMetrics', () => {
  it('derives per-triangle max-edge and aspect from geometry', () => {
    // Right triangle legs 0.05 → hypotenuse 0.05√2 ≈ 0.0707; aspect = √2.
    const mesh = makeMesh([{ edgeMax: 0, aspect: 0 }]);
    // overwrite vertices with a known right triangle (legs 0.05, 0.05)
    mesh.vertices.set([0, 0, 0, 0.05, 0, 0, 0, 0.05, 0]);
    const { triEdgeMax, triAspect } = computeTriangleMetrics(mesh);
    expect(triEdgeMax[0]).toBeCloseTo(0.05 * Math.SQRT2, 6);
    expect(triAspect[0]).toBeCloseTo(Math.SQRT2, 5);
  });
});

describe('triangleFilterCounts', () => {
  it('partitions candidates by Lmax then aspect (matching C++ attribution order)', () => {
    const mesh = makeMesh([
      { edgeMax: 0.05, aspect: 2.0 }, // kept
      { edgeMax: 0.50, aspect: 2.0 }, // dropped by Lmax
      { edgeMax: 0.05, aspect: 9.0 }, // dropped by aspect
      { edgeMax: 0.50, aspect: 9.0 }, // fails both → attributed to Lmax
    ]);
    const counts = triangleFilterCounts(mesh, 0.1, 4.0);
    expect(counts).toEqual({ candidates: 4, kept: 1, droppedLmax: 2, droppedAspect: 1 });
    expect(counts.kept + counts.droppedLmax + counts.droppedAspect).toBe(counts.candidates);
  });

  it('uses strict > for drops: an edge exactly at Lmax is kept', () => {
    const mesh = makeMesh([{ edgeMax: 0.5, aspect: 4.0 }]);
    const counts = triangleFilterCounts(mesh, 0.5, 4.0);
    expect(counts.kept).toBe(1);
    expect(counts.droppedLmax).toBe(0);
    expect(counts.droppedAspect).toBe(0);
  });
});

describe('applyTriangleFilter', () => {
  it('keeps only triangles passing both thresholds and reuses the vertex buffer', () => {
    const mesh = makeMesh([
      { edgeMax: 0.05, aspect: 1.5, scan: 0 },
      { edgeMax: 0.50, aspect: 1.5, scan: 1 }, // dropped (Lmax)
      { edgeMax: 0.08, aspect: 1.5, scan: 1 },
    ]);
    const filtered = applyTriangleFilter(mesh, 0.1, 4.0);
    expect(filtered.triangleCount).toBe(2);
    expect(filtered.indices.length).toBe(6);
    expect(filtered.vertices).toBe(mesh.vertices);
    expect(filtered.triEdgeMax![0]).toBeCloseTo(0.05, 6);
    expect(filtered.triEdgeMax![1]).toBeCloseTo(0.08, 6);
    expect(Array.from(filtered.triangleScanIds!)).toEqual([0, 1]);
    const expectedArea = (0.05 * 0.05) / 2 + (0.08 * 0.08) / 2;
    expect(filtered.surfaceArea).toBeCloseTo(expectedArea, 6);
    expect(filtered.normals).toBeUndefined();
  });

  it('widening Lmax on a re-filter restores triangles', () => {
    const mesh = makeMesh([
      { edgeMax: 0.05, aspect: 1.5 },
      { edgeMax: 0.50, aspect: 1.5 },
    ]);
    expect(applyTriangleFilter(mesh, 0.1, 4.0).triangleCount).toBe(1);
    expect(applyTriangleFilter(mesh, 1.0, 4.0).triangleCount).toBe(2);
  });

  it('returns the mesh unchanged when it carries no metrics', () => {
    const bare: MeshData = {
      vertices: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      vertexCount: 3,
      triangleCount: 1,
    };
    expect(applyTriangleFilter(bare, 0.1, 4.0)).toBe(bare);
    expect(hasTriangleFilterMetrics(bare)).toBe(false);
  });
});
