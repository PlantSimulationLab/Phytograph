import { describe, it, expect } from 'vitest';
import { extractReuseMeshPayload } from './pointCloudHelpers';
import { applyTriangleFilter } from './triangleFilter';
import { encodeBinaryFrame, decodeBinaryFrame } from '../utils/backendApi';
import type { MeshData } from './pointCloudTypes';

// Minimal MeshData of `n` triangles with explicit per-triangle metrics + scan
// ids, mirroring triangleFilter.test.ts. Each triangle is an independent right
// triangle offset along X so they don't overlap.
function makeMesh(tris: { edgeMax: number; aspect: number; scan: number }[]): MeshData {
  const n = tris.length;
  const vertices = new Float32Array(n * 9);
  const indices = new Uint32Array(n * 3);
  const triEdgeMax = new Float32Array(n);
  const triAspect = new Float32Array(n);
  const triangleScanIds = new Uint32Array(n);
  for (let t = 0; t < n; t++) {
    const e = tris[t].edgeMax;
    const ox = t * 10;
    vertices[t * 9 + 0] = ox; vertices[t * 9 + 3] = ox + e; vertices[t * 9 + 7] = e;
    vertices[t * 9 + 6] = ox;
    indices[t * 3] = t * 3; indices[t * 3 + 1] = t * 3 + 1; indices[t * 3 + 2] = t * 3 + 2;
    triEdgeMax[t] = tris[t].edgeMax;
    triAspect[t] = tris[t].aspect;
    triangleScanIds[t] = tris[t].scan;
  }
  return {
    vertices, indices, vertexCount: n * 3, triangleCount: n,
    triEdgeMax, triAspect, triangleScanIds,
  };
}

describe('extractReuseMeshPayload', () => {
  it('remaps per-triangle scan ids to the request scan order', () => {
    // Mesh built from scans ["A","B"] → triangleScanIds 0=A, 1=B.
    const mesh = makeMesh([
      { edgeMax: 0.1, aspect: 2, scan: 0 },  // A
      { edgeMax: 0.1, aspect: 2, scan: 1 },  // B
      { edgeMax: 0.1, aspect: 2, scan: 0 },  // A
    ]);
    const sourceScanIds = ['A', 'B'];
    // The LAD request emits scans in the OPPOSITE order: ["B","A"]. So A→1, B→0.
    const requestOrder = ['B', 'A'];

    const payload = extractReuseMeshPayload(mesh, 1, 100, sourceScanIds, requestOrder);

    expect(payload.triangleCount).toBe(3);
    expect(Array.from(payload.scanIds)).toEqual([1, 0, 1]);
  });

  it('translates WORLD vertices into the STORED frame by subtracting worldShift (new buffer, input unmutated)', () => {
    const mesh = makeMesh([{ edgeMax: 0.1, aspect: 2, scan: 0 }]);
    const original = Float32Array.from(mesh.vertices);
    const ws: [number, number, number] = [1000, 2000, 30];
    const payload = extractReuseMeshPayload(mesh, 1, 100, ['A'], ['A'], ws);
    // Triangle 0's first vertex is the origin [0,0,0] → [-1000,-2000,-30] after shift.
    expect([payload.vertices[0], payload.vertices[1], payload.vertices[2]]).toEqual([-1000, -2000, -30]);
    // The shared mesh buffer (also rendered) must not be mutated in place.
    expect(Array.from(mesh.vertices)).toEqual(Array.from(original));
    expect(payload.vertices).not.toBe(mesh.vertices);
  });

  it('passes vertices through unshifted when worldShift is null or zero', () => {
    const mesh = makeMesh([{ edgeMax: 0.1, aspect: 2, scan: 0 }]);
    const withNull = extractReuseMeshPayload(mesh, 1, 100, ['A'], ['A'], null);
    const withZero = extractReuseMeshPayload(mesh, 1, 100, ['A'], ['A'], [0, 0, 0]);
    expect([withNull.vertices[0], withNull.vertices[1], withNull.vertices[2]]).toEqual([0, 0, 0]);
    expect([withZero.vertices[0], withZero.vertices[1], withZero.vertices[2]]).toEqual([0, 0, 0]);
  });

  it('uses the filtered triangle set (drops triangles past lmax/aspect)', () => {
    const mesh = makeMesh([
      { edgeMax: 0.05, aspect: 2, scan: 0 },   // keep
      { edgeMax: 0.50, aspect: 2, scan: 0 },   // dropped by lmax
      { edgeMax: 0.05, aspect: 99, scan: 0 },  // dropped by aspect
    ]);
    const filtered = applyTriangleFilter(mesh, 0.1, 4);
    const payload = extractReuseMeshPayload(mesh, 0.1, 4, ['A'], ['A']);

    expect(payload.triangleCount).toBe(filtered.triangleCount);
    expect(payload.triangleCount).toBe(1);
    expect(payload.indices.length).toBe(3);
    expect(payload.scanIds.length).toBe(1);
  });

  it('throws when a source scan is missing from the request order', () => {
    const mesh = makeMesh([{ edgeMax: 0.1, aspect: 2, scan: 1 }]);
    // Triangle references source scan index 1 ("B"), but the request only has "A".
    expect(() => extractReuseMeshPayload(mesh, 1, 100, ['A', 'B'], ['A']))
      .toThrow(/no longer/i);
  });

  it('throws when a MULTI-scan mesh has no per-triangle scan ids', () => {
    // With more than one source scan and no triangleScanIds there's no way to
    // know which scan each triangle came from — must throw rather than guess.
    const mesh = makeMesh([{ edgeMax: 0.1, aspect: 2, scan: 0 }]);
    const noScan: MeshData = { ...mesh, triangleScanIds: undefined };
    expect(() => extractReuseMeshPayload(noScan, 1, 100, ['A', 'B'], ['A', 'B']))
      .toThrow(/scan ids/i);
  });

  it('synthesizes all-zero scan ids for a SINGLE-scan mesh with no scan ids', () => {
    // A per-scan ball-pivot mesh carries no triangleScanIds: its one source scan
    // means every triangle is scan index 0. This is the ball-pivot LAD path.
    const mesh = makeMesh([
      { edgeMax: 0.1, aspect: 2, scan: 0 },
      { edgeMax: 0.1, aspect: 2, scan: 0 },
    ]);
    const noScan: MeshData = { ...mesh, triangleScanIds: undefined };
    const payload = extractReuseMeshPayload(noScan, 1, 100, ['A'], ['A']);
    expect(payload.triangleCount).toBe(2);
    expect(Array.from(payload.scanIds)).toEqual([0, 0]);
  });

  it('drops out-of-grid triangles (cell id = outside sentinel)', () => {
    // The ball-pivot LAD path: only triangles whose centroid is inside the grid
    // feed the inversion. A mesh has no edge/aspect metrics (filter is a no-op),
    // a single source scan, and cell ids mixing an in-grid cell and the sentinel.
    const OUTSIDE = 0xffffffff;
    const mesh: MeshData = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
      vertexCount: 4,
      triangleCount: 2,
      triangleCellIds: new Uint32Array([0, OUTSIDE]),
    };
    const payload = extractReuseMeshPayload(mesh, 0.1, 4, ['A'], ['A']);
    // Only the in-grid triangle (cell 0) survives; the sentinel one is dropped.
    expect(payload.triangleCount).toBe(1);
    expect(Array.from(payload.indices)).toEqual([0, 1, 2]);
    expect(Array.from(payload.scanIds)).toEqual([0]);
  });
});

describe('encodeBinaryFrame round-trips through decodeBinaryFrame', () => {
  it('preserves meta and buffers', () => {
    const meta = { lmax: 0.04, scans: [{ origin: [1, 2, 3] }], nx: 2 };
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const scanIds = new Uint32Array([0]);

    const frame = encodeBinaryFrame(meta, [
      { name: 'mesh_vertices', data: vertices },
      { name: 'mesh_indices', data: indices },
      { name: 'mesh_scan_ids', data: scanIds },
    ]);
    // frame is a Uint8Array view; decodeBinaryFrame wants an ArrayBuffer.
    const buf = frame.slice().buffer;
    const decoded = decodeBinaryFrame(buf);

    expect(decoded.meta).toEqual(meta);
    expect(Array.from(decoded.buffers.mesh_vertices as Float32Array)).toEqual(Array.from(vertices));
    expect(Array.from(decoded.buffers.mesh_indices as Uint32Array)).toEqual([0, 1, 2]);
    expect(Array.from(decoded.buffers.mesh_scan_ids as Uint32Array)).toEqual([0]);
  });
});
